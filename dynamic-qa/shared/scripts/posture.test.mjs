// dynamic-qa/shared/scripts/posture.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isKnownPosture,
  evaluatePostureDeclaration,
  repositoryShapeSignal,
  makeObservationFact,
  confirmIntent,
  canBecomeExpectedOutcome,
  validateGreenfieldSource,
  requireApprovedGreenfieldEvidence,
  buildGreenfieldFact,
} from "./posture.mjs";

// --- posture is determined explicitly -------------------------------------

test("isKnownPosture accepts only brownfield/greenfield", () => {
  assert.equal(isKnownPosture("brownfield"), true);
  assert.equal(isKnownPosture("greenfield"), true);
  assert.equal(isKnownPosture("mixed"), false);
  assert.equal(isKnownPosture(undefined), false);
});

test("evaluatePostureDeclaration allows an explicit QA Owner declaration", () => {
  const result = evaluatePostureDeclaration({ source: "qa-owner-declaration", posture: "brownfield" });
  assert.equal(result.allowed, true);
  assert.equal(result.posture, "brownfield");
  assert.equal(result.stopReason, null);
});

test("evaluatePostureDeclaration allows an explicit Technical Owner declaration", () => {
  const result = evaluatePostureDeclaration({ source: "technical-owner-declaration", posture: "greenfield" });
  assert.equal(result.allowed, true);
  assert.equal(result.posture, "greenfield");
});

test("evaluatePostureDeclaration refuses to let repository shape alone decide posture", () => {
  const result = evaluatePostureDeclaration({ source: "inferred-from-repository-shape", posture: "brownfield" });
  assert.equal(result.allowed, false);
  assert.equal(result.posture, null);
  assert.equal(result.stopReason, "posture-not-explicit");
});

test("evaluatePostureDeclaration refuses an assumed default", () => {
  const result = evaluatePostureDeclaration({ source: "assumed-default", posture: "greenfield" });
  assert.equal(result.allowed, false);
  assert.equal(result.stopReason, "posture-not-explicit");
});

test("evaluatePostureDeclaration fails closed on an unrecognized source", () => {
  const result = evaluatePostureDeclaration({ source: "vibes", posture: "brownfield" });
  assert.equal(result.allowed, false);
  assert.equal(result.stopReason, "unrecognized-posture-source");
});

test("evaluatePostureDeclaration rejects a posture value outside the known vocabulary", () => {
  const result = evaluatePostureDeclaration({ source: "qa-owner-declaration", posture: "hybrid" });
  assert.equal(result.allowed, false);
  assert.equal(result.stopReason, "unrecognized-posture");
});

test("repositoryShapeSignal is informational only and never itself an accepted declaration source", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "posture-signal-"));
  try {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "app.ts"), "export const x = 1;\n");
    const signal = repositoryShapeSignal(dir);
    assert.equal(signal.hasApplicationCode, true);
    assert.ok(signal.fileCount >= 1);
    // The signal's shape must never satisfy evaluatePostureDeclaration by
    // being handed straight through as `source` — it is not a listed source.
    const result = evaluatePostureDeclaration({ source: signal, posture: "brownfield" });
    assert.equal(result.allowed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repositoryShapeSignal reports no application code for an empty repository", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "posture-signal-empty-"));
  try {
    const signal = repositoryShapeSignal(dir);
    assert.equal(signal.hasApplicationCode, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- brownfield: observation is evidence, never intended behaviour -------

test("makeObservationFact always starts unconfirmed", () => {
  const fact = makeObservationFact({ id: "obs:retry-button", provenance: "observed", description: "retry button silently swallows errors" });
  assert.equal(fact.category, "brownfield-observation");
  assert.equal(fact.intentStatus, "unconfirmed");
});

test("makeObservationFact refuses to construct a pre-confirmed observation", () => {
  assert.throws(() =>
    makeObservationFact({ id: "obs:x", provenance: "observed", intentStatus: "confirmed-intended" })
  );
});

test("an unconfirmed observation cannot become an Expected Outcome", () => {
  const fact = makeObservationFact({ id: "obs:retry-button", provenance: "observed" });
  assert.equal(canBecomeExpectedOutcome(fact), false);
});

test("confirmIntent requires an accountable human identity, never a bare decision", () => {
  const fact = makeObservationFact({ id: "obs:retry-button", provenance: "observed" });
  assert.throws(() => confirmIntent(fact, { decision: "intended" }));
});

test("confirmIntent rejects a Domain Expert as the confirming role", () => {
  const fact = makeObservationFact({ id: "obs:retry-button", provenance: "observed" });
  assert.throws(() =>
    confirmIntent(fact, { decision: "intended", confirmedBy: "dana", confirmedByRole: "domain-expert" })
  );
});

test("confirmIntent moves an observation to confirmed-intended only via an explicit QA Owner decision", () => {
  const fact = makeObservationFact({ id: "obs:retry-button", provenance: "observed" });
  const confirmed = confirmIntent(fact, { decision: "intended", confirmedBy: "per", confirmedByRole: "qa-owner" });
  assert.equal(confirmed.intentStatus, "confirmed-intended");
  assert.equal(confirmed.confirmedBy, "per");
});

test("THE core property: an observation cannot reach contract status without explicit intent confirmation", () => {
  const observed = makeObservationFact({ id: "obs:retry-button", provenance: "observed", description: "retry silently swallows errors" });
  assert.equal(canBecomeExpectedOutcome(observed), false, "a merely-observed fact must never qualify");

  const confirmedNotIntended = confirmIntent(observed, {
    decision: "not-intended",
    confirmedBy: "per",
    confirmedByRole: "qa-owner",
  });
  assert.equal(
    canBecomeExpectedOutcome(confirmedNotIntended),
    false,
    "an explicitly confirmed BUG must never qualify as an Expected Outcome"
  );

  const confirmedIntended = confirmIntent(observed, {
    decision: "intended",
    confirmedBy: "per",
    confirmedByRole: "qa-owner",
  });
  assert.equal(
    canBecomeExpectedOutcome(confirmedIntended),
    true,
    "only an explicitly confirmed-intended observation may qualify"
  );
});

test("confirmIntent refuses to operate on a non-brownfield-observation fact", () => {
  assert.throws(() =>
    confirmIntent(
      { id: "x", category: "test-framework", provenance: "observed" },
      { decision: "intended", confirmedBy: "per", confirmedByRole: "qa-owner" }
    )
  );
});

test("confirmIntent rejects a decision outside intended/not-intended", () => {
  const fact = makeObservationFact({ id: "obs:x", provenance: "observed" });
  assert.throws(() => confirmIntent(fact, { decision: "maybe", confirmedBy: "per", confirmedByRole: "qa-owner" }));
});

test("canBecomeExpectedOutcome is false for a stray object shaped like a fact but not one", () => {
  assert.equal(canBecomeExpectedOutcome(null), false);
  assert.equal(canBecomeExpectedOutcome({ category: "brownfield-observation", intentStatus: "confirmed-intended" }), false);
});

// --- greenfield: approved-source-only evidence ----------------------------

test("validateGreenfieldSource accepts a well-formed approved ticket", () => {
  const { ok, errors } = validateGreenfieldSource({
    type: "approved-ticket",
    reference: "#210",
    approvedBy: "per",
    approvedByRole: "qa-owner",
  });
  assert.equal(ok, true, errors.join("; "));
});

test("validateGreenfieldSource rejects a source type outside the known vocabulary", () => {
  const { ok, errors } = validateGreenfieldSource({
    type: "verbal-agreement",
    reference: "a chat",
    approvedBy: "per",
    approvedByRole: "qa-owner",
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("type")));
});

test("validateGreenfieldSource rejects a Domain Expert as the approving role", () => {
  const { ok, errors } = validateGreenfieldSource({
    type: "approved-example",
    reference: "examples/checkout.md",
    approvedBy: "dana",
    approvedByRole: "domain-expert",
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("approvedByRole")));
});

test("requireApprovedGreenfieldEvidence refuses to proceed with an empty source list", () => {
  const { ok, errors } = requireApprovedGreenfieldEvidence([]);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("at least one approved ticket or example")));
});

test("requireApprovedGreenfieldEvidence refuses to proceed when every source is invalid", () => {
  const { ok } = requireApprovedGreenfieldEvidence([{ type: "verbal-agreement", reference: "chat" }]);
  assert.equal(ok, false);
});

test("requireApprovedGreenfieldEvidence proceeds once at least one source validates", () => {
  const { ok, errors } = requireApprovedGreenfieldEvidence([
    { type: "approved-ticket", reference: "#210", approvedBy: "per", approvedByRole: "qa-owner" },
  ]);
  assert.equal(ok, true, errors.join("; "));
});

test("buildGreenfieldFact stays unknown, never a filled-in assumption, with no approved source", () => {
  const fact = buildGreenfieldFact("gf:checkout", "checkout flow has no approved ticket or example yet", []);
  assert.equal(fact.category, "greenfield-source");
  assert.equal(fact.provenance, "unknown");
  assert.equal(fact.evidence, undefined);
});

test("buildGreenfieldFact is reported, citing the approved source, once one exists", () => {
  const fact = buildGreenfieldFact("gf:checkout", "checkout flow evidence", [
    { type: "approved-ticket", reference: "#210", approvedBy: "per", approvedByRole: "qa-owner" },
  ]);
  assert.equal(fact.provenance, "reported");
  assert.ok(fact.evidence.includes("#210"));
});

test("buildGreenfieldFact ignores an invalid source rather than laundering it into evidence", () => {
  const fact = buildGreenfieldFact("gf:checkout", "checkout flow evidence", [
    { type: "verbal-agreement", reference: "a chat" },
  ]);
  assert.equal(fact.provenance, "unknown");
});
