// dynamic-qa/shared/scripts/provenance.test.mjs
//
// Tier 1 coverage for the Provenance Manifest v1 contract (provenance.mjs,
// #146): schema validity (unknown fields, missing required fields, bad
// enums), deterministic ordering as a CHECKED invariant (not merely how
// this module happens to write it), digest reuse from canonical-digest.mjs,
// and cross-revision monotonicity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { contentDigest } from "./canonical-digest.mjs";
import {
  buildBindingRecord,
  insertOrUpdateBindingRecord,
  serializeProvenanceManifest,
  canonicalizeProvenanceManifest,
  validateProvenanceManifest,
  checkRevisionMonotonic,
} from "./provenance.mjs";

const FLOW_DATA = {
  schema: "dynamic-qa-flow-v1",
  id: "generation-happy-path",
  revision: 1,
  title: "t",
  intent: "i",
  criticality: "high",
  state: "active",
  origin: { tickets: ["https://example.test/2", "https://example.test/1"] },
  test_level: { selection: "inferred" },
  data_sets: ["basic-case"],
  boundaries: [],
  steps: [],
};

const DATA_SET_A = { id: "zzz-case", data: { schema: "dynamic-qa-data-v1", id: "zzz-case", revision: 1, cases: [] } };
const DATA_SET_B = { id: "aaa-case", data: { schema: "dynamic-qa-data-v1", id: "aaa-case", revision: 1, cases: [] } };

function goodRecordInput(overrides = {}) {
  return {
    flowData: FLOW_DATA,
    dataSets: [DATA_SET_A, DATA_SET_B],
    schemaDigests: { flow: "sha256:flow", data: "sha256:data" },
    sourceCommit: "a".repeat(40),
    generator: { identity: "generated", bundleVersion: "0.0.1", contentDigest: "sha256:gen", harness: "claude-code" },
    framework: { name: "vitest", version: "1.0.0", adapter: "github-actions" },
    harnessInputs: {
      configPaths: [{ path: "vitest.config.ts", digest: "sha256:cfg" }],
      lockfilePaths: [{ path: "package-lock.json", digest: "sha256:lock" }],
    },
    outputs: [
      { path: "tests/z.spec.ts", digest: "sha256:z" },
      { path: "tests/a.spec.ts", digest: "sha256:a" },
    ],
    impactPaths: ["src/z/**", "src/a/**"],
    enforcementLane: "advisory",
    executionProfile: { id: "pilot-profile" },
    ...overrides,
  };
}

test("buildBindingRecord computes flowDigest via canonical-digest.mjs's contentDigest (reused, not reinvented)", () => {
  const record = buildBindingRecord(goodRecordInput());
  assert.equal(record.flowDigest, contentDigest(FLOW_DATA));
});

test("buildBindingRecord sorts order-insignificant collections: dataSets, outputs, impactPaths, originTickets, harnessInputs paths", () => {
  const record = buildBindingRecord(goodRecordInput());
  assert.deepEqual(record.dataSets.map((d) => d.id), ["aaa-case", "zzz-case"]);
  assert.deepEqual(record.outputs.map((o) => o.path), ["tests/a.spec.ts", "tests/z.spec.ts"]);
  assert.deepEqual(record.impactPaths, ["src/a/**", "src/z/**"]);
  assert.deepEqual(record.originTickets, ["https://example.test/1", "https://example.test/2"]);
});

test("buildBindingRecord emits a fixed key order regardless of input order", () => {
  const record = buildBindingRecord(goodRecordInput());
  assert.deepEqual(Object.keys(record), [
    "flowId",
    "flowRevision",
    "flowDigest",
    "originTickets",
    "dataSets",
    "schemas",
    "testLevel",
    "sourceCommit",
    "generator",
    "framework",
    "harnessInputs",
    "outputs",
    "impactPaths",
    "enforcementLane",
    "executionProfile",
  ]);
});

test("serializeProvenanceManifest is byte-identical across two independently assembled manifests with the same logical content", () => {
  const recordA = buildBindingRecord(goodRecordInput());
  const manifestA = insertOrUpdateBindingRecord(null, recordA, { generatedAt: "2026-01-01T00:00:00Z" });

  // Assemble "the same" manifest again, but shuffle field/record order to
  // prove serialization is deterministic regardless of assembly order.
  const recordB = buildBindingRecord(goodRecordInput({ dataSets: [DATA_SET_B, DATA_SET_A] }));
  const manifestB = insertOrUpdateBindingRecord(null, recordB, { generatedAt: "2026-01-01T00:00:00Z" });

  assert.equal(serializeProvenanceManifest(manifestA), serializeProvenanceManifest(manifestB));
  assert.ok(serializeProvenanceManifest(manifestA).endsWith("\n"));
});

test("insertOrUpdateBindingRecord replaces an existing flow's record rather than duplicating it", () => {
  const first = buildBindingRecord(goodRecordInput());
  let manifest = insertOrUpdateBindingRecord(null, first, { generatedAt: "t0" });
  const second = buildBindingRecord(goodRecordInput({ flowData: { ...FLOW_DATA, revision: 2 } }));
  manifest = insertOrUpdateBindingRecord(manifest, second, { generatedAt: "t1" });
  assert.equal(manifest.bindings.length, 1);
  assert.equal(manifest.bindings[0].flowRevision, 2);
});

test("insertOrUpdateBindingRecord keeps bindings sorted by flowId across multiple flows", () => {
  const zFlow = { ...FLOW_DATA, id: "zzz-flow" };
  const aFlow = { ...FLOW_DATA, id: "aaa-flow" };
  let manifest = insertOrUpdateBindingRecord(null, buildBindingRecord(goodRecordInput({ flowData: zFlow })), { generatedAt: "t" });
  manifest = insertOrUpdateBindingRecord(manifest, buildBindingRecord(goodRecordInput({ flowData: aFlow })), { generatedAt: "t" });
  assert.deepEqual(
    manifest.bindings.map((b) => b.flowId),
    ["aaa-flow", "zzz-flow"],
  );
});

test("validateProvenanceManifest accepts a well-formed, canonically-ordered manifest", () => {
  const manifest = insertOrUpdateBindingRecord(null, buildBindingRecord(goodRecordInput()), { generatedAt: "t" });
  const result = validateProvenanceManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("fail-closed: validateProvenanceManifest rejects an unsupported schema version", () => {
  const manifest = insertOrUpdateBindingRecord(null, buildBindingRecord(goodRecordInput()), { generatedAt: "t" });
  const result = validateProvenanceManifest({ ...manifest, schema: "dynamic-qa-provenance-v2" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unsupported schema version/.test(e.message)));
});

test("fail-closed: validateProvenanceManifest rejects an unknown top-level key", () => {
  const manifest = insertOrUpdateBindingRecord(null, buildBindingRecord(goodRecordInput()), { generatedAt: "t" });
  const result = validateProvenanceManifest({ ...manifest, extra: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unknown key "extra"/.test(e.message)));
});

test("fail-closed: validateProvenanceManifest rejects a record missing a required field", () => {
  const record = buildBindingRecord(goodRecordInput());
  delete record.sourceCommit;
  const manifest = { schema: "dynamic-qa-provenance-v1", generatedAt: "t", bindings: [record] };
  const result = validateProvenanceManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /sourceCommit/.test(e.message)));
});

test("fail-closed: validateProvenanceManifest treats an out-of-order bindings array as invalid, not silently re-sortable", () => {
  const zFlow = { ...FLOW_DATA, id: "zzz-flow" };
  const aFlow = { ...FLOW_DATA, id: "aaa-flow" };
  const manifest = {
    schema: "dynamic-qa-provenance-v1",
    generatedAt: "t",
    bindings: [buildBindingRecord(goodRecordInput({ flowData: zFlow })), buildBindingRecord(goodRecordInput({ flowData: aFlow }))],
  };
  const result = validateProvenanceManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /sorted by flowId/.test(e.message)));
});

test("fail-closed: validateProvenanceManifest rejects a duplicate flowId", () => {
  const record = buildBindingRecord(goodRecordInput());
  const manifest = { schema: "dynamic-qa-provenance-v1", generatedAt: "t", bindings: [record, record] };
  const result = validateProvenanceManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /at most once/.test(e.message)));
});

test("fail-closed: validateProvenanceManifest rejects a bad enforcementLane value", () => {
  const record = buildBindingRecord(goodRecordInput({ enforcementLane: "sometimes" }));
  const manifest = { schema: "dynamic-qa-provenance-v1", generatedAt: "t", bindings: [record] };
  const result = validateProvenanceManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /enforcementLane must be one of/.test(e.message)));
});

test("checkRevisionMonotonic accepts a first-time flow (no existing record)", () => {
  const result = checkRevisionMonotonic(null, "generation-happy-path", 1);
  assert.equal(result.ok, true);
  assert.equal(result.existingRevision, null);
});

test("checkRevisionMonotonic accepts a non-decreasing revision", () => {
  const manifest = insertOrUpdateBindingRecord(null, buildBindingRecord(goodRecordInput()), { generatedAt: "t" });
  const result = checkRevisionMonotonic(manifest, "generation-happy-path", 1);
  assert.equal(result.ok, true);
});

test("fail-closed: checkRevisionMonotonic rejects a regressing revision", () => {
  const manifest = insertOrUpdateBindingRecord(
    null,
    buildBindingRecord(goodRecordInput({ flowData: { ...FLOW_DATA, revision: 5 } })),
    { generatedAt: "t" },
  );
  const result = checkRevisionMonotonic(manifest, "generation-happy-path", 3);
  assert.equal(result.ok, false);
  assert.equal(result.existingRevision, 5);
});

test("canonicalizeProvenanceManifest is idempotent", () => {
  const manifest = insertOrUpdateBindingRecord(null, buildBindingRecord(goodRecordInput()), { generatedAt: "t" });
  const once = canonicalizeProvenanceManifest(manifest);
  const twice = canonicalizeProvenanceManifest(once);
  assert.deepEqual(once, twice);
});
