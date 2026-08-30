// dynamic-qa/shared/scripts/setup-review-packet.test.mjs
//
// Tier 1 tests for ticket #169 (qa-setup stage 10: Setup Review Packet,
// emit patch and stop). Covers: the packet covers all seven required areas
// and is rejected if one is missing; contract and technical approvals gate
// independently and neither alone emits; measurement-required prevents
// emission; the emitted patch contains exactly the expected qa/ artifacts
// and nothing else; after emission no further action exists to take
// (emitSetupReviewPacket's return value carries no generator/merge/apply
// handle at all).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_PACKET_AREAS,
  assembleSetupReviewPacket,
  validateSetupReviewPacket,
  evaluateSetupReviewApproval,
  buildSetupPatchFiles,
  emitSetupReviewPacket,
  listBundledSchemaFiles,
} from "./setup-review-packet.mjs";
import { makeFact } from "./fact.mjs";
import { knownQuantity, unknownQuantity, notApplicableQuantity, makeMetric, buildBaselinePlan, REQUIRED_METRIC_IDS, MIN_BURN_IN_CALENDAR_DAYS } from "./baseline-plan.mjs";
import { designProviderNativeCI } from "./ci-design.mjs";

// --- shared fixtures ---------------------------------------------------

function flow(id, overrides = {}) {
  return {
    schema: "dynamic-qa-flow-v1",
    id,
    revision: 1,
    title: `Flow ${id}`,
    intent: "prove something real",
    criticality: "high",
    state: "active",
    origin: { tickets: ["https://github.com/phassle/VibeFileSync/issues/1"] },
    test_level: { selection: "inferred" },
    data_sets: [],
    boundaries: [],
    steps: [],
    ...overrides,
  };
}

function dataSet(id) {
  return { schema: "dynamic-qa-data-v1", id, revision: 1, cases: [{ id: "case-1", fields: { name: "value" } }] };
}

function portfolioApproval(approvedFlowIds, draftFlowIds = []) {
  return { approvedFlowIds, draftFlowIds, portfolioFullyApproved: draftFlowIds.length === 0 && approvedFlowIds.length > 0, perFlow: [] };
}

function executionResult(flowId, { activate = true, runnerClass = "macos-14" } = {}) {
  return {
    flowId,
    profile: { schema: "dynamic-qa-execution-profile-v1", id: flowId, revision: 1, environments: { runnerClass } },
    profileYaml: `schema: "dynamic-qa-execution-profile-v1"\nid: "${flowId}"\n`,
    decision: activate
      ? { activate: true, state: "activatable", blockers: [] }
      : { activate: false, state: "deferred", blockers: [{ category: "evidence", message: "missing capability" }] },
  };
}

const NOW = new Date("2026-06-01T00:00:00Z");
const STARTED_LONG_AGO = new Date(NOW.getTime() - (MIN_BURN_IN_CALENDAR_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
const STARTED_RECENTLY = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

function metricFor(id, { ready = true } = {}) {
  if (!ready) {
    return makeMetric({ id, label: id, query: "tbd", interval: "trailing-30-days", source: "tbd", provenance: "unknown", numerator: unknownQuantity(), denominator: unknownQuantity(), collectedAt: null });
  }
  if (id === "repair-decisions") {
    return makeMetric({
      id, label: id, query: "n/a", interval: "n/a", source: "n/a", provenance: "reported",
      numerator: notApplicableQuantity("no repair activity yet"), denominator: notApplicableQuantity("no repair activity yet"), collectedAt: null,
    });
  }
  const denom = id === "pr-check-latency-p95" ? 25 : 30;
  return makeMetric({ id, label: id, query: `select ${id}`, interval: "trailing-30-days", source: "github-actions", provenance: "observed", numerator: knownQuantity(3), denominator: knownQuantity(denom), collectedAt: NOW.toISOString() });
}

function readyBaselinePlan() {
  return buildBaselinePlan(
    {
      id: "pilot-baseline",
      revision: 1,
      owners: { qaOwner: "qa-owner", technicalOwner: "tech-owner" },
      repository: "phassle/VibeFileSync",
      window: { startedAt: STARTED_LONG_AGO },
      metrics: REQUIRED_METRIC_IDS.map((id) => metricFor(id, { ready: true })),
      generatedAt: STARTED_LONG_AGO,
    },
    { now: NOW },
  );
}

function measurementRequiredBaselinePlan() {
  return buildBaselinePlan(
    {
      id: "pilot-baseline",
      revision: 1,
      owners: { qaOwner: "qa-owner", technicalOwner: "tech-owner" },
      repository: "phassle/VibeFileSync",
      window: { startedAt: STARTED_RECENTLY },
      metrics: REQUIRED_METRIC_IDS.map((id) => metricFor(id, { ready: false })),
      generatedAt: STARTED_RECENTLY,
    },
    { now: NOW },
  );
}

function ciFacts() {
  return [
    makeFact({ id: "ci-trigger:pull_request", category: "ci-trigger", provenance: "observed", evidence: ".github/workflows/acceptance.yml" }),
    makeFact({ id: "ci-runner:macos-14", category: "ci-runner", provenance: "observed", evidence: ".github/workflows/acceptance.yml" }),
  ];
}

function renderConfig() {
  return { runsOn: "macos-14", nodeVersion: "20", testCommand: "node --test dynamic-qa/shared/scripts/*.test.mjs", junitPath: "qa/reports/junit.xml" };
}

function readyCiProposal(approvedFlowIds) {
  const approval = portfolioApproval(approvedFlowIds);
  const executionResultsByFlowId = Object.fromEntries(approvedFlowIds.map((id) => [id, executionResult(id)]));
  return designProviderNativeCI({
    portfolioApproval: approval,
    flows: approvedFlowIds.map((id) => flow(id)),
    executionResultsByFlowId,
    ciInventoryFacts: ciFacts(),
    renderConfig: renderConfig(),
  });
}

function harnessFacts() {
  return [makeFact({ id: "test-framework:node:test", category: "test-framework", provenance: "observed" })];
}

function approvalRecord({ qaPresent = true, technicalPresent = true } = {}) {
  return {
    qaOwnerGate: { present: qaPresent, identifier: "qa-owner-alice" },
    technicalOwnerGate: { present: technicalPresent, identifier: "tech-owner-bob" },
  };
}

function fullInputs({ approvedFlowIds = ["flow-a"], draftFlowIds = [], baselinePlan = readyBaselinePlan() } = {}) {
  const flows = [...approvedFlowIds, ...draftFlowIds].map((id) => flow(id));
  const approval = portfolioApproval(approvedFlowIds, draftFlowIds);
  const executionResults = approvedFlowIds.map((id) => executionResult(id));
  const ciProposal = readyCiProposal(approvedFlowIds);
  return {
    flows,
    portfolioApproval: approval,
    executionResults,
    dataSets: [],
    baselinePlan,
    ciProposal,
    harnessFacts: harnessFacts(),
  };
}

// --- packet completeness ------------------------------------------------

test("assembleSetupReviewPacket covers all seven required areas when every input is present", () => {
  const packet = assembleSetupReviewPacket(fullInputs());
  assert.equal(packet.complete, true);
  assert.deepEqual(packet.missingAreas, []);
  for (const area of REQUIRED_PACKET_AREAS) {
    assert.ok(area in packet.areas, `expected area ${area} to be present`);
  }
});

test("assembleSetupReviewPacket reports exactly the one missing area when one input is absent, others unaffected", () => {
  const inputs = fullInputs();
  delete inputs.ciProposal; // knocks out both "dependency" and "ci"
  const packet = assembleSetupReviewPacket(inputs);
  assert.equal(packet.complete, false);
  assert.deepEqual(new Set(packet.missingAreas), new Set(["dependency", "ci", "unresolvedRequirements"]));
  // areas that did not depend on ciProposal are still built
  assert.ok("contract" in packet.areas);
  assert.ok("data" in packet.areas);
  assert.ok("safety" in packet.areas);
  assert.ok("harness" in packet.areas);
});

test("validateSetupReviewPacket rejects a packet missing any required area", () => {
  const packet = assembleSetupReviewPacket({});
  const validation = validateSetupReviewPacket(packet);
  assert.equal(validation.valid, false);
  assert.deepEqual(new Set(validation.missingAreas), new Set(REQUIRED_PACKET_AREAS));
});

test("validateSetupReviewPacket rejects a forged object that isn't a real assembleSetupReviewPacket result", () => {
  const forged = { areas: Object.fromEntries(REQUIRED_PACKET_AREAS.map((a) => [a, {}])) }; // no missingAreas field
  const validation = validateSetupReviewPacket(forged);
  assert.equal(validation.valid, false);
});

// --- independent dual approval -------------------------------------------

test("evaluateSetupReviewApproval requires both gates present to approve, and each withholds independently", () => {
  const bothApproved = evaluateSetupReviewApproval(approvalRecord());
  assert.equal(bothApproved.bothApproved, true);

  const technicalWithheld = evaluateSetupReviewApproval(approvalRecord({ technicalPresent: false }));
  assert.equal(technicalWithheld.contractApproved, true);
  assert.equal(technicalWithheld.technicalApproved, false);
  assert.equal(technicalWithheld.bothApproved, false);

  const contractWithheld = evaluateSetupReviewApproval(approvalRecord({ qaPresent: false }));
  assert.equal(contractWithheld.contractApproved, false);
  assert.equal(contractWithheld.technicalApproved, true);
  assert.equal(contractWithheld.bothApproved, false);
});

test("evaluateSetupReviewApproval fails closed on a malformed or collapsed approval record", () => {
  assert.equal(evaluateSetupReviewApproval({}).ok, false);
  assert.equal(evaluateSetupReviewApproval({ qaOwnerGate: { present: true, identifier: "a" }, technicalOwnerGate: { present: true, identifier: "b" }, approved: true }).ok, false);
});

test("evaluateSetupReviewApproval refuses to treat non-independent (same-reference) gates as bothApproved", () => {
  const sharedGate = { present: true, identifier: "same-person" };
  const record = { qaOwnerGate: sharedGate, technicalOwnerGate: sharedGate };
  const evaluation = evaluateSetupReviewApproval(record);
  assert.equal(evaluation.independent, false);
  assert.equal(evaluation.bothApproved, false);
});

// --- emission gating: packet completeness, both approvals, measurement ---

test("emitSetupReviewPacket refuses an incomplete packet", () => {
  const inputs = fullInputs();
  const incompletePacket = assembleSetupReviewPacket({});
  const result = emitSetupReviewPacket({ packet: incompletePacket, approvalRecord: approvalRecord(), ...inputs });
  assert.equal(result.emitted, false);
  assert.equal(result.reason, "incomplete-packet");
});

test("emitSetupReviewPacket emits nothing when the contract approval alone is given", () => {
  const inputs = fullInputs();
  const packet = assembleSetupReviewPacket(inputs);
  const result = emitSetupReviewPacket({ packet, approvalRecord: approvalRecord({ technicalPresent: false }), ...inputs });
  assert.equal(result.emitted, false);
  assert.equal(result.reason, "technical-approval-withheld");
});

test("emitSetupReviewPacket emits nothing when the technical approval alone is given", () => {
  const inputs = fullInputs();
  const packet = assembleSetupReviewPacket(inputs);
  const result = emitSetupReviewPacket({ packet, approvalRecord: approvalRecord({ qaPresent: false }), ...inputs });
  assert.equal(result.emitted, false);
  assert.equal(result.reason, "contract-approval-withheld");
});

test("emitSetupReviewPacket emits nothing when both approvals are withheld", () => {
  const inputs = fullInputs();
  const packet = assembleSetupReviewPacket(inputs);
  const result = emitSetupReviewPacket({ packet, approvalRecord: approvalRecord({ qaPresent: false, technicalPresent: false }), ...inputs });
  assert.equal(result.emitted, false);
  assert.equal(result.reason, "both-approvals-withheld");
});

test("emitSetupReviewPacket refuses on measurement-required even with both approvals present", () => {
  const inputs = fullInputs({ baselinePlan: measurementRequiredBaselinePlan() });
  const packet = assembleSetupReviewPacket(inputs);
  const result = emitSetupReviewPacket({ packet, approvalRecord: approvalRecord(), ...inputs });
  assert.equal(result.emitted, false);
  assert.equal(result.reason, "measurement-required");
});

test("emitSetupReviewPacket emits once the packet is complete, both approvals are present, and measurement is ready", () => {
  const inputs = fullInputs();
  const packet = assembleSetupReviewPacket(inputs);
  const result = emitSetupReviewPacket({ packet, approvalRecord: approvalRecord(), ...inputs });
  assert.equal(result.emitted, true);
  assert.ok(Array.isArray(result.files) && result.files.length > 0);
});

test("emitSetupReviewPacket's return value carries no generation/merge/apply handle — emit then stop is structural", () => {
  const inputs = fullInputs();
  const packet = assembleSetupReviewPacket(inputs);
  const result = emitSetupReviewPacket({ packet, approvalRecord: approvalRecord(), ...inputs });
  assert.equal(result.emitted, true);
  for (const forbiddenKey of ["apply", "merge", "generate", "run", "activate"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(result, forbiddenKey), false, `result must not carry a "${forbiddenKey}" action handle`);
  }
});

// --- exact patch contents ------------------------------------------------

test("buildSetupPatchFiles contains exactly the expected qa/ artifacts and nothing else", () => {
  const approvedFlowIds = ["flow-a", "flow-b"];
  const flowsWithData = approvedFlowIds.map((id) => flow(id, { data_sets: id === "flow-a" ? ["ds-1"] : [] }));
  const draftFlow = flow("flow-draft");
  const allFlows = [...flowsWithData, draftFlow];
  const approval = portfolioApproval(approvedFlowIds, ["flow-draft"]);
  const executionResults = [executionResult("flow-a"), executionResult("flow-b", { activate: false })];
  const dataSets = [dataSet("ds-1"), dataSet("ds-unreferenced")];
  const baselinePlan = readyBaselinePlan();
  const ciProposal = readyCiProposal(approvedFlowIds);

  const inputs = { flows: allFlows, portfolioApproval: approval, executionResults, dataSets, baselinePlan, ciProposal, harnessFacts: harnessFacts() };
  const packet = assembleSetupReviewPacket(inputs);
  assert.equal(packet.complete, true);

  const files = buildSetupPatchFiles({ packet, flows: allFlows, executionResults, dataSets, baselinePlan });
  const paths = files.map((f) => f.path).sort();

  const schemaPaths = listBundledSchemaFiles().map((s) => `qa/schemas/${s.name}`).sort();
  const expected = [
    "qa/flows/flow-a.yaml",
    "qa/flows/flow-b.yaml",
    "qa/data/ds-1.yaml",
    "qa/execution-profiles/flow-a.yaml",
    "qa/execution-profiles/flow-b.yaml",
    "qa/baseline-plan.yaml",
    ...schemaPaths,
  ].sort();

  assert.deepEqual(paths, expected);
  // the draft flow, and the unreferenced data set, must never appear
  assert.ok(!paths.includes("qa/flows/flow-draft.yaml"));
  assert.ok(!paths.includes("qa/data/ds-unreferenced.yaml"));
  // no quarantine and no provenance manifest — those are not this ticket's job
  assert.ok(!paths.some((p) => p.startsWith("qa/quarantines/")));
  assert.ok(!paths.includes("qa/provenance.json"));
  // never a CI workflow file — CI policy change stays a separate action
  assert.ok(!paths.some((p) => p.startsWith(".github/")));
});

test("buildSetupPatchFiles produces a deterministic file order independent of input array order", () => {
  const inputs = fullInputs({ approvedFlowIds: ["flow-b", "flow-a"] });
  const packet = assembleSetupReviewPacket(inputs);
  const files = buildSetupPatchFiles({ packet, flows: inputs.flows, executionResults: inputs.executionResults, dataSets: inputs.dataSets, baselinePlan: inputs.baselinePlan });
  const paths = files.map((f) => f.path);
  const sorted = [...paths].sort();
  assert.deepEqual(paths, sorted);
});

test("listBundledSchemaFiles reads the bundle's own current schema files, at least one exists", () => {
  const files = listBundledSchemaFiles();
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(f.name.endsWith(".schema.json"));
    assert.ok(f.contents.length > 0);
  }
});
