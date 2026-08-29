// dynamic-qa/shared/scripts/expected-outcome-coverage.mjs
//
// The completeness check ticket #146 exists to build: "Every generated
// assertion carries the Expected Outcome ID it proves, and generation fails
// when an outcome would be left unproven" (SPEC-135.md user story 53,
// tickets/146.md acceptance criteria). This is deterministic computation
// over two already-validated data structures — a Flow Definition's declared
// Expected Outcome IDs, and the list of assertions a candidate Binding
// claims to realize — so it belongs here, not in `qa-generate/SKILL.md`
// prose: "emitting a stub instead of a real test must be impossible, not
// merely discouraged" only holds if something other than the same model
// that wrote the assertions checks them.
//
// An "assertion" here is the generic shape any Binding — API, CLI, or
// browser — reduces to for this check: `{ stepId, outcomeId, location }`,
// where `location` is a free-form string a review packet can show a human
// (e.g. "checkout.spec.ts:42"), never inspected by this module itself.

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collects every declared Expected Outcome ID from a validated Flow
 * Definition, alongside the step that declares it. Returns
 * `[{ stepId, outcomeId }]` in flow-declaration order (steps/outcomes are
 * meaningful order, per flow-definition.mjs / the Flow Definition schema).
 */
export function collectExpectedOutcomeIds(flowData) {
  const declared = [];
  for (const step of flowData.steps ?? []) {
    for (const outcome of step.outcomes ?? []) {
      declared.push({ stepId: step.id, outcomeId: outcome.id });
    }
  }
  return declared;
}

/**
 * Checks that a candidate Binding's claimed assertions cover every declared
 * Expected Outcome exactly, no more and no less loosely than that:
 *   - every assertion must reference a real, currently-declared
 *     `{ stepId, outcomeId }` pair (an assertion pointing at an outcome id
 *     that exists but under the wrong step is still rejected — the mapping
 *     must be exact, not merely "the id exists somewhere");
 *   - every declared Expected Outcome must be proven by at least one
 *     assertion (more than one assertion proving the same outcome is fine
 *     and common — e.g. an intermediate checkpoint plus a final assertion —
 *     it is never an error).
 *
 * Returns `{ valid, errors }` in the same `{ path, message }` Issues shape
 * used across the deterministic core. Never throws; collects every problem
 * rather than stopping at the first, so a review packet can show a
 * complete list of what would be left unproven.
 */
export function checkAssertionCoverage(flowData, assertions) {
  const errors = [];
  const declared = collectExpectedOutcomeIds(flowData);
  const declaredKey = (d) => `${d.stepId}::${d.outcomeId}`;
  const declaredSet = new Set(declared.map(declaredKey));

  if (!Array.isArray(assertions)) {
    errors.push({ path: ["assertions"], message: "assertions must be a list" });
    return { valid: false, errors };
  }

  const proven = new Set();
  assertions.forEach((assertion, i) => {
    const path = ["assertions", i];
    if (!isPlainObject(assertion) || typeof assertion.stepId !== "string" || typeof assertion.outcomeId !== "string") {
      errors.push({ path, message: "each assertion must be a mapping with stepId and outcomeId" });
      return;
    }
    const key = declaredKey(assertion);
    if (!declaredSet.has(key)) {
      errors.push({
        path,
        message: `assertion references outcome ${JSON.stringify(assertion.outcomeId)} on step ${JSON.stringify(assertion.stepId)}, which this flow does not declare — a Binding may only prove outcomes the Flow Definition actually declares, on the exact step that declares them`,
      });
      return;
    }
    proven.add(key);
  });

  for (const outcome of declared) {
    const key = declaredKey(outcome);
    if (!proven.has(key)) {
      errors.push({
        path: ["steps"],
        message: `Expected Outcome ${JSON.stringify(outcome.outcomeId)} on step ${JSON.stringify(outcome.stepId)} is left unproven — generation must fail rather than silently lose a proof obligation`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
