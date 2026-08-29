// dynamic-qa/shared/scripts/result-envelope.mjs
//
// Defines the Result Envelope v1 contract (ticket #153,
// shared/schemas/dynamic-qa-result-envelope-v1.schema.json,
// DESIGN-dynamic-qa-spec.md §5.6, trust-zones.mjs's landed-#151 note: "No
// Result Envelope schema exists yet. #153/#155/#170 should define it and
// keep checkPrivilegedLaneArtifact as the gate.") The privileged-publication
// Trust Zone (trust-zones.mjs, #151) accepts only an artifact of kind
// "result-envelope" or "recompute" — never generated code, a cache, a path,
// a command, or a URL. This module is what "result-envelope" actually means
// once accepted: small, non-executable, schema-validated, size-bounded, and
// tied to repository, source SHA, workflow/run, and artifact digest, per
// spec §5.6 exactly.
//
// "Non-executable" is enforced structurally, not by scanning for dangerous
// substrings: every field is a closed schema of strings/enums/integers with
// no free-form script, command, path, or URL-as-instruction field defined at
// all (assertKnownKeys below is fail-closed, exactly like every other
// validator in this bundle). There is nothing in this shape a privileged
// lane could "run".
//
// Follows execution-profile.mjs's established pattern: an Issues collector
// that reports every violation rather than stopping at the first, and never
// throws for an ordinary shape violation.

import { checkPrivilegedLaneArtifact } from "./trust-zones.mjs";

export const SUPPORTED_SCHEMA = "dynamic-qa-result-envelope-v1";

// "Size-bounded": the whole envelope, serialized, must never exceed this —
// deliberately small (16 KiB), because it is a summary of a run's outcome,
// never the run's JUnit body or logs. `bindings` is independently bounded to
// MAX_BINDINGS entries so the size bound is a structural property of the
// contract, not solely a runtime byte-count check.
export const MAX_ENVELOPE_BYTES = 16384;
export const MAX_BINDINGS = 50;

const VERDICTS = new Set(["pass", "fail"]);
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function pathStr(path) {
  if (!path || path.length === 0) return "$";
  let out = "$";
  for (const segment of path) out += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  return out;
}

class Issues {
  constructor() {
    this.list = [];
  }
  add(path, message) {
    this.list.push({ path, message: `${message} (at ${pathStr(path)})` });
  }
}

function assertKnownKeys(obj, allowed, path, issues) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) issues.add([...path, key], `unknown key ${JSON.stringify(key)}`);
  }
}

function validateWorkflow(workflow, path, issues) {
  if (!isPlainObject(workflow)) {
    issues.add(path, "workflow must be a mapping");
    return;
  }
  assertKnownKeys(workflow, new Set(["provider", "workflowFile", "runId", "runAttempt", "url"]), path, issues);
  if (workflow.provider !== "github-actions") {
    issues.add([...path, "provider"], 'provider must be a named, tested adapter identity — only "github-actions" exists today');
  }
  if (!nonEmptyString(workflow.workflowFile)) issues.add([...path, "workflowFile"], "workflowFile must be a non-empty string");
  if (!nonEmptyString(workflow.runId)) issues.add([...path, "runId"], "runId must be a non-empty string");
  if (!nonEmptyString(workflow.runAttempt)) issues.add([...path, "runAttempt"], "runAttempt must be a non-empty string");
  if ("url" in workflow && typeof workflow.url !== "string") issues.add([...path, "url"], "url must be a string when present");
}

function validateBindings(bindings, path, issues) {
  if (!Array.isArray(bindings)) {
    issues.add(path, "bindings must be a list");
    return;
  }
  if (bindings.length > MAX_BINDINGS) {
    issues.add(path, `bindings must not exceed ${MAX_BINDINGS} entries (got ${bindings.length}) — the envelope is a summary, never a full report`);
  }
  bindings.forEach((entry, i) => {
    const entryPath = [...path, i];
    if (!isPlainObject(entry)) {
      issues.add(entryPath, "each binding entry must be a mapping");
      return;
    }
    assertKnownKeys(entry, new Set(["flowId", "flowRevision", "verdict", "junitDigest"]), entryPath, issues);
    if (!nonEmptyString(entry.flowId)) issues.add([...entryPath, "flowId"], "flowId must be a non-empty string");
    if (!(Number.isInteger(entry.flowRevision) && entry.flowRevision >= 1)) {
      issues.add([...entryPath, "flowRevision"], "flowRevision must be an integer >= 1");
    }
    if (!VERDICTS.has(entry.verdict)) issues.add([...entryPath, "verdict"], 'verdict must be "pass" or "fail"');
    if (!SHA256_DIGEST_RE.test(entry.junitDigest ?? "")) {
      issues.add([...entryPath, "junitDigest"], 'junitDigest must be a "sha256:<64-hex>" content digest');
    }
  });
}

/**
 * Validates an already-parsed Result Envelope JS value against the v1
 * contract. Returns { valid, errors }; never throws for an ordinary shape
 * violation. Does not check byte size — see checkResultEnvelopeSize, kept
 * separate so a caller can check shape and size independently (a
 * shape-valid envelope can still be rejected purely for being oversized).
 */
export function validateResultEnvelope(data) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Result Envelope must be a mapping");
    return { valid: false, errors: issues.list };
  }

  assertKnownKeys(
    data,
    new Set(["schema", "repository", "sourceCommit", "generatedAt", "workflow", "verdict", "bindings", "artifactDigest"]),
    [],
    issues,
  );

  if (data.schema !== SUPPORTED_SCHEMA) {
    issues.add(["schema"], `unsupported schema version ${JSON.stringify(data.schema)} — this validator only accepts ${JSON.stringify(SUPPORTED_SCHEMA)}`);
  }
  if (!REPOSITORY_RE.test(data.repository ?? "")) {
    issues.add(["repository"], 'repository must be an exact "owner/name" string');
  }
  if (!FULL_SHA_RE.test(data.sourceCommit ?? "")) {
    issues.add(["sourceCommit"], "sourceCommit must be a full 40-character commit SHA, never a branch name or short SHA");
  }
  if (!nonEmptyString(data.generatedAt) || Number.isNaN(Date.parse(data.generatedAt))) {
    issues.add(["generatedAt"], "generatedAt must be a parseable ISO-8601 timestamp");
  }
  validateWorkflow(data.workflow, ["workflow"], issues);
  if (!VERDICTS.has(data.verdict)) issues.add(["verdict"], 'verdict must be "pass" or "fail"');
  validateBindings(data.bindings, ["bindings"], issues);
  if (!SHA256_DIGEST_RE.test(data.artifactDigest ?? "")) {
    issues.add(["artifactDigest"], 'artifactDigest must be a "sha256:<64-hex>" content digest');
  }

  return { valid: issues.list.length === 0, errors: issues.list };
}

/**
 * The size-bound half of "small, size-bounded". Checks the serialized byte
 * length of `raw` (the exact text a privileged lane would read) against
 * MAX_ENVELOPE_BYTES. Kept as its own function, independent of schema shape
 * validity, per the spec's "small ... size-bounded" phrasing naming two
 * distinct properties.
 */
export function checkResultEnvelopeSize(raw) {
  const bytes = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw), "utf8");
  if (bytes > MAX_ENVELOPE_BYTES) {
    return {
      valid: false,
      errors: [{ path: [], message: `Result Envelope is ${bytes} bytes, exceeding the ${MAX_ENVELOPE_BYTES}-byte bound (at $)` }],
    };
  }
  return { valid: true, errors: [] };
}

/**
 * The single function a privileged-publication caller should use to accept
 * an artifact claiming to be a Result Envelope. Composes, in order:
 *
 *   1. trust-zones.mjs's checkPrivilegedLaneArtifact(zone, artifact) — the
 *      sole Trust Zone gate (#151), reused here rather than duplicated.
 *      Rejects outright unless zone === "privileged-publication" implies
 *      "not constrained" (every other zone), or the artifact kind is
 *      exactly "result-envelope" (or "recompute", which this function does
 *      not further validate — a recompute is not an envelope).
 *   2. When kind is "result-envelope": validateResultEnvelope(artifact.envelope)
 *      and checkResultEnvelopeSize(raw ?? artifact.envelope) — both must
 *      pass.
 *
 * Returns { valid, errors } combining every stage's errors. Fail-closed:
 * any stage failing means the whole result is invalid, and this function
 * never partially trusts an envelope that failed one check but not another.
 */
export function validatePrivilegedResultEnvelopeArtifact(zone, artifact, raw) {
  const zoneCheck = checkPrivilegedLaneArtifact(zone, artifact);
  if (!zoneCheck.valid) {
    return { valid: false, errors: zoneCheck.errors.map((e) => ({ path: [], message: e.message })) };
  }
  if (!isPlainObject(artifact) || artifact.kind !== "result-envelope") {
    // Either not a constrained zone, or a "recompute" artifact — nothing
    // further for this module (which only knows about envelopes) to check.
    return { valid: true, errors: [] };
  }
  const shapeCheck = validateResultEnvelope(artifact.envelope);
  const sizeCheck = checkResultEnvelopeSize(raw ?? artifact.envelope);
  return {
    valid: shapeCheck.valid && sizeCheck.valid,
    errors: [...shapeCheck.errors, ...sizeCheck.errors],
  };
}
