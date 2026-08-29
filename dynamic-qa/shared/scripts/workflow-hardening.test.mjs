// dynamic-qa/shared/scripts/workflow-hardening.test.mjs
//
// Tier 1 coverage for ticket #155's low-trust workflow hardening:
// action/reusable-workflow allowlisting (on top of #153's SHA pinning) and
// a privileged lane's refusal to execute low-trust code or artifacts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderAdvisoryPullRequestLane, checkWorkflowHardening } from "./github-actions-workflow.mjs";
import {
  DEFAULT_ALLOWLISTED_ACTIONS,
  checkActionAndReusableWorkflowAllowlist,
  checkPrivilegedLaneRefusesLowTrustBridge,
  assertPrivilegedJobRefusesArtifact,
} from "./workflow-hardening.mjs";

function baseConfig(overrides = {}) {
  return {
    runsOn: "ubuntu-latest",
    nodeVersion: "20",
    testCommand: "node dynamic-qa/shared/scripts/run-relevant.mjs",
    junitPath: "diagnostics/result.xml",
    ...overrides,
  };
}

// --- unreviewed PR job receives nothing privileged --------------------------
//
// This is #153's own advisory-lane renderer, consumed here (not
// re-implemented) to prove the ticket #155 acceptance criterion "an
// unreviewed PR job proven to receive nothing privileged" against real
// rendered output.

test("the advisory PR lane (an unreviewed-PR job) is proven to carry no secret/OIDC/protected-environment/write/cache identity", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig());
  const hardening = checkWorkflowHardening(yaml);
  assert.equal(hardening.valid, true, JSON.stringify(hardening.errors));
  assert.ok(!/\$\{\{\s*secrets\./.test(yaml));
  assert.ok(!/id-token:\s*write/.test(yaml));
  assert.ok(!/^\s*environment:/m.test(yaml));
  assert.ok(!/actions\/cache@/.test(yaml));
});

test("mutating the advisory lane to add a secret reference is individually detected, not silently accepted", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig()).replace(
    "steps:\n",
    'steps:\n      - name: Leaky\n        env:\n          TOKEN: ${{ secrets.SOME_TOKEN }}\n',
  );
  const hardening = checkWorkflowHardening(yaml);
  assert.equal(hardening.valid, false);
  assert.ok(hardening.errors.some((e) => e.code === "identity.secret-referenced"));
});

// --- action / reusable-workflow allowlist -----------------------------------

test("checkActionAndReusableWorkflowAllowlist: the rendered advisory lane's actions are all allowlisted and pinned", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig());
  const result = checkActionAndReusableWorkflowAllowlist(yaml);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("checkActionAndReusableWorkflowAllowlist: an unpinned action (floating tag) is rejected", () => {
  const yaml = `
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
`;
  const result = checkActionAndReusableWorkflowAllowlist(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "action.not-pinned"));
});

test("checkActionAndReusableWorkflowAllowlist: a pinned but non-allowlisted action is rejected", () => {
  const yaml = `
jobs:
  build:
    steps:
      - uses: some-org/some-action@${"a".repeat(40)}
`;
  const result = checkActionAndReusableWorkflowAllowlist(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "action.not-allowlisted"));
});

test("checkActionAndReusableWorkflowAllowlist: an allowlisted identity pinned to the WRONG sha is rejected", () => {
  const yaml = `
jobs:
  build:
    steps:
      - uses: actions/checkout@${"b".repeat(40)}
`;
  const result = checkActionAndReusableWorkflowAllowlist(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "action.sha-mismatch"));
});

test("checkActionAndReusableWorkflowAllowlist: applies identically to a reusable workflow call", () => {
  const sha = "c".repeat(40);
  const yaml = `
jobs:
  call:
    uses: some-org/some-repo/.github/workflows/reusable.yml@${sha}
`;
  const result = checkActionAndReusableWorkflowAllowlist(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "action.not-allowlisted" && e.message.includes("some-org/some-repo")));
});

test("checkActionAndReusableWorkflowAllowlist: a caller may extend the allowlist for its own approved actions", () => {
  const sha = "d".repeat(40);
  const yaml = `
jobs:
  build:
    steps:
      - uses: my-org/my-action@${sha}
`;
  const allowlist = { ...DEFAULT_ALLOWLISTED_ACTIONS, "my-org/my-action": sha };
  const result = checkActionAndReusableWorkflowAllowlist(yaml, allowlist);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

// --- privileged lane refuses low-trust code and artifacts -------------------

test("checkPrivilegedLaneRefusesLowTrustBridge: a privileged job on pull_request_target is rejected by name", () => {
  const yaml = `
on:
  pull_request_target:
    branches: ["main"]

jobs:
  publish:
    permissions:
      contents: write
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
`;
  const result = checkPrivilegedLaneRefusesLowTrustBridge(yaml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "privileged-lane.low-trust-trigger-with-privileged-identity"));
});

test("checkPrivilegedLaneRefusesLowTrustBridge: a privileged job downloading a raw artifact with no envelope validation is rejected", () => {
  const yaml = `
on:
  workflow_run:
    workflows: ["dynamic-qa advisory PR lane"]

jobs:
  publish:
    environment: production
    steps:
      - uses: actions/download-artifact@${"e".repeat(40)}
      - run: ./deploy.sh
`;
  const result = checkPrivilegedLaneRefusesLowTrustBridge(yaml);
  assert.equal(result.valid, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes("privileged-lane.low-trust-trigger-with-privileged-identity"));
  assert.ok(codes.includes("privileged-lane.downloads-artifact-without-envelope-validation"));
});

test("checkPrivilegedLaneRefusesLowTrustBridge: downloading and validating a Result Envelope explicitly is not flagged", () => {
  const yaml = `
on:
  pull_request:
    branches: ["main"]

jobs:
  advisory:
    permissions:
      contents: read
    steps:
      - run: echo ok

  publish:
    environment: production
    needs: advisory
    steps:
      - uses: actions/download-artifact@${"f".repeat(40)}
      - run: node dynamic-qa/shared/scripts/result-envelope-verify-cli.mjs
`;
  const result = checkPrivilegedLaneRefusesLowTrustBridge(yaml);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("checkPrivilegedLaneRefusesLowTrustBridge: an advisory-only workflow (no privileged job at all) is never flagged", () => {
  const yaml = renderAdvisoryPullRequestLane(baseConfig());
  const result = checkPrivilegedLaneRefusesLowTrustBridge(yaml);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("assertPrivilegedJobRefusesArtifact: a privileged job refuses a code artifact, reusing trust-zones.mjs's own gate", () => {
  const result = assertPrivilegedJobRefusesArtifact(true, { kind: "code" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-zone.privileged-lane-refuses-code"));
});

test("assertPrivilegedJobRefusesArtifact: a privileged job refuses a raw cache/path artifact", () => {
  const result = assertPrivilegedJobRefusesArtifact(true, { kind: "cache" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-zone.privileged-lane-refuses-artifact"));
});

test("assertPrivilegedJobRefusesArtifact: a privileged job accepts a result-envelope artifact", () => {
  const result = assertPrivilegedJobRefusesArtifact(true, { kind: "result-envelope" });
  assert.equal(result.valid, true);
});

test("assertPrivilegedJobRefusesArtifact: a non-privileged (low-trust-ci) job is unconstrained by this gate", () => {
  const result = assertPrivilegedJobRefusesArtifact(false, { kind: "code" });
  assert.equal(result.valid, true);
});
