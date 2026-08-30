// dynamic-qa/shared/scripts/seeded-defects.test.mjs
//
// Tier 1 coverage for the Seeded Binding Defect Case machinery (ticket
// #174). All case data here is a synthetic test fixture, never a real
// VibeFileSync pilot defect (see run brief decision 3).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEEDED_CHANGE_KIND,
  MIN_SEEDED_DEFECTS,
  MIN_ACCEPTED_UNCHANGED,
  createSeededDefectCase,
  attachDiagnosis,
  attachNegativeControlReport,
  stayedRedUntilRepairVerification,
  recordRepairReview,
  isCorrectlyHandledSeededDefect,
  wasAcceptedUnchanged,
  summarizeSeededDefectResults,
  evaluateSeededDefectThreshold,
} from "./seeded-defects.mjs";

const SHA = "a".repeat(40);

function baseDiagnosis({ attempts }) {
  return {
    schema: "dynamic-qa-diagnosis-v1",
    diagnosisId: "diag-seed-1",
    flowId: "update-replacement-retention",
    bindingId: "binding-update-replacement-retention",
    sourceCommit: SHA,
    generatedAt: "2026-02-01T00:00:00Z",
    owner: "binding",
    repeatability: "deterministic",
    repeatabilityBasis: "reproduction",
    status: "confirmed",
    failureClass: "binding-defect",
    causalChain: "The Binding's assertion compares the wrong path, so it fails on an otherwise-correct product run.",
    evidence: ["assertion diff shows the wrong file path compared"],
    counterEvidence: [],
    affectedIds: ["destination-content-matches-source"],
    attempts,
  };
}

function originalFailedAttempt() {
  return { attemptId: "att-1", kind: "original", verdict: "failed", recordedAt: "2026-02-01T00:00:00Z" };
}

function repairVerificationPassedAttempt() {
  return { attemptId: "att-2", kind: "repair-verification", verdict: "passed", recordedAt: "2026-02-02T00:00:00Z" };
}

function newCase(id = "seed-1") {
  return createSeededDefectCase({
    id,
    flowId: "update-replacement-retention",
    bindingId: "binding-update-replacement-retention",
    description: "A seeded off-by-one in the Binding's assertion path comparison — test fixture only.",
    injectedChange: { summary: "Compare against the wrong (sibling) path in the assertion, never the product code." },
  });
}

test("SEEDED_CHANGE_KIND is always binding — the constructor accepts no other kind", () => {
  assert.equal(SEEDED_CHANGE_KIND, "binding");
  const c = newCase();
  assert.equal(c.injectedChange.kind, "binding");
  assert.equal(c.productBehaviorChanged, false);
});

test("createSeededDefectCase has no parameter path to inject a product-kind change", () => {
  // There is no `kind` parameter accepted at all — passing one is silently
  // ignored by createSeededDefectCase's destructuring, which is itself part
  // of the structural guarantee: the function signature has no slot for it.
  const c = createSeededDefectCase({
    id: "seed-x",
    flowId: "flow-x",
    bindingId: "binding-x",
    description: "test",
    injectedChange: { kind: "product", summary: "attempted product-kind injection" },
  });
  assert.equal(c.injectedChange.kind, "binding");
});

test("a case starts red and cannot record repair review before diagnosis", () => {
  const c = newCase();
  assert.equal(c.status, "red");
  assert.throws(() => recordRepairReview(c, { outcome: "accepted-unchanged", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z", proposalOnly: true }));
});

test("attachDiagnosis refuses a non-binding-owned diagnosis", () => {
  const c = newCase();
  const productDiagnosis = { ...baseDiagnosis({ attempts: [originalFailedAttempt()] }), owner: "product", failureClass: "product-regression" };
  assert.throws(() => attachDiagnosis(c, productDiagnosis), /Binding-owned/);
});

test("attachDiagnosis accepts a binding-owned, shape-valid diagnosis and moves the case to diagnosed", () => {
  const c = newCase();
  const diagnosis = baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] });
  const diagnosed = attachDiagnosis(c, diagnosis);
  assert.equal(diagnosed.status, "diagnosed");
  assert.equal(diagnosed.diagnosis.owner, "binding");
});

test("stayedRedUntilRepairVerification: true when nothing has passed yet", () => {
  assert.equal(stayedRedUntilRepairVerification([originalFailedAttempt()]), true);
});

test("stayedRedUntilRepairVerification: true when the only pass is a repair-verification attempt", () => {
  assert.equal(stayedRedUntilRepairVerification([originalFailedAttempt(), repairVerificationPassedAttempt()]), true);
});

test("stayedRedUntilRepairVerification: false when a retry passes before any repair verification", () => {
  const sneakyRetry = { attemptId: "att-sneaky", kind: "retry", verdict: "passed", recordedAt: "2026-02-01T12:00:00Z" };
  assert.equal(stayedRedUntilRepairVerification([originalFailedAttempt(), sneakyRetry]), false);
});

test("recordRepairReview rejects an outcome that is not proposal-only", () => {
  const c = attachDiagnosis(newCase(), baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] }));
  assert.throws(
    () => recordRepairReview(c, { outcome: "accepted-unchanged", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z", proposalOnly: false }),
    /proposalOnly must be exactly true/,
  );
});

test("a fully-handled, accepted-unchanged case is correctly handled and counts toward acceptance", () => {
  let c = newCase();
  c = attachDiagnosis(c, baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] }));
  c = recordRepairReview(c, { outcome: "accepted-unchanged", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z", proposalOnly: true });
  assert.equal(c.status, "resolved");
  assert.equal(isCorrectlyHandledSeededDefect(c), true);
  assert.equal(wasAcceptedUnchanged(c), true);
});

test("a rejected proposal is correctly handled but does not count as accepted unchanged", () => {
  let c = newCase("seed-2");
  c = attachDiagnosis(c, baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] }));
  c = recordRepairReview(c, { outcome: "rejected", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z", proposalOnly: true });
  assert.equal(c.status, "rejected");
  assert.equal(isCorrectlyHandledSeededDefect(c), true);
  assert.equal(wasAcceptedUnchanged(c), false);
});

test("a case that never had its repair reviewed is not correctly handled", () => {
  let c = newCase("seed-3");
  c = attachDiagnosis(c, baseDiagnosis({ attempts: [originalFailedAttempt()] }));
  assert.equal(isCorrectlyHandledSeededDefect(c), false);
});

test("summarizeSeededDefectResults is unknown (never a fabricated zero) until measured:true is asserted", () => {
  const summary = summarizeSeededDefectResults([], {});
  assert.equal(summary.correctlyHandledCount.kind, "unknown");
  assert.equal(summary.acceptedUnchangedCount.kind, "unknown");
});

test("summarizeSeededDefectResults yields real known counts once measured:true, and the threshold gate uses them", () => {
  function handledAcceptedCase(id) {
    let c = createSeededDefectCase({
      id,
      flowId: "update-replacement-retention",
      bindingId: "binding-update-replacement-retention",
      description: "test",
      injectedChange: { summary: "test" },
    });
    c = attachDiagnosis(c, baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] }));
    c = recordRepairReview(c, { outcome: "accepted-unchanged", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z", proposalOnly: true });
    return c;
  }
  const cases = [handledAcceptedCase("s1"), handledAcceptedCase("s2"), handledAcceptedCase("s3")];
  const summary = summarizeSeededDefectResults(cases, { measured: true });
  assert.equal(summary.totalSeeded.kind, "known");
  assert.equal(summary.totalSeeded.value, 3);
  assert.equal(summary.correctlyHandledCount.value, 3);
  assert.equal(summary.acceptedUnchangedCount.value, 3);

  const gate = evaluateSeededDefectThreshold(summary);
  assert.equal(gate.met, true);
  assert.equal(gate.status, "met");
});

test("the threshold gate is measurement-required, never a pass, on an unknown summary", () => {
  const gate = evaluateSeededDefectThreshold(summarizeSeededDefectResults([], {}));
  assert.equal(gate.met, false);
  assert.equal(gate.status, "measurement-required");
});

test("the threshold gate fails below the minimums even with a known, measured summary", () => {
  const gate = evaluateSeededDefectThreshold({
    correctlyHandledCount: { kind: "known", value: MIN_SEEDED_DEFECTS - 1 },
    acceptedUnchangedCount: { kind: "known", value: MIN_ACCEPTED_UNCHANGED },
  });
  assert.equal(gate.met, false);
  assert.equal(gate.status, "failed");
});

test("attachNegativeControlReport requires an executed, assertion-failed report", () => {
  const c = newCase("seed-nc");
  const notExecuted = { stepId: "s", outcomeId: "o", mode: "simulated", appliedViolation: { outcome: "assertion-failed" } };
  assert.throws(() => attachNegativeControlReport(c, notExecuted));

  const executedAndFailed = { stepId: "s", outcomeId: "o", mode: "executed", appliedViolation: { outcome: "assertion-failed" } };
  const withControl = attachNegativeControlReport(c, executedAndFailed);
  assert.ok(withControl.negativeControlReport);
});
