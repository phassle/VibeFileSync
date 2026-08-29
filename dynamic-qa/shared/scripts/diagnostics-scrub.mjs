// dynamic-qa/shared/scripts/diagnostics-scrub.mjs
//
// Ticket #155, completing #153's low-trust CI lane with the diagnostics half
// of DESIGN-dynamic-qa-spec.md §11: "Rich diagnostics are failure-only,
// minimized, scrubbed, size-bounded, and narrowly visible. DOM, screenshots,
// video, traces, HAR, storage, and bodies default off. Rich diagnostics
// default to seven-day retention; scrubbed JUnit/result bundles to 30 days.
// Scrub failure suppresses upload and records `diagnostic withheld`."
//
// This module reuses secret-detection.mjs's `redactSecretsInText` and
// `textStillContainsSecretShapedValue` (ticket #144's detector, extended by
// this ticket with free-text variants of the exact same patterns) as the
// SOLE scrubber. It does not define a second detector.
//
// --- the two retention/visibility buckets -----------------------------------
//
// The five diagnostic kinds this ticket names — logs, DOM, traces,
// screenshots, JUnit — split into exactly two buckets, matching the spec's
// two named retention windows:
//
//   RICH_DIAGNOSTIC_KINDS  = log, dom, trace, screenshot
//     off by default, failure-only when enabled, 7-day retention.
//   BUNDLE_DIAGNOSTIC_KINDS = junit
//     always produced (a pass/fail result needs it), still scrubbed,
//     30-day retention.
//
// --- the structural "scrub failure suppresses upload" guarantee ------------
//
// `prepareDiagnosticForUpload` is the ONLY function in this module that
// returns an "uploadable" shape (`{ upload: true, artifact }`). There is no
// code path in this function that reaches `upload: true` without first
// producing text that has been redacted AND then re-verified clean by
// `textStillContainsSecretShapedValue` (for text kinds), or without an
// explicit, caller-supplied, already-verified redaction (for the one binary
// kind, screenshots — this module has no image parser and cannot itself
// inspect pixel content). Every other exit from this function returns
// `{ upload: false, reason, message: "diagnostic withheld" }`. A caller
// cannot obtain diagnostic content any other way: there is no exported
// function that hands back raw/redacted bytes without going through this
// gate, so "an unscrubbed artifact reaches an upload" has no path to exist.
//
// The `verify` option (default `textStillContainsSecretShapedValue`) is an
// explicit dependency-injection seam used ONLY by this module's own tests to
// deterministically prove the suppression path: a test passes
// `verify: () => true` to simulate "the scrub could not be verified clean"
// without needing a contrived regex gap, and asserts the artifact is
// suppressed rather than uploaded. Production callers never override it.

import { redactSecretsInText, textStillContainsSecretShapedValue } from "./secret-detection.mjs";

export const DIAGNOSTIC_KINDS = Object.freeze(["log", "dom", "trace", "screenshot", "junit"]);

export const RICH_DIAGNOSTIC_KINDS = Object.freeze(["log", "dom", "trace", "screenshot"]);
export const BUNDLE_DIAGNOSTIC_KINDS = Object.freeze(["junit"]);

const TEXT_KINDS = new Set(["log", "dom", "trace", "junit"]);
const BINARY_KINDS = new Set(["screenshot"]);

export const RETENTION_DAYS = Object.freeze({ rich: 7, bundle: 30 });

// Conservative per-kind defaults. "Minimized" per the spec — these bound a
// single diagnostic artifact, not a whole workspace. A caller may pass a
// tighter bound; this module never widens a caller-supplied bound.
export const DEFAULT_SIZE_BOUNDS_BYTES = Object.freeze({
  log: 256 * 1024,
  dom: 512 * 1024,
  trace: 2 * 1024 * 1024,
  screenshot: 1 * 1024 * 1024,
  junit: 512 * 1024,
});

// "Narrowly visible": rich diagnostics may never be handed to a public/
// unrestricted audience. This is a fixed allowlist, not a caller-suppliable
// bypass — a caller who wants broader visibility must pick a different
// (narrower) label, not weaken this list.
export const ALLOWED_DIAGNOSTIC_AUDIENCES = Object.freeze(["repository-maintainers", "triage-owners"]);

const WITHHELD_MESSAGE = "diagnostic withheld";

function bucketOf(kind) {
  if (RICH_DIAGNOSTIC_KINDS.includes(kind)) return "rich";
  if (BUNDLE_DIAGNOSTIC_KINDS.includes(kind)) return "bundle";
  return undefined;
}

function withheld(reason, extra = {}) {
  return { upload: false, reason, message: WITHHELD_MESSAGE, ...extra };
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Checks whether a diagnostic audience label is narrow enough to receive a
 * rich diagnostic. Returns `{ valid, errors }` (this module's usual shape)
 * rather than a bare boolean, so a caller/test can see a named reason.
 */
export function checkDiagnosticAudience(audience) {
  if (ALLOWED_DIAGNOSTIC_AUDIENCES.includes(audience)) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: [
      {
        code: "diagnostics.audience-not-narrow",
        message: `diagnostic audience ${JSON.stringify(audience ?? null)} is not in the narrow allowlist ${JSON.stringify(ALLOWED_DIAGNOSTIC_AUDIENCES)} — rich diagnostics must stay narrowly visible, never public/unrestricted`,
      },
    ],
  };
}

/**
 * The single entry point. Given a diagnostic `kind` and its raw content
 * descriptor, decides whether it may be uploaded at all, and if so, returns
 * the scrubbed content plus its retention window. Never throws for an
 * ordinary input problem — an unknown kind, missing content, a failed
 * scrub, an oversized artifact, or a too-broad audience are all named
 * suppression reasons, not exceptions.
 *
 * `diagnostic` shape:
 *   - text kinds (log, dom, trace, junit): `{ text }`
 *   - binary kinds (screenshot): `{ bytes, verifiedRedacted }` — bytes is a
 *     Buffer/Uint8Array/base64 string; `verifiedRedacted: true` asserts an
 *     external (non-text) redaction pass already ran and was verified. This
 *     module has no image parser, so it can never itself confirm that claim
 *     — absent an explicit `true`, the artifact is suppressed. Fail safe.
 *
 * `opts`:
 *   - `richDiagnosticsEnabled` (default `false`) — rich diagnostics are off
 *     unless explicitly `true`.
 *   - `runOutcome` (`"pass" | "failure"`) — rich diagnostics require
 *     `"failure"`.
 *   - `audience` (default `undefined`, which fails `checkDiagnosticAudience`)
 *     — required for rich diagnostics.
 *   - `sizeBounds` (default `DEFAULT_SIZE_BOUNDS_BYTES`).
 *   - `verify` (default `textStillContainsSecretShapedValue`) — test-only
 *     injection seam, see module header.
 */
export function prepareDiagnosticForUpload(kind, diagnostic, opts = {}) {
  const { richDiagnosticsEnabled = false, runOutcome, audience, sizeBounds = DEFAULT_SIZE_BOUNDS_BYTES, verify = textStillContainsSecretShapedValue } = opts;

  const bucket = bucketOf(kind);
  if (!bucket) {
    return withheld("diagnostics.unknown-kind", { kind });
  }

  if (bucket === "rich") {
    if (richDiagnosticsEnabled !== true) {
      return withheld("diagnostics.rich-disabled-by-default", { kind });
    }
    if (runOutcome !== "failure") {
      return withheld("diagnostics.rich-not-failure", { kind });
    }
    const audienceCheck = checkDiagnosticAudience(audience);
    if (!audienceCheck.valid) {
      return withheld(audienceCheck.errors[0].code, { kind });
    }
  }

  const retentionDays = bucket === "rich" ? RETENTION_DAYS.rich : RETENTION_DAYS.bundle;
  const bound = sizeBounds?.[kind] ?? DEFAULT_SIZE_BOUNDS_BYTES[kind];

  if (TEXT_KINDS.has(kind)) {
    const rawText = diagnostic?.text;
    if (typeof rawText !== "string" || rawText.length === 0) {
      return withheld("diagnostics.missing-content", { kind });
    }

    const { text: redacted, redactionCount } = redactSecretsInText(rawText);

    // The fail-safe gate: a scrub that still contains a secret-shaped
    // value after redaction is not "mostly clean" — it is a scrub failure,
    // and the artifact must be suppressed rather than partially uploaded.
    if (verify(redacted)) {
      return withheld("diagnostics.scrub-verification-failed", { kind });
    }

    const sizeBytes = byteLength(redacted);
    if (sizeBytes > bound) {
      // A partial/truncated upload could cut a redaction placeholder in
      // half and misrepresent what was scrubbed — suppress rather than
      // truncate silently.
      return withheld("diagnostics.size-bound-exceeded", { kind, sizeBytes, bound });
    }

    return {
      upload: true,
      artifact: { kind, text: redacted, sizeBytes, redactionCount, retentionDays, audience: bucket === "rich" ? audience : undefined },
    };
  }

  if (BINARY_KINDS.has(kind)) {
    if (diagnostic?.verifiedRedacted !== true) {
      // No OCR/image inspection exists in this deterministic core — a
      // screenshot's redaction can only be trusted when a caller asserts an
      // already-verified external pass. Absent that, fail closed.
      return withheld("diagnostics.binary-scrub-unverified", { kind });
    }
    const bytes = diagnostic.bytes;
    const sizeBytes =
      typeof bytes === "string" ? Buffer.byteLength(bytes, "base64") : bytes instanceof Uint8Array ? bytes.byteLength : undefined;
    if (typeof sizeBytes !== "number") {
      return withheld("diagnostics.missing-content", { kind });
    }
    if (sizeBytes > bound) {
      return withheld("diagnostics.size-bound-exceeded", { kind, sizeBytes, bound });
    }
    return {
      upload: true,
      artifact: { kind, bytes, sizeBytes, retentionDays, audience },
    };
  }

  return withheld("diagnostics.unknown-kind", { kind });
}

/**
 * Batch form: prepares every entry in `diagnostics` (an array of
 * `{ kind, diagnostic }`) and returns an EXACT manifest — never a glob or
 * wildcard path, mirroring github-actions-workflow.mjs's own
 * "junitPath must be an exact path" rule. `artifacts` lists only what
 * actually uploads (each with an explicit `path`, required and unique);
 * `withheld` lists everything suppressed, with its reason, so a caller can
 * both publish the exact list and audit what was withheld and why.
 */
export function buildDiagnosticsManifest(diagnostics, opts = {}) {
  const artifacts = [];
  const withheldEntries = [];

  for (const entry of diagnostics ?? []) {
    const { kind, diagnostic, path } = entry;
    if (typeof path !== "string" || path.trim() === "") {
      withheldEntries.push({ kind, reason: "diagnostics.missing-artifact-path", message: WITHHELD_MESSAGE });
      continue;
    }
    if (path.includes("*")) {
      withheldEntries.push({ kind, path, reason: "diagnostics.wildcard-artifact-path", message: WITHHELD_MESSAGE });
      continue;
    }
    const result = prepareDiagnosticForUpload(kind, diagnostic, opts);
    if (result.upload) {
      artifacts.push({ kind, path, sizeBytes: result.artifact.sizeBytes, retentionDays: result.artifact.retentionDays });
    } else {
      withheldEntries.push({ kind, path, reason: result.reason, message: result.message });
    }
  }

  return { artifacts, withheld: withheldEntries };
}
