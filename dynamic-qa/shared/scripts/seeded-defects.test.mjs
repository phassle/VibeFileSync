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
  attachRepairReviewPacket,
  recordRepairReviewOutcome,
  isCorrectlyHandledSeededDefect,
  wasAcceptedUnchanged,
  summarizeSeededDefectResults,
  evaluateSeededDefectThreshold,
} from "./seeded-defects.mjs";
import { evaluateRepairProposal } from "./repair.mjs";
import { computeBundleDigest } from "./failure-evidence.mjs";
import { buildNegativeControlPlan, EXECUTED_MODE } from "./negative-controls.mjs";
import { declaredViolationDigest } from "./repair.mjs";

const SHA = "a".repeat(40);

// --- a real, valid #160 evaluateRepairProposal fixture, mirroring
// repair.test.mjs's own baseRepairInput so seeded-defects gets the exact
// same real packet #160's own tests prove is shape-valid — never a second,
// hand-rolled packet shape. ---

const FLOW_DATA = {
  boundaries: [{ id: "checkout-service", role: "owned" }],
  steps: [
    { id: "given-a", kind: "given", intent: "..." },
    {
      id: "then-b",
      kind: "then",
      intent: "...",
      outcomes: [{ id: "destination-content-matches-source", expect: "..." }],
    },
  ],
};

function protectedSnapshot() {
  return {
    flowSemantics: "unchanged", tolerances: "unchanged", boundaries: "unchanged", dataMeaning: "unchanged",
    levelOverrides: "unchanged", lifecycle: "unchanged", enforcement: "unchanged", dependencies: "unchanged",
    lockfiles: "unchanged", workflows: "unchanged", profiles: "unchanged", identities: "unchanged",
    networkAccess: "unchanged", quarantine: "unchanged", requiredCheckPolicy: "unchanged",
  };
}

function acceptedRepairProposalResult(diagnosisRecord) {
  const plan = buildNegativeControlPlan(FLOW_DATA);
  const negativeControlReports = plan.map((v) => ({
    stepId: v.stepId,
    outcomeId: v.outcomeId,
    mode: EXECUTED_MODE,
    appliedViolation: { outcome: "assertion-failed", declaredViolationDigest: declaredViolationDigest(v) },
  }));
  const snapshot = protectedSnapshot();
  const withoutDigest = {
    schema: "dynamic-qa-failure-evidence-v1",
    bundleId: "bundle-seed-1",
    repository: "phassle/VibeFileSync",
    sourceCommit: SHA,
    generatedAt: "2026-02-01T00:00:00Z",
    workflow: { provider: "github-actions", workflowFile: "dynamic-qa.yml", runId: "1", runAttempt: "1" },
    flowId: diagnosisRecord.flowId,
    bindingId: diagnosisRecord.bindingId,
    profileId: "update-replacement-retention-profile",
    provenanceDigest: `sha256:${"a".repeat(64)}`,
    originalConclusion: "failed",
    diagnosisRecord,
    junitFacts: [{ suite: "update", name: "retention", verdict: "failed", message: "assertion failed", durationMs: 50 }],
    expectedVsObserved: [{ expectedOutcomeId: "destination-content-matches-source", expected: "prior content preserved", observed: "prior content missing" }],
    fixtureBoundaryEnforcement: { boundariesEnforced: ["checkout-service stubbed"], fixtureIsolation: "fresh namespace per run" },
    environmentHealth: { checkedAt: "2026-02-01T00:00:00Z", capabilities: [{ name: "runtime.node-available", status: "met" }] },
    approvedDiagnostics: [{ label: "console capture", digest: `sha256:${"a".repeat(64)}` }],
  };
  const bundle = { ...withoutDigest, bundleDigest: computeBundleDigest(withoutDigest) };

  return evaluateRepairProposal({
    bundle,
    hypothesesConsidered: [diagnosisRecord.causalChain],
    proposedFiles: [{ path: "tests/update-replacement-retention.spec.ts", content: "test('fixed', () => {});" }],
    assertions: [{ stepId: "then-b", outcomeId: "destination-content-matches-source", location: "update-replacement-retention.spec.ts:10" }],
    flowData: FLOW_DATA,
    affectedOutcomeIds: ["destination-content-matches-source"],
    protectedContractsBefore: snapshot,
    protectedContractsAfter: snapshot,
    negativeControlReports,
    neighboringFlows: [],
    residualRisk: ["none identified"],
  });
}

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

test("a case starts red and cannot have a Repair Review Packet attached before diagnosis", () => {
  const c = newCase();
  assert.equal(c.status, "red");
  assert.throws(() => attachRepairReviewPacket(c, { status: "proposal", packet: {} }));
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

test("recordRepairReviewOutcome refuses an outcome before a Repair Review Packet is attached (structural ordering)", () => {
  const c = attachDiagnosis(newCase(), baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] }));
  assert.equal(c.status, "diagnosed");
  assert.throws(
    () => recordRepairReviewOutcome(c, { outcome: "accepted-unchanged", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z" }),
    /must have an attached Repair Review Packet/,
  );
});

test("attachRepairReviewPacket refuses a refused (non-\"proposal\") evaluateRepairProposal result — a refusal has nothing to review", () => {
  const c = attachDiagnosis(newCase(), baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] }));
  const refused = { status: "refused", reasons: [{ gate: "bundle-eligibility" }], packet: null };
  assert.throws(() => attachRepairReviewPacket(c, refused), /requires a real evaluateRepairProposal result/);
});

test("a fully-handled, accepted-unchanged case is correctly handled and counts toward acceptance, carrying a real, shape-valid #160 Repair Review Packet", () => {
  let c = newCase();
  const diagnosis = baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] });
  c = attachDiagnosis(c, diagnosis);
  const proposalResult = acceptedRepairProposalResult(diagnosis);
  assert.equal(proposalResult.status, "proposal", JSON.stringify(proposalResult.reasons));
  c = attachRepairReviewPacket(c, proposalResult);
  assert.equal(c.status, "repair-proposed");
  assert.deepEqual(Object.keys(c.repairReviewPacket).sort(), ["diff", "evidence", "mappings", "protectedContractDigests", "residualRisk", "verification"].sort());

  c = recordRepairReviewOutcome(c, { outcome: "accepted-unchanged", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z" });
  assert.equal(c.status, "resolved");
  assert.equal(isCorrectlyHandledSeededDefect(c), true);
  assert.equal(wasAcceptedUnchanged(c), true);
});

test("a rejected proposal is correctly handled but does not count as accepted unchanged", () => {
  let c = newCase("seed-2");
  const diagnosis = baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] });
  c = attachDiagnosis(c, diagnosis);
  c = attachRepairReviewPacket(c, acceptedRepairProposalResult(diagnosis));
  c = recordRepairReviewOutcome(c, { outcome: "rejected", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z" });
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
    const diagnosis = baseDiagnosis({ attempts: [originalFailedAttempt(), repairVerificationPassedAttempt()] });
    c = attachDiagnosis(c, diagnosis);
    c = attachRepairReviewPacket(c, acceptedRepairProposalResult(diagnosis));
    c = recordRepairReviewOutcome(c, { outcome: "accepted-unchanged", reviewer: "Per", reviewedAt: "2026-02-03T00:00:00Z" });
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
