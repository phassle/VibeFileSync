// dynamic-qa/shared/scripts/lifecycle-state.mjs
//
// Ticket #157 (DESIGN-dynamic-qa-spec.md §8, SPEC-135.md user stories
// 60-64): the lifecycle rules layer over three independent axes —
//
//   Flow State        draft | deferred | active | retired      (flow-definition.mjs FLOW_STATES)
//   Binding Freshness  absent | current | stale                (drift-gate.mjs FRESHNESS_STATES)
//   Enforcement State  advisory | required                     (provenance.mjs ENFORCEMENT_LANES)
//
// This module does not redeclare any of the three enums — it imports them
// from the modules that already own each artifact (#143/#148/#146), because
// the independence the ticket asks for is not just "three separate fields",
// it is "three separate OWNERS": Flow State lives in the Flow Definition
// contract, Binding Freshness is mechanically derived by the drift gate,
// Enforcement State is recorded in the Provenance Manifest. Nothing here
// re-derives staleness (#148's job) or invents a fourth place those values
// could live.
//
// THE STRUCTURAL GUARANTEE THIS MODULE EXISTS TO PROVIDE
// --------------------------------------------------------------------------
// "A failure must never silently rewrite policy" is enforced structurally,
// not just by omission:
//
//   - Each axis has exactly one apply* function (applyFlowStateChange,
//     applyBindingFreshnessReport, applyEnforcementPromotion), and each one
//     declares a fixed, small set of delta keys it will ever accept
//     (FLOW_STATE_DELTA_KEYS / FRESHNESS_DELTA_KEYS / ENFORCEMENT_DELTA_KEYS).
//   - `foreignKeyErrors` rejects a delta carrying ANY key outside that set
//     before any transition logic runs. A real test-outcome object — the
//     shape a test runner actually produces, e.g.
//     `{ passed, bindingId, failureReason }` — carries none of the keys any
//     axis's delta accepts, so passing it to ANY of the three apply*
//     functions is refused at the door, on shape alone, before the
//     function's own transition rules are even consulted. There is no
//     parameter path from "a test failed" into a state change; a caller
//     cannot even construct a call that would express it.
//   - No function in this module ever writes more than one axis's field.
//     Each apply* function spreads the caller's existing record and
//     replaces exactly its own key; the other two keys pass through
//     untouched by construction (object spread, not a hand-written
//     multi-field merge that a future edit could widen).
//   - There is no "demote enforcement" or "mark stale" function at all.
//     Enforcement State only ever moves advisory -> required, through
//     `applyEnforcementPromotion`, which itself refuses without BOTH a
//     measured Qualifying Run count and an explicit approval (see below).
//     The absence of a reverse-direction function is deliberate: nothing
//     here can write "advisory" over a "required" Binding, or "stale" over
//     a Flow's state, because no exported function's signature allows it.

import { FLOW_STATES } from "./flow-definition.mjs";
import { FRESHNESS_STATES } from "./drift-gate.mjs";
import { ENFORCEMENT_LANES } from "./provenance.mjs";
import { validateAuthorityRecord, GATE_KEYS } from "./authority.mjs";

export { FLOW_STATES, FRESHNESS_STATES, ENFORCEMENT_LANES };

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(record) {
  return isPlainObject(record) ? record : createLifecycleRecord();
}

function foreignKeyErrors(delta, allowedKeys, axisLabel) {
  if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
    return [`${axisLabel} delta must be a plain object (got ${JSON.stringify(delta)})`];
  }
  const allowed = new Set(allowedKeys);
  const foreign = Object.keys(delta).filter((key) => !allowed.has(key));
  if (foreign.length > 0) {
    return [
      `${axisLabel} delta carries key(s) ${foreign.map((k) => JSON.stringify(k)).join(", ")} that do not belong to the ${axisLabel} axis — only ${allowedKeys
        .map((k) => JSON.stringify(k))
        .join(", ")} may ever appear in a ${axisLabel} delta, so this input cannot express a change to any other axis`,
    ];
  }
  return [];
}

/**
 * The starting point for a Flow that has never been activated: `draft` /
 * `absent` / `advisory`. `advisory` is a harmless default here — there is
 * nothing to enforce yet, since no Binding exists.
 */
export function createLifecycleRecord() {
  return Object.freeze({ flowState: "draft", bindingFreshness: "absent", enforcementState: "advisory" });
}

// ---------------------------------------------------------------------------
// Axis 1: Flow State
// ---------------------------------------------------------------------------

// Allowed Flow State transitions (DESIGN-dynamic-qa-spec.md §8). `retired`
// is terminal: it appears only as a `to`, never as a `from`, in this table —
// that absence IS the terminal rule, not a separate check bolted on.
export const ALLOWED_FLOW_TRANSITIONS = Object.freeze([
  Object.freeze({ from: "draft", to: "deferred" }),
  Object.freeze({ from: "draft", to: "active" }),
  Object.freeze({ from: "deferred", to: "active" }),
  Object.freeze({ from: "active", to: "deferred" }),
  Object.freeze({ from: "draft", to: "retired" }),
  Object.freeze({ from: "deferred", to: "retired" }),
  Object.freeze({ from: "active", to: "retired" }),
]);

// Reasons that must NEVER justify an active -> deferred suspension. The spec
// is explicit: "never because it failed, flakes, is slow, or is
// inconvenient." Suspension is an exceptional reviewed decision that the
// flow genuinely cannot run at all — not a QA escape hatch for a red suite.
export const FORBIDDEN_SUSPENSION_REASONS = Object.freeze(["test-failure", "flaky", "slow", "inconvenient"]);

// The nine independently-checked Activation requirements, in the order the
// ticket names them. `checkActivationRequirements` evaluates every one of
// them (never short-circuits), then names the FIRST unmet requirement as
// the refusal reason — "every precondition is checked" and "refused naming
// the first unmet one" both hold at once.
export const ACTIVATION_REQUIREMENTS = Object.freeze([
  Object.freeze({ key: "productBehaviourApproved", label: "approved product behaviour" }),
  Object.freeze({ key: "deterministicObservability", label: "deterministic observability" }),
  Object.freeze({ key: "stableInteractionPoints", label: "stable interaction points" }),
  Object.freeze({ key: "dataIsolationAndCleanup", label: "isolated data and cleanup" }),
  Object.freeze({ key: "enforceableBoundaries", label: "enforceable boundaries" }),
  Object.freeze({ key: "capabilityGatePassed", label: "a passing Capability Gate" }),
  Object.freeze({ key: "candidateBindingVerified", label: "a verified candidate Binding" }),
  Object.freeze({ key: "provenanceCurrent", label: "current provenance" }),
  Object.freeze({ key: "bothApprovalsGranted", label: "both approvals" }),
]);

function bothApprovalsGranted(approvals) {
  const record = isPlainObject(approvals) ? approvals : {};
  const result = validateAuthorityRecord(record);
  if (!result.ok) return false;
  return GATE_KEYS.every((key) => record[key]?.present === true);
}

/**
 * Runs all nine Activation requirements, unconditionally, in the fixed
 * order above — no early return once one is unmet. Returns
 * `{ met, unmet, firstUnmet }`: `unmet` lists every requirement not
 * satisfied by `evidence`; `firstUnmet` is `unmet[0]` (or `null` when
 * `met`). `evidence.approvals` reuses authority.mjs's own gate shape
 * (`qaOwnerGate` / `technicalOwnerGate`) rather than a bespoke boolean pair,
 * so "both approvals" can never collapse into one combined field here
 * either.
 */
export function checkActivationRequirements(evidence) {
  const ev = isPlainObject(evidence) ? evidence : {};
  const unmet = [];
  for (const requirement of ACTIVATION_REQUIREMENTS) {
    const met = requirement.key === "bothApprovalsGranted" ? bothApprovalsGranted(ev.approvals) : ev[requirement.key] === true;
    if (!met) {
      unmet.push({
        key: requirement.key,
        message: `activation requires ${requirement.label}, which this evidence does not satisfy`,
      });
    }
  }
  return { met: unmet.length === 0, unmet, firstUnmet: unmet[0] ?? null };
}

/**
 * The one function callers should use to decide whether a Flow may move to
 * `active`. There is no path through this function that returns
 * `activate: true` while any requirement is unmet — mirrors
 * capability-gate.mjs's `activationDecision` shape deliberately.
 */
export function decideFlowActivation(evidence) {
  const result = checkActivationRequirements(evidence);
  if (!result.met) {
    return { activate: false, state: "deferred", firstUnmet: result.firstUnmet, unmet: result.unmet };
  }
  return { activate: true, state: "active", firstUnmet: null, unmet: [] };
}

/**
 * Decides one Flow State transition. `context` shape depends on `to`:
 *   - `to: "deferred"` from `draft`  -> `{ contractApproved: true }`
 *   - `to: "active"`                 -> `{ activationEvidence }` (see
 *     `checkActivationRequirements`)
 *   - `to: "deferred"` from `active` -> `{ suspension: { reason } }`, and
 *     `reason` must not be one of `FORBIDDEN_SUSPENSION_REASONS`
 *   - `to: "retired"`                -> `{ retirement: { approvedBy,
 *     bindingRemoved: true, ciEnrollmentRemoved: true } }`
 * Returns `{ allowed, to, reason }`; `allowed` is only ever `true` when the
 * pair is in `ALLOWED_FLOW_TRANSITIONS` AND the transition-specific
 * evidence above is fully satisfied.
 */
export function decideFlowStateTransition(from, to, context = {}) {
  const ctx = isPlainObject(context) ? context : {};

  if (!FLOW_STATES.includes(from)) {
    return { allowed: false, to: null, reason: `unknown current Flow State ${JSON.stringify(from)}` };
  }
  if (!FLOW_STATES.includes(to)) {
    return { allowed: false, to: null, reason: `unknown target Flow State ${JSON.stringify(to)}` };
  }
  const isKnownPair = ALLOWED_FLOW_TRANSITIONS.some((t) => t.from === from && t.to === to);
  if (!isKnownPair) {
    return {
      allowed: false,
      to: null,
      reason: `${JSON.stringify(from)} -> ${JSON.stringify(to)} is not an allowed Flow State transition${from === "retired" ? " (retired is terminal)" : ""}`,
    };
  }

  if (to === "deferred" && from === "draft") {
    if (ctx.contractApproved !== true) {
      return { allowed: false, to: null, reason: "draft -> deferred requires the contract to be approved (contractApproved: true)" };
    }
    return { allowed: true, to: "deferred", reason: null };
  }

  if (to === "deferred" && from === "active") {
    const reason = ctx.suspension?.reason;
    if (typeof reason !== "string" || reason.trim() === "") {
      return { allowed: false, to: null, reason: "active -> deferred requires an explicit reviewed suspension.reason" };
    }
    if (FORBIDDEN_SUSPENSION_REASONS.includes(reason)) {
      return {
        allowed: false,
        to: null,
        reason: `active -> deferred refused: ${JSON.stringify(reason)} is never a valid suspension reason (failure, flake, slowness, and inconvenience never suspend a flow) — the flow genuinely must not be able to run`,
      };
    }
    return { allowed: true, to: "deferred", reason: null };
  }

  if (to === "active") {
    const activation = decideFlowActivation(ctx.activationEvidence);
    if (!activation.activate) {
      return {
        allowed: false,
        to: null,
        reason: `-> active refused: ${activation.firstUnmet?.message ?? "activation requirements unmet"}`,
        firstUnmet: activation.firstUnmet,
        unmet: activation.unmet,
      };
    }
    return { allowed: true, to: "active", reason: null };
  }

  if (to === "retired") {
    const retirement = ctx.retirement;
    if (!isPlainObject(retirement) || typeof retirement.approvedBy !== "string" || retirement.approvedBy.trim() === "") {
      return { allowed: false, to: null, reason: "-> retired requires retirement.approvedBy (the QA Owner retiring the contract)" };
    }
    if (retirement.bindingRemoved !== true || retirement.ciEnrollmentRemoved !== true) {
      return {
        allowed: false,
        to: null,
        reason: "-> retired requires the live Binding and CI enrollment to be removed in the same reviewed change (retirement.bindingRemoved and retirement.ciEnrollmentRemoved must both be true)",
      };
    }
    return { allowed: true, to: "retired", reason: null, auditRecord: { from, to: "retired", ...retirement } };
  }

  // Unreachable: every pair in ALLOWED_FLOW_TRANSITIONS is handled above.
  return { allowed: false, to: null, reason: "unhandled transition" };
}

const FLOW_STATE_DELTA_KEYS = Object.freeze(["to", "context"]);

/**
 * Applies a Flow State change to `record`. Refuses on shape alone if
 * `delta` carries any key outside `{ to, context }` — a test-outcome object
 * (`passed`, `bindingId`, `failureReason`, ...) never matches this shape and
 * is rejected here before `decideFlowStateTransition` ever runs. On
 * success, returns a NEW record with exactly `flowState` replaced;
 * `bindingFreshness` and `enforcementState` are carried over untouched.
 */
export function applyFlowStateChange(record, delta) {
  const shapeErrors = foreignKeyErrors(delta, FLOW_STATE_DELTA_KEYS, "flow-state");
  if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors };
  const base = requireRecord(record);
  const decision = decideFlowStateTransition(base.flowState, delta.to, delta.context);
  if (!decision.allowed) return { ok: false, errors: [decision.reason] };
  return { ok: true, record: { ...base, flowState: decision.to } };
}

// ---------------------------------------------------------------------------
// Axis 2: Binding Freshness — consumed, never re-derived
// ---------------------------------------------------------------------------

const FRESHNESS_DELTA_KEYS = Object.freeze(["freshness"]);

/**
 * Records a Binding Freshness value this module did NOT compute.
 * `delta.freshness` must already be the output of drift-gate.mjs's
 * `evaluateBindingDrift` (`"absent" | "current" | "stale"`) — this function
 * only ever copies that value through; it contains no staleness logic of
 * its own. Refuses any delta shape beyond `{ freshness }`, so a failing
 * test's own result object can never be mistaken for a freshness report.
 */
export function applyBindingFreshnessReport(record, delta) {
  const shapeErrors = foreignKeyErrors(delta, FRESHNESS_DELTA_KEYS, "binding-freshness");
  if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors };
  if (!FRESHNESS_STATES.includes(delta.freshness)) {
    return {
      ok: false,
      errors: [`binding-freshness delta.freshness must be one of ${FRESHNESS_STATES.join(" | ")} (got ${JSON.stringify(delta.freshness)})`],
    };
  }
  const base = requireRecord(record);
  return { ok: true, record: { ...base, bindingFreshness: delta.freshness } };
}

// ---------------------------------------------------------------------------
// Axis 3: Enforcement State — brownfield/greenfield defaults + promotion
// ---------------------------------------------------------------------------

export const POSTURES = Object.freeze(["brownfield", "greenfield"]);

/**
 * The Enforcement State a Binding's FIRST active version starts in, keyed
 * only by repository posture:
 *   - brownfield: `advisory` — burn-in, so a new suite cannot destabilize
 *     the existing merge gate.
 *   - greenfield: `required` — the flow stayed `deferred` until an
 *     implementation change could activate a passing Binding; once that
 *     happens, enforcement starts required immediately (DESIGN-dynamic-qa-
 *     spec.md §8, "required enforcement starts with that first active
 *     Binding").
 * An unrecognized posture refuses rather than guessing — there is no
 * silent third default.
 */
export function resolveActivationEnforcementDefault(posture) {
  if (posture === "brownfield") {
    return { enforcementState: "advisory", reason: "brownfield Bindings enter advisory burn-in on activation" };
  }
  if (posture === "greenfield") {
    return { enforcementState: "required", reason: "the first active greenfield Binding defaults to required enforcement" };
  }
  return {
    enforcementState: null,
    reason: `unrecognized posture ${JSON.stringify(posture)} — activation is refused rather than defaulting to a guessed enforcement lane`,
  };
}

// Burn-in Qualification (DESIGN-dynamic-qa-spec.md §8) is a much larger set
// of measured criteria (14 days, 20 Qualifying Runs, five source commits,
// 100 individual candidate executions, <=1% confirmed false-positive/flaky
// failures, no unresolved flake in the final 10 runs, all failures
// classified, PR-fast p95 within budget, continuous safety/provenance
// health). That FULL measurement is explicitly the pilot's job (#171-175),
// not this ticket's. What this ticket models is the one gate the ticket's
// acceptance criteria actually name: a measured Qualifying Run count AND an
// explicit approval, with neither alone sufficing.
export const MIN_QUALIFYING_RUNS = 20;

/**
 * A Qualifying Run (glossary: "complete, comparable run eligible as
 * brownfield burn-in evidence"). Requires a real source commit and Binding
 * identity, a clean-pass outcome, and an explicit `comparable: true` flag
 * (the same profile/environment as the promotion candidate) — an
 * intermittent, failed, or non-comparable run never counts.
 */
export function isQualifyingRun(run) {
  return (
    isPlainObject(run) &&
    typeof run.sourceCommit === "string" &&
    run.sourceCommit.trim() !== "" &&
    typeof run.bindingId === "string" &&
    run.bindingId.trim() !== "" &&
    run.outcome === "clean-pass" &&
    run.comparable === true
  );
}

/**
 * Reduces a list of candidate run records to the measured facts a
 * promotion decision needs. Note there is no `elapsedDays` or
 * `greenStreak` field anywhere in this shape — those are exactly the
 * inputs the spec says must never alone change enforcement, so they have
 * no representation here for `decidePromotion` to accidentally read.
 */
export function summarizeQualifyingRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const qualifying = list.filter(isQualifyingRun);
  return {
    qualifyingCount: qualifying.length,
    totalRuns: list.length,
    distinctSourceCommits: new Set(qualifying.map((run) => run.sourceCommit)).size,
  };
}

function approvalIsExplicit(approval) {
  return isPlainObject(approval) && approval.granted === true && typeof approval.approver === "string" && approval.approver.trim() !== "";
}

/**
 * Decides advisory -> required promotion. Requires BOTH, always checked
 * independently:
 *   - `qualifyingRunSummary.qualifyingCount >= MIN_QUALIFYING_RUNS`
 *   - an explicit `approval` (`{ granted: true, approver: "<name>" }`)
 * Neither alone promotes — this function's parameter shape has no field
 * for elapsed time or an unqualified green streak at all, so no caller can
 * even construct an input that would promote on those grounds.
 */
export function decidePromotion({ qualifyingRunSummary, approval } = {}) {
  const summary = isPlainObject(qualifyingRunSummary) ? qualifyingRunSummary : {};
  const hasMeasurement = typeof summary.qualifyingCount === "number" && summary.qualifyingCount >= MIN_QUALIFYING_RUNS;
  const hasApproval = approvalIsExplicit(approval);

  if (hasMeasurement && hasApproval) {
    return { promote: true, enforcementState: "required", reasons: [] };
  }

  const reasons = [];
  if (!hasMeasurement) {
    reasons.push(`fewer than ${MIN_QUALIFYING_RUNS} measured Qualifying Runs (got ${JSON.stringify(summary.qualifyingCount ?? null)})`);
  }
  if (!hasApproval) {
    reasons.push("no explicit promotion approval (approval.granted !== true, or no named approval.approver)");
  }
  return { promote: false, enforcementState: "advisory", reasons };
}

const ENFORCEMENT_DELTA_KEYS = Object.freeze(["qualifyingRunSummary", "approval"]);

/**
 * Applies a promotion to `record`. Only ever moves `advisory -> required`
 * — there is no counterpart function that moves `required -> advisory`;
 * demotion is out of scope by omission, not by a guard that could be
 * bypassed. Refuses on foreign keys exactly like the other two axis
 * appliers, and refuses when `record.enforcementState` is not already
 * `"advisory"` (promotion never applies to a Binding that is not in the
 * advisory lane it is meant to graduate out of).
 */
export function applyEnforcementPromotion(record, delta) {
  const shapeErrors = foreignKeyErrors(delta, ENFORCEMENT_DELTA_KEYS, "enforcement-state");
  if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors };
  const base = requireRecord(record);
  if (base.enforcementState !== "advisory") {
    return { ok: false, errors: [`promotion only applies to a Binding currently in the advisory lane (record.enforcementState is ${JSON.stringify(base.enforcementState)})`] };
  }
  const decision = decidePromotion(delta);
  if (!decision.promote) return { ok: false, errors: decision.reasons };
  return { ok: true, record: { ...base, enforcementState: "required" } };
}
