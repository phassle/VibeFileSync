// dynamic-qa/shared/scripts/capability-gate.test.mjs
//
// Tier 1 tests for the Capability Gate (ticket #150): one test proving each
// of the eight categories (paths, commands, environments, network,
// identities, effects, resources, evidence) independently produces a named
// Safety Blocker when the environment does not match/prove what the
// profile requires, plus the composed pass/deferred behaviour of
// `activationDecision`. Every "missing capability" assertion checks the
// exact `capability` string, not just "some error happened" — the ticket's
// acceptance criterion is that Blocker text names the exact missing
// capability, never a generic failure.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runCapabilityGate, activationDecision } from "./capability-gate.mjs";

function baseProfile(overrides = {}) {
  return {
    paths: { allowedRead: ["/repo"], allowedWrite: ["/repo/tmp"] },
    commands: { allowed: ["cargo test --test cli"] },
    environments: { runnerClass: "github-hosted-macos", disposable: true, disposabilityEvidence: "fresh VM", sandbox: "vm" },
    resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
    identities: { approvedNonProduction: ["ci-bot"], denyProduction: ["prod-service-account"], denyMetadata: ["169.254.169.254"] },
    network: { mode: "none" },
    effects: { allowedBoundaryIds: ["filesystem-state"], reversibleSideEffects: false },
    evidence: {
      adapter: "github-actions",
      capabilities: [{ capability: "environments.disposable-runner", category: "environments" }],
    },
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
    effects: { enforcedBoundaryIds: ["filesystem-state"] },
    evidence: [{ capability: "environments.disposable-runner", status: "met" }],
    ...overrides,
  };
}

function capabilitiesOf(result) {
  return result.blockers.map((b) => b.capability);
}

test("a fully matching environment passes the gate with no blockers", () => {
  const result = runCapabilityGate(baseProfile(), passingEnvironment());
  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
});

test("paths: an environment enforcing a different read/write set produces a named blocker", () => {
  const env = passingEnvironment({ paths: { enforcedRead: ["/somewhere-else"], enforcedWrite: ["/repo/tmp"] } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.equal(result.passed, false);
  assert.ok(capabilitiesOf(result).includes("paths.read-allowlist-enforced"));
});

test("commands: a mismatched enforced command allowlist produces a named blocker", () => {
  const env = passingEnvironment({ commands: { enforced: ["some other command"] } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("commands.allowlist-enforced"));
});

test("environments: a non-disposable runner produces a named blocker", () => {
  const env = passingEnvironment({ environments: { runnerClass: "github-hosted-macos", disposable: false, sandbox: "vm" } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("environments.disposable"));
});

test("environments: a mismatched runner class produces a named blocker", () => {
  const env = passingEnvironment({ environments: { runnerClass: "self-hosted-linux", disposable: true, sandbox: "vm" } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("environments.runner-class-matches"));
});

test("resources: an environment that does not cap a resource at or below the profile's limit produces a named blocker", () => {
  const env = passingEnvironment({ resources: { maxProcesses: 8, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("resources.maxProcesses-enforced"));
});

test("identities: an active identity outside the approved list produces a named blocker", () => {
  const env = passingEnvironment({ identities: { active: ["some-unapproved-id"] } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("identities.only-approved-identity-active"));
});

test("identities: an active identity on the deny list produces a named blocker even if never approved", () => {
  const env = passingEnvironment({ identities: { active: ["prod-service-account"] } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("identities.no-denied-identity-active"));
});

test("effects: a mismatched enforced boundary allowlist produces a named blocker", () => {
  const env = passingEnvironment({ effects: { enforcedBoundaryIds: ["different-boundary"] } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("effects.boundary-allowlist-enforced"));
});

test("effects: reversibleSideEffects true requires the environment to report isolation and cleanup", () => {
  const profile = baseProfile({ effects: { allowedBoundaryIds: ["filesystem-state"], reversibleSideEffects: true } });
  const env = passingEnvironment({ effects: { enforcedBoundaryIds: ["filesystem-state"] } });
  const result = runCapabilityGate(profile, env);
  assert.ok(capabilitiesOf(result).includes("effects.namespace-isolation-enforced"));
  assert.ok(capabilitiesOf(result).includes("effects.cleanup-capability-enforced"));

  const withIsolation = passingEnvironment({
    effects: { enforcedBoundaryIds: ["filesystem-state"], namespaceIsolation: true, cleanupCapability: true },
  });
  const passingResult = runCapabilityGate(profile, withIsolation);
  assert.equal(passingResult.passed, true);
});

test("evidence: a missing required capability produces a Safety Blocker named exactly after that capability", () => {
  const env = passingEnvironment({ evidence: [] });
  const result = runCapabilityGate(baseProfile(), env);
  assert.equal(result.passed, false);
  assert.ok(capabilitiesOf(result).includes("environments.disposable-runner"));
  const blocker = result.blockers.find((b) => b.capability === "environments.disposable-runner");
  assert.equal(blocker.category, "evidence");
  assert.match(blocker.message, /environments\.disposable-runner/);
});

test("evidence: a capability reported unmet (not missing) still produces the same named blocker", () => {
  const env = passingEnvironment({ evidence: [{ capability: "environments.disposable-runner", status: "unmet" }] });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("environments.disposable-runner"));
});

test("evidence gate never silently skips: an entirely absent environment.evidence produces blockers, not a pass", () => {
  const env = passingEnvironment();
  delete env.evidence;
  const result = runCapabilityGate(baseProfile(), env);
  assert.equal(result.passed, false);
});

// --- network: default none, exact-allowlist, and the externally-enforced rule ---

test("network default none: an environment that does not report mode none is blocked", () => {
  const env = passingEnvironment({ network: { mode: "exact-allowlist" } });
  const result = runCapabilityGate(baseProfile(), env);
  assert.ok(capabilitiesOf(result).includes("network.egress-isolated"));
});

function exactAllowlistProfile() {
  return baseProfile({
    network: {
      mode: "exact-allowlist",
      allowlist: [{ origin: "https://api.example-staging.test", service: "example-api" }],
      dnsRecheck: true,
      redirectRecheck: true,
      denyMetadataRange: true,
      denyInternalRange: true,
      denyPublicRange: true,
      externallyEnforced: true,
      enforcementMechanism: "egress proxy",
    },
  });
}

function exactAllowlistEnvironment(overrides = {}) {
  return passingEnvironment({
    network: {
      mode: "exact-allowlist",
      enforcedAllowlist: [{ origin: "https://api.example-staging.test", service: "example-api" }],
      dnsRecheck: true,
      redirectRecheck: true,
      denyMetadataRange: true,
      denyInternalRange: true,
      denyPublicRange: true,
      externallyEnforced: true,
      ...overrides,
    },
  });
}

test("network exact-allowlist: a matching, fully-enforced environment passes", () => {
  const result = runCapabilityGate(exactAllowlistProfile(), exactAllowlistEnvironment());
  assert.equal(result.passed, true);
});

test("network exact-allowlist: a permissive hosted runner without external enforcement is deferred, not passed", () => {
  const env = exactAllowlistEnvironment({ externallyEnforced: false });
  const result = runCapabilityGate(exactAllowlistProfile(), env);
  assert.equal(result.passed, false);
  assert.ok(capabilitiesOf(result).includes("network.egress-externally-enforced"));
  const decision = activationDecision(result);
  assert.equal(decision.activate, false);
  assert.equal(decision.state, "deferred");
});

test("network exact-allowlist: a mismatched allowlist is blocked even if the environment claims exact-allowlist mode", () => {
  const env = exactAllowlistEnvironment({ enforcedAllowlist: [{ origin: "https://some-other-host.test", service: "example-api" }] });
  const result = runCapabilityGate(exactAllowlistProfile(), env);
  assert.ok(capabilitiesOf(result).includes("network.exact-allowlist-matches"));
});

test("network exact-allowlist: missing dnsRecheck/redirectRecheck/deny-range flags each produce their own named blocker", () => {
  for (const [field, capability] of [
    ["dnsRecheck", "network.dns-recheck-enforced"],
    ["redirectRecheck", "network.redirect-recheck-enforced"],
    ["denyMetadataRange", "network.metadata-range-denied"],
    ["denyInternalRange", "network.internal-range-denied"],
    ["denyPublicRange", "network.public-range-denied"],
  ]) {
    const env = exactAllowlistEnvironment({ [field]: false });
    const result = runCapabilityGate(exactAllowlistProfile(), env);
    assert.ok(capabilitiesOf(result).includes(capability), `expected blocker ${capability} when ${field} is false`);
  }
});

// --- activationDecision composition -------------------------------------

test("activationDecision never activates while any blocker is open", () => {
  const result = runCapabilityGate(baseProfile(), passingEnvironment({ identities: { active: ["prod-service-account"] } }));
  const decision = activationDecision(result);
  assert.equal(decision.activate, false);
  assert.equal(decision.state, "deferred");
  assert.ok(decision.blockers.length > 0);
});

test("activationDecision activates only when the gate passed and no extra blockers are supplied", () => {
  const result = runCapabilityGate(baseProfile(), passingEnvironment());
  const decision = activationDecision(result);
  assert.equal(decision.activate, true);
  assert.equal(decision.state, "activatable");
  assert.deepEqual(decision.blockers, []);
});

test("activationDecision composes extra blockers (e.g. boundary honourability) and still refuses to activate", () => {
  const result = runCapabilityGate(baseProfile(), passingEnvironment());
  const decision = activationDecision(result, [{ category: "effects", capability: "effects.boundary-honoured", message: "unhonourable" }]);
  assert.equal(decision.activate, false);
  assert.equal(decision.state, "deferred");
  assert.equal(decision.blockers.length, 1);
});
