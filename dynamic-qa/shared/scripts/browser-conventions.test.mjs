// dynamic-qa/shared/scripts/browser-conventions.test.mjs
//
// Tier 1 coverage for browser Binding selector/hook conventions
// (browser-conventions.mjs, #149): detecting several different existing
// hook conventions and following (never replacing) whichever is detected;
// each forbidden selector class rejected with its own named error; role
// and accessibility selectors accepted; a dedicated hook proposed only for
// a critical/ambiguous point, and never `data-testid` when an equivalent
// convention already exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHookConvention, validateSelector, proposeHook } from "./browser-conventions.mjs";

// --- detectHookConvention ---------------------------------------------------

test("detects a data-cy convention", () => {
  const result = detectHookConvention([
    { path: "a.tsx", content: '<button data-cy="run-button">Run</button>' },
    { path: "b.tsx", content: '<div data-cy="destination-report">{report}</div>' },
  ]);
  assert.equal(result.detected, true);
  assert.equal(result.attribute, "data-cy");
  assert.equal(result.occurrences, 2);
});

test("detects a data-qa convention", () => {
  const result = detectHookConvention([{ path: "a.tsx", content: '<button data-qa="submit">Submit</button>' }]);
  assert.equal(result.detected, true);
  assert.equal(result.attribute, "data-qa");
});

test("detects a data-testid convention", () => {
  const result = detectHookConvention([
    { path: "a.tsx", content: '<button data-testid="run-button">Run</button>' },
    { path: "a.tsx", content: '<button data-testid="cancel-button">Cancel</button>' },
  ]);
  assert.equal(result.detected, true);
  assert.equal(result.attribute, "data-testid");
});

test("detects a data-automation-id convention", () => {
  const result = detectHookConvention([{ path: "a.tsx", content: '<input data-automation-id="email-field" />' }]);
  assert.equal(result.detected, true);
  assert.equal(result.attribute, "data-automation-id");
});

test("no convention detected when no known hook attribute appears", () => {
  const result = detectHookConvention([{ path: "a.tsx", content: '<button className="primary">Run</button>' }]);
  assert.equal(result.detected, false);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.candidates, []);
});

test("ambiguous when two hook attributes tie for the highest count", () => {
  const result = detectHookConvention([
    { path: "a.tsx", content: '<button data-cy="run">Run</button>' },
    { path: "b.tsx", content: '<button data-qa="run">Run</button>' },
  ]);
  assert.equal(result.detected, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 2);
});

test("a bare substring match (e.g. inside a comment) does not count as convention evidence", () => {
  const result = detectHookConvention([{ path: "a.tsx", content: "// we used to use data-cy here, not anymore" }]);
  assert.equal(result.detected, false);
});

test("empty or missing files list is simply no convention detected", () => {
  assert.equal(detectHookConvention([]).detected, false);
  assert.equal(detectHookConvention(undefined).detected, false);
});

// --- validateSelector: forbidden classes, each with a named error -----------

test("rejects a generated ID selector", () => {
  const result = validateSelector("#react-select-2-input");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "generated-id-selector");
});

test("rejects a hashed (build-tool) class selector", () => {
  const result = validateSelector(".css-1q2w3e4r");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "hashed-class-selector");
});

test("rejects a transient framework attribute selector", () => {
  const result = validateSelector("[data-v-7ba5bd90] .title");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "transient-attribute-selector");
});

test("rejects a DOM-position selector", () => {
  const result = validateSelector("div.list > li:nth-child(3)");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "dom-position-selector");
});

test("rejects an XPath selector", () => {
  const result = validateSelector("//div[@class='report']/span[2]");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "xpath-selector");
});

test("rejects a non-string selector without throwing", () => {
  const result = validateSelector(undefined);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-selector");
});

// --- validateSelector: accepted stable targets -------------------------------

test("accepts a role/accessible-name contract via getByRole", () => {
  const result = validateSelector('getByRole("button", { name: "Run" })');
  assert.equal(result.ok, true);
  assert.equal(result.kind, "role-or-accessibility");
});

test("accepts an aria-label attribute selector", () => {
  const result = validateSelector('[aria-label="Run migration"]');
  assert.equal(result.ok, true);
  assert.equal(result.kind, "role-or-accessibility");
});

test("accepts a stable hook attribute selector", () => {
  const result = validateSelector('[data-cy="run-button"]');
  assert.equal(result.ok, true);
  assert.equal(result.kind, "stable-hook");
});

test("accepts a caller-supplied detected hookAttribute even if not in the built-in list", () => {
  const result = validateSelector('[data-selenium-id="run-button"]', { hookAttribute: "data-selenium-id" });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "stable-hook");
});

// --- proposeHook: only for critical/ambiguous points, following convention --

test("does not propose a hook when the point already has a stable selector", () => {
  const result = proposeHook({ id: "run-button", critical: true, hasStableSelector: true }, { detected: false });
  assert.equal(result.proposed, false);
});

test("does not propose a hook for an ordinary point that is neither critical nor ambiguous — no blanket application", () => {
  const result = proposeHook({ id: "decorative-icon", critical: false, ambiguous: false, hasStableSelector: false }, { detected: false });
  assert.equal(result.proposed, false);
  assert.match(result.reason, /never blanket-applied/);
});

test("proposes a hook for a critical point with no stable selector, falling back to data-testid when no convention exists", () => {
  const result = proposeHook({ id: "run-button", critical: true, hasStableSelector: false }, { detected: false });
  assert.equal(result.proposed, true);
  assert.equal(result.attribute, "data-testid");
});

test("proposes a hook for an ambiguous point, following the detected convention rather than forcing data-testid", () => {
  const convention = { detected: true, attribute: "data-cy", occurrences: 5, candidates: [{ attribute: "data-cy", occurrences: 5 }] };
  const result = proposeHook({ id: "confirm-dialog-ok", ambiguous: true, hasStableSelector: false }, convention);
  assert.equal(result.proposed, true);
  assert.equal(result.attribute, "data-cy");
  assert.notEqual(result.attribute, "data-testid");
});

test("rejects a malformed interaction point without throwing", () => {
  const result = proposeHook({}, { detected: false });
  assert.equal(result.proposed, false);
  assert.match(result.reason, /invalid-interaction-point/);
});
