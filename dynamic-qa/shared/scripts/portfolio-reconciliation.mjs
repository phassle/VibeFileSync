// dynamic-qa/shared/scripts/portfolio-reconciliation.mjs
//
// Ticket #165, qa-setup stage 6 ("Reconcile the portfolio" —
// DESIGN-dynamic-qa-spec.md §6 step 6, SPEC-135.md stories 37-39). Stage 5
// (#164) assembles and validates exactly one Flow Definition per interview,
// in isolation. This module is the cross-flow computation stage 6 needs
// once every interviewed flow's Flow Definition is in hand: are the flows,
// taken together, coherent — no duplicates, no contradictions, no
// conflicting boundary/data/lane declarations — or does the portfolio carry
// disagreement that must stay visible rather than be quietly dropped?
//
// The rule that matters most (SPEC-135 story 39, the ticket's explicit
// framing): "unresolved disagreement keeps a flow draft." That is not a
// review convention here — it is structural:
//
//   - `reconcilePortfolio` only ever REPORTS issues. There is no parameter,
//     branch, or mode that discards, merges away, or auto-picks a side for
//     a detected conflict.
//   - `issuesForFlow` FAILS CLOSED (throws) if it is not given a real
//     report produced by `reconcilePortfolio` — a caller cannot skip the
//     eligibility check by passing `undefined`/a stray object and having it
//     silently read as "no issues".
//   - `evaluateFlowForPortfolio` and `recordFlowApproval` check
//     `issuesForFlow` FIRST, unconditionally, before looking at any approval
//     input at all. Every return path for "this flow has an unresolved
//     issue" is `eligible: false` / `approved: false` with `state: "draft"`.
//     No option flips that outcome. Approving a flow with an outstanding
//     issue is not a code path that exists to be reached; it would have to
//     be built new, not toggled.
//
// Genuine judgement — presenting a conflict to the QA Owner in plain
// language, and deciding (as a human) how to reconcile it — stays in
// qa-setup/SKILL.md prose. Everything here is naming a specific structural
// disagreement between specific flows; it never interprets which side of a
// disagreement is "right".

import { CONFIRMING_ROLES } from "./fact.mjs";
import { renderFlowDefinitionYAML } from "./flow-yaml.mjs";
import { contentDigest } from "./canonical-digest.mjs";

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : value;
}

function isRealSideEffecting(boundary) {
  if (!boundary || boundary.treatment !== "real") return false;
  const sideEffects = typeof boundary.side_effects === "string" ? boundary.side_effects.trim().toLowerCase() : "";
  return sideEffects !== "" && sideEffects !== "none";
}

function quoteAll(ids) {
  return ids.map((id) => JSON.stringify(id)).join(", ");
}

// --- individual detectors -------------------------------------------------
//
// Each detector is independently callable and independently testable. Every
// issue is `{ type, message, flowIds, details? }`; `flowIds` names every
// flow implicated so a caller (reconcilePortfolio, or a future direct
// caller) can attribute the issue back to the flows it blocks.

/**
 * Cross-flow duplicates (SPEC-135 story 38, acceptance criterion 1):
 *   - the same Flow ID declared more than once (should already be
 *     impossible if the portfolio is assembled from one file per ID, but a
 *     caller assembling from mixed sources gets this checked anyway);
 *   - two DIFFERENT flow IDs whose Given/When/Then steps and Expected
 *     Outcome wording are identical once whitespace/case-normalized,
 *     ignoring id/title/revision/criticality/state/origin — i.e. the same
 *     contract authored twice under two names.
 */
export function findDuplicateFlows(flows) {
  const issues = [];
  const seenIds = new Set();
  const bySignature = new Map();

  for (const flow of flows) {
    if (!flow || typeof flow.id !== "string") continue;

    if (seenIds.has(flow.id)) {
      issues.push({
        type: "duplicate-flow-id",
        message: `flow id ${JSON.stringify(flow.id)} is declared more than once in the portfolio`,
        flowIds: [flow.id],
      });
    }
    seenIds.add(flow.id);

    const steps = Array.isArray(flow.steps)
      ? flow.steps.map((step) => ({
          kind: step?.kind,
          intent: normalizeText(step?.intent),
          outcomes: Array.isArray(step?.outcomes) ? step.outcomes.map((o) => normalizeText(o?.expect)) : [],
        }))
      : [];
    const signature = contentDigest({ steps });
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(flow.id);
  }

  for (const ids of bySignature.values()) {
    const distinct = [...new Set(ids)];
    if (distinct.length > 1) {
      issues.push({
        type: "duplicate-flow-content",
        message: `flows ${quoteAll(distinct)} declare the same Given/When/Then steps and Expected Outcome wording (ignoring id, title, and revision) — this is one flow authored twice, not two independently justified ones`,
        flowIds: distinct,
      });
    }
  }

  return issues;
}

/**
 * Contradictory Expected Outcomes (SPEC-135 story 38, acceptance
 * criterion 1): the same Expected Outcome id is reused across two or more
 * flows with different wording. A stable semantic outcome id (SPEC-135
 * story 19) is meant to identify one claim; if two flows attach different
 * text to the same id, either they contradict each other or one must be
 * renamed — either way it is not something setup may pick a side on.
 */
export function findContradictoryOutcomes(flows) {
  const issues = [];
  const byOutcomeId = new Map();

  for (const flow of flows) {
    if (!flow || typeof flow.id !== "string" || !Array.isArray(flow.steps)) continue;
    for (const step of flow.steps) {
      if (!Array.isArray(step?.outcomes)) continue;
      for (const outcome of step.outcomes) {
        if (!outcome || typeof outcome.id !== "string") continue;
        if (!byOutcomeId.has(outcome.id)) byOutcomeId.set(outcome.id, []);
        byOutcomeId.get(outcome.id).push({ flowId: flow.id, expect: outcome.expect, normalized: normalizeText(outcome.expect) });
      }
    }
  }

  for (const [outcomeId, entries] of byOutcomeId) {
    const distinctFlows = [...new Set(entries.map((e) => e.flowId))];
    if (distinctFlows.length < 2) continue;
    const distinctText = new Set(entries.map((e) => e.normalized));
    if (distinctText.size > 1) {
      issues.push({
        type: "contradictory-expected-outcome",
        message: `Expected Outcome id ${JSON.stringify(outcomeId)} is worded differently across flows ${quoteAll(distinctFlows)} — a stable Expected Outcome id must mean the same claim everywhere it appears`,
        flowIds: distinctFlows,
        details: entries.map((e) => ({ flowId: e.flowId, expect: e.expect })),
      });
    }
  }

  return issues;
}

/**
 * Conflicting boundary treatments for the same dependency (SPEC-135
 * story 38, acceptance criteria 1 and 4): the same Boundary Declaration id
 * — the same crossed dependency, by definition (#145) — is classified
 * `real`/`simulated`/`forbidden`, or marked `volatile`, differently across
 * flows. #145's boundary-policy.mjs governs one flow's own boundary set;
 * this is the cross-flow half it explicitly leaves for a later ticket.
 */
export function findBoundaryTreatmentConflicts(flows) {
  const issues = [];
  const byBoundaryId = new Map();

  for (const flow of flows) {
    if (!flow || typeof flow.id !== "string" || !Array.isArray(flow.boundaries)) continue;
    for (const boundary of flow.boundaries) {
      if (!boundary || typeof boundary.id !== "string") continue;
      if (!byBoundaryId.has(boundary.id)) byBoundaryId.set(boundary.id, []);
      byBoundaryId.get(boundary.id).push({
        flowId: flow.id,
        treatment: boundary.treatment,
        volatile: boundary.volatile === true,
      });
    }
  }

  for (const [boundaryId, entries] of byBoundaryId) {
    const distinctFlows = [...new Set(entries.map((e) => e.flowId))];
    if (distinctFlows.length < 2) continue;
    const distinctTreatments = new Set(entries.map((e) => e.treatment));
    const distinctVolatility = new Set(entries.map((e) => e.volatile));
    if (distinctTreatments.size > 1 || distinctVolatility.size > 1) {
      issues.push({
        type: "conflicting-boundary-treatment",
        message: `dependency ${JSON.stringify(boundaryId)} is classified differently across flows ${quoteAll(distinctFlows)} — every flow that crosses the same dependency must agree whether it is real, simulated, or forbidden, and whether it is volatile`,
        flowIds: distinctFlows,
        details: entries,
      });
    }
  }

  return issues;
}

/**
 * Shared isolation-namespace collisions (SPEC-135 story 30 extended across
 * the portfolio): two flows both declare a `real`, side-effecting boundary
 * with the literal same `isolation.namespace`. #145 requires a namespace
 * per flow that has one; identical literal namespaces across flows means
 * concurrent runs of both flows could corrupt each other's data even though
 * each flow's own isolation declaration is individually well-formed.
 */
export function findIsolationNamespaceCollisions(flows) {
  const issues = [];
  const byNamespace = new Map();

  for (const flow of flows) {
    if (!flow || typeof flow.id !== "string" || !Array.isArray(flow.boundaries)) continue;
    for (const boundary of flow.boundaries) {
      if (!isRealSideEffecting(boundary)) continue;
      const namespace =
        boundary.isolation && typeof boundary.isolation.namespace === "string" ? boundary.isolation.namespace.trim() : "";
      if (!namespace) continue;
      if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
      byNamespace.get(namespace).push({ flowId: flow.id, boundaryId: boundary.id });
    }
  }

  for (const [namespace, entries] of byNamespace) {
    const distinctFlows = [...new Set(entries.map((e) => e.flowId))];
    if (distinctFlows.length > 1) {
      issues.push({
        type: "shared-isolation-namespace",
        message: `isolation namespace ${JSON.stringify(namespace)} is declared identically by real side-effecting boundaries in flows ${quoteAll(distinctFlows)} — concurrent runs could corrupt each other's data unless the namespace is actually distinguished per flow`,
        flowIds: distinctFlows,
        details: entries,
      });
    }
  }

  return issues;
}

/**
 * Named Data Set reference coherence (SPEC-135 story 38's "data",
 * acceptance criterion 4). Reuses #144's resolution contract rather than
 * reimplementing it: `resolveDataSet(id)` is caller-supplied (mirroring
 * resolve-data-sets.mjs's "callers must supply dataSetsDir" contract — this
 * module does not know where Named Data Sets live) and must return
 * `{ found: boolean }`. Omitting `resolveDataSet` skips this check rather
 * than guessing — see reconcilePortfolio's doc comment.
 */
export function findDataSetIssues(flows, resolveDataSet) {
  const issues = [];
  if (typeof resolveDataSet !== "function") return issues;

  for (const flow of flows) {
    if (!flow || typeof flow.id !== "string" || !Array.isArray(flow.data_sets)) continue;
    for (const dataSetId of flow.data_sets) {
      const result = resolveDataSet(dataSetId);
      if (!result || result.found !== true) {
        issues.push({
          type: "unresolved-data-set-reference",
          message: `flow ${JSON.stringify(flow.id)} references Named Data Set ${JSON.stringify(dataSetId)}, which does not resolve to a declared data set`,
          flowIds: [flow.id],
          details: { dataSetId },
        });
      }
    }
  }

  return issues;
}

/**
 * Derives a candidate CI lane for one flow from data already on the Flow
 * Definition — NOT CI design (stage 9, a later ticket owns provider-native
 * proposals). This is only the coherence signal stage 6 needs: a flow with
 * any `real`, side-effecting boundary, or a test-level override naming an
 * end-to-end/browser level, is a nightly candidate; otherwise it is a
 * pr-fast candidate. Exported so a later stage/ticket can reuse the same
 * classification rather than re-deriving it.
 */
function deriveLane(hasRealSideEffecting, testLevel) {
  const overrideValue =
    testLevel && testLevel.selection === "override" && typeof testLevel.value === "string" ? testLevel.value : "";
  const overrideImpliesNightly = /e2e|end-to-end|browser/i.test(overrideValue);
  return hasRealSideEffecting || overrideImpliesNightly ? "nightly-candidate" : "pr-fast-candidate";
}

export function classifyCandidateLane(flow) {
  const hasRealSideEffecting = Array.isArray(flow?.boundaries) && flow.boundaries.some(isRealSideEffecting);
  return deriveLane(hasRealSideEffecting, flow?.test_level);
}

/**
 * Lane coherence (SPEC-135 story 38's "CI lanes", acceptance criterion 4).
 *
 * A shared real, side-effecting boundary pushes every flow that declares it
 * toward the nightly lane by itself (see classifyCandidateLane) — two flows
 * agreeing on that is coherent, not a conflict to report. The conflict this
 * checks for is subtler: SET ASIDE the shared boundary and ask what each
 * flow's OTHER signals (its other real side-effecting boundaries, and any
 * explicit test-level override) would place it as. If, apart from the
 * dependency they share, the flows would otherwise land in different
 * candidate lanes, they disagree about how expensive/frequent coverage of
 * that shared risk needs to be — and stage 9 cannot design one coherent CI
 * lane plan around a dependency two flows have inconsistent expectations
 * for. Flag it rather than silently picking either flow's assumption.
 */
export function findLaneAssignmentConflicts(flows) {
  const issues = [];
  const byBoundaryId = new Map();

  for (const flow of flows) {
    if (!flow || typeof flow.id !== "string" || !Array.isArray(flow.boundaries)) continue;
    for (const boundary of flow.boundaries) {
      if (!isRealSideEffecting(boundary)) continue;
      const hasOtherRealSideEffecting = flow.boundaries.some((b) => b !== boundary && isRealSideEffecting(b));
      const laneExcludingThisDependency = deriveLane(hasOtherRealSideEffecting, flow.test_level);
      if (!byBoundaryId.has(boundary.id)) byBoundaryId.set(boundary.id, []);
      byBoundaryId.get(boundary.id).push({ flowId: flow.id, lane: laneExcludingThisDependency });
    }
  }

  for (const [boundaryId, entries] of byBoundaryId) {
    const distinctFlows = [...new Set(entries.map((e) => e.flowId))];
    if (distinctFlows.length < 2) continue;
    const distinctLanes = new Set(entries.map((e) => e.lane));
    if (distinctLanes.size > 1) {
      issues.push({
        type: "lane-assignment-conflict",
        message: `real side-effecting dependency ${JSON.stringify(boundaryId)} is shared by flows ${quoteAll(distinctFlows)} whose other signals would otherwise place them in different candidate CI lanes (${[...distinctLanes].join(", ")}) — they must agree on a lane or isolation strategy before CI design`,
        flowIds: distinctFlows,
        details: entries,
      });
    }
  }

  return issues;
}

/**
 * State coherence (SPEC-135 story 38's "states", acceptance criteria 1
 * and 3): a flow that declares a state other than `draft` while some other
 * check above named it in an unresolved issue is itself an incoherence — a
 * flow cannot claim to be further along than the reconciliation it has not
 * cleared. Takes the issues already found by every other detector so it
 * never re-derives what "implicated" means.
 */
export function findStateDeclarationConflicts(flows, priorIssues) {
  const implicated = new Set();
  for (const issue of priorIssues) {
    for (const flowId of issue.flowIds || []) implicated.add(flowId);
  }

  const issues = [];
  for (const flow of flows) {
    if (!flow || typeof flow.id !== "string") continue;
    if (implicated.has(flow.id) && flow.state && flow.state !== "draft") {
      issues.push({
        type: "state-declaration-conflict",
        message: `flow ${JSON.stringify(flow.id)} declares state ${JSON.stringify(flow.state)} but has unresolved portfolio reconciliation issue(s) — it must be treated as draft until every issue naming it is resolved`,
        flowIds: [flow.id],
      });
    }
  }
  return issues;
}

// --- the portfolio-level aggregate ----------------------------------------

/**
 * Runs every detector above over the full set of assembled, validated Flow
 * Definitions (the in-memory output of #164's stage 5 — nothing here reads
 * or writes the repository) and returns one report:
 *
 *   { issues, issuesByFlowId, isPortfolioCoherent }
 *
 * `resolveDataSet` is optional (see findDataSetIssues); every other
 * detector always runs. `issuesByFlowId` is a Map<flowId, issue[]> so a
 * caller can look up exactly which issues implicate one flow without
 * re-scanning `issues` itself — `issuesForFlow` below is the fail-closed
 * accessor built on top of it.
 *
 * This function never removes, merges, or auto-resolves an issue it finds.
 * There is no "resolved" input parameter here at all: resolving a conflict
 * is a human act (recorded through recordFlowApproval, once the underlying
 * Flow Definitions have actually been changed so the detectors stop firing
 * on a re-run) — reconcilePortfolio only ever reports what it currently
 * observes.
 */
export function reconcilePortfolio(flows, { resolveDataSet } = {}) {
  if (!Array.isArray(flows)) {
    throw new Error("reconcilePortfolio requires an array of assembled Flow Definitions");
  }

  const crossFlowIssues = [
    ...findDuplicateFlows(flows),
    ...findContradictoryOutcomes(flows),
    ...findBoundaryTreatmentConflicts(flows),
    ...findIsolationNamespaceCollisions(flows),
    ...findDataSetIssues(flows, resolveDataSet),
    ...findLaneAssignmentConflicts(flows),
  ];
  const stateConflicts = findStateDeclarationConflicts(flows, crossFlowIssues);
  const issues = [...crossFlowIssues, ...stateConflicts];

  const issuesByFlowId = new Map();
  for (const issue of issues) {
    for (const flowId of issue.flowIds || []) {
      if (!issuesByFlowId.has(flowId)) issuesByFlowId.set(flowId, []);
      issuesByFlowId.get(flowId).push(issue);
    }
  }

  return Object.freeze({
    issues,
    issuesByFlowId,
    isPortfolioCoherent: issues.length === 0,
  });
}

/**
 * The fail-closed accessor onto a reconcilePortfolio report. Throws rather
 * than treating a missing/malformed report as "no issues" — this is what
 * makes it impossible for a caller to accidentally bypass the draft-
 * retention rule by forgetting to pass the real report through.
 */
export function issuesForFlow(report, flowId) {
  if (!report || !(report.issuesByFlowId instanceof Map)) {
    throw new Error("issuesForFlow requires a reconciliationReport produced by reconcilePortfolio");
  }
  return report.issuesByFlowId.get(flowId) || [];
}

/**
 * Whether one flow may enter the approved portfolio at all, given the
 * portfolio-wide reconciliation report. `eligible` is false, unconditionally,
 * whenever `issuesForFlow` returns anything — there is no argument this
 * function accepts that can flip that outcome.
 */
export function evaluateFlowForPortfolio(flowId, reconciliationReport) {
  const issues = issuesForFlow(reconciliationReport, flowId);
  if (issues.length > 0) {
    return { flowId, eligible: false, reason: "unresolved portfolio reconciliation issue(s)", issues };
  }
  return { flowId, eligible: true, issues: [] };
}

/**
 * Records one flow's approval decision against the reconciliation report.
 * The eligibility check (issuesForFlow, via evaluateFlowForPortfolio) runs
 * BEFORE the approval record is even inspected — an unresolved issue
 * short-circuits to `{ approved: false, state: "draft" }` regardless of
 * what `approval` contains. Only once a flow is eligible does the function
 * look at `approval`, and even then requires an explicit qa-owner or
 * technical-owner record (reusing fact.mjs's CONFIRMING_ROLES — a Domain
 * Expert may inform a flow but never approves the portfolio contract,
 * consistent with #163's confirmIntent rule).
 *
 * `approval` shape: `{ approvedBy: string, role: "qa-owner"|"technical-owner", timestamp?: string }`.
 */
export function recordFlowApproval(flowId, reconciliationReport, approval) {
  const evaluation = evaluateFlowForPortfolio(flowId, reconciliationReport);
  if (!evaluation.eligible) {
    return { flowId, approved: false, state: "draft", reason: evaluation.reason, issues: evaluation.issues };
  }

  const hasValidApproval =
    approval &&
    typeof approval === "object" &&
    typeof approval.approvedBy === "string" &&
    approval.approvedBy.trim() !== "" &&
    CONFIRMING_ROLES.includes(approval.role);

  if (!hasValidApproval) {
    return {
      flowId,
      approved: false,
      state: "draft",
      reason: `flow approval requires an explicit approval record naming approvedBy and a role in ${CONFIRMING_ROLES.join(" | ")}`,
      issues: [],
    };
  }

  return {
    flowId,
    approved: true,
    state: null, // stage 6 clears the flow for the portfolio; it does not itself set Flow State to "active" — that is stage 7-10's job (Execution Profiles, Capability Gate, dual Setup Review Packet approval).
    approvedBy: approval.approvedBy,
    role: approval.role,
    timestamp: approval.timestamp ?? null,
  };
}

/**
 * Evaluates approval for every flow in the portfolio and rolls the result
 * up to a portfolio-level record (acceptance criterion 5: "approval is
 * recorded per flow and for the portfolio as a whole"). `flowApprovals` is
 * a plain object keyed by flow id, `{ [flowId]: approval }` — a flow with
 * no entry is treated as not yet approved (never as approved-by-default).
 *
 * `portfolioFullyApproved` is true only when every flow in `flows` is both
 * eligible and approved; a single draft-retained flow keeps it false, per
 * SPEC-135 story 39 — the portfolio is simply not fully approved, it is not
 * an error to report and move on from.
 */
export function evaluatePortfolioApproval(flows, reconciliationReport, flowApprovals = {}) {
  const perFlow = flows.map((flow) => recordFlowApproval(flow.id, reconciliationReport, flowApprovals[flow.id]));
  const approvedFlowIds = perFlow.filter((r) => r.approved).map((r) => r.flowId);
  const draftFlowIds = perFlow.filter((r) => !r.approved).map((r) => r.flowId);

  return {
    perFlow,
    approvedFlowIds,
    draftFlowIds,
    portfolioFullyApproved: draftFlowIds.length === 0 && flows.length > 0,
  };
}

// --- exact per-flow YAML review -------------------------------------------

/**
 * Builds the Flow Review artifact for one flow (SPEC-135 story 37,
 * acceptance criterion 2): the flow's exact restricted-YAML text — rendered
 * by the SAME `renderFlowDefinitionYAML` (#164's flow-yaml.mjs) that would
 * be used to write the flow to the repository, imported here rather than
 * reimplemented — plus whatever portfolio reconciliation issues currently
 * implicate it. Because there is exactly one renderer and this function
 * calls it directly, the text the QA Owner reviews is byte-identical to
 * what a later write would produce; there is no second rendering path that
 * could drift from it.
 */
export function buildFlowReview(flow, reconciliationReport) {
  return {
    flowId: flow.id,
    yaml: renderFlowDefinitionYAML(flow),
    issues: issuesForFlow(reconciliationReport, flow.id),
  };
}
