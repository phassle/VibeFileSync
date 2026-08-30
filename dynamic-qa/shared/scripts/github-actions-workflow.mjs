// dynamic-qa/shared/scripts/github-actions-workflow.mjs
//
// Ticket #153: GitHub Actions is dynamic-qa's first named provider adapter
// (DESIGN-dynamic-qa-spec.md §9's provider-neutral contract point 3: "render
// advisory, required, and quarantine lanes without changing policy itself").
// This module is the pure rendering half: it turns a small caller-supplied
// descriptor into workflow YAML text for the advisory pull-request lane.
// github-actions-adapter.mjs (same ticket) is the adapter-contract half that
// decides *whether* to render (Capability Gate, runtime evidence) and
// resolves provider run references; this module never makes that decision,
// it only renders and it only verifies its own output.
//
// Brownfield Bindings enter CI advisory during burn-in (spec §8) so a new
// suite cannot destabilise the existing merge gate. The rendered job uses
// `continue-on-error: true` at the JOB level — GitHub Actions' own
// documented mechanism for "a job may fail internally, but the workflow run
// (and therefore any branch-protection required-check keyed on it) never
// fails because of it" — never a required-check policy change, never a
// silent test skip.
//
// No generic YAML serializer is used (per the run brief's deterministic-core
// decision: no third-party dependency, restricted subset only). The shape
// this module produces is small and fixed, so a plain template is simpler
// and more auditable than a general serializer would be; there is nothing
// here for a generic serializer to get "more right" than a template already
// does.
//
// Hardening is NOT merely "the renderer only knows how to write it safely" —
// checkWorkflowHardening below is a separate, reusable detector that scans
// arbitrary rendered/mutated workflow YAML text and names, individually,
// which hardening property (if any) is missing. It exists for two reasons:
// it is this ticket's own Tier 1 proof that each hardening property is
// independently detected when violated (not just "the happy path looks
// fine"), and it is the concrete implementation of provider-adapter contract
// point 7 ("validate that generated configuration enforces the Execution
// Profile") — a caller runs it against whatever text is about to be written
// to the repository, whether this module produced it or not.
//
// Node-runtime caveat (run brief, explicit): a customer's self-hosted runner
// is not guaranteed to ship Node the way a developer machine or a
// GitHub-hosted runner is. This renderer never assumes an ambient `node` on
// PATH — it always renders an explicit `actions/setup-node` step that
// installs a pinned Node version, so the runtime is a declared, visible part
// of the generated configuration rather than a silent assumption. Deciding
// *whether* the run may proceed at all when the adapter cannot even prove a
// runtime capability is github-actions-adapter.mjs's Safety Blocker, not
// this module's job — see that module for "a missing Node runtime is a
// Safety Blocker and a deferred flow, never a silent skip."

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

// --- immutable action pins -------------------------------------------------
//
// Full 40-character commit SHAs, never a floating tag (`@v4`) — a tag can be
// moved by its owner; a commit SHA cannot. This module has zero network
// access (the deterministic core's hard invariant) and therefore cannot
// itself resolve "the current commit behind tag v4.x" — the SHAs below are
// the pins shipped with this ticket. ASSUMPTION a later implementer/operator
// must re-verify before this generated workflow is ever enabled for a real
// repository: confirm each SHA still corresponds to the intended upstream
// release before first real rollout (the pilot, #171-175, is deliberately
// not being run yet, so nothing here has executed against real CI).
export const CHECKOUT_ACTION_SHA = "692973e3d937129bcbf40652eb9f2f61becf3332"; // actions/checkout, tagged v4.1.7 at authoring time — PLACEHOLDER, see ACTION_PINS below
export const SETUP_NODE_ACTION_SHA = "1e60f620b9541d16bece96c5465dc8ee9832be0a"; // actions/setup-node, tagged v4.0.3 at authoring time — PLACEHOLDER, see ACTION_PINS below
export const CHECKOUT_ACTION_REF = `actions/checkout@${CHECKOUT_ACTION_SHA}`;
export const SETUP_NODE_ACTION_REF = `actions/setup-node@${SETUP_NODE_ACTION_SHA}`;

// --- finding #3, closed: placeholder pins must be loud, never silent -------
//
// This module has zero network access (the deterministic core's own hard
// invariant), so it cannot itself resolve "the current commit behind tag
// v4.x" against the real upstream repository. The two SHAs above were never
// independently re-verified against a live GitHub API/checkout — they were
// authored as the commits believed to correspond to the named tags at
// authoring time, which is exactly the hazard: a security-critical
// immutable-pin list must never ship an unverified value silently.
//
// ACTION_PINS is the single, unmistakable source of truth for "has a human
// actually re-verified this SHA against the real upstream commit for the
// intended release." Each entry's `resolved` flag sits directly beside the
// SHA it describes — there is no separate list to fall out of sync with the
// pin it is about. It starts `false` for both pins and MUST stay that way
// until a human operator has done the following, for EACH pin, before this
// workflow is ever enabled against a real repository:
//
//   1. Look up the exact commit SHA GitHub's own release page (or
//      `git ls-remote --tags https://github.com/<owner>/<repo>`) reports for
//      the intended tag (currently targeted: actions/checkout v4.1.7,
//      actions/setup-node v4.0.3, or whichever later release is actually
//      being adopted).
//   2. Compare that SHA, byte for byte, against CHECKOUT_ACTION_SHA /
//      SETUP_NODE_ACTION_SHA above. Update the constant if it does not
//      match exactly.
//   3. Only then flip that pin's `resolved` entry below to `true`.
//
// `checkActionPinsResolved()` fails closed on the CURRENT, honest state
// (both still `false`) — see its own doc comment — and `checkShippable`
// (github-actions-adapter.mjs) refuses to call a rendered workflow
// shippable while any pin is unresolved. Neither planAdvisoryPullRequestLane
// nor any other renderer here is blocked from producing a REVIEWABLE draft
// (a human must be able to see the generated YAML in order to review and
// resolve the pins in the first place) — it is `checkShippable`, the
// pre-rollout gate, that refuses.
export const ACTION_PINS = Object.freeze({
  checkout: Object.freeze({ ref: "actions/checkout", sha: CHECKOUT_ACTION_SHA, resolved: false }),
  setupNode: Object.freeze({ ref: "actions/setup-node", sha: SETUP_NODE_ACTION_SHA, resolved: false }),
});

/**
 * Checks whether every named action pin in `pins` (defaults to this
 * module's own ACTION_PINS — the shipped, real pin set) has actually been
 * re-verified by a human (`resolved: true`). Returns `{ valid, errors }`;
 * `errors` names each still-unresolved pin individually, `{ code:
 * "actions.placeholder-pin-unresolved", message }`, so a caller (or a test)
 * can see exactly which pin(s) remain unverified rather than one generic
 * "something about the pins is wrong" flag. `pins` is accepted as an
 * argument (rather than always reading the module-level ACTION_PINS)
 * purely so a test can exercise the detector's own logic against a
 * hypothetical fully-resolved set without mutating the real, honest
 * placeholder state. Never throws.
 */
export function checkActionPinsResolved(pins = ACTION_PINS) {
  const errors = [];
  for (const [key, pin] of Object.entries(pins)) {
    if (pin.resolved !== true) {
      errors.push({
        code: "actions.placeholder-pin-unresolved",
        message: `ACTION_PINS.${key} (${pin.ref}@${pin.sha}) has not been re-verified by a human against the real upstream commit for its intended release — this pin must never be treated as shippable while it remains a placeholder`,
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

// --- safe PR events ---------------------------------------------------------
//
// `pull_request` runs with the fork PR's own restricted, read-only
// GITHUB_TOKEN and no repository secrets. `pull_request_target` runs with
// the BASE repository's token and secrets against code checked out from an
// untrusted fork — the canonical GitHub Actions privilege-escalation
// footgun. This adapter only ever emits `pull_request`; `pull_request_target`
// is named here only so checkWorkflowHardening can recognise and reject it
// by name if it ever appears in a workflow this function is asked to verify.
export const SAFE_PR_TRIGGER = "pull_request";
export const FORBIDDEN_PR_TRIGGER = "pull_request_target";

export const DEFAULT_BASE_BRANCHES = Object.freeze(["develop", "main"]); // matches this repo's own acceptance.yml convention
export const DEFAULT_TIMEOUT_MINUTES = 15;

/**
 * Renders the advisory pull-request lane workflow as YAML text.
 *
 * Required: `runsOn` (an existing runner label — this adapter introduces no
 * new infrastructure, per the ticket's acceptance criterion), `nodeVersion`
 * (an explicit pinned version string, e.g. "20" — never "lts/*"),
 * `testCommand` (the exact, deterministic command that runs only the
 * relevant Bindings — selecting *which* Bindings are relevant is impact-path
 * filtering, a caller/adapter concern this renderer does not itself decide),
 * `junitPath` (an exact file path, never a glob — "exact artifact lists" is
 * enforced by construction: this renderer has no parameter that accepts a
 * wildcard).
 *
 * Optional: `workflowName`, `baseBranches` (defaults to this repo's own
 * `develop`/`main` convention), `timeoutMinutes`, `driftGateScript`,
 * `annotationsScript`, `summaryScript` (all default to this bundle's own
 * shipped script paths).
 *
 * Fixed, non-configurable by design (there is no parameter for any of
 * these — hardening is not an opt-in flag a caller could accidentally leave
 * off): `permissions: contents: read` only, `persist-credentials: false` on
 * checkout, SHA-pinned actions, the `pull_request` trigger only, and
 * `continue-on-error: true` at the job level so an advisory failure can
 * never fail the workflow run or gate a merge.
 *
 * Returns the workflow YAML as a string.
 */
export function renderAdvisoryPullRequestLane(config = {}) {
  const {
    workflowName = "dynamic-qa advisory PR lane",
    baseBranches = DEFAULT_BASE_BRANCHES,
    runsOn,
    nodeVersion,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
    testCommand,
    junitPath,
    driftGateScript = "dynamic-qa/shared/scripts/drift-gate-cli.mjs",
    annotationsScript = "dynamic-qa/shared/scripts/github-actions-annotations-cli.mjs",
    summaryScript = "dynamic-qa/shared/scripts/github-actions-summary-cli.mjs",
  } = config;

  if (!nonEmptyString(runsOn)) throw new Error("renderAdvisoryPullRequestLane: runsOn is required (reuse an existing runner label)");
  if (!nonEmptyString(nodeVersion)) throw new Error("renderAdvisoryPullRequestLane: nodeVersion is required — the Node runtime must be declared explicitly, never assumed");
  if (!nonEmptyString(testCommand)) throw new Error("renderAdvisoryPullRequestLane: testCommand is required");
  if (!nonEmptyString(junitPath)) throw new Error("renderAdvisoryPullRequestLane: junitPath is required and must be an exact path, never a glob");
  if (junitPath.includes("*")) throw new Error("renderAdvisoryPullRequestLane: junitPath must be an exact path — wildcard artifact lists are forbidden");

  // An empty baseBranches array would collapse the trigger to "on all
  // branches", silently widening who this advisory lane runs for — guard
  // against that rather than trusting the caller passed a non-empty list.
  const branches = baseBranches.length > 0 ? baseBranches : DEFAULT_BASE_BRANCHES;
  const branchesYaml = branches.map((b) => `"${b}"`).join(", ");

  return `# Generated by dynamic-qa's GitHub Actions adapter (ticket #153). This is an
# advisory pull-request lane: it never gates the merge (continue-on-error:
# true at the job level). Do not hand-edit generated Bindings or this
# workflow without re-running dynamic-qa/qa-generate — drift will be
# detected and blocks before the next test run.
name: ${workflowName}

on:
  pull_request:
    branches: [${branchesYaml}]

permissions:
  contents: read

jobs:
  dynamic-qa-advisory:
    name: dynamic-qa advisory PR lane (does not gate the merge)
    runs-on: ${runsOn}
    timeout-minutes: ${timeoutMinutes}
    continue-on-error: true
    steps:
${renderCommonSteps({ nodeVersion, driftGateScript, annotationsScript, summaryScript, testCommand, junitPath, testStepName: "Run relevant deterministic Bindings" })}`;
}

// --- ticket #154: nightly, manual/provider, and merge-group lanes ---------
//
// DESIGN-dynamic-qa-spec.md §8 names four Provider-native CI exposures;
// #153 built the first (`pull_request`, above). This section adds the other
// three as independent, additive renderers — `renderAdvisoryPullRequestLane`
// above is untouched, per the run's "keep edits additive and localized,
// do not restructure existing functions" instruction, since #155 also
// edits this file concurrently.
//
// Trust asymmetry (modeled explicitly, not copied blindly from the PR
// lane): DESIGN-dynamic-qa-spec.md §11 zone 3 ("low-trust-ci") groups
// "ordinary PR/nightly runs" together, and github-actions-adapter.mjs's
// `classifyLaneContentSource` extends that classification to all four
// triggers via trust-zones.mjs's own vocabulary — `pull_request` and
// `workflow_dispatch` (manual/provider) content is `"branch"` (untrusted:
// a fork PR head, or a caller-selected ref a manual dispatch could point
// at anything), while `schedule` (nightly) and `merge_group` content is
// `"reviewed-base-branch"` (trusted: the default branch tip, or a merge
// queue's already-individually-approved constituent PRs). That
// classification genuinely changes what `checkHardSecurityInvariant` would
// PERMIT — but every lane this module renders still uses the same minimal
// identity (no secrets, no OIDC, no write permission, no privileged cache,
// no self-hosted runner) regardless of which zone its content classifies
// into, because none of these lanes has a functional need for more: they
// only check out, run deterministic tests, and publish JUnit/annotations/
// summary. Trust classification says what would be ALLOWED; least
// privilege says none of it should be USED. See
// github-actions-adapter.test.mjs for tests proving the asymmetry is real
// (an identical permissive config is accepted for schedule/merge_group
// content and rejected for pull_request/workflow_dispatch content) even
// though this renderer never exercises the extra room it would allow.
//
// What DOES differ per lane, deliberately:
//   - nightly (`schedule`) and manual (`workflow_dispatch`) are ADVISORY —
//     `continue-on-error: true` at the job level, exactly like the PR lane,
//     because neither is tied to a merge being gated (nightly runs against
//     an already-landed commit; a manual/provider run is requested
//     evidence, not enforcement). A failure is observed, never gates.
//   - merge-group (`merge_group`) is REQUIRED — it deliberately omits
//     `continue-on-error`, because the entire point of a merge-group
//     trigger is that its result gates the merge queue's required checks
//     (spec §8: "merge-group trigger when the repository uses a merge
//     queue" / User Story 68: "required checks continue gating queued
//     merges"). Job failure here must be a real, unmasked failure.
//   - manual (`workflow_dispatch`) declares NO inputs at all. This is how
//     "a coding agent can request deterministic regression evidence
//     without owning QA policy" is enforced structurally rather than by
//     convention: there is nothing in the trigger for a requester to set,
//     so a request cannot smuggle in a different command, runner,
//     permission, or identity than the one this renderer already fixed.
//     checkWorkflowHardening's `dispatch.inputs-not-permitted` check names
//     a violation of this if a caller adds inputs to mutated YAML.
//
// Sharding: none of these three renderers introduce a matrix strategy.
// Each still takes a single precomputed `testCommand` string, exactly
// #153's seam — "sharding only after measured runtime need" (spec §8,
// User Story 70) and no runtime measurement exists yet (the pilot,
// #171-175, has not run). Nightly's `testCommand` is expected to be the
// full active portfolio rather than an impacted subset, but that is a
// caller/adapter concern (which command string to pass in), not a
// sharding concern.

export const DEFAULT_NIGHTLY_CRON = "0 3 * * *"; // 03:00 UTC daily; a customer may override

function renderCommonSteps({ nodeVersion, driftGateScript, annotationsScript, summaryScript, testCommand, junitPath, testStepName }) {
  return `      - name: Checkout
        uses: ${CHECKOUT_ACTION_REF}
        with:
          persist-credentials: false

      - name: Set up Node (explicit runtime; never assumed ambient on the runner)
        uses: ${SETUP_NODE_ACTION_REF}
        with:
          node-version: "${nodeVersion}"

      - name: Deterministic drift gate (runs before tests)
        run: node ${driftGateScript}

      - name: ${testStepName}
        run: ${testCommand}

      - name: Publish native annotations
        if: always()
        run: node ${annotationsScript} ${junitPath}

      - name: Publish job summary
        if: always()
        run: node ${summaryScript} ${junitPath} >> "$GITHUB_STEP_SUMMARY"
`;
}

function validateCommonConfig(fnName, { runsOn, nodeVersion, testCommand, junitPath }) {
  if (!nonEmptyString(runsOn)) throw new Error(`${fnName}: runsOn is required (reuse an existing runner label)`);
  if (!nonEmptyString(nodeVersion)) throw new Error(`${fnName}: nodeVersion is required — the Node runtime must be declared explicitly, never assumed`);
  if (!nonEmptyString(testCommand)) throw new Error(`${fnName}: testCommand is required`);
  if (!nonEmptyString(junitPath)) throw new Error(`${fnName}: junitPath is required and must be an exact path, never a glob`);
  if (junitPath.includes("*")) throw new Error(`${fnName}: junitPath must be an exact path — wildcard artifact lists are forbidden`);
}

/**
 * Renders the nightly full-suite lane. ADVISORY (continue-on-error: true —
 * nothing merges off the back of a scheduled run, so nothing needs gating);
 * `testCommand` is expected to run the full active portfolio rather than an
 * impacted subset (a caller/adapter concern, not enforced by this
 * renderer). Same fixed hardening as the PR lane: minimal permissions,
 * `persist-credentials: false`, SHA-pinned actions, no secrets/OIDC/write/
 * privileged-cache/self-hosted-runner.
 */
export function renderNightlyFullSuiteLane(config = {}) {
  const {
    workflowName = "dynamic-qa nightly full suite",
    cron = DEFAULT_NIGHTLY_CRON,
    runsOn,
    nodeVersion,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
    testCommand,
    junitPath,
    driftGateScript = "dynamic-qa/shared/scripts/drift-gate-cli.mjs",
    annotationsScript = "dynamic-qa/shared/scripts/github-actions-annotations-cli.mjs",
    summaryScript = "dynamic-qa/shared/scripts/github-actions-summary-cli.mjs",
  } = config;

  validateCommonConfig("renderNightlyFullSuiteLane", { runsOn, nodeVersion, testCommand, junitPath });
  if (!nonEmptyString(cron)) throw new Error("renderNightlyFullSuiteLane: cron is required and must be a non-empty cron expression");

  return `# Generated by dynamic-qa's GitHub Actions adapter (ticket #154). This is the
# nightly full-suite lane: it observes broader critical-flow coverage
# continuously and never gates a merge (continue-on-error is set at the
# job level — no merge is happening off a scheduled run). Do not hand-edit
# generated Bindings or this workflow without re-running
# dynamic-qa/qa-generate; drift will be detected and blocks before the next
# test run.
name: ${workflowName}

on:
  schedule:
    - cron: "${cron}"

permissions:
  contents: read

jobs:
  dynamic-qa-nightly:
    name: dynamic-qa nightly full suite (does not gate the merge)
    runs-on: ${runsOn}
    timeout-minutes: ${timeoutMinutes}
    continue-on-error: true
    steps:
${renderCommonSteps({ nodeVersion, driftGateScript, annotationsScript, summaryScript, testCommand, junitPath, testStepName: "Run the full active portfolio" })}`;
}

/**
 * Renders the manual/provider-API trigger lane (`workflow_dispatch`).
 * ADVISORY (continue-on-error: true — a requested run produces evidence,
 * it does not itself enforce anything) and, deliberately, carries NO
 * `inputs:` at all: "a coding agent can request deterministic regression
 * evidence without owning QA policy" is enforced by construction — there
 * is nothing in the trigger for a requester to set, so a dispatch cannot
 * change which command, runner, or identity this lane executes with.
 */
export function renderManualTriggerLane(config = {}) {
  const {
    workflowName = "dynamic-qa manual/provider trigger",
    runsOn,
    nodeVersion,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
    testCommand,
    junitPath,
    driftGateScript = "dynamic-qa/shared/scripts/drift-gate-cli.mjs",
    annotationsScript = "dynamic-qa/shared/scripts/github-actions-annotations-cli.mjs",
    summaryScript = "dynamic-qa/shared/scripts/github-actions-summary-cli.mjs",
  } = config;

  validateCommonConfig("renderManualTriggerLane", { runsOn, nodeVersion, testCommand, junitPath });

  return `# Generated by dynamic-qa's GitHub Actions adapter (ticket #154). This is the
# manual/provider trigger lane: a coding agent or MCP integration can
# request deterministic regression evidence (via the Actions UI, \`gh
# workflow run\`, or the REST API) WITHOUT owning QA policy — this trigger
# declares no inputs, so a request cannot change the command, runner, or
# identity fixed below. ADVISORY (continue-on-error is set): a requested
# run produces evidence, it never itself gates a merge. Do not hand-edit
# generated Bindings or this workflow without re-running
# dynamic-qa/qa-generate; drift will be detected and blocks before the next
# test run.
name: ${workflowName}

on:
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  dynamic-qa-manual:
    name: dynamic-qa manual/provider trigger (does not gate the merge)
    runs-on: ${runsOn}
    timeout-minutes: ${timeoutMinutes}
    continue-on-error: true
    steps:
${renderCommonSteps({ nodeVersion, driftGateScript, annotationsScript, summaryScript, testCommand, junitPath, testStepName: "Run the requested deterministic Bindings" })}`;
}

/**
 * Renders the merge-group lane (`merge_group`), for repositories using a
 * GitHub merge queue. REQUIRED — deliberately the only one of the four
 * lanes that omits `continue-on-error`: the entire point of a merge-group
 * trigger is that its result gates the merge queue's required checks
 * (spec §8 / User Story 68), so a failure here must be a real, unmasked
 * job failure. The repository operator must still add this job's `name:`
 * to branch protection's required-status-checks list — this renderer emits
 * the workflow, it does not itself reach into repository settings (spec's
 * "discovery is read-only... nothing is touched until separate approvals"
 * invariant applies here too).
 */
export function renderMergeGroupLane(config = {}) {
  const {
    workflowName = "dynamic-qa merge-group required check",
    runsOn,
    nodeVersion,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
    testCommand,
    junitPath,
    driftGateScript = "dynamic-qa/shared/scripts/drift-gate-cli.mjs",
    annotationsScript = "dynamic-qa/shared/scripts/github-actions-annotations-cli.mjs",
    summaryScript = "dynamic-qa/shared/scripts/github-actions-summary-cli.mjs",
  } = config;

  validateCommonConfig("renderMergeGroupLane", { runsOn, nodeVersion, testCommand, junitPath });

  return `# Generated by dynamic-qa's GitHub Actions adapter (ticket #154). This is
# the merge-group REQUIRED lane: unlike the advisory PR/nightly/manual
# lanes, this job does NOT set continue-on-error — its result must actually
# gate the merge queue's required checks (add this job's name to branch
# protection's required-status-checks list). Do not hand-edit generated
# Bindings or this workflow without re-running dynamic-qa/qa-generate;
# drift will be detected and blocks before the next test run.
name: ${workflowName}

on:
  merge_group:
    types: [checks_requested]

permissions:
  contents: read

jobs:
  dynamic-qa-merge-group:
    name: dynamic-qa merge-group required check
    runs-on: ${runsOn}
    timeout-minutes: ${timeoutMinutes}
    steps:
${renderCommonSteps({ nodeVersion, driftGateScript, annotationsScript, summaryScript, testCommand, junitPath, testStepName: "Run relevant deterministic Bindings" })}`;
}

// --- the hardening detector -------------------------------------------------

function namedIssue(code, message) {
  return { code, message };
}

const USES_LINE_RE = /^\s*-?\s*uses:\s*([^\s#]+)/gm;

const EXPECTED_TRIGGER_KEY = Object.freeze({
  pull_request: SAFE_PR_TRIGGER,
  schedule: "schedule",
  workflow_dispatch: "workflow_dispatch",
  merge_group: "merge_group",
});

/**
 * Scans rendered (or arbitrarily mutated) GitHub Actions workflow YAML text
 * and names, individually, every missing/violated hardening property this
 * ticket requires. Text-scanning, not a general YAML parser — deliberately:
 * the deterministic core adds no YAML library dependency, and a handful of
 * fixed, security-relevant patterns is exactly what a restricted-subset
 * check should look like (mirrors restricted-yaml.mjs's own "accept only
 * the safe subset" ethos, applied here to detection rather than parsing).
 *
 * `options.lane` (default `"advisory"`): `"advisory"` requires
 * `continue-on-error: true` (unchanged #153 behaviour); `"required"`
 * (#154, the merge-group lane) requires the OPPOSITE — the absence of
 * `continue-on-error: true`, because a required lane's whole purpose is to
 * actually gate. `options.trigger` (default `"pull_request"`, #153's only
 * lane): which of the four Provider-native CI events this text is expected
 * to declare (`"pull_request"`, `"schedule"`, `"workflow_dispatch"`, or
 * `"merge_group"`) — `pull_request_target` is forbidden unconditionally
 * regardless of `trigger`. `trigger: "workflow_dispatch"` additionally
 * requires the `on:` block to declare no `inputs:` at all (#154's manual
 * lane: "a request cannot change policy" is enforced by there being
 * nothing for a request to set).
 *
 * Returns `{ valid, errors }`; every violation gets its own named `code` so
 * a Tier 1 test (or a real CI drift check) can assert on exactly which
 * property was violated, never a single generic "unsafe workflow" flag.
 */
export function checkWorkflowHardening(yamlText, options = {}) {
  const { lane = "advisory", trigger = SAFE_PR_TRIGGER } = options;
  const issues = [];
  const text = typeof yamlText === "string" ? yamlText : "";

  // 1. minimal permissions: exactly `contents: read`, nothing else.
  const permissionsMatch = /^permissions:\n((?:^ {2}.*\n?)*)/m.exec(text);
  if (!permissionsMatch) {
    issues.push(namedIssue("permissions.missing", "no top-level permissions block is declared — permissions default to broad read/write on a repository that has not narrowed them"));
  } else {
    const body = permissionsMatch[1];
    const keys = [...body.matchAll(/^ {2}([a-zA-Z-]+):\s*(\S+)/gm)];
    const nonMinimal = keys.filter((m) => !(m[1] === "contents" && m[2] === "read"));
    if (keys.length === 0 || nonMinimal.length > 0 || !keys.some((m) => m[1] === "contents" && m[2] === "read")) {
      issues.push(namedIssue("permissions.not-minimal", `permissions must be exactly "contents: read" and nothing else (found: ${JSON.stringify(keys.map((m) => `${m[1]}:${m[2]}`))})`));
    }
  }

  // 2. persist-credentials: false on the checkout step.
  const checkoutBlockMatch = /uses:\s*actions\/checkout@[^\s#]+[\s\S]*?(?=\n\s*- name:|\n\s*-\s*uses:|$)/.exec(text);
  if (!checkoutBlockMatch || !/persist-credentials:\s*false/.test(checkoutBlockMatch[0])) {
    issues.push(namedIssue("checkout.persist-credentials-not-disabled", "the checkout step does not set persist-credentials: false — a persisted credential on disk is reachable by untrusted PR code"));
  }

  // 3. every `uses:` action reference is pinned to a full 40-hex commit SHA,
  //    never a floating tag.
  for (const m of text.matchAll(USES_LINE_RE)) {
    const ref = m[1];
    if (!/@[0-9a-f]{40}$/.test(ref)) {
      issues.push(namedIssue("actions.not-sha-pinned", `action reference ${JSON.stringify(ref)} is not pinned to a full 40-character commit SHA`));
    }
  }

  // 4. pull_request_target is forbidden unconditionally, regardless of
  //    which lane/trigger this text belongs to; the expected trigger event
  //    for THIS lane must be declared.
  if (new RegExp(`\\b${FORBIDDEN_PR_TRIGGER}\\b`).test(text)) {
    issues.push(namedIssue("trigger.unsafe-pull-request-target", `${FORBIDDEN_PR_TRIGGER} grants base-repository secrets/token to untrusted fork PR code and must never be used`));
  }
  const expectedTriggerKey = EXPECTED_TRIGGER_KEY[trigger] ?? SAFE_PR_TRIGGER;
  if (!new RegExp(`^\\s*${expectedTriggerKey}:`, "m").test(text)) {
    issues.push(namedIssue("trigger.missing-declared-event", `no ${expectedTriggerKey} trigger found (expected for trigger=${JSON.stringify(trigger)})`));
  }

  // 5. gating semantics depend on the lane: an advisory lane
  //    (pull_request/nightly/manual) must never be able to fail the merge
  //    gate; a required lane (#154's merge-group) must actually be able to,
  //    so continue-on-error must be ABSENT there.
  const hasContinueOnError = /continue-on-error:\s*true/.test(text);
  if (lane === "advisory" && !hasContinueOnError) {
    issues.push(namedIssue("advisory.not-continue-on-error", "the job does not set continue-on-error: true — an advisory lane must never be able to fail the merge gate"));
  }
  if (lane === "required" && hasContinueOnError) {
    issues.push(namedIssue("required.continue-on-error-present", "the job sets continue-on-error: true — a required lane (e.g. merge-group) must actually be able to fail and gate the merge queue, not mask its own failure"));
  }

  // 8. a manual/provider (workflow_dispatch) trigger declares no inputs at
  //    all — "a request cannot change policy" is enforced by there being
  //    nothing in the trigger for a requester to set.
  if (trigger === "workflow_dispatch") {
    const onSectionMatch = /^on:\n([\s\S]*?)\n\n/m.exec(text);
    const onSection = onSectionMatch ? onSectionMatch[1] : text;
    if (/inputs:/.test(onSection)) {
      issues.push(namedIssue("dispatch.inputs-not-permitted", "workflow_dispatch declares inputs — a manual/provider trigger must not be able to influence which command, runner, or identity the lane executes with"));
    }
  }

  // 6. unreviewed PR jobs get no secrets, OIDC, protected environment, write
  //    identity, ambient credential, or privileged cache.
  if (/\$\{\{\s*secrets\./.test(text)) {
    issues.push(namedIssue("identity.secret-referenced", "the workflow references a secret — an unreviewed PR job must receive no secret"));
  }
  if (/id-token:\s*write/.test(text)) {
    issues.push(namedIssue("identity.oidc-write-permission", "the workflow requests id-token: write (OIDC) — an unreviewed PR job must receive no OIDC identity"));
  }
  if (/^\s*environment:/m.test(text)) {
    issues.push(namedIssue("identity.protected-environment-declared", "the job declares a protected environment — an unreviewed PR job must not run inside one"));
  }
  if (/contents:\s*write|pull-requests:\s*write|packages:\s*write|actions:\s*write/.test(text)) {
    issues.push(namedIssue("identity.write-permission-granted", "the workflow grants a write permission scope — an unreviewed PR job must receive no write identity"));
  }
  if (/actions\/cache@/.test(text)) {
    issues.push(namedIssue("cache.privileged-cache-used", "the workflow uses a cache action — an unreviewed PR job must receive no privileged/shared cache"));
  }
  if (/^\s*runs-on:\s*self-hosted/m.test(text)) {
    issues.push(namedIssue("environment.self-hosted-runner-used", "the workflow targets a self-hosted runner label — this lane must use existing hosted runners/environments, not new privileged infrastructure"));
  }

  // 7. exact artifact lists: no wildcard glob feeding a reporting step.
  if (/(annotations|summary)[^\n]*\*/.test(text)) {
    issues.push(namedIssue("artifact.wildcard-list", "a reporting step references a wildcard path — artifact lists must be exact, never a glob"));
  }

  return { valid: issues.length === 0, errors: issues };
}
