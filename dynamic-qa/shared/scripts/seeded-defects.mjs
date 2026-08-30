// dynamic-qa/shared/scripts/seeded-defects.mjs
//
// Seeded Binding Defect Case machinery (ticket #174, SPEC-135.md §13 "at
// least three seeded Binding defects: all remain red, are correctly
// classified, and produce reviewable proposal-only patches; at least two
// are accepted unchanged; none weakens policy or is auto-applied").
//
// Purpose: test repair quality against REAL defects without risking product
// behaviour. A seeded defect is always an intentional Binding-level mistake
// — never a product change — injected into an already-active pilot Binding
// so its own diagnosis/repair path can be exercised end to end.
//
// Composition, not reinvention: this module builds on #158's
// diagnosis.mjs (owner/repeatability/failureClass, isRepairEligible,
// attempts), #152's negative-controls.mjs (a seeded defect's "stays red"
// claim is strongest when it is also witnessed by a genuinely EXECUTED,
// failing negative control — see attachNegativeControlReport below), and
// (CLOSED, see below) #160's repair.mjs, rather than building a second
// diagnosis, control, or review-packet model.
//
// CLOSED (was a KNOWN GAP): this module was originally written before #160
// ("Implement guarded repair with a Repair Review Packet") landed, and used
// a deliberately minimal LOCAL stand-in (`recordRepairReview` /
// `REPAIR_REVIEW_OUTCOMES`) for exactly the one fact this ticket's
// acceptance criteria need — an outcome (accepted unchanged / accepted with
// modification / rejected) by a named reviewer — rather than #160's full
// packet (evidence, mappings, protected-contract digests, diff,
// verification results, residual risk). #160 has since landed;
// `attachRepairReviewPacket` below now attaches the REAL Repair Review
// Packet (validated by repair.mjs's own `validateRepairReviewPacket`,
// exactly the six required sections, never a second shape), and
// `recordRepairReviewOutcome` records the human's review verdict against
// that real, already-attached packet — `REPAIR_REVIEW_OUTCOMES` (the
// outcome vocabulary itself) is genuinely this ticket's own concept, not
// part of #160's packet, and is kept. A byproduct of requiring a real,
// validated packet before any outcome can be recorded: "proposal-only,
// never applied" is now a STRUCTURAL property inherited from repair.mjs
// (which has no dependency on node:fs/node:child_process — see that
// module's own module-footer proof) rather than a caller-asserted boolean
// this module previously had to trust.

import {
  isRepairEligible,
  validateDiagnosisRecord,
  originalAttempt,
} from "./diagnosis.mjs";
import { judgeNegativeControl } from "./negative-controls.mjs";
import { validateRepairReviewPacket } from "./repair.mjs";
import { unknownQuantity, knownQuantity, isQuantity } from "./baseline-plan.mjs";

export { unknownQuantity, knownQuantity, isQuantity };

// A seeded defect's injected change is ALWAYS Binding-owned. There is no
// parameter, override, or code path anywhere in this module that accepts
// "product" (or anything else) as the injected-change kind — the only
// constructor (createSeededDefectCase) hard-codes it, exactly like
// quarantine.mjs's createQuarantineRecord hard-codes its own invariants.
export const SEEDED_CHANGE_KIND = "binding";

export const CASE_STATUSES = Object.freeze(["red", "diagnosed", "repair-proposed", "resolved", "rejected"]);

// The human review verdict for an already-attached, real Repair Review
// Packet (see recordRepairReviewOutcome below) — this vocabulary is this
// ticket's own concept, not part of #160's packet shape, so it is kept even
// though the packet itself is now #160's real one (see the CLOSED note
// above).
export const REPAIR_REVIEW_OUTCOMES = Object.freeze(["accepted-unchanged", "accepted-with-modification", "rejected"]);

const MIN_SEEDED_DEFECTS = 3;
const MIN_ACCEPTED_UNCHANGED = 2;
export { MIN_SEEDED_DEFECTS, MIN_ACCEPTED_UNCHANGED };

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * The only constructor for a Seeded Defect Case. `injectedChange` accepts
 * only `summary` from the caller — `kind` is always SEEDED_CHANGE_KIND
 * ("binding"), and `productBehaviorChanged` is always `false` and frozen:
 * neither field has ANY path by which a caller could set them to anything
 * else. This is the structural guarantee "no seeded defect causes a product
 * behaviour change" rests on, not a runtime check that could be bypassed.
 */
export function createSeededDefectCase({ id, flowId, bindingId, description, injectedChange }) {
  if (!nonEmptyString(id)) throw new Error("createSeededDefectCase: id must be a non-empty string");
  if (!nonEmptyString(flowId)) throw new Error("createSeededDefectCase: flowId must be a non-empty string");
  if (!nonEmptyString(bindingId)) throw new Error("createSeededDefectCase: bindingId must be a non-empty string");
  if (!nonEmptyString(description)) throw new Error("createSeededDefectCase: description must be a non-empty string");
  if (!isPlainObject(injectedChange) || !nonEmptyString(injectedChange.summary)) {
    throw new Error("createSeededDefectCase: injectedChange.summary must be a non-empty, plain-language description of the seeded mechanical Binding mistake");
  }

  return Object.freeze({
    id,
    flowId,
    bindingId,
    description,
    injectedChange: Object.freeze({ kind: SEEDED_CHANGE_KIND, summary: injectedChange.summary }),
    status: "red",
    productBehaviorChanged: false,
    diagnosis: null,
    negativeControlReport: null,
    repairReview: null,
  });
}

// ---------------------------------------------------------------------------
// Negative-control corroboration ("stays red", witnessed) — reuses #152.
// ---------------------------------------------------------------------------

/**
 * Attaches a negative-control report proving this seeded defect actually
 * produced a genuine, EXECUTED failure — not a simulated or skipped one.
 * Reuses #152's judgeNegativeControl exactly (never re-implements the
 * executed/simulated/skipped distinction). Refuses to attach a report that
 * judgeNegativeControl does not accept, and refuses on a case that is not
 * still "red" (a control result only means something about the ORIGINAL
 * failure, before any repair attempt).
 */
export function attachNegativeControlReport(caseRecord, report) {
  if (caseRecord.status !== "red") {
    throw new Error(`attachNegativeControlReport: case ${JSON.stringify(caseRecord.id)} is not in status "red" (got ${JSON.stringify(caseRecord.status)}) — a negative control only corroborates the ORIGINAL seeded failure`);
  }
  const verdict = judgeNegativeControl(report);
  if (!verdict.accepted) {
    throw new Error(`attachNegativeControlReport: case ${JSON.stringify(caseRecord.id)}'s negative control did not confirm the seeded defect (reason: ${JSON.stringify(verdict.reason)}) — a seeded defect that does not produce a genuine, executed, failing control is not proven to stay red`);
  }
  return Object.freeze({ ...caseRecord, negativeControlReport: Object.freeze({ ...report }) });
}

// ---------------------------------------------------------------------------
// Diagnosis — "each defect is diagnosed as Binding-owned before repair is
// invoked" (ticket #174 acceptance criterion), enforced structurally: repair
// review can only ever be attached (see attachRepairReviewPacket below)
// against a case whose status is already "diagnosed", and attachDiagnosis is the only
// function that can produce that status.
// ---------------------------------------------------------------------------

/**
 * Attaches a Diagnosis Record to a still-red case. Requires:
 *   - the Diagnosis Record itself to shape-validate (#158's
 *     validateDiagnosisRecord, unchanged);
 *   - owner === "binding" — a seeded defect that diagnosis does not confirm
 *     as Binding-owned is not eligible to proceed to repair through this
 *     path at all (throws, rather than silently downgrading);
 *   - the Diagnosis Record's own flowId/bindingId to match this case's.
 * Never mutates the diagnosis record or the case in place.
 */
export function attachDiagnosis(caseRecord, diagnosisRecord) {
  if (caseRecord.status !== "red") {
    throw new Error(`attachDiagnosis: case ${JSON.stringify(caseRecord.id)} is not in status "red" (got ${JSON.stringify(caseRecord.status)})`);
  }
  const { valid, errors } = validateDiagnosisRecord(diagnosisRecord);
  if (!valid) {
    throw new Error(`attachDiagnosis: invalid Diagnosis Record — ${errors.map((e) => e.message).join("; ")}`);
  }
  if (diagnosisRecord.owner !== "binding") {
    throw new Error(`attachDiagnosis: case ${JSON.stringify(caseRecord.id)}'s diagnosis owner is ${JSON.stringify(diagnosisRecord.owner)}, not "binding" — a seeded Binding defect must be diagnosed as Binding-owned before repair is ever invoked`);
  }
  if (diagnosisRecord.flowId !== caseRecord.flowId || diagnosisRecord.bindingId !== caseRecord.bindingId) {
    throw new Error(`attachDiagnosis: diagnosis flowId/bindingId does not match case ${JSON.stringify(caseRecord.id)}`);
  }
  return Object.freeze({ ...caseRecord, status: "diagnosed", diagnosis: Object.freeze({ ...diagnosisRecord }) });
}

// ---------------------------------------------------------------------------
// "Stays red" until an accepted repair — pure computation over the attached
// diagnosis's own append-only attempts list (#158's shape, unmodified).
// ---------------------------------------------------------------------------

/**
 * True only when every attempt before the first "passed" verdict is
 * "failed", AND the first (and only, for a still-in-flight case) "passed"
 * verdict belongs to an attempt of kind "repair-verification". A case with
 * no passing attempt at all is still "stayed red so far" (true) — it simply
 * has not yet been repaired. A case where anything OTHER than a
 * repair-verification attempt ever passed is NOT correctly handled: that is
 * exactly the "the defect quietly stopped reproducing on its own" failure
 * mode this check exists to catch.
 */
export function stayedRedUntilRepairVerification(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return false;
  const original = originalAttempt(attempts);
  if (!original || original.verdict !== "failed") return false;

  for (const attempt of attempts) {
    if (attempt.verdict === "passed") {
      return attempt.kind === "repair-verification";
    }
  }
  return true; // nothing has passed yet — still red, which is honest, not a failure
}

// ---------------------------------------------------------------------------
// Repair review — the REAL #160 Repair Review Packet (finding closed).
// ---------------------------------------------------------------------------

/**
 * Attaches the REAL Repair Review Packet — #160's repair.mjs
 * `evaluateRepairProposal` output — to a diagnosed, repair-eligible case.
 * This is the function that replaces the pre-#160 stand-in (see the CLOSED
 * note at the top of this module): the packet reused here is #160's own,
 * never a second, parallel shape.
 *
 * Requires:
 *   - caseRecord.status === "diagnosed" — a packet cannot be attached
 *     before diagnosis confirms Binding ownership (structural ordering);
 *   - caseRecord.diagnosis to be repair-ELIGIBLE per #158's own
 *     isRepairEligible, unchanged;
 *   - `proposalResult` to be a real `evaluateRepairProposal` result (#160)
 *     whose `status` is exactly `"proposal"` and whose `packet`
 *     shape-validates against #160's own `validateRepairReviewPacket`
 *     (exactly the six required sections, never more or fewer).
 * A "refused" `evaluateRepairProposal` result (`status !== "proposal"`, no
 * packet) is never accepted here — a seeded defect whose repair candidate
 * was refused has no packet to review, and this function has no path that
 * manufactures one. Advances the case to `"repair-proposed"` — a status
 * this module's CASE_STATUSES always named but never previously reached.
 */
export function attachRepairReviewPacket(caseRecord, proposalResult) {
  if (caseRecord.status !== "diagnosed") {
    throw new Error(`attachRepairReviewPacket: case ${JSON.stringify(caseRecord.id)} must be "diagnosed" before a Repair Review Packet can be attached (got ${JSON.stringify(caseRecord.status)})`);
  }
  if (!caseRecord.diagnosis || !isRepairEligible(caseRecord.diagnosis)) {
    throw new Error(`attachRepairReviewPacket: case ${JSON.stringify(caseRecord.id)}'s diagnosis is not repair-eligible (must be confirmed, owner binding, failureClass binding-defect)`);
  }
  if (!isPlainObject(proposalResult) || proposalResult.status !== "proposal" || !isPlainObject(proposalResult.packet)) {
    throw new Error(
      `attachRepairReviewPacket: case ${JSON.stringify(caseRecord.id)} requires a real evaluateRepairProposal result with status "proposal" and a packet — a refused proposal has nothing to review`,
    );
  }
  const { valid, errors } = validateRepairReviewPacket(proposalResult.packet);
  if (!valid) {
    throw new Error(`attachRepairReviewPacket: invalid Repair Review Packet — ${errors.map((e) => e.message).join("; ")}`);
  }
  return Object.freeze({ ...caseRecord, status: "repair-proposed", repairReviewPacket: Object.freeze({ ...proposalResult.packet }) });
}

/**
 * Records the human review outcome for the REAL Repair Review Packet
 * `attachRepairReviewPacket` already attached. Requires:
 *   - caseRecord.status === "repair-proposed" — a real packet must already
 *     be attached before its outcome can be recorded;
 *   - a non-empty reviewer name, a valid outcome, and a parseable
 *     reviewedAt timestamp.
 * There is no `proposalOnly` parameter here (unlike the pre-#160
 * stand-in): "proposal-only, never applied" is now a STRUCTURAL guarantee
 * inherited from the packet itself (repair.mjs has no dependency on
 * node:fs/node:child_process — see that module's own module-footer proof),
 * not a caller-asserted boolean this function has to trust.
 */
export function recordRepairReviewOutcome(caseRecord, { outcome, reviewer, reviewedAt }) {
  if (caseRecord.status !== "repair-proposed") {
    throw new Error(
      `recordRepairReviewOutcome: case ${JSON.stringify(caseRecord.id)} must have an attached Repair Review Packet ("repair-proposed") before its outcome can be recorded (got ${JSON.stringify(caseRecord.status)})`,
    );
  }
  if (!caseRecord.repairReviewPacket) {
    throw new Error(`recordRepairReviewOutcome: case ${JSON.stringify(caseRecord.id)} has no attached Repair Review Packet`);
  }
  if (!REPAIR_REVIEW_OUTCOMES.includes(outcome)) {
    throw new Error(`recordRepairReviewOutcome: outcome must be one of ${REPAIR_REVIEW_OUTCOMES.join(", ")} (got ${JSON.stringify(outcome)})`);
  }
  if (!nonEmptyString(reviewer)) throw new Error("recordRepairReviewOutcome: reviewer must be a non-empty string");
  if (!nonEmptyString(reviewedAt) || Number.isNaN(Date.parse(reviewedAt))) {
    throw new Error("recordRepairReviewOutcome: reviewedAt must be a parseable ISO-8601 timestamp");
  }

  const nextStatus = outcome === "rejected" ? "rejected" : "resolved";
  return Object.freeze({
    ...caseRecord,
    status: nextStatus,
    repairReview: Object.freeze({ outcome, reviewer, reviewedAt, proposalOnly: true }),
  });
}

// ---------------------------------------------------------------------------
// "Correctly handled" — the pilot-success predicate SPEC-135 §13 names.
// ---------------------------------------------------------------------------

/**
 * A seeded defect is "correctly handled" (SPEC-135 §13 threshold 6) when,
 * over its whole lifecycle:
 *   - it was diagnosed as Binding-owned and repair-eligible (attachDiagnosis
 *     + isRepairEligible, both already enforced when the case reached this
 *     status);
 *   - it never resolved on its own — stayedRedUntilRepairVerification is
 *     true for its diagnosis's attempts;
 *   - a repair review outcome was actually recorded (proposal-only,
 *     reviewed by a named human);
 *   - it never changed product behaviour (structurally guaranteed false at
 *     construction, re-asserted here defensively).
 * A "rejected" outcome still counts as correctly HANDLED (the defect was
 * red, diagnosed, and reviewed) — it just does not count toward the
 * separate "accepted unchanged" threshold.
 *
 * Now also requires a REAL, shape-valid Repair Review Packet
 * (`repairReviewPacket`, #160) to be attached, not merely a caller-asserted
 * `proposalOnly` boolean — closing the gap the pre-#160 stand-in left open.
 */
export function isCorrectlyHandledSeededDefect(caseRecord) {
  if (!isPlainObject(caseRecord)) return false;
  if (caseRecord.productBehaviorChanged !== false) return false;
  if (!caseRecord.diagnosis || !isRepairEligible(caseRecord.diagnosis)) return false;
  if (!stayedRedUntilRepairVerification(caseRecord.diagnosis.attempts)) return false;
  if (!caseRecord.repairReviewPacket || !validateRepairReviewPacket(caseRecord.repairReviewPacket).valid) return false;
  if (!caseRecord.repairReview || caseRecord.repairReview.proposalOnly !== true) return false;
  return caseRecord.status === "resolved" || caseRecord.status === "rejected";
}

export function wasAcceptedUnchanged(caseRecord) {
  return isCorrectlyHandledSeededDefect(caseRecord) && caseRecord.repairReview?.outcome === "accepted-unchanged";
}

// ---------------------------------------------------------------------------
// Pilot-level summary — Quantity-typed, never a fabricated number.
// ---------------------------------------------------------------------------

/**
 * Summarizes a set of Seeded Defect Cases into the two counts SPEC-135 §13's
 * threshold 6 needs. `measured` must be explicitly asserted `true` by the
 * caller (the real pilot, never this ticket) before any count becomes a
 * `known` Quantity — with no seeded-defect pilot run yet, this MUST return
 * `unknown`, never a plausible-looking zero. `cases` may be empty even when
 * `measured: true` (an honest "zero correctly handled so far"), which stays
 * distinct from "not measured" by TAG (unknownQuantity vs knownQuantity(0)),
 * exactly like every other metric in this bundle.
 */
export function summarizeSeededDefectResults(cases, { measured = false } = {}) {
  if (!measured) {
    return {
      totalSeeded: unknownQuantity(),
      correctlyHandledCount: unknownQuantity(),
      acceptedUnchangedCount: unknownQuantity(),
    };
  }
  const list = Array.isArray(cases) ? cases : [];
  const correctlyHandled = list.filter(isCorrectlyHandledSeededDefect);
  const acceptedUnchanged = list.filter(wasAcceptedUnchanged);
  return {
    totalSeeded: knownQuantity(list.length),
    correctlyHandledCount: knownQuantity(correctlyHandled.length),
    acceptedUnchangedCount: knownQuantity(acceptedUnchanged.length),
  };
}

/**
 * Evaluates SPEC-135 §13 threshold 6 ("at least three correctly handled
 * seeded Binding defects... at least two accepted unchanged") against a
 * summary from summarizeSeededDefectResults. Never treats an `unknown`
 * count as met — a not-yet-measured seeded-defect pilot yields
 * "measurement-required", never a silent pass.
 */
export function evaluateSeededDefectThreshold(summary) {
  const correctly = summary?.correctlyHandledCount;
  const accepted = summary?.acceptedUnchangedCount;
  if (!isQuantity(correctly) || !isQuantity(accepted) || correctly.kind !== "known" || accepted.kind !== "known") {
    return { met: false, status: "measurement-required", correctlyHandledCount: null, acceptedUnchangedCount: null };
  }
  const met = correctly.value >= MIN_SEEDED_DEFECTS && accepted.value >= MIN_ACCEPTED_UNCHANGED;
  return {
    met,
    status: met ? "met" : "failed",
    correctlyHandledCount: correctly.value,
    acceptedUnchangedCount: accepted.value,
  };
}
