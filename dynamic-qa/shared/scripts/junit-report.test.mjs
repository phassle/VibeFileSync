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

// --- escaping: <, >, &, and quotes must round-trip in both attributes and
// text, and must never cause a testcase to be silently dropped from the
// parse (the finding: an unescaped `>` in an attribute value broke the
// tag-boundary regex and made the whole next testcase vanish). ------------

test("a testcase name containing an escaped '<' decodes correctly and does not truncate parsing", () => {
  const xml = `<testsuite name="s"><testcase classname="c" name="a &lt; b" time="0.1"/></testsuite>`;
  const parsed = parseJUnitXML(xml);
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.tests[0].name, "a < b");
});

test("a testcase name containing an escaped '&' decodes correctly", () => {
  const xml = `<testsuite name="s"><testcase classname="c" name="a &amp; b" time="0.1"/></testsuite>`;
  const parsed = parseJUnitXML(xml);
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.tests[0].name, "a & b");
});

test("a testcase name containing escaped quote entities decodes correctly", () => {
  const xml = `<testsuite name="s"><testcase classname="c" name="say &quot;hi&quot; and &apos;bye&apos;" time="0.1"/></testsuite>`;
  const parsed = parseJUnitXML(xml);
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.tests[0].name, `say "hi" and 'bye'`);
});

test("a raw, unescaped '>' inside an attribute value must not drop a subsequent testcase from the parse", () => {
  // XML only requires escaping '<', '&', and the enclosing quote character
  // within an attribute value — a literal '>' is legal there. The
  // tag-boundary regexes must be quote-aware so this never causes the
  // following self-closed <testcase/> to be swallowed into the current
  // one's body and lost.
  const xml =
    `<testsuite name="s">` +
    `<testcase classname="c" name="a > b" time="0.1"/>` +
    `<testcase classname="c" name="second case" time="0.2"/>` +
    `</testsuite>`;
  const parsed = parseJUnitXML(xml);
  assert.equal(parsed.tests.length, 2);
  assert.equal(parsed.tests[0].name, "a > b");
  assert.equal(parsed.tests[1].name, "second case");
});

test("a raw '>' inside a failure/error message attribute does not drop the enclosing testcase", () => {
  const xml =
    `<testsuite name="s">` +
    `<testcase classname="c" name="first" time="0.1">` +
    `<failure message="expected a > b"><![CDATA[trace]]></failure>` +
    `</testcase>` +
    `<testcase classname="c" name="second" time="0.2"/>` +
    `</testsuite>`;
  const parsed = parseJUnitXML(xml);
  assert.equal(parsed.tests.length, 2);
  assert.equal(parsed.tests[0].status, "failed");
  assert.equal(parsed.tests[0].message, "expected a > b");
  assert.equal(parsed.tests[1].name, "second");
});

test("a raw '>' inside the <testsuite> name attribute's preceding attributes does not defeat the name lookup", () => {
  const xml = `<testsuite tests="a > b" name="dynamic-qa"><testcase classname="c" name="only" time="0.1"/></testsuite>`;
  const parsed = parseJUnitXML(xml);
  assert.equal(parsed.testsuiteName, "dynamic-qa");
  assert.equal(parsed.tests.length, 1);
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

test("a literal '</testcase>'-shaped string inside a <system-out> CDATA block never truncates the real body — the real <failure> after it is still observed", () => {
  // CodeRabbit re-review finding on PR #177 (junit-report.mjs:78). A JUnit
  // reporter routinely echoes captured stdout/stderr into a CDATA block,
  // and that captured text is not trusted content: a test can print
  // anything, including a string that happens to read like a real XML
  // closing tag. Before the fix, caseRe's non-greedy "<\/testcase>" search
  // ran directly against the raw text and matched that literal string
  // INSIDE the CDATA block, truncating the body before the real <failure>
  // that follows — silently recording an actually-failing test as
  // "passed", the most dangerous direction this reader can be wrong in.
  const xml =
    `<testsuite name="s">` +
    `<testcase classname="c" name="a" time="0.1">` +
    `<system-out><![CDATA[some output that ends with </testcase> literally, not a real tag]]></system-out>` +
    `<failure message="the real failure"/>` +
    `</testcase>` +
    `<testcase classname="c" name="b" time="0.1"/>` +
    `</testsuite>`;
  const parsed = parseJUnitXML(xml);
  assert.equal(parsed.tests.length, 2, "the CDATA-embedded fake closing tag must not swallow the second testcase either");
  assert.equal(parsed.tests[0].name, "a");
  assert.equal(parsed.tests[0].status, "failed", "a fake '</testcase>' inside CDATA output must never hide the real <failure> that follows it");
  assert.equal(parsed.tests[0].message, "the real failure");
  assert.equal(parsed.tests[1].name, "b");
  assert.equal(parsed.tests[1].status, "passed");
});

test("a literal '</failure>'-shaped string inside a <failure> element's own CDATA message is preserved as content, not treated as the closing tag", () => {
  // Same class of hazard, one level down: the failure MESSAGE itself
  // (arbitrary test output) can contain text shaped like the failure
  // element's own closing tag. The masked-boundary match must still find
  // the real "</failure>", so the testcase parse does not run on past it
  // and swallow whatever follows.
  const xml =
    `<testsuite name="s">` +
    `<testcase classname="c" name="a" time="0.1">` +
    `<failure><![CDATA[trace ends with </failure> literally]]></failure>` +
    `</testcase>` +
    `<testcase classname="c" name="b" time="0.1"/>` +
    `</testsuite>`;
  const parsed = parseJUnitXML(xml);
  assert.equal(parsed.tests.length, 2, "the CDATA-embedded fake '</failure>' must not swallow the second testcase");
  assert.equal(parsed.tests[0].status, "failed");
  assert.equal(parsed.tests[0].message, "trace ends with </failure> literally");
  assert.equal(parsed.tests[1].name, "b");
});
