// dynamic-qa/shared/scripts/inventory.test.mjs
//
// Tier 1 coverage for the acceptance criteria that are genuine computation:
//   - every inventory fact carries observed/reported/unknown provenance
//   - discovery writes nothing (no repository file, provider policy,
//     infrastructure, or secret is modified)
//   - secret names are listed without any value being read or echoed
//   - existing tests are inventoried together with the outcomes they prove
//
// See dynamic-qa/acceptance/cases/... (Tier 2) for the corresponding
// behavioral proof that qa-setup's own discovery stage leaves a fixture
// repository byte-unchanged end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { buildSetupInventory, summarizeProvenance } from "./inventory.mjs";
import { validateInventory } from "./fact.mjs";

function makeRealisticFixtureRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "dynamic-qa-inventory-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { jest: "^29.0.0" } }));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src", "checkout.test.js"),
    ["beforeEach(() => { seed(); });", "afterEach(() => { cleanup(); });", "jest.mock('./payments');"].join("\n")
  );
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    [
      "name: CI",
      "on:",
      "  push:",
      "  pull_request:",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm test",
      "        env:",
      "          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "",
    ].join("\n")
  );
  return root;
}

test("buildSetupInventory returns a Setup Inventory that validates against fact.mjs's schema", () => {
  const root = makeRealisticFixtureRepo();
  try {
    const inventory = buildSetupInventory(root, { now: new Date("2026-08-29T00:00:00Z") });
    const { ok, errors } = validateInventory(inventory);
    assert.equal(ok, true, errors.join("; "));
    assert.equal(inventory.repoRoot, root);
    assert.equal(inventory.generatedAt, "2026-08-29T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every fact in the inventory carries observed, reported, or unknown provenance", () => {
  const root = makeRealisticFixtureRepo();
  try {
    const inventory = buildSetupInventory(root);
    assert.ok(inventory.facts.length > 0);
    for (const fact of inventory.facts) {
      assert.ok(["observed", "reported", "unknown"].includes(fact.provenance), `fact ${fact.id} has invalid provenance ${fact.provenance}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing tests are inventoried together with the outcome fact summarizing what they currently prove", () => {
  const root = makeRealisticFixtureRepo();
  try {
    const inventory = buildSetupInventory(root);
    assert.ok(inventory.facts.some((f) => f.category === "existing-test" && f.evidence === "src/checkout.test.js"));
    const outcome = inventory.facts.find((f) => f.category === "existing-test-outcome");
    assert.ok(outcome);
    assert.equal(outcome.provenance, "unknown"); // no report artifact in this fixture
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret names are listed without any value being read or echoed anywhere in the inventory", () => {
  const root = makeRealisticFixtureRepo();
  try {
    const inventory = buildSetupInventory(root);
    const secretFacts = inventory.facts.filter((f) => f.category === "secret-name");
    assert.equal(secretFacts.length, 1);
    assert.equal(secretFacts[0].secretName, "NPM_TOKEN");
    const json = JSON.stringify(inventory);
    assert.ok(!json.includes('"value"'), "no fact in the inventory may carry a value field on a secret");
    assert.ok(!json.includes("secretValue"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarizeProvenance counts every fact exactly once, split by provenance", () => {
  const root = makeRealisticFixtureRepo();
  try {
    const inventory = buildSetupInventory(root);
    const counts = summarizeProvenance(inventory);
    const total = counts.observed + counts.reported + counts.unknown;
    assert.equal(total, inventory.facts.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- The read-only acceptance criterion, proven at Tier 1 -----------------

test("buildSetupInventory performs ZERO filesystem writes against a real fixture repository", () => {
  const root = makeRealisticFixtureRepo();
  const before = readTreeSnapshot(root);
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
    "utimes",
    "utimesSync",
  ];
  const originals = new Map();
  for (const name of mutators) {
    if (typeof fs[name] === "function") {
      originals.set(name, fs[name]);
      fs[name] = () => {
        throw new Error(`buildSetupInventory (discovery) must never call fs.${name} — discovery is read-only`);
      };
    }
  }
  try {
    const inventory = buildSetupInventory(root);
    assert.ok(inventory.facts.length > 0, "sanity: the scan must still find real facts with writes wired to throw");
  } finally {
    for (const [name, fn] of originals) fs[name] = fn;
  }
  const after = readTreeSnapshot(root);
  assert.deepEqual(before, after, "the fixture repository must be byte-for-byte unchanged after discovery");
  rmSync(root, { recursive: true, force: true });
});

function readTreeSnapshot(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(entryRel);
      } else {
        const content = readFileSync(path.join(root, entryRel));
        out.push(`${entryRel}:${createHash("sha256").update(content).digest("hex")}`);
      }
    }
  }
  return out.sort();
}
