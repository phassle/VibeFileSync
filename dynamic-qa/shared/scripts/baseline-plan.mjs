// dynamic-qa/shared/scripts/baseline-plan.mjs
//
// The Baseline Plan v1 contract (qa/baseline-plan.yaml,
// dynamic-qa-baseline-plan-v1.schema.json, DESIGN-dynamic-qa-spec.md §5.4,
// SPEC-135.md user stories 42-44 and 103). Ticket #167, stage 8 of
// qa-setup ("Establish measurement readiness"): pilot activation is blocked
// until coverage, escapes, latency, flake, maintenance, and repair
// baselines exist, so improvement can be measured rather than asserted.
//
// The one rule this whole module exists to enforce: MISSING EVIDENCE NEVER
// BECOMES A NUMBER. There is no function anywhere in this file, reachable
// from any code path, that turns "we don't know yet" into 0, into a
// default, or into an estimate. The only way a Metric's numerator or
// denominator carries an actual number is `knownQuantity(value)`, called by
// something that measured that value. Everything else is `unknownQuantity()`
// (evidence not yet collected) or `notApplicableQuantity(reason)` (the
// metric does not apply here, with a mandatory stated reason) — three
// distinct tagged states, never collapsed into one another, so a missing
// denominator can never masquerade as a good result (SPEC-135 story 43).
//
// `buildBaselinePlan` is the only constructor and it does not accept a
// caller-supplied `readiness` at all: readiness is always recomputed from
// the metrics actually present (`computeReadiness`), and
// `validateBaselinePlan` re-derives it again and fails closed if a
// hand-edited document's stored `readiness` disagrees with what its own
// evidence supports. There is no override, force, or "trust me" field.
//
// Following flow-definition.mjs / execution-profile.mjs's established
// pattern: an Issues collector that reports every problem rather than
// stopping at the first, unknown keys and unsupported schema versions fail
// closed, and a hostile/malformed restricted-YAML parse is the one path
// that throws rather than reporting.
//
// Resume (SPEC-135 story 44: "resumable from repo-owned baseline evidence
// ... measurement can span days without hidden session state"):
// `resumeBaselinePlan(repoRoot)` takes exactly one argument — the
// repository root — and reads `qa/baseline-plan.yaml` from disk. It holds
// no cache, no module-level state, and accepts no session identifier: two
// processes started days apart, given the same repository, reproduce the
// same result, because the ONLY input is the repository's own file.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";
import { isValidSemanticId } from "./id-rules.mjs";
import { isValidProvenance } from "./fact.mjs";

export const SUPPORTED_SCHEMA = "dynamic-qa-baseline-plan-v1";

// Where a customer repository's Baseline Plan lives (DESIGN-dynamic-qa-spec.md
// §5.4). Resume reads exactly this path and nothing else.
export const BASELINE_PLAN_REPO_PATH = "qa/baseline-plan.yaml";

// The six required baselines (DESIGN-dynamic-qa-spec.md §5.4, SPEC-135.md
// story 103): named-flow coverage, escaped regressions, comparable PR-check
// p95 duration, false-positive/flaky failure rate, active human maintenance
// time, and repair decisions accepted unchanged/edited/rejected. All six
// are always present in a valid plan — a metric that does not yet apply
// (e.g. repair decisions for a brand-new capability) is still present, just
// carrying a `not-applicable` Quantity with a reason, never simply absent.
export const REQUIRED_METRIC_IDS = Object.freeze([
  "flow-coverage",
  "escaped-regressions",
  "pr-check-latency-p95",
  "flake-rate",
  "maintenance-time",
  "repair-decisions",
]);

// Burn-in qualification numbers from SPEC-135.md's Implementation
// Decisions: "at least 14 calendar days and 20 relevant completed PR runs,
// a 90-day escape review". These are spec-given constants, not evidence —
// exactly the kind of thing decision 5 in the run brief calls "real
// executable code" rather than prose a model re-derives each time.
export const MIN_BURN_IN_CALENDAR_DAYS = 14;
export const MIN_RELEVANT_PR_RUNS = 20;
export const ESCAPE_REVIEW_WINDOW_DAYS = 90;

// ASSUMPTION (documented for #169/#171): the "20 relevant completed PR
// runs" gate reads its run-count from the pr-check-latency-p95 metric's
// denominator, treated as the sample size the p95 was computed over. This
// ticket builds the machinery only; it never collects a real count. A
// later ticket that finds a better source for "relevant completed PR runs"
// should update RUN_COUNT_METRIC_ID deliberately, in one place.
export const RUN_COUNT_METRIC_ID = "pr-check-latency-p95";

export const READINESS = Object.freeze(["measurement-required", "ready"]);
export const METRIC_STATUS = Object.freeze(["measurement-required", "not-applicable", "ready"]);

// ---------------------------------------------------------------------------
// Quantity — the three-state value type a numerator or denominator must be.
// ---------------------------------------------------------------------------

/** Evidence not yet collected. The ONLY state that ever yields "unknown". */
export function unknownQuantity() {
  return Object.freeze({ kind: "unknown" });
}

/**
 * The metric does not apply here (e.g. a repair-decisions baseline for a
 * capability that has not shipped yet). Requires a mandatory, non-empty
 * reason — "not-applicable" with no stated reason is refused, because an
 * unreasoned not-applicable is indistinguishable from someone dodging an
 * inconvenient unknown.
 */
export function notApplicableQuantity(reason) {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error("notApplicableQuantity requires a non-empty reason");
  }
  return Object.freeze({ kind: "not-applicable", reason });
}

/**
 * A real, measured number. Zero is a perfectly ordinary known value here —
 * it is distinguished from "unknown" and "not-applicable" by TAG, not by
 * value, so a measured zero can never be produced by, or confused with,
 * either of the other two states.
 */
export function knownQuantity(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`knownQuantity requires a finite number >= 0 (got ${JSON.stringify(value)})`);
  }
  return Object.freeze({ kind: "known", value });
}

export function isQuantity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.kind === "unknown") return Object.keys(value).length === 1;
  if (value.kind === "not-applicable") {
    return Object.keys(value).length === 2 && typeof value.reason === "string" && value.reason.trim() !== "";
  }
  if (value.kind === "known") {
    return (
      Object.keys(value).length === 2 &&
      typeof value.value === "number" &&
      Number.isFinite(value.value) &&
      value.value >= 0
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Issue collection (matches flow-definition.mjs / execution-profile.mjs).
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isValidIsoTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function pathStr(p) {
  if (!p || p.length === 0) return "$";
  let out = "$";
  for (const segment of p) out += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  return out;
}

class Issues {
  constructor() {
    this.list = [];
  }
  add(p, message) {
    this.list.push({ path: p, message: `${message} (at ${pathStr(p)})` });
  }
}

function assertKnownKeys(obj, allowed, p, issues) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) issues.add([...p, key], `unknown key ${JSON.stringify(key)}`);
  }
}

// ---------------------------------------------------------------------------
// Metric
// ---------------------------------------------------------------------------

const METRIC_KEYS = new Set([
  "id",
  "label",
  "query",
  "interval",
  "source",
  "numerator",
  "denominator",
  "provenance",
  "collectedAt",
  "notes",
]);

// Every one of these is required on every metric, always — this is the
// ticket's "a metric missing any of these is not a metric" rule. Note that
// numerator/denominator being *present* is required even when their kind is
// "unknown"; what may legitimately be absent-in-spirit is a NUMBER, not the
// field itself.
const METRIC_REQUIRED_KEYS = [
  "id",
  "label",
  "query",
  "interval",
  "source",
  "numerator",
  "denominator",
  "provenance",
  "collectedAt",
];

function validateQuantity(q, p, issues) {
  if (!isPlainObject(q)) {
    issues.add(p, "must be a mapping with a kind of unknown | not-applicable | known");
    return;
  }
  if (q.kind === "unknown") {
    assertKnownKeys(q, new Set(["kind"]), p, issues);
    return;
  }
  if (q.kind === "not-applicable") {
    assertKnownKeys(q, new Set(["kind", "reason"]), p, issues);
    if (!nonEmptyString(q.reason)) {
      issues.add([...p, "reason"], "not-applicable requires a non-empty reason — an unreasoned not-applicable is not distinguishable from a dodged unknown");
    }
    return;
  }
  if (q.kind === "known") {
    assertKnownKeys(q, new Set(["kind", "value"]), p, issues);
    if (typeof q.value !== "number" || !Number.isFinite(q.value) || q.value < 0) {
      issues.add([...p, "value"], "known value must be a finite number >= 0");
    }
    return;
  }
  issues.add([...p, "kind"], `kind must be one of unknown | not-applicable | known (got ${JSON.stringify(q.kind)})`);
}

/**
 * The per-metric status this one metric's own evidence supports:
 *   - "ready"               numerator AND denominator both kind "known".
 *   - "not-applicable"      numerator AND denominator both kind "not-applicable".
 *   - "measurement-required" everything else — including any "unknown" on
 *                            either side, and an asymmetric known/not-applicable
 *                            mix (which validateMetric also flags as invalid
 *                            shape). This function never returns "ready" or
 *                            "not-applicable" from an incomplete or mismatched
 *                            pair; the safe default is always
 *                            "measurement-required".
 * Assumes the metric has already passed shape validation.
 */
export function metricStatus(metric) {
  const n = metric?.numerator?.kind;
  const d = metric?.denominator?.kind;
  if (n === "known" && d === "known") return "ready";
  if (n === "not-applicable" && d === "not-applicable") return "not-applicable";
  return "measurement-required";
}

function validateMetric(metric, p, issues) {
  if (!isPlainObject(metric)) {
    issues.add(p, "each metric must be a mapping");
    return;
  }
  assertKnownKeys(metric, METRIC_KEYS, p, issues);
  for (const key of METRIC_REQUIRED_KEYS) {
    if (!(key in metric)) {
      issues.add(
        [...p, key],
        `${key} is required — a metric missing any of numerator, denominator, query, interval, source, provenance, or collectedAt is not a metric`,
      );
    }
  }

  if (metric.id !== undefined && !REQUIRED_METRIC_IDS.includes(metric.id)) {
    issues.add([...p, "id"], `id must be one of ${REQUIRED_METRIC_IDS.join(" | ")} (got ${JSON.stringify(metric.id)})`);
  }
  if ("label" in metric && !nonEmptyString(metric.label)) issues.add([...p, "label"], "label must be a non-empty string");
  if ("query" in metric && !nonEmptyString(metric.query)) {
    issues.add([...p, "query"], "query must name the exact collection query/method — this is the explicit collection method the ticket requires even before any evidence exists");
  }
  if ("interval" in metric && !nonEmptyString(metric.interval)) {
    issues.add([...p, "interval"], "interval must name the collection interval (e.g. trailing-30-days)");
  }
  if ("source" in metric && !nonEmptyString(metric.source)) {
    issues.add([...p, "source"], "source must name the system queried for this metric");
  }
  if ("provenance" in metric && !isValidProvenance(metric.provenance)) {
    issues.add([...p, "provenance"], "provenance must be observed, reported, or unknown");
  }
  if ("numerator" in metric) validateQuantity(metric.numerator, [...p, "numerator"], issues);
  if ("denominator" in metric) validateQuantity(metric.denominator, [...p, "denominator"], issues);

  const nKind = metric?.numerator?.kind;
  const dKind = metric?.denominator?.kind;
  if ("numerator" in metric && "denominator" in metric && (nKind === "not-applicable") !== (dKind === "not-applicable")) {
    issues.add(p, "numerator and denominator must be not-applicable together, never only one side — a metric cannot be half not-applicable");
  }

  if ("collectedAt" in metric) {
    const hasKnown = nKind === "known" || dKind === "known";
    if (hasKnown) {
      if (!isValidIsoTimestamp(metric.collectedAt)) {
        issues.add([...p, "collectedAt"], "collectedAt must be a valid ISO 8601 timestamp whenever a numerator or denominator carries a known value");
      }
    } else if (metric.collectedAt !== null) {
      issues.add([...p, "collectedAt"], "collectedAt must be null when nothing has been measured yet — a timestamp here would misleadingly claim a real collection happened");
    }
  }

  if ("notes" in metric && metric.notes !== undefined && typeof metric.notes !== "string") {
    issues.add([...p, "notes"], "notes must be a string when present");
  }
}

function validateMetricsArray(metrics, p, issues) {
  if (!Array.isArray(metrics)) {
    issues.add(p, "metrics must be a list");
    return;
  }
  const seen = new Set();
  metrics.forEach((m, i) => {
    validateMetric(m, [...p, i], issues);
    if (isPlainObject(m) && typeof m.id === "string") {
      if (seen.has(m.id)) issues.add([...p, i, "id"], `duplicate metric id ${JSON.stringify(m.id)}`);
      seen.add(m.id);
    }
  });
  for (const requiredId of REQUIRED_METRIC_IDS) {
    if (!seen.has(requiredId)) {
      issues.add(p, `missing required metric ${JSON.stringify(requiredId)} — all six baselines (coverage, escapes, latency, flake, maintenance, repair) are always present, even when a given baseline's status is not-applicable`);
    }
  }
  const extra = [...seen].filter((id) => !REQUIRED_METRIC_IDS.includes(id));
  if (extra.length) issues.add(p, `unknown metric id(s): ${extra.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Owners / window
// ---------------------------------------------------------------------------

function validateOwners(owners, p, issues) {
  if (!isPlainObject(owners)) {
    issues.add(p, "owners must be a mapping");
    return;
  }
  assertKnownKeys(owners, new Set(["qaOwner", "technicalOwner"]), p, issues);
  if (!nonEmptyString(owners.qaOwner)) issues.add([...p, "qaOwner"], "qaOwner must be a non-empty string");
  if (!nonEmptyString(owners.technicalOwner)) issues.add([...p, "technicalOwner"], "technicalOwner must be a non-empty string");
}

function validateWindow(window, p, issues) {
  if (!isPlainObject(window)) {
    issues.add(p, "window must be a mapping");
    return;
  }
  assertKnownKeys(window, new Set(["startedAt", "note"]), p, issues);
  if (!isValidIsoTimestamp(window.startedAt)) {
    issues.add([...p, "startedAt"], "startedAt must be a valid ISO 8601 timestamp naming when baseline collection began");
  }
  if ("note" in window && window.note !== undefined && typeof window.note !== "string") {
    issues.add([...p, "note"], "note must be a string when present");
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Computes the Baseline Plan's overall readiness PURELY from what its
 * metrics and window actually evidence. This is the single choke point:
 * nothing else in this module, or reachable from outside it, is allowed to
 * assign "ready" by any other means.
 *
 *   - Any required metric at "measurement-required" (per metricStatus)
 *     forces the whole plan to "measurement-required" — one missing
 *     baseline blocks the pilot, exactly as SPEC-135 story 42/103 require.
 *   - Otherwise every metric is either "ready" or legitimately
 *     "not-applicable" (with a reason). The plan still is not "ready" until
 *     the burn-in gate also clears: at least MIN_BURN_IN_CALENDAR_DAYS
 *     have elapsed since window.startedAt, and the designated run-count
 *     metric's denominator is at least MIN_RELEVANT_PR_RUNS.
 *   - A malformed window.startedAt (or a metrics array that doesn't shape-
 *     check) is treated as "measurement-required", never as "ready" by
 *     omission — call validateBaselinePlan first if you need to know
 *     *why* it isn't ready.
 */
export function computeReadiness(plan, { now } = {}) {
  if (!isPlainObject(plan) || !Array.isArray(plan.metrics)) return "measurement-required";

  for (const metric of plan.metrics) {
    if (!isPlainObject(metric)) return "measurement-required";
    if (metricStatus(metric) === "measurement-required") return "measurement-required";
  }

  const started = isPlainObject(plan.window) ? Date.parse(plan.window.startedAt) : NaN;
  if (Number.isNaN(started)) return "measurement-required";

  const nowMs = now instanceof Date ? now.getTime() : now !== undefined ? new Date(now).getTime() : Date.now();
  const elapsedDays = (nowMs - started) / (24 * 60 * 60 * 1000);
  if (elapsedDays < MIN_BURN_IN_CALENDAR_DAYS) return "measurement-required";

  const runCountMetric = plan.metrics.find((m) => isPlainObject(m) && m.id === RUN_COUNT_METRIC_ID);
  const runCountQuantity = runCountMetric?.denominator;
  if (!isQuantity(runCountQuantity) || runCountQuantity.kind !== "known" || runCountQuantity.value < MIN_RELEVANT_PR_RUNS) {
    return "measurement-required";
  }

  return "ready";
}

// ---------------------------------------------------------------------------
// Top-level validation
// ---------------------------------------------------------------------------

const ROOT_KEYS = new Set(["schema", "id", "revision", "owners", "repository", "window", "metrics", "readiness", "generatedAt"]);

/**
 * Validates an already-parsed Baseline Plan JS value against the v1
 * contract, including the anti-fabrication check: a stored `readiness`
 * that disagrees with what `computeReadiness` derives from the SAME
 * document's own metrics/window is reported as an issue, never silently
 * accepted. Never throws for an ordinary shape/policy violation.
 *
 * The consistency check is anchored to `now ?? data.generatedAt`, NOT the
 * real wall clock, deliberately: it asks "was this readiness value
 * something the evidence in this document could actually support at the
 * moment it was generated", not "does it still hold this instant". The
 * burn-in gate is calendar-time-based by design (SPEC-135's Implementation
 * Decisions), so a document that was honestly "measurement-required" on
 * the day it was written must stay VALID as real time passes and the
 * burn-in window quietly elapses — going stale is not fabrication. Callers
 * that want the CURRENT readiness (which legitimately differs from the
 * stored value once enough calendar time has passed) call
 * `computeReadiness`/`resumeBaselinePlan` with the real clock instead.
 */
export function validateBaselinePlan(data, { expectedId, now } = {}) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Baseline Plan document must be a mapping");
    return { valid: false, errors: issues.list };
  }

  assertKnownKeys(data, ROOT_KEYS, [], issues);

  if (data.schema !== SUPPORTED_SCHEMA) {
    issues.add(["schema"], `unsupported schema version ${JSON.stringify(data.schema)} — this validator only accepts ${JSON.stringify(SUPPORTED_SCHEMA)}`);
  }

  if (!isValidSemanticId(data.id)) {
    issues.add(["id"], "id must be an immutable semantic identifier");
  } else if (expectedId !== undefined && data.id !== expectedId) {
    issues.add(["id"], `id ${JSON.stringify(data.id)} does not match its filename ${JSON.stringify(expectedId)}`);
  }

  if (!(Number.isInteger(data.revision) && data.revision >= 1)) {
    issues.add(["revision"], "revision must be a monotonically increasing integer starting at 1");
  }

  validateOwners(data.owners, ["owners"], issues);

  if (!nonEmptyString(data.repository)) {
    issues.add(["repository"], "repository must name the repository identity this plan measures");
  }

  validateWindow(data.window, ["window"], issues);
  validateMetricsArray(data.metrics, ["metrics"], issues);

  if (!isValidIsoTimestamp(data.generatedAt)) {
    issues.add(["generatedAt"], "generatedAt must be a valid ISO 8601 timestamp");
  }

  if (!READINESS.includes(data.readiness)) {
    issues.add(["readiness"], `readiness must be one of ${READINESS.join(" | ")} (got ${JSON.stringify(data.readiness)})`);
  } else if (issues.list.length === 0) {
    // Only recompute against evidence once everything else the computation
    // reads (window, metrics) is itself known-good — otherwise a shape
    // error would be reported twice, once as itself and once as a
    // misleading "readiness mismatch".
    const recomputed = computeReadiness(data, { now: now ?? data.generatedAt });
    if (recomputed !== data.readiness) {
      issues.add(
        ["readiness"],
        `stored readiness ${JSON.stringify(data.readiness)} does not match what this plan's own metrics and window evidence (recomputed: ${JSON.stringify(recomputed)}) — readiness is never hand-set ahead of its evidence`,
      );
    }
  }

  return { valid: issues.list.length === 0, errors: issues.list };
}

// ---------------------------------------------------------------------------
// Construction — the only way to build a plan; always recomputes readiness.
// ---------------------------------------------------------------------------

/**
 * The only constructor. Deliberately has NO `readiness` parameter: readiness
 * is always derived by `computeReadiness` from the metrics/window given, so
 * there is no path through this function that lets a caller assert
 * "ready" ahead of the evidence.
 *
 * Throws if the assembled plan does not itself pass validateBaselinePlan —
 * fails closed rather than handing back something malformed.
 */
export function buildBaselinePlan({ id, revision, owners, repository, window, metrics, generatedAt }, { now } = {}) {
  const draft = {
    schema: SUPPORTED_SCHEMA,
    id,
    revision,
    owners,
    repository,
    window,
    metrics,
    generatedAt,
    readiness: "measurement-required", // placeholder; recomputed unconditionally below
  };
  draft.readiness = computeReadiness(draft, { now });

  const { valid, errors } = validateBaselinePlan(draft, { now });
  if (!valid) {
    throw new Error(`buildBaselinePlan produced an invalid Baseline Plan: ${errors.map((e) => e.message).join("; ")}`);
  }
  return draft;
}

/** Small convenience constructor for one metric entry (not a validator). */
export function makeMetric({ id, label, query, interval, source, provenance, numerator, denominator, collectedAt = null, notes }) {
  const metric = { id, label, query, interval, source, numerator, denominator, provenance, collectedAt };
  if (notes !== undefined) metric.notes = notes;
  return metric;
}

// ---------------------------------------------------------------------------
// Rendering (restricted-YAML subset only — round-trips through
// parseRestrictedYAML + validateBaselinePlan, same discipline as
// flow-yaml.mjs).
// ---------------------------------------------------------------------------

function renderQuotedString(value) {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function renderScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return renderQuotedString(value);
  throw new Error(`baseline-plan: cannot render a scalar of type ${typeof value}`);
}

function pad(n) {
  return " ".repeat(n);
}

function renderQuantity(q, indent) {
  const lines = [`${pad(indent)}kind: ${renderScalar(q.kind)}`];
  if (q.kind === "not-applicable") lines.push(`${pad(indent)}reason: ${renderScalar(q.reason)}`);
  if (q.kind === "known") lines.push(`${pad(indent)}value: ${renderScalar(q.value)}`);
  return lines;
}

function renderMetric(m, indent) {
  const lines = [];
  lines.push(`${pad(indent)}- id: ${renderScalar(m.id)}`);
  lines.push(`${pad(indent + 2)}label: ${renderScalar(m.label)}`);
  lines.push(`${pad(indent + 2)}query: ${renderScalar(m.query)}`);
  lines.push(`${pad(indent + 2)}interval: ${renderScalar(m.interval)}`);
  lines.push(`${pad(indent + 2)}source: ${renderScalar(m.source)}`);
  lines.push(`${pad(indent + 2)}provenance: ${renderScalar(m.provenance)}`);
  lines.push(`${pad(indent + 2)}numerator:`);
  lines.push(...renderQuantity(m.numerator, indent + 4));
  lines.push(`${pad(indent + 2)}denominator:`);
  lines.push(...renderQuantity(m.denominator, indent + 4));
  lines.push(`${pad(indent + 2)}collectedAt: ${renderScalar(m.collectedAt)}`);
  if (m.notes !== undefined) lines.push(`${pad(indent + 2)}notes: ${renderScalar(m.notes)}`);
  return lines;
}

/**
 * Renders a Baseline Plan JS value into the restricted YAML subset
 * restricted-yaml.mjs accepts. Not a general-purpose YAML writer — mirrors
 * flow-yaml.mjs's approach exactly, for the same reason: round-tripping
 * through parseRestrictedYAML + validateBaselinePlan is guaranteed to
 * succeed and to reproduce an identical document.
 */
export function renderBaselinePlanYAML(plan) {
  const lines = [];
  lines.push(`schema: ${renderScalar(plan.schema)}`);
  lines.push(`id: ${renderScalar(plan.id)}`);
  lines.push(`revision: ${renderScalar(plan.revision)}`);
  lines.push(`owners:`);
  lines.push(`  qaOwner: ${renderScalar(plan.owners.qaOwner)}`);
  lines.push(`  technicalOwner: ${renderScalar(plan.owners.technicalOwner)}`);
  lines.push(`repository: ${renderScalar(plan.repository)}`);
  lines.push(`window:`);
  lines.push(`  startedAt: ${renderScalar(plan.window.startedAt)}`);
  if (plan.window.note !== undefined) lines.push(`  note: ${renderScalar(plan.window.note)}`);
  if (plan.metrics.length === 0) {
    lines.push(`metrics: []`);
  } else {
    lines.push(`metrics:`);
    for (const m of plan.metrics) lines.push(...renderMetric(m, 2));
  }
  lines.push(`readiness: ${renderScalar(plan.readiness)}`);
  lines.push(`generatedAt: ${renderScalar(plan.generatedAt)}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Resume — repository-owned baseline evidence, no hidden session state.
// ---------------------------------------------------------------------------

/**
 * Parses raw Baseline Plan YAML text into a plain JS value using the
 * restricted-YAML subset. Throws YamlSyntaxError on anything outside that
 * subset (aliases, custom tags, duplicate keys, ...) — the same fail-closed
 * behaviour as every other artifact parser in this bundle.
 */
export function parseBaselinePlanDocument(source, { filename } = {}) {
  return parseRestrictedYAML(source, { filename: filename ?? BASELINE_PLAN_REPO_PATH });
}

/**
 * Resumes measurement readiness PURELY from the repository's own
 * `qa/baseline-plan.yaml` — the only argument is `repoRoot`. There is no
 * cache, no module-level state, and no session identifier anywhere in this
 * function: two calls from two entirely separate process invocations,
 * pointed at the same repository, produce byte-identical results, which is
 * exactly what "measurement can span days without hidden session state"
 * (SPEC-135 story 44) requires.
 *
 * `now` is accepted ONLY as a testing/determinism seam for the burn-in
 * clock comparison inside computeReadiness — it defaults to the real
 * clock and is never treated as part of "session state" the way a cached
 * plan object would be.
 *
 * Returns:
 *   - { exists: false, plan: null, readiness: "measurement-required",
 *       valid: true, errors: [] } when no plan has been proposed yet.
 *   - { exists: true, plan, readiness, valid, errors } otherwise, where
 *     `readiness` is always recomputed from the file's own content (never
 *     merely copied from a `readiness:` line in the file), and `errors`
 *     reports whether the stored value in the file agreed.
 */
export function resumeBaselinePlan(repoRoot, { now } = {}) {
  const filePath = path.join(repoRoot, BASELINE_PLAN_REPO_PATH);
  if (!existsSync(filePath)) {
    return { exists: false, plan: null, readiness: "measurement-required", valid: true, errors: [] };
  }
  const source = readFileSync(filePath, "utf8");
  const data = parseBaselinePlanDocument(source);
  // Structural/anti-fabrication validity is anchored to the document's own
  // generatedAt (see validateBaselinePlan) so a plan that was honest when
  // written stays valid as real time passes. The CURRENT readiness is then
  // recomputed separately against the real (or injected) clock — this is
  // exactly how "measurement can span days" without rewriting the file:
  // the stored readiness can legitimately flip from measurement-required
  // to ready between two resumes of the same untouched file.
  const { valid, errors } = validateBaselinePlan(data);
  const readiness = valid ? computeReadiness(data, { now }) : "measurement-required";
  return { exists: true, plan: data, readiness, valid, errors };
}

/**
 * Writes a Baseline Plan to the repository at BASELINE_PLAN_REPO_PATH.
 * Refuses to write anything that does not itself pass validateBaselinePlan
 * — the repository never ends up holding a plan this module would reject
 * on its own next read.
 */
export function saveBaselinePlanToRepo(repoRoot, plan) {
  const { valid, errors } = validateBaselinePlan(plan);
  if (!valid) {
    throw new Error(`refusing to write an invalid Baseline Plan: ${errors.map((e) => e.message).join("; ")}`);
  }
  const filePath = path.join(repoRoot, BASELINE_PLAN_REPO_PATH);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderBaselinePlanYAML(plan), "utf8");
  return filePath;
}

/**
 * A short, human-readable per-metric summary for the setup interview to
 * present verbatim (stage 8 prose reads this rather than re-deriving it).
 * Purely descriptive — computes nothing that computeReadiness/metricStatus
 * didn't already compute.
 */
export function describeMetric(metric) {
  const status = metricStatus(metric);
  if (status === "ready") {
    return `${metric.id}: ${metric.numerator.value}/${metric.denominator.value} (measured ${metric.collectedAt}, source: ${metric.source})`;
  }
  if (status === "not-applicable") {
    return `${metric.id}: not-applicable (${metric.numerator.reason})`;
  }
  return `${metric.id}: measurement-required (query: ${metric.query}, interval: ${metric.interval}, source: ${metric.source})`;
}
