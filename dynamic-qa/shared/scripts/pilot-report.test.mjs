// dynamic-qa/shared/scripts/pilot-report.test.mjs
//
// Tier 1 coverage for the Pilot Report contract (ticket #173). Every case
// here uses SYNTHETIC numbers explicitly labelled as test fixtures — none of
// this is real VibeFileSync pilot evidence (see run brief decision 3 and
// this ticket's DECISIONS.md entry).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REQUIRED_METRIC_IDS,
  RUN_COUNT_METRIC_ID,
  MIN_ADVISORY_WEEKS,
  MIN_RELEVANT_PR_RUNS,
  PILOT_REPORT_REPO_PATH,
  unknownQuantity,
  notApplicableQuantity,
  knownQuantity,
  makeReportMetric,
  buildPilotReport,
  validatePilotReport,
  computeReportStatus,
  checkMetricPasses,
  savePilotReportToRepo,
  resumePilotReport,
  renderPilotReportYAML,
  parsePilotReportDocument,
} from "./pilot-report.mjs";

const ACTIVE_SINCE = "2026-01-01T00:00:00Z";
const WELL_PAST_WINDOW = "2026-03-01T00:00:00Z"; // > 4 weeks after ACTIVE_SINCE
const TOO_SOON = "2026-01-10T00:00:00Z"; // < 4 weeks after ACTIVE_SINCE

function knownMetric(id, { numerator, denominator, extra } = {}) {
  return makeReportMetric({
    id,
    label: `${id} (test fixture)`,
    query: "SELECT synthetic test data",
    interval: "trailing-4-weeks",
    source: "test-fixture",
    provenance: "observed",
    numerator: knownQuantity(numerator),
    denominator: knownQuantity(denominator),
    measuredAt: ACTIVE_SINCE,
    extra,
  });
}

function unknownMetric(id) {
  return makeReportMetric({
    id,
    label: `${id} (not yet measured)`,
    query: "SELECT synthetic test data",
    interval: "trailing-4-weeks",
    source: "test-fixture",
    provenance: "unknown",
    numerator: unknownQuantity(),
    denominator: unknownQuantity(),
    measuredAt: null,
  });
}

function fullyKnownMetrics() {
  return [
    knownMetric("flow-coverage", { numerator: 5, denominator: 5 }),
    knownMetric("escaped-regressions", { numerator: 0, denominator: 5 }),
    knownMetric("pr-check-latency-p95", { numerator: 500, denominator: 25 }),
    knownMetric("flake-false-positive-rate", { numerator: 1, denominator: 200 }),
    knownMetric("maintenance-time", { numerator: 20, denominator: 8, extra: { maxEventMinutes: knownQuantity(45) } }),
  ];
}

test("REQUIRED_METRIC_IDS names exactly the five report metrics the ticket lists", () => {
  assert.deepEqual(
    [...REQUIRED_METRIC_IDS].sort(),
    ["escaped-regressions", "flake-false-positive-rate", "flow-coverage", "maintenance-time", "pr-check-latency-p95"].sort(),
  );
});

test("a fully-measured report, past the advisory window, is complete", () => {
  const report = buildPilotReport(
    {
      id: "vibefilesync-pilot",
      revision: 1,
      repository: "phassle/VibeFileSync",
      window: { allBindingsActiveAt: ACTIVE_SINCE },
      metrics: fullyKnownMetrics(),
      generatedAt: WELL_PAST_WINDOW,
    },
    { now: WELL_PAST_WINDOW },
  );
  assert.equal(report.status, "complete");
  const { valid, errors } = validatePilotReport(report, { now: WELL_PAST_WINDOW });
  assert.equal(valid, true, JSON.stringify(errors));
});

test("a report missing any one metric is rejected — a metric missing a required field cannot pass", () => {
  const metrics = fullyKnownMetrics().slice(0, 4); // drop maintenance-time entirely
  const draft = {
    schema: "dynamic-qa-pilot-report-v1",
    id: "vibefilesync-pilot",
    revision: 1,
    repository: "phassle/VibeFileSync",
    window: { allBindingsActiveAt: ACTIVE_SINCE },
    metrics,
    status: "complete",
    generatedAt: WELL_PAST_WINDOW,
  };
  const { valid, errors } = validatePilotReport(draft, { now: WELL_PAST_WINDOW });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.message.includes("missing required metric") && e.message.includes("maintenance-time")));
});

test("a metric missing query/interval/source/provenance is rejected even with known numbers", () => {
  const metric = { id: "flow-coverage", numerator: knownQuantity(5), denominator: knownQuantity(5), measuredAt: ACTIVE_SINCE };
  const metrics = [metric, ...fullyKnownMetrics().slice(1)];
  const draft = {
    schema: "dynamic-qa-pilot-report-v1",
    id: "vibefilesync-pilot",
    revision: 1,
    repository: "phassle/VibeFileSync",
    window: { allBindingsActiveAt: ACTIVE_SINCE },
    metrics,
    status: "complete",
    generatedAt: WELL_PAST_WINDOW,
  };
  const { valid, errors } = validatePilotReport(draft, { now: WELL_PAST_WINDOW });
  assert.equal(valid, false);
  for (const field of ["label", "query", "interval", "source", "provenance"]) {
    assert.ok(errors.some((e) => e.message.includes(field)), `expected an error naming ${field}`);
  }
});

test("an unknown metric never passes and forces pilot-incomplete, never a good result", () => {
  const metrics = [unknownMetric("flow-coverage"), ...fullyKnownMetrics().slice(1)];
  const status = computeReportStatus(
    { metrics, window: { allBindingsActiveAt: ACTIVE_SINCE } },
    { now: WELL_PAST_WINDOW },
  );
  assert.equal(status, "pilot-incomplete");
  assert.equal(checkMetricPasses(metrics[0]).ok, false);
});

test("unknown, zero, and not-applicable stay distinct end to end", () => {
  const zero = knownQuantity(0);
  const unknown = unknownQuantity();
  const na = notApplicableQuantity("not measured yet — test fixture");
  assert.equal(zero.kind, "known");
  assert.equal(zero.value, 0);
  assert.equal(unknown.kind, "unknown");
  assert.equal(na.kind, "not-applicable");
  assert.notDeepEqual(zero, unknown);
  assert.notDeepEqual(zero, na);
  assert.notDeepEqual(unknown, na);
});

test("a not-applicable report metric is rejected — report-time metrics are never legitimately N/A", () => {
  const metric = makeReportMetric({
    id: "escaped-regressions",
    label: "escapes",
    query: "test",
    interval: "trailing-4-weeks",
    source: "test-fixture",
    provenance: "unknown",
    numerator: notApplicableQuantity("test fixture: pretending this does not apply"),
    denominator: notApplicableQuantity("test fixture: pretending this does not apply"),
    measuredAt: null,
  });
  const metrics = [fullyKnownMetrics()[0], metric, ...fullyKnownMetrics().slice(2)];
  const draft = {
    schema: "dynamic-qa-pilot-report-v1",
    id: "vibefilesync-pilot",
    revision: 1,
    repository: "phassle/VibeFileSync",
    window: { allBindingsActiveAt: ACTIVE_SINCE },
    metrics,
    status: "pilot-incomplete",
    generatedAt: WELL_PAST_WINDOW,
  };
  const { valid, errors } = validatePilotReport(draft, { now: WELL_PAST_WINDOW });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.message.includes("may not be not-applicable")));
});

test("a report cannot be complete before the 4-week advisory window elapses", () => {
  const status = computeReportStatus(
    { metrics: fullyKnownMetrics(), window: { allBindingsActiveAt: ACTIVE_SINCE } },
    { now: TOO_SOON },
  );
  assert.equal(status, "pilot-incomplete");
});

test("a report cannot be complete below the 20 relevant PR runs gate", () => {
  const metrics = fullyKnownMetrics().map((m) =>
    m.id === RUN_COUNT_METRIC_ID ? { ...m, denominator: knownQuantity(MIN_RELEVANT_PR_RUNS - 1) } : m,
  );
  const status = computeReportStatus({ metrics, window: { allBindingsActiveAt: ACTIVE_SINCE } }, { now: WELL_PAST_WINDOW });
  assert.equal(status, "pilot-incomplete");
});

test("a hand-set status that disagrees with the report's own evidence is rejected — never fabricated", () => {
  const draft = {
    schema: "dynamic-qa-pilot-report-v1",
    id: "vibefilesync-pilot",
    revision: 1,
    repository: "phassle/VibeFileSync",
    window: { allBindingsActiveAt: ACTIVE_SINCE },
    metrics: fullyKnownMetrics(),
    status: "complete",
    generatedAt: TOO_SOON, // evidence does not yet support "complete" at this instant
  };
  const { valid, errors } = validatePilotReport(draft, { now: TOO_SOON });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.message.includes("does not match what this report's own metrics")));
});

test("MIN_ADVISORY_WEEKS and MIN_RELEVANT_PR_RUNS are the exact spec-given constants", () => {
  assert.equal(MIN_ADVISORY_WEEKS, 4);
  assert.equal(MIN_RELEVANT_PR_RUNS, 20);
});

// --- save/resume round trip: PILOT_REPORT_REPO_PATH is a .yaml file, read
// back with the restricted-YAML parser, never with JSON.parse. A previous
// version of savePilotReportToRepo wrote JSON.stringify(report) to that
// path — a document its own resume path could never read back. -----------

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeysDeep(value[k])]));
  }
  return value;
}

function tempRepoRoot() {
  return mkdtempSync(path.join(tmpdir(), "pilot-report-test-"));
}

test("savePilotReportToRepo writes a document resumePilotReport can read straight back, complete with extra metrics and notes", () => {
  const repoRoot = tempRepoRoot();
  try {
    const metrics = fullyKnownMetrics().map((m) =>
      m.id === "maintenance-time" ? { ...m, notes: "hand-reviewed" } : m,
    );
    const report = buildPilotReport(
      {
        id: "vibefilesync-pilot",
        revision: 1,
        repository: "phassle/VibeFileSync",
        window: { allBindingsActiveAt: ACTIVE_SINCE, note: "kickoff" },
        metrics,
        generatedAt: WELL_PAST_WINDOW,
      },
      { now: WELL_PAST_WINDOW },
    );

    const filePath = savePilotReportToRepo(repoRoot, report);
    assert.equal(filePath, path.join(repoRoot, PILOT_REPORT_REPO_PATH));

    // The file on disk must actually be restricted-YAML, not JSON — a raw
    // JSON document starts with "{" as its first non-whitespace character,
    // which parseRestrictedYAML rejects outright (it is not "key: value").
    const onDisk = readFileSync(filePath, "utf8").trim();
    assert.ok(onDisk.startsWith("schema:"), `expected a YAML document, got: ${onDisk.slice(0, 40)}`);

    const resumed = resumePilotReport(repoRoot, { now: WELL_PAST_WINDOW });
    assert.equal(resumed.exists, true);
    assert.equal(resumed.valid, true, JSON.stringify(resumed.errors));
    assert.equal(resumed.status, "complete");
    assert.deepEqual(sortKeysDeep(resumed.report), sortKeysDeep(report));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("renderPilotReportYAML's empty-metrics-list flow literal round-trips through parseRestrictedYAML", () => {
  // savePilotReportToRepo always refuses an incomplete metrics list (a
  // valid report always carries all five), but the renderer's "metrics: []"
  // flow-literal branch is still real, reachable code — exercise it
  // directly against the same parser resumePilotReport uses, rather than
  // routing around it via the schema-validity gate.
  const draft = {
    schema: "dynamic-qa-pilot-report-v1",
    id: "vibefilesync-pilot",
    revision: 1,
    repository: "phassle/VibeFileSync",
    window: { allBindingsActiveAt: ACTIVE_SINCE },
    metrics: [],
    status: "pilot-incomplete",
    generatedAt: ACTIVE_SINCE,
  };
  const yaml = renderPilotReportYAML(draft);
  assert.match(yaml, /^metrics: \[\]$/m);
  const parsed = parsePilotReportDocument(yaml);
  assert.deepEqual(parsed.metrics, []);
});

test("savePilotReportToRepo round-trips string values needing escaping (quotes, backslash, newline)", () => {
  const repoRoot = tempRepoRoot();
  try {
    const metrics = fullyKnownMetrics().map((m) =>
      m.id === "flow-coverage" ? { ...m, notes: `a "quoted" note with a\\backslash and a\nline break` } : m,
    );
    const report = buildPilotReport(
      {
        id: "vibefilesync-pilot",
        revision: 1,
        repository: "phassle/VibeFileSync",
        window: { allBindingsActiveAt: ACTIVE_SINCE },
        metrics,
        generatedAt: WELL_PAST_WINDOW,
      },
      { now: WELL_PAST_WINDOW },
    );
    savePilotReportToRepo(repoRoot, report);
    const resumed = resumePilotReport(repoRoot, { now: WELL_PAST_WINDOW });
    assert.equal(resumed.valid, true, JSON.stringify(resumed.errors));
    const flowCoverage = resumed.report.metrics.find((m) => m.id === "flow-coverage");
    assert.equal(flowCoverage.notes, `a "quoted" note with a\\backslash and a\nline break`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
