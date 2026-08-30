// dynamic-qa/shared/scripts/drift-gate-cli.test.mjs
//
// Tier 1 coverage for the filesystem-facing digest helpers in
// drift-gate-cli.mjs (readJSON, schemaDigestOf, digestPathList,
// resolveDataSetDigest, executionProfileDigest, and runDriftGate's own
// provenance.json read). Each helper feeds evaluateBindingDrift
// (drift-gate.mjs), which was found to silently pass an `undefined`
// digest through as "nothing to check" for several fields. This module's
// job is the other half of that fix: every helper here must turn a
// missing OR malformed file into an explicit `undefined` digest (never an
// uncaught crash, never a guessed value), so the gate always has a real
// input to fail closed on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readJSON,
  schemaDigestOf,
  digestPathList,
  resolveDataSetDigest,
  executionProfileDigest,
  runDriftGate,
} from "./drift-gate-cli.mjs";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "drift-gate-cli-test-"));
}

test("readJSON throws on malformed JSON rather than returning a guessed value", () => {
  const dir = tempDir();
  try {
    const p = path.join(dir, "broken.json");
    writeFileSync(p, "{ not: valid json ", "utf8");
    assert.throws(() => readJSON(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJSON throws when the file does not exist", () => {
  const dir = tempDir();
  try {
    assert.throws(() => readJSON(path.join(dir, "does-not-exist.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schemaDigestOf returns undefined (never throws, never guesses) for a missing schema file", () => {
  const dir = tempDir();
  try {
    assert.equal(schemaDigestOf(dir, "dynamic-qa-flow-v1.schema.json"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schemaDigestOf returns undefined (never throws, never guesses) for a malformed schema file", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "dynamic-qa-flow-v1.schema.json"), "{ this is not json", "utf8");
    assert.equal(schemaDigestOf(dir, "dynamic-qa-flow-v1.schema.json"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schemaDigestOf returns a stable digest for a well-formed schema file", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "dynamic-qa-flow-v1.schema.json"), JSON.stringify({ a: 1 }), "utf8");
    const digest = schemaDigestOf(dir, "dynamic-qa-flow-v1.schema.json");
    assert.equal(typeof digest, "string");
    assert.notEqual(digest, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digestPathList reports undefined for a missing path, never throws", () => {
  const repoRoot = tempDir();
  try {
    const result = digestPathList([{ path: "does-not-exist.txt" }], repoRoot);
    assert.deepEqual(result, [{ path: "does-not-exist.txt", digest: undefined }]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("digestPathList reports undefined (never throws) when the path is unreadable as a file (a directory)", () => {
  const repoRoot = tempDir();
  try {
    mkdirSync(path.join(repoRoot, "a-directory"));
    const result = digestPathList([{ path: "a-directory" }], repoRoot);
    assert.deepEqual(result, [{ path: "a-directory", digest: undefined }]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("digestPathList returns a real digest for an existing readable file", () => {
  const repoRoot = tempDir();
  try {
    writeFileSync(path.join(repoRoot, "package.json"), "{}", "utf8");
    const result = digestPathList([{ path: "package.json" }], repoRoot);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, "package.json");
    assert.notEqual(result[0].digest, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveDataSetDigest returns undefined digest for a missing data set file", () => {
  const dir = tempDir();
  try {
    const result = resolveDataSetDigest("no-such-data-set", dir);
    assert.deepEqual(result, { id: "no-such-data-set", digest: undefined });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDataSetDigest returns undefined digest (never throws) for a malformed data set file", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "broken.yaml"), "a: 1\na: 2\n", "utf8"); // duplicate key
    const result = resolveDataSetDigest("broken", dir);
    assert.deepEqual(result, { id: "broken", digest: undefined });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executionProfileDigest returns undefined for a missing profile id or file", () => {
  const dir = tempDir();
  try {
    assert.equal(executionProfileDigest(undefined, dir), undefined);
    assert.equal(executionProfileDigest("no-such-profile", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executionProfileDigest returns undefined (never throws) for a malformed profile file", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "broken.yaml"), "id: broken\nid: broken-again\n", "utf8"); // duplicate key
    assert.equal(executionProfileDigest("broken", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDriftGate fails closed with a named reason on a malformed qa/provenance.json rather than crashing", () => {
  const repoRoot = tempDir();
  try {
    mkdirSync(path.join(repoRoot, "qa"));
    writeFileSync(path.join(repoRoot, "qa", "provenance.json"), "{ not valid json", "utf8");
    const { ok, messages } = runDriftGate(repoRoot);
    assert.equal(ok, false);
    assert.ok(messages.some((m) => m.includes("provenance.json") && m.includes("could not be parsed")));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runDriftGate reports nothing-to-enforce for a repository with no qa/ directory", () => {
  const repoRoot = tempDir();
  try {
    const { ok, messages } = runDriftGate(repoRoot);
    assert.equal(ok, true);
    assert.ok(messages.some((m) => m.includes("no qa/ directory")));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
