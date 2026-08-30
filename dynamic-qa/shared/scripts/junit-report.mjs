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

// Replaces the INNER content of every non-content region — a CDATA section,
// an XML comment, a processing instruction, or a DOCTYPE declaration's body
// — with same-length placeholder characters (never "<", ">", or '"' — a
// plain letter is neutral to every regex below), leaving each region's own
// delimiters and everything else untouched. Every replacement is exactly as
// long as what it replaces, so an offset measured in the masked text is
// always the same offset in the real, original text.
//
// Why this exists (CodeRabbit re-review findings on PR #177,
// junit-report.mjs:78 and :121 — the same bug class, found twice): a JUnit
// reporter routinely echoes captured test stdout/stderr into
// <system-out>/<system-err> CDATA blocks, and a hand-authored or
// reporter-emitted report can carry XML comments too. Neither is trusted,
// structural content — a test can print (or a comment can contain) literal
// text that happens to read like "</testcase>", "<failure ...>", or
// "<skipped/>". Before the first fix, every tag-boundary regex (caseRe,
// failureMatch, errorMatch, skippedMatch) ran directly against the raw XML
// text, so a fake boundary living inside CDATA truncated a real testcase's
// body before its real <failure> — recording an actually-failing test as
// "passed". The first fix masked only CDATA. The second re-review finding
// showed the identical bug still open for `<!-- </testcase> --> `-shaped
// XML comments: caseRe stopped at the comment text just the same way it
// once stopped at CDATA text, with the same false-negative consequence —
// the most dangerous direction for this module to be wrong in, since
// emitReporting can then publish a passing result for a failed run.
//
// Rather than patch a third variant later, this masks every non-content
// region up front — CDATA, comments, processing instructions, and DOCTYPE —
// before ANY boundary regex runs. Actual message content extraction
// (extractAttr, stripCData) always reads from the ORIGINAL, unmasked text
// via the offsets the masked-text match reported, so genuine CDATA content
// in a failure/error message is preserved exactly; only comment/PI/DOCTYPE
// bodies are ever masked, and nothing in those regions is ever surfaced as
// message content in the first place.
function maskNonContentRegions(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (whole, inner) => `<![CDATA[${"x".repeat(inner.length)}]]>`)
    .replace(/<!--([\s\S]*?)-->/g, (whole, inner) => `<!--${"x".repeat(inner.length)}-->`)
    .replace(/<\?([\s\S]*?)\?>/g, (whole, inner) => `<?${"x".repeat(inner.length)}?>`)
    // A DOCTYPE with an internal subset (`<!DOCTYPE x [ ... ]>`) can itself
    // contain a raw '>' (e.g. inside an <!ENTITY ...> declaration) before
    // its own closing '>' — but any <!ENTITY declaration anywhere in the
    // document already makes parseJUnitXML throw before this function ever
    // runs (see the ENTITY check below), so a non-greedy match up to the
    // first '>' is always correct for every DOCTYPE this function actually
    // has to mask.
    .replace(/<!DOCTYPE([\s\S]*?)>/gi, (whole, inner) => `<!DOCTYPE${"x".repeat(inner.length)}>`);
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

  // Masked once up front and reused everywhere below: a CDATA block, XML
  // comment, processing instruction, or DOCTYPE body containing text shaped
  // like a real tag (e.g. a stray `<testsuite name="...">` inside a
  // comment) must never be mistaken for the real one, for the suite-name
  // lookup any more than for testcase boundaries.
  const maskedXmlText = maskNonContentRegions(xmlText);

  const suiteMatch = /<testsuite\b(?:[^">]|"[^"]*")*?name="([^"]*)"/i.exec(maskedXmlText);
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
  // "d" (hasIndices): boundary-matching runs against the masked text (see
  // maskNonContentRegions above) so a "</testcase>"-shaped literal inside
  // captured test output, an XML comment, a processing instruction, or a
  // DOCTYPE body can never be mistaken for a real closing tag, but every
  // substring actually used below is sliced from the real, unmasked
  // xmlText using the match's own group indices — masking never changes a
  // match's length or position, only whether the engine can be fooled by
  // embedded text into stopping early.
  const caseRe = new RegExp(`<testcase\\b(${ATTRS})(\\/>|>([\\s\\S]*?)<\\/testcase>)`, "gid");
  let m;
  while ((m = caseRe.exec(maskedXmlText)) !== null) {
    const attrsRange = m.indices[1];
    const bodyRange = m.indices[3];
    const attrs = attrsRange ? xmlText.slice(attrsRange[0], attrsRange[1]) : "";
    const body = bodyRange ? xmlText.slice(bodyRange[0], bodyRange[1]) : "";
    const maskedBody = maskNonContentRegions(body);
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
