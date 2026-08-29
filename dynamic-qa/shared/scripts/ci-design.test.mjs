// dynamic-qa/shared/scripts/ci-design.test.mjs
//
// Tier 1 tests for ticket #168 (qa-setup stage 9: provider-native CI
// design). Covers: CI design is refused (throws) when the portfolio is not
// fully approved, and succeeds once it is; lane assignment follows real
// capability evidence (an unactivated Execution Profile, and a trigger the
// adapter has not built yet, both block a lane rather than silently
// assigning one); the smallest-diff choice prefers amending a suitable
// existing workflow and is tested both ways (amend preferred when eligible
// and smaller-or-equal; new-file chosen when nothing eligible exists); and
// the CI proposal artifact names only runners/environments/workflow paths
// that were actually inventoried, never invented ones.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeFact } from "./fact.mjs";
import {
  assignFlowLane,
  summarizeCiInventory,
  evaluateAmendCandidate,
  chooseSmallestDiff,
  designProviderNativeCI,
  LANE_TRIGGERS,
} from "./ci-design.mjs";

function prFastFlow(id = "flow-checkout") {
  return { id, boundaries: [], test_level: { selection: "inferred" } };
}

function nightlyFlow(id = "flow-e2e-checkout") {
  return {
    id,
    boundaries: [{ id: "b1", treatment: "real", side_effects: "sends real email" }],
    test_level: { selection: "inferred" },
  };
}

function activatableExecutionResult(runnerClass = "macos-14") {
  return {
    flowId: "x",
    profile: { environments: { runnerClass } },
    decision: { activate: true, state: "activatable", blockers: [] },
  };
}

function deferredExecutionResult() {
  return {
    flowId: "x",
    profile: {},
    decision: { activate: false, state: "deferred", blockers: [{ category: "evidence", message: "missing capability" }] },
  };
}

function portfolioApproval(approvedFlowIds, draftFlowIds = []) {
  return { approvedFlowIds, draftFlowIds, portfolioFullyApproved: draftFlowIds.length === 0, perFlow: [] };
}

function ciFacts({ path = ".github/workflows/acceptance.yml", triggers = ["pull_request"], runners = ["macos-14"] } = {}) {
  const facts = [];
  for (const t of triggers) facts.push(makeFact({ id: `ci-trigger:${t}`, category: "ci-trigger", provenance: "observed", evidence: path }));
  for (const r of runners) facts.push(makeFact({ id: `ci-runner:${r}`, category: "ci-runner", provenance: "observed", evidence: path }));
  return facts;
}

function renderConfig(overrides = {}) {
  return {
    runsOn: "macos-14",
    nodeVersion: "20",
    testCommand: "node --test dynamic-qa/shared/scripts/*.test.mjs",
    junitPath: "qa/reports/junit.xml",
    ...overrides,
  };
}

// --- ordering: CI design is unreachable with an unapproved portfolio ------

test("designProviderNativeCI throws when the portfolio is not fully approved", () => {
  const approval = portfolioApproval(["a"], ["b"]);
  assert.throws(
    () => designProviderNativeCI({ portfolioApproval: approval, flows: [prFastFlow("a")], executionResultsByFlowId: { a: activatableExecutionResult() } }),
    /not fully approved/,
  );
});

test("designProviderNativeCI proceeds once the portfolio is fully approved", () => {
  const approval = portfolioApproval(["a"]);
  const result = designProviderNativeCI({
    portfolioApproval: approval,
    flows: [prFastFlow("a")],
    executionResultsByFlowId: { a: activatableExecutionResult() },
    ciInventoryFacts: ciFacts(),
    renderConfig: renderConfig(),
  });
  assert.equal(result.provider, "github-actions");
  assert.deepEqual(result.approvedFlowIds, ["a"]);
  assert.equal(result.lanes.length, 1);
  assert.equal(result.lanes[0].assigned, true);
});

test("designProviderNativeCI throws on a malformed portfolioApproval rather than treating it as nothing approved", () => {
  assert.throws(() => designProviderNativeCI({ portfolioApproval: { approved: true }, flows: [] }), /evaluatePortfolioApproval/);
});

// --- lane assignment follows real capability evidence ----------------------

test("assignFlowLane assigns the pr-fast lane for an activatable pull-request-shaped flow", () => {
  const lane = assignFlowLane(prFastFlow(), activatableExecutionResult());
  assert.equal(lane.assigned, true);
  assert.equal(lane.requiredTrigger, "pull_request");
  assert.equal(lane.laneName, "pr-fast");
  assert.equal(lane.enforcementState, "advisory");
  assert.equal(lane.runnerClass, "macos-14");
});

test("assignFlowLane refuses a lane for a flow whose Execution Profile never activated", () => {
  const lane = assignFlowLane(prFastFlow(), deferredExecutionResult());
  assert.equal(lane.assigned, false);
  assert.equal(lane.reason, "execution-profile-not-activatable");
  assert.equal(lane.blockers.length, 1);
});

test("assignFlowLane refuses a lane whose required trigger the adapter has not built yet, and names the deferred trigger", () => {
  const lane = assignFlowLane(nightlyFlow(), activatableExecutionResult(), { supportedTriggers: ["pull_request"], deferredTriggers: ["schedule (nightly)", "workflow_dispatch (manual/API)", "merge_group"] });
  assert.equal(lane.assigned, false);
  assert.equal(lane.reason, "trigger-not-yet-supported-by-adapter");
  assert.equal(lane.requiredTrigger, "schedule");
  assert.equal(lane.deferredTrigger, "schedule (nightly)");
});

test("assignFlowLane picks up a newly supported trigger with no code change — the seam for #154", () => {
  // Simulates #154 having landed a `schedule` renderer: passing a wider
  // supportedTriggers list is the only thing that changes, proving this
  // module never hard-coded "only pull_request exists".
  const lane = assignFlowLane(nightlyFlow(), activatableExecutionResult(), {
    supportedTriggers: ["pull_request", "schedule"],
  });
  assert.equal(lane.assigned, true);
  assert.equal(lane.requiredTrigger, "schedule");
  assert.equal(lane.laneName, "nightly-full");
});

test("LANE_TRIGGERS names all four spec-required lanes, not only pull_request", () => {
  assert.deepEqual(Object.keys(LANE_TRIGGERS).sort(), ["manual", "merge-queue", "nightly-full", "pr-fast"].sort());
});

test("assignFlowLane throws without a real stage-7 execution result", () => {
  assert.throws(() => assignFlowLane(prFastFlow(), undefined), /designExecutionProfile result/);
});

// --- CI inventory summary ----------------------------------------------------

test("summarizeCiInventory groups facts by their own evidence field, inventing nothing", () => {
  const facts = ciFacts({ path: ".github/workflows/acceptance.yml", triggers: ["pull_request"], runners: ["macos-14"] });
  const summary = summarizeCiInventory(facts);
  assert.equal(summary.workflows.length, 1);
  assert.equal(summary.workflows[0].path, ".github/workflows/acceptance.yml");
  assert.ok(summary.workflows[0].triggers.has("pull_request"));
  assert.ok(summary.workflows[0].runners.has("macos-14"));
  assert.ok(summary.runners.has("macos-14"));
  assert.equal(summary.runners.has("ubuntu-latest"), false);
});

// --- smallest diff: tested both ways ----------------------------------------

test("chooseSmallestDiff prefers amending a suitable existing workflow when it is smaller", () => {
  const ciInventory = summarizeCiInventory(ciFacts({ triggers: ["pull_request"], runners: ["macos-14"] }));
  const choice = chooseSmallestDiff({ ciInventory, requiredTrigger: "pull_request", renderConfig: renderConfig() });
  assert.equal(choice.strategy, "amend");
  assert.equal(choice.targetPath, ".github/workflows/acceptance.yml");
  assert.equal(choice.triggerAlreadyPresent, true);
  assert.equal(choice.reusedRunner, "macos-14");
  assert.ok(choice.estimatedDiffLines <= choice.alternativeEstimatedDiffLines);
});

test("chooseSmallestDiff proposes a new file when no eligible existing workflow exists", () => {
  const ciInventory = summarizeCiInventory([]); // no workflows inventoried at all
  const choice = chooseSmallestDiff({ ciInventory, requiredTrigger: "pull_request", renderConfig: renderConfig() });
  assert.equal(choice.strategy, "new-file");
  assert.equal(choice.targetPath, ".github/workflows/dynamic-qa.yml");
  assert.equal(choice.alternativeEstimatedDiffLines, null);
});

test("chooseSmallestDiff never proposes amending a self-hosted-only workflow", () => {
  const ciInventory = summarizeCiInventory(ciFacts({ runners: ["self-hosted"] }));
  const choice = chooseSmallestDiff({ ciInventory, requiredTrigger: "pull_request", renderConfig: renderConfig() });
  assert.equal(choice.strategy, "new-file");
});

test("evaluateAmendCandidate charges a small, named addition when the required trigger is not already present", () => {
  const workflowFact = { path: ".github/workflows/other.yml", triggers: new Set(["push"]), runners: new Set(["macos-14"]), environments: new Set(), checks: new Set() };
  const candidate = evaluateAmendCandidate(workflowFact, "pull_request", 10);
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.triggerAlreadyPresent, false);
  assert.equal(candidate.estimatedDiffLines, 13);
});

// --- the proposal names only real, inventoried infrastructure --------------

test("designProviderNativeCI's namedInfrastructure cites only the runners/environments/workflow paths actually inventoried", () => {
  const approval = portfolioApproval(["a"]);
  const result = designProviderNativeCI({
    portfolioApproval: approval,
    flows: [prFastFlow("a")],
    executionResultsByFlowId: { a: activatableExecutionResult("macos-14") },
    ciInventoryFacts: ciFacts({ path: ".github/workflows/acceptance.yml", triggers: ["pull_request"], runners: ["macos-14"] }),
    renderConfig: renderConfig({ runsOn: "macos-14" }),
  });
  assert.deepEqual(result.namedInfrastructure.runners, ["macos-14"]);
  assert.deepEqual(result.namedInfrastructure.existingWorkflowPaths, [".github/workflows/acceptance.yml"]);
  assert.equal(result.namedInfrastructure.runners.includes("ubuntu-latest"), false);
  assert.equal(result.runnerMatchesInventory.matches, true);
});

test("designProviderNativeCI flags a runner the inventory never observed rather than treating it as reusable", () => {
  const approval = portfolioApproval(["a"]);
  const result = designProviderNativeCI({
    portfolioApproval: approval,
    flows: [prFastFlow("a")],
    executionResultsByFlowId: { a: activatableExecutionResult("ubuntu-latest") },
    ciInventoryFacts: ciFacts({ path: ".github/workflows/acceptance.yml", triggers: ["pull_request"], runners: ["macos-14"] }),
    renderConfig: renderConfig({ runsOn: "ubuntu-latest" }),
  });
  assert.equal(result.runnerMatchesInventory.matches, false);
  assert.equal(result.runnerMatchesInventory.runner, "ubuntu-latest");
});

// --- Tier 2-shaped: a flow with no working lane still produces a proposal ---

test("a flow blocked from every lane still yields a proposal naming why, never an exception mid-portfolio", () => {
  const approval = portfolioApproval(["a", "b"]);
  // Pin trigger support explicitly rather than relying on the adapter's shipped
  // default: #154 has since added schedule/workflow_dispatch/merge_group. This
  // test is about the deferred-trigger PATH, not about which triggers happen to
  // be supported today.
  const result = designProviderNativeCI({
    portfolioApproval: approval,
    flows: [prFastFlow("a"), nightlyFlow("b")],
    executionResultsByFlowId: { a: activatableExecutionResult(), b: activatableExecutionResult() },
    ciInventoryFacts: ciFacts(),
    renderConfig: renderConfig(),
    supportedTriggers: ["pull_request"],
    deferredTriggers: ["schedule (nightly)", "workflow_dispatch (manual/API)", "merge_group"],
  });
  const laneA = result.lanes.find((l) => l.flowId === "a");
  const laneB = result.lanes.find((l) => l.flowId === "b");
  assert.equal(laneA.assigned, true);
  assert.equal(laneB.assigned, false);
  assert.equal(laneB.reason, "trigger-not-yet-supported-by-adapter");
});

test("with the adapter's shipped trigger support, a nightly flow is now assigned (#154 widened it)", () => {
  const approval = portfolioApproval(["a", "b"]);
  const result = designProviderNativeCI({
    portfolioApproval: approval,
    flows: [prFastFlow("a"), nightlyFlow("b")],
    executionResultsByFlowId: { a: activatableExecutionResult(), b: activatableExecutionResult() },
    ciInventoryFacts: ciFacts(),
    renderConfig: renderConfig(),
  });
  const laneB = result.lanes.find((l) => l.flowId === "b");
  assert.equal(laneB.assigned, true);
});
