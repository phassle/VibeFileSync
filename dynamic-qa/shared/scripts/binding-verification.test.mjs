// dynamic-qa/shared/scripts/binding-verification.test.mjs
//
// Tier 1 coverage for the post-generation gate (binding-verification.mjs,
// #146): the core is what actually checks a candidate Binding, not the
// agent that authored it. Proves acceptance requires BOTH complete Expected
// Outcome coverage AND a clean forbidden-pattern scan, and that either
// check failing produces its own distinguishable reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCandidateBinding } from "./binding-verification.mjs";

const FLOW_DATA = {
  steps: [
    {
      id: "then-a",
      kind: "then",
      intent: "...",
      outcomes: [{ id: "outcome-one", expect: "..." }],
    },
  ],
};

const CLEAN_FILE = {
  path: "tests/e2e/checkout.spec.ts",
  content: `
import { test, expect } from "@playwright/test";
test("checkout completes", async ({ page }) => {
  await expect(page.getByTestId("result")).toHaveText("done");
});
`,
};

test("accepts a candidate with complete coverage and no forbidden pattern", () => {
  const result = verifyCandidateBinding({
    flowData: FLOW_DATA,
    assertions: [{ stepId: "then-a", outcomeId: "outcome-one", location: `${CLEAN_FILE.path}:3` }],
    files: [CLEAN_FILE],
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.deepEqual(result.reasons, []);
});

test("fail-closed: rejects a candidate that leaves an Expected Outcome unproven", () => {
  const result = verifyCandidateBinding({ flowData: FLOW_DATA, assertions: [], files: [CLEAN_FILE] });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("incomplete-outcome-coverage"));
  assert.equal(result.coverage.valid, false);
});

test("fail-closed: rejects a candidate containing a forbidden pattern even when coverage is complete", () => {
  const dirtyFile = { path: "tests/e2e/checkout.spec.ts", content: "it.skip('checkout completes', () => {});\n" };
  const result = verifyCandidateBinding({
    flowData: FLOW_DATA,
    assertions: [{ stepId: "then-a", outcomeId: "outcome-one", location: `${dirtyFile.path}:1` }],
    files: [dirtyFile],
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("forbidden-pattern-present"));
  assert.ok(result.forbidden.violationsByFile[dirtyFile.path].length > 0);
});

test("fail-closed: reports both reasons when coverage is incomplete AND a forbidden pattern is present", () => {
  const dirtyFile = { path: "tests/e2e/checkout.spec.ts", content: "// TODO\n" };
  const result = verifyCandidateBinding({ flowData: FLOW_DATA, assertions: [], files: [dirtyFile] });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.reasons.sort(), ["forbidden-pattern-present", "incomplete-outcome-coverage"]);
});
