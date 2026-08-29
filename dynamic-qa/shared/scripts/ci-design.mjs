// dynamic-qa/shared/scripts/ci-design.mjs
//
// qa-setup stage 9 (ticket #168, SPEC-135 User Stories 45-46): "provider-
// native CI designed only after the flow portfolio is approved" and "setup
// proposes the smallest existing-harness and CI diff." This module is the
// deterministic core stage 9's own SKILL.md prose calls — everything
// checkable by rule lives here, never in prose (run brief decision #5).
//
// This module composes, it does not re-decide:
//   - #165's `evaluatePortfolioApproval` (portfolio-reconciliation.mjs) is
//     the ONLY source of "is the portfolio approved." `classifyCandidateLane`
//     from that same module is reused too, but only as the coherence SIGNAL
//     #165 always said it was — never as CI policy. The REAL lane
//     assignment (does this flow actually get a working, capability-backed
//     CI lane right now) is this ticket's own job; see assignFlowLane.
//   - #166's `designExecutionProfile` / `designSafeExecutionForApprovedFlows`
//     results (safe-execution-design.mjs) are the ONLY source of "is this
//     flow's execution actually enforceable." A flow whose Execution
//     Profile did not activate never gets a CI lane here, regardless of
//     what classifyCandidateLane's signal says.
//   - #153's GitHub Actions adapter (github-actions-adapter.mjs,
//     github-actions-workflow.mjs) is the ONLY renderer and the ONLY source
//     of which triggers are actually built (`SUPPORTED_TRIGGERS`) versus
//     named-but-not-yet-built (`DEFERRED_TRIGGERS`). This module never
//     hand-rolls a second rendering path — see chooseSmallestDiff, which
//     reuses `renderAdvisoryPullRequestLane`'s own output to measure size
//     rather than inventing a line-count.
//
// Structural ordering (SPEC-135 story 45): `designProviderNativeCI` THROWS
// if the portfolio is not fully approved. This is not a soft warning a
// caller could ignore — there is no code path in this module that reaches
// lane assignment, diff choice, or the proposal artifact without first
// passing that check, so CI design is unreachable with an unapproved
// portfolio by construction, not by convention.
//
// Smallest-diff (SPEC-135 story 46): `chooseSmallestDiff` compares an
// estimated line-count for amending an existing, inventoried workflow
// file against the actual line-count of the fully rendered new-file
// output, and prefers amending whenever that is the same size or smaller.
// It never invents a workflow's existing shape — amend candidates come
// only from `summarizeCiInventory`'s reading of stage 2's own CI Facts
// (inventory-ci.mjs), grouped by each fact's own `evidence` (source file)
// field.

import { classifyCandidateLane } from "./portfolio-reconciliation.mjs";
import { renderAdvisoryPullRequestLane } from "./github-actions-workflow.mjs";
import { PROVIDER_IDENTITY, SUPPORTED_TRIGGERS, DEFERRED_TRIGGERS } from "./github-actions-adapter.mjs";

// --- lane vocabulary --------------------------------------------------------
//
// All four Provider-native CI exposures DESIGN-dynamic-qa-spec.md §8
// requires are named here up front — PR-fast, nightly-full, manual/API, and
// merge-group — precisely so this module does not hard-code an assumption
// that only `pull_request` exists. Whether a given lane is actually usable
// today is decided at call time against the CALLER-SUPPLIED `supportedTriggers`
// list (defaulted to the adapter's own `SUPPORTED_TRIGGERS`, never
// duplicated as a literal here), so the day a later ticket (#154) teaches
// the adapter to render `schedule`/`workflow_dispatch`/`merge_group`, this
// module's lane assignment picks that up with no code change — only the
// list passed in changes.
export const LANE_TRIGGERS = Object.freeze({
  "pr-fast": "pull_request",
  "nightly-full": "schedule",
  manual: "workflow_dispatch",
  "merge-queue": "merge_group",
});

function triggerForCandidateSignal(signal) {
  return signal === "nightly-candidate" ? "schedule" : "pull_request";
}

function laneNameForTrigger(trigger) {
  const found = Object.entries(LANE_TRIGGERS).find(([, t]) => t === trigger);
  return found ? found[0] : trigger;
}

function deferredTriggerLabel(trigger, deferredTriggers) {
  const named = deferredTriggers.find((label) => label.startsWith(trigger));
  return named ?? trigger;
}

// --- real lane assignment (this ticket's own job) --------------------------

/**
 * Assigns ONE approved flow to a CI lane, using real capability evidence —
 * never `classifyCandidateLane`'s signal alone. That signal (`pr-fast-
 * candidate` | `nightly-candidate`, from #165) only decides WHICH trigger
 * this flow would need; two further, independently checkable facts decide
 * whether it can actually be enrolled today:
 *
 *   1. `executionResult` — the flow's own #166 `designExecutionProfile`
 *      result. A flow whose Execution Profile did not activate
 *      (`decision.activate !== true`) never gets a lane; its Safety
 *      Blockers are cited, not silently dropped.
 *   2. `supportedTriggers` — which triggers the provider adapter can
 *      actually render right now (defaults to the GitHub Actions adapter's
 *      own `SUPPORTED_TRIGGERS`). A flow whose required trigger is not yet
 *      built (e.g. `nightly-candidate` before #154 lands `schedule`) is
 *      named as blocked on that exact deferred trigger, never silently
 *      folded into the PR-fast lane it was not classified for.
 *
 * Returns `{ flowId, laneName, requiredTrigger, assigned, ... }`. `assigned`
 * is `false` for both reasons above, each with its own `reason` code so a
 * reviewer sees exactly why, and a Tier 1 test can assert on the exact
 * cause rather than one generic "not assigned" flag.
 */
export function assignFlowLane(flow, executionResult, { supportedTriggers = SUPPORTED_TRIGGERS, deferredTriggers = DEFERRED_TRIGGERS } = {}) {
  if (!flow || typeof flow.id !== "string") {
    throw new Error("assignFlowLane requires an assembled Flow Definition with an id");
  }
  if (!executionResult || typeof executionResult.decision?.activate !== "boolean") {
    throw new Error("assignFlowLane requires this flow's own stage-7 designExecutionProfile result (safe-execution-design.mjs)");
  }

  const signal = classifyCandidateLane(flow);
  const requiredTrigger = triggerForCandidateSignal(signal);
  const laneName = laneNameForTrigger(requiredTrigger);
  const runnerClass = executionResult.profile?.environments?.runnerClass;

  if (!executionResult.decision.activate) {
    return {
      flowId: flow.id,
      laneName,
      requiredTrigger,
      assigned: false,
      reason: "execution-profile-not-activatable",
      blockers: executionResult.decision.blockers,
    };
  }

  if (!supportedTriggers.includes(requiredTrigger)) {
    return {
      flowId: flow.id,
      laneName,
      requiredTrigger,
      assigned: false,
      reason: "trigger-not-yet-supported-by-adapter",
      deferredTrigger: deferredTriggerLabel(requiredTrigger, deferredTriggers),
    };
  }

  return {
    flowId: flow.id,
    laneName,
    requiredTrigger,
    runnerClass,
    assigned: true,
    // Only the advisory lane is ever proposed here — #153 built no other
    // renderer, and inventing a "required" or "quarantine" enforcement
    // state this stage cannot actually render would be exactly the kind of
    // plausible-looking guess the run brief forbids.
    enforcementState: "advisory",
  };
}

// --- CI inventory summary (reads stage 2's own Facts, invents nothing) -----

function stripPrefix(id, prefix) {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * Groups stage 2's CI Facts (inventory-ci.mjs's `scanCiWorkflows`) by the
 * workflow file each fact's own `evidence` field names, and separately
 * collects the repo-wide sets of runners/environments/triggers. This is a
 * read of what stage 2 already observed — it parses nothing new and never
 * infers a fact inventory-ci.mjs did not itself produce.
 */
export function summarizeCiInventory(facts = []) {
  const workflows = new Map();
  const runners = new Set();
  const environments = new Set();
  const triggers = new Set();
  let hasMergeQueue = false;

  function workflowFor(path) {
    if (!workflows.has(path)) {
      workflows.set(path, { path, triggers: new Set(), runners: new Set(), environments: new Set(), checks: new Set(), hasArtifactUpload: false });
    }
    return workflows.get(path);
  }

  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact.category !== "string") continue;
    const path = typeof fact.evidence === "string" ? fact.evidence : undefined;

    switch (fact.category) {
      case "ci-trigger": {
        const trigger = stripPrefix(fact.id, "ci-trigger:");
        triggers.add(trigger);
        if (path) workflowFor(path).triggers.add(trigger);
        break;
      }
      case "ci-runner": {
        const runner = stripPrefix(fact.id, "ci-runner:");
        runners.add(runner);
        if (path) workflowFor(path).runners.add(runner);
        break;
      }
      case "ci-environment": {
        const env = stripPrefix(fact.id, "ci-environment:");
        environments.add(env);
        if (path) workflowFor(path).environments.add(env);
        break;
      }
      case "ci-check": {
        const check = stripPrefix(fact.id, "ci-check:");
        if (path) workflowFor(path).checks.add(check);
        break;
      }
      case "ci-merge-queue":
        hasMergeQueue = true;
        break;
      case "ci-artifact":
        if (path) workflowFor(path).hasArtifactUpload = true;
        break;
      default:
        break;
    }
  }

  return { workflows: [...workflows.values()], runners, environments, triggers, hasMergeQueue };
}

// --- smallest-diff decision --------------------------------------------------

const TRIGGER_ADDITION_LINES = 3; // a modest, named, non-invented allowance for
// one new `on:` event key plus its branches line, when an eligible existing
// workflow does not already carry the required trigger. The exact existing
// `on:` shape differs per repository and this module never re-renders a
// third-party workflow's YAML (github-actions-workflow.mjs's own renderer
// remains the one place that produces workflow text), so this is charged as
// a small, explicit, documented constant rather than a computed guess.

function looksSelfHosted(runnerLabel) {
  return typeof runnerLabel === "string" && /self-hosted/i.test(runnerLabel);
}

function extractJobsBlock(yamlText) {
  const lines = yamlText.split("\n");
  const jobsIndex = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIndex === -1) return "";
  return lines.slice(jobsIndex + 1).join("\n");
}

function nonBlankLineCount(text) {
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

/**
 * Scores one inventoried workflow file as an amend candidate for the
 * required trigger, using only what stage 2 actually observed about it.
 * `eligible` is false when the workflow has no real, hosted runner this
 * module could safely reuse for a new job (a self-hosted-only workflow is
 * not proposed as an amend target — capability evidence for a self-hosted
 * runner's Node availability is a named seam #153 already left open, not
 * something to assume here).
 */
export function evaluateAmendCandidate(workflowFact, requiredTrigger, jobBlockLines) {
  const hostedRunners = [...workflowFact.runners].filter((r) => !looksSelfHosted(r));
  const eligible = hostedRunners.length > 0;
  const triggerAlreadyPresent = workflowFact.triggers.has(requiredTrigger);
  const estimatedDiffLines = jobBlockLines + (triggerAlreadyPresent ? 0 : TRIGGER_ADDITION_LINES);
  return {
    path: workflowFact.path,
    eligible,
    triggerAlreadyPresent,
    estimatedDiffLines,
    reusableRunners: hostedRunners,
  };
}

/**
 * Chooses the smallest diff that can carry the portfolio's assigned lanes:
 * amend an eligible existing workflow, or propose a new dedicated file.
 * Neither branch is decided a priori — "amending is preferred... when it is
 * smaller and clear" (ticket #168) is made literal by comparing an actual
 * line count on each side, both sourced from real data:
 *
 *   - the "amend" line count is the job-block slice of the SAME rendered
 *     YAML `renderAdvisoryPullRequestLane` (#153) would produce for a new
 *     file, so this module never hand-writes a second version of the job's
 *     steps;
 *   - the "new file" line count is that same renderer's full output,
 *     measured directly rather than assumed.
 *
 * Ties and smaller-amend cases both prefer `amend`; only a strictly smaller
 * new-file count, or the absence of any eligible amend candidate, produces
 * `new-file`. `renderConfig` must supply everything
 * `renderAdvisoryPullRequestLane` requires (`runsOn`, `nodeVersion`,
 * `testCommand`, `junitPath`) — `runsOn` should be the flow's own Execution
 * Profile `environments.runnerClass` (stage 7, itself inventory-derived),
 * never a runner this module invents.
 */
export function chooseSmallestDiff({ ciInventory, requiredTrigger = "pull_request", renderConfig, newWorkflowPath = ".github/workflows/dynamic-qa.yml" }) {
  const fullYaml = renderAdvisoryPullRequestLane(renderConfig);
  const fullLines = nonBlankLineCount(fullYaml);
  const jobBlockLines = nonBlankLineCount(extractJobsBlock(fullYaml));

  const candidates = ciInventory.workflows
    .map((w) => evaluateAmendCandidate(w, requiredTrigger, jobBlockLines))
    .filter((c) => c.eligible)
    .sort((a, b) => a.estimatedDiffLines - b.estimatedDiffLines);

  const best = candidates[0];

  if (best && best.estimatedDiffLines <= fullLines) {
    return {
      strategy: "amend",
      targetPath: best.path,
      estimatedDiffLines: best.estimatedDiffLines,
      alternativeEstimatedDiffLines: fullLines,
      reusedRunner: best.reusableRunners[0],
      triggerAlreadyPresent: best.triggerAlreadyPresent,
      justification:
        `amending ${best.path} adds one job to its existing jobs: block ` +
        `(~${best.estimatedDiffLines} non-blank line${best.estimatedDiffLines === 1 ? "" : "s"})` +
        (best.triggerAlreadyPresent
          ? `, and its ${requiredTrigger} trigger already matches — no on: block change needed`
          : `, plus a small ${requiredTrigger} trigger addition to its on: block`) +
        `, smaller than or equal to a new dedicated workflow file (~${fullLines} non-blank lines).`,
    };
  }

  return {
    strategy: "new-file",
    targetPath: newWorkflowPath,
    estimatedDiffLines: fullLines,
    alternativeEstimatedDiffLines: best ? best.estimatedDiffLines : null,
    justification: best
      ? `the smallest eligible amendment (~${best.estimatedDiffLines} non-blank lines at ${best.path}) is larger than a new dedicated workflow file (~${fullLines} non-blank lines), so a new file is the smaller diff here.`
      : `no inventoried workflow has a hosted runner this module can safely reuse for a new job, so a new dedicated workflow file (~${fullLines} non-blank lines) is proposed.`,
  };
}

// --- portfolio-level entry point (qa-setup stage 9 calls this) ------------

/**
 * Designs provider-native CI for the fully approved flow portfolio.
 *
 * STRUCTURAL ORDERING (SPEC-135 story 45): this function THROWS unless
 * `portfolioApproval.portfolioFullyApproved === true`. There is no return
 * value, partial or otherwise, for an unapproved portfolio — CI design is
 * unreachable, not merely discouraged, until every flow has cleared stage
 * 6's dual approval. This mirrors #166's own fail-closed pattern for a
 * malformed `portfolioApproval` (throw, never "treat as nothing approved"),
 * extended here to the stronger "not FULLY approved yet" case, because
 * SPEC-135 story 45 is about the whole portfolio, not one flow at a time.
 *
 * `executionResultsByFlowId` must carry each approved flow's own #166
 * `designExecutionProfile` result (keyed by flow id) — a missing entry
 * throws via `assignFlowLane`'s own guard, exactly like #166 throws on a
 * missing inventory for an approved flow.
 *
 * Returns the CI proposal artifact: `{ provider, approvedFlowIds, lanes,
 * diffChoice, namedInfrastructure, runnerMatchesInventory }`. Nothing here
 * writes a file or changes provider policy — this is a proposal to present
 * in the stage 10 Setup Review Packet, not an applied change.
 */
export function designProviderNativeCI({
  portfolioApproval,
  flows,
  executionResultsByFlowId = {},
  ciInventoryFacts = [],
  renderConfig,
  newWorkflowPath = ".github/workflows/dynamic-qa.yml",
  supportedTriggers = SUPPORTED_TRIGGERS,
  deferredTriggers = DEFERRED_TRIGGERS,
} = {}) {
  if (!portfolioApproval || typeof portfolioApproval.portfolioFullyApproved !== "boolean" || !Array.isArray(portfolioApproval.approvedFlowIds)) {
    throw new Error(
      "designProviderNativeCI requires a portfolioApproval produced by portfolio-reconciliation.mjs's evaluatePortfolioApproval",
    );
  }
  if (!portfolioApproval.portfolioFullyApproved) {
    throw new Error(
      "designProviderNativeCI refuses to run: the flow portfolio is not fully approved yet " +
        `(draft flow ids: ${JSON.stringify(portfolioApproval.draftFlowIds ?? [])}). ` +
        "Provider-native CI is designed only after every flow in the portfolio clears stage 6 approval " +
        "(SPEC-135 story 45) — resolve the remaining drafts first; this function has no path that " +
        "produces a CI proposal before that.",
    );
  }
  if (!Array.isArray(flows)) {
    throw new Error("designProviderNativeCI requires an array of assembled Flow Definitions");
  }

  const approvedSet = new Set(portfolioApproval.approvedFlowIds);
  const approvedFlows = flows.filter((flow) => flow && approvedSet.has(flow.id));

  const lanes = approvedFlows.map((flow) =>
    assignFlowLane(flow, executionResultsByFlowId[flow.id], { supportedTriggers, deferredTriggers }),
  );

  const ciInventory = summarizeCiInventory(ciInventoryFacts);

  const assignedLane = lanes.find((l) => l.assigned);
  const requiredTrigger = assignedLane?.requiredTrigger ?? "pull_request";

  const diffChoice = renderConfig ? chooseSmallestDiff({ ciInventory, requiredTrigger, renderConfig, newWorkflowPath }) : undefined;

  const runsOn = renderConfig?.runsOn;
  const runnerMatchesInventory =
    typeof runsOn === "string" && runsOn.trim() !== ""
      ? { runner: runsOn, matches: ciInventory.runners.has(runsOn) }
      : { runner: undefined, matches: false };

  return {
    provider: PROVIDER_IDENTITY,
    approvedFlowIds: portfolioApproval.approvedFlowIds,
    lanes,
    diffChoice,
    namedInfrastructure: {
      runners: [...ciInventory.runners],
      environments: [...ciInventory.environments],
      triggers: [...ciInventory.triggers],
      existingWorkflowPaths: ciInventory.workflows.map((w) => w.path),
      hasMergeQueue: ciInventory.hasMergeQueue,
    },
    runnerMatchesInventory,
  };
}
