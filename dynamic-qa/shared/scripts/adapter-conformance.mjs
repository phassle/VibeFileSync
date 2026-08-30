// dynamic-qa/shared/scripts/adapter-conformance.mjs
//
// Ticket #156: the reusable provider-adapter conformance suite. This is the
// single entry point any caller (a Tier 1 test, a future onboarding check
// for a real second provider) should use to ask "does this adapter object
// conform to the neutral contract (adapter-contract.mjs)?" — it always runs
// every one of the seven contract points and every one of the six security
// obligations, unconditionally, in a fixed order, exactly like
// capability-gate.mjs's `runCapabilityGate` runs all eight of its own
// categories unconditionally: there is no early return once one point/
// obligation fails, and no code path that omits a check because an earlier
// one already failed.
//
// Genuinely reusable, not merely "written once but only ever called once":
// this function takes an `adapter` object and a `fixtures` bag as plain
// data — it imports nothing provider-specific, so calling it against
// `github-actions-adapter.mjs`'s exported `adapter` with GitHub-shaped
// fixtures, and again against `fixture-adapter.mjs`'s exported `adapter`
// with fixture-ci-shaped fixtures, exercises the exact same code path both
// times (see adapter-conformance.test.mjs's reusability test).

import { checkAdapterShape, CONTRACT_POINTS, POINT_CHECKS, SECURITY_OBLIGATIONS, OBLIGATION_CHECKS } from "./adapter-contract.mjs";

/**
 * Runs the full conformance suite against `adapter` using `fixtures` (the
 * adapter-specific probe data adapter-contract.mjs's individual checks
 * document). Returns:
 *
 *   {
 *     valid,            // true only when every point and every obligation passes
 *     shapeValid,       // structural pre-check result (checkAdapterShape)
 *     pointResults,     // { [pointKey]: { valid, errors } } for all 7 points
 *     obligationResults,// { [obligationId]: { valid, errors } } for all 6 obligations
 *     errors,           // every error from shape + points + obligations, concatenated
 *   }
 *
 * Never throws for an ordinary non-conforming adapter — every individual
 * check already catches a thrown error from the adapter under test and
 * turns it into a named `{ valid: false, errors }` result instead.
 */
export function runAdapterConformanceSuite(adapter, fixtures = {}) {
  const shape = checkAdapterShape(adapter);

  const pointResults = {};
  for (const point of CONTRACT_POINTS) {
    const checkFn = POINT_CHECKS[point.id - 1];
    pointResults[point.key] = checkFn(adapter, fixtures);
  }

  const obligationResults = {};
  for (let i = 0; i < SECURITY_OBLIGATIONS.length; i++) {
    const obligation = SECURITY_OBLIGATIONS[i];
    const checkFn = OBLIGATION_CHECKS[i];
    obligationResults[obligation.id] = checkFn(adapter, fixtures);
  }

  const errors = [
    ...shape.errors,
    ...Object.values(pointResults).flatMap((r) => r.errors),
    ...Object.values(obligationResults).flatMap((r) => r.errors),
  ];

  return {
    valid: errors.length === 0,
    shapeValid: shape.valid,
    pointResults,
    obligationResults,
    errors,
  };
}
