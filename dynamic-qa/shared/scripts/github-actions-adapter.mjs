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
  checkActionPinsResolved,
} from "./github-actions-workflow.mjs";
import { checkActionAndReusableWorkflowAllowlist, checkPrivilegedLaneRefusesLowTrustBridge } from "./workflow-hardening.mjs";
import { parseJUnitXML, summarizeJUnit } from "./junit-report.mjs";
import { buildDiagnosticsManifest } from "./diagnostics-scrub.mjs";

// #156 (provider-neutral adapter contract, DESIGN-dynamic-qa-spec.md §9):
// everything below this point through the end of the file expresses this
// SAME adapter — no behaviour of #153/#154/#155's functions above is
// changed — as an implementation of the neutral contract
// (adapter-contract.mjs), so that a conformance suite written against the
// contract (adapter-conformance.mjs) can run identically against this
// adapter or any other. Two things are genuinely new here, not just
// aggregation:
//
//   - `checkGeneratedConfigEnforcesProfile` (point 7) now ALSO composes
//     #155's `checkActionAndReusableWorkflowAllowlist` and
//     `checkPrivilegedLaneRefusesLowTrustBridge` — both were built by #155
//     but never wired into this adapter's own enforcement gate (an open
//     seam #155's own notes named for this ticket). Every existing
//     rendered lane already satisfies both (the only actions ever emitted
//     are the two DEFAULT_ALLOWLISTED_ACTIONS entries, pinned to the exact
//     SHAs that allowlist approves, and no lane ever declares
//     pull_request_target/workflow_run alongside a privileged job) — so no
//     existing test's expected result changes. What changes is that a
//     configuration violating either property, which previously slipped
//     past this adapter's own enforcement check, is now caught. This is a
//     security strengthening the ticket requires ("portability must not
//     weaken security... the contract must make the security obligations
//     explicit and checkable"), not a behaviour change to anything this
//     adapter currently renders.
//   - `planLane`, `emitReporting`, `emitFailureBundle`, and the exported
//     `adapter` object are new, additive surface: `planLane` dispatches to
//     the same four `plan*` functions already defined above (point 3);
//     `emitReporting`/`emitFailureBundle` close the point-5 seam #155's
//     notes explicitly left open ("no caller wires
//     prepareDiagnosticForUpload/buildDiagnosticsManifest into a real
//     generated workflow step... #156") by reusing junit-report.mjs and
//     diagnostics-scrub.mjs directly — neither is a second detector.

export const PROVIDER_IDENTITY = "github-actions";

// Point 4: #153 built only the safe pull-request trigger. #154 completes
// the set — DESIGN-dynamic-qa-spec.md §8 names exactly four Provider-native
// CI exposures and all four are now real, tested renderers/plan functions;
// nothing is deferred any longer.
export const SUPPORTED_TRIGGERS = Object.freeze(["pull_request", "schedule", "workflow_dispatch", "merge_group"]);
export const DEFERRED_TRIGGERS = Object.freeze([]);

// #156: this adapter renders ADVISORY lanes (pull_request/schedule/
// workflow_dispatch) and one REQUIRED lane (merge_group). Quarantine-lane
// rendering remains exactly the open seam #153/#154's notes already named
// ("required-lane and quarantine-lane rendering... quarantine-lane
// rendering, remain open for a later ticket") — declared honestly here
// rather than silently omitted, mirroring DEFERRED_TRIGGERS above.
export const SUPPORTED_LANES = Object.freeze(["advisory", "required"]);
export const DEFERRED_LANES = Object.freeze(["quarantine"]);

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

function composeLanePlan({ renderer, lane, trigger, defaultWorkflowPath, profile, environmentEvidence, workflowConfig, workflowPath }) {
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
  return composeLanePlan({
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
  return composeLanePlan({
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
  return composeLanePlan({
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
 *
 * #156: ALSO composes #155's `checkActionAndReusableWorkflowAllowlist`
 * (immutable pins AND an explicit approval, not pinning alone) and
 * `checkPrivilegedLaneRefusesLowTrustBridge` (privileged/low-trust
 * separation — no "pwn request" bridge) — both existed since #155 but were
 * never wired into this, the adapter's sole point-7 enforcement gate, until
 * now. Every lane this adapter renders already satisfies both (see the
 * module header note), so no existing caller's expected result changes;
 * what changes is that a configuration violating either property no longer
 * slips past this check.
 */
export function checkGeneratedConfigEnforcesProfile(profile, yamlText, { lane = "advisory", trigger = "pull_request" } = {}) {
  const hardening = checkWorkflowHardening(yamlText, { lane, trigger });
  const allowlist = checkActionAndReusableWorkflowAllowlist(yamlText);
  const bridge = checkPrivilegedLaneRefusesLowTrustBridge(yamlText);
  const errors = [...hardening.errors, ...allowlist.errors, ...bridge.errors];

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

// --- finding #3, closed: the pre-rollout shippability gate -----------------
//
// `plan*`/`planLane` render a REVIEWABLE draft workflow — a human needs to
// see the generated YAML in order to review it (including its action pins)
// in the first place, so those functions are deliberately NOT blocked by
// unresolved action pins. `checkShippable` is the separate, additional gate
// a human/CI must run before a rendered workflow may actually be committed
// to a real repository or registered as a required check: it composes
// `checkGeneratedConfigEnforcesProfile` (point 7) with
// `checkActionPinsResolved` (github-actions-workflow.mjs, finding #3) so an
// unresolved placeholder pin can never silently ship alongside "the
// configuration otherwise looks fine." Returns `{ valid, errors }`; never
// throws.
export function checkShippable(profile, yamlText, options = {}) {
  const enforcement = checkGeneratedConfigEnforcesProfile(profile, yamlText, options);
  const pins = checkActionPinsResolved();
  return { valid: enforcement.valid && pins.valid, errors: [...enforcement.errors, ...pins.errors] };
}

// --- #156: the neutral-contract surface (points 3, 5, and the aggregate) ---

const LANE_PLANNERS = Object.freeze({
  advisory: {
    pull_request: planAdvisoryPullRequestLane,
    schedule: planNightlyFullSuiteLane,
    workflow_dispatch: planManualTriggerLane,
  },
  required: {
    merge_group: planMergeGroupLane,
  },
});

/**
 * Point 3, generalized: a single `{ lane, trigger, ... }`-shaped entry point
 * a contract-neutral caller (or the conformance suite) can use without
 * knowing this adapter's four separately-named `plan*` functions exist.
 * Dispatches to the exact same function `planAdvisoryPullRequestLane` /
 * `planNightlyFullSuiteLane` / `planManualTriggerLane` / `planMergeGroupLane`
 * would have been called directly — no duplicated Capability Gate/renderer
 * composition — and normalizes the result's `yaml` field to `config`
 * (neutral naming: another provider's rendered configuration need not be
 * YAML at all), while every direct caller of the original four functions is
 * unaffected. An unknown `lane`/`trigger` pair (including `"quarantine"`,
 * DEFERRED_LANES above) is refused as a deferred, blocked plan — never a
 * silent no-op — naming the exact unsupported pair.
 */
export function planLane({ lane = "advisory", trigger = "pull_request", profile, environmentEvidence, workflowConfig, workflowPath } = {}) {
  const planner = LANE_PLANNERS[lane]?.[trigger];
  if (typeof planner !== "function") {
    return {
      rendered: false,
      state: "deferred",
      blockers: [
        {
          category: "lane",
          capability: `lane:${lane}/trigger:${trigger}`,
          message: `this adapter does not support lane ${JSON.stringify(lane)} with trigger ${JSON.stringify(trigger)} — supported lanes are ${JSON.stringify(SUPPORTED_LANES)} (deferred: ${JSON.stringify(DEFERRED_LANES)}), supported triggers are ${JSON.stringify(SUPPORTED_TRIGGERS)}`,
        },
      ],
    };
  }
  const result = planner({ profile, environmentEvidence, workflowConfig, workflowPath });
  if (!result.rendered) return result;
  const { yaml, ...rest } = result;
  return { ...rest, config: yaml };
}

/**
 * Point 5 (reporting half). Reuses junit-report.mjs's `parseJUnitXML` /
 * `summarizeJUnit` — the exact same primitives
 * github-actions-annotations-cli.mjs and github-actions-summary-cli.mjs
 * already use to publish native annotations and the job summary — rather
 * than a second JUnit reader. Returns `{ summary, annotations }`: `summary`
 * is the same total/passed/failed/errors/skipped/verdict shape a Result
 * Envelope binding entry is built from; `annotations` is one
 * `{ title, message }` entry per failed/errored test case, the same
 * information the annotations CLI turns into `::error::` workflow commands.
 * Pure function of the JUnit XML text — no filesystem access, so it is
 * usable outside a real GitHub Actions run.
 */
export function emitReporting(junitXmlText) {
  const parsed = parseJUnitXML(junitXmlText);
  const summary = summarizeJUnit(parsed);
  const annotations = parsed.tests
    .filter((t) => t.status === "failed" || t.status === "error")
    .map((t) => ({ title: `${t.classname ? `${t.classname} > ` : ""}${t.name}`, message: t.message ?? "failed" }));
  return { summary, annotations };
}

/**
 * Point 5 (strict failure-bundle half). Composes #155's
 * `buildDiagnosticsManifest` directly — the sole fail-safe scrub/suppress
 * gate (`prepareDiagnosticForUpload`) this bundle is built from — rather
 * than re-implementing scrubbing, retention, or the exact-artifact-list
 * rule here. This closes the seam #155's own notes named for this ticket:
 * "no caller wires... buildDiagnosticsManifest into a real generated
 * workflow step [or] the Failure Evidence Bundle."
 */
export function emitFailureBundle(diagnostics, opts) {
  return buildDiagnosticsManifest(diagnostics, opts);
}

/**
 * The neutral-contract-conforming adapter object (adapter-contract.mjs).
 * Every property below is either one of this module's own exports, passed
 * through unchanged, or one of the two thin compositions just above — this
 * object adds no new decision logic of its own, it only names the shape a
 * provider-neutral caller (or the conformance suite,
 * adapter-conformance.mjs) can rely on existing.
 */
export const adapter = Object.freeze({
  identity: PROVIDER_IDENTITY,
  detect: detectProviderConfiguration,
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
