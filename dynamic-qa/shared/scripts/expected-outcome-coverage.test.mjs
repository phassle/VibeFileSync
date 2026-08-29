// dynamic-qa/shared/scripts/expected-outcome-coverage.test.mjs
//
// Tier 1 coverage for the assertion <-> Expected Outcome ID completeness
// check (expected-outcome-coverage.mjs, #146, SPEC-135 story 53).

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectExpectedOutcomeIds, checkAssertionCoverage } from "./expected-outcome-coverage.mjs";

const FLOW_DATA = {
  steps: [
    { id: "given-a", kind: "given", intent: "..." },
    {
      id: "then-b",
      kind: "then",
      intent: "...",
      outcomes: [
        { id: "outcome-one", expect: "..." },
        { id: "outcome-two", expect: "..." },
      ],
    },
    {
      id: "then-c",
      kind: "then",
      intent: "...",
      outcomes: [{ id: "outcome-three", expect: "..." }],
    },
  ],
};

test("collectExpectedOutcomeIds lists every declared outcome with its owning step, in declaration order", () => {
  assert.deepEqual(collectExpectedOutcomeIds(FLOW_DATA), [
    { stepId: "then-b", outcomeId: "outcome-one" },
    { stepId: "then-b", outcomeId: "outcome-two" },
    { stepId: "then-c", outcomeId: "outcome-three" },
  ]);
});

test("checkAssertionCoverage accepts a complete 1:1 mapping", () => {
  const assertions = [
    { stepId: "then-b", outcomeId: "outcome-one", location: "a.spec.ts:1" },
    { stepId: "then-b", outcomeId: "outcome-two", location: "a.spec.ts:2" },
    { stepId: "then-c", outcomeId: "outcome-three", location: "a.spec.ts:3" },
  ];
  const result = checkAssertionCoverage(FLOW_DATA, assertions);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("checkAssertionCoverage accepts more than one assertion proving the same outcome", () => {
  const assertions = [
    { stepId: "then-b", outcomeId: "outcome-one", location: "a.spec.ts:1" },
    { stepId: "then-b", outcomeId: "outcome-one", location: "a.spec.ts:1b" },
    { stepId: "then-b", outcomeId: "outcome-two", location: "a.spec.ts:2" },
    { stepId: "then-c", outcomeId: "outcome-three", location: "a.spec.ts:3" },
  ];
  const result = checkAssertionCoverage(FLOW_DATA, assertions);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("fail-closed: checkAssertionCoverage fails generation when an outcome is left unproven", () => {
  const assertions = [
    { stepId: "then-b", outcomeId: "outcome-one", location: "a.spec.ts:1" },
    { stepId: "then-c", outcomeId: "outcome-three", location: "a.spec.ts:3" },
  ];
  const result = checkAssertionCoverage(FLOW_DATA, assertions);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /outcome-two.*left unproven/.test(e.message)));
});

test("fail-closed: checkAssertionCoverage rejects an assertion referencing an outcome id that does not exist", () => {
  const assertions = [
    { stepId: "then-b", outcomeId: "outcome-one", location: "a.spec.ts:1" },
    { stepId: "then-b", outcomeId: "outcome-two", location: "a.spec.ts:2" },
    { stepId: "then-c", outcomeId: "outcome-three", location: "a.spec.ts:3" },
    { stepId: "then-c", outcomeId: "invented-outcome", location: "a.spec.ts:4" },
  ];
  const result = checkAssertionCoverage(FLOW_DATA, assertions);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /which this flow does not declare/.test(e.message)));
});

test("fail-closed: checkAssertionCoverage rejects an assertion pairing a real outcome id with the wrong step", () => {
  const assertions = [
    { stepId: "then-c", outcomeId: "outcome-one", location: "a.spec.ts:1" }, // outcome-one belongs to then-b, not then-c
    { stepId: "then-b", outcomeId: "outcome-two", location: "a.spec.ts:2" },
    { stepId: "then-c", outcomeId: "outcome-three", location: "a.spec.ts:3" },
  ];
  const result = checkAssertionCoverage(FLOW_DATA, assertions);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /which this flow does not declare/.test(e.message)));
  // outcome-one is still unproven under its real step, then-b.
  assert.ok(result.errors.some((e) => /outcome-one.*left unproven/.test(e.message)));
});

test("fail-closed: checkAssertionCoverage rejects a non-list assertions argument", () => {
  const result = checkAssertionCoverage(FLOW_DATA, null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /must be a list/.test(e.message)));
});

test("fail-closed: checkAssertionCoverage rejects a malformed assertion entry", () => {
  const result = checkAssertionCoverage(FLOW_DATA, [{ location: "a.spec.ts:1" }]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /stepId and outcomeId/.test(e.message)));
});

test("a flow with no outcomes at all is trivially fully covered by zero assertions", () => {
  const result = checkAssertionCoverage({ steps: [{ id: "given-a", kind: "given", intent: "..." }] }, []);
  assert.equal(result.valid, true);
});
