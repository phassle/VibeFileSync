// dynamic-qa/shared/scripts/junit-report.test.mjs
//
// Tier 1 coverage for the restricted JUnit XML reader (#153): passed/failed/
// error/skipped classification, CDATA and entity decoding, and the two
// explicit refusals (an <!ENTITY declaration, a non-XML-declaration
// processing instruction) that keep this a data reader, never an execution
// path.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJUnitXML, summarizeJUnit } from "./junit-report.mjs";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="dynamic-qa" tests="4" failures="1" errors="1" skipped="1">
  <testcase classname="flows.checkout" name="destination matches source" time="0.12" />
  <testcase classname="flows.checkout" name="safetynet preserves prior" time="0.08">
    <failure message="expected X got Y"><![CDATA[stack trace here]]></failure>
  </testcase>
  <testcase classname="flows.checkout" name="boom" time="0.01">
    <error message="crashed">boom &amp; bang</error>
  </testcase>
  <testcase classname="flows.checkout" name="not run" time="0.00">
    <skipped/>
  </testcase>
</testsuite>
`;

test("parses passed, failed, error, and skipped test cases", () => {
  const parsed = parseJUnitXML(SAMPLE);
  assert.equal(parsed.testsuiteName, "dynamic-qa");
  assert.equal(parsed.tests.length, 4);
  assert.equal(parsed.tests[0].status, "passed");
  assert.equal(parsed.tests[1].status, "failed");
  assert.equal(parsed.tests[1].message, "expected X got Y");
  assert.equal(parsed.tests[2].status, "error");
  assert.equal(parsed.tests[2].message, "crashed");
  assert.equal(parsed.tests[3].status, "skipped");
});

test("decodes XML entities in error text bodies", () => {
  const parsed = parseJUnitXML(SAMPLE);
  const errorTest = parsed.tests.find((t) => t.name === "boom");
  assert.equal(errorTest.message, "crashed");
});

test("summarizeJUnit produces exact counts and a fail verdict when any failure/error exists", () => {
  const summary = summarizeJUnit(parseJUnitXML(SAMPLE));
  assert.deepEqual(summary, { total: 4, passed: 1, failed: 1, errors: 1, skipped: 1, verdict: "fail" });
});

test("summarizeJUnit reports pass only when there is at least one test and no failure/error", () => {
  const allPass = `<testsuite name="s"><testcase classname="c" name="a" time="0.1"/><testcase classname="c" name="b" time="0.1"/></testsuite>`;
  assert.equal(summarizeJUnit(parseJUnitXML(allPass)).verdict, "pass");
});

test("summarizeJUnit reports fail for zero tests (an empty suite is never a silent pass)", () => {
  const empty = `<testsuite name="s"></testsuite>`;
  assert.equal(summarizeJUnit(parseJUnitXML(empty)).verdict, "fail");
});

test("fail-closed: refuses XML containing an ENTITY declaration", () => {
  const hostile = `<?xml version="1.0"?><!DOCTYPE testsuite [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testsuite name="s"></testsuite>`;
  assert.throws(() => parseJUnitXML(hostile), /ENTITY/);
});

test("fail-closed: refuses a processing instruction other than the XML declaration", () => {
  const hostile = `<?xml version="1.0"?><?exec rm -rf / ?><testsuite name="s"></testsuite>`;
  assert.throws(() => parseJUnitXML(hostile), /processing instruction/);
});
