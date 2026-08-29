// dynamic-qa/shared/scripts/diagnosis.test.mjs
//
// Tier 1 coverage for the Diagnosis Record contract (#158): every Failure
// Owner x Repeatability combination and its derived Failure Class, the
// retry-pass-never-proves-flake guard, original-attempt immutability across
// retry/diagnosis/repair-verification/quarantine, and the repair-eligibility
// gate (ineligible by default).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveFailureClass,
  validateDiagnosisRecord,
  validateAttempt,
  appendAttempt,
  originalAttempt,
  assertOriginalAttemptStaysFailed,
  isRepairEligible,
  SUPPORTED_SCHEMA,
  OWNERS,
  REPEATABILITY_VALUES,
} from "./diagnosis.mjs";

const SHA = "c".repeat(40);

function baseRecord(overrides = {}) {
  return {
    schema: SUPPORTED_SCHEMA,
    diagnosisId: "diag-001",
    flowId: "checkout-happy-path",
    sourceCommit: SHA,
    generatedAt: "2026-08-30T00:00:00Z",
    owner: "binding",
    repeatability: "deterministic",
    repeatabilityBasis: "reproduction",
    failureClass: "binding-defect",
    status: "confirmed",
    bindingId: "checkout-happy-path-binding",
    causalChain: "Selector changed after a markup update; reproduced unchanged.",
    evidence: ["reproduced on pinned source commit"],
    counterEvidence: [],
    affectedIds: ["checkout-happy-path"],
    attempts: [{ attemptId: "a1", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" }],
    ...overrides,
  };
}

// --- 12-combination derivation table -------------------------------------

const EXPECTED_CLASSES = {
  product: { deterministic: "product-regression", intermittent: "product-regression", unknown: "product-regression" },
  binding: { deterministic: "binding-defect", intermittent: "test-flake", unknown: "unclassified-failure" },
  environment: { deterministic: "environment-failure", intermittent: "test-flake", unknown: "unclassified-failure" },
  unresolved: { deterministic: "unclassified-failure", intermittent: "unclassified-failure", unknown: "unclassified-failure" },
};

test("every Failure Owner x Repeatability combination (12) derives its documented Failure Class", () => {
  let count = 0;
  for (const owner of OWNERS) {
    for (const repeatability of REPEATABILITY_VALUES) {
      count += 1;
      assert.equal(deriveFailureClass(owner, repeatability), EXPECTED_CLASSES[owner][repeatability], `${owner}/${repeatability}`);
    }
  }
  assert.equal(count, 12);
});

test("deriveFailureClass fails closed on an unknown owner or repeatability", () => {
  assert.throws(() => deriveFailureClass("vendor", "deterministic"), /unknown Failure Owner/);
  assert.throws(() => deriveFailureClass("binding", "flaky"), /unknown Repeatability/);
});

test("a full, valid Diagnosis Record for each of the 12 combinations validates and matches its derived class", () => {
  for (const owner of OWNERS) {
    for (const repeatability of REPEATABILITY_VALUES) {
      const expectedClass = EXPECTED_CLASSES[owner][repeatability];
      const record = baseRecord({
        owner,
        repeatability,
        repeatabilityBasis: repeatability === "deterministic" ? "reproduction" : repeatability === "intermittent" ? "hypothesis-probe" : "insufficient-evidence",
        failureClass: expectedClass,
        bindingId: owner === "binding" ? "some-binding" : undefined,
        failedCapability: owner === "environment" ? "network-egress" : undefined,
        status: "provisional",
      });
      const result = validateDiagnosisRecord(record);
      assert.equal(result.valid, true, `${owner}/${repeatability}: ${JSON.stringify(result.errors)}`);
    }
  }
});

test("a stored failureClass that disagrees with the derived value is rejected", () => {
  const record = baseRecord({ owner: "product", repeatability: "deterministic", failureClass: "binding-defect" });
  const result = validateDiagnosisRecord(record);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /must be the DERIVED value/.test(e.message)));
});

// --- Owner and repeatability are independent axes -------------------------

test("owner 'binding' requires a named bindingId, independent of repeatability", () => {
  const record = baseRecord({ owner: "binding", bindingId: undefined });
  const result = validateDiagnosisRecord(record);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /bindingId/.test(e.message)));
});

test("an environment failure names the exact capability that failed", () => {
  const missing = validateDiagnosisRecord(
    baseRecord({ owner: "environment", repeatability: "deterministic", failureClass: "environment-failure", bindingId: undefined }),
  );
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => /failedCapability/.test(e.message)));

  const named = validateDiagnosisRecord(
    baseRecord({
      owner: "environment",
      repeatability: "deterministic",
      failureClass: "environment-failure",
      bindingId: undefined,
      failedCapability: "network-egress",
    }),
  );
  assert.equal(named.valid, true, JSON.stringify(named.errors));
});

test("a product regression carries no Binding-mutation field at all", () => {
  const record = baseRecord({
    owner: "product",
    repeatability: "deterministic",
    failureClass: "product-regression",
    bindingId: undefined,
    productDefectRef: "PROD-123",
  });
  const result = validateDiagnosisRecord(record);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(!("proposedBindingEdit" in record));
  assert.ok(!("bindingPatch" in record));
});

// --- A retry pass never proves flake --------------------------------------

test("a retry-pass basis can only justify repeatability 'unknown', never 'intermittent'", () => {
  const claimsFlake = baseRecord({
    owner: "binding",
    repeatability: "intermittent",
    repeatabilityBasis: "retry-pass",
    failureClass: "test-flake",
  });
  const result = validateDiagnosisRecord(claimsFlake);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /retry pass is not evidence of flake/.test(e.message)));
});

test("a retry-pass basis can only justify repeatability 'unknown', never 'deterministic'", () => {
  const claimsDeterministic = baseRecord({
    owner: "binding",
    repeatability: "deterministic",
    repeatabilityBasis: "retry-pass",
    failureClass: "binding-defect",
  });
  const result = validateDiagnosisRecord(claimsDeterministic);
  assert.equal(result.valid, false);
});

test("a retry-pass basis paired with 'unknown' repeatability is accepted", () => {
  const record = baseRecord({
    owner: "binding",
    repeatability: "unknown",
    repeatabilityBasis: "retry-pass",
    failureClass: "unclassified-failure",
    status: "provisional",
  });
  const result = validateDiagnosisRecord(record);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("a retry pass is recorded in attempts as kind 'retry', never rewriting the original", () => {
  let attempts = [{ attemptId: "a1", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" }];
  attempts = appendAttempt(attempts, { attemptId: "a2", kind: "retry", verdict: "passed", recordedAt: "2026-08-30T01:00:00Z" });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].kind, "retry");
  assert.equal(attempts[1].verdict, "passed");
  // The retry passing is not, on its own, evidence the module will treat as
  // an intermittent conclusion — that requires an explicit repeatabilityBasis
  // other than "retry-pass", checked above. Nothing in appendAttempt derives
  // a repeatability value from this attempts list at all.
  assert.equal(originalAttempt(attempts).verdict, "failed");
});

// --- A failed attempt stays failed ----------------------------------------

test("the original attempt remains failed after retry, diagnosis, repair-verification, and quarantine", () => {
  let attempts = [{ attemptId: "a1", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" }];
  const beforeRetry = attempts;
  attempts = appendAttempt(attempts, { attemptId: "a2", kind: "retry", verdict: "passed", recordedAt: "2026-08-30T01:00:00Z" });
  assertOriginalAttemptStaysFailed(beforeRetry, attempts);

  const beforeVerification = attempts;
  attempts = appendAttempt(attempts, { attemptId: "a3", kind: "repair-verification", verdict: "passed", recordedAt: "2026-08-30T02:00:00Z" });
  assertOriginalAttemptStaysFailed(beforeVerification, attempts);

  const beforeQuarantine = attempts;
  attempts = appendAttempt(attempts, { attemptId: "a4", kind: "quarantine-check", verdict: "failed", recordedAt: "2026-08-30T03:00:00Z" });
  assertOriginalAttemptStaysFailed(beforeQuarantine, attempts);

  assert.equal(originalAttempt(attempts).verdict, "failed");
  assert.equal(originalAttempt(attempts).attemptId, "a1");
});

test("appendAttempt refuses a duplicate 'original' attempt", () => {
  const attempts = [{ attemptId: "a1", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" }];
  assert.throws(
    () => appendAttempt(attempts, { attemptId: "a2", kind: "original", verdict: "failed", recordedAt: "2026-08-30T01:00:00Z" }),
    /already exists/,
  );
});

test("appendAttempt refuses an 'original' attempt recorded as anything but failed", () => {
  assert.throws(() => appendAttempt([], { attemptId: "a1", kind: "original", verdict: "passed", recordedAt: "2026-08-30T00:00:00Z" }), /invalid attempt/);
});

test("appendAttempt never mutates a prior entry's own object in place", () => {
  const attempts = [{ attemptId: "a1", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" }];
  const originalEntry = attempts[0];
  const next = appendAttempt(attempts, { attemptId: "a2", kind: "retry", verdict: "passed", recordedAt: "2026-08-30T01:00:00Z" });
  assert.notEqual(next[0], originalEntry);
  assert.deepEqual(next[0], originalEntry);
  assert.throws(() => {
    "use strict";
    next[0].verdict = "passed";
  });
});

test("validateAttempt rejects an unknown kind or verdict", () => {
  const badKind = validateAttempt({ attemptId: "a1", kind: "rerun", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" });
  assert.equal(badKind.valid, false);
  const badVerdict = validateAttempt({ attemptId: "a1", kind: "retry", verdict: "flaky", recordedAt: "2026-08-30T00:00:00Z" });
  assert.equal(badVerdict.valid, false);
});

test("a Diagnosis Record with two 'original' attempts is rejected", () => {
  const record = baseRecord({
    attempts: [
      { attemptId: "a1", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" },
      { attemptId: "a2", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:05:00Z" },
    ],
  });
  const result = validateDiagnosisRecord(record);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /exactly one entry of kind "original"/.test(e.message)));
});

// --- Repair eligibility: ineligible is the default ------------------------

test("only confirmed + binding-owned + binding-defect is repair-eligible", () => {
  const eligible = baseRecord({ owner: "binding", repeatability: "deterministic", failureClass: "binding-defect", status: "confirmed" });
  assert.equal(isRepairEligible(eligible), true);
});

test("a product diagnosis produces no repair eligibility regardless of status", () => {
  for (const status of ["confirmed", "provisional", "safety-blocked"]) {
    const record = baseRecord({
      owner: "product",
      repeatability: "deterministic",
      failureClass: "product-regression",
      bindingId: undefined,
      status,
    });
    assert.equal(isRepairEligible(record), false, `status ${status}`);
  }
});

test("an environment diagnosis produces no repair eligibility regardless of status", () => {
  for (const status of ["confirmed", "provisional", "safety-blocked"]) {
    const record = baseRecord({
      owner: "environment",
      repeatability: "deterministic",
      failureClass: "environment-failure",
      bindingId: undefined,
      failedCapability: "network-egress",
      status,
    });
    assert.equal(isRepairEligible(record), false, `status ${status}`);
  }
});

test("an unresolved diagnosis produces no repair eligibility", () => {
  const record = baseRecord({
    owner: "unresolved",
    repeatability: "unknown",
    failureClass: "unclassified-failure",
    bindingId: undefined,
    status: "confirmed",
  });
  assert.equal(isRepairEligible(record), false);
});

test("a provisional binding-owned diagnosis produces no repair eligibility", () => {
  const record = baseRecord({ owner: "binding", repeatability: "deterministic", failureClass: "binding-defect", status: "provisional" });
  assert.equal(isRepairEligible(record), false);
});

test("a safety-blocked binding-owned diagnosis produces no repair eligibility", () => {
  const record = baseRecord({ owner: "binding", repeatability: "deterministic", failureClass: "binding-defect", status: "safety-blocked" });
  assert.equal(isRepairEligible(record), false);
});

test("a confirmed binding-owned but intermittent (Test Flake) diagnosis is not general repair-eligible", () => {
  const record = baseRecord({
    owner: "binding",
    repeatability: "intermittent",
    repeatabilityBasis: "hypothesis-probe",
    failureClass: "test-flake",
    status: "confirmed",
  });
  assert.equal(isRepairEligible(record), false);
});

test("isRepairEligible never throws and defaults false for malformed input", () => {
  assert.equal(isRepairEligible(null), false);
  assert.equal(isRepairEligible(undefined), false);
  assert.equal(isRepairEligible({}), false);
  assert.equal(isRepairEligible({ owner: "binding", status: "confirmed", failureClass: "binding-defect" }), false);
});
