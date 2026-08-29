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
import { checkHardSecurityInvariant } from "./trust-zones.mjs";
import {
  renderAdvisoryPullRequestLane,
  renderNightlyFullSuiteLane,
  renderManualTriggerLane,
  renderMergeGroupLane,
  checkWorkflowHardening,
} from "./github-actions-workflow.mjs";

export const PROVIDER_IDENTITY = "github-actions";

// Point 4: #153 built only the safe pull-request trigger. #154 completes
// the set — DESIGN-dynamic-qa-spec.md §8 names exactly four Provider-native
// CI exposures and all four are now real, tested renderers/plan functions;
// nothing is deferred any longer.
export const SUPPORTED_TRIGGERS = Object.freeze(["pull_request", "schedule", "workflow_dispatch", "merge_group"]);
export const DEFERRED_TRIGGERS = Object.freeze([]);

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

// --- #154: trust asymmetry across the four lanes, modeled explicitly ------
//
// DESIGN-dynamic-qa-spec.md §11 zone 3 ("low-trust-ci") names "ordinary
// PR/nightly runs" together, but that is not the whole picture the ticket
// asks for: "a nightly or merge-group run on reviewed base-branch content
// is not the same trust context as an unreviewed PR." trust-zones.mjs
// already carries the vocabulary for this
// (`UNTRUSTED_CONTENT_SOURCES`/`"reviewed-base-branch"`,
// `checkHardSecurityInvariant`) — this function is the one place that
// decides which `contentSource` string each of the four triggers maps to,
// so the classification is an explicit, checkable table rather than an
// assumption buried in a renderer.
//
//   - `pull_request`: an unreviewed fork/branch head — untrusted (`"branch"`).
//   - `workflow_dispatch` (manual/provider): a caller-selected ref. Even
//     though the *requester* is deliberate (a coding agent, not an
//     attacker), the ref being exercised is not guaranteed to be reviewed
//     base-branch content — a dispatch can target any branch. Classified
//     untrusted (`"branch"`) for the same reason a manual trigger must not
//     be allowed to change policy: this adapter cannot tell, from the
//     dispatch event alone, that the content is any more trustworthy than
//     an ordinary branch.
//   - `schedule` (nightly): runs against the default branch tip —
//     already-reviewed content. Classified trusted (`"reviewed-base-branch"`).
//   - `merge_group`: every constituent commit is a PR that already passed
//     required review to enter the merge queue. Classified trusted
//     (`"reviewed-base-branch"`).
//
// This classification genuinely changes what `checkHardSecurityInvariant`
// would PERMIT for the trusted lanes (see github-actions-adapter.test.mjs
// for a test proving an identical permissive identity/paths/network shape
// is accepted for schedule/merge_group and rejected for
// pull_request/workflow_dispatch) — but every renderer in
// github-actions-workflow.mjs still uses the same minimal identity
// regardless, because none of these lanes needs more than checkout + run +
// report. Trust classification says what would be allowed; least privilege
// says none of the extra room is used.
export function classifyLaneContentSource(triggerName) {
  switch (triggerName) {
    case "schedule":
    case "merge_group":
      return "reviewed-base-branch";
    case "pull_request":
    case "workflow_dispatch":
      return "branch";
    default:
      // Fail closed: an unrecognized trigger is never assumed trusted.
      return "branch";
  }
}

/**
 * Convenience wrapper: runs `checkHardSecurityInvariant` with the
 * `contentSource` `classifyLaneContentSource` derives for `triggerName`,
 * against caller-supplied `credentials`/`paths`/`network` (Execution
 * Profile-shaped, mirroring trust-zones.mjs's own parameter shape). Exists
 * so a caller/test can assert on the lane-specific trust outcome without
 * re-deriving the classification inline every time.
 */
export function checkLaneTrustInvariant(triggerName, { credentials, paths, network } = {}) {
  return checkHardSecurityInvariant({ contentSource: classifyLaneContentSource(triggerName), credentials, paths, network });
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

// --- #154: the three completing lanes --------------------------------------
//
// Each mirrors `planAdvisoryPullRequestLane`'s exact composition (Node-
// runtime declaration check -> Capability Gate -> `activationDecision` ->
// render -> post-render enforcement), so the "no default-open path"
// invariant holds identically for every lane, not just the original PR
// one. Only the renderer called, the default `workflowPath`, and the
// `lane`/`trigger` pair passed to `checkGeneratedConfigEnforcesProfile`
// differ.

function planLane({ renderer, lane, trigger, defaultWorkflowPath, profile, environmentEvidence, workflowConfig, workflowPath }) {
  const runtimeDeclared = checkNodeRuntimeCapabilityDeclared(profile);
  const gateResult = runCapabilityGate(profile ?? {}, environmentEvidence ?? {});
  const decision = activationDecision(gateResult, runtimeDeclared.errors);

  if (!decision.activate) {
    return { rendered: false, state: "deferred", blockers: decision.blockers };
  }

  const yaml = renderer(workflowConfig);
  const enforcement = checkGeneratedConfigEnforcesProfile(profile, yaml, { lane, trigger });
  if (!enforcement.valid) {
    return {
      rendered: false,
      state: "deferred",
      blockers: enforcement.errors.map((e) => ({ category: "evidence", capability: e.code ?? "config-enforcement", message: e.message })),
    };
  }

  return { rendered: true, state: "activatable", yaml, path: workflowPath ?? defaultWorkflowPath };
}

/**
 * Plans the nightly full-suite lane (ADVISORY — a scheduled run gates no
 * merge). Same "no default-open path" composition as
 * `planAdvisoryPullRequestLane`.
 */
export function planNightlyFullSuiteLane({ profile, environmentEvidence, workflowConfig, workflowPath } = {}) {
  return planLane({
    renderer: renderNightlyFullSuiteLane,
    lane: "advisory",
    trigger: "schedule",
    defaultWorkflowPath: ".github/workflows/dynamic-qa-nightly.yml",
    profile,
    environmentEvidence,
    workflowConfig,
    workflowPath,
  });
}

/**
 * Plans the manual/provider-API trigger lane (ADVISORY — a requested run
 * produces evidence, it never itself gates a merge). The renderer declares
 * no `workflow_dispatch` inputs, so a request cannot influence policy;
 * `checkGeneratedConfigEnforcesProfile` additionally verifies that via
 * `checkWorkflowHardening`'s `dispatch.inputs-not-permitted` check.
 */
export function planManualTriggerLane({ profile, environmentEvidence, workflowConfig, workflowPath } = {}) {
  return planLane({
    renderer: renderManualTriggerLane,
    lane: "advisory",
    trigger: "workflow_dispatch",
    defaultWorkflowPath: ".github/workflows/dynamic-qa-manual.yml",
    profile,
    environmentEvidence,
    workflowConfig,
    workflowPath,
  });
}

/**
 * Plans the merge-group lane (REQUIRED — its whole purpose is to gate the
 * merge queue's required checks, spec §8 / User Story 68). `lane:
 * "required"` flips `checkWorkflowHardening`'s gating check: the rendered
 * job must NOT set `continue-on-error`, unlike every other lane this
 * adapter plans.
 */
export function planMergeGroupLane({ profile, environmentEvidence, workflowConfig, workflowPath } = {}) {
  return planLane({
    renderer: renderMergeGroupLane,
    lane: "required",
    trigger: "merge_group",
    defaultWorkflowPath: ".github/workflows/dynamic-qa-merge-group.yml",
    profile,
    environmentEvidence,
    workflowConfig,
    workflowPath,
  });
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
 *
 * `options.lane`/`options.trigger` (#154, additive — both default to
 * `#153`'s original values, `"advisory"`/`"pull_request"`, so every
 * existing caller is unaffected) are forwarded to `checkWorkflowHardening`
 * so each of the four lanes is checked against its own correct gating and
 * trigger expectations rather than the PR lane's.
 */
export function checkGeneratedConfigEnforcesProfile(profile, yamlText, { lane = "advisory", trigger = "pull_request" } = {}) {
  const hardening = checkWorkflowHardening(yamlText, { lane, trigger });
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
