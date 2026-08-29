// dynamic-qa/shared/scripts/data-set-refs.test.mjs
//
// Tests the shape-only seam #144 (the Named Data Set contract) is expected
// to build on — see data-set-refs.mjs's module comment for what is
// deliberately left to that ticket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDataSetReferences } from "./data-set-refs.mjs";

test("an empty data_sets list is allowed (a flow may need no named data)", () => {
  assert.deepEqual(validateDataSetReferences([], ["data_sets"]), []);
});

test("valid semantic references have no issues", () => {
  assert.deepEqual(validateDataSetReferences(["changed-destination-basic"], ["data_sets"]), []);
});

test("a non-semantic reference is rejected", () => {
  const issues = validateDataSetReferences(["Not Semantic!"], ["data_sets"]);
  assert.ok(issues.some((i) => /semantic Named Data Set id/.test(i.message)));
});

test("duplicate references are rejected", () => {
  const issues = validateDataSetReferences(["a", "a"], ["data_sets"]);
  assert.ok(issues.some((i) => /duplicate data_sets reference/.test(i.message)));
});

test("data_sets must be a list", () => {
  const issues = validateDataSetReferences("not-a-list", ["data_sets"]);
  assert.ok(issues.some((i) => /must be a list/.test(i.message)));
});
