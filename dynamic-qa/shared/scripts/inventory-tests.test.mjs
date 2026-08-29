// dynamic-qa/shared/scripts/inventory-tests.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanTestFrameworks, scanExistingTests, scanTestSupportKeywords } from "./inventory-tests.mjs";
import { validateFact } from "./fact.mjs";

function withFixture(build, run) {
  const root = mkdtempSync(path.join(tmpdir(), "dynamic-qa-inv-tests-"));
  try {
    build(root);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("scanTestFrameworks observes jest from package.json devDependencies", () => {
  withFixture(
    (root) => {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { jest: "^29.0.0" } }));
    },
    (root) => {
      const facts = scanTestFrameworks(root);
      assert.equal(facts.length, 1);
      assert.equal(facts[0].id, "test-framework:jest");
      assert.equal(facts[0].provenance, "observed");
      for (const f of facts) assert.equal(validateFact(f).ok, true);
    }
  );
});

test("scanTestFrameworks observes cargo-test from Cargo.toml presence", () => {
  withFixture(
    (root) => {
      writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"fixture\"\n");
    },
    (root) => {
      const facts = scanTestFrameworks(root);
      assert.ok(facts.some((f) => f.id === "test-framework:cargo-test"));
    }
  );
});

test("scanTestFrameworks reports nothing when no marker is present (never asserts absence)", () => {
  withFixture(
    () => {},
    (root) => {
      assert.deepEqual(scanTestFrameworks(root), []);
    }
  );
});

test("scanExistingTests finds test-shaped files as observed facts", () => {
  withFixture(
    (root) => {
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src", "app.test.js"), "test('x', () => {});\n");
      writeFileSync(path.join(root, "src", "app.js"), "module.exports = {};\n");
    },
    (root) => {
      const facts = scanExistingTests(root);
      const testFacts = facts.filter((f) => f.category === "existing-test");
      assert.equal(testFacts.length, 1);
      assert.equal(testFacts[0].evidence, "src/app.test.js");
      assert.equal(testFacts[0].provenance, "observed");
    }
  );
});

test("scanExistingTests marks outcome unknown when no report artifact exists", () => {
  withFixture(
    () => {},
    (root) => {
      const facts = scanExistingTests(root);
      const outcome = facts.find((f) => f.category === "existing-test-outcome");
      assert.equal(outcome.provenance, "unknown");
    }
  );
});

test("scanExistingTests marks outcome reported (not observed) when a report artifact is found", () => {
  withFixture(
    (root) => {
      writeFileSync(path.join(root, "junit.xml"), "<testsuites></testsuites>\n");
    },
    (root) => {
      const facts = scanExistingTests(root);
      const outcome = facts.find((f) => f.category === "existing-test-outcome");
      assert.equal(outcome.provenance, "reported");
      assert.equal(outcome.evidence, "junit.xml");
    }
  );
});

test("scanTestSupportKeywords finds mock/clock/cleanup/fixture evidence with a named file", () => {
  withFixture(
    (root) => {
      mkdirSync(path.join(root, "src"));
      writeFileSync(
        path.join(root, "src", "app.test.js"),
        [
          "beforeEach(() => { setup(); });",
          "afterEach(() => { teardown(); });",
          "jest.mock('./db');",
          "jest.useFakeTimers();",
        ].join("\n")
      );
    },
    (root) => {
      const facts = scanTestSupportKeywords(root);
      assert.ok(facts.some((f) => f.category === "mock"));
      assert.ok(facts.some((f) => f.category === "clock"));
      assert.ok(facts.some((f) => f.category === "cleanup"));
      assert.ok(facts.some((f) => f.category === "fixture"));
      for (const f of facts) {
        assert.equal(f.provenance, "observed");
        assert.equal(f.evidence, "src/app.test.js");
        assert.equal(validateFact(f).ok, true);
      }
    }
  );
});

test("scanTestSupportKeywords never inlines full file content, only file evidence paths", () => {
  withFixture(
    (root) => {
      mkdirSync(path.join(root, "src"));
      writeFileSync(
        path.join(root, "src", "app.test.js"),
        "jest.mock('./db'); // SENTINEL_SHOULD_NOT_LEAK_INTO_FACT_JSON\n"
      );
    },
    (root) => {
      const facts = scanTestSupportKeywords(root);
      const json = JSON.stringify(facts);
      assert.ok(!json.includes("SENTINEL_SHOULD_NOT_LEAK_INTO_FACT_JSON"));
    }
  );
});
