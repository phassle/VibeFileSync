// dynamic-qa/shared/scripts/candidate-ranking.mjs
//
// Ticket #164, qa-setup stage 4 ("Rank broadly, then refine"). Builds a
// broad Candidate Flow list and ranks it BEFORE any deep per-flow interview
// (stage 5, flow-assembly.mjs), so selection is risk-based rather than
// arbitrary (DESIGN-dynamic-qa-spec.md §6 step 4, SPEC-135.md stories 13-16).
//
// Two structural guarantees this module exists to make impossible to
// violate, not merely discouraged in prose:
//
//   1. NEVER PAD TO A QUOTA. There is no function anywhere in this module
//      that invents, duplicates, or synthesizes a Candidate Flow. The only
//      inputs `rankCandidateFlows` accepts are candidates the caller already
//      identified from real evidence (stage 2's inventory, stage 3's
//      confirmed-intended observations, or approved greenfield sources — see
//      flow-assembly.mjs for the eligibility check those facts must pass).
//      Ranking can reorder or flag what exists; it can never grow the list.
//      A caller that wants a bigger portfolio must go back to discovery and
//      find more real evidence — there is no shortcut through this module.
//   2. GUIDANCE, NOT A HARD CAP. `evaluatePortfolioSize` never rejects or
//      truncates a small portfolio — fewer than the guidance minimum is
//      `allowed: true` unconditionally (SPEC-135.md story 15/AC3). Only
//      exceeding the guidance MAXIMUM without an explicit, reviewed override
//      is refused, and even then the function only reports `allowed: false`;
//      it never itself drops flows to fit under the cap. Silent truncation
//      would be exactly the "quota" failure mode in reverse.
//
// Ranking is explainable by construction: `rankCandidateFlows` returns each
// candidate's five factor scores individually (`factorScores`), never a
// single opaque number alone. The combined `totalScore` is a plain,
// documented sum of those five scores, so a QA Owner can see exactly why one
// candidate outranks another and can override the ranking with that
// reasoning in view.

import { isValidSemanticId } from "./id-rules.mjs";
import { CONFIRMING_ROLES } from "./fact.mjs";

export const RANKING_FACTORS = Object.freeze([
  "impact",
  "frequency",
  "changeExposure",
  "escapeHistory",
  "cheaperCoverageExists",
]);

// Ordinal scales for the three qualitative factors. Index into the array is
// the factor's numeric score (0..3) — low risk scores low, high risk scores
// high. Shared across impact/frequency/changeExposure because they are the
// same shape of judgement ("how much of this is there"), not because they
// mean the same thing; each flow's evidence for each factor is recorded and
// shown separately.
export const ORDINAL_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);

// A candidate's ticket link is checked with the same "stable http(s) URI"
// shape flow-definition.mjs's validateOrigin uses for a Flow Definition's
// origin.tickets, deliberately mirrored rather than imported: a Candidate
// Flow is not yet a Flow Definition (it has no schema of its own), and this
// stage's own gate must not depend on #143's schema module to fail closed.
const TICKET_URI_RE = /^https?:\/\/\S+$/;

export function isValidTicketUri(value) {
  return typeof value === "string" && TICKET_URI_RE.test(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Constructs one immutable Candidate Flow. Throws (fails closed) rather than
 * returning a partially-valid object — the same posture as fact.mjs's
 * makeFact — on:
 *   - a malformed id, empty title
 *   - an empty or invalid originatingTickets list (AC: "a flow without an
 *     originating ticket link fails")
 *   - impact/frequency/changeExposure outside ORDINAL_LEVELS
 *   - a negative or non-integer escapeCount
 *   - a non-boolean cheaperCoverageExists
 */
export function makeCandidateFlow(input = {}) {
  const {
    id,
    title,
    originatingTickets,
    impact,
    frequency,
    changeExposure,
    escapeCount,
    cheaperCoverageExists,
  } = input;

  if (!isValidSemanticId(id)) {
    throw new Error(`Candidate Flow id must be a semantic kebab-case identifier (got ${JSON.stringify(id)})`);
  }
  if (!nonEmptyString(title)) {
    throw new Error("Candidate Flow requires a non-empty title");
  }
  if (!Array.isArray(originatingTickets) || originatingTickets.length === 0) {
    throw new Error(
      `Candidate Flow "${id}" has no originating ticket link — every candidate must trace to at least one originating ticket`,
    );
  }
  originatingTickets.forEach((ticket) => {
    if (!isValidTicketUri(ticket)) {
      throw new Error(`Candidate Flow "${id}" has an invalid originating ticket reference: ${JSON.stringify(ticket)}`);
    }
  });
  for (const [factor, value] of [
    ["impact", impact],
    ["frequency", frequency],
    ["changeExposure", changeExposure],
  ]) {
    if (!ORDINAL_LEVELS.includes(value)) {
      throw new Error(
        `Candidate Flow "${id}" has an invalid ${factor} (must be one of ${ORDINAL_LEVELS.join(" | ")}, got ${JSON.stringify(value)})`,
      );
    }
  }
  if (!isNonNegativeInteger(escapeCount)) {
    throw new Error(`Candidate Flow "${id}" escapeCount must be a non-negative integer (got ${JSON.stringify(escapeCount)})`);
  }
  if (typeof cheaperCoverageExists !== "boolean") {
    throw new Error(`Candidate Flow "${id}" cheaperCoverageExists must be a boolean`);
  }

  return Object.freeze({
    id,
    title,
    originatingTickets: Object.freeze([...originatingTickets]),
    impact,
    frequency,
    changeExposure,
    escapeCount,
    cheaperCoverageExists,
  });
}

// Escape history is a raw count, not an ordinal the QA Owner assigns — but
// its contribution to the ranking is capped at the same 0..3 range as the
// other factors so no single dimension can dominate the sum by magnitude
// alone. The raw count is still reported alongside the capped score so nothing
// is hidden.
const ESCAPE_HISTORY_CAP = 3;

function ordinalScore(level) {
  return ORDINAL_LEVELS.indexOf(level);
}

/**
 * Computes this candidate's per-factor scores. Returns every one of the five
 * ranking dimensions individually (never collapsed into a single number
 * before this point) plus the documented sum. Pure function of the
 * candidate's own fields — same input always produces the same output.
 */
export function scoreCandidateFlow(candidate) {
  const impact = ordinalScore(candidate.impact);
  const frequency = ordinalScore(candidate.frequency);
  const changeExposure = ordinalScore(candidate.changeExposure);
  const escapeHistory = Math.min(candidate.escapeCount, ESCAPE_HISTORY_CAP);
  // Cheaper coverage that already exists REDUCES the case for this flow's
  // place in the portfolio — it is the one factor that pulls the score down
  // rather than up, which is exactly why it belongs alongside the other four
  // instead of being applied as a separate filter after ranking.
  const cheaperCoverageExists = candidate.cheaperCoverageExists ? -1 : 0;
  const total = impact + frequency + changeExposure + escapeHistory + cheaperCoverageExists;
  return Object.freeze({
    impact,
    frequency,
    changeExposure,
    escapeHistory,
    escapeHistoryRawCount: candidate.escapeCount,
    cheaperCoverageExists,
    total,
  });
}

/**
 * Ranks a list of already-identified Candidate Flows. Deterministic: ties
 * are broken by ascending id, so the same input always produces the same
 * order regardless of input array order. Returns one entry per candidate —
 * this function can reorder what it is given; it can never add to it (see
 * this module's header comment on "never pad to a quota").
 */
export function rankCandidateFlows(candidates) {
  if (!Array.isArray(candidates)) {
    throw new Error("rankCandidateFlows requires an array of Candidate Flows");
  }
  const ranked = candidates.map((candidate) => ({
    candidate,
    factorScores: scoreCandidateFlow(candidate),
  }));
  ranked.sort((a, b) => {
    if (b.factorScores.total !== a.factorScores.total) {
      return b.factorScores.total - a.factorScores.total;
    }
    return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
  });
  return ranked.map((entry, index) => Object.freeze({ ...entry, rank: index + 1 }));
}

// --- Portfolio size: guidance, not a hard cap -----------------------------

export const PORTFOLIO_GUIDANCE = Object.freeze({ min: 5, max: 10 });

/**
 * Evaluates a proposed portfolio size against the 5-10 guidance band.
 *
 *   - Below the minimum: ALWAYS `allowed: true`. Approving fewer flows than
 *     the guidance minimum, when that is sufficient coverage, is a
 *     first-class, comfortable outcome (SPEC-135.md story 15) — this
 *     function contains no code path that can refuse or flag it as
 *     deficient beyond the informational `band` label.
 *   - Within the band: `allowed: true`, no override needed.
 *   - Above the maximum: requires an explicit, reviewed override — a named
 *     approver holding the qa-owner or technical-owner role, with a reason
 *     (the same reviewed-identity shape confirmIntent/validateGreenfieldSource
 *     use in posture.mjs, reused here rather than reinvented). Without a
 *     valid override, `allowed: false` — but this function never truncates
 *     the list itself; it only reports that the caller must go get review
 *     before proceeding with this size.
 */
export function evaluatePortfolioSize(selectedCount, override) {
  if (!isNonNegativeInteger(selectedCount)) {
    throw new Error("evaluatePortfolioSize requires selectedCount to be a non-negative integer");
  }

  if (selectedCount < PORTFOLIO_GUIDANCE.min) {
    return Object.freeze({
      band: "below-guidance",
      withinGuidance: false,
      requiresOverride: false,
      allowed: true,
      errors: [],
    });
  }
  if (selectedCount <= PORTFOLIO_GUIDANCE.max) {
    return Object.freeze({
      band: "within-guidance",
      withinGuidance: true,
      requiresOverride: false,
      allowed: true,
      errors: [],
    });
  }

  // Above PORTFOLIO_GUIDANCE.max: an explicit reviewed override is required.
  const errors = [];
  const { approvedBy, approvedByRole, reason } = override || {};
  if (!nonEmptyString(approvedBy)) {
    errors.push("a portfolio above the 5-10 guidance band requires an override naming an approving identity (approvedBy)");
  }
  if (!CONFIRMING_ROLES.includes(approvedByRole)) {
    errors.push(
      `override approvedByRole must be one of ${CONFIRMING_ROLES.join(", ")}, got: ${String(approvedByRole)}`,
    );
  }
  if (!nonEmptyString(reason)) {
    errors.push("a portfolio-size override requires a plain-language reason");
  }
  return Object.freeze({
    band: "above-guidance",
    withinGuidance: false,
    requiresOverride: true,
    allowed: errors.length === 0,
    errors,
  });
}
