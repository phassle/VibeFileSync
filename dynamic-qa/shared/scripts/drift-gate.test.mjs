// dynamic-qa/shared/scripts/drift-gate.test.mjs
//
// Tier 1 tests for the deterministic drift gate (#148). One test per rule
// from SPEC-135.md user stories 55-57 and DESIGN-dynamic-qa-spec.md §8,
// plus a couple of adjacent cases (revision regression reuse, missing
// output, retired-flow cleanup) that the same module is responsible for.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBindingDrift, evaluatePortfolioDrift, FRESHNESS_STATES } from "./drift-gate.mjs";

const FLOW_ID = "checkout-completes";

function baseRecord(overrides = {}) {
  return {
    flowId: FLOW_ID,
    flowRevision: 3,
    flowDigest: "sha256:flow-aaa",
    originTickets: ["https://example.test/issues/1"],
    dataSets: [{ id: "checkout-happy-path", digest: "sha256:data-aaa" }],
    schemas: { flow: "sha256:schema-flow-v1", data: "sha256:schema-data-v1" },
    testLevel: { selection: "api" },
    sourceCommit: "a".repeat(40),
    generator: { identity: "generated", bundleVersion: "1.2.0", contentDigest: "sha256:bundle-aaa", harness: "claude-code" },
    framework: { name: "node:test", version: "20" },
    harnessInputs: {
      configPaths: [{ path: "package.json", digest: "sha256:config-aaa" }],
      lockfilePaths: [{ path: "package-lock.json", digest: "sha256:lock-aaa" }],
    },
    outputs: [{ path: "tests/checkout.test.mjs", digest: "sha256:output-aaa" }],
    impactPaths: ["src/checkout/"],
    enforcementLane: "advisory",
    executionProfile: { id: "default-profile", digest: "sha256:profile-aaa" },
    ...overrides,
  };
}

function baseManifest(record = baseRecord()) {
  return { schema: "dynamic-qa-provenance-v1", generatedAt: "2026-01-01T00:00:00.000Z", bindings: [record] };
}

// Every "current" input matching the record exactly, so a test only needs
// to override the one thing it wants to drift.
function currentInputsFor(record) {
  return {
    flowId: record.flowId,
    flowRevision: record.flowRevision,
    manifest: baseManifest(record),
    flowDigest: record.flowDigest,
    dataSetDigests: record.dataSets.map((d) => ({ id: d.id, digest: d.digest })),
    schemaDigests: { flow: record.schemas.flow, data: record.schemas.data },
    harnessInputDigests: {
      configPaths: record.harnessInputs.configPaths.map((p) => ({ ...p })),
      lockfilePaths: record.harnessInputs.lockfilePaths.map((p) => ({ ...p })),
    },
    outputDigests: record.outputs.map((o) => ({ ...o })),
    executionProfileDigest: record.executionProfile.digest,
  };
}

test("an active Binding without current provenance fails the gate with an exact reason", () => {
  const result = evaluateBindingDrift({
    flowId: FLOW_ID,
    flowRevision: 1,
    manifest: baseManifest({ ...baseRecord(), flowId: "some-other-flow" }),
    flowDigest: "sha256:whatever",
  });
  assert.equal(result.freshness, "absent");
  assert.ok(FRESHNESS_STATES.includes(result.freshness));
  assert.equal(result.reasons.length, 1);
  assert.equal(result.reasons[0].code, "MISSING_PROVENANCE");
  assert.match(result.reasons[0].message, /no current Provenance Manifest record/);
});

test("a change to a file outside the Binding's recorded impact paths does not mark it stale", () => {
  const record = baseRecord();
  // Nothing about an unrelated product-code file appears anywhere in the
  // inputs this gate compares — there is no digest for it to feed in. This
  // proves the "unrelated change is not drift" rule structurally: the test
  // simulates an unrelated product change simply by NOT touching any of the
  // record's own recorded inputs, and the gate reports current.
  const result = evaluateBindingDrift(currentInputsFor(record));
  assert.equal(result.freshness, "current");
  assert.equal(result.edited, false);
  assert.deepEqual(result.reasons, []);
});

test("a change within a recorded impact path (a recorded data set) does mark it stale", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  inputs.dataSetDigests = [{ id: "checkout-happy-path", digest: "sha256:data-bbb-changed" }];
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "DATA_SET_MISMATCH"));
});

test("a new bundle version alone does not mark existing Bindings stale", () => {
  // generator.bundleVersion is never read or compared by evaluateBindingDrift
  // at all — bumping it, with every recorded input otherwise unchanged, must
  // produce zero drift.
  const record = baseRecord({
    generator: { identity: "generated", bundleVersion: "9.9.9", contentDigest: "sha256:bundle-new", harness: "claude-code" },
  });
  const result = evaluateBindingDrift(currentInputsFor(record));
  assert.equal(result.freshness, "current");
  assert.deepEqual(result.reasons, []);
});

test("an incompatible schema version mandates regeneration", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  // The customer's installed qa/schemas/dynamic-qa-flow-v1.schema.json
  // content actually changed (not just reformatted) since generation.
  inputs.schemaDigests = { flow: "sha256:schema-flow-v2-incompatible", data: record.schemas.data };
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "SCHEMA_CONTRACT_CHANGED"));
});

test("a hand-edited Binding is detected and reported as edited rather than silently accepted or overwritten", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  inputs.outputDigests = [{ path: "tests/checkout.test.mjs", digest: "sha256:output-hand-edited" }];
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.equal(result.edited, true);
  assert.deepEqual(result.editedOutputs, ["tests/checkout.test.mjs"]);
  const editReason = result.reasons.find((r) => r.code === "OUTPUT_EDITED");
  assert.ok(editReason, "expected an OUTPUT_EDITED reason, not a generic rejection");
  assert.match(editReason.message, /hand-edited/);
  assert.doesNotMatch(editReason.message, /\brejected\b/);
});

test("a recorded output that goes missing is reported distinctly from an edit", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  inputs.outputDigests = [];
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.equal(result.edited, false);
  assert.ok(result.reasons.some((r) => r.code === "OUTPUT_MISSING"));
});

test("revision regression is rejected by reusing provenance.mjs's checkRevisionMonotonic", () => {
  const record = baseRecord({ flowRevision: 5 });
  const inputs = currentInputsFor(record);
  inputs.flowRevision = 4; // regresses the recorded revision 5
  inputs.flowDigest = record.flowDigest; // hold everything else steady
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "REVISION_REGRESSION"));
});

test("an unsupported adapter/framework contract is reported when a support predicate is supplied", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  inputs.isFrameworkSupported = () => false;
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "ADAPTER_CONTRACT_UNSUPPORTED"));
});

test("omitting the adapter support predicate skips that check entirely", () => {
  const record = baseRecord();
  const result = evaluateBindingDrift(currentInputsFor(record));
  assert.equal(result.freshness, "current");
});

test("evaluatePortfolioDrift flags a retired flow that still carries a provenance record", () => {
  const activeRecord = baseRecord();
  const retiredRecord = baseRecord({ flowId: "old-onboarding-flow" });
  const manifest = { schema: "dynamic-qa-provenance-v1", generatedAt: "2026-01-01T00:00:00.000Z", bindings: [activeRecord, retiredRecord] };

  const activeInputs = currentInputsFor(activeRecord);
  activeInputs.manifest = manifest;

  const result = evaluatePortfolioDrift({
    manifest,
    bindings: [activeInputs],
    retiredFlowIds: ["old-onboarding-flow"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].freshness, "current");
  assert.equal(result.retiredCleanup.length, 1);
  assert.equal(result.retiredCleanup[0].flowId, "old-onboarding-flow");
  assert.equal(result.retiredCleanup[0].code, "RETIRED_FLOW_PROVENANCE");
});

// --- an undefined current digest must never compare equal or silently
// pass — the gate must fail closed with a named reason (finding: digest
// helpers feeding `undefined` into evaluateBindingDrift must not slip
// through as "nothing to check"). ---------------------------------------

test("an unrecomputable current flowDigest (undefined) fails closed, never treated as a match", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  inputs.flowDigest = undefined;
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "FLOW_DIGEST_MISMATCH"));
});

test("an unrecomputable current schemaDigests.flow (undefined) fails closed", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  inputs.schemaDigests = { flow: undefined, data: record.schemas.data };
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "SCHEMA_CONTRACT_CHANGED"));
});

test("an unrecomputable current schemaDigests.data (undefined) fails closed", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  inputs.schemaDigests = { flow: record.schemas.flow, data: undefined };
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "SCHEMA_CONTRACT_CHANGED"));
});

test("omitting schemaDigests entirely fails closed rather than defaulting to current", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  delete inputs.schemaDigests;
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "SCHEMA_CONTRACT_CHANGED"));
});

test("an unrecomputable current executionProfileDigest fails closed once a digest has been recorded", () => {
  const record = baseRecord();
  const inputs = currentInputsFor(record);
  inputs.executionProfileDigest = undefined;
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "stale");
  assert.ok(result.reasons.some((r) => r.code === "EXECUTION_PROFILE_CHANGED"));
});

test("a record that never recorded an executionProfile digest is not flagged when current is undefined (nothing to compare yet)", () => {
  const record = baseRecord({ executionProfile: { id: "default-profile" } });
  const inputs = currentInputsFor(record);
  inputs.executionProfileDigest = undefined;
  const result = evaluateBindingDrift(inputs);
  assert.equal(result.freshness, "current");
  assert.deepEqual(result.reasons, []);
});

test("evaluatePortfolioDrift is ok when every active Binding is current and nothing retired remains", () => {
  const record = baseRecord();
  const manifest = baseManifest(record);
  const inputs = currentInputsFor(record);
  inputs.manifest = manifest;
  const result = evaluatePortfolioDrift({ manifest, bindings: [inputs], retiredFlowIds: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.retiredCleanup, []);
});
