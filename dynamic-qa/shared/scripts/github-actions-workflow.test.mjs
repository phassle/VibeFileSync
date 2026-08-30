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
  renderNightlyFullSuiteLane,
  renderManualTriggerLane,
  renderMergeGroupLane,
  checkWorkflowHardening,
  checkActionPinsResolved,
  ACTION_PINS,
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

// --- #154: nightly, manual/provider, and merge-group lanes ----------------
//
// Every hardening property #153 proved for the PR lane must hold for these
// three new lanes too — one test per lane per property, not an assumption
// of inheritance, per the ticket's own instruction.

const NEW_LANES = [
  { name: "nightly", render: renderNightlyFullSuiteLane, lane: "advisory", trigger: "schedule", triggerLine: /^\s*schedule:/m },
  { name: "manual", render: renderManualTriggerLane, lane: "advisory", trigger: "workflow_dispatch", triggerLine: /^\s*workflow_dispatch:/m },
  { name: "merge-group", render: renderMergeGroupLane, lane: "required", trigger: "merge_group", triggerLine: /^\s*merge_group:/m },
];

for (const { name, render, lane, trigger, triggerLine } of NEW_LANES) {
  test(`${name} lane: renders with every required hardening property`, () => {
    const yaml = render(baseConfig());
    const result = checkWorkflowHardening(yaml, { lane, trigger });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test(`${name} lane: declares its own trigger event, never pull_request_target`, () => {
    const yaml = render(baseConfig());
    assert.match(yaml, triggerLine);
    assert.ok(!yaml.includes(FORBIDDEN_PR_TRIGGER));
  });

  test(`${name} lane: uses SHA-pinned actions, never a floating tag`, () => {
    const yaml = render(baseConfig());
    assert.ok(yaml.includes(`uses: ${CHECKOUT_ACTION_REF}`));
    assert.ok(yaml.includes(`uses: ${SETUP_NODE_ACTION_REF}`));
  });

  test(`${name} lane: the drift gate step precedes the test step`, () => {
    const yaml = render(baseConfig());
    const driftIndex = yaml.indexOf("Deterministic drift gate");
    const testIndex = yaml.lastIndexOf(": npm test -- --grep dynamic-qa-relevant");
    assert.ok(driftIndex > -1 && testIndex > -1);
    assert.ok(driftIndex < testIndex, "drift gate must run before tests");
  });

  test(`${name} lane: detects a missing permissions block`, () => {
    const yaml = render(baseConfig()).replace(/^permissions:\n(?:^ {2}.*\n?)*/m, "");
    const result = checkWorkflowHardening(yaml, { lane, trigger });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === "permissions.missing"));
  });

  test(`${name} lane: detects a checkout step missing persist-credentials: false`, () => {
    const yaml = render(baseConfig()).replace("        with:\n          persist-credentials: false\n", "");
    const result = checkWorkflowHardening(yaml, { lane, trigger });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === "checkout.persist-credentials-not-disabled"));
  });

  test(`${name} lane: detects a tag-pinned action instead of a full commit SHA`, () => {
    const yaml = render(baseConfig()).replace(CHECKOUT_ACTION_REF, "actions/checkout@v4");
    const result = checkWorkflowHardening(yaml, { lane, trigger });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === "actions.not-sha-pinned"));
  });

  test(`${name} lane: detects a referenced secret`, () => {
    const yaml = render(baseConfig()).replace("npm test -- --grep dynamic-qa-relevant", "npm test --token ${{ secrets.NPM_TOKEN }}");
    const result = checkWorkflowHardening(yaml, { lane, trigger });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === "identity.secret-referenced"));
  });

  test(`${name} lane: detects a requested OIDC id-token: write permission`, () => {
    const yaml = render(baseConfig()).replace("permissions:\n  contents: read", "permissions:\n  contents: read\n  id-token: write");
    const result = checkWorkflowHardening(yaml, { lane, trigger });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === "identity.oidc-write-permission"));
  });

  test(`${name} lane: detects a self-hosted runner label`, () => {
    const yaml = render(baseConfig()).replace("runs-on: ubuntu-latest", "runs-on: self-hosted");
    const result = checkWorkflowHardening(yaml, { lane, trigger });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === "environment.self-hosted-runner-used"));
  });

  test(`${name} lane: rejects a wildcard junitPath outright`, () => {
    assert.throws(() => render(baseConfig({ junitPath: "reports/**/*.xml" })));
  });

  test(`${name} lane: requires an explicit Node version rather than assuming an ambient runtime`, () => {
    assert.throws(() => render(baseConfig({ nodeVersion: undefined })));
  });
}

// --- lane-specific gating semantics: the one property that must DIFFER ----

test("nightly and manual lanes are ADVISORY: continue-on-error: true, so a failure never gates anything", () => {
  assert.match(renderNightlyFullSuiteLane(baseConfig()), /continue-on-error:\s*true/);
  assert.match(renderManualTriggerLane(baseConfig()), /continue-on-error:\s*true/);
});

test("merge-group lane is REQUIRED: it omits continue-on-error so a failure actually gates the merge queue", () => {
  const yaml = renderMergeGroupLane(baseConfig());
  assert.ok(!/continue-on-error:\s*true/.test(yaml));
});

test("checkWorkflowHardening flags a merge-group lane that was mutated to add continue-on-error (would silently defeat the required check)", () => {
  const yaml = renderMergeGroupLane(baseConfig()).replace("    steps:", "    continue-on-error: true\n    steps:");
  const result = checkWorkflowHardening(yaml, { lane: "required", trigger: "merge_group" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "required.continue-on-error-present"));
});

test("checkWorkflowHardening flags a nightly/manual lane mutated to remove continue-on-error (would let a scheduled/requested run start gating something it should not)", () => {
  const nightlyYaml = renderNightlyFullSuiteLane(baseConfig()).replace("    continue-on-error: true\n", "");
  const result = checkWorkflowHardening(nightlyYaml, { lane: "advisory", trigger: "schedule" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "advisory.not-continue-on-error"));
});

// --- manual/provider lane: the requester cannot change policy -------------

test("the manual/provider lane declares workflow_dispatch with no inputs at all", () => {
  const yaml = renderManualTriggerLane(baseConfig());
  assert.match(yaml, /^\s*workflow_dispatch:\s*\{\}\s*$/m);
  assert.ok(!yaml.includes("inputs:"));
});

test("checkWorkflowHardening detects a workflow_dispatch mutated to add inputs, which would let a request influence the command/runner/identity", () => {
  const yaml = renderManualTriggerLane(baseConfig()).replace(
    "  workflow_dispatch: {}",
    "  workflow_dispatch:\n    inputs:\n      testCommand:\n        required: false",
  );
  const result = checkWorkflowHardening(yaml, { lane: "advisory", trigger: "workflow_dispatch" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "dispatch.inputs-not-permitted"));
});

// --- trigger-declaration checks, per lane ----------------------------------

test("checkWorkflowHardening detects a nightly lane missing its declared schedule trigger", () => {
  const yaml = renderNightlyFullSuiteLane(baseConfig()).replace(/^\s*schedule:\n\s*- cron:.*\n/m, "");
  const result = checkWorkflowHardening(yaml, { lane: "advisory", trigger: "schedule" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "trigger.missing-declared-event"));
});

test("checkWorkflowHardening detects a merge-group lane missing its declared merge_group trigger", () => {
  const yaml = renderMergeGroupLane(baseConfig()).replace(/^\s*merge_group:\n\s*types:.*\n/m, "");
  const result = checkWorkflowHardening(yaml, { lane: "required", trigger: "merge_group" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "trigger.missing-declared-event"));
});

test("nightly lane accepts a caller-supplied cron and rejects an empty one", () => {
  const yaml = renderNightlyFullSuiteLane(baseConfig({ cron: "0 6 * * 1-5" }));
  assert.ok(yaml.includes('cron: "0 6 * * 1-5"'));
  assert.throws(() => renderNightlyFullSuiteLane(baseConfig({ cron: "" })));
});

// --- finding #3, closed: placeholder action pins fail closed, never silently ---

test("checkActionPinsResolved: both shipped action pins are honestly reported as unresolved placeholders until a human re-verifies each against the real upstream commit", () => {
  // This is a TRUE statement about this bundle's current, honest state, not
  // an aspiration: neither pin has been re-verified against a live upstream
  // checkout (this module has zero network access and cannot do so itself).
  // Once a human completes the steps documented beside ACTION_PINS above and
  // flips a pin's `resolved` flag to `true`, this test must be updated to
  // match — that is the intended, visible signal that the pin was actually
  // resolved, not merely silently forgotten about.
  assert.equal(ACTION_PINS.checkout.resolved, false);
  assert.equal(ACTION_PINS.setupNode.resolved, false);

  const result = checkActionPinsResolved();
  assert.equal(result.valid, false);
  const codes = result.errors.map((e) => e.code);
  assert.deepEqual(codes, ["actions.placeholder-pin-unresolved", "actions.placeholder-pin-unresolved"]);
  assert.ok(result.errors.some((e) => e.message.includes("checkout")));
  assert.ok(result.errors.some((e) => e.message.includes("setupNode") || e.message.includes("actions/setup-node")));
});

test("checkActionPinsResolved: a hypothetical fully-resolved pin set is not flagged (proves the check reacts to the flag, not just always-fails)", () => {
  const allResolved = { checkout: { ...ACTION_PINS.checkout, resolved: true }, setupNode: { ...ACTION_PINS.setupNode, resolved: true } };
  assert.deepEqual(checkActionPinsResolved(allResolved), { valid: true, errors: [] });
});
