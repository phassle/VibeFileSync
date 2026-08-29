// dynamic-qa/shared/scripts/result-envelope.test.mjs
//
// Tier 1 coverage for the Result Envelope v1 contract (#153): schema-shape
// fail-closed cases, the independent size bound, and the composed
// privileged-lane acceptance function that reuses trust-zones.mjs's
// checkPrivilegedLaneArtifact as the sole gate rather than duplicating it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateResultEnvelope,
  checkResultEnvelopeSize,
  validatePrivilegedResultEnvelopeArtifact,
  SUPPORTED_SCHEMA,
  MAX_ENVELOPE_BYTES,
  MAX_BINDINGS,
} from "./result-envelope.mjs";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function baseEnvelope(overrides = {}) {
  return {
    schema: SUPPORTED_SCHEMA,
    repository: "phassle/VibeFileSync",
    sourceCommit: SHA,
    generatedAt: "2026-08-30T00:00:00Z",
    workflow: {
      provider: "github-actions",
      workflowFile: ".github/workflows/dynamic-qa.yml",
      runId: "12345",
      runAttempt: "1",
    },
    verdict: "pass",
    bindings: [{ flowId: "generation-happy-path", flowRevision: 1, verdict: "pass", junitDigest: DIGEST }],
    artifactDigest: DIGEST,
    ...overrides,
  };
}

test("a fully-formed envelope validates", () => {
  const result = validateResultEnvelope(baseEnvelope());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("fail-closed: unknown top-level key is refused", () => {
  const result = validateResultEnvelope({ ...baseEnvelope(), extra: "nope" });
  assert.equal(result.valid, false);
});

test("fail-closed: unsupported schema version is refused", () => {
  const result = validateResultEnvelope(baseEnvelope({ schema: "dynamic-qa-result-envelope-v2" }));
  assert.equal(result.valid, false);
});

test("fail-closed: repository must be exact owner/name", () => {
  assert.equal(validateResultEnvelope(baseEnvelope({ repository: "not-a-repo-slug" })).valid, false);
});

test("fail-closed: sourceCommit must be a full 40-hex SHA, not a branch name", () => {
  assert.equal(validateResultEnvelope(baseEnvelope({ sourceCommit: "develop" })).valid, false);
  assert.equal(validateResultEnvelope(baseEnvelope({ sourceCommit: "abc123" })).valid, false);
});

test("fail-closed: workflow.provider must be a named adapter identity", () => {
  const result = validateResultEnvelope(baseEnvelope({ workflow: { ...baseEnvelope().workflow, provider: "generic-ci" } }));
  assert.equal(result.valid, false);
});

test("fail-closed: verdict must be pass or fail", () => {
  assert.equal(validateResultEnvelope(baseEnvelope({ verdict: "unknown" })).valid, false);
});

test("fail-closed: a binding entry with a non-digest junitDigest is refused", () => {
  const result = validateResultEnvelope(
    baseEnvelope({ bindings: [{ flowId: "x", flowRevision: 1, verdict: "pass", junitDigest: "not-a-digest" }] }),
  );
  assert.equal(result.valid, false);
});

test("fail-closed: bindings beyond the structural bound are refused", () => {
  const bindings = Array.from({ length: MAX_BINDINGS + 1 }, (_, i) => ({
    flowId: `flow-${i}`,
    flowRevision: 1,
    verdict: "pass",
    junitDigest: DIGEST,
  }));
  const result = validateResultEnvelope(baseEnvelope({ bindings }));
  assert.equal(result.valid, false);
});

test("fail-closed: artifactDigest must be a sha256 content digest", () => {
  assert.equal(validateResultEnvelope(baseEnvelope({ artifactDigest: "deadbeef" })).valid, false);
});

// --- size bound, independent of shape ------------------------------------

test("a small envelope passes the size bound", () => {
  const result = checkResultEnvelopeSize(baseEnvelope());
  assert.equal(result.valid, true);
});

test("fail-closed: an oversized envelope is refused purely on size, even though shape-valid", () => {
  const bindings = Array.from({ length: MAX_BINDINGS }, (_, i) => ({
    flowId: `flow-${i}-${"x".repeat(200)}`,
    flowRevision: 1,
    verdict: "pass",
    junitDigest: DIGEST,
  }));
  const oversized = baseEnvelope({ bindings });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") > MAX_ENVELOPE_BYTES);
  // Still schema-shape valid (well under MAX_BINDINGS, every field well-formed) —
  // proving size is checked independently of shape, not inferred from it.
  assert.equal(validateResultEnvelope(oversized).valid, true);
  assert.equal(checkResultEnvelopeSize(oversized).valid, false);
});

// --- composed privileged-lane acceptance ---------------------------------

test("privileged-publication zone accepts a valid result-envelope artifact", () => {
  const artifact = { kind: "result-envelope", envelope: baseEnvelope() };
  const result = validatePrivilegedResultEnvelopeArtifact("privileged-publication", artifact);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("privileged-publication zone refuses a result-envelope artifact with an invalid envelope payload", () => {
  const artifact = { kind: "result-envelope", envelope: baseEnvelope({ sourceCommit: "develop" }) };
  const result = validatePrivilegedResultEnvelopeArtifact("privileged-publication", artifact);
  assert.equal(result.valid, false);
});

test("privileged-publication zone refuses code even before this module's own checks run (reuses trust-zones.mjs, not duplicated)", () => {
  const result = validatePrivilegedResultEnvelopeArtifact("privileged-publication", { kind: "code" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.message.includes("never executes low-trust generated code")));
});

test("a recompute artifact is accepted by the zone gate and is not further constrained by this module", () => {
  const result = validatePrivilegedResultEnvelopeArtifact("privileged-publication", { kind: "recompute" });
  assert.equal(result.valid, true);
});

test("a non-privileged-publication zone is unconstrained regardless of artifact shape", () => {
  const result = validatePrivilegedResultEnvelopeArtifact("low-trust-ci", { kind: "code" });
  assert.equal(result.valid, true);
});
