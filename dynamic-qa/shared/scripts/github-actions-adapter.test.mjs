// dynamic-qa/shared/scripts/github-actions-adapter.test.mjs
//
// Tier 1 coverage for the GitHub Actions provider adapter (#153): the
// missing/unmet Node-runtime capability yields a Safety Blocker and a
// deferred flow (never a silent skip); a fully-evidenced profile plans and
// renders a hardened advisory lane; run-reference resolution is a pure
// function of a caller-supplied environment; and detection stays read-only.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectProviderConfiguration,
  deriveCapabilityEvidence,
  checkNodeRuntimeCapabilityDeclared,
  planAdvisoryPullRequestLane,
  resolveRunReference,
  checkGeneratedConfigEnforcesProfile,
  NODE_RUNTIME_CAPABILITY,
  SUPPORTED_TRIGGERS,
  PROVIDER_IDENTITY,
} from "./github-actions-adapter.mjs";
import { checkWorkflowHardening } from "./github-actions-workflow.mjs";

const RUNNER_CLASS = "ubuntu-latest";

function fullProfile(overrides = {}) {
  return {
    schema: "dynamic-qa-execution-profile-v1",
    id: "pilot-safe-profile",
    revision: 1,
    owners: { qaOwner: "Per", technicalOwner: "Alex" },
    allowedPhases: ["pr"],
    allowedTestLevels: ["cli"],
    environments: { runnerClass: RUNNER_CLASS, disposable: true, disposabilityEvidence: "fresh hosted VM per job", sandbox: "vm" },
    paths: { allowedRead: ["/repo"], allowedWrite: ["/repo/tmp"] },
    commands: { allowed: ["npm test"] },
    resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
    identities: { approvedNonProduction: [], denyProduction: ["prod-service-account"], denyMetadata: ["169.254.169.254"] },
    network: { mode: "none" },
    effects: { allowedBoundaryIds: ["vibesync-cli"], reversibleSideEffects: false },
    credentials: {},
    diagnostics: { classes: [], captureConditions: ["failure-only"], scrubber: "redact-secrets", maxSizeMb: 5, audience: "qa-owner", retentionDays: 7 },
    evidence: {
      adapter: "github-actions",
      capabilities: [{ capability: NODE_RUNTIME_CAPABILITY, category: "evidence" }],
    },
    ...overrides,
  };
}

function workflowConfig(overrides = {}) {
  return {
    runsOn: RUNNER_CLASS,
    nodeVersion: "20",
    testCommand: "npm test",
    junitPath: "reports/junit.xml",
    ...overrides,
  };
}

// --- point 1: read-only detection -----------------------------------------

test("detectProviderConfiguration is read-only and reports whether a dynamic-qa workflow already exists", () => {
  const result = detectProviderConfiguration(["acceptance.yml"]);
  assert.equal(result.provider, PROVIDER_IDENTITY);
  assert.equal(result.hasDynamicQaWorkflow, false);
  assert.deepEqual(result.existingWorkflows, ["acceptance.yml"]);
});

test("detectProviderConfiguration detects an already-present dynamic-qa workflow by filename", () => {
  const result = detectProviderConfiguration(["dynamic-qa.yml"]);
  assert.equal(result.hasDynamicQaWorkflow, true);
});

// --- point 4: only the safe trigger is built this ticket -------------------

test("only pull_request is a supported trigger this ticket built", () => {
  assert.deepEqual([...SUPPORTED_TRIGGERS], ["pull_request"]);
});

// --- the Node-runtime caveat: Safety Blocker + deferral, never a skip -----

test("a profile that never declares the Node-runtime capability is refused before any gate runs", () => {
  const result = checkNodeRuntimeCapabilityDeclared(fullProfile({ evidence: { adapter: "github-actions", capabilities: [] } }));
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].capability, NODE_RUNTIME_CAPABILITY);
});

test("planAdvisoryPullRequestLane defers (never skips) when the profile never declared the Node-runtime capability", () => {
  const profile = fullProfile({ evidence: { adapter: "github-actions", capabilities: [] } });
  const environmentEvidence = deriveCapabilityEvidence({
    runnerClass: RUNNER_CLASS,
    enforcedRead: profile.paths.allowedRead,
    enforcedWrite: profile.paths.allowedWrite,
    enforcedCommands: profile.commands.allowed,
    enforcedBoundaryIds: profile.effects.allowedBoundaryIds,
    resources: profile.resources,
    nodeRuntimeAvailable: true,
  });
  const result = planAdvisoryPullRequestLane({ profile, environmentEvidence, workflowConfig: workflowConfig() });
  assert.equal(result.rendered, false);
  assert.equal(result.state, "deferred");
  assert.ok(result.blockers.some((b) => b.capability === NODE_RUNTIME_CAPABILITY));
});

test("planAdvisoryPullRequestLane defers when the profile declares the Node-runtime capability but the environment reports it unmet", () => {
  const profile = fullProfile();
  const environmentEvidence = deriveCapabilityEvidence({
    runnerClass: RUNNER_CLASS,
    enforcedRead: profile.paths.allowedRead,
    enforcedWrite: profile.paths.allowedWrite,
    enforcedCommands: profile.commands.allowed,
    enforcedBoundaryIds: profile.effects.allowedBoundaryIds,
    resources: profile.resources,
    nodeRuntimeAvailable: false, // <-- the case under test
  });
  const result = planAdvisoryPullRequestLane({ profile, environmentEvidence, workflowConfig: workflowConfig() });
  assert.equal(result.rendered, false);
  assert.equal(result.state, "deferred");
  assert.ok(result.blockers.some((b) => b.capability === NODE_RUNTIME_CAPABILITY));
});

// --- the happy path: fully evidenced, plans and renders a hardened lane --

test("planAdvisoryPullRequestLane renders a hardened workflow once every capability is evidenced", () => {
  const profile = fullProfile();
  const environmentEvidence = deriveCapabilityEvidence({
    runnerClass: RUNNER_CLASS,
    enforcedRead: profile.paths.allowedRead,
    enforcedWrite: profile.paths.allowedWrite,
    enforcedCommands: profile.commands.allowed,
    enforcedBoundaryIds: profile.effects.allowedBoundaryIds,
    resources: profile.resources,
    nodeRuntimeAvailable: true,
  });
  const result = planAdvisoryPullRequestLane({ profile, environmentEvidence, workflowConfig: workflowConfig() });
  assert.equal(result.rendered, true, JSON.stringify(result));
  assert.equal(result.state, "activatable");
  assert.equal(result.path, ".github/workflows/dynamic-qa.yml");
  assert.equal(checkWorkflowHardening(result.yaml).valid, true);
});

test("planAdvisoryPullRequestLane defers when the environment does not match the profile's required paths (an ordinary Capability Gate blocker, not just the Node-runtime one)", () => {
  const profile = fullProfile();
  const environmentEvidence = deriveCapabilityEvidence({
    runnerClass: RUNNER_CLASS,
    enforcedRead: ["/somewhere-else"],
    enforcedWrite: profile.paths.allowedWrite,
    enforcedCommands: profile.commands.allowed,
    enforcedBoundaryIds: profile.effects.allowedBoundaryIds,
    resources: profile.resources,
    nodeRuntimeAvailable: true,
  });
  const result = planAdvisoryPullRequestLane({ profile, environmentEvidence, workflowConfig: workflowConfig() });
  assert.equal(result.rendered, false);
  assert.equal(result.state, "deferred");
  assert.ok(result.blockers.some((b) => b.capability === "paths.read-allowlist-enforced"));
});

// --- point 7: generated config must actually enforce the profile ----------

test("checkGeneratedConfigEnforcesProfile detects a rendered runner that does not match the profile's required runnerClass", () => {
  const profile = fullProfile();
  const environmentEvidence = deriveCapabilityEvidence({
    runnerClass: RUNNER_CLASS,
    enforcedRead: profile.paths.allowedRead,
    enforcedWrite: profile.paths.allowedWrite,
    enforcedCommands: profile.commands.allowed,
    enforcedBoundaryIds: profile.effects.allowedBoundaryIds,
    resources: profile.resources,
    nodeRuntimeAvailable: true,
  });
  const result = planAdvisoryPullRequestLane({ profile, environmentEvidence, workflowConfig: workflowConfig({ runsOn: "macos-14" }) });
  // The Capability Gate itself passes (environment evidence matches the
  // profile's runnerClass); it is the post-render enforcement check that
  // catches the renderer being asked to target a different runner than the
  // profile requires.
  assert.equal(result.rendered, false);
  assert.ok(result.blockers.some((b) => b.capability === "config.runner-class-mismatch"));
});

// --- point 6: pure run-reference resolution --------------------------------

test("resolveRunReference normalizes GitHub's own run environment into Result Envelope identity fields", () => {
  const env = {
    GITHUB_REPOSITORY: "phassle/VibeFileSync",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "999",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
  };
  const ref = resolveRunReference(env);
  assert.equal(ref.repository, "phassle/VibeFileSync");
  assert.equal(ref.sourceCommit, "a".repeat(40));
  assert.equal(ref.workflow.provider, PROVIDER_IDENTITY);
  assert.equal(ref.workflow.runId, "999");
  assert.equal(ref.workflow.runAttempt, "1");
  assert.equal(ref.workflow.url, "https://github.com/phassle/VibeFileSync/actions/runs/999");
});

test("resolveRunReference is a pure function of its input, requiring no real GitHub Actions environment", () => {
  const ref1 = resolveRunReference({});
  assert.equal(ref1.repository, undefined);
  assert.equal(ref1.workflow.url, undefined);
});
