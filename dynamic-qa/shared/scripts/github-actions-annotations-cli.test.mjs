// dynamic-qa/shared/scripts/github-actions-annotations-cli.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeData, escapeProperty } from "./github-actions-annotations-cli.mjs";

const CLI = fileURLToPath(new URL("./github-actions-annotations-cli.mjs", import.meta.url));

test("escapeData escapes '%' before inserting '%0A'/'%0D', so a literal newline never becomes '%250A'", () => {
  assert.equal(escapeData("line one\nline two"), "line one%0Aline two");
  assert.equal(escapeData("a%b"), "a%25b");
  assert.equal(escapeData("100%\ndone"), "100%25%0Adone");
});

test("escapeProperty additionally escapes ',' and ':' after the shared data escaping", () => {
  const value = 'name with %, : and\na newline';
  const escaped = escapeProperty(value);
  assert.equal(escaped, "name with %25%2C %3A and%0Aa newline");
  // Never contains a literal unescaped ',' or ':' that could start a new
  // workflow-command property.
  assert.doesNotMatch(escaped, /[,:]/);
});

function runCli(junitXml) {
  const dir = mkdtempSync(join(tmpdir(), "gha-annotations-test-"));
  const junitPath = join(dir, "junit.xml");
  writeFileSync(junitPath, junitXml, "utf8");
  try {
    const stdout = execFileSync(process.execPath, [CLI, junitPath], { encoding: "utf8" });
    return { stdout, junitPath };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a failure message containing a literal newline is escaped to a single-line '%0A', not raw", () => {
  const xml = `<testsuite name="s"><testcase name="t1" classname="c">
    <failure message="first line
second line"></failure>
  </testcase></testsuite>`;
  const { stdout } = runCli(xml);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, "the annotation must print as a single line, not be split by a raw newline");
  assert.match(lines[0], /first line%0Asecond line/);
});

test("a test name containing '%', ',', ':' and a newline is escaped in the title property", () => {
  const xml = `<testsuite name="s"><testcase name="weird % name, with: a
newline" classname="c">
    <failure message="boom"></failure>
  </testcase></testsuite>`;
  const { stdout, junitPath } = runCli(xml);
  const lines = stdout.trim().split("\n");
  // Exactly one line was printed (no raw newline broke it into two).
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line.startsWith("::error"), "expected an ::error annotation line");
  assert.match(line, /title=c > weird %25 name%2C with%3A a%0Anewline/);
  assert.ok(line.startsWith(`::error file=${junitPath.replace(/,/g, "%2C").replace(/:/g, "%3A")},title=`));
});

test("a crafted JUnit test name cannot inject an extra workflow-command property", () => {
  // If title/file were not escaped, a name containing ",line=999" would be
  // read by GitHub Actions as introducing an unrelated extra `line`
  // property rather than staying part of the `title` value.
  const hostileName = "innocuous,line=999,title=spoofed";
  const xml = `<testsuite name="s"><testcase name="${hostileName}" classname="c">
    <failure message="boom"></failure>
  </testcase></testsuite>`;
  const { stdout } = runCli(xml);
  const line = stdout.trim();
  // The only "line=" or extra "title=" substrings present are the escaped,
  // inert text inside the title value — not a second live property. Verify
  // by checking the raw commas from the hostile name are gone from the
  // property-list portion (before the final "::").
  const propertyList = line.slice(0, line.lastIndexOf("::"));
  const rawCommaCount = (propertyList.match(/,/g) ?? []).length;
  // Only the single legitimate separator between file= and title= remains.
  assert.equal(rawCommaCount, 1);
  assert.match(line, /title=c > innocuous%2Cline=999%2Ctitle=spoofed/);
});

test("no JUnit report present prints a warning and does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "gha-annotations-test-missing-"));
  const junitPath = join(dir, "does-not-exist.xml");
  try {
    const stdout = execFileSync(process.execPath, [CLI, junitPath], { encoding: "utf8" });
    assert.match(stdout, /::warning::no JUnit report found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
