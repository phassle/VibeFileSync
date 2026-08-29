// dynamic-qa/shared/scripts/adapter-conformance.test.mjs
//
// Ticket #156: Tier 1 coverage for the provider-neutral adapter contract.
// Three groups of proof, matching the ticket's acceptance criteria exactly:
//
//   1. Both the real GitHub Actions adapter (github-actions-adapter.mjs's
//      exported `adapter`) and a second, independently-written fixture
//      adapter (fixture-adapter.mjs) pass the FULL conformance suite — the
//      same suite code, run against two different adapter objects, proving
//      genuine reusability (not a GitHub-Actions-shaped suite in disguise).
//   2. A fixture adapter missing each of the 7 contract points fails with a
//      named error identifying that exact point — one test per point.
//   3. An adapter that CANNOT enforce each of the 6 security obligations
//      fails conformance for that obligation rather than degrading to a
//      silent pass — one test per obligation, each via a "rubber stamp"
//      adapter that accepts what a conforming adapter must reject.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runAdapterConformanceSuite } from "./adapter-conformance.mjs";
import { CONTRACT_POINTS, SECURITY_OBLIGATIONS } from "./adapter-contract.mjs";
import { adapter as githubActionsAdapter, NODE_RUNTIME_CAPABILITY } from "./github-actions-adapter.mjs";
import { adapter as fixtureCiAdapter } from "./fixture-adapter.mjs";

const SAMPLE_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="dynamic-qa" tests="2" failures="1" errors="0" skipped="0">
  <testcase classname="flows.checkout" name="destination matches source" time="0.12" />
  <testcase classname="flows.checkout" name="boom" time="0.01">
    <failure message="expected X got Y">stack trace here</failure>
  </testcase>
</testsuite>
`;

// --- fixtures: GitHub Actions -----------------------------------------------

function ghProfile() {
  return {
    environments: { runnerClass: "ubuntu-latest", disposable: true, sandbox: "vm" },
    paths: { allowedRead: ["/repo"], allowedWrite: ["/repo/tmp"] },
    commands: { allowed: ["npm test"] },
    resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
    identities: { approvedNonProduction: [], denyProduction: [], denyMetadata: [] },
    network: { mode: "none" },
    effects: { allowedBoundaryIds: ["vibesync-cli"], reversibleSideEffects: false },
    evidence: { adapter: "github-actions", capabilities: [{ capability: NODE_RUNTIME_CAPABILITY, category: "evidence" }] },
  };
}

function ghWorkflowConfig() {
  return { runsOn: "ubuntu-latest", nodeVersion: "20", testCommand: "npm test", junitPath: "reports/junit.xml" };
}

function ghEvidenceInput({ nodeRuntimeAvailable, networkMode }) {
  const profile = ghProfile();
  return {
    runnerClass: profile.environments.runnerClass,
    enforcedRead: profile.paths.allowedRead,
    enforcedWrite: profile.paths.allowedWrite,
    enforcedCommands: profile.commands.allowed,
    enforcedBoundaryIds: profile.effects.allowedBoundaryIds,
    resources: profile.resources,
    nodeRuntimeAvailable,
    ...(networkMode !== undefined ? {} : {}),
  };
}

function ghFixtures() {
  const profile = ghProfile();
  const workflowConfig = ghWorkflowConfig();
  const metEnvironmentEvidence = githubActionsAdapter.deriveCapabilityEvidence(ghEvidenceInput({ nodeRuntimeAvailable: true }));
  const blockedEnvironmentEvidence = githubActionsAdapter.deriveCapabilityEvidence(ghEvidenceInput({ nodeRuntimeAvailable: false }));
  const violatingEnvironmentEvidence = { ...metEnvironmentEvidence, network: { mode: "open" } };

  const conformingRender = githubActionsAdapter.planLane({ lane: "advisory", trigger: "pull_request", profile, environmentEvidence: metEnvironmentEvidence, workflowConfig });
  assert.equal(conformingRender.rendered, true, JSON.stringify(conformingRender));
  const conformingConfig = conformingRender.config;

  const minimalPermissionsBroken = conformingConfig.replace("contents: read", "contents: write");
  const noPersistedCredentialBroken = conformingConfig.replace("persist-credentials: false", "persist-credentials: true");
  const immutablePinsBroken = conformingConfig.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v4");
  const privilegedLowTrustSeparationBroken = `name: broken
on:
  pull_request_target:
    branches: ["main"]
permissions:
  contents: read
jobs:
  privileged-job:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332
      - name: Use secret
        run: echo \${{ secrets.TOKEN }}
      - name: Download artifact
        uses: actions/download-artifact@abc0000000000000000000000000000000000000
`;

  return {
    existingWorkflowFilenames: ["acceptance.yml"],
    capabilityEvidence: {
      metInput: ghEvidenceInput({ nodeRuntimeAvailable: true }),
      unmetInput: ghEvidenceInput({ nodeRuntimeAvailable: false }),
      unmetCapability: NODE_RUNTIME_CAPABILITY,
    },
    profile,
    workflowConfig,
    primaryLaneTrigger: { lane: "advisory", trigger: "pull_request" },
    metEnvironmentEvidence,
    blockedEnvironmentEvidence,
    junitXmlText: SAMPLE_JUNIT,
    cleanDiagnostics: [{ kind: "junit", path: "reports/junit.xml", diagnostic: { text: "<testsuite name=\"s\"></testsuite>" } }],
    failureBundleOpts: {},
    runEnvironment: { GITHUB_REPOSITORY: "phassle/VibeFileSync", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
    conformingConfig,
    conformingConfigOptions: { lane: "advisory", trigger: "pull_request" },
    nonConformingConfig: minimalPermissionsBroken,
    nonConformingConfigOptions: { lane: "advisory", trigger: "pull_request" },
    obligations: {
      exactEgress: { violatingEnvironmentEvidence },
      brokenConfigs: {
        minimalPermissions: { config: minimalPermissionsBroken, options: { lane: "advisory", trigger: "pull_request" } },
        immutablePins: { config: immutablePinsBroken, options: { lane: "advisory", trigger: "pull_request" } },
        noPersistedCredential: { config: noPersistedCredentialBroken, options: { lane: "advisory", trigger: "pull_request" } },
        privilegedLowTrustSeparation: { config: privilegedLowTrustSeparationBroken, options: { lane: "advisory", trigger: "pull_request" } },
      },
      diagnosticsScrubbing: { diagnostics: [{ kind: "junit", path: "reports/junit.xml", diagnostic: { text: "<testsuite name=\"s\"></testsuite>" } }] },
    },
  };
}

// --- fixtures: fixture-ci ----------------------------------------------------

function fixtureCiProfile() {
  return {
    environments: { runnerClass: "fixture-runner", disposable: true, sandbox: "vm" },
    paths: { allowedRead: ["/repo"], allowedWrite: [] },
    commands: { allowed: ["npm test"] },
    resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
    identities: { approvedNonProduction: [], denyProduction: [], denyMetadata: [] },
    network: { mode: "none" },
    effects: { allowedBoundaryIds: [], reversibleSideEffects: false },
    evidence: { capabilities: [{ capability: "runtime.node-available", category: "evidence" }] },
  };
}

function fixtureCiFixtures() {
  const profile = fixtureCiProfile();
  const workflowConfig = { runsOn: "fixture-runner", nodeVersion: "20", testCommand: "npm test", junitPath: "reports/junit.json" };
  const metEnvironmentEvidence = fixtureCiAdapter.deriveCapabilityEvidence({ networkIsolated: true, nodeAvailable: true });
  const blockedEnvironmentEvidence = fixtureCiAdapter.deriveCapabilityEvidence({ networkIsolated: true, nodeAvailable: false });
  const violatingEnvironmentEvidence = { ...metEnvironmentEvidence, network: { mode: "open" } };

  const conformingRender = fixtureCiAdapter.planLane({ lane: "advisory", trigger: "pull_request", profile, environmentEvidence: metEnvironmentEvidence, workflowConfig });
  assert.equal(conformingRender.rendered, true, JSON.stringify(conformingRender));
  const conformingConfig = conformingRender.config;
  const conformingParsed = JSON.parse(conformingConfig);

  const minimalPermissionsBroken = JSON.stringify({ ...conformingParsed, permissions: "write-all" });
  const noPersistedCredentialBroken = JSON.stringify({ ...conformingParsed, persistCredentials: true });
  const immutablePinsBroken = JSON.stringify({ ...conformingParsed, actionPin: "checkout@v4" });
  const privilegedLowTrustSeparationBroken = JSON.stringify({ ...conformingParsed, identity: "privileged" });

  return {
    existingWorkflowFilenames: ["some-other-workflow.json"],
    capabilityEvidence: {
      metInput: { networkIsolated: true, nodeAvailable: true },
      unmetInput: { networkIsolated: true, nodeAvailable: false },
      unmetCapability: "runtime.node-available",
    },
    profile,
    workflowConfig,
    primaryLaneTrigger: { lane: "advisory", trigger: "pull_request" },
    metEnvironmentEvidence,
    blockedEnvironmentEvidence,
    junitXmlText: SAMPLE_JUNIT,
    cleanDiagnostics: [{ kind: "junit", path: "reports/junit.json", diagnostic: { text: "clean junit content" } }],
    failureBundleOpts: {},
    runEnvironment: { FIXTURE_REPOSITORY: "example/fixture", FIXTURE_SHA: "b".repeat(40), FIXTURE_RUN_ID: "42", FIXTURE_RUN_ATTEMPT: "1" },
    conformingConfig,
    conformingConfigOptions: undefined,
    nonConformingConfig: minimalPermissionsBroken,
    nonConformingConfigOptions: undefined,
    obligations: {
      exactEgress: { violatingEnvironmentEvidence },
      brokenConfigs: {
        minimalPermissions: { config: minimalPermissionsBroken, options: undefined },
        immutablePins: { config: immutablePinsBroken, options: undefined },
        noPersistedCredential: { config: noPersistedCredentialBroken, options: undefined },
        privilegedLowTrustSeparation: { config: privilegedLowTrustSeparationBroken, options: undefined },
      },
      diagnosticsScrubbing: { diagnostics: [{ kind: "junit", path: "reports/junit.json", diagnostic: { text: "clean junit content" } }] },
    },
  };
}

// --- group 1: both adapters pass the SAME suite — genuine reusability -----

test("the GitHub Actions adapter passes the full provider-neutral conformance suite", () => {
  const result = runAdapterConformanceSuite(githubActionsAdapter, ghFixtures());
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.shapeValid, true);
  for (const point of CONTRACT_POINTS) assert.equal(result.pointResults[point.key].valid, true, `${point.key}: ${JSON.stringify(result.pointResults[point.key].errors)}`);
  for (const obligation of SECURITY_OBLIGATIONS) assert.equal(result.obligationResults[obligation.id].valid, true, `${obligation.id}: ${JSON.stringify(result.obligationResults[obligation.id].errors)}`);
});

test("a second, independently-written fixture-ci adapter also passes the exact same conformance suite (reusability, not a GitHub-Actions-shaped suite in disguise)", () => {
  const result = runAdapterConformanceSuite(fixtureCiAdapter, fixtureCiFixtures());
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});

// --- group 2: a fixture adapter missing each of the 7 points fails, named --

function omit(obj, ...keys) {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

test("point 1 (discovery): an adapter missing detect() fails conformance naming point 1", () => {
  const broken = omit(fixtureCiAdapter, "detect");
  const result = runAdapterConformanceSuite(broken, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.point === 1), JSON.stringify(result.errors));
});

test("point 2 (capability evidence): an adapter missing deriveCapabilityEvidence() fails conformance naming point 2", () => {
  const broken = omit(fixtureCiAdapter, "deriveCapabilityEvidence");
  const result = runAdapterConformanceSuite(broken, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.point === 2), JSON.stringify(result.errors));
});

test("point 3 (lane rendering): an adapter missing planLane() fails conformance naming point 3", () => {
  const broken = omit(fixtureCiAdapter, "planLane");
  const result = runAdapterConformanceSuite(broken, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.point === 3), JSON.stringify(result.errors));
});

test("point 4 (triggers): an adapter missing supportedTriggers fails conformance naming point 4", () => {
  const broken = omit(fixtureCiAdapter, "supportedTriggers");
  const result = runAdapterConformanceSuite(broken, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.point === 4), JSON.stringify(result.errors));
});

test("point 5 (reporting/failure-bundle): an adapter missing emitFailureBundle() fails conformance naming point 5", () => {
  const broken = omit(fixtureCiAdapter, "emitFailureBundle");
  const result = runAdapterConformanceSuite(broken, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.point === 5), JSON.stringify(result.errors));
});

test("point 6 (provider-run resolution): an adapter missing resolveRunReference() fails conformance naming point 6", () => {
  const broken = omit(fixtureCiAdapter, "resolveRunReference");
  const result = runAdapterConformanceSuite(broken, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.point === 6), JSON.stringify(result.errors));
});

test("point 7 (Execution Profile validation): an adapter missing checkGeneratedConfigEnforcesProfile() fails conformance naming point 7", () => {
  const broken = omit(fixtureCiAdapter, "checkGeneratedConfigEnforcesProfile");
  const result = runAdapterConformanceSuite(broken, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.point === 7), JSON.stringify(result.errors));
});

// --- group 3: an adapter that cannot enforce each obligation fails, never --
// --- degrades to a silent pass (one "rubber stamp" adapter per obligation) -

test("exact egress: an adapter whose planLane renders regardless of network evidence fails this obligation, never degrades to a silent render", () => {
  const rubberStamp = { ...fixtureCiAdapter, planLane: () => ({ rendered: true, state: "activatable", config: "{}", path: "fixture-ci.json" }) };
  const result = runAdapterConformanceSuite(rubberStamp, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.equal(result.obligationResults["exact-egress"].valid, false, JSON.stringify(result.obligationResults["exact-egress"].errors));
});

test("minimal permissions: an adapter whose profile-enforcement check accepts a broad-permissions configuration fails this obligation", () => {
  const rubberStamp = { ...fixtureCiAdapter, checkGeneratedConfigEnforcesProfile: () => ({ valid: true, errors: [] }) };
  const result = runAdapterConformanceSuite(rubberStamp, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.equal(result.obligationResults["minimal-permissions"].valid, false);
});

test("immutable pins: an adapter whose profile-enforcement check accepts a floating (non-exact) action reference fails this obligation", () => {
  const rubberStamp = { ...fixtureCiAdapter, checkGeneratedConfigEnforcesProfile: () => ({ valid: true, errors: [] }) };
  const result = runAdapterConformanceSuite(rubberStamp, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.equal(result.obligationResults["immutable-pins"].valid, false);
});

test("no persisted credential: an adapter whose profile-enforcement check accepts a persisted-credential configuration fails this obligation", () => {
  const rubberStamp = { ...fixtureCiAdapter, checkGeneratedConfigEnforcesProfile: () => ({ valid: true, errors: [] }) };
  const result = runAdapterConformanceSuite(rubberStamp, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.equal(result.obligationResults["no-persisted-credential"].valid, false);
});

test("privileged/low-trust separation: an adapter whose profile-enforcement check accepts a privileged identity bridged to a low-trust trigger fails this obligation", () => {
  const rubberStamp = { ...fixtureCiAdapter, checkGeneratedConfigEnforcesProfile: () => ({ valid: true, errors: [] }) };
  const result = runAdapterConformanceSuite(rubberStamp, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.equal(result.obligationResults["privileged-low-trust-separation"].valid, false);
});

test("diagnostics scrubbing: an adapter whose failure-bundle emission bypasses the fail-safe scrub gate (ignores a forced scrub-verification failure) fails this obligation", () => {
  const rubberStamp = {
    ...fixtureCiAdapter,
    emitFailureBundle: (diagnostics) => ({
      artifacts: diagnostics.map((d) => ({ kind: d.kind, path: d.path, sizeBytes: 10, retentionDays: 30 })),
      withheld: [],
    }),
  };
  const result = runAdapterConformanceSuite(rubberStamp, fixtureCiFixtures());
  assert.equal(result.valid, false);
  assert.equal(result.obligationResults["diagnostics-scrubbing"].valid, false, JSON.stringify(result.obligationResults["diagnostics-scrubbing"].errors));
});

// --- a genuinely conforming adapter is not accidentally penalized ----------

test("a fully-conforming rubber-stamp counterexample is not itself broken: fixture-ci's own real methods still pass every obligation (sanity check for the tests above)", () => {
  const result = runAdapterConformanceSuite(fixtureCiAdapter, fixtureCiFixtures());
  for (const obligation of SECURITY_OBLIGATIONS) {
    assert.equal(result.obligationResults[obligation.id].valid, true, `${obligation.id}: ${JSON.stringify(result.obligationResults[obligation.id].errors)}`);
  }
});
