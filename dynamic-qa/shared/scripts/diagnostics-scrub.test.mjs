// dynamic-qa/shared/scripts/diagnostics-scrub.test.mjs
//
// Tier 1 coverage for ticket #155's diagnostics scrubbing gate
// (diagnostics-scrub.mjs). Each acceptance criterion gets its own test:
// off-by-default, failure-only, per-kind secret scrubbing (log/DOM/trace/
// JUnit), scrub-failure-suppresses-upload, size bounds, retention, and
// audience narrowness. Screenshots (the one binary kind) are covered
// separately since they cannot be text-scrubbed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIAGNOSTIC_KINDS,
  RICH_DIAGNOSTIC_KINDS,
  BUNDLE_DIAGNOSTIC_KINDS,
  RETENTION_DAYS,
  DEFAULT_SIZE_BOUNDS_BYTES,
  ALLOWED_DIAGNOSTIC_AUDIENCES,
  checkDiagnosticAudience,
  prepareDiagnosticForUpload,
  buildDiagnosticsManifest,
} from "./diagnostics-scrub.mjs";

const OK_AUDIENCE = ALLOWED_DIAGNOSTIC_AUDIENCES[0];

test("all five ticket-named diagnostic kinds are recognised, split into exactly two buckets", () => {
  assert.deepEqual(DIAGNOSTIC_KINDS, ["log", "dom", "trace", "screenshot", "junit"]);
  for (const kind of RICH_DIAGNOSTIC_KINDS) assert.ok(!BUNDLE_DIAGNOSTIC_KINDS.includes(kind));
  assert.deepEqual([...RICH_DIAGNOSTIC_KINDS, ...BUNDLE_DIAGNOSTIC_KINDS].sort(), [...DIAGNOSTIC_KINDS].sort());
});

// --- off by default / failure-only ------------------------------------------

test("rich diagnostics are off by default: no options at all suppresses a DOM capture", () => {
  const result = prepareDiagnosticForUpload("dom", { text: "<html></html>" });
  assert.equal(result.upload, false);
  assert.equal(result.reason, "diagnostics.rich-disabled-by-default");
  assert.equal(result.message, "diagnostic withheld");
});

test("rich diagnostics enabled but the run passed: still suppressed (failure-only)", () => {
  const result = prepareDiagnosticForUpload(
    "trace",
    { text: "trace event stream" },
    { richDiagnosticsEnabled: true, runOutcome: "pass", audience: OK_AUDIENCE },
  );
  assert.equal(result.upload, false);
  assert.equal(result.reason, "diagnostics.rich-not-failure");
});

test("rich diagnostics enabled AND the run failed: proceeds to scrub/size/audience checks", () => {
  const result = prepareDiagnosticForUpload(
    "log",
    { text: "clean log line" },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: OK_AUDIENCE },
  );
  assert.equal(result.upload, true);
  assert.equal(result.artifact.retentionDays, RETENTION_DAYS.rich);
});

test("JUnit (bundle kind) is not gated by richDiagnosticsEnabled/runOutcome at all", () => {
  const result = prepareDiagnosticForUpload("junit", { text: "<testsuite></testsuite>" });
  assert.equal(result.upload, true);
  assert.equal(result.artifact.retentionDays, RETENTION_DAYS.bundle);
});

// --- per-kind secret scrubbing ----------------------------------------------

test("log: a secret pattern is removed, not merely flagged", () => {
  const result = prepareDiagnosticForUpload(
    "log",
    { text: "auth header set: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef.ghijkl" },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: OK_AUDIENCE },
  );
  assert.equal(result.upload, true);
  assert.ok(!result.artifact.text.includes("Bearer eyJhbGciOiJIUzI1NiJ9"));
  assert.ok(result.artifact.redactionCount >= 1);
});

test("DOM: a secret pattern embedded in an attribute is removed", () => {
  const result = prepareDiagnosticForUpload(
    "dom",
    { text: `<input value="AKIAABCDEFGHIJKLMNOP" />` },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: OK_AUDIENCE },
  );
  assert.equal(result.upload, true);
  assert.ok(!result.artifact.text.includes("AKIAABCDEFGHIJKLMNOP"));
});

test("trace: a secret pattern embedded in an event payload is removed", () => {
  const result = prepareDiagnosticForUpload(
    "trace",
    { text: `{"header":"Authorization: Bearer sometoken1234567890"}` },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: OK_AUDIENCE },
  );
  assert.equal(result.upload, true);
  assert.ok(!result.artifact.text.includes("Bearer sometoken1234567890"));
});

test("junit: a secret pattern embedded in system-out is removed", () => {
  const result = prepareDiagnosticForUpload("junit", {
    text: `<system-out>db url mongodb://user:hunter2pass@db.example.com/app</system-out>`,
  });
  assert.equal(result.upload, true);
  assert.ok(!result.artifact.text.includes("user:hunter2pass@"));
});

// --- scrub failure suppresses upload (structural guarantee) -----------------

test("scrub verification failure suppresses the artifact — it is never uploaded, redacted or not", () => {
  // Dependency-injection seam (module header): a `verify` override that
  // always reports "still not clean" simulates a scrub the module cannot
  // trust, without needing a contrived regex gap. Production code never
  // overrides `verify`.
  const result = prepareDiagnosticForUpload(
    "log",
    { text: "perfectly ordinary log line" },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: OK_AUDIENCE, verify: () => true },
  );
  assert.equal(result.upload, false);
  assert.equal(result.reason, "diagnostics.scrub-verification-failed");
  assert.equal(result.message, "diagnostic withheld");
  assert.equal("artifact" in result, false, "a suppressed result must carry no artifact content at all");
});

test("screenshot: absent explicit verified-redaction evidence, the artifact is suppressed (fail safe — no image parser exists)", () => {
  const result = prepareDiagnosticForUpload(
    "screenshot",
    { bytes: Buffer.from("fake-png-bytes").toString("base64") },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: OK_AUDIENCE },
  );
  assert.equal(result.upload, false);
  assert.equal(result.reason, "diagnostics.binary-scrub-unverified");
});

test("screenshot: with explicit verifiedRedacted evidence, it may upload", () => {
  const result = prepareDiagnosticForUpload(
    "screenshot",
    { bytes: Buffer.from("fake-png-bytes").toString("base64"), verifiedRedacted: true },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: OK_AUDIENCE },
  );
  assert.equal(result.upload, true);
  assert.equal(result.artifact.retentionDays, RETENTION_DAYS.rich);
});

// --- size bounds -------------------------------------------------------------

test("size bound exceeded suppresses the artifact rather than truncating it", () => {
  const bigText = "x".repeat(DEFAULT_SIZE_BOUNDS_BYTES.log + 1);
  const result = prepareDiagnosticForUpload(
    "log",
    { text: bigText },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: OK_AUDIENCE },
  );
  assert.equal(result.upload, false);
  assert.equal(result.reason, "diagnostics.size-bound-exceeded");
});

test("a caller-supplied tighter size bound is honoured", () => {
  const result = prepareDiagnosticForUpload(
    "junit",
    { text: "x".repeat(100) },
    { sizeBounds: { junit: 10 } },
  );
  assert.equal(result.upload, false);
  assert.equal(result.reason, "diagnostics.size-bound-exceeded");
});

// --- retention windows -------------------------------------------------------

test("retention: rich diagnostics default to 7 days, the scrubbed bundle to 30 days", () => {
  assert.equal(RETENTION_DAYS.rich, 7);
  assert.equal(RETENTION_DAYS.bundle, 30);
});

// --- narrow visibility --------------------------------------------------------

test("checkDiagnosticAudience: rejects a public/unrestricted audience by name", () => {
  const result = checkDiagnosticAudience("public");
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "diagnostics.audience-not-narrow");
});

test("a rich diagnostic with no audience (or too broad an audience) is suppressed", () => {
  const noAudience = prepareDiagnosticForUpload("log", { text: "ok" }, { richDiagnosticsEnabled: true, runOutcome: "failure" });
  assert.equal(noAudience.upload, false);
  assert.equal(noAudience.reason, "diagnostics.audience-not-narrow");

  const publicAudience = prepareDiagnosticForUpload(
    "log",
    { text: "ok" },
    { richDiagnosticsEnabled: true, runOutcome: "failure", audience: "public" },
  );
  assert.equal(publicAudience.upload, false);
  assert.equal(publicAudience.reason, "diagnostics.audience-not-narrow");
});

// --- exact artifact manifest, never a glob -----------------------------------

test("buildDiagnosticsManifest: produces an exact artifact list and withholds the rest with reasons", () => {
  const manifest = buildDiagnosticsManifest(
    [
      { kind: "junit", path: "diagnostics/result.xml", diagnostic: { text: "<testsuite></testsuite>" } },
      { kind: "dom", path: "diagnostics/dom.html", diagnostic: { text: "<html></html>" } }, // rich, disabled by default
      { kind: "log", path: "diagnostics/*.log", diagnostic: { text: "ok" } }, // wildcard path itself is refused
    ],
    {},
  );
  assert.deepEqual(manifest.artifacts, [{ kind: "junit", path: "diagnostics/result.xml", sizeBytes: manifest.artifacts[0].sizeBytes, retentionDays: 30 }]);
  assert.equal(manifest.withheld.length, 2);
  assert.ok(manifest.withheld.some((w) => w.reason === "diagnostics.rich-disabled-by-default"));
  assert.ok(manifest.withheld.some((w) => w.reason === "diagnostics.wildcard-artifact-path"));
});

test("an unknown diagnostic kind is suppressed by name, never silently accepted", () => {
  const result = prepareDiagnosticForUpload("video", { text: "x" });
  assert.equal(result.upload, false);
  assert.equal(result.reason, "diagnostics.unknown-kind");
});
