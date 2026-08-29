// dynamic-qa/shared/scripts/github-actions-adapter.mjs
//
// The named GitHub Actions provider adapter (#153), implementing the seven
// points DESIGN-dynamic-qa-spec.md §9 requires of every provider-neutral CI
// adapter contract. This module is the decision layer; it composes #150's
// Capability Gate (capability-gate.mjs), #151's Trust Zones
// (trust-zones.mjs), and this ticket's own renderer
// (github-actions-workflow.mjs) — it re-validates nothing those modules
// already validate.
//
// Contract point-by-point:
//   1. detectProviderConfiguration    — read-only inventory of what already
//                                        exists under .github/workflows/.
//   2. deriveCapabilityEvidence        — shapes what a GitHub-hosted PR
//                                        runner concretely proves into the
//                                        environment-evidence shape
//                                        capability-gate.mjs expects.
//   3. planAdvisoryPullRequestLane     — renders the advisory lane WITHOUT
//                                        changing policy itself: it never
//                                        decides advisory vs. required, it
//                                        only refuses to render at all when
//                                        the Capability Gate has open
//                                        blockers.
//   4. SUPPORTED_TRIGGERS              — pull_request only, this ticket's
//                                        scope; nightly/manual/merge-group
//                                        are an explicit seam, not built.
//   5. (JUnit/annotations/summary)     — github-actions-workflow.mjs's
//                                        renderer already emits all three
//                                        via this bundle's own scripts.
//   6. resolveRunReference             — normalizes GitHub's own run
//                                        environment variables into the
//                                        Result Envelope's identity fields.
//   7. checkGeneratedConfigEnforcesProfile — validates that rendered
//                                        configuration text actually
//                                        enforces the Execution Profile,
//                                        reusing github-actions-workflow.mjs's
//                                        checkWorkflowHardening rather than
//                                        a second hand-rolled scan.
//
// The Node-runtime caveat (run brief, explicit): Node is guaranteed on a
// developer machine and on a GitHub-hosted runner, but NOT automatically on
// a minimal self-hosted runner. This adapter therefore refuses to treat
// Node as ambient: it requires the Execution Profile to name a Node-runtime
// capability explicitly (NODE_RUNTIME_CAPABILITY) among its
// evidence.capabilities, and requires the environment to report that exact
// capability "met" — exactly like every other named capability #150's
// generic Capability Gate already checks. What is adapter-specific is that
// this module additionally refuses to even attempt planning a lane for a
// profile that never named the capability at all (a profile author could
// otherwise omit it and the generic gate would have nothing to check) —
// see checkNodeRuntimeCapabilityDeclared. A missing/unmet Node runtime is
// therefore always a named Safety Blocker and a deferred flow, never a
// silent skip: there is no code path here that renders a workflow while
// this blocker is open.

import { runCapabilityGate, activationDecision } from "./capability-gate.mjs";
import { renderAdvisoryPullRequestLane, checkWorkflowHardening } from "./github-actions-workflow.mjs";

export const PROVIDER_IDENTITY = "github-actions";

// Point 4: only the safe pull-request trigger is built by this ticket.
// Nightly full-suite, manual/provider-API trigger, and merge-group are
// DESIGN-dynamic-qa-spec.md §8's other three required Provider-native CI
// exposures — real, named seams for a later ticket, not silently folded
// into "pull_request" and not invented here as generic placeholder YAML.
export const SUPPORTED_TRIGGERS = Object.freeze(["pull_request"]);
export const DEFERRED_TRIGGERS = Object.freeze(["schedule (nightly)", "workflow_dispatch (manual/API)", "merge_group"]);

export const NODE_RUNTIME_CAPABILITY = "runtime.node-available";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// --- 1. detect and inventory current provider/configuration ---------------

/**
 * Read-only inventory of what already exists under `.github/workflows/`.
 * `existingWorkflowFilenames` is caller-supplied (the caller already listed
 * the directory — this module touches no real filesystem, mirroring every
 * other deterministic-core module's caller-supplied-evidence pattern).
 * Nothing is parsed beyond filenames: dynamic-qa's own restricted-YAML
 * parser is deliberately scoped to dynamic-qa's own schemas, not arbitrary
 * third-party workflow YAML, so full semantic inventory of an existing
 * workflow's content is an explicit seam, not attempted here.
 */
export function detectProviderConfiguration(existingWorkflowFilenames = [], { defaultWorkflowPath = ".github/workflows/dynamic-qa.yml" } = {}) {
  const filenames = Array.isArray(existingWorkflowFilenames) ? existingWorkflowFilenames : [];
  return {
    provider: PROVIDER_IDENTITY,
    existingWorkflows: filenames,
    hasDynamicQaWorkflow: filenames.includes(defaultWorkflowPath.split("/").pop()) || filenames.includes(defaultWorkflowPath),
    defaultWorkflowPath,
  };
}

// --- 2. prove runner/identity/environment/egress/... capabilities ---------

/**
 * Shapes what a GitHub Actions pull_request job concretely proves — for an
 * UNREVIEWED PR (the low-trust-ci Trust Zone, trust-zones.mjs) — into the
 * environment-evidence object capability-gate.mjs's `runCapabilityGate`
 * expects. This is honest evidence a real `pull_request`-triggered job (not
 * `pull_request_target`) genuinely has: no secrets, no OIDC, no write
 * token, a disposable hosted VM, and (this ticket's caveat) Node only when
 * `nodeRuntimeAvailable` is asserted true by the caller — this module does
 * not itself detect whether a self-hosted runner can actually reach the
 * Node download; that is real infrastructure knowledge only a real
 * inventory step (a later ticket) can supply.
 */
export function deriveCapabilityEvidence({
  runnerClass,
  sandbox = "vm",
  enforcedRead = [],
  enforcedWrite = [],
  enforcedCommands = [],
  enforcedBoundaryIds = [],
  resources,
  nodeRuntimeAvailable = false,
  extraEvidence = [],
} = {}) {
  return {
    paths: { enforcedRead, enforcedWrite },
    commands: { enforced: enforcedCommands },
    environments: { runnerClass, disposable: true, sandbox },
    resources: resources ?? {},
    // An unreviewed pull_request job's GITHUB_TOKEN is the only identity
    // present, and it is never in a profile's approvedNonProduction list by
    // name here — a caller wiring a real profile supplies its own approved
    // identifier; this adapter never invents one to "make the gate pass".
    identities: { active: [] },
    network: { mode: "none" },
    effects: { enforcedBoundaryIds },
    evidence: [
      { capability: NODE_RUNTIME_CAPABILITY, status: nodeRuntimeAvailable ? "met" : "unmet" },
      ...extraEvidence,
    ],
  };
}

function profileDeclaresCapability(profile, capabilityName) {
  const list = Array.isArray(profile?.evidence?.capabilities) ? profile.evidence.capabilities : [];
  return list.some((entry) => entry?.capability === capabilityName);
}

/**
 * Adapter-specific pre-check: refuses to even attempt planning a lane for a
 * profile that never named the Node-runtime capability at all. #150's
 * generic Capability Gate only checks a capability that IS named; a profile
 * author omitting it entirely would otherwise sail through unblocked. This
 * function makes the omission itself a named Safety Blocker.
 */
export function checkNodeRuntimeCapabilityDeclared(profile) {
  if (profileDeclaresCapability(profile, NODE_RUNTIME_CAPABILITY)) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: [
      {
        category: "evidence",
        capability: NODE_RUNTIME_CAPABILITY,
        message:
          "the Execution Profile does not declare a Node-runtime capability — a minimal self-hosted GitHub Actions runner is not guaranteed to ship Node the way a developer machine or a GitHub-hosted runner is; the GitHub Actions adapter refuses to plan a lane without this being an explicit, checked requirement",
      },
    ],
  };
}

// --- 3. render the advisory lane without changing policy itself -----------

/**
 * The single planning entry point: composes the Node-runtime declaration
 * check, the Capability Gate, and the renderer. Never returns a rendered
 * workflow while any blocker is open — mirrors capability-gate.mjs's own
 * `activationDecision`: there is no default-open path here.
 *
 * Returns, on success: `{ rendered: true, state: "activatable", yaml,
 * path }`. On any blocker (including the missing-Node-runtime-declaration
 * case above): `{ rendered: false, state: "deferred", blockers }` — a
 * deferred flow, never a silent skip; the caller sees exactly why.
 */
export function planAdvisoryPullRequestLane({ profile, environmentEvidence, workflowConfig, workflowPath = ".github/workflows/dynamic-qa.yml" } = {}) {
  const runtimeDeclared = checkNodeRuntimeCapabilityDeclared(profile);
  const gateResult = runCapabilityGate(profile ?? {}, environmentEvidence ?? {});
  const decision = activationDecision(gateResult, runtimeDeclared.errors);

  if (!decision.activate) {
    return { rendered: false, state: "deferred", blockers: decision.blockers };
  }

  const yaml = renderAdvisoryPullRequestLane(workflowConfig);
  const enforcement = checkGeneratedConfigEnforcesProfile(profile, yaml);
  if (!enforcement.valid) {
    // Belt-and-braces: the renderer and this adapter agreeing to render
    // something that then fails its own post-render enforcement check
    // would be an internal bug, not a caller input problem — fail closed
    // rather than ship it.
    return {
      rendered: false,
      state: "deferred",
      blockers: enforcement.errors.map((e) => ({ category: "evidence", capability: e.code ?? "config-enforcement", message: e.message })),
    };
  }

  return { rendered: true, state: "activatable", yaml, path: workflowPath };
}

// --- 6. resolve a provider run reference into immutable evidence -----------

/**
 * Normalizes GitHub Actions' own run environment (GITHUB_REPOSITORY,
 * GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SERVER_URL) into the
 * identity fields a Result Envelope (result-envelope.mjs) requires. Pure
 * function of its input — `env` is caller-supplied (typically
 * `process.env` from inside a real Action run), never read directly here,
 * so this is Tier 1 testable without a real GitHub Actions environment.
 */
export function resolveRunReference(env = {}) {
  const serverUrl = env.GITHUB_SERVER_URL ?? "https://github.com";
  const url =
    env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${serverUrl}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  return {
    repository: env.GITHUB_REPOSITORY,
    sourceCommit: env.GITHUB_SHA,
    workflow: {
      provider: PROVIDER_IDENTITY,
      workflowFile: env.GITHUB_WORKFLOW_REF ? env.GITHUB_WORKFLOW_REF.split("@")[0].split("/").slice(3).join("/") : undefined,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      ...(url ? { url } : {}),
    },
  };
}

// --- 7. validate that generated configuration enforces the profile --------

/**
 * Point 7 of the adapter contract. Reuses checkWorkflowHardening (this
 * ticket's renderer module) rather than a second hand-rolled scan, and adds
 * one adapter-specific cross-check: the rendered runner label must be the
 * exact `runnerClass` the profile declares — a renderer silently rendering
 * a different runner than the profile named would make the profile a
 * decoration rather than an enforced contract.
 */
export function checkGeneratedConfigEnforcesProfile(profile, yamlText) {
  const hardening = checkWorkflowHardening(yamlText);
  const errors = [...hardening.errors];

  const runnerClass = profile?.environments?.runnerClass;
  if (typeof runnerClass === "string" && runnerClass.trim() !== "") {
    const runsOnMatch = /^\s*runs-on:\s*(\S+)/m.exec(yamlText);
    const rendered = runsOnMatch ? runsOnMatch[1] : undefined;
    if (rendered !== runnerClass) {
      errors.push({
        code: "config.runner-class-mismatch",
        message: `rendered runs-on (${JSON.stringify(rendered ?? null)}) does not match the Execution Profile's required runnerClass (${JSON.stringify(runnerClass)})`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
