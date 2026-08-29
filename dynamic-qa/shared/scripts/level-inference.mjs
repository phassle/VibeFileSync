// dynamic-qa/shared/scripts/level-inference.mjs
//
// Ticket #147: "Infer the test level and adopt existing coverage"
// (DESIGN-dynamic-qa-spec.md §7 step 3, SPEC-135 user stories 31-32).
// #146 left `qa-generate/SKILL.md` step 3 hard-coding "honor test_level as-is
// / prefer API over browser" — this module replaces that with the real
// deterministic decision: select the cheapest deterministic test level that
// proves every Expected Outcome, after eliminating candidates that are
// unsafe, incomplete, or unobservable.
//
// There is deliberately no fixed API-vs-CLI-vs-browser ranking anywhere in
// this file. A "candidate" is an opaque `id` (a level name the caller
// discovered as realizable against the flow's boundaries/harness — "api",
// "cli", "browser", or anything else the customer's harness supports) plus
// three boolean proof-obligation flags and a cost breakdown. Which id wins
// falls out of those inputs alone. Two calls with the same id set can and
// should pick different winners when the cost numbers differ — that is the
// point, not a bug: cost is a property of *this* flow against *this*
// harness (an API candidate might need a whole new mock server while a CLI
// candidate reuses an existing harness untouched, or vice versa on the next
// flow).
//
// Elimination happens strictly before cost is ever consulted. A candidate
// that fails any of the three gates is discarded with a stated reason and
// never enters the cost comparison, regardless of how cheap its cost numbers
// claim to be — a cheap lie is still a lie.
//
//   - `safe: false`      -> eliminated as unsafe (e.g. would require a
//                           forbidden or unhonourable boundary treatment;
//                           see resolveBoundaryTreatment in
//                           boundary-policy.mjs, which callers should use to
//                           derive this flag rather than re-deriving it).
//   - `provesAllOutcomes: false` -> eliminated as incomplete (this level
//                           cannot prove every declared Expected Outcome
//                           of the flow, e.g. a CLI surface with no way to
//                           observe an outcome only visible in a UI toast).
//   - `observable: false` -> eliminated as unobservable (the outcome exists
//                           at this level in principle, but nothing at this
//                           level can deterministically observe it — e.g. a
//                           fire-and-forget async side effect with no
//                           readback).
//
// Cost, for every surviving candidate, is the sum of five caller-supplied
// non-negative numbers, matching the run brief and ticket verbatim: reuse
// (how much of the existing harness/fixtures this level can reuse — lower
// is more reuse), runtime, fixture complexity, boundary fidelity (cost of
// how faithfully this level exercises the flow's real boundaries — a level
// that must simulate away the owned boundary to work costs more here even
// when it is otherwise cheap), and maintenance. Lower total wins; ties are
// broken by ascending `id` so the decision is reproducible, never by
// insertion order or Math.random.
//
// A Test Level Override bypasses cost-based ranking, never elimination: an
// override still has to name a surviving (safe, complete, observable)
// candidate. It must be explicit (`override.levelId` naming exactly one
// candidate) and reviewed (`override.reviewed === true`, a caller-supplied
// boolean the run brief requires be *evidence*, never inferred the way
// #145 refused to infer boundary `role`/`volatile` from prose) and carry a
// non-empty `reason`. Fail closed on any of that being missing: this
// function never infers an override on the model's say-so.

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const COST_FIELDS = Object.freeze(["reuse", "runtime", "fixtureComplexity", "boundaryFidelity", "maintenance"]);

function validateCandidateShape(candidate, index, errors) {
  const path = ["candidates", index];
  if (!isPlainObject(candidate) || !nonEmptyString(candidate.id)) {
    errors.push({ path, message: "each candidate must be a mapping with a non-empty id" });
    return false;
  }
  for (const flag of ["safe", "provesAllOutcomes", "observable"]) {
    if (typeof candidate[flag] !== "boolean") {
      errors.push({ path: [...path, flag], message: `candidate ${JSON.stringify(candidate.id)} must declare ${flag} as a boolean` });
      return false;
    }
  }
  if (!isPlainObject(candidate.cost)) {
    errors.push({ path: [...path, "cost"], message: `candidate ${JSON.stringify(candidate.id)} must declare a cost mapping` });
    return false;
  }
  for (const field of COST_FIELDS) {
    const value = candidate.cost[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push({
        path: [...path, "cost", field],
        message: `candidate ${JSON.stringify(candidate.id)} cost.${field} must be a non-negative finite number`,
      });
      return false;
    }
  }
  return true;
}

function eliminationReason(candidate) {
  if (!candidate.safe) {
    return { code: "unsafe", message: `level ${JSON.stringify(candidate.id)} eliminated: unsafe (cannot be realized without an unsafe boundary treatment)` };
  }
  if (!candidate.provesAllOutcomes) {
    return { code: "incomplete", message: `level ${JSON.stringify(candidate.id)} eliminated: incomplete (cannot prove every declared Expected Outcome)` };
  }
  if (!candidate.observable) {
    return { code: "unobservable", message: `level ${JSON.stringify(candidate.id)} eliminated: unobservable (no deterministic way to observe the outcome at this level)` };
  }
  return null;
}

function totalCost(candidate) {
  return COST_FIELDS.reduce((sum, field) => sum + candidate.cost[field], 0);
}

function rankByCost(survivors) {
  return survivors
    .map((candidate) => ({ id: candidate.id, totalCost: totalCost(candidate), candidate }))
    .sort((a, b) => (a.totalCost !== b.totalCost ? a.totalCost - b.totalCost : a.id.localeCompare(b.id)));
}

/**
 * Selects a test level for one flow from a list of candidate levels.
 *
 * `candidates`: `[{ id, safe, provesAllOutcomes, observable, cost: {
 *   reuse, runtime, fixtureComplexity, boundaryFidelity, maintenance } }]`.
 *
 * `options.override`, when present: `{ levelId, reviewed, reason }`. Selects
 * `levelId` unconditionally over cost ranking, but only if `levelId` names a
 * surviving (non-eliminated) candidate, `reviewed === true`, and `reason` is
 * a non-empty string. Never partially honors an override.
 *
 * Returns `{ ok: true, selection: "inferred" | "override", levelId, reason,
 * eliminated, ranked }` on success, where `eliminated` is
 * `[{ id, code, message }]` for every discarded candidate (in input order)
 * and `ranked` is every surviving candidate in the order cost ranking
 * considered them (cheapest first), each as `{ id, totalCost }`.
 *
 * Returns `{ ok: false, reason, errors, eliminated }` on failure. Never
 * throws; a malformed candidate list is a fail-closed `ok: false`, not an
 * exception.
 */
export function selectTestLevel(candidates, options = {}) {
  const errors = [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, reason: "no-candidates", errors: [{ path: ["candidates"], message: "at least one candidate level is required" }], eliminated: [] };
  }

  candidates.forEach((candidate, i) => validateCandidateShape(candidate, i, errors));
  if (errors.length > 0) {
    return { ok: false, reason: "malformed-candidates", errors, eliminated: [] };
  }

  const ids = candidates.map((c) => c.id);
  const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicateIds.length > 0) {
    return {
      ok: false,
      reason: "duplicate-candidate-id",
      errors: [{ path: ["candidates"], message: `candidate ids must be unique (duplicated: ${[...new Set(duplicateIds)].join(", ")})` }],
      eliminated: [],
    };
  }

  const eliminated = [];
  const survivors = [];
  for (const candidate of candidates) {
    const why = eliminationReason(candidate);
    if (why) eliminated.push({ id: candidate.id, ...why });
    else survivors.push(candidate);
  }

  const ranked = rankByCost(survivors).map(({ id, totalCost: cost }) => ({ id, totalCost: cost }));

  const override = options.override;
  if (override !== undefined) {
    if (!isPlainObject(override) || !nonEmptyString(override.levelId)) {
      return { ok: false, reason: "override-malformed", errors: [{ path: ["override", "levelId"], message: "an override must name a non-empty levelId" }], eliminated };
    }
    if (override.reviewed !== true) {
      return {
        ok: false,
        reason: "override-not-reviewed",
        errors: [{ path: ["override", "reviewed"], message: "a Test Level Override requires an explicit, evidenced review — it is never inferred" }],
        eliminated,
      };
    }
    if (!nonEmptyString(override.reason)) {
      return { ok: false, reason: "override-missing-reason", errors: [{ path: ["override", "reason"], message: "a Test Level Override requires a non-empty recorded reason" }], eliminated };
    }
    const chosen = survivors.find((c) => c.id === override.levelId);
    if (!chosen) {
      const eliminatedMatch = eliminated.find((e) => e.id === override.levelId);
      return {
        ok: false,
        reason: "override-candidate-ineligible",
        errors: [
          {
            path: ["override", "levelId"],
            message: eliminatedMatch
              ? `override names level ${JSON.stringify(override.levelId)}, which was eliminated (${eliminatedMatch.code}) — an override may keep a genuine end-to-end journey, it may not bypass safety, completeness, or observability`
              : `override names level ${JSON.stringify(override.levelId)}, which is not among the candidates`,
          },
        ],
        eliminated,
      };
    }
    return { ok: true, selection: "override", levelId: chosen.id, reason: override.reason, eliminated, ranked };
  }

  if (survivors.length === 0) {
    return {
      ok: false,
      reason: "no-surviving-candidate",
      errors: [{ path: ["candidates"], message: "every candidate level was eliminated as unsafe, incomplete, or unobservable" }],
      eliminated,
    };
  }

  const winner = ranked[0];
  return {
    ok: true,
    selection: "inferred",
    levelId: winner.id,
    reason: `cheapest surviving level (total cost ${winner.totalCost}) among ${survivors.length} candidate(s) that proved every Expected Outcome safely and observably`,
    eliminated,
    ranked,
  };
}
