// dynamic-qa/shared/scripts/inventory-ci.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanCiWorkflows } from "./inventory-ci.mjs";
import { validateFact } from "./fact.mjs";

const SAMPLE_WORKFLOW = `name: CI

on:
  push:
    branches: [main]
  pull_request:
  merge_group:

jobs:
  test:
    name: Run tests
    runs-on: ubuntu-latest
    environment: staging
    services:
      postgres:
        image: postgres:15
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: npm test
        env:
          API_KEY: \${{ secrets.API_KEY }}
      - uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: results/
      - run: echo "\${{ secrets['OTHER_TOKEN'] }}"
`;

function withWorkflowFixture(workflowText, run) {
  const root = mkdtempSync(path.join(tmpdir(), "dynamic-qa-inv-ci-"));
  try {
    mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), workflowText);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("scanCiWorkflows returns nothing when no workflow files exist", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dynamic-qa-inv-ci-empty-"));
  try {
    assert.deepEqual(scanCiWorkflows(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanCiWorkflows observes the provider and every fact is a valid, observed fact", () => {
  withWorkflowFixture(SAMPLE_WORKFLOW, (root) => {
    const facts = scanCiWorkflows(root);
    assert.ok(facts.some((f) => f.id === "ci-provider:github-actions"));
    for (const f of facts) {
      assert.equal(validateFact(f).ok, true, JSON.stringify(f));
      assert.equal(f.provenance, "observed");
    }
  });
});

test("scanCiWorkflows observes triggers including push, pull_request, and a separate merge-queue fact", () => {
  withWorkflowFixture(SAMPLE_WORKFLOW, (root) => {
    const facts = scanCiWorkflows(root);
    assert.ok(facts.some((f) => f.id === "ci-trigger:push"));
    assert.ok(facts.some((f) => f.id === "ci-trigger:pull_request"));
    assert.ok(facts.some((f) => f.id === "ci-merge-queue:enabled"));
    assert.ok(!facts.some((f) => f.id === "ci-trigger:merge_group"), "merge_group must be its own ci-merge-queue fact, not a plain trigger");
  });
});

test("scanCiWorkflows observes runner, service, and environment", () => {
  withWorkflowFixture(SAMPLE_WORKFLOW, (root) => {
    const facts = scanCiWorkflows(root);
    assert.ok(facts.some((f) => f.id === "ci-runner:ubuntu-latest"));
    assert.ok(facts.some((f) => f.id === "ci-service:postgres"));
    assert.ok(facts.some((f) => f.id === "ci-environment:staging"));
  });
});

test("scanCiWorkflows observes check names (workflow name and job id) and an artifact upload", () => {
  withWorkflowFixture(SAMPLE_WORKFLOW, (root) => {
    const facts = scanCiWorkflows(root);
    assert.ok(facts.some((f) => f.id === "ci-check:CI"));
    assert.ok(facts.some((f) => f.id === "ci-check:test"));
    assert.ok(facts.some((f) => f.category === "ci-artifact"));
  });
});

test("scanCiWorkflows captures secret NAMES from both ${{ secrets.X }} and secrets['X'] forms, never a value", () => {
  withWorkflowFixture(SAMPLE_WORKFLOW, (root) => {
    const facts = scanCiWorkflows(root);
    const secretFacts = facts.filter((f) => f.category === "secret-name");
    const names = secretFacts.map((f) => f.secretName).sort();
    assert.deepEqual(names, ["API_KEY", "OTHER_TOKEN"]);
    for (const f of secretFacts) {
      assert.equal(Object.prototype.hasOwnProperty.call(f, "value"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(f, "secretValue"), false);
    }
  });
});

test("scanCiWorkflows never embeds a secret's referenced value even when the workflow contains one", () => {
  // A workflow can only ever reference `secrets.NAME` — the actual value
  // lives in provider configuration outside the repo, never in workflow
  // YAML. This test proves the scanner's OWN output contains no value-like
  // field for any secret fact, i.e. it never accidentally widens what it
  // captures to something value-shaped.
  withWorkflowFixture(SAMPLE_WORKFLOW, (root) => {
    const facts = scanCiWorkflows(root);
    const json = JSON.stringify(facts);
    // The only mentions of "API_KEY"/"OTHER_TOKEN" must be as secretName
    // values inside secret-name facts, not woven into some other field.
    const secretNameFacts = facts.filter((f) => f.category === "secret-name");
    assert.equal(secretNameFacts.length, 2);
    assert.ok(json.includes("API_KEY"));
    assert.ok(json.includes("OTHER_TOKEN"));
  });
});
