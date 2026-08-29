// dynamic-qa/shared/scripts/preflight.test.mjs
//
// Tier 1 coverage for the generation preflight gate (preflight.mjs, #146).
// One case per precondition in the ticket's own listed order: contract,
// lifecycle, approvals, safety, source identity, harness, provenance — each
// proven to fail closed with its own exact reason code, plus the full
// happy-path acceptance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runGenerationPreflight } from "./preflight.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "generation");
const DATA_SETS_DIR = path.join(FIXTURES, "data");
const EXECUTION_PROFILES_DIR = path.join(FIXTURES, "execution-profiles");

const VALID_SOURCE_COMMIT = "a".repeat(40);
const GOOD_APPROVALS = { qaOwner: true, technicalOwner: true };
const GOOD_HARNESS = { framework: "vitest", testDir: "tests/e2e", command: "npm test" };

// A Capability Gate environment that fully matches
// fixtures/generation/execution-profiles/pilot-profile.yaml — mirrors
// capability-gate.test.mjs's own passingEnvironment() shape.
const PASSING_ENVIRONMENT_EVIDENCE = {
  paths: { enforcedRead: ["/repo"], enforcedWrite: ["/repo/tmp"] },
  commands: { enforced: ["npm test"] },
  environments: { runnerClass: "github-hosted-ubuntu", disposable: true, sandbox: "vm" },
  resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
  identities: { active: ["ci-bot"] },
  network: { mode: "none" },
  effects: { enforcedBoundaryIds: ["vibesync-cli"], namespaceIsolation: true, cleanupCapability: true },
  evidence: [{ capability: "runtime.node-available", status: "met" }],
};

function readFixture(relPath) {
  return readFileSync(path.join(FIXTURES, relPath), "utf8");
}

function goodInput(overrides = {}) {
  return {
    flowSource: readFixture("flow-active.yaml"),
    flowFilename: "generation-happy-path",
    dataSetsDir: DATA_SETS_DIR,
    approvals: GOOD_APPROVALS,
    executionProfileId: "pilot-profile",
    executionProfilesDir: EXECUTION_PROFILES_DIR,
    environmentEvidence: PASSING_ENVIRONMENT_EVIDENCE,
    sourceCommit: VALID_SOURCE_COMMIT,
    harness: GOOD_HARNESS,
    existingProvenanceManifest: null,
    ...overrides,
  };
}

test("preflight accepts a fully approved, policy-compliant, active flow", () => {
  const result = runGenerationPreflight(goodInput());
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(result.flowData.id, "generation-happy-path");
  assert.equal(result.dataSets.length, 1);
  assert.equal(result.dataSets[0].id, "generation-basic-case");
  assert.equal(result.dataSets[0].data.id, "generation-basic-case");
});

test("fail-closed: contract — an invalid Flow Definition is refused with invalid-flow-contract", () => {
  const result = runGenerationPreflight(
    goodInput({ flowSource: readFixture("flow-active.yaml").replace("schema: dynamic-qa-flow-v1", "schema: dynamic-qa-flow-v2") }),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "invalid-flow-contract");
  assert.ok(result.issues.length > 0);
});

test("fail-closed: lifecycle — a draft flow is refused with flow-not-active", () => {
  const result = runGenerationPreflight(
    goodInput({ flowSource: readFixture("invalid/flow-state-draft.yaml"), flowFilename: "flow-state-draft" }),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "flow-not-active");
});

test("fail-closed: lifecycle — a deferred flow is refused with flow-not-active", () => {
  const result = runGenerationPreflight(
    goodInput({ flowSource: readFixture("invalid/flow-state-deferred.yaml"), flowFilename: "flow-state-deferred" }),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "flow-not-active");
});

test("fail-closed: lifecycle — a retired flow is refused with flow-not-active", () => {
  const result = runGenerationPreflight(
    goodInput({ flowSource: readFixture("invalid/flow-state-retired.yaml"), flowFilename: "flow-state-retired" }),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "flow-not-active");
});

test("fail-closed: approvals — missing QA Owner approval is refused with missing-qa-owner-approval", () => {
  const result = runGenerationPreflight(goodInput({ approvals: { qaOwner: false, technicalOwner: true } }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-qa-owner-approval");
});

test("fail-closed: approvals — missing Technical Owner approval is refused with missing-technical-owner-approval", () => {
  const result = runGenerationPreflight(goodInput({ approvals: { qaOwner: true, technicalOwner: false } }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-technical-owner-approval");
});

test("fail-closed: approvals — no approvals object at all is refused with missing-qa-owner-approval", () => {
  const result = runGenerationPreflight(goodInput({ approvals: undefined }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-qa-owner-approval");
});

test("fail-closed: safety — a flow with no boundary declaring role: owned is refused with boundary-policy-violation", () => {
  const result = runGenerationPreflight(
    goodInput({ flowSource: readFixture("invalid/flow-boundary-violation.yaml"), flowFilename: "flow-boundary-violation" }),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "boundary-policy-violation");
});

test("fail-closed: safety — a dangling data_sets reference is refused with invalid-data-sets", () => {
  const result = runGenerationPreflight(goodInput({ dataSetsDir: path.join(FIXTURES, "does-not-exist") }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "invalid-data-sets");
});

test("fail-closed: safety — a missing Execution Profile id is refused with missing-execution-profile-id", () => {
  const result = runGenerationPreflight(goodInput({ executionProfileId: undefined }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-execution-profile-id");
});

test("fail-closed: safety — an Execution Profile id that does not resolve to a real file is refused with invalid-execution-profile", () => {
  const result = runGenerationPreflight(goodInput({ executionProfileId: "does-not-exist" }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "invalid-execution-profile");
});

test("fail-closed: safety — no executionProfilesDir at all is refused with invalid-execution-profile", () => {
  const result = runGenerationPreflight(goodInput({ executionProfilesDir: undefined }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "invalid-execution-profile");
});

test("fail-closed: safety — a malformed Execution Profile document is refused with invalid-execution-profile", () => {
  const badProfilesDir = path.join(FIXTURES, "does-not-exist-profiles-dir");
  const result = runGenerationPreflight(goodInput({ executionProfilesDir: badProfilesDir }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "invalid-execution-profile");
});

test("fail-closed: safety — an Execution Profile that does not honour the flow's boundaries is refused with execution-profile-boundary-mismatch", () => {
  const result = runGenerationPreflight(
    goodInput({
      executionProfileId: "pilot-profile-no-boundary",
      environmentEvidence: { ...PASSING_ENVIRONMENT_EVIDENCE, effects: { enforcedBoundaryIds: [] } },
    }),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "execution-profile-boundary-mismatch");
});

test("fail-closed: safety — no environment evidence at all is refused with missing-environment-evidence, never silently skipped", () => {
  const result = runGenerationPreflight(goodInput({ environmentEvidence: undefined }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-environment-evidence");
});

test("fail-closed: safety — environment evidence that does not satisfy the Capability Gate is refused with execution-profile-capability-blocked, naming the exact blocker", () => {
  const result = runGenerationPreflight(
    goodInput({ environmentEvidence: { ...PASSING_ENVIRONMENT_EVIDENCE, network: { mode: "exact-allowlist" } } }),
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, "execution-profile-capability-blocked");
  assert.ok(result.issues.length > 0);
});

test("fail-closed: safety — an empty environment evidence object fails every Capability Gate category rather than being treated as not-applicable", () => {
  const result = runGenerationPreflight(goodInput({ environmentEvidence: {} }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "execution-profile-capability-blocked");
  assert.ok(result.issues.length >= 5);
});

test("fail-closed: source identity — a missing source commit is refused with missing-source-commit", () => {
  const result = runGenerationPreflight(goodInput({ sourceCommit: undefined }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-source-commit");
});

test("fail-closed: source identity — a short/invalid commit SHA is refused with missing-source-commit", () => {
  const result = runGenerationPreflight(goodInput({ sourceCommit: "abc123" }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-source-commit");
});

test("fail-closed: harness — a missing harness descriptor is refused with missing-harness-descriptor", () => {
  const result = runGenerationPreflight(goodInput({ harness: undefined }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-harness-descriptor");
});

test("fail-closed: harness — an incomplete harness descriptor is refused with missing-harness-descriptor", () => {
  const result = runGenerationPreflight(goodInput({ harness: { framework: "vitest", testDir: "", command: "npm test" } }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing-harness-descriptor");
});

test("fail-closed: provenance — a malformed existing provenance manifest is refused with invalid-existing-provenance", () => {
  const result = runGenerationPreflight(goodInput({ existingProvenanceManifest: { schema: "dynamic-qa-provenance-v1" } }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "invalid-existing-provenance");
});

test("fail-closed: provenance — a revision regression against existing provenance is refused with revision-not-monotonic", () => {
  const existingManifest = {
    schema: "dynamic-qa-provenance-v1",
    generatedAt: "2026-01-01T00:00:00Z",
    bindings: [
      {
        flowId: "generation-happy-path",
        flowRevision: 5,
        flowDigest: "sha256:deadbeef",
        originTickets: ["https://example.test/1"],
        dataSets: [],
        schemas: { flow: "sha256:a", data: "sha256:b" },
        testLevel: { selection: "inferred" },
        sourceCommit: VALID_SOURCE_COMMIT,
        generator: { identity: "generated", bundleVersion: "0.0.1", contentDigest: "sha256:c", harness: "claude-code" },
        framework: { name: "vitest", version: "1.0.0" },
        harnessInputs: { configPaths: [], lockfilePaths: [] },
        outputs: [{ path: "tests/x.spec.ts", digest: "sha256:d" }],
        impactPaths: [],
        enforcementLane: "advisory",
        executionProfile: { id: "pilot-profile" },
      },
    ],
  };
  const result = runGenerationPreflight(goodInput({ existingProvenanceManifest: existingManifest }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "revision-not-monotonic");
});
