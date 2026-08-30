// dynamic-qa/shared/scripts/pilot-promotion.mjs
//
// The pilot promotion gate (ticket #175, SPEC-135.md §13 "Missing
// denominators or unmeasured thresholds mean pilot incomplete. Promotion
// remains an explicit QA Owner and Technical Owner decision. A failed
// threshold yields evidence for a later spec revision; it is not silently
// relaxed.").
//
// Evaluates every one of SPEC-135's seven pilot-success thresholds against
// REPORTED EVIDENCE ONLY — a #173 Pilot Report plus a #174 seeded-defect
// summary plus a caller-supplied safety-violation count. Every evaluation
// names the exact metric (or evidence source) it used, so a review packet
// never has to guess what a "failed" or "pilot-incomplete" verdict is about.
//
// This module NEVER promotes on its own. `decidePilotPromotion` requires,
// in addition to every threshold being met:
//   - both QA Owner and Technical Owner approval (reusing authority.mjs's
//     two-gate shape verbatim — a single combined "approved" field is
//     rejected exactly as it is in the Setup Review Packet, Repair Review
//     Packet, and Quarantine Record);
//   - approval to have been granted AFTER thresholds were already met (an
//     approval recorded before the evidence existed cannot retroactively
//     bless it).
//
// "No threshold can be relaxed without an explicit recorded decision":
// `applyDocumentedRelaxations` is the ONLY way a failed/incomplete
// threshold's verdict can be overridden, and every relaxation is itself
// named, reasoned, and attributed in the output — never silent.

import { checkMetricPasses } from "./pilot-report.mjs";
import { evaluateSeededDefectThreshold } from "./seeded-defects.mjs";
import { isQuantity } from "./baseline-plan.mjs";

const NINE_MINUTES_THIRTY_SECONDS = 9 * 60 + 30; // SPEC-135 §13: "PR p95 at most 9m30s"
const MAX_FLAKE_FALSE_POSITIVE_RATE = 0.01; // "at most 1%"
const MAX_MEDIAN_MAINTENANCE_MINUTES = 30;
const MAX_SINGLE_MAINTENANCE_EVENT_MINUTES = 60;

export {
  NINE_MINUTES_THIRTY_SECONDS as PR_P95_MAX_SECONDS,
  MAX_FLAKE_FALSE_POSITIVE_RATE,
  MAX_MEDIAN_MAINTENANCE_MINUTES,
  MAX_SINGLE_MAINTENANCE_EVENT_MINUTES,
};

// The seven thresholds, in SPEC-135 §13's own order. `id` is stable and is
// what a relaxation record must name.
export const THRESHOLD_IDS = Object.freeze([
  "coverage",
  "escapes",
  "pr-latency-p95",
  "flake-false-positive-rate",
  "maintenance-effort",
  "seeded-binding-defects",
  "safety-violations",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findMetric(report, id) {
  return Array.isArray(report?.metrics) ? report.metrics.find((m) => isPlainObject(m) && m.id === id) : undefined;
}

// Every evaluator returns the same shape:
//   { thresholdId, metricUsed, status: "met" | "failed" | "pilot-incomplete",
//     measuredValue, reason }
// `metricUsed` is ALWAYS present — the ticket's "each evaluation names the
// metric it used" requirement, even for a threshold sourced from outside
// the Pilot Report (seeded defects, safety violations).

function evaluateCoverage(report) {
  const metricUsed = "flow-coverage";
  const metric = findMetric(report, metricUsed);
  const check = checkMetricPasses(metric);
  if (!check.ok) {
    return { thresholdId: "coverage", metricUsed, status: "pilot-incomplete", measuredValue: null, reason: check.reason };
  }
  const { numerator, denominator, provenance } = metric;
  const measuredValue = `${numerator.value}/${denominator.value}`;
  if (numerator.value !== 5 || denominator.value !== 5) {
    return { thresholdId: "coverage", metricUsed, status: "failed", measuredValue, reason: "requires 5/5 flow coverage" };
  }
  if (provenance !== "observed") {
    return { thresholdId: "coverage", metricUsed, status: "failed", measuredValue, reason: `requires clean (observed) provenance, got ${JSON.stringify(provenance)}` };
  }
  return { thresholdId: "coverage", metricUsed, status: "met", measuredValue, reason: null };
}

function evaluateEscapes(report) {
  const metricUsed = "escaped-regressions";
  const metric = findMetric(report, metricUsed);
  const check = checkMetricPasses(metric);
  if (!check.ok) {
    return { thresholdId: "escapes", metricUsed, status: "pilot-incomplete", measuredValue: null, reason: check.reason };
  }
  const measuredValue = metric.numerator.value;
  const met = measuredValue === 0;
  return { thresholdId: "escapes", metricUsed, status: met ? "met" : "failed", measuredValue, reason: met ? null : "requires zero escaped regressions" };
}

function evaluatePrLatency(report) {
  const metricUsed = "pr-check-latency-p95";
  const metric = findMetric(report, metricUsed);
  const check = checkMetricPasses(metric);
  if (!check.ok) {
    return { thresholdId: "pr-latency-p95", metricUsed, status: "pilot-incomplete", measuredValue: null, reason: check.reason };
  }
  const measuredValue = metric.numerator.value;
  const met = measuredValue <= NINE_MINUTES_THIRTY_SECONDS;
  return {
    thresholdId: "pr-latency-p95",
    metricUsed,
    status: met ? "met" : "failed",
    measuredValue,
    reason: met ? null : `requires p95 <= ${NINE_MINUTES_THIRTY_SECONDS}s, measured ${measuredValue}s`,
  };
}

function evaluateFlakeFalsePositive(report) {
  const metricUsed = "flake-false-positive-rate";
  const metric = findMetric(report, metricUsed);
  const check = checkMetricPasses(metric);
  if (!check.ok) {
    return { thresholdId: "flake-false-positive-rate", metricUsed, status: "pilot-incomplete", measuredValue: null, reason: check.reason };
  }
  if (metric.denominator.value === 0) {
    return { thresholdId: "flake-false-positive-rate", metricUsed, status: "pilot-incomplete", measuredValue: null, reason: "denominator is zero — a rate with no observed runs is not measured" };
  }
  const rate = metric.numerator.value / metric.denominator.value;
  const met = rate <= MAX_FLAKE_FALSE_POSITIVE_RATE;
  return {
    thresholdId: "flake-false-positive-rate",
    metricUsed,
    status: met ? "met" : "failed",
    measuredValue: rate,
    reason: met ? null : `requires rate <= ${MAX_FLAKE_FALSE_POSITIVE_RATE}, measured ${rate}`,
  };
}

function evaluateMaintenance(report) {
  const metricUsed = "maintenance-time";
  const metric = findMetric(report, metricUsed);
  const check = checkMetricPasses(metric);
  if (!check.ok) {
    return { thresholdId: "maintenance-effort", metricUsed, status: "pilot-incomplete", measuredValue: null, reason: check.reason };
  }
  const maxEvent = metric.extra?.maxEventMinutes;
  if (!isQuantity(maxEvent) || maxEvent.kind !== "known") {
    return {
      thresholdId: "maintenance-effort",
      metricUsed,
      status: "pilot-incomplete",
      measuredValue: null,
      reason: "maintenance-time metric is missing a known extra.maxEventMinutes — the single-event ceiling is unmeasured",
    };
  }
  const medianMinutes = metric.numerator.value;
  const measuredValue = { medianMinutes, maxEventMinutes: maxEvent.value };
  if (medianMinutes > MAX_MEDIAN_MAINTENANCE_MINUTES) {
    return {
      thresholdId: "maintenance-effort",
      metricUsed,
      status: "failed",
      measuredValue,
      reason: `requires median maintenance <= ${MAX_MEDIAN_MAINTENANCE_MINUTES} minutes, measured ${medianMinutes}`,
    };
  }
  if (maxEvent.value > MAX_SINGLE_MAINTENANCE_EVENT_MINUTES) {
    return {
      thresholdId: "maintenance-effort",
      metricUsed,
      status: "failed",
      measuredValue,
      reason: `requires no single maintenance event over ${MAX_SINGLE_MAINTENANCE_EVENT_MINUTES} minutes, measured ${maxEvent.value}`,
    };
  }
  return { thresholdId: "maintenance-effort", metricUsed, status: "met", measuredValue, reason: null };
}

function evaluateSeededDefects(seededDefectSummary) {
  const metricUsed = "seeded-defect-summary";
  const gate = evaluateSeededDefectThreshold(seededDefectSummary);
  const measuredValue =
    gate.correctlyHandledCount === null ? null : { correctlyHandledCount: gate.correctlyHandledCount, acceptedUnchangedCount: gate.acceptedUnchangedCount };
  // Normalize seeded-defects.mjs's own "measurement-required" vocabulary to
  // this module's three-state status (met | failed | pilot-incomplete) so
  // decidePilotPromotion has exactly one incomplete-status spelling to check
  // across all seven thresholds.
  const status = gate.status === "measurement-required" ? "pilot-incomplete" : gate.status;
  return {
    thresholdId: "seeded-binding-defects",
    metricUsed,
    status,
    measuredValue,
    reason: gate.met
      ? null
      : status === "pilot-incomplete"
        ? "seeded-defect counts are not yet measured"
        : `requires >= 3 correctly handled and >= 2 accepted unchanged`,
  };
}

function evaluateSafetyViolations(safetyViolations) {
  const metricUsed = "safety-violation-count";
  if (!isQuantity(safetyViolations) || safetyViolations.kind !== "known") {
    return { thresholdId: "safety-violations", metricUsed, status: "pilot-incomplete", measuredValue: null, reason: "safety-violation count is not yet measured" };
  }
  const measuredValue = safetyViolations.value;
  const met = measuredValue === 0;
  return {
    thresholdId: "safety-violations",
    metricUsed,
    status: met ? "met" : "failed",
    measuredValue,
    reason: met ? null : "requires zero safety violations",
  };
}

/**
 * Evaluates all seven thresholds against reported evidence. Never stops at
 * the first failure — a review packet needs the complete list. Each
 * returned entry names the exact metric it used (`metricUsed`), per the
 * ticket's own acceptance criterion.
 */
export function evaluatePromotionThresholds({ report, seededDefectSummary, safetyViolations } = {}) {
  return [
    evaluateCoverage(report),
    evaluateEscapes(report),
    evaluatePrLatency(report),
    evaluateFlakeFalsePositive(report),
    evaluateMaintenance(report),
    evaluateSeededDefects(seededDefectSummary),
    evaluateSafetyViolations(safetyViolations),
  ];
}

// ---------------------------------------------------------------------------
// Documented relaxation — the ONLY way a threshold's verdict can be
// overridden, and it is never silent.
// ---------------------------------------------------------------------------

/**
 * `relaxations`: [{ thresholdId, reason, approvedBy, recordedAt }]. Applies
 * ONLY to entries whose thresholdId matches an evaluation currently NOT
 * "met" — a relaxation of an already-met threshold is refused (there is
 * nothing to relax), and an unreasoned or unattributed relaxation is
 * refused outright. The returned evaluation for a relaxed threshold keeps
 * its real measuredValue and reason, but its status becomes "relaxed"
 * (never silently rewritten to "met") with the relaxation record attached —
 * so a review packet can never mistake a relaxed threshold for one that
 * was actually satisfied by evidence.
 */
export function applyDocumentedRelaxations(evaluations, relaxations = []) {
  if (!Array.isArray(relaxations) || relaxations.length === 0) return evaluations;

  const byId = new Map(relaxations.map((r) => [r?.thresholdId, r]));
  return evaluations.map((evaluation) => {
    const relaxation = byId.get(evaluation.thresholdId);
    if (!relaxation) return evaluation;
    if (evaluation.status === "met") return evaluation; // nothing to relax
    if (typeof relaxation.reason !== "string" || relaxation.reason.trim() === "") {
      throw new Error(`applyDocumentedRelaxations: relaxation for ${JSON.stringify(evaluation.thresholdId)} requires a non-empty reason`);
    }
    if (typeof relaxation.approvedBy !== "string" || relaxation.approvedBy.trim() === "") {
      throw new Error(`applyDocumentedRelaxations: relaxation for ${JSON.stringify(evaluation.thresholdId)} requires a named approvedBy`);
    }
    if (typeof relaxation.recordedAt !== "string" || Number.isNaN(Date.parse(relaxation.recordedAt))) {
      throw new Error(`applyDocumentedRelaxations: relaxation for ${JSON.stringify(evaluation.thresholdId)} requires a parseable recordedAt`);
    }
    return {
      ...evaluation,
      status: "relaxed",
      relaxation: { reason: relaxation.reason, approvedBy: relaxation.approvedBy, recordedAt: relaxation.recordedAt },
    };
  });
}

// ---------------------------------------------------------------------------
// Approvals — reuses authority.mjs's two-gate shape verbatim.
// ---------------------------------------------------------------------------

function gateIsSatisfied(gate) {
  return isPlainObject(gate) && gate.present === true && typeof gate.identifier === "string" && gate.identifier.trim() !== "";
}

/**
 * Both gates required, independently, exactly like every other approval
 * surface in this bundle (Setup Review Packet, Repair Review Packet,
 * Quarantine Record, authority.mjs's own validateAuthorityRecord). A single
 * combined "approved" field is never accepted.
 */
export function bothApprovalsPresent(approvals) {
  if (!isPlainObject(approvals)) return false;
  if (Object.prototype.hasOwnProperty.call(approvals, "approved")) return false; // collapsed-gate shape, refused
  return gateIsSatisfied(approvals.qaOwnerGate) && gateIsSatisfied(approvals.technicalOwnerGate);
}

// ---------------------------------------------------------------------------
// The decision itself.
// ---------------------------------------------------------------------------

/**
 * Decides advisory -> required promotion for the whole pilot. Requires,
 * ALL of:
 *   - every threshold "met" (after any documented relaxations are applied);
 *   - both QA Owner and Technical Owner approval present;
 *   - approvals.decidedAt (when given) not earlier than the LATEST
 *     measuredAt among the report's own metrics — an approval predating the
 *     evidence it is supposed to bless cannot count.
 * Never throws for ordinary unmet-threshold or missing-approval cases;
 * returns a decision object naming every blocking reason.
 */
export function decidePilotPromotion({ report, seededDefectSummary, safetyViolations, approvals, relaxations } = {}) {
  const rawEvaluations = evaluatePromotionThresholds({ report, seededDefectSummary, safetyViolations });
  const evaluations = applyDocumentedRelaxations(rawEvaluations, relaxations);

  const unmet = evaluations.filter((e) => e.status !== "met" && e.status !== "relaxed");
  const incomplete = evaluations.filter((e) => e.status === "pilot-incomplete");

  if (unmet.length > 0) {
    return {
      promote: false,
      decision: incomplete.length > 0 ? "pilot-incomplete" : "thresholds-not-met",
      evaluations,
      blockingReasons: unmet.map((e) => `${e.thresholdId} (${e.metricUsed}): ${e.status} — ${e.reason}`),
    };
  }

  if (!bothApprovalsPresent(approvals)) {
    return {
      promote: false,
      decision: "awaiting-approval",
      evaluations,
      blockingReasons: ["thresholds are met, but promotion requires BOTH an explicit QA Owner and an explicit Technical Owner approval — neither alone suffices"],
    };
  }

  const latestMeasuredAt = Array.isArray(report?.metrics)
    ? report.metrics.reduce((latest, m) => {
        const t = m?.measuredAt ? Date.parse(m.measuredAt) : NaN;
        return Number.isNaN(t) ? latest : Math.max(latest, t);
      }, -Infinity)
    : -Infinity;
  if (approvals.decidedAt !== undefined) {
    const decidedAt = Date.parse(approvals.decidedAt);
    if (Number.isNaN(decidedAt)) {
      return { promote: false, decision: "malformed-approval", evaluations, blockingReasons: ["approvals.decidedAt must be a parseable timestamp when present"] };
    }
    if (Number.isFinite(latestMeasuredAt) && decidedAt < latestMeasuredAt) {
      return {
        promote: false,
        decision: "approval-predates-evidence",
        evaluations,
        blockingReasons: ["approval was recorded before the evidence it is meant to bless — an approval cannot retroactively cover measurements taken after it was given"],
      };
    }
  }

  return { promote: true, decision: "promoted", evaluations, blockingReasons: [] };
}
