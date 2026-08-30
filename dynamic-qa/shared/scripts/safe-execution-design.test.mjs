// dynamic-qa/shared/scripts/safe-execution-design.test.mjs
//
// Tier 1 tests for ticket #166 (qa-setup stage 7): composing #150's
// Execution Profile + Capability Gate and #151's Trust Zones into one
// per-flow decision, and gating #165's approved portfolio before profile
// design ever begins. One test each for: profile generation happens before
// activation is possible; a missing inventory section never becomes a
// default; a missing capability (evidence) produces a named blocker and
// `deferred`, never a skip or pass; a Trust Zone violation surfaces as a
// blocker; only #165's `approvedFlowIds` reach profile design; the
// portfolio entry point fails closed on a malformed approval result. The
// last test is the Tier 2 behavioural case the ticket calls for.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveExecutionProfileFromInventory,
  checkTrustZoneForExecution,
  designExecutionProfile,
  designSafeExecutionForApprovedFlows,
} from "./safe-execution-design.mjs";

function baseInventory(overrides = {}) {
  return {
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

function sampleFlow(overrides = {}) {
  return {
    id: "sample-flow",
    boundaries: [
      { id: "filesystem-state", treatment: "real", side_effects: "reversible", behavior: "writes a temp file", role: "owned" },
    ],
    ...overrides,
  };
}

function passingEnvironment(overrides = {}) {
  return {
    paths: { enforcedRead: ["/repo"], enforcedWrite: ["/repo/tmp"] },
    commands: { enforced: ["cargo test --test cli"] },
    environments: { runnerClass: "github-hosted-macos", disposable: true, sandbox: "vm" },
    resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
    identities: { active: ["ci-bot"] },
    network: { mode: "none" },
    effects: { enforcedBoundaryIds: ["filesystem-state"], namespaceIsolation: true, cleanupCapability: true },
    evidence: [{ capability: "environments.disposable", status: "met" }],
    ...overrides,
  };
}

function passingContext(overrides = {}) {
  return {
    zone: "low-trust-ci",
    contentSource: "reviewed-base-branch",
    environment: passingEnvironment(),
    ...overrides,
  };
}

// --- happy path: profile is generated and gated, activation is possible --

test("a fully inventoried flow with a matching environment is activatable, with a profile generated before activation", () => {
  const result = designExecutionProfile(sampleFlow(), baseInventory(), passingContext());
  assert.equal(result.decision.activate, true);
  assert.equal(result.decision.state, "activatable");
  assert.deepEqual(result.decision.blockers, []);
  assert.equal(typeof result.profileYaml, "string");
  assert.ok(result.profileYaml.includes('id: "sample-flow"'), "the generated profile YAML should name the flow's id");
});

// --- profiles are derived from inventory, never from defaults ------------

test("deriveExecutionProfileFromInventory never invents a section inventory did not supply", () => {
  const inventory = baseInventory();
  delete inventory.network;
  const { profile, blockers } = deriveExecutionProfileFromInventory(sampleFlow(), inventory);
  assert.equal("network" in profile, false, "an uninventoried section must be entirely absent, never a default value");
  assert.ok(
    blockers.some((b) => b.capability === "inventory.network-known" && b.category === "network"),
    "a missing inventory section must produce a named blocker naming exactly that section",
  );
});

test("a flow missing one inventory section stays deferred through the full pipeline, never a skip", () => {
  const inventory = baseInventory();
  delete inventory.network;
  const result = designExecutionProfile(sampleFlow(), inventory, passingContext());
  assert.equal(result.decision.activate, false);
  assert.equal(result.decision.state, "deferred");
  assert.ok(result.decision.blockers.some((b) => b.capability === "inventory.network-known"));
  assert.equal(typeof result.profileYaml, "string", "a profile draft is still generated even while deferred");
});

// --- a missing capability produces a named blocker and deferred, never a skip or pass --

test("a missing evidence capability produces a named Safety Blocker and defers the flow, never a silent skip or pass", () => {
  const environmentMissingEvidence = passingEnvironment({ evidence: [] });
  const result = designExecutionProfile(sampleFlow(), baseInventory(), passingContext({ environment: environmentMissingEvidence }));
  assert.equal(result.decision.activate, false);
  assert.equal(result.decision.state, "deferred");
  const evidenceBlocker = result.decision.blockers.find((b) => b.category === "evidence");
  assert.ok(evidenceBlocker, "the missing capability must appear as a named evidence blocker");
  assert.equal(evidenceBlocker.capability, "environments.disposable");
});

// --- Trust Zone violations surface as blockers ----------------------------

test("checkTrustZoneForExecution: untrusted content combined with a privileged credential scope is named", () => {
  const profile = { paths: { allowedRead: [], allowedWrite: [] }, network: { mode: "none" }, credentials: { scopes: ["repo:write"] } };
  const issues = checkTrustZoneForExecution(profile, { contentSource: "repository" });
  assert.ok(issues.some((i) => i.error === "trust-invariant.untrusted-content-with-privileged-identity"));
});

test("checkTrustZoneForExecution: omitting context.zone entirely produces a named zone-not-classified blocker, never a silent skip (finding #1, closed)", () => {
  const profile = { paths: { allowedRead: [], allowedWrite: [] }, network: { mode: "none" }, credentials: {} };
  // contentSource is deliberately TRUSTED so checkHardSecurityInvariant stays
  // silent, isolating exactly what omitting context.zone alone would lose.
  const issues = checkTrustZoneForExecution(profile, { contentSource: "reviewed-base-branch" });
  assert.ok(
    issues.some((i) => i.error === "zone-not-classified"),
    "an omitted context.zone must itself surface as a named trust-zone issue",
  );
});

test("designExecutionProfile: omitting context.zone defers the flow — checkAuthoringAuthority/checkVerificationCompute/checkPrivilegedLaneArtifact can never be silently bypassed by leaving zone out (finding #1, closed)", () => {
  const privilegedCredentials = { scopes: ["write:contents", "deploy"] };
  const result = designExecutionProfile(
    sampleFlow(),
    baseInventory({ credentials: { handle: "deploy-token", audience: "github-actions", scopes: privilegedCredentials.scopes, lifetimeSeconds: 600, injectionPhase: "pr", revocation: "auto-expire" } }),
    passingContext({ zone: undefined, contentSource: "reviewed-base-branch", credentials: privilegedCredentials }),
  );
  assert.equal(result.decision.activate, false);
  assert.equal(result.decision.state, "deferred");
  const zoneBlocker = result.decision.blockers.find((b) => b.category === "trust-zone" && b.capability === "zone-not-classified");
  assert.ok(zoneBlocker, "an omitted zone must produce its own named blocker rather than silently skipping every zone-dependent check");
});

test("a Trust Zone violation surfaces as a Safety Blocker and defers the flow", () => {
  const inventory = baseInventory({
    credentials: { handle: "deploy-token", audience: "github-actions", scopes: ["repo:write"], lifetimeSeconds: 600, injectionPhase: "pr", revocation: "auto-expire" },
  });
  const result = designExecutionProfile(sampleFlow(), inventory, passingContext({ contentSource: "repository" }));
  assert.equal(result.decision.activate, false);
  assert.equal(result.decision.state, "deferred");
  const trustBlocker = result.decision.blockers.find((b) => b.category === "trust-zone");
  assert.ok(trustBlocker, "a Trust Zone violation must appear as a named blocker");
  assert.equal(trustBlocker.capability, "trust-invariant.untrusted-content-with-privileged-identity");
});

// --- only #165's approved flows reach profile design ----------------------

test("designSafeExecutionForApprovedFlows only designs a profile for approvedFlowIds, never a draft-retained flow", () => {
  const approvedFlow = sampleFlow({ id: "approved-flow" });
  const draftFlow = sampleFlow({ id: "draft-flow" });
  const portfolioApproval = { approvedFlowIds: ["approved-flow"], draftFlowIds: ["draft-flow"] };
  const results = designSafeExecutionForApprovedFlows([approvedFlow, draftFlow], portfolioApproval, {
    inventoryByFlowId: { "approved-flow": baseInventory() },
    contextByFlowId: { "approved-flow": passingContext() },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].flowId, "approved-flow");
});

test("designSafeExecutionForApprovedFlows fails closed on a missing/malformed portfolioApproval", () => {
  assert.throws(() => designSafeExecutionForApprovedFlows([sampleFlow()], undefined));
  assert.throws(() => designSafeExecutionForApprovedFlows([sampleFlow()], {}));
});

// --- Tier 2: behavioural case ----------------------------------------------
//
// A flow with a missing capability stays deferred with the blocker visible,
// exercised through the same public portfolio entry point qa-setup stage 7
// calls, not an internal helper.

test("Tier 2: an approved flow with a missing capability stays deferred, and its blocker is visible in the portfolio result", () => {
  const flow = sampleFlow({ id: "pilot-flow" });
  const portfolioApproval = { approvedFlowIds: ["pilot-flow"], draftFlowIds: [] };
  const environmentMissingEvidence = passingEnvironment({ evidence: [] });

  const results = designSafeExecutionForApprovedFlows([flow], portfolioApproval, {
    inventoryByFlowId: { "pilot-flow": baseInventory() },
    contextByFlowId: { "pilot-flow": passingContext({ environment: environmentMissingEvidence }) },
  });

  assert.equal(results.length, 1);
  const [result] = results;
  assert.equal(result.decision.activate, false);
  assert.equal(result.decision.state, "deferred");
  assert.ok(
    result.decision.blockers.some((b) => b.category === "evidence" && b.capability === "environments.disposable"),
    "the missing capability must remain visible on the returned result, not swallowed",
  );
  assert.equal(typeof result.profileYaml, "string", "a profile draft is still produced even though the flow is deferred");
});
