// dynamic-qa/shared/scripts/baseline-plan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SUPPORTED_SCHEMA,
  BASELINE_PLAN_REPO_PATH,
  REQUIRED_METRIC_IDS,
  MIN_BURN_IN_CALENDAR_DAYS,
  MIN_RELEVANT_PR_RUNS,
  unknownQuantity,
  notApplicableQuantity,
  knownQuantity,
  isQuantity,
  metricStatus,
  makeMetric,
  computeReadiness,
  validateBaselinePlan,
  buildBaselinePlan,
  renderBaselinePlanYAML,
  parseBaselinePlanDocument,
  resumeBaselinePlan,
  saveBaselinePlanToRepo,
} from "./baseline-plan.mjs";
import { contentDigest } from "./canonical-digest.mjs";

const NOW = new Date("2026-06-01T00:00:00Z");
const STARTED_LONG_AGO = new Date(NOW.getTime() - (MIN_BURN_IN_CALENDAR_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
const STARTED_RECENTLY = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

function readyMetric(id, { numeratorValue = 3, denominatorValue = 30 } = {}) {
  return makeMetric({
    id,
    label: `label for ${id}`,
    query: `select * from ${id}`,
    interval: "trailing-30-days",
    source: "github-actions",
    provenance: "observed",
    numerator: knownQuantity(numeratorValue),
    denominator: knownQuantity(denominatorValue),
    collectedAt: NOW.toISOString(),
  });
}

function unknownMetric(id) {
  return makeMetric({
    id,
    label: `label for ${id}`,
    query: `select * from ${id}`,
    interval: "trailing-30-days",
    source: "github-actions",
    provenance: "unknown",
    numerator: unknownQuantity(),
    denominator: unknownQuantity(),
    collectedAt: null,
  });
}

function notApplicableMetric(id, reason = "not applicable for a new capability") {
  return makeMetric({
    id,
    label: `label for ${id}`,
    query: `select * from ${id}`,
    interval: "trailing-30-days",
    source: "github-actions",
    provenance: "reported",
    numerator: notApplicableQuantity(reason),
    denominator: notApplicableQuantity(reason),
    collectedAt: null,
  });
}

function allReadyMetrics({ runCount = MIN_RELEVANT_PR_RUNS } = {}) {
  return REQUIRED_METRIC_IDS.map((id) =>
    id === "repair-decisions"
      ? notApplicableMetric(id)
      : id === "pr-check-latency-p95"
        ? readyMetric(id, { denominatorValue: runCount })
        : readyMetric(id),
  );
}

function basePlanInput(overrides = {}) {
  return {
    schema: SUPPORTED_SCHEMA,
    id: "vibefilesync-pilot-baseline",
    revision: 1,
    owners: { qaOwner: "qa-owner", technicalOwner: "tech-owner" },
    repository: "phassle/VibeFileSync",
    window: { startedAt: STARTED_LONG_AGO },
    metrics: allReadyMetrics(),
    generatedAt: NOW.toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Quantity: unknown vs zero vs not-applicable are distinguishable, and every
// pairing is tested explicitly.
// ---------------------------------------------------------------------------

test("unknown, zero (a known value of 0), and not-applicable are three distinct, well-formed Quantity shapes", () => {
  const unknown = unknownQuantity();
  const zero = knownQuantity(0);
  const na = notApplicableQuantity("no PRs ran in this window");

  assert.ok(isQuantity(unknown));
  assert.ok(isQuantity(zero));
  assert.ok(isQuantity(na));

  assert.equal(unknown.kind, "unknown");
  assert.equal(zero.kind, "known");
  assert.equal(zero.value, 0);
  assert.equal(na.kind, "not-applicable");
  assert.equal(na.reason, "no PRs ran in this window");
});

test("pairing: unknown vs zero are never conflated", () => {
  const unknown = unknownQuantity();
  const zero = knownQuantity(0);
  assert.notDeepEqual(unknown, zero);
  assert.notEqual(unknown.kind, zero.kind);
  // The zero side actually carries the number; the unknown side never does.
  assert.equal("value" in unknown, false);
  assert.equal(zero.value, 0);
});

test("pairing: zero vs not-applicable are never conflated", () => {
  const zero = knownQuantity(0);
  const na = notApplicableQuantity("no repair history for a new capability");
  assert.notDeepEqual(zero, na);
  assert.notEqual(zero.kind, na.kind);
  assert.equal("reason" in zero, false);
  assert.equal("value" in na, false);
});

test("pairing: unknown vs not-applicable are never conflated", () => {
  const unknown = unknownQuantity();
  const na = notApplicableQuantity("no repair history for a new capability");
  assert.notDeepEqual(unknown, na);
  assert.notEqual(unknown.kind, na.kind);
});

test("notApplicableQuantity refuses an empty or missing reason", () => {
  assert.throws(() => notApplicableQuantity(""));
  assert.throws(() => notApplicableQuantity("   "));
  assert.throws(() => notApplicableQuantity(undefined));
});

test("knownQuantity refuses a non-number, negative, or non-finite value — no coercion of 'unknown' into a number", () => {
  assert.throws(() => knownQuantity("3"));
  assert.throws(() => knownQuantity(-1));
  assert.throws(() => knownQuantity(NaN));
  assert.throws(() => knownQuantity(Infinity));
  assert.throws(() => knownQuantity(undefined));
});

// ---------------------------------------------------------------------------
// metricStatus never conflates the three states at the metric level either.
// ---------------------------------------------------------------------------

test("metricStatus: known/known is ready; unknown/unknown is measurement-required; not-applicable/not-applicable is not-applicable", () => {
  assert.equal(metricStatus(readyMetric("flow-coverage")), "ready");
  assert.equal(metricStatus(unknownMetric("flow-coverage")), "measurement-required");
  assert.equal(metricStatus(notApplicableMetric("repair-decisions")), "not-applicable");
});

test("metricStatus: a measured zero numerator with a known denominator is ready, not measurement-required", () => {
  const metric = makeMetric({
    id: "escaped-regressions",
    label: "escapes",
    query: "count escapes",
    interval: "trailing-90-days",
    source: "issue-tracker",
    provenance: "observed",
    numerator: knownQuantity(0),
    denominator: knownQuantity(50),
    collectedAt: NOW.toISOString(),
  });
  assert.equal(metricStatus(metric), "ready");
});

test("metricStatus: a missing denominator never masquerades as a good (zero) result", () => {
  const metric = makeMetric({
    id: "escaped-regressions",
    label: "escapes",
    query: "count escapes",
    interval: "trailing-90-days",
    source: "issue-tracker",
    provenance: "observed",
    numerator: knownQuantity(0), // we counted 0 escapes so far...
    denominator: unknownQuantity(), // ...but we don't know how many PRs that's out of.
    collectedAt: null,
  });
  assert.equal(metricStatus(metric), "measurement-required");
});

// ---------------------------------------------------------------------------
// A metric missing any required field is rejected.
// ---------------------------------------------------------------------------

test("validateBaselinePlan rejects a metric missing any required field", () => {
  const requiredFields = ["id", "label", "query", "interval", "source", "numerator", "denominator", "provenance", "collectedAt"];
  for (const field of requiredFields) {
    const metrics = allReadyMetrics();
    const broken = { ...metrics[0] };
    delete broken[field];
    metrics[0] = broken;
    const plan = { ...basePlanInput({ metrics }), readiness: "measurement-required" };
    const { valid, errors } = validateBaselinePlan(plan, { now: NOW });
    assert.equal(valid, false, `expected invalid when ${field} is missing`);
    assert.ok(
      errors.some((e) => e.message.includes(field)),
      `expected an error mentioning ${field}, got: ${JSON.stringify(errors)}`,
    );
  }
});

test("validateBaselinePlan rejects an unknown key on a metric or on the plan itself", () => {
  const metrics = allReadyMetrics();
  metrics[0] = { ...metrics[0], bogus: true };
  const plan = { ...basePlanInput({ metrics }), readiness: computeReadiness(basePlanInput({ metrics }), { now: NOW }), extraRoot: 1 };
  const { valid, errors } = validateBaselinePlan(plan, { now: NOW });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.message.includes("bogus")));
  assert.ok(errors.some((e) => e.message.includes("extraRoot")));
});

test("validateBaselinePlan rejects a plan missing a required metric id, and rejects an unknown extra metric id", () => {
  const metrics = allReadyMetrics().filter((m) => m.id !== "flake-rate");
  const plan = { ...basePlanInput({ metrics }), readiness: "measurement-required" };
  const { valid, errors } = validateBaselinePlan(plan, { now: NOW });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.message.includes("flake-rate")));

  const withExtra = { ...basePlanInput({ metrics: [...allReadyMetrics(), readyMetric("bogus-metric")] }), readiness: "measurement-required" };
  const result2 = validateBaselinePlan(withExtra, { now: NOW });
  assert.equal(result2.valid, false);
  assert.ok(result2.errors.some((e) => e.message.includes("bogus-metric")));
});

test("an asymmetric not-applicable (only one of numerator/denominator) is rejected", () => {
  const metrics = allReadyMetrics();
  const repairIndex = metrics.findIndex((m) => m.id === "repair-decisions");
  metrics[repairIndex] = {
    ...metrics[repairIndex],
    numerator: notApplicableQuantity("no history"),
    denominator: knownQuantity(0),
  };
  const plan = { ...basePlanInput({ metrics }), readiness: "measurement-required" };
  const { valid, errors } = validateBaselinePlan(plan, { now: NOW });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.message.includes("half not-applicable")));
});

// ---------------------------------------------------------------------------
// Missing evidence yields measurement-required and cannot yield ready.
// ---------------------------------------------------------------------------

test("missing evidence on even one required metric yields measurement-required for the whole plan, never ready", () => {
  const metrics = allReadyMetrics();
  metrics[0] = unknownMetric(metrics[0].id);
  const draft = basePlanInput({ metrics });
  assert.equal(computeReadiness(draft, { now: NOW }), "measurement-required");

  const plan = buildBaselinePlan(draft, { now: NOW });
  assert.equal(plan.readiness, "measurement-required");
});

test("a brand-new plan with every metric unknown is measurement-required, not an error and not ready", () => {
  const metrics = REQUIRED_METRIC_IDS.map((id) => unknownMetric(id));
  const plan = buildBaselinePlan(basePlanInput({ metrics, window: { startedAt: NOW.toISOString() } }), { now: NOW });
  assert.equal(plan.readiness, "measurement-required");
  const { valid } = validateBaselinePlan(plan, { now: NOW });
  assert.equal(valid, true);
});

test("all metrics evidenced but the burn-in window has not elapsed yet is still measurement-required", () => {
  const plan = buildBaselinePlan(basePlanInput({ window: { startedAt: STARTED_RECENTLY } }), { now: NOW });
  assert.equal(plan.readiness, "measurement-required");
});

test("all metrics evidenced, burn-in elapsed, but too few relevant PR runs is still measurement-required", () => {
  const metrics = allReadyMetrics({ runCount: MIN_RELEVANT_PR_RUNS - 1 });
  const plan = buildBaselinePlan(basePlanInput({ metrics }), { now: NOW });
  assert.equal(plan.readiness, "measurement-required");
});

test("all metrics evidenced (including a legitimate not-applicable repair baseline), burn-in elapsed, enough runs: ready", () => {
  const plan = buildBaselinePlan(basePlanInput(), { now: NOW });
  assert.equal(plan.readiness, "ready");
  const { valid } = validateBaselinePlan(plan, { now: NOW });
  assert.equal(valid, true);
});

// ---------------------------------------------------------------------------
// No code path fabricates, estimates, or defaults a metric value / a ready
// state.
// ---------------------------------------------------------------------------

test("buildBaselinePlan has no readiness parameter — passing one is simply ignored, the value is always recomputed", () => {
  const input = basePlanInput({ metrics: REQUIRED_METRIC_IDS.map((id) => unknownMetric(id)) });
  const plan = buildBaselinePlan({ ...input, readiness: "ready" }, { now: NOW });
  assert.equal(plan.readiness, "measurement-required", "a caller-supplied readiness must never be trusted");
});

test("validateBaselinePlan rejects a hand-edited document that claims ready while its own metrics do not support it", () => {
  const plan = { ...basePlanInput({ metrics: REQUIRED_METRIC_IDS.map((id) => unknownMetric(id)) }), readiness: "ready" };
  const { valid, errors } = validateBaselinePlan(plan, { now: NOW });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.message.includes("readiness")));
});

test("there is no function in this module that turns an unknown or not-applicable Quantity into a number", () => {
  // Structural proof: unknownQuantity/notApplicableQuantity never carry a
  // `value` field at all, so nothing downstream (metricStatus, computeReadiness,
  // describeMetric) can read a number off of them by accident.
  assert.equal("value" in unknownQuantity(), false);
  assert.equal("value" in notApplicableQuantity("x"), false);
});

// ---------------------------------------------------------------------------
// Round trip through the restricted-YAML renderer/parser.
// ---------------------------------------------------------------------------

test("render -> parse round trip reproduces an identical document (identical canonical digest)", () => {
  const plan = buildBaselinePlan(basePlanInput(), { now: NOW });
  const rendered = renderBaselinePlanYAML(plan);
  const parsed = parseBaselinePlanDocument(rendered);
  assert.equal(contentDigest(plan), contentDigest(parsed));
  const { valid } = validateBaselinePlan(parsed, { now: NOW });
  assert.equal(valid, true);
});

test("a not-applicable metric's reason and a measured 0 both survive the round trip distinctly", () => {
  const plan = buildBaselinePlan(basePlanInput(), { now: NOW });
  const parsed = parseBaselinePlanDocument(renderBaselinePlanYAML(plan));
  const repair = parsed.metrics.find((m) => m.id === "repair-decisions");
  assert.equal(repair.numerator.kind, "not-applicable");
  assert.equal(typeof repair.numerator.reason, "string");
  const coverage = parsed.metrics.find((m) => m.id === "flow-coverage");
  assert.equal(coverage.numerator.kind, "known");
});

// ---------------------------------------------------------------------------
// Resume from a repository artifact reproduces state exactly, with no
// session input beyond the repository root itself.
// ---------------------------------------------------------------------------

test("resumeBaselinePlan on a repo with no plan yet reports measurement-required without error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "baseline-plan-resume-"));
  try {
    const result = resumeBaselinePlan(dir, { now: NOW });
    assert.equal(result.exists, false);
    assert.equal(result.plan, null);
    assert.equal(result.readiness, "measurement-required");
    assert.equal(result.valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume reproduces the exact same plan and readiness as the one written, purely from repoRoot", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "baseline-plan-resume-"));
  try {
    const original = buildBaselinePlan(basePlanInput(), { now: NOW });
    const writtenPath = saveBaselinePlanToRepo(dir, original);
    assert.equal(writtenPath, path.join(dir, BASELINE_PLAN_REPO_PATH));

    // Two independent "resume" calls — as if invoked from two separate
    // process runs days apart — given only the repository root.
    const first = resumeBaselinePlan(dir, { now: NOW });
    const second = resumeBaselinePlan(dir, { now: NOW });

    assert.equal(first.exists, true);
    assert.equal(first.valid, true);
    assert.equal(first.readiness, "ready");
    assert.deepEqual(first.plan, second.plan);
    assert.equal(first.readiness, second.readiness);
    assert.equal(contentDigest(first.plan), contentDigest(original));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume recomputes readiness from the file's own evidence rather than trusting a stored value, even across a simulated multi-day gap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "baseline-plan-resume-"));
  try {
    // Day 1: not enough burn-in yet.
    const day1 = new Date("2026-01-01T00:00:00Z");
    const partial = buildBaselinePlan(
      basePlanInput({ window: { startedAt: day1.toISOString() }, generatedAt: day1.toISOString() }),
      { now: day1 },
    );
    saveBaselinePlanToRepo(dir, partial);
    const resumedDay1 = resumeBaselinePlan(dir, { now: day1 });
    assert.equal(resumedDay1.readiness, "measurement-required");

    // Day 20: resuming against the SAME file, only the clock moved — no
    // session state carried the earlier result forward, the readiness
    // flip comes entirely from recomputing against the unchanged file plus
    // the new `now`.
    const day20 = new Date(day1.getTime() + 20 * 24 * 60 * 60 * 1000);
    const resumedDay20 = resumeBaselinePlan(dir, { now: day20 });
    assert.equal(resumedDay20.readiness, "ready");
    assert.deepEqual(resumedDay20.plan, resumedDay1.plan, "the repo artifact itself never silently changed between resumes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveBaselinePlanToRepo refuses to write a plan that fails its own validation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "baseline-plan-resume-"));
  try {
    const invalid = { ...basePlanInput(), schema: "wrong-schema", readiness: "measurement-required" };
    assert.throws(() => saveBaselinePlanToRepo(dir, invalid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SUPPORTED_SCHEMA and REQUIRED_METRIC_IDS are the expected fixed contract", () => {
  assert.equal(SUPPORTED_SCHEMA, "dynamic-qa-baseline-plan-v1");
  assert.deepEqual(
    [...REQUIRED_METRIC_IDS].sort(),
    ["escaped-regressions", "flake-rate", "flow-coverage", "maintenance-time", "pr-check-latency-p95", "repair-decisions"].sort(),
  );
});
