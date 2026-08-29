// dynamic-qa/shared/scripts/forbidden-patterns.test.mjs
//
// Tier 1 coverage for the forbidden-pattern scan (forbidden-patterns.mjs,
// #146): each forbidden pattern family (fixed sleep, stub/placeholder,
// skipped test) is proven detected on its own, plus a clean-file baseline
// and the multi-file combinator.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectFixedSleep,
  detectStubOrPlaceholder,
  detectSkippedTest,
  scanGeneratedSource,
  scanGeneratedFiles,
} from "./forbidden-patterns.mjs";

const CLEAN_SOURCE = `
import { test, expect } from "@playwright/test";

test("destination matches source after run", async ({ page }) => {
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("destination-report")).toHaveText("Updated report text");
});
`;

test("scanGeneratedSource accepts a clean file with no forbidden pattern", () => {
  const result = scanGeneratedSource(CLEAN_SOURCE);
  assert.equal(result.clean, true, JSON.stringify(result.violations));
});

test("fail-closed: detects a fixed sleep — Playwright waitForTimeout", () => {
  const violations = detectFixedSleep('await page.waitForTimeout(2000);\n');
  assert.ok(violations.some((v) => v.pattern === "playwright-fixed-timeout"));
});

test("fail-closed: detects a fixed sleep — Cypress numeric wait", () => {
  const violations = detectFixedSleep("cy.wait(3000);\n");
  assert.ok(violations.some((v) => v.pattern === "cypress-numeric-wait"));
});

test("a Cypress alias wait (a real readiness signal, not a fixed sleep) is not flagged", () => {
  const violations = detectFixedSleep("cy.wait('@getDestination');\n");
  assert.equal(violations.length, 0);
});

test("fail-closed: detects a fixed sleep — Python time.sleep", () => {
  const violations = detectFixedSleep("time.sleep(2)\n");
  assert.ok(violations.some((v) => v.pattern === "python-time.sleep"));
});

test("fail-closed: detects a fixed sleep — Java Thread.sleep", () => {
  const violations = detectFixedSleep("Thread.sleep(500);\n");
  assert.ok(violations.some((v) => v.pattern === "java-thread-sleep"));
});

test("fail-closed: detects a fixed sleep — shell sleep", () => {
  const violations = detectFixedSleep("sleep 5\necho done\n");
  assert.ok(violations.some((v) => v.pattern === "shell-sleep"));
});

test("fail-closed: detects a fixed sleep — setTimeout used as a JS sleep idiom", () => {
  const violations = detectFixedSleep("await new Promise((resolve) => setTimeout(resolve, 1000));\n");
  assert.ok(violations.some((v) => v.pattern === "js-settimeout-as-sleep"));
});

test("fail-closed: detects a fixed sleep — Playwright networkidle", () => {
  const violations = detectFixedSleep("await page.waitForLoadState('networkidle');\n");
  assert.ok(violations.some((v) => v.pattern === "playwright-networkidle"));
});

test("fail-closed: detects a stub/placeholder — TODO marker", () => {
  const violations = detectStubOrPlaceholder("// TODO: write the real assertion\n");
  assert.ok(violations.some((v) => v.pattern === "todo-marker"));
});

test("fail-closed: detects a stub/placeholder — FIXME marker", () => {
  const violations = detectStubOrPlaceholder("// FIXME once selectors exist\n");
  assert.ok(violations.some((v) => v.pattern === "fixme-marker"));
});

test("fail-closed: detects a stub/placeholder — not implemented", () => {
  const violations = detectStubOrPlaceholder('throw new Error("not implemented");\n');
  assert.ok(violations.some((v) => v.pattern === "not-implemented"));
});

test("fail-closed: detects a stub/placeholder — always-true assertion", () => {
  const violations = detectStubOrPlaceholder("assert(true);\n");
  assert.ok(violations.some((v) => v.pattern === "always-true-assertion"));
});

test("fail-closed: detects a stub/placeholder — literal PLACEHOLDER marker", () => {
  const violations = detectStubOrPlaceholder('const value = "PLACEHOLDER";\n');
  assert.ok(violations.some((v) => v.pattern === "placeholder-marker"));
});

test("fail-closed: detects a skipped test — it.skip", () => {
  const violations = detectSkippedTest('it.skip("some case", () => {});\n');
  assert.ok(violations.some((v) => v.pattern === "js-skip"));
});

test("fail-closed: detects a skipped test — xdescribe", () => {
  const violations = detectSkippedTest('xdescribe("suite", () => {});\n');
  assert.ok(violations.some((v) => v.pattern === "js-x-prefixed-skip"));
});

test("fail-closed: detects a skipped test — it.todo", () => {
  const violations = detectSkippedTest('it.todo("write this later");\n');
  assert.ok(violations.some((v) => v.pattern === "js-todo-test"));
});

test("fail-closed: detects a skipped test — pytest.mark.skip", () => {
  const violations = detectSkippedTest("@pytest.mark.skip\ndef test_x(): pass\n");
  assert.ok(violations.some((v) => v.pattern === "pytest-skip"));
});

test("fail-closed: detects a skipped test — JUnit @Disabled", () => {
  const violations = detectSkippedTest("@Disabled\nvoid testX() {}\n");
  assert.ok(violations.some((v) => v.pattern === "junit-disabled"));
});

test("scanGeneratedSource reports the offending line number", () => {
  const source = 'line one\nline two\nawait page.waitForTimeout(1000);\nline four\n';
  const result = scanGeneratedSource(source);
  const violation = result.violations.find((v) => v.pattern === "playwright-fixed-timeout");
  assert.ok(violation);
  assert.equal(violation.line, 3);
});

test("scanGeneratedFiles reports violations keyed by file path, and is clean when every file is clean", () => {
  const clean = scanGeneratedFiles([{ path: "a.spec.ts", content: CLEAN_SOURCE }]);
  assert.equal(clean.clean, true);

  const dirty = scanGeneratedFiles([
    { path: "a.spec.ts", content: CLEAN_SOURCE },
    { path: "b.spec.ts", content: "it.skip('x', () => {});\n" },
  ]);
  assert.equal(dirty.clean, false);
  assert.ok(dirty.violationsByFile["b.spec.ts"]);
  assert.equal(dirty.violationsByFile["a.spec.ts"], undefined);
});
