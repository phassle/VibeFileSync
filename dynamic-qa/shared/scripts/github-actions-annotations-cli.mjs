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
      const message = (t.message ?? "failed").replace(/\n/g, "%0A").replace(/%/g, "%25").replace(/\r/g, "%0D");
      console.log(`::error file=${junitPath},title=${title}::${message}`);
    }
  }
}

function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) main();
