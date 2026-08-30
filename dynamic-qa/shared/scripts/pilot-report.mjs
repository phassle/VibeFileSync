// dynamic-qa/shared/scripts/pilot-report.mjs
//
// The Pilot Report v1 contract (ticket #173, SPEC-135.md §13 "advisory-first
// pilot results reported with exact denominators, queries, intervals, and
// provenance" — story 104, and "Pilot reporting tests require every metric
// to expose its numerator, denominator, query, interval, source, and
// provenance. Unknown and missing metrics cannot pass.").
//
// This is REPORT structure only. No real VibeFileSync pilot data is created
// by this module or anywhere in this ticket set — see run brief decision 3
// and DECISIONS.md's entry for this ticket range.
//
// Deliberately reuses #167's Quantity three-state value type
// (baseline-plan.mjs's unknownQuantity/notApplicableQuantity/knownQuantity)
// rather than inventing a second metric model: a numerator or denominator is
// "unknown" (not yet collected), "not-applicable" (with a mandatory reason),
// or "known" (a real measured number, where zero is an ordinary known value
// distinguished by TAG, never by value). There is no function anywhere in
// this file that turns "not measured" into a number.
//
// Five required metrics (SPEC-135 story 104 / ticket #173 acceptance
// criteria): flow-coverage, escaped-regressions, pr-check-latency-p95,
// flake-false-positive-rate, maintenance-time. Every one is always present
// in a valid report — never simply absent — and every one must reach
// "known" on both numerator and denominator (report-time metrics are never
// legitimately not-applicable; unlike a pre-activation Baseline Plan, by the
// time a report exists all five Bindings are active and every metric is
// expected to have real evidence) before the report's overall status can be
// anything but "pilot-incomplete".

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";
import { isValidSemanticId } from "./id-rules.mjs";
import { isValidProvenance } from "./fact.mjs";
import { isQuantity, metricStatus, unknownQuantity, notApplicableQuantity, knownQuantity } from "./baseline-plan.mjs";

export { unknownQuantity, notApplicableQuantity, knownQuantity, isQuantity, metricStatus };

export const SUPPORTED_SCHEMA = "dynamic-qa-pilot-report-v1";

// Where a customer repository's Pilot Report lives once a real pilot writes
// one. This module never writes here on its own initiative; only an
// explicit caller (never this ticket) does.
export const PILOT_REPORT_REPO_PATH = "qa/pilot-report.yaml";

export const REQUIRED_METRIC_IDS = Object.freeze([
  "flow-coverage",
  "escaped-regressions",
  "pr-check-latency-p95",
  "flake-false-positive-rate",
  "maintenance-time",
]);

// SPEC-135 §13: "Run advisory-first for at least four weeks and 20 relevant
// PRs after all five Bindings are active."
export const MIN_ADVISORY_WEEKS = 4;
export const MIN_RELEVANT_PR_RUNS = 20;

// Same documented assumption as baseline-plan.mjs's RUN_COUNT_METRIC_ID: the
// "20 relevant PRs" count reads from the pr-check-latency-p95 metric's
// denominator, treated as the sample size the p95 was computed over.
export const RUN_COUNT_METRIC_ID = "pr-check-latency-p95";

export const REPORT_STATUS = Object.freeze(["pilot-incomplete", "complete"]);

// ---------------------------------------------------------------------------
// Issue collection (matches flow-definition.mjs / baseline-plan.mjs).
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

function validateQuantity(q, p, issues) {
  if (!isQuantity(q)) {
    issues.add(p, "must be a mapping with a kind of unknown | not-applicable | known");
  }
}

// ---------------------------------------------------------------------------
// extra key safety
//
// CodeRabbit re-review finding on PR #177 (pilot-report.mjs:463):
// validateMetric let metric.extra accept arbitrary string keys, but
// renderMetric later writes each key as unescaped YAML mapping-key syntax
// ("${key}:"). parseRestrictedYAML's mapping-key parser only round-trips a
// PLAIN (unquoted) key that: starts with a letter, contains no ":"/"#"/
// whitespace/newline/quote/bracket character (any of which either
// prematurely ends the key at the first unquoted ": ", gets stripped as a
// trailing comment, or trips a forbidden-indicator/flow-collection/
// block-scalar rejection), and is not one of the parser's reserved scalar
// words ("true"/"false"/"null" would parse back as a boolean/null instead
// of the string key it started as, tripping "mapping keys must be plain
// strings"). A valid JS object key containing any of that — a colon, a
// newline — would corrupt the saved report on write, or make
// resumePilotReport throw or silently return a different key on read back.
// Restricting extra keys to this safe subset at validation time (fail
// closed, consistent with the rest of the bundle) closes that gap.
const PLAIN_YAML_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_YAML_KEY_WORDS = new Set(["true", "false", "null"]);

function isSafePlainYamlKey(key) {
  return typeof key === "string" && PLAIN_YAML_KEY_RE.test(key) && !RESERVED_YAML_KEY_WORDS.has(key);
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
  "measuredAt",
  "extra",
  "notes",
]);

// A metric missing ANY of these is not a metric — the ticket's exact
// requirement, and it holds even before any evidence exists (query/interval/
// source name the collection method itself).
const METRIC_REQUIRED_KEYS = ["id", "label", "query", "interval", "source", "numerator", "denominator", "provenance", "measuredAt"];

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
        `${key} is required — a metric missing any of numerator, denominator, query, interval, source, provenance, or measuredAt is not a metric, and cannot pass`,
      );
    }
  }

  if (metric.id !== undefined && !REQUIRED_METRIC_IDS.includes(metric.id)) {
    issues.add([...p, "id"], `id must be one of ${REQUIRED_METRIC_IDS.join(" | ")} (got ${JSON.stringify(metric.id)})`);
  }
  if ("label" in metric && !nonEmptyString(metric.label)) issues.add([...p, "label"], "label must be a non-empty string");
  if ("query" in metric && !nonEmptyString(metric.query)) {
    issues.add([...p, "query"], "query must name the exact collection query/method");
  }
  if ("interval" in metric && !nonEmptyString(metric.interval)) {
    issues.add([...p, "interval"], "interval must name the collection interval (e.g. trailing-4-weeks)");
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
    issues.add(p, "numerator and denominator must be not-applicable together, never only one side");
  }
  // Report-time metrics are never legitimately not-applicable: by the time a
  // Pilot Report exists all five Bindings are active, so every one of the
  // five named metrics is expected to have real evidence, or to honestly say
  // "measurement-required" (unknown) — never "does not apply here".
  if (nKind === "not-applicable" || dKind === "not-applicable") {
    issues.add(p, "a Pilot Report metric may not be not-applicable — all five metrics are expected to be measured once the pilot is active; use unknown if evidence is not yet collected");
  }

  if ("measuredAt" in metric) {
    const hasKnown = nKind === "known" && dKind === "known";
    if (hasKnown) {
      if (!isValidIsoTimestamp(metric.measuredAt)) {
        issues.add([...p, "measuredAt"], "measuredAt must be a valid ISO 8601 timestamp whenever numerator and denominator both carry known values");
      }
    } else if (metric.measuredAt !== null) {
      issues.add([...p, "measuredAt"], "measuredAt must be null when the metric has not been fully measured yet");
    }
  }

  if ("extra" in metric && metric.extra !== undefined) {
    if (!isPlainObject(metric.extra)) {
      issues.add([...p, "extra"], "extra must be a mapping of named auxiliary Quantities when present");
    } else {
      for (const [key, value] of Object.entries(metric.extra)) {
        if (!isSafePlainYamlKey(key)) {
          issues.add(
            [...p, "extra", key],
            `extra key ${JSON.stringify(key)} is not a supported plain YAML key (must match ${PLAIN_YAML_KEY_RE} and not be a reserved word) — an unsupported key cannot round-trip through the restricted YAML writer/parser`,
          );
        }
        validateQuantity(value, [...p, "extra", key], issues);
      }
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
      issues.add(p, `missing required metric ${JSON.stringify(requiredId)} — all five report metrics (coverage, escapes, latency, flake/false-positive, maintenance) are always present`);
    }
  }
  const extra = [...seen].filter((id) => !REQUIRED_METRIC_IDS.includes(id));
  if (extra.length) issues.add(p, `unknown metric id(s): ${extra.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Window / status
// ---------------------------------------------------------------------------

function validateWindow(window, p, issues) {
  if (!isPlainObject(window)) {
    issues.add(p, "window must be a mapping");
    return;
  }
  assertKnownKeys(window, new Set(["allBindingsActiveAt", "note"]), p, issues);
  if (!isValidIsoTimestamp(window.allBindingsActiveAt)) {
    issues.add([...p, "allBindingsActiveAt"], "allBindingsActiveAt must be a valid ISO 8601 timestamp naming when all five Bindings became active — the advisory-first clock starts here, not at report generation");
  }
  if ("note" in window && window.note !== undefined && typeof window.note !== "string") {
    issues.add([...p, "note"], "note must be a string when present");
  }
}

/**
 * Computes the report's overall status PURELY from its own metrics and
 * window — the same anti-fabrication choke point as
 * baseline-plan.mjs::computeReadiness.
 *
 *   - Any required metric not fully "known" on both numerator and
 *     denominator forces "pilot-incomplete" — a missing denominator is a
 *     gap, never a zero and never a silent pass (SPEC-135 story 104).
 *   - Otherwise, "complete" requires the advisory window to have run at
 *     least MIN_ADVISORY_WEEKS since allBindingsActiveAt, AND the
 *     designated run-count metric's denominator to be at least
 *     MIN_RELEVANT_PR_RUNS.
 *   - A malformed window or metrics array is "pilot-incomplete", never
 *     "complete" by omission.
 */
export function computeReportStatus(report, { now } = {}) {
  if (!isPlainObject(report) || !Array.isArray(report.metrics)) return "pilot-incomplete";

  for (const metric of report.metrics) {
    if (!isPlainObject(metric)) return "pilot-incomplete";
    if (metric?.numerator?.kind !== "known" || metric?.denominator?.kind !== "known") return "pilot-incomplete";
  }

  const started = isPlainObject(report.window) ? Date.parse(report.window.allBindingsActiveAt) : NaN;
  if (Number.isNaN(started)) return "pilot-incomplete";

  const nowMs = now instanceof Date ? now.getTime() : now !== undefined ? new Date(now).getTime() : Date.now();
  const elapsedWeeks = (nowMs - started) / (7 * 24 * 60 * 60 * 1000);
  if (elapsedWeeks < MIN_ADVISORY_WEEKS) return "pilot-incomplete";

  const runCountMetric = report.metrics.find((m) => isPlainObject(m) && m.id === RUN_COUNT_METRIC_ID);
  const runCountQuantity = runCountMetric?.denominator;
  if (!isQuantity(runCountQuantity) || runCountQuantity.kind !== "known" || runCountQuantity.value < MIN_RELEVANT_PR_RUNS) {
    return "pilot-incomplete";
  }

  return "complete";
}

// ---------------------------------------------------------------------------
// Top-level validation
// ---------------------------------------------------------------------------

const ROOT_KEYS = new Set(["schema", "id", "revision", "repository", "window", "metrics", "status", "generatedAt"]);

/**
 * Validates an already-parsed Pilot Report JS value, including the
 * anti-fabrication check: a stored `status` that disagrees with what
 * computeReportStatus derives from the SAME document's own metrics/window is
 * reported as an issue, never silently accepted.
 */
export function validatePilotReport(data, { expectedId, now } = {}) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Pilot Report document must be a mapping");
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

  if (!nonEmptyString(data.repository)) {
    issues.add(["repository"], "repository must name the repository identity this report measures");
  }

  validateWindow(data.window, ["window"], issues);
  validateMetricsArray(data.metrics, ["metrics"], issues);

  if (!isValidIsoTimestamp(data.generatedAt)) {
    issues.add(["generatedAt"], "generatedAt must be a valid ISO 8601 timestamp");
  }

  if (!REPORT_STATUS.includes(data.status)) {
    issues.add(["status"], `status must be one of ${REPORT_STATUS.join(" | ")} (got ${JSON.stringify(data.status)})`);
  } else if (issues.list.length === 0) {
    const recomputed = computeReportStatus(data, { now: now ?? data.generatedAt });
    if (recomputed !== data.status) {
      issues.add(
        ["status"],
        `stored status ${JSON.stringify(data.status)} does not match what this report's own metrics and window evidence support (recomputed: ${JSON.stringify(recomputed)}) — status is never hand-set ahead of its evidence`,
      );
    }
  }

  return { valid: issues.list.length === 0, errors: issues.list };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * The only constructor. Deliberately has NO `status` parameter: status is
 * always derived by computeReportStatus from the metrics/window given.
 */
export function buildPilotReport({ id, revision, repository, window, metrics, generatedAt }, { now } = {}) {
  const draft = {
    schema: SUPPORTED_SCHEMA,
    id,
    revision,
    repository,
    window,
    metrics,
    generatedAt,
    status: "pilot-incomplete", // placeholder; recomputed unconditionally below
  };
  draft.status = computeReportStatus(draft, { now });

  const { valid, errors } = validatePilotReport(draft, { now });
  if (!valid) {
    throw new Error(`buildPilotReport produced an invalid Pilot Report: ${errors.map((e) => e.message).join("; ")}`);
  }
  return draft;
}

/** Small convenience constructor for one metric entry (not a validator). */
export function makeReportMetric({ id, label, query, interval, source, provenance, numerator, denominator, measuredAt = null, extra, notes }) {
  const metric = { id, label, query, interval, source, numerator, denominator, provenance, measuredAt };
  if (extra !== undefined) metric.extra = extra;
  if (notes !== undefined) metric.notes = notes;
  return metric;
}

/**
 * Per-metric report-time check named directly by the ticket: "an unknown or
 * missing metric is reported as such and fails its check". Returns
 * { ok, reason } rather than a boolean so a caller (or the promotion gate)
 * can surface WHY a metric failed without re-deriving it.
 */
export function checkMetricPasses(metric) {
  if (!isPlainObject(metric)) return { ok: false, reason: "metric is missing or malformed" };
  for (const key of METRIC_REQUIRED_KEYS) {
    if (!(key in metric)) return { ok: false, reason: `metric is missing required field ${key}` };
  }
  if (metric.numerator?.kind !== "known" || metric.denominator?.kind !== "known") {
    return { ok: false, reason: "metric numerator/denominator is not fully known — an unknown or missing metric cannot pass" };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Rendering — restricted-YAML subset only (mirrors baseline-plan.mjs's own
// renderBaselinePlanYAML / flow-yaml.mjs's approach exactly, for the same
// reason: PILOT_REPORT_REPO_PATH names a `.yaml` file, parsed back by
// parsePilotReportDocument/resumePilotReport with parseRestrictedYAML — a
// parser that does not accept JSON's `{`/`[` flow syntax at all. Writing
// `JSON.stringify(report)` to that path would save a document its own
// resume path can never read back (verified: it throws on the very first
// line). Not a general-purpose YAML writer — round-tripping through
// parseRestrictedYAML + validatePilotReport is guaranteed to succeed and to
// reproduce an identical document.
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
  throw new Error(`pilot-report: cannot render a scalar of type ${typeof value}`);
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
  lines.push(`${pad(indent + 2)}numerator:`);
  lines.push(...renderQuantity(m.numerator, indent + 4));
  lines.push(`${pad(indent + 2)}denominator:`);
  lines.push(...renderQuantity(m.denominator, indent + 4));
  lines.push(`${pad(indent + 2)}provenance: ${renderScalar(m.provenance)}`);
  lines.push(`${pad(indent + 2)}measuredAt: ${renderScalar(m.measuredAt)}`);
  if (m.extra !== undefined) {
    const extraKeys = Object.keys(m.extra);
    if (extraKeys.length === 0) {
      lines.push(`${pad(indent + 2)}extra: {}`);
    } else {
      lines.push(`${pad(indent + 2)}extra:`);
      for (const key of extraKeys) {
        // Defense in depth: this should already be unreachable for a
        // metric that passed validatePilotReport (see the "extra key
        // safety" section above), but renderMetric has its own exported
        // caller (renderPilotReportYAML) that a test or future caller could
        // invoke on an unvalidated draft. Fail closed here too rather than
        // silently emitting a key that could corrupt the written YAML.
        if (!isSafePlainYamlKey(key)) {
          throw new Error(
            `pilot-report: cannot render extra key ${JSON.stringify(key)} — not a supported plain YAML key (must match ${PLAIN_YAML_KEY_RE} and not be a reserved word)`,
          );
        }
        lines.push(`${pad(indent + 4)}${key}:`);
        lines.push(...renderQuantity(m.extra[key], indent + 6));
      }
    }
  }
  if (m.notes !== undefined) lines.push(`${pad(indent + 2)}notes: ${renderScalar(m.notes)}`);
  return lines;
}

/**
 * Renders a Pilot Report JS value into the restricted YAML subset
 * restricted-yaml.mjs accepts. See the section header above for why this
 * exists at all: PILOT_REPORT_REPO_PATH is a `.yaml` file read back with
 * parseRestrictedYAML, never with JSON.parse.
 */
export function renderPilotReportYAML(report) {
  const lines = [];
  lines.push(`schema: ${renderScalar(report.schema)}`);
  lines.push(`id: ${renderScalar(report.id)}`);
  lines.push(`revision: ${renderScalar(report.revision)}`);
  lines.push(`repository: ${renderScalar(report.repository)}`);
  lines.push(`window:`);
  lines.push(`  allBindingsActiveAt: ${renderScalar(report.window.allBindingsActiveAt)}`);
  if (report.window.note !== undefined) lines.push(`  note: ${renderScalar(report.window.note)}`);
  if (report.metrics.length === 0) {
    lines.push(`metrics: []`);
  } else {
    lines.push(`metrics:`);
    for (const m of report.metrics) lines.push(...renderMetric(m, 2));
  }
  lines.push(`status: ${renderScalar(report.status)}`);
  lines.push(`generatedAt: ${renderScalar(report.generatedAt)}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Resume / persistence (mirrors baseline-plan.mjs's resume discipline)
// ---------------------------------------------------------------------------

export function parsePilotReportDocument(source, { filename } = {}) {
  return parseRestrictedYAML(source, { filename: filename ?? PILOT_REPORT_REPO_PATH });
}

/**
 * Resumes purely from the repository's own qa/pilot-report.yaml, exactly
 * like baseline-plan.mjs::resumeBaselinePlan: one argument, no cache, no
 * session identifier, so the reported status can legitimately flip between
 * two resumes of an untouched file as the advisory window elapses.
 */
export function resumePilotReport(repoRoot, { now } = {}) {
  const filePath = path.join(repoRoot, PILOT_REPORT_REPO_PATH);
  if (!existsSync(filePath)) {
    return { exists: false, report: null, status: "pilot-incomplete", valid: true, errors: [] };
  }
  const source = readFileSync(filePath, "utf8");
  const data = parsePilotReportDocument(source);
  const { valid, errors } = validatePilotReport(data);
  const status = valid ? computeReportStatus(data, { now }) : "pilot-incomplete";
  return { exists: true, report: data, status, valid, errors };
}

export function savePilotReportToRepo(repoRoot, report) {
  const { valid, errors } = validatePilotReport(report);
  if (!valid) {
    throw new Error(`refusing to write an invalid Pilot Report: ${errors.map((e) => e.message).join("; ")}`);
  }
  const filePath = path.join(repoRoot, PILOT_REPORT_REPO_PATH);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderPilotReportYAML(report), "utf8");
  return filePath;
}
