#!/usr/bin/env node
// dynamic-qa/shared/scripts/github-actions-summary-cli.mjs
//
// A concise GitHub Actions job summary (#153) from a JUnit report. GitHub
// Actions' job summary is native: any Markdown written to the file named by
// the $GITHUB_STEP_SUMMARY environment variable is rendered on the run
// page. No action is needed; the generated workflow simply redirects this
// script's stdout there (`>> "$GITHUB_STEP_SUMMARY"`).
//
//   node dynamic-qa/shared/scripts/github-actions-summary-cli.mjs <junit-path>
//
// Prints a short Markdown block: totals, verdict, and one line per failed/
// errored test — never the full JUnit body, keeping the summary genuinely
// concise rather than a second copy of the report.

import { readFileSync, existsSync } from "node:fs";
import { parseJUnitXML, summarizeJUnit } from "./junit-report.mjs";

function main() {
  const junitPath = process.argv[2];
  if (!junitPath) {
    console.error("github-actions-summary-cli.mjs: usage: node github-actions-summary-cli.mjs <junit-path>");
    process.exit(64);
  }
  if (!existsSync(junitPath)) {
    console.log(`### dynamic-qa advisory PR lane\n\nNo JUnit report found at \`${junitPath}\`.\n`);
    return;
  }

  const parsed = parseJUnitXML(readFileSync(junitPath, "utf8"));
  const summary = summarizeJUnit(parsed);

  const lines = [
    "### dynamic-qa advisory PR lane",
    "",
    `**Verdict:** ${summary.verdict === "pass" ? "✅ pass" : "❌ fail"} (advisory — does not gate the merge)`,
    "",
    `| total | passed | failed | errors | skipped |`,
    `|---|---|---|---|---|`,
    `| ${summary.total} | ${summary.passed} | ${summary.failed} | ${summary.errors} | ${summary.skipped} |`,
  ];

  const failing = parsed.tests.filter((t) => t.status === "failed" || t.status === "error");
  if (failing.length > 0) {
    lines.push("", "**Failing:**", "");
    for (const t of failing) {
      lines.push(`- ${t.classname ? `${t.classname} > ` : ""}${t.name}`);
    }
  }

  console.log(lines.join("\n"));
}

function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) main();
