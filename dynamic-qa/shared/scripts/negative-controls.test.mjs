// dynamic-qa/shared/scripts/negative-controls.test.mjs
//
// Tier 1 coverage for the negative-control gate (negative-controls.mjs,
// #152, SPEC-135 user story 59): violation derivation for several
// outcome/tolerance shapes; an always-true assertion is caught because its
// control passes; a correct assertion whose control fails is accepted; a
// missing control fails; an unrun/simulated control cannot be recorded as
// satisfied.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveDeclaredViolation,
  buildNegativeControlPlan,
  judgeNegativeControl,
  checkNegativeControlCoverage,
  OUTCOME_MODES,
  EXECUTED_MODE,
} from "./negative-controls.mjs";

// --- deriveDeclaredViolation across tolerance shapes -----------------------

test("deriveDeclaredViolation: exact tolerance (default when omitted) demands any differing value", () => {
  const v = deriveDeclaredViolation({ stepId: "then-a", outcomeId: "o1", tolerance: undefined });
  assert.equal(v.kind, "exact");
  assert.match(v.statement, /differ from the exact expected value/);
  assert.equal(v.requiresManualStatement, false);
});

test("deriveDeclaredViolation: normalized-text demands a difference that survives normalization", () => {
  const v = deriveDeclaredViolation({
    stepId: "s",
    outcomeId: "o",
    tolerance: { kind: "normalized-text", ignore_case: true },
  });
  assert.equal(v.kind, "normalized-text");
  assert.match(v.statement, /survives the declared normalization/);
});

test("deriveDeclaredViolation: numeric tolerance names the exact epsilon window (abs)", () => {
  const v = deriveDeclaredViolation({
    stepId: "s",
    outcomeId: "o",
    tolerance: { kind: "numeric", abs_epsilon: 0.5 },
  });
  assert.equal(v.kind, "numeric");
  assert.match(v.statement, /abs_epsilon=0\.5/);
  assert.match(v.statement, /strictly outside/);
});

test("deriveDeclaredViolation: numeric tolerance names the exact epsilon window (rel)", () => {
  const v = deriveDeclaredViolation({
    stepId: "s",
    outcomeId: "o",
    tolerance: { kind: "numeric", rel_epsilon: 0.1 },
  });
  assert.match(v.statement, /rel_epsilon=0\.1/);
});

test("deriveDeclaredViolation: temporal tolerance names epsilon_seconds", () => {
  const v = deriveDeclaredViolation({
    stepId: "s",
    outcomeId: "o",
    tolerance: { kind: "temporal", epsilon_seconds: 30 },
  });
  assert.equal(v.kind, "temporal");
  assert.match(v.statement, /epsilon_seconds=30/);
});

test("deriveDeclaredViolation: unordered-set demands a membership change, not reordering", () => {
  const v = deriveDeclaredViolation({ stepId: "s", outcomeId: "o", tolerance: { kind: "unordered-set" } });
  assert.match(v.statement, /gain or lose at least one member/);
  assert.match(v.statement, /order alone must not/);
});

test("deriveDeclaredViolation: presentation demands a non-ignorable aspect break, not an ignored one", () => {
  const v = deriveDeclaredViolation({
    stepId: "s",
    outcomeId: "o",
    tolerance: { kind: "presentation", aspects: ["layout"] },
  });
  assert.match(v.statement, /content, values, behavior, accessibility semantics, or counts/);
  assert.match(v.statement, /not a valid violation/);
});

test("deriveDeclaredViolation: custom tolerance surfaces the approver's own reason and still requires a control", () => {
  const v = deriveDeclaredViolation({
    stepId: "s",
    outcomeId: "o",
    tolerance: { kind: "custom", approved_by: "qa-owner", reason: "known renderer quirk" },
  });
  assert.equal(v.kind, "custom");
  assert.equal(v.requiresManualStatement, true);
  assert.match(v.statement, /qa-owner/);
  assert.match(v.statement, /known renderer quirk/);
});

test("deriveDeclaredViolation: custom tolerance with no reason still requires a control, not an exemption", () => {
  const v = deriveDeclaredViolation({ stepId: "s", outcomeId: "o", tolerance: { kind: "custom" } });
  assert.equal(v.requiresManualStatement, true);
  assert.match(v.statement, /still required/);
});

test("deriveDeclaredViolation: notes the owned boundary when one is supplied", () => {
  const v = deriveDeclaredViolation({
    stepId: "s",
    outcomeId: "o",
    tolerance: { kind: "exact" },
    ownedBoundary: { id: "checkout-service", role: "owned" },
  });
  assert.match(v.statement, /owned boundary "checkout-service"/);
});

// --- buildNegativeControlPlan: one violation per declared outcome ----------

const FLOW_DATA = {
  boundaries: [
    { id: "checkout-service", role: "owned" },
    { id: "email-provider", role: "dependency" },
  ],
  steps: [
    { id: "given-a", kind: "given", intent: "..." },
    {
      id: "then-b",
      kind: "then",
      intent: "...",
      outcomes: [
        { id: "outcome-exact", expect: "..." },
        { id: "outcome-numeric", expect: "...", tolerance: { kind: "numeric", abs_epsilon: 1 } },
      ],
    },
  ],
};

test("buildNegativeControlPlan derives one violation per declared Expected Outcome, using the owned boundary", () => {
  const plan = buildNegativeControlPlan(FLOW_DATA);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].outcomeId, "outcome-exact");
  assert.equal(plan[0].kind, "exact");
  assert.match(plan[0].statement, /checkout-service/);
  assert.equal(plan[1].outcomeId, "outcome-numeric");
  assert.equal(plan[1].kind, "numeric");
});

// --- judgeNegativeControl: the fail-closed judgment ------------------------

test("judgeNegativeControl accepts a genuinely executed control whose assertion failed", () => {
  const result = judgeNegativeControl({
    stepId: "then-b",
    outcomeId: "outcome-exact",
    mode: EXECUTED_MODE,
    appliedViolation: { outcome: "assertion-failed" },
  });
  assert.deepEqual(result, { accepted: true, reason: null });
});

test("judgeNegativeControl rejects an always-true assertion: the control ran but did not fail", () => {
  const result = judgeNegativeControl({
    stepId: "then-b",
    outcomeId: "outcome-exact",
    mode: EXECUTED_MODE,
    appliedViolation: { outcome: "assertion-passed" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "assertion-did-not-fail");
});

test("judgeNegativeControl rejects a report with no mode at all — never mistaken for executed", () => {
  const result = judgeNegativeControl({
    stepId: "then-b",
    outcomeId: "outcome-exact",
    appliedViolation: { outcome: "assertion-failed" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "not-executed");
});

for (const fakeMode of ["simulated", "skipped", "assumed", "planned", "dry-run", "", null, 0, false]) {
  test(`judgeNegativeControl rejects mode ${JSON.stringify(fakeMode)} — only the literal "executed" ever counts`, () => {
    const result = judgeNegativeControl({
      stepId: "s",
      outcomeId: "o",
      mode: fakeMode,
      appliedViolation: { outcome: "assertion-failed" },
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "not-executed");
  });
}

test("judgeNegativeControl rejects a crash as an unrelated failure, not a valid control", () => {
  const result = judgeNegativeControl({
    stepId: "s",
    outcomeId: "o",
    mode: EXECUTED_MODE,
    appliedViolation: { outcome: "crash" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unrelated-failure");
});

test("judgeNegativeControl rejects a timeout as an unrelated failure, not a valid control", () => {
  const result = judgeNegativeControl({
    stepId: "s",
    outcomeId: "o",
    mode: EXECUTED_MODE,
    appliedViolation: { outcome: "timeout" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unrelated-failure");
});

test("judgeNegativeControl rejects a malformed report shape", () => {
  assert.equal(judgeNegativeControl(null).reason, "malformed-report");
  assert.equal(judgeNegativeControl({}).reason, "malformed-report");
  assert.equal(judgeNegativeControl({ stepId: "s" }).reason, "malformed-report");
  assert.equal(
    judgeNegativeControl({ stepId: "s", outcomeId: "o", mode: EXECUTED_MODE, appliedViolation: { outcome: "nonsense" } })
      .reason,
    "malformed-report",
  );
});

test("OUTCOME_MODES is the closed set judgeNegativeControl recognizes", () => {
  assert.deepEqual(OUTCOME_MODES, ["assertion-failed", "assertion-passed", "crash", "timeout"]);
});

// --- checkNegativeControlCoverage: every assertion needs an accepted control

const ASSERTIONS = [
  { stepId: "then-b", outcomeId: "outcome-exact", location: "a.spec.ts:1" },
  { stepId: "then-b", outcomeId: "outcome-numeric", location: "a.spec.ts:2" },
];

test("checkNegativeControlCoverage accepts a correct assertion whose control failed for both outcomes", () => {
  const reports = [
    { stepId: "then-b", outcomeId: "outcome-exact", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
    { stepId: "then-b", outcomeId: "outcome-numeric", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
  ];
  const result = checkNegativeControlCoverage(ASSERTIONS, reports);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("checkNegativeControlCoverage accepts multiple assertions sharing one outcome's single control", () => {
  const assertions = [
    { stepId: "then-b", outcomeId: "outcome-exact", location: "a.spec.ts:1" },
    { stepId: "then-b", outcomeId: "outcome-exact", location: "a.spec.ts:1b" },
  ];
  const reports = [
    { stepId: "then-b", outcomeId: "outcome-exact", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
  ];
  const result = checkNegativeControlCoverage(assertions, reports);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("fail-closed: checkNegativeControlCoverage rejects an always-true assertion — its control passed", () => {
  const reports = [
    { stepId: "then-b", outcomeId: "outcome-exact", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-passed" } },
    { stepId: "then-b", outcomeId: "outcome-numeric", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
  ];
  const result = checkNegativeControlCoverage(ASSERTIONS, reports);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /outcome-exact.*rejected \(assertion-did-not-fail\)/.test(e.message)));
});

test("fail-closed: checkNegativeControlCoverage rejects a missing control as a failure, not a warning", () => {
  const reports = [
    { stepId: "then-b", outcomeId: "outcome-exact", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
    // outcome-numeric has no report at all.
  ];
  const result = checkNegativeControlCoverage(ASSERTIONS, reports);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /outcome-numeric.*no negative control report at all/.test(e.message)));
});

test("fail-closed: checkNegativeControlCoverage rejects an unrun/simulated control — it cannot count as satisfied", () => {
  const reports = [
    { stepId: "then-b", outcomeId: "outcome-exact", mode: "simulated", appliedViolation: { outcome: "assertion-failed" } },
    { stepId: "then-b", outcomeId: "outcome-numeric", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
  ];
  const result = checkNegativeControlCoverage(ASSERTIONS, reports);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /outcome-exact.*rejected \(not-executed\)/.test(e.message)));
});

test("fail-closed: checkNegativeControlCoverage rejects a report that crashed instead of exercising the assertion", () => {
  const reports = [
    { stepId: "then-b", outcomeId: "outcome-exact", mode: EXECUTED_MODE, appliedViolation: { outcome: "crash" } },
    { stepId: "then-b", outcomeId: "outcome-numeric", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
  ];
  const result = checkNegativeControlCoverage(ASSERTIONS, reports);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /outcome-exact.*rejected \(unrelated-failure\)/.test(e.message)));
});

test("fail-closed: checkNegativeControlCoverage rejects a non-list assertions argument", () => {
  const result = checkNegativeControlCoverage(null, []);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /assertions must be a list/.test(e.message)));
});

test("fail-closed: checkNegativeControlCoverage rejects a non-list reports argument", () => {
  const result = checkNegativeControlCoverage(ASSERTIONS, null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /reports must be a list/.test(e.message)));
});

test("fail-closed: checkNegativeControlCoverage rejects a malformed report entry", () => {
  const result = checkNegativeControlCoverage(ASSERTIONS, [{ mode: EXECUTED_MODE }]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /stepId, outcomeId, mode, and appliedViolation/.test(e.message)));
});

test("a rejection for a key is never silently overwritten by a later weaker report for the same key", () => {
  const reports = [
    { stepId: "then-b", outcomeId: "outcome-exact", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
    { stepId: "then-b", outcomeId: "outcome-exact", mode: "simulated", appliedViolation: { outcome: "assertion-failed" } },
    { stepId: "then-b", outcomeId: "outcome-numeric", mode: EXECUTED_MODE, appliedViolation: { outcome: "assertion-failed" } },
  ];
  const result = checkNegativeControlCoverage(ASSERTIONS, reports);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("no assertions at all means no coverage obligation", () => {
  const result = checkNegativeControlCoverage([], []);
  assert.equal(result.valid, true);
});
