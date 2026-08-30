// dynamic-qa/shared/scripts/fixture-adapter.mjs
//
// Ticket #156: a second, independently-implemented, FULLY CONFORMING
// provider adapter against the neutral contract (adapter-contract.mjs),
// existing solely to prove the conformance suite
// (adapter-conformance.mjs) is genuinely reusable rather than accidentally
// coupled to GitHub Actions' shape. "fixture-ci" is an imaginary provider —
// this is deliberately NOT a second real provider (the ticket is explicit
// that shipping one is out of scope). Its rendered configuration is a small
// JSON string, not YAML, precisely so that nothing about conformance here
// depends on GitHub Actions' rendered format.
//
// Composes exactly the same public, provider-neutral modules the GitHub
// Actions adapter composes (capability-gate.mjs, diagnostics-scrub.mjs,
// junit-report.mjs) and NOTHING from github-actions-adapter.mjs or
// github-actions-workflow.mjs — proving the ticket's acceptance criterion
// "a second adapter can be written against the contract without touching
// bundle internals".

import { runCapabilityGate, activationDecision } from "./capability-gate.mjs";
import { buildDiagnosticsManifest } from "./diagnostics-scrub.mjs";
import { parseJUnitXML, summarizeJUnit } from "./junit-report.mjs";

export const PROVIDER_IDENTITY = "fixture-ci";
export const NODE_RUNTIME_CAPABILITY = "runtime.node-available";

export const SUPPORTED_TRIGGERS = Object.freeze(["pull_request"]);
export const DEFERRED_TRIGGERS = Object.freeze(["schedule", "workflow_dispatch", "merge_group"]);
export const SUPPORTED_LANES = Object.freeze(["advisory"]);
export const DEFERRED_LANES = Object.freeze(["required", "quarantine"]);

// --- point 1 -----------------------------------------------------------------

export function detect(existingWorkflowFilenames = []) {
  const filenames = Array.isArray(existingWorkflowFilenames) ? existingWorkflowFilenames : [];
  return {
    provider: PROVIDER_IDENTITY,
    existingWorkflows: filenames,
    hasDynamicQaWorkflow: filenames.includes("fixture-ci.json"),
    defaultWorkflowPath: "fixture-ci.json",
  };
}

// --- point 2 -----------------------------------------------------------------

export function deriveCapabilityEvidence({ networkIsolated = false, nodeAvailable = false } = {}) {
  return {
    paths: { enforcedRead: ["/repo"], enforcedWrite: [] },
    commands: { enforced: ["npm test"] },
    environments: { runnerClass: "fixture-runner", disposable: true, sandbox: "vm" },
    resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
    identities: { active: [] },
    network: { mode: networkIsolated ? "none" : "open" },
    effects: { enforcedBoundaryIds: [] },
    evidence: [{ capability: NODE_RUNTIME_CAPABILITY, status: nodeAvailable ? "met" : "unmet" }],
  };
}

// --- point 3 -----------------------------------------------------------------

function renderConfig({ runsOn, nodeVersion, testCommand, junitPath, lane, trigger }) {
  return JSON.stringify({
    provider: PROVIDER_IDENTITY,
    lane,
    trigger,
    runsOn,
    nodeVersion,
    testCommand,
    junitPath,
    permissions: "read-only",
    persistCredentials: false,
    actionPin: "checkout@exact-sha",
    identity: "unprivileged",
    gating: lane === "required" ? "blocking" : "advisory",
  });
}

/**
 * Point 3: refuses to render (deferred, named blockers) while the
 * Capability Gate has any open blocker — no default-open path, mirroring
 * github-actions-adapter.mjs's `planAdvisoryPullRequestLane` composition
 * exactly, just against this provider's own trivial renderer.
 */
export function planLane({ lane = "advisory", trigger = "pull_request", profile, environmentEvidence, workflowConfig } = {}) {
  if (!SUPPORTED_LANES.includes(lane) || !SUPPORTED_TRIGGERS.includes(trigger)) {
    return {
      rendered: false,
      state: "deferred",
      blockers: [{ category: "lane", capability: `lane:${lane}/trigger:${trigger}`, message: `fixture-ci does not support lane ${JSON.stringify(lane)} with trigger ${JSON.stringify(trigger)}` }],
    };
  }
  const gateResult = runCapabilityGate(profile ?? {}, environmentEvidence ?? {});
  const decision = activationDecision(gateResult);
  if (!decision.activate) {
    return { rendered: false, state: "deferred", blockers: decision.blockers };
  }
  const config = renderConfig({ ...workflowConfig, lane, trigger });
  return { rendered: true, state: "activatable", config, path: "fixture-ci.json" };
}

// --- point 5 -----------------------------------------------------------------

export function emitReporting(junitXmlText) {
  const parsed = parseJUnitXML(junitXmlText);
  const summary = summarizeJUnit(parsed);
  const annotations = parsed.tests
    .filter((t) => t.status === "failed" || t.status === "error")
    .map((t) => ({ title: `${t.classname ? `${t.classname} > ` : ""}${t.name}`, message: t.message ?? "failed" }));
  return { summary, annotations };
}

export function emitFailureBundle(diagnostics, opts) {
  return buildDiagnosticsManifest(diagnostics, opts);
}

// --- point 6 -----------------------------------------------------------------

export function resolveRunReference(env = {}) {
  return {
    repository: env.FIXTURE_REPOSITORY,
    sourceCommit: env.FIXTURE_SHA,
    workflow: {
      provider: PROVIDER_IDENTITY,
      workflowFile: "fixture-ci.json",
      runId: env.FIXTURE_RUN_ID,
      runAttempt: env.FIXTURE_RUN_ATTEMPT,
    },
  };
}

// --- point 7 -----------------------------------------------------------------

/**
 * Deliberately independent of github-actions-workflow.mjs's
 * `checkWorkflowHardening`: this is a second, JSON-shaped implementation of
 * "does the rendered configuration actually enforce the Execution Profile",
 * proving the neutral contract does not secretly require YAML text
 * scanning.
 */
export function checkGeneratedConfigEnforcesProfile(profile, configText) {
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return { valid: false, errors: [{ code: "config.unparseable", message: "fixture-ci configuration must be valid JSON" }] };
  }

  const errors = [];
  if (parsed.permissions !== "read-only") {
    errors.push({ code: "permissions.not-minimal", message: `fixture-ci config must declare read-only permissions (found ${JSON.stringify(parsed.permissions)})` });
  }
  if (parsed.persistCredentials !== false) {
    errors.push({ code: "checkout.persist-credentials-not-disabled", message: "fixture-ci config must not persist credentials" });
  }
  if (typeof parsed.actionPin !== "string" || !parsed.actionPin.includes("exact-sha")) {
    errors.push({ code: "actions.not-sha-pinned", message: "fixture-ci config must pin actions to an exact, immutable reference" });
  }
  if (parsed.trigger === "pull_request_target") {
    errors.push({ code: "trigger.unsafe-pull-request-target", message: "fixture-ci config must never use an unsafe pull_request_target-equivalent trigger" });
  }
  if ((parsed.trigger === "pull_request" || parsed.trigger === "pull_request_target") && parsed.identity === "privileged") {
    errors.push({
      code: "privileged-lane.low-trust-trigger-with-privileged-identity",
      message: "a privileged identity must never run in response to fixture-ci's low-trust pull_request-equivalent trigger",
    });
  }
  if (parsed.lane === "required" && parsed.gating !== "blocking") {
    errors.push({ code: "required.continue-on-error-present", message: "a required fixture-ci lane must actually gate" });
  }
  if (parsed.lane === "advisory" && parsed.gating !== "advisory") {
    errors.push({ code: "advisory.not-continue-on-error", message: "an advisory fixture-ci lane must never gate" });
  }

  return { valid: errors.length === 0, errors };
}

// --- the neutral-contract-conforming adapter object -------------------------

export const adapter = Object.freeze({
  identity: PROVIDER_IDENTITY,
  detect,
  deriveCapabilityEvidence,
  planLane,
  supportedTriggers: SUPPORTED_TRIGGERS,
  deferredTriggers: DEFERRED_TRIGGERS,
  supportedLanes: SUPPORTED_LANES,
  deferredLanes: DEFERRED_LANES,
  emitReporting,
  emitFailureBundle,
  resolveRunReference,
  checkGeneratedConfigEnforcesProfile,
});
