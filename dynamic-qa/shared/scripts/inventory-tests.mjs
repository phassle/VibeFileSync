// dynamic-qa/shared/scripts/inventory-tests.mjs
//
// Setup Inventory stage 2 scanner: existing tests and the outcomes they
// already prove; frameworks; fixtures; mocks; clocks; cleanup; reporting.
// Read-only — built entirely on repo-walk.mjs's read-only primitives, never
// on node:fs directly, so it inherits that module's "cannot write" property.
//
// This scanner is deliberately conservative: it reports what it can support
// with a concrete piece of evidence (a file, a dependency entry, a matched
// keyword) and marks everything else "unknown" rather than guessing. Static
// scanning cannot know what an existing test actually proves without running
// it, so "existing-test-outcome" facts are marked "reported" (backed by a
// found report artifact) when one exists, and "unknown" otherwise — never a
// confident-looking guess.

import { walkFiles, readTextFile, fileExists } from "./repo-walk.mjs";
import { makeFact } from "./fact.mjs";

const TEST_FILE_PATTERN = /(^|\/)(__tests__\/|tests?\/|spec\/)|(\.test\.[jt]sx?$)|(\.spec\.[jt]sx?$)|(_test\.py$)|(^test_.*\.py$)|(\.rs$)/;

const FRAMEWORK_DEPENDENCY_MARKERS = [
  { name: "jest", deps: ["jest"] },
  { name: "vitest", deps: ["vitest"] },
  { name: "mocha", deps: ["mocha"] },
  { name: "playwright", deps: ["@playwright/test", "playwright"] },
  { name: "cypress", deps: ["cypress"] },
  { name: "pytest", deps: ["pytest"] },
];

const REPORT_ARTIFACT_NAMES = [
  "junit.xml",
  "coverage/coverage-summary.json",
  "coverage.xml",
  ".nyc_output/coverage-summary.json",
];

// Keyword evidence for fixtures/mocks/clocks/cleanup/reporting. Each entry's
// keyword is searched literally (no regex) inside test-shaped files only, so
// a hit is always backed by a concrete file + line.
const KEYWORD_EVIDENCE = [
  { category: "mock", keyword: "jest.mock(" },
  { category: "mock", keyword: "sinon.mock(" },
  { category: "mock", keyword: "unittest.mock" },
  { category: "clock", keyword: "jest.useFakeTimers" },
  { category: "clock", keyword: "sinon.useFakeTimers" },
  { category: "clock", keyword: "freezegun" },
  { category: "cleanup", keyword: "afterEach(" },
  { category: "cleanup", keyword: "afterAll(" },
  { category: "cleanup", keyword: "teardown" },
  { category: "fixture", keyword: "beforeEach(" },
  { category: "fixture", keyword: "@pytest.fixture" },
  { category: "reporting", keyword: "reporters:" },
  { category: "reporting", keyword: "--reporter" },
];

function isTestFile(relPath) {
  return TEST_FILE_PATTERN.test(relPath);
}

function parseDependencyNames(packageJsonText) {
  try {
    const pkg = JSON.parse(packageJsonText);
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ]);
  } catch {
    return new Set();
  }
}

// scanTestFrameworks(repoRoot) -> Fact[]
//
// Observed facts only: a framework is reported when a concrete marker (a
// dependency entry, or a well-known config/manifest file) is found. Absence
// of a marker is simply absence of a fact — this scanner never asserts a
// framework is NOT in use.
export function scanTestFrameworks(repoRoot) {
  const facts = [];
  const packageJsonText = readTextFile(repoRoot, "package.json");
  if (packageJsonText !== null) {
    const deps = parseDependencyNames(packageJsonText);
    for (const marker of FRAMEWORK_DEPENDENCY_MARKERS) {
      const hit = marker.deps.find((d) => deps.has(d));
      if (hit) {
        facts.push(
          makeFact({
            id: `test-framework:${marker.name}`,
            category: "test-framework",
            description: `${marker.name} found in package.json dependencies`,
            provenance: "observed",
            evidence: `package.json:${hit}`,
          })
        );
      }
    }
  }
  if (fileExists(repoRoot, "Cargo.toml")) {
    facts.push(
      makeFact({
        id: "test-framework:cargo-test",
        category: "test-framework",
        description: "Cargo.toml present — Rust's built-in cargo test harness applies",
        provenance: "observed",
        evidence: "Cargo.toml",
      })
    );
  }
  if (fileExists(repoRoot, "pytest.ini") || fileExists(repoRoot, "pyproject.toml")) {
    const evidence = fileExists(repoRoot, "pytest.ini") ? "pytest.ini" : "pyproject.toml";
    facts.push(
      makeFact({
        id: "test-framework:pytest-config",
        category: "test-framework",
        description: "a pytest configuration file is present",
        provenance: "observed",
        evidence,
      })
    );
  }
  return facts;
}

// scanExistingTests(repoRoot) -> Fact[]
//
// One "existing-test" fact per test-shaped file found (provenance: observed
// — the file itself was read). One "existing-test-outcome" fact summarizing
// whether a report artifact backs a claim about what these tests currently
// prove: "reported" when a known report artifact exists (naming it as
// evidence), "unknown" otherwise. This function never inspects test file
// bodies to infer pass/fail — that would be a claim this static scan cannot
// support.
export function scanExistingTests(repoRoot) {
  const facts = [];
  const files = walkFiles(repoRoot).filter(isTestFile);
  for (const relPath of files) {
    facts.push(
      makeFact({
        id: `existing-test:${relPath}`,
        category: "existing-test",
        description: "test-shaped file found by path/name convention",
        provenance: "observed",
        evidence: relPath,
      })
    );
  }

  const reportArtifact = REPORT_ARTIFACT_NAMES.find((name) => fileExists(repoRoot, name));
  facts.push(
    makeFact({
      id: "existing-test-outcome:summary",
      category: "existing-test-outcome",
      description:
        reportArtifact !== undefined
          ? `a test report artifact exists; its claims about what passes are reported, not independently observed by this scan`
          : "no test report artifact was found; what the existing tests currently prove is unknown until one is produced or the suite is run",
      provenance: reportArtifact !== undefined ? "reported" : "unknown",
      evidence: reportArtifact,
    })
  );

  return facts;
}

// scanTestSupportKeywords(repoRoot) -> Fact[]
//
// Fixtures, mocks, clocks, cleanup, reporting: keyword-evidence facts, each
// naming the file (never full file content) that contains the match, plus
// (for "reporting") a package.json/config-level scripts hit. Every fact is
// "observed" — the keyword was literally found in a named file.
export function scanTestSupportKeywords(repoRoot) {
  const facts = [];
  const seen = new Set();
  const files = walkFiles(repoRoot).filter(isTestFile);
  for (const relPath of files) {
    const text = readTextFile(repoRoot, relPath);
    if (text === null) continue;
    for (const { category, keyword } of KEYWORD_EVIDENCE) {
      if (!text.includes(keyword)) continue;
      const id = `${category}:${keyword}`;
      if (seen.has(id)) continue; // one fact per (category, keyword) is enough evidence; evidence names the first file
      seen.add(id);
      facts.push(
        makeFact({
          id,
          category,
          description: `'${keyword}' found in a test-shaped file`,
          provenance: "observed",
          evidence: relPath,
        })
      );
    }
  }
  return facts;
}
