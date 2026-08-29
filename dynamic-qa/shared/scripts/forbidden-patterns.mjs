// dynamic-qa/shared/scripts/forbidden-patterns.mjs
//
// Deterministic scan for the patterns generation must never emit
// (DESIGN-dynamic-qa-spec.md §10, SPEC-135.md user story 36, tickets/146.md:
// "Generation never writes placeholders, skipped/fixme tests, or knowingly
// non-executable code — emitting a stub instead of a real test must be
// impossible, not merely discouraged"). This is exact, line-oriented text
// scanning over generated source — plain computation, not agentic judgment
// — so it belongs in the deterministic core and runs against every
// candidate Binding before it can be accepted, regardless of which model or
// harness wrote it.
//
// Three independently testable pattern families, each with its own
// detector so a Tier 1 test can prove each is caught on its own:
//
//   - `detectFixedSleep`     — a fixed sleep/timeout instead of a bounded
//                              readiness signal. Exact API-name matching
//                              across the frameworks the bundle's harness
//                              adapters target (spec §10's "no
//                              `networkidle`, no fixed sleeps" reference
//                              contract), not a guess about intent.
//   - `detectStubOrPlaceholder` — TODO/FIXME/"not implemented"/placeholder
//                              markers, and an assertion that can never
//                              fail (e.g. `assert(true)`), i.e. code that
//                              looks executable but knowingly proves
//                              nothing.
//   - `detectSkippedTest`    — a skip/pending/todo/disabled test marker
//                              across the same framework families. A
//                              skipped test is not a smaller proof
//                              obligation, it is zero proof, so it is
//                              forbidden outright rather than merely
//                              flagged.
//
// `scanGeneratedSource` composes all three into one `{ clean, violations }`
// result; `qa-generate` calls this (via binding-verification.mjs) on every
// file a candidate Binding writes and refuses to proceed on any violation.

const FIXED_SLEEP_PATTERNS = [
  { name: "python-time.sleep", re: /\btime\.sleep\s*\(/ },
  { name: "generic-sleep-call", re: /(?<![.\w])sleep\s*\(\s*\d/ },
  { name: "shell-sleep", re: /^\s*sleep\s+\d/m },
  { name: "java-thread-sleep", re: /\bThread\.sleep\s*\(/ },
  { name: "playwright-fixed-timeout", re: /\bwaitForTimeout\s*\(/ },
  { name: "cypress-numeric-wait", re: /\bcy\.wait\s*\(\s*\d/ },
  { name: "js-settimeout-as-sleep", re: /setTimeout\s*\(\s*(?:resolve|done|cb|callback)\s*,\s*\d+\s*\)/ },
  { name: "playwright-networkidle", re: /networkidle/ },
];

const STUB_OR_PLACEHOLDER_PATTERNS = [
  { name: "todo-marker", re: /\bTODO\b/ },
  { name: "fixme-marker", re: /\bFIXME\b/ },
  { name: "not-implemented", re: /not[ _-]?implemented/i },
  { name: "placeholder-marker", re: /\bPLACEHOLDER\b/i },
  { name: "not-implemented-error", re: /\bNotImplementedError\b/ },
  { name: "always-true-assertion", re: /\bassert(?:\.ok)?\s*\(\s*true\s*\)/ },
  { name: "insert-marker", re: /<\s*INSERT/i },
];

const SKIPPED_TEST_PATTERNS = [
  { name: "js-skip", re: /\b(?:it|test|describe)\.skip\s*\(/ },
  { name: "js-x-prefixed-skip", re: /\bx(?:it|describe)\s*\(/ },
  { name: "js-todo-test", re: /\b(?:it|test)\.todo\s*\(/ },
  { name: "pytest-skip", re: /@pytest\.mark\.skip/ },
  { name: "junit-disabled", re: /@Disabled\b/ },
  { name: "junit-ignore", re: /@Ignore\b/ },
  { name: "python-unittest-skip", re: /\bunittest\.skip\b/ },
  { name: "rspec-pending", re: /\bpending\s*\(/ },
];

function scanWithPatterns(sourceText, patterns, category) {
  const violations = [];
  const lines = sourceText.split(/\r?\n/);
  for (const { name, re } of patterns) {
    // Test the whole text first (some patterns are multi-line or anchor to
    // line start with the `m` flag); then locate the offending line(s) for
    // a useful excerpt.
    const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let match;
    let found = false;
    while ((match = globalRe.exec(sourceText)) !== null) {
      found = true;
      const upToMatch = sourceText.slice(0, match.index);
      const lineNumber = upToMatch.split(/\r?\n/).length;
      violations.push({
        category,
        pattern: name,
        line: lineNumber,
        excerpt: (lines[lineNumber - 1] ?? "").trim(),
      });
      if (globalRe.lastIndex === match.index) globalRe.lastIndex += 1; // guard zero-width matches
    }
    void found;
  }
  return violations;
}

export function detectFixedSleep(sourceText) {
  return scanWithPatterns(sourceText, FIXED_SLEEP_PATTERNS, "fixed-sleep");
}

export function detectStubOrPlaceholder(sourceText) {
  return scanWithPatterns(sourceText, STUB_OR_PLACEHOLDER_PATTERNS, "stub-or-placeholder");
}

export function detectSkippedTest(sourceText) {
  return scanWithPatterns(sourceText, SKIPPED_TEST_PATTERNS, "skipped-test");
}

/**
 * Runs every detector over one generated file's source text. Returns
 * `{ clean, violations }`; `violations` is empty exactly when `clean` is
 * true. Never throws — an unreadable/binary file is the caller's concern
 * (this module only ever receives text it is handed).
 */
export function scanGeneratedSource(sourceText) {
  const violations = [
    ...detectFixedSleep(sourceText),
    ...detectStubOrPlaceholder(sourceText),
    ...detectSkippedTest(sourceText),
  ].sort((a, b) => a.line - b.line || a.pattern.localeCompare(b.pattern));
  return { clean: violations.length === 0, violations };
}

/**
 * Scans every file a candidate Binding writes. `files` is
 * `[{ path, content }]`. Returns `{ clean, violationsByFile }`, where
 * `violationsByFile` maps each offending path to its own `scanGeneratedSource`
 * violations, so a review packet can name exactly which file and line is
 * disqualifying.
 */
export function scanGeneratedFiles(files) {
  const violationsByFile = {};
  for (const file of files ?? []) {
    const result = scanGeneratedSource(file.content);
    if (!result.clean) violationsByFile[file.path] = result.violations;
  }
  return { clean: Object.keys(violationsByFile).length === 0, violationsByFile };
}
