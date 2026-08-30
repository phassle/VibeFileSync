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

// Replaces every CDATA section's INNER content with same-length placeholder
// characters (never "<", ">", or '"' — a plain letter is neutral to every
// regex below), leaving the "<![CDATA[" / "]]>" delimiters and everything
// else untouched. The replacement is always the same length as what it
// replaces, so an offset measured in the masked text is always the same
// offset in the real, original text.
//
// Why this exists (CodeRabbit re-review finding on PR #177,
// junit-report.mjs:78): a JUnit reporter routinely echoes captured test
// stdout/stderr into <system-out>/<system-err> CDATA blocks, and that
// captured output is not trusted content — it can contain literal text a
// test printed, including text that happens to read like
// "</testcase>", "<failure ...>", or "<skipped/>". Before this fix, every
// tag-boundary regex (caseRe, failureMatch, errorMatch, skippedMatch) ran
// directly against the raw XML text, so a real failing test whose captured
// output happened to contain the literal string "</testcase>" BEFORE its
// real <failure> element got its body truncated at that fake boundary —
// the real <failure> element then fell outside the (wrongly shortened)
// body, and the test was silently recorded as "passed". That is a false
// negative in exactly the report a promotion/CI gate relies on to know
// whether the run actually passed — the most dangerous direction for this
// module to be wrong in.
//
// Masking CDATA content before boundary-matching closes this: the fake
// "</testcase>" text living inside a CDATA section is masked out (replaced
// with neutral placeholder characters) before any boundary regex ever sees
// it, so it can never be mistaken for a real closing tag. Actual message
// content extraction (extractAttr, stripCData) always reads from the
// ORIGINAL, unmasked text via the offsets the masked-text match reported,
// so genuine CDATA content in a failure/error message is preserved exactly.
function maskCDataForBoundaryMatching(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (whole, inner) => `<![CDATA[${"x".repeat(inner.length)}]]>`);
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
  // "d" (hasIndices): boundary-matching runs against the CDATA-masked text
  // (see maskCDataForBoundaryMatching above) so a "</testcase>"-shaped
  // literal inside captured test output can never be mistaken for a real
  // closing tag, but every substring actually used below is sliced from the
  // real, unmasked xmlText using the match's own group indices — masking
  // never changes a match's length or position, only whether the engine can
  // be fooled by CDATA-embedded text into stopping early.
  const caseRe = new RegExp(`<testcase\\b(${ATTRS})(\\/>|>([\\s\\S]*?)<\\/testcase>)`, "gid");
  const maskedXmlText = maskCDataForBoundaryMatching(xmlText);
  let m;
  while ((m = caseRe.exec(maskedXmlText)) !== null) {
    const attrsRange = m.indices[1];
    const bodyRange = m.indices[3];
    const attrs = attrsRange ? xmlText.slice(attrsRange[0], attrsRange[1]) : "";
    const body = bodyRange ? xmlText.slice(bodyRange[0], bodyRange[1]) : "";
    const maskedBody = maskCDataForBoundaryMatching(body);
    const name = extractAttr(attrs, "name") ?? "";
    const classname = extractAttr(attrs, "classname") ?? "";
    const time = extractAttr(attrs, "time");

    let status = "passed";
    let message;
    const failureMatch = new RegExp(`<failure\\b(${ATTRS})(?:\\/>|>([\\s\\S]*?)<\\/failure>)`, "id").exec(maskedBody);
    const errorMatch = new RegExp(`<error\\b(${ATTRS})(?:\\/>|>([\\s\\S]*?)<\\/error>)`, "id").exec(maskedBody);
    const skippedMatch = /<skipped\b/i.test(maskedBody);

    if (failureMatch) {
      status = "failed";
      const attrsR = failureMatch.indices[1];
      const bodyR = failureMatch.indices[2];
      const failureAttrs = attrsR ? body.slice(attrsR[0], attrsR[1]) : "";
      const failureBody = bodyR ? body.slice(bodyR[0], bodyR[1]) : "";
      message = extractAttr(failureAttrs, "message") ?? decodeEntities(stripCData(failureBody).trim());
    } else if (errorMatch) {
      status = "error";
      const attrsR = errorMatch.indices[1];
      const bodyR = errorMatch.indices[2];
      const errorAttrs = attrsR ? body.slice(attrsR[0], attrsR[1]) : "";
      const errorBody = bodyR ? body.slice(bodyR[0], bodyR[1]) : "";
      message = extractAttr(errorAttrs, "message") ?? decodeEntities(stripCData(errorBody).trim());
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
