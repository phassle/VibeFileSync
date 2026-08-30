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
  planNightlyFullSuiteLane,
  planManualTriggerLane,
  planMergeGroupLane,
  classifyLaneContentSource,
  checkLaneTrustInvariant,
  resolveRunReference,
  checkGeneratedConfigEnforcesProfile,
  checkShippable,
  NODE_RUNTIME_CAPABILITY,
  SUPPORTED_TRIGGERS,
  DEFERRED_TRIGGERS,
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

// --- point 4: #154 completes the trigger set --------------------------------

test("all four Provider-native CI triggers are supported after #154; nothing remains deferred", () => {
  assert.deepEqual([...SUPPORTED_TRIGGERS], ["pull_request", "schedule", "workflow_dispatch", "merge_group"]);
  assert.deepEqual([...DEFERRED_TRIGGERS], []);
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

// --- finding #3, closed: checkShippable refuses while action pins are placeholders ---

test("checkShippable refuses a fully-rendered, otherwise-hardened workflow while its action pins remain unresolved placeholders (finding #3, closed)", () => {
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
  // The rendered draft is itself perfectly hardened (proven above) — the
  // ONLY reason checkShippable refuses it is the still-unresolved action
  // pins, proving the two concerns are checked independently rather than
  // one masking the other.
  assert.equal(checkGeneratedConfigEnforcesProfile(profile, result.yaml).valid, true);

  const shippable = checkShippable(profile, result.yaml);
  assert.equal(shippable.valid, false);
  assert.ok(shippable.errors.some((e) => e.code === "actions.placeholder-pin-unresolved"));
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

// --- #154: the three completing lanes --------------------------------------

function environmentEvidenceFor(profile, { nodeRuntimeAvailable = true } = {}) {
  return deriveCapabilityEvidence({
    runnerClass: RUNNER_CLASS,
    enforcedRead: profile.paths.allowedRead,
    enforcedWrite: profile.paths.allowedWrite,
    enforcedCommands: profile.commands.allowed,
    enforcedBoundaryIds: profile.effects.allowedBoundaryIds,
    resources: profile.resources,
    nodeRuntimeAvailable,
  });
}

test("planNightlyFullSuiteLane renders a hardened, advisory (continue-on-error) nightly workflow once every capability is evidenced", () => {
  const profile = fullProfile();
  const result = planNightlyFullSuiteLane({
    profile,
    environmentEvidence: environmentEvidenceFor(profile),
    workflowConfig: workflowConfig(),
  });
  assert.equal(result.rendered, true, JSON.stringify(result));
  assert.equal(result.state, "activatable");
  assert.equal(result.path, ".github/workflows/dynamic-qa-nightly.yml");
  assert.match(result.yaml, /^\s*schedule:/m);
  assert.match(result.yaml, /continue-on-error:\s*true/);
  assert.equal(checkWorkflowHardening(result.yaml, { lane: "advisory", trigger: "schedule" }).valid, true);
});

test("planNightlyFullSuiteLane defers (never skips) when the Node-runtime capability is unmet, exactly like the PR lane", () => {
  const profile = fullProfile();
  const result = planNightlyFullSuiteLane({
    profile,
    environmentEvidence: environmentEvidenceFor(profile, { nodeRuntimeAvailable: false }),
    workflowConfig: workflowConfig(),
  });
  assert.equal(result.rendered, false);
  assert.equal(result.state, "deferred");
  assert.ok(result.blockers.some((b) => b.capability === NODE_RUNTIME_CAPABILITY));
});

test("planManualTriggerLane renders a hardened, advisory, zero-input workflow_dispatch lane", () => {
  const profile = fullProfile();
  const result = planManualTriggerLane({
    profile,
    environmentEvidence: environmentEvidenceFor(profile),
    workflowConfig: workflowConfig(),
  });
  assert.equal(result.rendered, true, JSON.stringify(result));
  assert.match(result.yaml, /^\s*workflow_dispatch:\s*\{\}/m);
  assert.ok(!result.yaml.includes("inputs:"));
  assert.equal(checkWorkflowHardening(result.yaml, { lane: "advisory", trigger: "workflow_dispatch" }).valid, true);
});

test("planManualTriggerLane's rendered lane fails enforcement if inputs are mutated in (proving the check is real, not decorative)", () => {
  const profile = fullProfile();
  const result = planManualTriggerLane({
    profile,
    environmentEvidence: environmentEvidenceFor(profile),
    workflowConfig: workflowConfig(),
  });
  const mutated = result.yaml.replace("workflow_dispatch: {}", "workflow_dispatch:\n    inputs:\n      testCommand:\n        required: false");
  const enforcement = checkGeneratedConfigEnforcesProfile(profile, mutated, { lane: "advisory", trigger: "workflow_dispatch" });
  assert.equal(enforcement.valid, false);
  assert.ok(enforcement.errors.some((e) => e.code === "dispatch.inputs-not-permitted"));
});

test("planMergeGroupLane renders a REQUIRED lane (no continue-on-error) that keeps required checks gating queued merges", () => {
  const profile = fullProfile();
  const result = planMergeGroupLane({
    profile,
    environmentEvidence: environmentEvidenceFor(profile),
    workflowConfig: workflowConfig(),
  });
  assert.equal(result.rendered, true, JSON.stringify(result));
  assert.equal(result.path, ".github/workflows/dynamic-qa-merge-group.yml");
  assert.match(result.yaml, /^\s*merge_group:/m);
  assert.ok(!/continue-on-error:\s*true/.test(result.yaml), "a required merge-group lane must not mask its own failure");
  assert.equal(checkWorkflowHardening(result.yaml, { lane: "required", trigger: "merge_group" }).valid, true);
});

test("planMergeGroupLane defers (never skips) when the Node-runtime capability is unmet, exactly like every other lane", () => {
  const profile = fullProfile();
  const result = planMergeGroupLane({
    profile,
    environmentEvidence: environmentEvidenceFor(profile, { nodeRuntimeAvailable: false }),
    workflowConfig: workflowConfig(),
  });
  assert.equal(result.rendered, false);
  assert.equal(result.state, "deferred");
  assert.ok(result.blockers.some((b) => b.capability === NODE_RUNTIME_CAPABILITY));
});

test("every lane's renderer still uses minimal permissions, SHA-pinned actions, and no secrets/OIDC/write/cache/self-hosted (hardening does not weaken for the new lanes)", () => {
  const profile = fullProfile();
  const evidence = environmentEvidenceFor(profile);
  const cfg = workflowConfig();
  for (const [plan, lane, trigger] of [
    [planNightlyFullSuiteLane, "advisory", "schedule"],
    [planManualTriggerLane, "advisory", "workflow_dispatch"],
    [planMergeGroupLane, "required", "merge_group"],
  ]) {
    const result = plan({ profile, environmentEvidence: evidence, workflowConfig: cfg });
    assert.equal(result.rendered, true, JSON.stringify(result));
    const hardening = checkWorkflowHardening(result.yaml, { lane, trigger });
    assert.equal(hardening.valid, true, JSON.stringify(hardening.errors));
    assert.ok(!result.yaml.includes("secrets."));
    assert.ok(!/id-token:\s*write/.test(result.yaml));
    assert.ok(!/runs-on:\s*self-hosted/.test(result.yaml));
  }
});

// --- #154: the trust asymmetry, modeled via trust-zones.mjs, not copied ---

test("classifyLaneContentSource treats nightly and merge-group as reviewed-base-branch (trusted), and pull_request/workflow_dispatch as branch (untrusted)", () => {
  assert.equal(classifyLaneContentSource("schedule"), "reviewed-base-branch");
  assert.equal(classifyLaneContentSource("merge_group"), "reviewed-base-branch");
  assert.equal(classifyLaneContentSource("pull_request"), "branch");
  assert.equal(classifyLaneContentSource("workflow_dispatch"), "branch");
});

test("the same permissive identity/paths/network shape is REJECTED for pull_request/workflow_dispatch content but ACCEPTED for schedule/merge_group content — the asymmetry trust-zones.mjs models is real, not decorative", () => {
  const permissive = {
    credentials: { scopes: ["contents:write"] },
    paths: { allowedRead: ["/"], allowedWrite: ["/"] },
    network: { mode: "open" },
  };

  const prResult = checkLaneTrustInvariant("pull_request", permissive);
  assert.equal(prResult.valid, false);
  assert.ok(prResult.errors.some((e) => e.error === "trust-invariant.untrusted-content-with-privileged-identity"));

  const manualResult = checkLaneTrustInvariant("workflow_dispatch", permissive);
  assert.equal(manualResult.valid, false);

  const nightlyResult = checkLaneTrustInvariant("schedule", permissive);
  assert.equal(nightlyResult.valid, true, JSON.stringify(nightlyResult.errors));

  const mergeGroupResult = checkLaneTrustInvariant("merge_group", permissive);
  assert.equal(mergeGroupResult.valid, true, JSON.stringify(mergeGroupResult.errors));
});

test("every lane this adapter actually renders satisfies the hard security invariant regardless of its trust classification, because none of them uses the extra room trust would permit", () => {
  const profile = fullProfile();
  const evidence = environmentEvidenceFor(profile);
  const cfg = workflowConfig();
  const minimalShape = { credentials: {}, paths: { allowedRead: ["/repo"], allowedWrite: [] }, network: { mode: "none" } };

  for (const trigger of ["pull_request", "schedule", "workflow_dispatch", "merge_group"]) {
    const result = trigger === "schedule" ? planNightlyFullSuiteLane({ profile, environmentEvidence: evidence, workflowConfig: cfg })
      : trigger === "workflow_dispatch" ? planManualTriggerLane({ profile, environmentEvidence: evidence, workflowConfig: cfg })
      : trigger === "merge_group" ? planMergeGroupLane({ profile, environmentEvidence: evidence, workflowConfig: cfg })
      : planAdvisoryPullRequestLane({ profile, environmentEvidence: evidence, workflowConfig: cfg });
    assert.equal(result.rendered, true, JSON.stringify(result));
    assert.equal(checkLaneTrustInvariant(trigger, minimalShape).valid, true);
  }
});
