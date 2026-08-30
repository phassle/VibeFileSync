// dynamic-qa/shared/scripts/negative-controls.mjs
//
// Ticket #152: "A generated assertion is only evidence if it can fail.
// Before a Binding reaches review, prove that each assertion still fails
// for the violation it is supposed to catch." (tickets/152.md)
//
// This module is the deterministic half of the negative-control gate. It
// answers two questions that are pure computation over already-validated
// data:
//
//   1. What violation SHOULD make a given Expected Outcome's assertion
//      fail? (`deriveDeclaredViolation` / `buildNegativeControlPlan`) —
//      derived only from the Flow contract already on file (the outcome's
//      tolerance kind and the owned boundary's declared role), never
//      invented per-candidate.
//   2. Given a report of what actually happened when a control ran, was
//      that a valid, accepted negative control? (`judgeNegativeControl`,
//      `checkNegativeControlCoverage`) — never trusting a report that
//      does not explicitly say the control was executed and that it exercised
//      the assertion path, not an unrelated crash/timeout.
//
// It deliberately does NOT execute anything. Actually mutating a fixture or
// environment to realize a violation, running the candidate's assertion
// against that mutation, and observing what happened is harness-specific
// (API/CLI/browser) and belongs to the generation/verification pipeline in
// qa-generate/SKILL.md — see the module-level seam note at the bottom of
// this file. This module only ever consumes a `NegativeControlReport` the
// execution half hands back; it never assumes success, never times out,
// and never treats "did not run" as "passed".

import { collectExpectedOutcomeIds } from "./expected-outcome-coverage.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// --- 1. Deriving the declared violation -----------------------------------

/**
 * A closed set of ways a control run can conclude. Only "assertion-failed"
 * is an acceptable negative control result. "assertion-passed" is the
 * always-true-assertion case the ticket exists to catch. "crash" and
 * "timeout" are explicitly named because the acceptance criteria requires
 * the control to exercise the DECLARED violation, not an unrelated failure
 * mode — a candidate that merely throws under a malformed fixture proves
 * nothing about whether its assertion logic can ever fail on purpose.
 */
export const OUTCOME_MODES = Object.freeze([
  "assertion-failed",
  "assertion-passed",
  "crash",
  "timeout",
]);

/**
 * The only mode that may ever count as "the control ran for real". Every
 * other string (including the deliberately suggestive "simulated",
 * "skipped", "assumed", "n/a") is rejected by `judgeNegativeControl` below.
 * There is no list of "known-bad" execution modes to check against —
 * anything other than this exact literal is fail-closed, so a report format
 * this module has never seen cannot be mistaken for a passing control.
 */
export const EXECUTED_MODE = "executed";

/**
 * Derives the violation that a `{ stepId, outcomeId }` Expected Outcome's
 * negative control must exercise, from the Flow contract alone: the
 * outcome's own tolerance (spec 5.1 v1 kinds) and, when present, the
 * boundary this flow declares as `role: "owned"` (boundary-policy.mjs's
 * vocabulary — the boundary the outcome is actually proving something
 * about). Nothing here is invented per-candidate: the same outcome/
 * tolerance/boundary triple always derives the same violation.
 *
 * Returns a tech-neutral, harness-agnostic `DeclaredViolation`:
 *   { outcomeId, stepId, kind, statement, requiresManualStatement }
 *
 * `statement` is prose precise enough for a human review packet and for a
 * harness-specific generator to translate into a concrete fixture mutation
 * (e.g. "move the observed numeric value outside the approved rel_epsilon
 * window"), but it is never itself an assertion, a selector, or code — that
 * translation is the execution half's job (see the module footer).
 *
 * `requiresManualStatement` is true only for `custom` tolerance: v1 has no
 * deterministic notion of what invalidates a custom-approved comparison, so
 * this function refuses to invent one. It surfaces the tolerance's own
 * `reason`/`approved_by` as the only statement it is entitled to make, and
 * callers (verification, review) must treat a `custom` outcome's negative
 * control as still owed, not exempted, exactly like every other outcome.
 */
export function deriveDeclaredViolation({ stepId, outcomeId, tolerance, ownedBoundary } = {}) {
  const kind = isPlainObject(tolerance) && typeof tolerance.kind === "string" ? tolerance.kind : "exact";
  const boundaryNote =
    ownedBoundary && typeof ownedBoundary.id === "string"
      ? ` on the owned boundary ${JSON.stringify(ownedBoundary.id)}`
      : "";

  switch (kind) {
    case "normalized-text":
      return {
        stepId,
        outcomeId,
        kind,
        statement: `the observed text must differ from the expected text in a way that survives the declared normalization (ignore_case/ignore_whitespace/trim)${boundaryNote} — not merely a difference the tolerance itself absorbs`,
        requiresManualStatement: false,
      };
    case "numeric": {
      const bound = isPlainObject(tolerance)
        ? "abs_epsilon" in tolerance
          ? `abs_epsilon=${tolerance.abs_epsilon}`
          : `rel_epsilon=${tolerance.rel_epsilon}`
        : "its declared epsilon";
      return {
        stepId,
        outcomeId,
        kind,
        statement: `the observed numeric value must move strictly outside the approved ${bound} window from the expected value${boundaryNote}`,
        requiresManualStatement: false,
      };
    }
    case "temporal": {
      const seconds = isPlainObject(tolerance) ? tolerance.epsilon_seconds : "its declared";
      return {
        stepId,
        outcomeId,
        kind,
        statement: `the observed time must move strictly outside the approved epsilon_seconds=${seconds} window from the expected time${boundaryNote}`,
        requiresManualStatement: false,
      };
    }
    case "unordered-set":
      return {
        stepId,
        outcomeId,
        kind,
        statement: `the observed set must gain or lose at least one member relative to the expected set${boundaryNote} — order alone must not be the induced difference`,
        requiresManualStatement: false,
      };
    case "presentation":
      return {
        stepId,
        outcomeId,
        kind,
        statement: `a non-ignorable aspect (content, values, behavior, accessibility semantics, or counts) must be wrong${boundaryNote} — perturbing only an ignored aspect (layout, style, position) is not a valid violation for this outcome`,
        requiresManualStatement: false,
      };
    case "custom":
      return {
        stepId,
        outcomeId,
        kind,
        statement: isPlainObject(tolerance) && typeof tolerance.reason === "string"
          ? `custom tolerance approved by ${JSON.stringify(tolerance.approved_by ?? "unknown")} for: ${tolerance.reason} — v1 has no deterministic violation for a custom comparison; the approver's own reason is the only basis this module may state, and a control is still required`
          : "custom tolerance with no recorded reason — a negative control is still required and must be justified by the same approver at review time",
        requiresManualStatement: true,
      };
    case "exact":
    default:
      return {
        stepId,
        outcomeId,
        kind: "exact",
        statement: `the observed value must differ from the exact expected value${boundaryNote}`,
        requiresManualStatement: false,
      };
  }
}

function findOwnedBoundary(boundaries) {
  if (!Array.isArray(boundaries)) return undefined;
  return boundaries.find((b) => isPlainObject(b) && b.role === "owned");
}

function findOutcome(flowData, stepId, outcomeId) {
  for (const step of flowData.steps ?? []) {
    if (step.id !== stepId) continue;
    for (const outcome of step.outcomes ?? []) {
      if (outcome.id === outcomeId) return outcome;
    }
  }
  return undefined;
}

/**
 * Derives one `DeclaredViolation` per Expected Outcome the Flow Definition
 * declares (reusing expected-outcome-coverage.mjs's own
 * `collectExpectedOutcomeIds` — never a second declaration-order walk).
 * This is the plan a review packet shows and the execution half must
 * satisfy: one control obligation per declared outcome, derived from the
 * flow's own contract.
 */
export function buildNegativeControlPlan(flowData, boundaries) {
  const ownedBoundary = findOwnedBoundary(boundaries ?? flowData.boundaries);
  return collectExpectedOutcomeIds(flowData).map(({ stepId, outcomeId }) => {
    const outcome = findOutcome(flowData, stepId, outcomeId);
    return deriveDeclaredViolation({
      stepId,
      outcomeId,
      tolerance: outcome?.tolerance,
      ownedBoundary,
    });
  });
}

// --- 2. Judging a reported control run --------------------------------

/**
 * Judges one `NegativeControlReport` — what the execution half says
 * happened when it ran a candidate's assertion against a declared
 * violation. Expected shape:
 *
 *   { stepId, outcomeId, mode, appliedViolation }
 *
 * where `mode` must be exactly `EXECUTED_MODE` ("executed") for this report
 * to be considered "ran for real" at all, and `appliedViolation.outcome`
 * must be exactly `"assertion-failed"` (one of `OUTCOME_MODES`) for it to
 * be *accepted*.
 *
 * Returns `{ accepted, reason }` where `reason` is one of:
 *   - `"not-executed"` — `mode` was missing, or anything other than the
 *     literal "executed" (this is the guard against a simulated or unrun
 *     control ever being recorded as satisfied — there is no allowance for
 *     "probably ran", only the one accepted literal);
 *   - `"assertion-did-not-fail"` — the control ran, but the candidate's
 *     assertion passed anyway: the always-true-assertion / false-pass case
 *     this ticket exists to catch;
 *   - `"unrelated-failure"` — the control ran and the assertion did not
 *     pass, but the reported outcome was `"crash"` or `"timeout"`, not
 *     `"assertion-failed"` — the candidate broke for some other reason, so
 *     nothing was proven about whether the assertion logic itself can fail
 *     on purpose;
 *   - `"malformed-report"` — the report is not shaped like a
 *     NegativeControlReport at all;
 *   - `null` when accepted.
 */
export function judgeNegativeControl(report) {
  if (!isPlainObject(report) || typeof report.stepId !== "string" || typeof report.outcomeId !== "string") {
    return { accepted: false, reason: "malformed-report" };
  }
  if (report.mode !== EXECUTED_MODE) {
    return { accepted: false, reason: "not-executed" };
  }
  const outcome = isPlainObject(report.appliedViolation) ? report.appliedViolation.outcome : undefined;
  if (!OUTCOME_MODES.includes(outcome)) {
    return { accepted: false, reason: "malformed-report" };
  }
  if (outcome === "assertion-passed") {
    return { accepted: false, reason: "assertion-did-not-fail" };
  }
  if (outcome === "crash" || outcome === "timeout") {
    return { accepted: false, reason: "unrelated-failure" };
  }
  // outcome === "assertion-failed"
  return { accepted: true, reason: null };
}

// --- 3. Coverage: every assertion needs an accepted control ---------------

/**
 * Checks that every generated assertion `{ stepId, outcomeId, location }`
 * (the same shape expected-outcome-coverage.mjs consumes) has a
 * corresponding, accepted negative-control report. A missing control is a
 * failure, not a warning — same Issues shape (`{ path, message }`) used
 * across the deterministic core, so a caller can fold this straight into
 * the same review packet as `checkAssertionCoverage`.
 *
 * `reports` is `[NegativeControlReport]`, one entry expected per distinct
 * `{ stepId, outcomeId }` the assertions reference (multiple assertions for
 * the same outcome share that outcome's one control — the coverage
 * obligation is per Expected Outcome, matching expected-outcome-coverage.mjs's
 * own per-outcome, not per-assertion, proof requirement).
 *
 * Never throws; collects every problem so a review packet can show a
 * complete list of what is missing or unaccepted, not just the first.
 */
export function checkNegativeControlCoverage(assertions, reports) {
  const errors = [];

  if (!Array.isArray(assertions)) {
    errors.push({ path: ["assertions"], message: "assertions must be a list" });
    return { valid: false, errors };
  }
  if (!Array.isArray(reports)) {
    errors.push({ path: ["reports"], message: "negative control reports must be a list" });
    return { valid: false, errors };
  }

  const key = (a) => `${a.stepId}::${a.outcomeId}`;
  const neededKeys = new Set();
  assertions.forEach((assertion) => {
    if (isPlainObject(assertion) && typeof assertion.stepId === "string" && typeof assertion.outcomeId === "string") {
      neededKeys.add(key(assertion));
    }
  });

  const judgedByKey = new Map();
  reports.forEach((report, i) => {
    const judgment = judgeNegativeControl(report);
    if (judgment.reason === "malformed-report") {
      errors.push({
        path: ["reports", i],
        message: "each negative control report must be a mapping with stepId, outcomeId, mode, and appliedViolation.outcome",
      });
      return;
    }
    const k = key(report);
    // The first accepted judgment for a key wins; if none is ever accepted
    // the last judgment's reason is what gets reported below — but a
    // rejection is never silently overwritten by a later "not-executed" or
    // similar weaker report for the same key.
    const existing = judgedByKey.get(k);
    if (!existing || !existing.accepted) {
      judgedByKey.set(k, judgment);
    }
  });

  for (const k of neededKeys) {
    const [stepId, outcomeId] = k.split("::");
    const judgment = judgedByKey.get(k);
    if (!judgment) {
      errors.push({
        path: ["reports"],
        message: `Expected Outcome ${JSON.stringify(outcomeId)} on step ${JSON.stringify(stepId)} has no negative control report at all — a missing control is a failure, not a warning`,
      });
    } else if (!judgment.accepted) {
      errors.push({
        path: ["reports"],
        message: `Expected Outcome ${JSON.stringify(outcomeId)} on step ${JSON.stringify(stepId)}'s negative control was rejected (${judgment.reason}) — the Binding cannot be reported as verified while its control does not prove the assertion can fail`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- Seam: where computation stops and execution begins -------------------
//
// Everything above this line is pure and total: given the same Flow data
// and the same NegativeControlReport, the same verdict comes back, with no
// I/O, no clock, no process spawn, and no notion of "harness". This is the
// deterministic-core half the run brief's decision 5 requires.
//
// The execution half — NOT built here, and out of scope for this ticket —
// is whatever qa-generate/SKILL.md's step 6 (and #160's guarded repair
// verify step) actually does inside the approved candidate-verification
// sandbox for one `DeclaredViolation`:
//   1. Take `{ stepId, outcomeId, kind, statement }` from
//      `buildNegativeControlPlan`.
//   2. Realize `statement` as a concrete fixture/input mutation in whatever
//      harness (API/CLI/browser) the candidate uses — e.g. for a numeric
//      tolerance, substitute a value the statement's window excludes.
//   3. Run the candidate's existing assertion for that `{stepId,outcomeId}`
//      unchanged against the mutated input.
//   4. Report back exactly what happened as a `NegativeControlReport`:
//      `mode: "executed"` only when the run genuinely happened (never set
//      this from a dry run, a plan, or an assumption), and
//      `appliedViolation.outcome` as the one true observation — the
//      assertion failed, passed, crashed, or timed out.
//
// Handing this module anything other than a real `NegativeControlReport`
// with `mode: "executed"` is exactly the "simulated or unrun control
// mistaken for a passing one" failure the ticket calls out, and this
// module has no code path that treats a missing or non-"executed" `mode`
// as success — `judgeNegativeControl` fails closed on it every time.
