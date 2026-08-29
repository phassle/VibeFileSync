// dynamic-qa/shared/scripts/posture.mjs
//
// Stage 3 ("Enter through posture-specific evidence") mechanics for
// ticket #163. This module is an EXTENSION of #162's Fact/provenance model
// (see fact.mjs's module comment), not a parallel evidence system: it never
// redefines what a Fact is, it only (a) decides which posture applies
// explicitly, (b) governs the one legal path an observed-behaviour fact can
// take from "unconfirmed" to contract-eligible, and (c) enforces that
// greenfield evidence never enters without an approved source behind it.
//
// The two rules the parent spec names as most important both live here as
// real, tested code rather than SKILL.md prose:
//
//   1. A brownfield observation is evidence, never intended behaviour, until
//      an accountable human (never a Domain Expert) explicitly confirms it.
//      See INTENT_STATUSES / confirmIntent / canBecomeExpectedOutcome.
//   2. Greenfield setup works only from approved tickets/examples; absent
//      evidence stays `unknown`, never a filled-in assumption.
//      See GREENFIELD_SOURCE_TYPES / requireApprovedGreenfieldEvidence /
//      buildGreenfieldFact.

import { makeFact, CONFIRMING_ROLES } from "./fact.mjs";
import { walkFiles } from "./repo-walk.mjs";

// --- Posture: determined explicitly, never guessed -----------------------

export const POSTURES = Object.freeze(["brownfield", "greenfield"]);

// Sources an explicit posture declaration can legitimately come from — an
// accountable human stating it, the same way authority.mjs's invocation gate
// only accepts an explicit user command or explicit coordinator selection.
export const EXPLICIT_POSTURE_SOURCES = Object.freeze([
  "qa-owner-declaration",
  "technical-owner-declaration",
]);

// Sources that must NEVER be allowed to decide posture on their own — most
// importantly, inferring it purely from repository shape. A repository with
// no application code is strong evidence for greenfield, and one with a lot
// of it is strong evidence for brownfield, but "strong evidence" is not the
// same as "the QA Owner said so": the parent spec requires posture to be
// determined explicitly, because a wrong guess corrupts everything stage 3
// builds afterward (brownfield evidence rules applied to a greenfield flow,
// or vice versa).
export const NON_EXPLICIT_POSTURE_SOURCES = Object.freeze([
  "inferred-from-repository-shape",
  "assumed-default",
  "unspecified",
]);

export function isKnownPosture(posture) {
  return POSTURES.includes(posture);
}

// evaluatePostureDeclaration({ source, posture }) -> { allowed, posture, stopReason }
//
// stopReason is one of:
//   "unrecognized-posture"        — posture is not "brownfield"/"greenfield"
//   "posture-not-explicit"        — a recognized but disallowed source
//   "unrecognized-posture-source" — fail closed on anything unlisted
//   null                          — allowed to proceed with the declared posture
export function evaluatePostureDeclaration(declaration = {}) {
  const { source, posture } = declaration;
  if (!isKnownPosture(posture)) {
    return { allowed: false, posture: null, stopReason: "unrecognized-posture" };
  }
  if (EXPLICIT_POSTURE_SOURCES.includes(source)) {
    return { allowed: true, posture, stopReason: null };
  }
  if (NON_EXPLICIT_POSTURE_SOURCES.includes(source)) {
    return { allowed: false, posture: null, stopReason: "posture-not-explicit" };
  }
  return { allowed: false, posture: null, stopReason: "unrecognized-posture-source" };
}

// repositoryShapeSignal(repoRoot) -> { hasApplicationCode, fileCount }
//
// Purely informational. It exists so the human answering the posture
// question can be shown "here is what the repository looks like" — the same
// way stage 2's inventory informs stage 1's authority questions — but it is
// deliberately never wired as a `source` value evaluatePostureDeclaration
// accepts. Read-only via repo-walk.mjs, consistent with stage 2's "discovery
// never writes" invariant.
const APPLICATION_CODE_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs|rs|py|go|java|rb|cs|php)$/i;

export function repositoryShapeSignal(repoRoot) {
  const files = walkFiles(repoRoot);
  const hasApplicationCode = files.some((f) => APPLICATION_CODE_EXTENSIONS.test(f));
  return Object.freeze({ hasApplicationCode, fileCount: files.length });
}

// --- Brownfield: observation is evidence, never intended behaviour -------

export const INTENT_DECISIONS = Object.freeze(["intended", "not-intended"]);

// makeObservationFact(input) -> Fact, category "brownfield-observation",
// always starting "unconfirmed" (fact.mjs's makeFact rejects any other
// starting intentStatus arriving pre-confirmed — see its own tests). This is
// the single construction path stage 3 should use for what discovery
// observes about current application behaviour.
export function makeObservationFact(input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, "intentStatus")) {
    throw new Error(
      "makeObservationFact always starts a brownfield observation unconfirmed — use confirmIntent to move it, never construct it pre-confirmed"
    );
  }
  return makeFact({ ...input, category: "brownfield-observation" });
}

// confirmIntent(fact, { decision, confirmedBy, confirmedByRole }) -> Fact
//
// THE choke point for rule #1 above. Throws (fails closed) unless:
//   - fact.category is "brownfield-observation"
//   - decision is "intended" or "not-intended"
//   - confirmedBy is a non-empty identity
//   - confirmedByRole is "qa-owner" or "technical-owner" — never
//     "domain-expert". A Domain Expert can be consulted on what an observed
//     behaviour means (that judgement stays in SKILL.md prose, scoped to the
//     specific flow question), but they can never BE the confirming
//     identity: doing so would let flow-specific clarification silently
//     stand in for QA ownership, which ticket #163's AC3 forbids.
export function confirmIntent(fact, confirmation = {}) {
  if (!fact || fact.category !== "brownfield-observation") {
    throw new Error("confirmIntent only applies to a brownfield-observation fact");
  }
  const { decision, confirmedBy, confirmedByRole } = confirmation;
  if (!INTENT_DECISIONS.includes(decision)) {
    throw new Error(`confirmIntent requires decision "intended" or "not-intended", got: ${String(decision)}`);
  }
  if (typeof confirmedBy !== "string" || confirmedBy.length === 0) {
    throw new Error("confirmIntent requires a non-empty confirmedBy identity");
  }
  if (!CONFIRMING_ROLES.includes(confirmedByRole)) {
    throw new Error(
      `confirmIntent requires confirmedByRole to be one of ${CONFIRMING_ROLES.join(", ")}, got: ${String(confirmedByRole)} — a Domain Expert may clarify but never confirms intent`
    );
  }
  const intentStatus = decision === "intended" ? "confirmed-intended" : "confirmed-not-intended";
  return makeFact({
    id: fact.id,
    category: fact.category,
    provenance: fact.provenance,
    description: fact.description,
    evidence: fact.evidence,
    intentStatus,
    confirmedBy,
    confirmedByRole,
  });
}

// canBecomeExpectedOutcome(fact) -> boolean
//
// True only for a brownfield-observation fact that has been explicitly
// confirmed intended by an accountable human. This is what stage 5's later
// interview (a subsequent ticket) must check before letting an observation
// become an Expected Outcome — "observed", "reported many times", or
// "confirmed-not-intended" are never sufficient on their own.
export function canBecomeExpectedOutcome(fact) {
  return (
    !!fact &&
    fact.category === "brownfield-observation" &&
    fact.intentStatus === "confirmed-intended" &&
    typeof fact.confirmedBy === "string" &&
    fact.confirmedBy.length > 0 &&
    CONFIRMING_ROLES.includes(fact.confirmedByRole)
  );
}

// --- Greenfield: approved-source-only evidence ----------------------------

export const GREENFIELD_SOURCE_TYPES = Object.freeze(["approved-ticket", "approved-example"]);

// validateGreenfieldSource(source) -> { ok, errors }
//
//   { type: "approved-ticket" | "approved-example",
//     reference: string,      // ticket id/URL, or example path
//     approvedBy: string,     // non-empty identity
//     approvedByRole: "qa-owner" | "technical-owner" }
//
// A Domain Expert cannot be the approving identity here either — the same
// ownership-never-transfers rule from confirmIntent applies to greenfield
// approval.
export function validateGreenfieldSource(source) {
  const errors = [];
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return { ok: false, errors: ["greenfield source must be an object"] };
  }
  if (!GREENFIELD_SOURCE_TYPES.includes(source.type)) {
    errors.push(
      `greenfield source.type must be one of ${GREENFIELD_SOURCE_TYPES.join(", ")}, got: ${String(source.type)}`
    );
  }
  if (typeof source.reference !== "string" || source.reference.length === 0) {
    errors.push("greenfield source.reference must be a non-empty string (ticket id/URL or example path)");
  }
  if (typeof source.approvedBy !== "string" || source.approvedBy.length === 0) {
    errors.push("greenfield source.approvedBy must be a non-empty identity");
  }
  if (!CONFIRMING_ROLES.includes(source.approvedByRole)) {
    errors.push(
      `greenfield source.approvedByRole must be one of ${CONFIRMING_ROLES.join(", ")}, got: ${String(source.approvedByRole)}`
    );
  }
  return { ok: errors.length === 0, errors };
}

// requireApprovedGreenfieldEvidence(sources) -> { ok, errors }
//
// Rule #2 above, as a hard gate: greenfield setup must refuse to proceed
// (never silently continue with invented behaviour) unless at least one
// VALID approved ticket or example exists. An empty list, or a list where
// every entry fails validateGreenfieldSource, is exactly the same stop —
// there is no partial-credit path.
export function requireApprovedGreenfieldEvidence(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return {
      ok: false,
      errors: ["greenfield setup requires at least one approved ticket or example; none was provided"],
    };
  }
  const validSources = sources.filter((s) => validateGreenfieldSource(s).ok);
  if (validSources.length === 0) {
    return {
      ok: false,
      errors: [
        "greenfield setup requires at least one VALID approved ticket or example; every provided source failed validation",
      ],
    };
  }
  return { ok: true, errors: [] };
}

// buildGreenfieldFact(id, description, sources) -> Fact, category
// "greenfield-source".
//
// provenance is "reported" — backed by the named approved source(s) — only
// when at least one valid source exists. With none, provenance is "unknown":
// greenfield setup records the gap honestly instead of defaulting to a
// plausible-looking value, exactly like stage 2's inventory does for any
// other unanswerable fact.
export function buildGreenfieldFact(id, description, sources = []) {
  const validSources = (sources || []).filter((s) => validateGreenfieldSource(s).ok);
  if (validSources.length === 0) {
    return makeFact({ id, category: "greenfield-source", provenance: "unknown", description });
  }
  const evidence = validSources
    .map((s) => `${s.type}:${s.reference} (approved by ${s.approvedBy}, ${s.approvedByRole})`)
    .join("; ");
  return makeFact({ id, category: "greenfield-source", provenance: "reported", description, evidence });
}
