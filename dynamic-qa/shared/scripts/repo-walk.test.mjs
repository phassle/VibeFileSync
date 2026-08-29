// dynamic-qa/shared/scripts/repo-walk.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { walkFiles, readTextFile, fileExists, statOf } from "./repo-walk.mjs";

function makeFixtureRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "dynamic-qa-repo-walk-"));
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(path.join(root, "node_modules", "some-dep"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "some-dep", "index.js"), "module.exports = {};\n");
  writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "app.test.js"), "test('x', () => {});\n");
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "on: [push]\n");
  return root;
}

test("walkFiles finds real files and skips .git/node_modules", () => {
  const root = makeFixtureRepo();
  try {
    const files = walkFiles(root);
    assert.ok(files.includes("package.json"));
    assert.ok(files.includes("src/app.test.js"));
    assert.ok(files.includes(".github/workflows/ci.yml"));
    assert.ok(!files.some((f) => f.startsWith(".git/")), "must not descend into .git");
    assert.ok(!files.some((f) => f.startsWith("node_modules/")), "must not descend into node_modules");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkFiles returns a stable sorted order", () => {
  const root = makeFixtureRepo();
  try {
    const a = walkFiles(root);
    const b = walkFiles(root);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [...a].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readTextFile reads existing content and returns null for a missing file", () => {
  const root = makeFixtureRepo();
  try {
    assert.equal(readTextFile(root, "package.json"), '{"name":"fixture"}\n');
    assert.equal(readTextFile(root, "does/not/exist.txt"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fileExists and statOf are read-only probes", () => {
  const root = makeFixtureRepo();
  try {
    assert.equal(fileExists(root, "package.json"), true);
    assert.equal(fileExists(root, "nope.txt"), false);
    assert.ok(statOf(root, "package.json"));
    assert.equal(statOf(root, "nope.txt"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- The read-only guarantee itself --------------------------------------

test("repo-walk.mjs source never imports a mutating node:fs function", () => {
  const here = fileURLToPath(new URL("./repo-walk.mjs", import.meta.url));
  const source = readFileSync(here, "utf8");
  const forbidden = [
    "writeFileSync",
    "writeFile(",
    "appendFileSync",
    "appendFile(",
    "mkdirSync",
    "mkdir(",
    "rmSync",
    "rm(",
    "unlinkSync",
    "unlink(",
    "rmdirSync",
    "rmdir(",
    "renameSync",
    "rename(",
    "chmodSync",
    "chmod(",
    "createWriteStream",
    "copyFileSync",
    "copyFile(",
    "symlinkSync",
  ];
  for (const token of forbidden) {
    assert.ok(!source.includes(token), `repo-walk.mjs must never reference ${token}`);
  }
});

test("walkFiles and readTextFile perform zero writes even when every mutating fs export is wired to throw", () => {
  // Belt-and-suspenders alongside the static source check above: monkeypatch
  // every mutating node:fs function this process can see to throw, then run
  // a real scan against a real fixture and confirm it still succeeds. If the
  // scan ever called one of these, the test would fail with that function's
  // own thrown error rather than a passing walk.
  const mutators = [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "mkdir",
    "mkdirSync",
    "rm",
    "rmSync",
    "unlink",
    "unlinkSync",
    "rmdir",
    "rmdirSync",
    "rename",
    "renameSync",
    "chmod",
    "chmodSync",
    "copyFile",
    "copyFileSync",
    "symlink",
    "symlinkSync",
    "truncate",
    "truncateSync",
  ];
  const originals = new Map();
  for (const name of mutators) {
    if (typeof fs[name] === "function") {
      originals.set(name, fs[name]);
      fs[name] = () => {
        throw new Error(`repo-walk must never call fs.${name}`);
      };
    }
  }
  const root = makeFixtureRepo();
  try {
    const files = walkFiles(root);
    assert.ok(files.length > 0);
    assert.equal(readTextFile(root, "package.json"), '{"name":"fixture"}\n');
  } finally {
    for (const [name, fn] of originals) fs[name] = fn;
    rmSync(root, { recursive: true, force: true });
  }
});
