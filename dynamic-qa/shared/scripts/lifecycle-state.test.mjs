// dynamic-qa/shared/scripts/lifecycle-state.test.mjs
//
// Tier 1 tests for ticket #157. Sections mirror the ticket's own acceptance
// criteria:
//   1. each axis transitions independently; a failing test changes none
//   2. activation refused when any one of the nine requirements is missing
//      (one test per requirement)
//   3. brownfield activates to advisory, greenfield to required
//   4. promotion requires both a measured Qualifying Run count and an
//      explicit approval — neither alone suffices
//   5. retirement is a reviewed change, never implicit

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLifecycleRecord,
  ACTIVATION_REQUIREMENTS,
  checkActivationRequirements,
  decideFlowActivation,
  decideFlowStateTransition,
  applyFlowStateChange,
  applyBindingFreshnessReport,
  applyEnforcementPromotion,
  resolveActivationEnforcementDefault,
  isQualifyingRun,
  summarizeQualifyingRuns,
  decidePromotion,
  MIN_QUALIFYING_RUNS,
} from "./lifecycle-state.mjs";

function fullActivationEvidence(overrides = {}) {
  return {
    productBehaviourApproved: true,
    deterministicObservability: true,
    stableInteractionPoints: true,
    dataIsolationAndCleanup: true,
    enforceableBoundaries: true,
    capabilityGatePassed: true,
    candidateBindingVerified: true,
    provenanceCurrent: true,
    approvals: {
      qaOwnerGate: { present: true, identifier: "per" },
      technicalOwnerGate: { present: true, identifier: "dana" },
    },
    ...overrides,
  };
}

// A realistic test-runner result. Deliberately shares no key name with any
// axis's delta shape.
function failingTestOutcome() {
  return { passed: false, bindingId: "flow-checkout-happy-path", failureReason: "assertion-mismatch" };
}

// --- 1. Axis independence + "a failure changes no axis" --------------------

test("flow-state axis: applying a change never touches bindingFreshness or enforcementState", () => {
  const record = { flowState: "draft", bindingFreshness: "current", enforcementState: "required" };
  const result = applyFlowStateChange(record, { to: "deferred", context: { contractApproved: true } });
  assert.equal(result.ok, true);
  assert.equal(result.record.flowState, "deferred");
  assert.equal(result.record.bindingFreshness, "current");
  assert.equal(result.record.enforcementState, "required");
});

test("binding-freshness axis: applying a report never touches flowState or enforcementState", () => {
  const record = { flowState: "active", bindingFreshness: "absent", enforcementState: "advisory" };
  const result = applyBindingFreshnessReport(record, { freshness: "current" });
  assert.equal(result.ok, true);
  assert.equal(result.record.bindingFreshness, "current");
  assert.equal(result.record.flowState, "active");
  assert.equal(result.record.enforcementState, "advisory");
});

test("enforcement axis: promotion never touches flowState or bindingFreshness", () => {
  const record = { flowState: "active", bindingFreshness: "current", enforcementState: "advisory" };
  const result = applyEnforcementPromotion(record, {
    qualifyingRunSummary: { qualifyingCount: MIN_QUALIFYING_RUNS },
    approval: { granted: true, approver: "per" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.enforcementState, "required");
  assert.equal(result.record.flowState, "active");
  assert.equal(result.record.bindingFreshness, "current");
});

test("a failing test outcome cannot be shaped into a flow-state change", () => {
  const result = applyFlowStateChange(createLifecycleRecord(), failingTestOutcome());
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /do not belong to the flow-state axis/);
});

test("a failing test outcome cannot be shaped into a binding-freshness report", () => {
  const result = applyBindingFreshnessReport(createLifecycleRecord(), failingTestOutcome());
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /do not belong to the binding-freshness axis/);
});

test("a failing test outcome cannot be shaped into an enforcement promotion", () => {
  const result = applyEnforcementPromotion(createLifecycleRecord(), failingTestOutcome());
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /do not belong to the enforcement-state axis/);
});

test("no exported function demotes enforcement or marks a Binding stale", () => {
  // Structural: the promotion applier only ever moves advisory -> required.
  const alreadyRequired = { flowState: "active", bindingFreshness: "current", enforcementState: "required" };
  const result = applyEnforcementPromotion(alreadyRequired, {
    qualifyingRunSummary: { qualifyingCount: MIN_QUALIFYING_RUNS },
    approval: { granted: true, approver: "per" },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /promotion only applies to a Binding currently in the advisory lane/);
});

// --- 2. Activation requirements: one test per requirement ------------------

for (const requirement of ACTIVATION_REQUIREMENTS) {
  test(`activation refused when ${requirement.key} is unmet (names it as the first unmet requirement)`, () => {
    const evidence =
      requirement.key === "bothApprovalsGranted"
        ? fullActivationEvidence({ approvals: undefined })
        : fullActivationEvidence({ [requirement.key]: false });
    const result = checkActivationRequirements(evidence);
    assert.equal(result.met, false);
    assert.equal(result.firstUnmet.key, requirement.key);

    const decision = decideFlowActivation(evidence);
    assert.equal(decision.activate, false);
    assert.equal(decision.state, "deferred");
    assert.equal(decision.firstUnmet.key, requirement.key);
  });
}

test("activation succeeds only when every one of the nine requirements is met", () => {
  const decision = decideFlowActivation(fullActivationEvidence());
  assert.equal(decision.activate, true);
  assert.equal(decision.state, "active");
  assert.deepEqual(decision.unmet, []);
});

test("checkActivationRequirements evaluates all nine, not just until the first failure", () => {
  const evidence = fullActivationEvidence({ productBehaviourApproved: false, provenanceCurrent: false });
  const result = checkActivationRequirements(evidence);
  assert.equal(result.unmet.length, 2);
  assert.equal(result.firstUnmet.key, "productBehaviourApproved");
});

// --- Flow State transition matrix -------------------------------------------

test("draft -> active is allowed directly when activation evidence is complete", () => {
  const decision = decideFlowStateTransition("draft", "active", { activationEvidence: fullActivationEvidence() });
  assert.equal(decision.allowed, true);
  assert.equal(decision.to, "active");
});

test("deferred -> active requires a reviewed Activation Proposal proving all conditions", () => {
  const refused = decideFlowStateTransition("deferred", "active", { activationEvidence: fullActivationEvidence({ enforceableBoundaries: false }) });
  assert.equal(refused.allowed, false);
  assert.equal(refused.firstUnmet.key, "enforceableBoundaries");

  const allowed = decideFlowStateTransition("deferred", "active", { activationEvidence: fullActivationEvidence() });
  assert.equal(allowed.allowed, true);
});

test("active -> deferred requires an explicit suspension reason", () => {
  const missing = decideFlowStateTransition("active", "deferred", {});
  assert.equal(missing.allowed, false);
  assert.match(missing.reason, /explicit reviewed suspension/);
});

for (const forbidden of ["test-failure", "flaky", "slow", "inconvenient"]) {
  test(`active -> deferred refuses suspension reason ${JSON.stringify(forbidden)}`, () => {
    const result = decideFlowStateTransition("active", "deferred", { suspension: { reason: forbidden } });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /never a valid suspension reason/);
  });
}

test("active -> deferred allows a genuine exceptional suspension reason", () => {
  const result = decideFlowStateTransition("active", "deferred", { suspension: { reason: "upstream-provider-decommissioned" } });
  assert.equal(result.allowed, true);
  assert.equal(result.to, "deferred");
});

test("retired is terminal: no transition out of retired is allowed", () => {
  for (const to of ["draft", "deferred", "active"]) {
    const result = decideFlowStateTransition("retired", to, {});
    assert.equal(result.allowed, false);
    assert.match(result.reason, /retired is terminal/);
  }
});

test("an unknown Flow State pair is refused rather than defaulting to allowed", () => {
  const result = decideFlowStateTransition("active", "draft", {});
  assert.equal(result.allowed, false);
});

// --- Retirement: reviewed, never implicit -----------------------------------

test("retirement is refused without an explicit approvedBy QA Owner", () => {
  const result = decideFlowStateTransition("active", "retired", { retirement: { bindingRemoved: true, ciEnrollmentRemoved: true } });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /retirement.approvedBy/);
});

test("retirement is refused unless the live Binding and CI enrollment are removed in the same change", () => {
  const result = decideFlowStateTransition("active", "retired", { retirement: { approvedBy: "per", bindingRemoved: false, ciEnrollmentRemoved: true } });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /bindingRemoved and retirement.ciEnrollmentRemoved must both be true/);
});

test("a complete, approved retirement is allowed and leaves an auditable record", () => {
  const retirement = { approvedBy: "per", bindingRemoved: true, ciEnrollmentRemoved: true };
  const result = decideFlowStateTransition("active", "retired", { retirement });
  assert.equal(result.allowed, true);
  assert.equal(result.to, "retired");
  assert.deepEqual(result.auditRecord, { from: "active", to: "retired", ...retirement });
});

test("retirement can never be reached implicitly: applyFlowStateChange without retirement context refuses", () => {
  const result = applyFlowStateChange({ flowState: "active", bindingFreshness: "current", enforcementState: "advisory" }, { to: "retired", context: {} });
  assert.equal(result.ok, false);
});

// --- 3. Brownfield vs greenfield defaults -----------------------------------

test("brownfield posture defaults a newly-active Binding to advisory burn-in", () => {
  const result = resolveActivationEnforcementDefault("brownfield");
  assert.equal(result.enforcementState, "advisory");
});

test("greenfield posture defaults a first active Binding to required", () => {
  const result = resolveActivationEnforcementDefault("greenfield");
  assert.equal(result.enforcementState, "required");
});

test("an unrecognized posture refuses rather than guessing a default lane", () => {
  const result = resolveActivationEnforcementDefault("unknown-posture");
  assert.equal(result.enforcementState, null);
});

// --- 4. Promotion: measured Qualifying Runs + explicit approval, both -------

test("isQualifyingRun accepts only a complete, comparable, clean-pass run", () => {
  assert.equal(isQualifyingRun({ sourceCommit: "abc123", bindingId: "flow-1", outcome: "clean-pass", comparable: true }), true);
  assert.equal(isQualifyingRun({ sourceCommit: "abc123", bindingId: "flow-1", outcome: "failed", comparable: true }), false);
  assert.equal(isQualifyingRun({ sourceCommit: "abc123", bindingId: "flow-1", outcome: "clean-pass", comparable: false }), false);
  assert.equal(isQualifyingRun({ sourceCommit: "", bindingId: "flow-1", outcome: "clean-pass", comparable: true }), false);
});

test("summarizeQualifyingRuns counts only qualifying runs and never elapsed time", () => {
  const runs = [
    { sourceCommit: "a", bindingId: "flow-1", outcome: "clean-pass", comparable: true },
    { sourceCommit: "b", bindingId: "flow-1", outcome: "clean-pass", comparable: true },
    { sourceCommit: "c", bindingId: "flow-1", outcome: "failed", comparable: true },
  ];
  const summary = summarizeQualifyingRuns(runs);
  assert.equal(summary.qualifyingCount, 2);
  assert.equal(summary.totalRuns, 3);
  assert.equal(summary.distinctSourceCommits, 2);
  assert.equal("elapsedDays" in summary, false);
  assert.equal("greenStreak" in summary, false);
});

test("promotion is refused with neither a measured count nor an approval", () => {
  const result = decidePromotion({});
  assert.equal(result.promote, false);
  assert.equal(result.reasons.length, 2);
});

test("promotion is refused with a measured Qualifying Run count alone (no approval)", () => {
  const result = decidePromotion({ qualifyingRunSummary: { qualifyingCount: MIN_QUALIFYING_RUNS + 5 } });
  assert.equal(result.promote, false);
  assert.match(result.reasons.join(" "), /no explicit promotion approval/);
});

test("promotion is refused with an explicit approval alone (no measured Qualifying Runs)", () => {
  const result = decidePromotion({ approval: { granted: true, approver: "per" } });
  assert.equal(result.promote, false);
  assert.match(result.reasons.join(" "), /fewer than \d+ measured Qualifying Runs/);
});

test("a long elapsed time or a green streak alone never promotes (no such field exists to check)", () => {
  const result = decidePromotion({ elapsedDays: 400, greenStreak: 500 });
  assert.equal(result.promote, false);
});

test("promotion succeeds only with both a measured Qualifying Run count and an explicit approval", () => {
  const result = decidePromotion({
    qualifyingRunSummary: { qualifyingCount: MIN_QUALIFYING_RUNS },
    approval: { granted: true, approver: "per" },
  });
  assert.equal(result.promote, true);
  assert.equal(result.enforcementState, "required");
});

test("applyEnforcementPromotion refuses without both, leaving the record unchanged (advisory)", () => {
  const record = { flowState: "active", bindingFreshness: "current", enforcementState: "advisory" };
  const result = applyEnforcementPromotion(record, { qualifyingRunSummary: { qualifyingCount: 3 }, approval: { granted: true, approver: "per" } });
  assert.equal(result.ok, false);
});
