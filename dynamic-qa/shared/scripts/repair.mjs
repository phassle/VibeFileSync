// dynamic-qa/shared/scripts/repair.mjs
//
// Ticket #160: guarded repair — the explicit-repair mode of `qa-generate`
// (DESIGN-dynamic-qa-spec.md §7 "Repair workflow", SPEC-135.md user stories
// 77-81 and 94, tickets/160.md). This module is the deterministic core that
// decides whether a proposed repair may become a Repair Review Packet.
// It never diagnoses (#158 owns Diagnosis Records), never validates the
// Failure Evidence Bundle shape (#159's failure-evidence.mjs owns that —
// isBundleRepairEligible is reused here exactly, never re-derived), and
// never runs a negative control (#152's negative-controls.mjs is reused
// exactly for plan/judge/coverage). What #160 uniquely owns:
//
//   1. Pursuing exactly ONE causal hypothesis per invocation
//      (checkSingleCausalHypothesis) — a second theory ends the invocation;
//      repair must never become a retry loop.
//   2. Protected-contract digests (computeProtectedContractDigests /
//      checkProtectedContractsUnchanged): a before/after snapshot across
//      every category the spec names as off-limits — Flow semantics,
//      tolerances, boundaries, data meaning, level overrides, lifecycle,
//      enforcement, dependencies, lockfiles, workflows, profiles,
//      identities, network access, quarantine, required-check policy —
//      reusing canonical-digest.mjs's contentDigest, never a new hashing
//      scheme.
//   3. checkRepairFilesAreMechanicalOnly: a path-based denylist layer,
//      independent of and in addition to the digest check above — even a
//      byte-identical rewrite of a protected file's path is refused, not
//      only a semantic change.
//   4. THE GUARD #152 EXPLICITLY LEFT UNBUILT (see negative-controls.mjs's
//      module footer, "Seam for #160 — READ THIS"): a repair candidate that
//      widens its own tolerance, weakens an assertion, or otherwise makes
//      its own negative control easier to pass must be rejected.
//      checkNegativeControlNotWeakened closes this: it recomputes the
//      DECLARED violation from the (protected, therefore unchanged) Flow
//      contract and requires every negative-control report to name the
//      exact same violation it was obligated to apply
//      (declaredViolationDigest), never a softer one the candidate
//      substituted. #152's own judgeNegativeControl only proves "some
//      assertion failed for some reported reason" — it has no notion of
//      WHICH violation was applied, which is exactly the gap this closes.
//   5. Assembling the Repair Review Packet and structurally guaranteeing
//      "proposes only, never applies" — this module has no dependency on
//      node:fs, node:child_process, or any other write/exec capability;
//      `proposedFiles` are opaque data that flow straight into the
//      packet's `diff` section and are never written anywhere. See
//      repair.test.mjs's "proposes only" tests for the structural proof.

import { contentDigest } from "./canonical-digest.mjs";
import { isBundleRepairEligible } from "./failure-evidence.mjs";
import { buildNegativeControlPlan, checkNegativeControlCoverage } from "./negative-controls.mjs";
import { checkAssertionCoverage } from "./expected-outcome-coverage.mjs";
import { scanGeneratedFiles } from "./forbidden-patterns.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// --- 1. One causal hypothesis, never a loop --------------------------------

/**
 * The single most important control-flow rule repair execution owns
 * (DESIGN-dynamic-qa-spec.md §7 step 6, SPEC-135.md user story 78): one
 * repair invocation pursues exactly one causal hypothesis. `hypotheses` is
 * the ordered list of every distinct causal-hypothesis string the attempt
 * considered — normally just `[bundle.diagnosisRecord.causalChain]`, since
 * the Failure Evidence Bundle structurally carries only one (#159's module
 * footer). A caller that tried a hypothesis probe and it disagreed with the
 * bundle's own causalChain must record BOTH strings here, distinctly, so
 * this function can catch it.
 *
 * Returns `{ valid, reason }`. `reason` is `"no-hypothesis"` for an empty
 * list, `"second-causal-hypothesis"` for more than one distinct hypothesis
 * (this is a REFUSAL that ends the invocation, never a retry with the next
 * theory), or `null` when exactly one hypothesis was pursued. Never throws.
 */
export function checkSingleCausalHypothesis(hypotheses) {
  if (!Array.isArray(hypotheses) || hypotheses.length === 0) {
    return { valid: false, reason: "no-hypothesis", distinctHypotheses: [] };
  }
  const distinct = [...new Set(hypotheses.filter(nonEmptyString).map((h) => h.trim()))];
  if (distinct.length === 0) {
    return { valid: false, reason: "no-hypothesis", distinctHypotheses: [] };
  }
  if (distinct.length > 1) {
    return { valid: false, reason: "second-causal-hypothesis", distinctHypotheses: distinct };
  }
  return { valid: true, reason: null, distinctHypotheses: distinct };
}

// --- 2. Protected-contract digests ------------------------------------------

/**
 * Every category DESIGN-dynamic-qa-spec.md §7 and RUN-BRIEF.md name as
 * off-limits to repair, spelled out individually so a review packet (and a
 * test suite) can name exactly which one drifted rather than a single
 * generic "something changed". A caller assembles a snapshot object keyed
 * by these exact names; any category the caller cannot supply for a given
 * repair is still checked (absence is itself a stable, digestible value —
 * `contentDigest(undefined ?? null)` — so a category silently appearing
 * between before/after is caught too).
 */
export const PROTECTED_CONTRACT_CATEGORIES = Object.freeze([
  "flowSemantics",
  "tolerances",
  "boundaries",
  "dataMeaning",
  "levelOverrides",
  "lifecycle",
  "enforcement",
  "dependencies",
  "lockfiles",
  "workflows",
  "profiles",
  "identities",
  "networkAccess",
  "quarantine",
  "requiredCheckPolicy",
]);

/**
 * Computes one contentDigest (canonical-digest.mjs — reused, not a new
 * hashing scheme) per protected-contract category from a caller-supplied
 * snapshot object. A category absent from `snapshot` digests `null`, so
 * "this repair never even considered the profiles category" and "this
 * repair silently introduced a profiles change from nothing" are both
 * still comparable, never treated as "not applicable, skip".
 */
export function computeProtectedContractDigests(snapshot) {
  const source = isPlainObject(snapshot) ? snapshot : {};
  const digests = {};
  for (const category of PROTECTED_CONTRACT_CATEGORIES) {
    digests[category] = contentDigest(source[category] ?? null);
  }
  return digests;
}

/**
 * THE protected-contract gate. Computes digests for the before and after
 * snapshots and reports every category whose digest differs. Any drift in
 * ANY protected category rejects the repair outright — there is no
 * "acceptable" protected drift. Returns `{ valid, violations, before, after }`
 * where `before`/`after` are the full per-category digest maps (for the
 * Repair Review Packet's protectedContractDigests section) and `violations`
 * is `[{ category, before, after }]` for every category that changed. Never
 * throws.
 */
export function checkProtectedContractsUnchanged(beforeSnapshot, afterSnapshot) {
  const before = computeProtectedContractDigests(beforeSnapshot);
  const after = computeProtectedContractDigests(afterSnapshot);
  const violations = [];
  for (const category of PROTECTED_CONTRACT_CATEGORIES) {
    if (before[category] !== after[category]) {
      violations.push({ category, before: before[category], after: after[category] });
    }
  }
  return { valid: violations.length === 0, violations, before, after };
}

// --- 3. Mechanical-Binding-only scope, path layer ---------------------------

// A second, independent guard layer alongside the digest check above: a
// path that structurally belongs to a protected artifact is refused even
// before any content is inspected, so an edit that happens to be a no-op
// (and would therefore pass the digest check) is still caught if it
// touches a path repair has no business touching at all.
const FORBIDDEN_REPAIR_PATH_PATTERNS = Object.freeze([
  { category: "flowSemantics", re: /(^|\/)qa\/flows\/[^/]+\.ya?ml$/i },
  { category: "dataMeaning", re: /(^|\/)qa\/data\/[^/]+\.ya?ml$/i },
  { category: "profiles", re: /(^|\/)qa\/execution-profiles\/[^/]+\.ya?ml$/i },
  { category: "quarantine", re: /(^|\/)qa\/quarantine(\/|\.json$|\.ya?ml$)/i },
  { category: "workflows", re: /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i },
  { category: "requiredCheckPolicy", re: /(^|\/)\.github\/(branch-protection|required-checks)[^/]*$/i },
  { category: "dependencies", re: /(^|\/)package\.json$/i },
  { category: "lockfiles", re: /(^|\/)(package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|Cargo\.lock|Gemfile\.lock)$/i },
  { category: "identities", re: /(^|\/)(CODEOWNERS|\.github\/CODEOWNERS)$/i },
  // provenance.json's own header fields (enforcementLane, executionProfile)
  // are protected by the "enforcement"/"profiles" digest categories rather
  // than a path ban, because a repair's own Binding entry inside that same
  // file legitimately updates (e.g. an output digest) as part of a normal
  // mechanical fix. Path-banning the whole file would over-refuse.
]);

/**
 * Classifies one proposed file path against the protected-path denylist.
 * Returns the matching category name, or `null` when the path is not
 * structurally protected (i.e. it may be a legitimate mechanical Binding
 * file — a test/spec file, a fixture, a page object, provenance.json's
 * per-Binding entry, etc.).
 */
export function classifyRepairFilePath(path) {
  if (typeof path !== "string") return null;
  for (const { category, re } of FORBIDDEN_REPAIR_PATH_PATTERNS) {
    if (re.test(path)) return category;
  }
  return null;
}

/**
 * Checks a proposed repair's file list against the protected-path denylist.
 * `files` is `[{ path, content }]`, the same shape binding-verification.mjs
 * and forbidden-patterns.mjs already consume. Returns `{ valid, violations }`
 * where `violations` is `[{ path, category }]` for every proposed file that
 * touches a structurally protected path. Never throws.
 */
export function checkRepairFilesAreMechanicalOnly(files) {
  const violations = [];
  for (const file of files ?? []) {
    if (!isPlainObject(file) || typeof file.path !== "string") continue;
    const category = classifyRepairFilePath(file.path);
    if (category) violations.push({ path: file.path, category });
  }
  return { valid: violations.length === 0, violations };
}

// --- 4. Reconstructing the protected proof obligation -----------------------

/**
 * DESIGN-dynamic-qa-spec.md §7 step 2: "Reconstruct the exact step, Expected
 * Outcome, tolerance, boundary, data case, and selected-level proof
 * obligation. These contracts are read-only." Reuses
 * negative-controls.mjs's buildNegativeControlPlan exactly — never a
 * second derivation of what a tolerance requires — filtered to only the
 * outcome IDs this repair's evidence actually names (when given), so the
 * review packet's mappings section shows the exact obligation being
 * repaired against, not the whole flow's unrelated outcomes.
 */
export function reconstructProofObligations(flowData, affectedOutcomeIds) {
  const plan = buildNegativeControlPlan(flowData);
  if (!Array.isArray(affectedOutcomeIds) || affectedOutcomeIds.length === 0) return plan;
  const filter = new Set(affectedOutcomeIds);
  return plan.filter((violation) => filter.has(violation.outcomeId));
}

// --- 5. THE tolerance-widening / control-weakening guard --------------------

/**
 * Canonical identity digest for one DeclaredViolation (negative-controls.mjs
 * shape: `{ stepId, outcomeId, kind, statement }`). `statement` already
 * embeds the tolerance's own bound values as text (e.g. an exact
 * "rel_epsilon=0.05" or "epsilon_seconds=30" figure) — deriveDeclaredViolation
 * computes it straight from the Flow contract — so this digest changes the
 * moment the declared bound changes, with no separate bound-parsing logic
 * to maintain here.
 */
export function declaredViolationDigest(violation) {
  const v = isPlainObject(violation) ? violation : {};
  return contentDigest({ stepId: v.stepId ?? null, outcomeId: v.outcomeId ?? null, kind: v.kind ?? null, statement: v.statement ?? null });
}

/**
 * THE guard negative-controls.mjs's module footer names as NOT built there:
 * "#160 must additionally guard against a repair candidate widening its own
 * tolerance so its control passes more easily."
 *
 * A negative control only proves anything if it actually exercised the
 * violation the Flow's OWN (protected, therefore unchanged) tolerance
 * requires. #152's judgeNegativeControl proves only "some assertion failed
 * for some reported reason" — it has no notion of WHICH violation was
 * applied. A repair that quietly widens its own tolerance (or otherwise
 * weakens what its assertion actually checks) can still make its control
 * report "assertion-failed" by applying an easier, larger, more obvious
 * perturbation than the one actually required — passing #152's coverage
 * check while the real declared violation would no longer be caught.
 *
 * This function closes that gap: `plan` is `reconstructProofObligations`'s
 * (or buildNegativeControlPlan's) output — the declared violation for each
 * outcome, recomputed from the untouched Flow contract. `reports` is #152's
 * NegativeControlReport shape, extended with the one additional field this
 * repair-specific gate requires and #152 does not: a harness-computed
 * `appliedViolation.declaredViolationDigest`, a canonical-digest.mjs
 * contentDigest the harness computes over the EXACT perturbation it applied
 * — never copied from the plan by the module itself, always attested by
 * the execution half that actually ran the control (the same trust
 * boundary #152's `mode: "executed"` already relies on: this module judges
 * a report, it does not and cannot independently re-run the harness).
 *
 * Returns `{ valid, violations }` where `violations` is
 * `[{ stepId, outcomeId, expectedDigest, reportedDigest }]` for every report
 * whose applied violation does not match its declared one. A report with no
 * matching plan entry, or a plan entry with no report, is not this
 * function's concern — checkNegativeControlCoverage already fails a missing
 * report. Never throws.
 */
export function checkNegativeControlNotWeakened(plan, reports) {
  const violations = [];
  const planList = Array.isArray(plan) ? plan : [];
  const planByKey = new Map(planList.map((v) => [`${v.stepId}::${v.outcomeId}`, v]));

  for (const report of Array.isArray(reports) ? reports : []) {
    if (!isPlainObject(report) || typeof report.stepId !== "string" || typeof report.outcomeId !== "string") continue;
    const key = `${report.stepId}::${report.outcomeId}`;
    const declared = planByKey.get(key);
    if (!declared) continue;

    const expectedDigest = declaredViolationDigest(declared);
    const reportedDigest = isPlainObject(report.appliedViolation) ? report.appliedViolation.declaredViolationDigest : undefined;

    if (reportedDigest !== expectedDigest) {
      violations.push({
        stepId: report.stepId,
        outcomeId: report.outcomeId,
        expectedDigest,
        reportedDigest: reportedDigest ?? null,
        message:
          `negative control for Expected Outcome ${JSON.stringify(report.outcomeId)} on step ${JSON.stringify(report.stepId)} did not apply the ` +
          `flow's own declared violation (expected declaredViolationDigest ${expectedDigest}, got ${JSON.stringify(reportedDigest ?? null)}) — ` +
          "this is exactly how a repair could widen its own tolerance or weaken an assertion so its own control passes more easily; rejected",
      });
    }
  }
  return { valid: violations.length === 0, violations };
}

// --- 6. Neighbouring coverage must not break --------------------------------

/**
 * DESIGN-dynamic-qa-spec.md §7 step 6: "neighboring tests" must still pass.
 * The deterministic-core half of that is coverage, not execution
 * (execution is the same verification-sandbox seam every other module
 * defers to) — reuses expected-outcome-coverage.mjs's checkAssertionCoverage
 * exactly, once per neighbouring flow, over the assertion list AS IT STANDS
 * AFTER the repair. `neighbors` is `[{ flowId, flowData, assertions }]`.
 * Returns `{ valid, violations }` where `violations` is
 * `[{ flowId, errors }]` for every neighbour whose coverage broke. Never
 * throws.
 */
export function checkNeighboringCoverageUnbroken(neighbors) {
  const violations = [];
  for (const neighbor of Array.isArray(neighbors) ? neighbors : []) {
    if (!isPlainObject(neighbor) || typeof neighbor.flowId !== "string") continue;
    const result = checkAssertionCoverage(neighbor.flowData, neighbor.assertions);
    if (!result.valid) {
      violations.push({ flowId: neighbor.flowId, errors: result.errors });
    }
  }
  return { valid: violations.length === 0, violations };
}

// --- 7. The Repair Review Packet --------------------------------------------

/**
 * The exact, closed set of sections DESIGN-dynamic-qa-spec.md §7 step 7 and
 * SPEC-135.md user story 81 require a Repair Review Packet to show:
 * evidence, mappings, protected-contract digests, the diff, verification
 * results, and residual risk. Exactly these six, never more, never fewer.
 */
export const REPAIR_REVIEW_PACKET_SECTIONS = Object.freeze([
  "evidence",
  "mappings",
  "protectedContractDigests",
  "diff",
  "verification",
  "residualRisk",
]);

/**
 * Validates that a value carries exactly the six required Repair Review
 * Packet sections (no more, no fewer — a packet missing "residualRisk", or
 * one that smuggled an extra section in, both fail). Returns
 * `{ valid, errors }`. Never throws.
 */
export function validateRepairReviewPacket(packet) {
  const errors = [];
  if (!isPlainObject(packet)) {
    errors.push({ path: [], message: "a Repair Review Packet must be a mapping" });
    return { valid: false, errors };
  }
  const required = new Set(REPAIR_REVIEW_PACKET_SECTIONS);
  for (const key of Object.keys(packet)) {
    if (!required.has(key)) errors.push({ path: [key], message: `unknown Repair Review Packet section ${JSON.stringify(key)}` });
  }
  for (const section of REPAIR_REVIEW_PACKET_SECTIONS) {
    if (!(section in packet)) errors.push({ path: [section], message: `missing required Repair Review Packet section ${JSON.stringify(section)}` });
  }
  return { valid: errors.length === 0, errors };
}

// --- 8. The orchestrator -----------------------------------------------------

/**
 * THE single function `qa-generate repair` calls to decide whether a
 * proposed repair may be presented as a Repair Review Packet, and to build
 * that packet when it may. Composes every gate above, plus #159's
 * isBundleRepairEligible and #152's checkNegativeControlCoverage, in the
 * exact order DESIGN-dynamic-qa-spec.md §7 lays out. Stops at the FIRST
 * failing gate — repair never "partially" proceeds, and never patches
 * around one failed gate by weakening another.
 *
 * `input`:
 *   - bundle: a Failure Evidence Bundle (#159 shape).
 *   - hypothesesConsidered: string[] — every distinct causal hypothesis this
 *     invocation pursued (normally just `[bundle.diagnosisRecord.causalChain]`).
 *   - proposedFiles: `[{ path, content }]` — the repair diff. NEVER written
 *     to disk by this module; flows straight into the packet's `diff`.
 *   - assertions: `[{ stepId, outcomeId, location }]` — the candidate's
 *     assertion list AFTER the proposed repair (unchanged assertions plus
 *     whatever the mechanical fix touches).
 *   - flowData: the Flow Definition (read-only; used to reconstruct proof
 *     obligations and the negative-control plan).
 *   - affectedOutcomeIds: string[] the evidence's expectedVsObserved names,
 *     for the mappings section.
 *   - protectedContractsBefore / protectedContractsAfter: snapshot objects
 *     keyed by PROTECTED_CONTRACT_CATEGORIES.
 *   - negativeControlReports: #152 NegativeControlReport shape, extended
 *     with `appliedViolation.declaredViolationDigest`.
 *   - neighboringFlows: `[{ flowId, flowData, assertions }]`.
 *   - residualRisk: string | string[] — caller-supplied, shown verbatim.
 *
 * Returns `{ status: "proposal" | "refused", reasons, packet }`. `packet` is
 * populated ONLY on `status === "proposal"` — a refusal never emits a
 * packet, matching "repair proposes; it never applies, never heals
 * silently" (a refusal is not a weaker proposal, it is no proposal at all).
 * Never throws.
 */
export function evaluateRepairProposal(input = {}) {
  const {
    bundle,
    hypothesesConsidered,
    proposedFiles = [],
    assertions = [],
    flowData,
    affectedOutcomeIds = [],
    protectedContractsBefore = {},
    protectedContractsAfter = {},
    negativeControlReports = [],
    neighboringFlows = [],
    residualRisk = [],
  } = input;

  const reasons = [];

  // Step 1 (spec §7 step 1 / #159's seam): only a confirmed binding-owned
  // bundle may proceed at all.
  const eligibility = isBundleRepairEligible(bundle);
  if (!eligibility.eligible) {
    reasons.push({ gate: "bundle-eligibility", detail: eligibility });
    return { status: "refused", reasons, packet: null };
  }

  // One causal hypothesis, never a loop.
  const hypotheses = Array.isArray(hypothesesConsidered) && hypothesesConsidered.length > 0
    ? hypothesesConsidered
    : [bundle?.diagnosisRecord?.causalChain];
  const hypothesisCheck = checkSingleCausalHypothesis(hypotheses);
  if (!hypothesisCheck.valid) {
    reasons.push({ gate: "single-causal-hypothesis", detail: hypothesisCheck });
    return { status: "refused", reasons, packet: null };
  }

  // Only mechanical Binding concerns are editable — path layer.
  const scopeCheck = checkRepairFilesAreMechanicalOnly(proposedFiles);
  if (!scopeCheck.valid) {
    reasons.push({ gate: "mechanical-scope", detail: scopeCheck });
    return { status: "refused", reasons, packet: null };
  }

  // No skips/fixme/placeholders/always-true assertions in the proposed diff.
  const forbidden = scanGeneratedFiles(proposedFiles);
  if (!forbidden.clean) {
    reasons.push({ gate: "forbidden-pattern", detail: forbidden });
    return { status: "refused", reasons, packet: null };
  }

  // Protected-contract digests — the structural guarantee across every
  // named off-limits category.
  const protectedCheck = checkProtectedContractsUnchanged(protectedContractsBefore, protectedContractsAfter);
  if (!protectedCheck.valid) {
    reasons.push({ gate: "protected-contracts", detail: protectedCheck });
    return { status: "refused", reasons, packet: null };
  }

  // Coverage must remain complete after the mechanical fix.
  const coverage = flowData ? checkAssertionCoverage(flowData, assertions) : { valid: false, errors: [{ path: [], message: "flowData is required to reconstruct the proof obligation" }] };
  if (!coverage.valid) {
    reasons.push({ gate: "assertion-coverage", detail: coverage });
    return { status: "refused", reasons, packet: null };
  }

  // A failing negative control is required...
  const plan = flowData ? buildNegativeControlPlan(flowData) : [];
  const negativeControlCoverage = checkNegativeControlCoverage(assertions, negativeControlReports);
  if (!negativeControlCoverage.valid) {
    reasons.push({ gate: "negative-control-coverage", detail: negativeControlCoverage });
    return { status: "refused", reasons, packet: null };
  }

  // ...and it must be the DECLARED control, never one the repair weakened.
  const negativeControlNotWeakened = checkNegativeControlNotWeakened(plan, negativeControlReports);
  if (!negativeControlNotWeakened.valid) {
    reasons.push({ gate: "negative-control-not-weakened", detail: negativeControlNotWeakened });
    return { status: "refused", reasons, packet: null };
  }

  // Neighbouring coverage must not have broken.
  const neighboringCoverage = checkNeighboringCoverageUnbroken(neighboringFlows);
  if (!neighboringCoverage.valid) {
    reasons.push({ gate: "neighboring-coverage", detail: neighboringCoverage });
    return { status: "refused", reasons, packet: null };
  }

  // Every gate passed: assemble the ONE Repair Review Packet and stop.
  const mappings = flowData ? reconstructProofObligations(flowData, affectedOutcomeIds) : [];
  const packet = {
    evidence: {
      bundleId: bundle.bundleId,
      repository: bundle.repository,
      sourceCommit: bundle.sourceCommit,
      workflow: bundle.workflow,
      diagnosisRecord: {
        diagnosisId: bundle.diagnosisRecord.diagnosisId,
        owner: bundle.diagnosisRecord.owner,
        repeatability: bundle.diagnosisRecord.repeatability,
        failureClass: bundle.diagnosisRecord.failureClass,
        causalChain: bundle.diagnosisRecord.causalChain,
      },
    },
    mappings,
    protectedContractDigests: { before: protectedCheck.before, after: protectedCheck.after },
    diff: proposedFiles,
    verification: {
      coverage,
      negativeControlCoverage,
      negativeControlNotWeakened,
      neighboringCoverage,
      forbidden,
    },
    residualRisk,
  };

  const packetCheck = validateRepairReviewPacket(packet);
  if (!packetCheck.valid) {
    // Should be unreachable given the fixed shape above; fail closed rather
    // than emit a malformed packet.
    reasons.push({ gate: "packet-shape", detail: packetCheck });
    return { status: "refused", reasons, packet: null };
  }

  return { status: "proposal", reasons: [], packet };
}
