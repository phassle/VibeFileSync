// dynamic-qa/shared/scripts/authority.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateInvocation,
  validateAuthorityRecord,
  gatesAreIndependent,
  isKnownRole,
} from "./authority.mjs";

test("evaluateInvocation allows an explicit user command", () => {
  const { allowed, stopReason } = evaluateInvocation({ source: "explicit-user-command" });
  assert.equal(allowed, true);
  assert.equal(stopReason, null);
});

test("evaluateInvocation refuses a natural-language mention", () => {
  const { allowed, stopReason } = evaluateInvocation({ source: "natural-language-mention" });
  assert.equal(allowed, false);
  assert.equal(stopReason, "not-explicit-invocation");
});

test("evaluateInvocation refuses an implicit coordinator inference", () => {
  const { allowed, stopReason } = evaluateInvocation({ source: "implicit-coordinator-inference" });
  assert.equal(allowed, false);
  assert.equal(stopReason, "not-explicit-invocation");
});

test("evaluateInvocation fails closed on an unrecognized source", () => {
  const { allowed, stopReason } = evaluateInvocation({ source: "something-nobody-declared" });
  assert.equal(allowed, false);
  assert.equal(stopReason, "unrecognized-invocation-source");
});

test("evaluateInvocation fails closed when source is missing entirely", () => {
  const { allowed, stopReason } = evaluateInvocation({});
  assert.equal(allowed, false);
  assert.equal(stopReason, "unrecognized-invocation-source");
});

test("isKnownRole recognizes exactly the three defined roles", () => {
  assert.equal(isKnownRole("qa-owner"), true);
  assert.equal(isKnownRole("technical-owner"), true);
  assert.equal(isKnownRole("domain-expert"), true);
  assert.equal(isKnownRole("product-manager"), false);
});

test("validateAuthorityRecord accepts a record with both gates present", () => {
  const { ok, errors } = validateAuthorityRecord({
    qaOwnerGate: { present: true, identifier: "per" },
    technicalOwnerGate: { present: true, identifier: "someone-else" },
  });
  assert.equal(ok, true, errors.join("; "));
});

test("validateAuthorityRecord requires both gates to be present as separate keys", () => {
  const { ok, errors } = validateAuthorityRecord({
    qaOwnerGate: { present: true, identifier: "per" },
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("technicalOwnerGate")));
});

test("validateAuthorityRecord rejects a combined approval field", () => {
  const { ok, errors } = validateAuthorityRecord({
    qaOwnerGate: { present: true, identifier: "per" },
    technicalOwnerGate: { present: true, identifier: "per" },
    approved: true,
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("collapse the two gates")));
});

test("validateAuthorityRecord rejects a gate marked present with no identifier", () => {
  const { ok, errors } = validateAuthorityRecord({
    qaOwnerGate: { present: true },
    technicalOwnerGate: { present: false },
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("qaOwnerGate is marked present but has no identifier")));
});

test("validateAuthorityRecord allows a QA Owner to be absent (present: false) without an identifier", () => {
  const { ok, errors } = validateAuthorityRecord({
    qaOwnerGate: { present: false },
    technicalOwnerGate: { present: false },
  });
  assert.equal(ok, true, errors.join("; "));
});

test("validateAuthorityRecord accepts a Domain Expert scoped to specific flows", () => {
  const { ok, errors } = validateAuthorityRecord({
    qaOwnerGate: { present: true, identifier: "per" },
    technicalOwnerGate: { present: true, identifier: "per" },
    domainExperts: [{ identifier: "billing-sme", scope: ["checkout-flow"] }],
  });
  assert.equal(ok, true, errors.join("; "));
});

test("validateAuthorityRecord rejects an unscoped Domain Expert (indistinguishable from a QA Owner)", () => {
  const { ok, errors } = validateAuthorityRecord({
    qaOwnerGate: { present: true, identifier: "per" },
    technicalOwnerGate: { present: true, identifier: "per" },
    domainExperts: [{ identifier: "billing-sme", scope: [] }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("unscoped domain expert")));
});

test("validateAuthorityRecord allows the same human to hold both gates (one person, two hats is not an error)", () => {
  const { ok, errors } = validateAuthorityRecord({
    qaOwnerGate: { present: true, identifier: "per" },
    technicalOwnerGate: { present: true, identifier: "per" },
  });
  assert.equal(ok, true, errors.join("; "));
});

test("gatesAreIndependent is true for two distinct gate objects", () => {
  const record = {
    qaOwnerGate: { present: true, identifier: "per" },
    technicalOwnerGate: { present: false },
  };
  assert.equal(gatesAreIndependent(record), true);
});

test("gatesAreIndependent is false if both keys were assigned the very same object (a bug that would let one write satisfy both)", () => {
  const shared = { present: true, identifier: "per" };
  const record = { qaOwnerGate: shared, technicalOwnerGate: shared };
  assert.equal(gatesAreIndependent(record), false);
});
