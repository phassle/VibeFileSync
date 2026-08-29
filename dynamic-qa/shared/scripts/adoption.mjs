// dynamic-qa/shared/scripts/adoption.mjs
//
// Ticket #147: "Infer the test level and adopt existing coverage"
// (DESIGN-dynamic-qa-spec.md §7 step 2, SPEC-135 user story 51). #146 left
// `qa-generate/SKILL.md` step 2's reuse path a stub ("treat 'no obviously
// matching existing test' as 'generate new'" with no actual detection).
// This module is the real decision, and it deliberately does not duplicate
// #146's `expected-outcome-coverage.mjs` — it calls it. Adoption of an
// existing test is exactly the same completeness question generation's
// own assertion-mapping gate already answers ("does this list of
// { stepId, outcomeId } assertions prove every declared Expected Outcome?"),
// just asked about a pre-existing candidate instead of a freshly generated
// one. Writing a second coverage checker here would be exactly the kind of
// duplicate machinery the run brief warns against.
//
// "Provable, not optimistic" (the run brief's phrase for this ticket) means
// adoption never succeeds on a hopeful guess that some existing test
// "probably" covers a flow. The caller must hand this module the existing
// test's *claimed* assertion list in the same
// `[{ stepId, outcomeId, location }]` shape generation itself must produce
// (discovering that list — e.g. by reading test source and matching it back
// to Flow step/outcome IDs — is qa-generate's discovery job, not this
// module's; this module only judges a list once it exists). If that claim
// cannot be produced at all (no candidate, or a candidate with no
// extractable assertion list), adoption fails closed and generation
// proceeds — it never falls back to "adopt anyway because a test file with
// a plausible name exists".
//
// Partial coverage never qualifies. `checkAssertionCoverage` already treats
// "declared outcome with zero assertions" as an error; this module surfaces
// that as `partial-coverage` rather than silently adopting a test that
// proves *some* outcomes and leaving the rest unproven forever.

import { checkAssertionCoverage } from "./expected-outcome-coverage.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Evaluates one existing-test candidate for adoption against a validated
 * Flow Definition's `flowData`.
 *
 * `candidate`: `{ sourcePath, assertions }`, where `assertions` is the
 * candidate's claimed `[{ stepId, outcomeId, location }]` list — the exact
 * shape `expected-outcome-coverage.mjs` already validates. `sourcePath`
 * identifies the pre-existing test file/spec being considered (becomes
 * provenance's `generator.adoptedFrom`).
 *
 * Returns `{ adopt: true, sourcePath, assertions }` only when every declared
 * Expected Outcome is proven by the candidate's own claimed assertions.
 * Returns `{ adopt: false, reason, errors }` otherwise:
 *   - `reason: "no-candidate"` when `candidate` is absent — there is
 *     nothing to adopt, generation proceeds;
 *   - `reason: "unverifiable-candidate"` when the candidate is malformed
 *     (missing sourcePath, or assertions not even a list) — the core
 *     cannot verify the claim, so it cannot be trusted;
 *   - `reason: "partial-coverage"` when the candidate's assertions are
 *     well-formed but leave at least one declared Expected Outcome
 *     unproven, or reference an outcome the flow does not declare —
 *     `errors` carries `checkAssertionCoverage`'s own findings so a review
 *     packet can show exactly what is missing.
 *
 * Never throws. Never adopts on partial evidence, no matter how close to
 * complete — this is a provable-or-not gate, not a best-effort score.
 */
export function evaluateAdoptionCandidate(flowData, candidate) {
  if (candidate === undefined || candidate === null) {
    return { adopt: false, reason: "no-candidate", errors: [] };
  }
  if (!isPlainObject(candidate) || !nonEmptyString(candidate.sourcePath) || !Array.isArray(candidate.assertions)) {
    return {
      adopt: false,
      reason: "unverifiable-candidate",
      errors: [{ path: ["candidate"], message: "an adoption candidate must be a mapping with a non-empty sourcePath and an assertions list" }],
    };
  }

  const coverage = checkAssertionCoverage(flowData, candidate.assertions);
  if (!coverage.valid) {
    return { adopt: false, reason: "partial-coverage", errors: coverage.errors };
  }

  return { adopt: true, sourcePath: candidate.sourcePath, assertions: candidate.assertions };
}

/**
 * Builds the `generator` object shape #146's `provenance.mjs` requires for
 * an adopted Binding: `identity: "adopted"` plus `adoptedFrom`. Callers
 * still supply `bundleVersion` and `contentDigest` (this module has no
 * opinion on the installed bundle's own version/digest) by spreading this
 * result into `buildBindingRecord`'s `generator` argument alongside them.
 */
export function adoptionGeneratorFields(sourcePath) {
  return { identity: "adopted", adoptedFrom: sourcePath };
}
