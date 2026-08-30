// dynamic-qa/shared/scripts/junit-report.mjs
//
// A minimal, restricted-subset JUnit XML reader (#153) — not a general XML
// parser (per the run brief's deterministic-core decision: no third-party
// dependency, hand-written checks only for the narrow shape actually needed,
// exactly like restricted-yaml.mjs does for YAML). JUnit XML produced by any
// mainstream test reporter (`cargo test`'s own JUnit output, `vitest`,
// `mocha --reporter mocha-junit-reporter`, etc.) is a small, regular subset:
// a <testsuite>/<testsuites> root, <testcase> elements with name/classname/
// time attributes, and an optional single <failure>/<error> child holding a
// message and body. This module reads exactly that subset, tolerating
// attribute-order and whitespace variation, and produces a small structured
// summary — never executes anything, never evaluates an XML entity or
// processing instruction (both are explicitly rejected, since JUnit XML from
// a test run is machine-generated but still originates in the same low-trust
// PR run this whole adapter is designed to isolate).
//
// Used by github-actions-annotations-cli.mjs (native annotations) and
// github-actions-summary-cli.mjs (job summary) — both are thin CLI wrappers
// around parseJUnitXML/summarizeJUnit below, so the actual parsing logic has
// direct Tier 1 coverage independent of any real CI environment.

function stripCData(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractAttr(tag, name) {
  // Requires a preceding whitespace (or start of string) before the
  // attribute name, so e.g. "name=" never matches inside "classname=".
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? decodeEntities(m[1]) : undefined;
}

/**
 * Parses a restricted JUnit XML subset. Rejects (throws) an entity
 * declaration or a processing instruction other than the XML declaration —
 * this is a data format, not an executable one, and this parser refuses to
 * treat it as anything else. Returns `{ testsuiteName, tests: [{ name,
 * classname, time, status: "passed"|"failed"|"error"|"skipped", message }] }`.
 */
export function parseJUnitXML(xmlText) {
  if (/<!ENTITY/i.test(xmlText)) {
    throw new Error("parseJUnitXML: refuses XML containing an <!ENTITY declaration (not a supported, safe subset)");
  }
  if (/<\?(?!xml\b)/i.test(xmlText)) {
    throw new Error("parseJUnitXML: refuses XML containing a processing instruction other than the XML declaration");
  }

  const suiteMatch = /<testsuite\b(?:[^">]|"[^"]*")*?name="([^"]*)"/i.exec(xmlText);
  const testsuiteName = suiteMatch ? decodeEntities(suiteMatch[1]) : "";

  const tests = [];
  // Attribute lists are matched with a quote-aware pattern rather than
  // plain `[^>]*` — a well-formed attribute value MAY legally contain a
  // raw, unescaped `>` (XML only mandates escaping `<`, `&`, and the
  // enclosing quote character within an attribute value; `>` is optional
  // convention, not a requirement). `[^>]*` truncates at that `>` and the
  // whole testcase silently vanishes from the parse instead of erroring or
  // parsing correctly. `(?:[^">]|"[^"]*")*` instead treats a `"..."` run
  // atomically, so a `>` inside quotes never ends the attribute list.
  // Non-greedy: the shortest attribute-list match that still lets the
  // required "/>" or ">...</tag>" closer match immediately after it is the
  // correct one. A greedy version would happily let its unquoted-char
  // branch swallow the self-close tag's own "/" (which is not `"` or `>`,
  // so the character class alone can't exclude it), miss the "/>" closer
  // entirely, and misparse a self-closed <testcase .../> as an *opening*
  // tag whose body runs on to absorb the next real testcase's closing tag
  // — silently dropping a whole test result rather than erroring.
  const ATTRS = `(?:[^">]|"[^"]*")*?`;
  const caseRe = new RegExp(`<testcase\\b(${ATTRS})(\\/>|>([\\s\\S]*?)<\\/testcase>)`, "gi");
  let m;
  while ((m = caseRe.exec(xmlText)) !== null) {
    const attrs = m[1];
    const body = m[3] ?? "";
    const name = extractAttr(attrs, "name") ?? "";
    const classname = extractAttr(attrs, "classname") ?? "";
    const time = extractAttr(attrs, "time");

    let status = "passed";
    let message;
    const failureMatch = new RegExp(`<failure\\b(${ATTRS})(?:\\/>|>([\\s\\S]*?)<\\/failure>)`, "i").exec(body);
    const errorMatch = new RegExp(`<error\\b(${ATTRS})(?:\\/>|>([\\s\\S]*?)<\\/error>)`, "i").exec(body);
    const skippedMatch = /<skipped\b/i.test(body);

    if (failureMatch) {
      status = "failed";
      message = extractAttr(failureMatch[1], "message") ?? decodeEntities(stripCData(failureMatch[2] ?? "").trim());
    } else if (errorMatch) {
      status = "error";
      message = extractAttr(errorMatch[1], "message") ?? decodeEntities(stripCData(errorMatch[2] ?? "").trim());
    } else if (skippedMatch) {
      status = "skipped";
    }

    tests.push({ name, classname, time, status, message });
  }

  return { testsuiteName, tests };
}

/**
 * Reduces a parsed JUnit result to the small counts a job summary or a
 * Result Envelope binding entry needs: total/passed/failed/errors/skipped
 * and the overall verdict ("pass" only when there is at least one test and
 * no failed/errored test).
 */
export function summarizeJUnit(parsed) {
  const counts = { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const t of parsed.tests) {
    counts.total += 1;
    if (t.status === "passed") counts.passed += 1;
    else if (t.status === "failed") counts.failed += 1;
    else if (t.status === "error") counts.errors += 1;
    else if (t.status === "skipped") counts.skipped += 1;
  }
  const verdict = counts.total > 0 && counts.failed === 0 && counts.errors === 0 ? "pass" : "fail";
  return { ...counts, verdict };
}
