// dynamic-qa/shared/scripts/boundaries.test.mjs
//
// Tests the shape-only seam #145 (Boundary Declarations) is expected to
// build on. Policy-level rules (owned outcome cannot be simulated,
// undeclared reach fails closed, Execution Profile honourability) are out
// of scope here — see boundaries.mjs's module comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBoundaries, validateBoundaryDeclaration, BOUNDARY_TREATMENTS } from "./boundaries.mjs";

test("a well-formed boundary declaration has no issues", () => {
  const issues = validateBoundaryDeclaration(
    { id: "vibesync-cli", system: "vibesync CLI", treatment: "real", behavior: "b", side_effects: "none" },
    ["boundaries", 0],
  );
  assert.deepEqual(issues, []);
});

test("treatment must be one of the three declared values", () => {
  const issues = validateBoundaryDeclaration(
    { id: "b", system: "s", treatment: "mocked", behavior: "b", side_effects: "none" },
    ["boundaries", 0],
  );
  assert.ok(issues.some((i) => i.message.includes(BOUNDARY_TREATMENTS.join(" | "))));
});

test("boundaries must declare at least one entry — undeclared reach is forbidden by default", () => {
  const issues = validateBoundaries([], ["boundaries"]);
  assert.ok(issues.some((i) => /at least one entry/.test(i.message)));
});

test("duplicate boundary ids are rejected", () => {
  const issues = validateBoundaries(
    [
      { id: "dup", system: "s", treatment: "real", behavior: "b", side_effects: "none" },
      { id: "dup", system: "s2", treatment: "simulated", behavior: "b2", side_effects: "none" },
    ],
    ["boundaries"],
  );
  assert.ok(issues.some((i) => /duplicate boundary id/.test(i.message)));
});

test("unknown keys on a boundary declaration are rejected", () => {
  const issues = validateBoundaryDeclaration(
    { id: "b", system: "s", treatment: "real", behavior: "b", side_effects: "none", selector: ".foo" },
    ["boundaries", 0],
  );
  assert.ok(issues.some((i) => /unknown key "selector"/.test(i.message)));
});
