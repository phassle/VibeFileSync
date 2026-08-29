// dynamic-qa/shared/scripts/github-actions-workflow.test.mjs
//
// Tier 1 coverage for the GitHub Actions advisory pull-request lane renderer
// and its hardening detector (#153). Proves: the happy-path render carries
// every required hardening property; each property is INDIVIDUALLY detected
// when violated (one mutation per test, one named code asserted); the
// advisory lane cannot fail the merge gate; the drift gate step precedes the
// test step; and the renderer never accepts a wildcard junitPath.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderAdvisoryPullRequestLane,
  checkWorkflowHardening,
  CHECKOUT_ACTION_REF,
  SETUP_NODE_ACTION_REF,
  SAFE_PR_TRIGGER,
  FORBIDDEN_PR_TRIGGER,
} from "./github-actions-workflow.mjs";

function baseConfig(overrides = {}) {
  return {
    runsOn: "ubuntu-latest",
    nodeVersion: "20",
    testCommand: "npm test -- --grep dynamic-qa-relevant",
    junitPath: "reports/junit/dynamic-qa.xml",
    ...overrides,
  };
}

test("renders a workflow with every required hardening property", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig());
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("uses SHA-pinned actions, never a floating tag", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig());
  assert.ok(yaml.includes(`uses: ${CHECKOUT_ACTION_REF}`));
  assert.ok(yaml.includes(`uses: ${SETUP_NODE_ACTION_REF}`));
  assert.match(CHECKOUT_ACTION_REF, /@[0-9a-f]{40}$/);
  assert.match(SETUP_NODE_ACTION_REF, /@[0-9a-f]{40}$/);
});

test("uses only the safe pull_request trigger, never pull_request_target", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig());
  assert.match(yaml, new RegExp(`^\\s*${SAFE_PR_TRIGGER}:`, "m"));
  assert.ok(!yaml.includes(FORBIDDEN_PR_TRIGGER));
});

test("the drift gate step precedes the test step", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig());
  const driftIndex = yaml.indexOf("Deterministic drift gate");
  const testIndex = yaml.indexOf("Run relevant deterministic Bindings");
  assert.ok(driftIndex > -1 && testIndex > -1);
  assert.ok(driftIndex < testIndex, "drift gate must run before tests");
});

test("emits JUnit consumption, native annotations, and a job summary", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig());
  assert.ok(yaml.includes("github-actions-annotations-cli.mjs reports/junit/dynamic-qa.xml"));
  assert.ok(yaml.includes("github-actions-summary-cli.mjs reports/junit/dynamic-qa.xml"));
  assert.ok(yaml.includes('>> "$GITHUB_STEP_SUMMARY"'));
});

test("uses existing runner labels rather than introducing new infrastructure", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig({ runsOn: "macos-14" }));
  assert.ok(yaml.includes("runs-on: macos-14"));
  assert.ok(!/self-hosted/.test(yaml));
});

test("rejects a wildcard junitPath outright", () => {
  assert.throws(() => renderAdvisoryPullRequestLane(baseConfig({ junitPath: "reports/**/*.xml" })));
});

test("requires an explicit Node version rather than assuming an ambient runtime", () => {
  assert.throws(() => renderAdvisoryPullRequestLane(baseConfig({ nodeVersion: undefined })));
});

// --- each hardening property individually detected when violated ---------

test("detects a missing permissions block", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace(/^permissions:\n(?:^ {2}.*\n?)*/m, "");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "permissions.missing"));
});

test("detects a non-minimal permissions grant", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace("permissions:\n  contents: read", "permissions:\n  contents: write\n  pull-requests: write");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "permissions.not-minimal"));
  assert.ok(result.errors.some((e) => e.code === "identity.write-permission-granted"));
});

test("detects a checkout step missing persist-credentials: false", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace("        with:\n          persist-credentials: false\n", "");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "checkout.persist-credentials-not-disabled"));
});

test("detects a tag-pinned action instead of a full commit SHA", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace(CHECKOUT_ACTION_REF, "actions/checkout@v4");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "actions.not-sha-pinned"));
});

test("detects the unsafe pull_request_target trigger", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace("  pull_request:", "  pull_request_target:");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "trigger.unsafe-pull-request-target"));
});

test("detects a job that is missing continue-on-error, which would let an advisory failure gate the merge", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace("    continue-on-error: true\n", "");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "advisory.not-continue-on-error"));
});

test("detects a referenced secret", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace(
    "npm test -- --grep dynamic-qa-relevant",
    "npm test --token ${{ secrets.NPM_TOKEN }}",
  );
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "identity.secret-referenced"));
});

test("detects a requested OIDC id-token: write permission", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace("permissions:\n  contents: read", "permissions:\n  contents: read\n  id-token: write");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "identity.oidc-write-permission"));
});

test("detects a declared protected environment", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace("    continue-on-error: true\n", "    continue-on-error: true\n    environment: production\n");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "identity.protected-environment-declared"));
});

test("detects a privileged cache action", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace(
    "      - name: Publish job summary",
    `      - name: Cache\n        uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809\n      - name: Publish job summary`,
  );
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "cache.privileged-cache-used"));
});

test("detects a self-hosted runner label", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace("runs-on: ubuntu-latest", "runs-on: self-hosted");
  const result = checkWorkflowHardening(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "environment.self-hosted-runner-used"));
});
