// dynamic-qa/shared/scripts/pilot-promotion.test.mjs
//
// Tier 1 coverage for the pilot promotion gate (ticket #175). One test per
// threshold blocking promotion when unmet (naming its measured value), plus
// missing-denominator -> pilot-incomplete, plus the two-gate approval
// requirement, plus documented relaxation. All figures below are synthetic
// test fixtures, never real VibeFileSync pilot evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeReportMetric, knownQuantity, unknownQuantity } from "./pilot-report.mjs";
import {
  evaluatePromotionThresholds,
  applyDocumentedRelaxations,
  bothApprovalsPresent,
  decidePilotPromotion,
  PR_P95_MAX_SECONDS,
} from "./pilot-promotion.mjs";

function metric(id, { numerator, denominator, provenance = "observed", extra } = {}) {
  return makeReportMetric({
    id,
    label: id,
    query: "test",
    interval: "trailing-4-weeks",
    source: "test-fixture",
    provenance,
    numerator,
    denominator,
    measuredAt: numerator?.kind === "known" && denominator?.kind === "known" ? "2026-03-01T00:00:00Z" : null,
    extra,
  });
}

function passingReport() {
  return {
    metrics: [
      metric("flow-coverage", { numerator: knownQuantity(5), denominator: knownQuantity(5) }),
      metric("escaped-regressions", { numerator: knownQuantity(0), denominator: knownQuantity(5) }),
      metric("pr-check-latency-p95", { numerator: knownQuantity(500), denominator: knownQuantity(25) }),
      metric("flake-false-positive-rate", { numerator: knownQuantity(1), denominator: knownQuantity(200) }),
      metric("maintenance-time", { numerator: knownQuantity(20), denominator: knownQuantity(8), extra: { maxEventMinutes: knownQuantity(45) } }),
    ],
  };
}

function passingSeededDefectSummary() {
  return { correctlyHandledCount: knownQuantity(3), acceptedUnchangedCount: knownQuantity(2) };
}

const ZERO_SAFETY_VIOLATIONS = knownQuantity(0);

const GOOD_APPROVALS = {
  qaOwnerGate: { present: true, identifier: "Per" },
  technicalOwnerGate: { present: true, identifier: "Technical Owner" },
};

test("a fully-passing pilot with both approvals promotes", () => {
  const decision = decidePilotPromotion({
    report: passingReport(),
    seededDefectSummary: passingSeededDefectSummary(),
    safetyViolations: ZERO_SAFETY_VIOLATIONS,
    approvals: GOOD_APPROVALS,
  });
  assert.equal(decision.promote, true);
  assert.equal(decision.decision, "promoted");
  assert.ok(decision.evaluations.every((e) => e.status === "met"));
});

test("threshold: coverage blocks promotion when below 5/5, naming its measured value", () => {
  const report = passingReport();
  report.metrics = report.metrics.map((m) => (m.id === "flow-coverage" ? metric("flow-coverage", { numerator: knownQuantity(4), denominator: knownQuantity(5) }) : m));
  const [coverage] = evaluatePromotionThresholds({ report, seededDefectSummary: passingSeededDefectSummary(), safetyViolations: ZERO_SAFETY_VIOLATIONS });
  assert.equal(coverage.status, "failed");
  assert.equal(coverage.metricUsed, "flow-coverage");
  assert.equal(coverage.measuredValue, "4/5");
});

test("threshold: coverage blocks promotion when provenance is not clean, even at 5/5", () => {
  const report = passingReport();
  report.metrics = report.metrics.map((m) => (m.id === "flow-coverage" ? metric("flow-coverage", { numerator: knownQuantity(5), denominator: knownQuantity(5), provenance: "reported" }) : m));
  const [coverage] = evaluatePromotionThresholds({ report, seededDefectSummary: passingSeededDefectSummary(), safetyViolations: ZERO_SAFETY_VIOLATIONS });
  assert.equal(coverage.status, "failed");
  assert.match(coverage.reason, /clean.*provenance/);
});

test("threshold: escapes blocks promotion on any nonzero count, naming its measured value", () => {
  const report = passingReport();
  report.metrics = report.metrics.map((m) => (m.id === "escaped-regressions" ? metric("escaped-regressions", { numerator: knownQuantity(1), denominator: knownQuantity(5) }) : m));
  const evals = evaluatePromotionThresholds({ report, seededDefectSummary: passingSeededDefectSummary(), safetyViolations: ZERO_SAFETY_VIOLATIONS });
  const escapes = evals.find((e) => e.thresholdId === "escapes");
  assert.equal(escapes.status, "failed");
  assert.equal(escapes.measuredValue, 1);
});

test("threshold: PR p95 blocks promotion above 9m30s, naming its measured value", () => {
  const report = passingReport();
  report.metrics = report.metrics.map((m) => (m.id === "pr-check-latency-p95" ? metric("pr-check-latency-p95", { numerator: knownQuantity(600), denominator: knownQuantity(25) }) : m));
  const evals = evaluatePromotionThresholds({ report, seededDefectSummary: passingSeededDefectSummary(), safetyViolations: ZERO_SAFETY_VIOLATIONS });
  const latency = evals.find((e) => e.thresholdId === "pr-latency-p95");
  assert.equal(latency.status, "failed");
  assert.equal(latency.measuredValue, 600);
  assert.equal(PR_P95_MAX_SECONDS, 570);
});

test("threshold: flake/false-positive rate blocks promotion above 1%, naming its measured value", () => {
  const report = passingReport();
  report.metrics = report.metrics.map((m) => (m.id === "flake-false-positive-rate" ? metric("flake-false-positive-rate", { numerator: knownQuantity(5), denominator: knownQuantity(200) }) : m));
  const evals = evaluatePromotionThresholds({ report, seededDefectSummary: passingSeededDefectSummary(), safetyViolations: ZERO_SAFETY_VIOLATIONS });
  const flake = evals.find((e) => e.thresholdId === "flake-false-positive-rate");
  assert.equal(flake.status, "failed");
  assert.equal(flake.measuredValue, 0.025);
});

test("threshold: maintenance blocks promotion on median over 30 minutes", () => {
  const report = passingReport();
  report.metrics = report.metrics.map((m) =>
    m.id === "maintenance-time" ? metric("maintenance-time", { numerator: knownQuantity(45), denominator: knownQuantity(8), extra: { maxEventMinutes: knownQuantity(45) } }) : m,
  );
  const evals = evaluatePromotionThresholds({ report, seededDefectSummary: passingSeededDefectSummary(), safetyViolations: ZERO_SAFETY_VIOLATIONS });
  const maintenance = evals.find((e) => e.thresholdId === "maintenance-effort");
  assert.equal(maintenance.status, "failed");
  assert.equal(maintenance.measuredValue.medianMinutes, 45);
});

test("threshold: maintenance blocks promotion on any single event over 60 minutes, even with a good median", () => {
  const report = passingReport();
  report.metrics = report.metrics.map((m) =>
    m.id === "maintenance-time" ? metric("maintenance-time", { numerator: knownQuantity(10), denominator: knownQuantity(8), extra: { maxEventMinutes: knownQuantity(75) } }) : m,
  );
  const evals = evaluatePromotionThresholds({ report, seededDefectSummary: passingSeededDefectSummary(), safetyViolations: ZERO_SAFETY_VIOLATIONS });
  const maintenance = evals.find((e) => e.thresholdId === "maintenance-effort");
  assert.equal(maintenance.status, "failed");
  assert.equal(maintenance.measuredValue.maxEventMinutes, 75);
});

test("threshold: seeded Binding defects blocks promotion below 3 correctly handled / 2 accepted unchanged", () => {
  const evals = evaluatePromotionThresholds({
    report: passingReport(),
    seededDefectSummary: { correctlyHandledCount: knownQuantity(2), acceptedUnchangedCount: knownQuantity(1) },
    safetyViolations: ZERO_SAFETY_VIOLATIONS,
  });
  const seeded = evals.find((e) => e.thresholdId === "seeded-binding-defects");
  assert.equal(seeded.status, "failed");
  assert.deepEqual(seeded.measuredValue, { correctlyHandledCount: 2, acceptedUnchangedCount: 1 });
});

test("threshold: safety violations blocks promotion on any nonzero count", () => {
  const evals = evaluatePromotionThresholds({
    report: passingReport(),
    seededDefectSummary: passingSeededDefectSummary(),
    safetyViolations: knownQuantity(1),
  });
  const safety = evals.find((e) => e.thresholdId === "safety-violations");
  assert.equal(safety.status, "failed");
  assert.equal(safety.measuredValue, 1);
});

test("a missing denominator yields pilot-incomplete, never a pass, for every report-derived threshold", () => {
  const report = passingReport();
  report.metrics = report.metrics.map((m) =>
    m.id === "pr-check-latency-p95" ? metric("pr-check-latency-p95", { numerator: unknownQuantity(), denominator: unknownQuantity() }) : m,
  );
  const evals = evaluatePromotionThresholds({ report, seededDefectSummary: passingSeededDefectSummary(), safetyViolations: ZERO_SAFETY_VIOLATIONS });
  const latency = evals.find((e) => e.thresholdId === "pr-latency-p95");
  assert.equal(latency.status, "pilot-incomplete");
  assert.equal(latency.measuredValue, null);
});

test("unmeasured seeded-defect and safety-violation evidence yields pilot-incomplete, not a pass", () => {
  const evals = evaluatePromotionThresholds({
    report: passingReport(),
    seededDefectSummary: { correctlyHandledCount: unknownQuantity(), acceptedUnchangedCount: unknownQuantity() },
    safetyViolations: unknownQuantity(),
  });
  assert.equal(evals.find((e) => e.thresholdId === "seeded-binding-defects").status, "pilot-incomplete");
  assert.equal(evals.find((e) => e.thresholdId === "safety-violations").status, "pilot-incomplete");
});

test("decidePilotPromotion reports pilot-incomplete as the overall decision when any threshold is unmeasured", () => {
  const decision = decidePilotPromotion({
    report: passingReport(),
    seededDefectSummary: { correctlyHandledCount: unknownQuantity(), acceptedUnchangedCount: unknownQuantity() },
    safetyViolations: ZERO_SAFETY_VIOLATIONS,
    approvals: GOOD_APPROVALS,
  });
  assert.equal(decision.promote, false);
  assert.equal(decision.decision, "pilot-incomplete");
});

test("bothApprovalsPresent rejects a single combined 'approved' field", () => {
  assert.equal(bothApprovalsPresent({ approved: true }), false);
});

test("bothApprovalsPresent requires both gates independently — one alone never suffices", () => {
  assert.equal(bothApprovalsPresent({ qaOwnerGate: { present: true, identifier: "Per" }, technicalOwnerGate: { present: false, identifier: "" } }), false);
  assert.equal(bothApprovalsPresent({ qaOwnerGate: { present: false, identifier: "" }, technicalOwnerGate: { present: true, identifier: "Tech" } }), false);
  assert.equal(bothApprovalsPresent(GOOD_APPROVALS), true);
});

test("all thresholds met but only one approval present still blocks promotion", () => {
  const decision = decidePilotPromotion({
    report: passingReport(),
    seededDefectSummary: passingSeededDefectSummary(),
    safetyViolations: ZERO_SAFETY_VIOLATIONS,
    approvals: { qaOwnerGate: { present: true, identifier: "Per" }, technicalOwnerGate: { present: false, identifier: "" } },
  });
  assert.equal(decision.promote, false);
  assert.equal(decision.decision, "awaiting-approval");
});

test("an approval recorded before the evidence it should bless does not promote", () => {
  const decision = decidePilotPromotion({
    report: passingReport(),
    seededDefectSummary: passingSeededDefectSummary(),
    safetyViolations: ZERO_SAFETY_VIOLATIONS,
    approvals: { ...GOOD_APPROVALS, decidedAt: "2020-01-01T00:00:00Z" },
  });
  assert.equal(decision.promote, false);
  assert.equal(decision.decision, "approval-predates-evidence");
});

test("applyDocumentedRelaxations requires a reason and an approver, and never overrides a met threshold", () => {
  const evals = evaluatePromotionThresholds({
    report: passingReport(),
    seededDefectSummary: passingSeededDefectSummary(),
    safetyViolations: knownQuantity(1), // fails
  });
  assert.throws(() => applyDocumentedRelaxations(evals, [{ thresholdId: "safety-violations", approvedBy: "Per" }]));
  assert.throws(() => applyDocumentedRelaxations(evals, [{ thresholdId: "safety-violations", reason: "test" }]));

  const relaxed = applyDocumentedRelaxations(evals, [
    { thresholdId: "safety-violations", reason: "one known, accepted low-severity finding", approvedBy: "Per", recordedAt: "2026-03-05T00:00:00Z" },
  ]);
  const safety = relaxed.find((e) => e.thresholdId === "safety-violations");
  assert.equal(safety.status, "relaxed");
  assert.equal(safety.measuredValue, 1, "the real measured value is preserved, never hidden by the relaxation");
  assert.ok(safety.relaxation.approvedBy);

  // Relaxing an already-met threshold is a no-op — nothing to relax.
  const coverageEval = evals.find((e) => e.thresholdId === "coverage");
  assert.equal(coverageEval.status, "met");
  const relaxedCoverage = applyDocumentedRelaxations(evals, [{ thresholdId: "coverage", reason: "x", approvedBy: "y", recordedAt: "2026-03-05T00:00:00Z" }]);
  assert.equal(relaxedCoverage.find((e) => e.thresholdId === "coverage").status, "met");
});

test("a relaxed threshold still requires both approvals to promote", () => {
  const decision = decidePilotPromotion({
    report: passingReport(),
    seededDefectSummary: passingSeededDefectSummary(),
    safetyViolations: knownQuantity(1),
    relaxations: [{ thresholdId: "safety-violations", reason: "test", approvedBy: "Per", recordedAt: "2026-03-05T00:00:00Z" }],
    approvals: GOOD_APPROVALS,
  });
  assert.equal(decision.promote, true);
  assert.equal(decision.evaluations.find((e) => e.thresholdId === "safety-violations").status, "relaxed");
});
