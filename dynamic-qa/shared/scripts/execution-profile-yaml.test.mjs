// dynamic-qa/shared/scripts/execution-profile-yaml.test.mjs
//
// Tier 1 tests for the Execution Profile YAML authoring/rendering surface
// (ticket #166), the seam #150 explicitly left unbuilt. Proves the round
// trip and that this module adds no second rendering or parsing path: it
// reuses flow-yaml.mjs's renderer and restricted-yaml.mjs's parser.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderExecutionProfileYAML, renderValidatedExecutionProfileYAML, parseExecutionProfileYAML } from "./execution-profile-yaml.mjs";
import { renderRestrictedYAMLDocument } from "./flow-yaml.mjs";
import { validateExecutionProfile, SUPPORTED_SCHEMA } from "./execution-profile.mjs";

function baseProfile(overrides = {}) {
  return {
    schema: SUPPORTED_SCHEMA,
    id: "pilot-safe-profile",
    revision: 1,
    owners: { qaOwner: "Per", technicalOwner: "Alex" },
    allowedPhases: ["candidate-verification", "pr"],
    allowedTestLevels: ["cli"],
    environments: {
      runnerClass: "github-hosted-macos",
      disposable: true,
      disposabilityEvidence: "fresh VM per job, destroyed after",
      sandbox: "vm",
    },
    paths: { allowedRead: ["/repo"], allowedWrite: ["/repo/tmp"] },
    commands: { allowed: ["cargo test --test cli"] },
    resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
    identities: {
      approvedNonProduction: ["ci-bot"],
      denyProduction: ["prod-service-account"],
      denyMetadata: ["169.254.169.254"],
    },
    network: { mode: "none" },
    effects: {
      allowedBoundaryIds: ["filesystem-state"],
      reversibleSideEffects: true,
      namespace: "run-${case.id}",
      cleanup: "rm -rf the per-run temp tree",
    },
    credentials: {},
    diagnostics: {
      classes: [],
      captureConditions: ["failure-only"],
      scrubber: "redact-secrets",
      maxSizeMb: 5,
      audience: "qa-owner",
      retentionDays: 7,
    },
    evidence: {
      adapter: "github-actions",
      capabilities: [{ capability: "environments.disposable", category: "environments" }],
    },
    ...overrides,
  };
}

test("renderExecutionProfileYAML uses the same one rendering path as flow-yaml.mjs", () => {
  const profile = baseProfile();
  assert.equal(renderExecutionProfileYAML(profile), renderRestrictedYAMLDocument(profile));
});

test("a valid profile round-trips through render -> parse -> validate", () => {
  const profile = baseProfile();
  const yaml = renderExecutionProfileYAML(profile);
  const result = parseExecutionProfileYAML(yaml, { filename: "pilot-safe-profile.yaml", expectedId: "pilot-safe-profile" });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.data, profile);
});

test("renderValidatedExecutionProfileYAML never renders an invalid profile", () => {
  const invalid = baseProfile({ network: { mode: "not-a-real-mode" } });
  const result = renderValidatedExecutionProfileYAML(invalid, { expectedId: invalid.id });
  assert.equal(result.valid, false);
  assert.equal(result.yaml, null);
});

test("parseExecutionProfileYAML fails closed on hostile YAML (an alias)", () => {
  const hostile = "schema: &anchor \"dynamic-qa-execution-profile-v1\"\nid: *anchor\n";
  assert.throws(() => parseExecutionProfileYAML(hostile));
});

test("validateExecutionProfile still governs correctness independently of the renderer", () => {
  const profile = baseProfile();
  const { valid } = validateExecutionProfile(profile, { expectedId: profile.id });
  assert.equal(valid, true);
});
