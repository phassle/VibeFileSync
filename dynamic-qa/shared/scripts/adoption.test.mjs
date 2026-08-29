// dynamic-qa/shared/scripts/adoption.test.mjs
//
// Ticket #147 coverage: adoption succeeds only when the core can prove full
// Expected Outcome coverage from the candidate's own claimed assertions
// (reusing #146's expected-outcome-coverage.mjs, not a second checker);
// partial coverage never qualifies; an absent or unverifiable candidate
// fails closed so generation proceeds instead.
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateAdoptionCandidate, adoptionGeneratorFields } from "./adoption.mjs";

const flowData = {
  steps: [
    { id: "step-1", outcomes: [{ id: "outcome-1" }] },
    { id: "step-2", outcomes: [{ id: "outcome-2" }, { id: "outcome-3" }] },
  ],
};

const fullAssertions = [
  { stepId: "step-1", outcomeId: "outcome-1", location: "existing.spec.ts:10" },
  { stepId: "step-2", outcomeId: "outcome-2", location: "existing.spec.ts:20" },
  { stepId: "step-2", outcomeId: "outcome-3", location: "existing.spec.ts:25" },
];

test("adopts an existing test that proves every declared Expected Outcome", () => {
  const result = evaluateAdoptionCandidate(flowData, { sourcePath: "test/existing.spec.ts", assertions: fullAssertions });
  assert.equal(result.adopt, true);
  assert.equal(result.sourcePath, "test/existing.spec.ts");
  assert.deepEqual(result.assertions, fullAssertions);
});

test("does not adopt an existing test that proves only some outcomes", () => {
  const partial = fullAssertions.slice(0, 1); // leaves outcome-2 and outcome-3 unproven
  const result = evaluateAdoptionCandidate(flowData, { sourcePath: "test/existing.spec.ts", assertions: partial });
  assert.equal(result.adopt, false);
  assert.equal(result.reason, "partial-coverage");
  assert.ok(result.errors.length >= 2, "expects one error per unproven outcome");
});

test("does not adopt when a claimed assertion references an outcome the flow does not declare", () => {
  const bogus = [...fullAssertions, { stepId: "step-2", outcomeId: "no-such-outcome", location: "existing.spec.ts:30" }];
  const result = evaluateAdoptionCandidate(flowData, { sourcePath: "test/existing.spec.ts", assertions: bogus });
  assert.equal(result.adopt, false);
  assert.equal(result.reason, "partial-coverage");
});

test("falls through to generation (no adoption) when no candidate exists", () => {
  const result = evaluateAdoptionCandidate(flowData, undefined);
  assert.equal(result.adopt, false);
  assert.equal(result.reason, "no-candidate");
});

test("fails closed on an unverifiable candidate (no assertion list to check)", () => {
  const result = evaluateAdoptionCandidate(flowData, { sourcePath: "test/existing.spec.ts" });
  assert.equal(result.adopt, false);
  assert.equal(result.reason, "unverifiable-candidate");
});

test("fails closed on an unverifiable candidate (missing sourcePath)", () => {
  const result = evaluateAdoptionCandidate(flowData, { assertions: fullAssertions });
  assert.equal(result.adopt, false);
  assert.equal(result.reason, "unverifiable-candidate");
});

test("builds the provenance generator fields an adopted Binding requires", () => {
  assert.deepEqual(adoptionGeneratorFields("test/existing.spec.ts"), {
    identity: "adopted",
    adoptedFrom: "test/existing.spec.ts",
  });
});
