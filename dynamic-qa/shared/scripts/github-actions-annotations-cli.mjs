#!/usr/bin/env node
// dynamic-qa/shared/scripts/github-actions-annotations-cli.mjs
//
// Native GitHub Actions annotations (#153) from a JUnit report, with no
// third-party action: GitHub Actions turns a workflow-command line printed
// to stdout (`::error file=...,line=1::message`) into a native Problem
// Matcher-free annotation on the PR — the deterministic core already knows
// how to read the JUnit file (junit-report.mjs), so an extra action
// dependency (with its own un-resolvable-offline commit SHA to pin) buys
// nothing an in-repo script does not already do more simply and with zero
// added supply chain.
//
//   node dynamic-qa/shared/scripts/github-actions-annotations-cli.mjs <junit-path>
//
// Prints one `::error file=<junit-path>::` line per failed/errored test case
// (the JUnit format this reads rarely carries a real source file/line for a
// deterministic Binding failure, so the annotation names the test and the
// JUnit file rather than guessing a source location) and exits 0 regardless
// of test outcome — this step never itself fails the job; the test-run step
// already reported the real exit code. No network, no model, no dependency.

import { readFileSync, existsSync } from "node:fs";
import { parseJUnitXML } from "./junit-report.mjs";

// GitHub's workflow-command escaping rules (both the message body and each
// property value): "%" MUST be escaped first, before anything else — any
// later-inserted "%XX" escape sequence (from escaping "\n" to "%0A", say)
// would itself get mangled into "%250A" if "%" were escaped afterward.
// https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#about-workflow-commands
export function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

// Property values (e.g. `title=`, `file=`) additionally escape "," and ":",
// which the property-list syntax itself uses as separators — otherwise a
// comma or colon inside a JUnit test name breaks the property list, or lets
// a crafted test name inject an extra property.
export function escapeProperty(value) {
  return escapeData(value).replace(/,/g, "%2C").replace(/:/g, "%3A");
}

function main() {
  const junitPath = process.argv[2];
  if (!junitPath) {
    console.error("github-actions-annotations-cli.mjs: usage: node github-actions-annotations-cli.mjs <junit-path>");
    process.exit(64);
  }
  if (!existsSync(junitPath)) {
    console.log(`::warning::no JUnit report found at ${junitPath} — nothing to annotate`);
    return;
  }

  const parsed = parseJUnitXML(readFileSync(junitPath, "utf8"));
  for (const t of parsed.tests) {
    if (t.status === "failed" || t.status === "error") {
      const title = `${t.classname ? `${t.classname} > ` : ""}${t.name}`;
      const message = escapeData(t.message ?? "failed");
      console.log(`::error file=${escapeProperty(junitPath)},title=${escapeProperty(title)}::${message}`);
    }
  }
}

function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) main();
