// dynamic-qa/shared/scripts/binding-verification.mjs
//
// The post-generation gate that pairs with preflight.mjs's pre-generation
// gate. Where preflight.mjs decides whether qa-generate may even attempt to
// generate a Binding for a flow, this module decides whether a candidate
// Binding the generative step (qa-generate/SKILL.md prose, driven by a
// coding agent) actually produced is acceptable:
//
//   "A generated Binding must then be *checked* by the deterministic core:
//   if the core cannot verify that every Expected Outcome ID is covered and
//   no forbidden pattern is present, generation fails." (run notes
//   tickets/146.md)
//
// This is the seam that makes "emitting a stub instead of a real test must
// be impossible, not merely discouraged" true: the agent that authored the
// candidate is never the sole judge of its own completeness or cleanliness.
// Composes expected-outcome-coverage.mjs and forbidden-patterns.mjs — both
// reused here, neither forked.

import { checkAssertionCoverage } from "./expected-outcome-coverage.mjs";
import { scanGeneratedFiles } from "./forbidden-patterns.mjs";

/**
 * Verifies one candidate Binding against its Flow Definition. `files` is
 * `[{ path, content }]` for every file the candidate writes; `assertions`
 * is `[{ stepId, outcomeId, location }]` for every assertion the candidate
 * claims to realize.
 *
 * Returns `{ accepted, reasons, coverage, forbidden }`:
 *   - `accepted` is true only when both the coverage check and the
 *     forbidden-pattern scan pass;
 *   - `reasons` is a short list of stable reason codes
 *     (`incomplete-outcome-coverage`, `forbidden-pattern-present`) for
 *     whichever check(s) failed, so a caller can report an exact reason
 *     without re-deriving one from `coverage`/`forbidden`;
 *   - `coverage` is expected-outcome-coverage.mjs's own `{ valid, errors }`;
 *   - `forbidden` is forbidden-patterns.mjs's own
 *     `{ clean, violationsByFile }`.
 *
 * Never throws; both underlying checks are pure, total functions over their
 * inputs.
 */
export function verifyCandidateBinding({ flowData, assertions, files }) {
  const coverage = checkAssertionCoverage(flowData, assertions);
  const forbidden = scanGeneratedFiles(files);

  const reasons = [];
  if (!coverage.valid) reasons.push("incomplete-outcome-coverage");
  if (!forbidden.clean) reasons.push("forbidden-pattern-present");

  return { accepted: reasons.length === 0, reasons, coverage, forbidden };
}
