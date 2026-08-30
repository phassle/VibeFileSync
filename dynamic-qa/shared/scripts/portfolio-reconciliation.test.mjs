// dynamic-qa/shared/scripts/portfolio-reconciliation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicateFlows,
  findContradictoryOutcomes,
  findBoundaryTreatmentConflicts,
  findIsolationNamespaceCollisions,
  findDataSetIssues,
  classifyCandidateLane,
  findLaneAssignmentConflicts,
  findStateDeclarationConflicts,
  reconcilePortfolio,
  issuesForFlow,
  evaluateFlowForPortfolio,
  recordFlowApproval,
  evaluatePortfolioApproval,
  buildFlowReview,
} from "./portfolio-reconciliation.mjs";
import { assembleAndRenderFlowDefinition } from "./flow-assembly.mjs";
import { renderFlowDefinitionYAML } from "./flow-yaml.mjs";

const TICKET = "https://github.com/phassle/VibeFileSync/issues/18";

// findDataSetIssues (and therefore reconcilePortfolio) now requires a real
// resolver (finding #1, closed) — every test flow below declares
// `data_sets: []`, so the resolver's own behaviour never matters to these
// tests; it exists only to prove the tests are not relying on the old
// fail-open.
const alwaysFoundDataSet = () => ({ found: true });

function ownedBoundary(overrides = {}) {
  return {
    id: "vibesync-cli",
    system: "vibesync CLI",
    treatment: "real",
    behavior: "Invoke the CLI.",
    side_effects: "none",
    role: "owned",
    ...overrides,
  };
}

function flow(overrides = {}) {
  return {
    schema: "dynamic-qa-flow-v1",
    id: "flow-a",
    revision: 1,
    title: "Flow A",
    intent: "Protect flow A.",
    criticality: "high",
    state: "draft",
    origin: { tickets: [TICKET] },
    test_level: { selection: "inferred" },
    data_sets: [],
    boundaries: [ownedBoundary()],
    steps: [
      { id: "given-setup", kind: "given", intent: "A precondition holds." },
      {
        id: "then-outcome",
        kind: "then",
        intent: "The outcome occurs.",
        outcomes: [{ id: "outcome-occurs", expect: "The outcome text is shown." }],
      },
    ],
    ...overrides,
  };
}

// --- findDuplicateFlows ----------------------------------------------------

test("findDuplicateFlows: identical GWT content under two different ids is a duplicate", () => {
  const a = flow({ id: "flow-a", title: "Flow A" });
  const b = flow({ id: "flow-b", title: "A completely different title" }); // same steps/outcomes
  const issues = findDuplicateFlows([a, b]);
  const dup = issues.find((i) => i.type === "duplicate-flow-content");
  assert.ok(dup, "expected a duplicate-flow-content issue");
  assert.deepEqual(dup.flowIds.sort(), ["flow-a", "flow-b"]);
});

test("findDuplicateFlows: the same flow id declared twice is flagged", () => {
  const a = flow({ id: "flow-a" });
  const aAgain = flow({ id: "flow-a", title: "Renamed but same id" });
  const issues = findDuplicateFlows([a, aAgain]);
  assert.ok(issues.some((i) => i.type === "duplicate-flow-id" && i.flowIds.includes("flow-a")));
});

test("findDuplicateFlows: genuinely different flows are not flagged", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({
    id: "flow-b",
    steps: [
      { id: "given-setup", kind: "given", intent: "A different precondition holds." },
      {
        id: "then-outcome",
        kind: "then",
        intent: "A different outcome occurs.",
        outcomes: [{ id: "different-outcome", expect: "Different text is shown." }],
      },
    ],
  });
  assert.deepEqual(findDuplicateFlows([a, b]), []);
});

// --- findContradictoryOutcomes ---------------------------------------------

test("findContradictoryOutcomes: same outcome id, different wording across flows, is contradictory", () => {
  const a = flow({
    id: "flow-a",
    steps: [{ id: "then-outcome", kind: "then", intent: "Check result.", outcomes: [{ id: "shared-outcome", expect: "The upload succeeds." }] }],
  });
  const b = flow({
    id: "flow-b",
    steps: [{ id: "then-outcome", kind: "then", intent: "Check result.", outcomes: [{ id: "shared-outcome", expect: "The upload fails." }] }],
  });
  const issues = findContradictoryOutcomes([a, b]);
  const contradiction = issues.find((i) => i.type === "contradictory-expected-outcome");
  assert.ok(contradiction, "expected a contradictory-expected-outcome issue");
  assert.deepEqual(contradiction.flowIds.sort(), ["flow-a", "flow-b"]);
  assert.equal(contradiction.details.length, 2);
});

test("findContradictoryOutcomes: identical wording (even case/whitespace variants) across flows is not a contradiction", () => {
  const a = flow({
    id: "flow-a",
    steps: [{ id: "then-outcome", kind: "then", intent: "Check.", outcomes: [{ id: "shared-outcome", expect: "The upload succeeds." }] }],
  });
  const b = flow({
    id: "flow-b",
    steps: [{ id: "then-outcome", kind: "then", intent: "Check.", outcomes: [{ id: "shared-outcome", expect: "  the UPLOAD   succeeds. " }] }],
  });
  assert.deepEqual(findContradictoryOutcomes([a, b]), []);
});

test("findContradictoryOutcomes: an outcome id used only within one flow is never flagged", () => {
  const a = flow({ id: "flow-a" });
  assert.deepEqual(findContradictoryOutcomes([a]), []);
});

// --- findBoundaryTreatmentConflicts -----------------------------------------

test("findBoundaryTreatmentConflicts: same dependency id classified real in one flow and simulated in another", () => {
  const a = flow({ id: "flow-a", boundaries: [ownedBoundary(), { id: "billing-provider", system: "Billing", treatment: "real", behavior: "b", side_effects: "none" }] });
  const b = flow({ id: "flow-b", boundaries: [ownedBoundary({ id: "other-owned" }), { id: "billing-provider", system: "Billing", treatment: "simulated", behavior: "b", side_effects: "none" }] });
  const issues = findBoundaryTreatmentConflicts([a, b]);
  const conflict = issues.find((i) => i.type === "conflicting-boundary-treatment");
  assert.ok(conflict, "expected a conflicting-boundary-treatment issue");
  assert.deepEqual(conflict.flowIds.sort(), ["flow-a", "flow-b"]);
});

test("findBoundaryTreatmentConflicts: same dependency id, same treatment and volatility, is not a conflict", () => {
  const a = flow({ id: "flow-a", boundaries: [ownedBoundary(), { id: "clock", system: "Clock", treatment: "simulated", behavior: "b", side_effects: "none", volatile: true }] });
  const b = flow({ id: "flow-b", boundaries: [ownedBoundary({ id: "other-owned" }), { id: "clock", system: "Clock", treatment: "simulated", behavior: "b", side_effects: "none", volatile: true }] });
  assert.deepEqual(findBoundaryTreatmentConflicts([a, b]), []);
});

// --- findIsolationNamespaceCollisions ---------------------------------------

test("findIsolationNamespaceCollisions: identical namespace across two real side-effecting boundaries collides", () => {
  const a = flow({
    id: "flow-a",
    boundaries: [ownedBoundary({ side_effects: "writes a row", isolation: { namespace: "shared-ns", cleanup: "delete row" } })],
  });
  const b = flow({
    id: "flow-b",
    boundaries: [ownedBoundary({ id: "other-owned", side_effects: "writes a row", isolation: { namespace: "shared-ns", cleanup: "delete row" } })],
  });
  const issues = findIsolationNamespaceCollisions([a, b]);
  assert.ok(issues.some((i) => i.type === "shared-isolation-namespace"));
});

test("findIsolationNamespaceCollisions: distinct namespaces do not collide", () => {
  const a = flow({ id: "flow-a", boundaries: [ownedBoundary({ side_effects: "writes a row", isolation: { namespace: "ns-a", cleanup: "delete row" } })] });
  const b = flow({ id: "flow-b", boundaries: [ownedBoundary({ id: "other-owned", side_effects: "writes a row", isolation: { namespace: "ns-b", cleanup: "delete row" } })] });
  assert.deepEqual(findIsolationNamespaceCollisions([a, b]), []);
});

// --- findDataSetIssues -------------------------------------------------------

test("findDataSetIssues: an unresolved data set reference is named", () => {
  const a = flow({ id: "flow-a", data_sets: ["missing-set"] });
  const resolveDataSet = (id) => ({ found: id !== "missing-set" });
  const issues = findDataSetIssues([a], resolveDataSet);
  assert.ok(issues.some((i) => i.type === "unresolved-data-set-reference" && i.flowIds.includes("flow-a")));
});

test("findDataSetIssues: fails closed (throws a named error) when no resolver is supplied, rather than silently skipping (finding #1, closed)", () => {
  const a = flow({ id: "flow-a", data_sets: ["whatever"] });
  assert.throws(() => findDataSetIssues([a], undefined), /requires a resolveDataSet/);
  assert.throws(() => findDataSetIssues([a], null), /requires a resolveDataSet/);
});

test("findDataSetIssues: a resolved data set reference is not flagged", () => {
  const a = flow({ id: "flow-a", data_sets: ["known-set"] });
  const resolveDataSet = () => ({ found: true });
  assert.deepEqual(findDataSetIssues([a], resolveDataSet), []);
});

// --- classifyCandidateLane / findLaneAssignmentConflicts --------------------

test("classifyCandidateLane: a real side-effecting boundary makes a flow a nightly candidate", () => {
  const a = flow({ boundaries: [ownedBoundary({ side_effects: "writes a row" })] });
  assert.equal(classifyCandidateLane(a), "nightly-candidate");
});

test("classifyCandidateLane: no real side effects and no e2e override is a pr-fast candidate", () => {
  const a = flow();
  assert.equal(classifyCandidateLane(a), "pr-fast-candidate");
});

test("classifyCandidateLane: an explicit e2e test-level override is a nightly candidate even with no real side effects", () => {
  const a = flow({ test_level: { selection: "override", value: "browser-e2e", reason: "true end-to-end journey required" } });
  assert.equal(classifyCandidateLane(a), "nightly-candidate");
});

test("findLaneAssignmentConflicts: flows that would otherwise land in different lanes, apart from the dependency they share, conflict", () => {
  // flow-a: shared-dep is its ONLY real side-effecting boundary — apart
  // from it, flow-a is a pr-fast candidate.
  const a = flow({
    id: "flow-a",
    boundaries: [ownedBoundary(), { id: "shared-dep", system: "Shared", treatment: "real", behavior: "b", side_effects: "writes a row" }],
  });
  // flow-b: ALSO has its own separate real side-effecting boundary, so even
  // apart from shared-dep, flow-b is independently a nightly candidate.
  const b = flow({
    id: "flow-b",
    boundaries: [
      ownedBoundary({ id: "other-owned" }),
      { id: "shared-dep", system: "Shared", treatment: "real", behavior: "b", side_effects: "writes a row" },
      { id: "flow-b-own-real-dep", system: "Other", treatment: "real", behavior: "b", side_effects: "writes another row" },
    ],
  });
  const issues = findLaneAssignmentConflicts([a, b]);
  const conflict = issues.find((i) => i.type === "lane-assignment-conflict");
  assert.ok(conflict, "expected a lane-assignment-conflict issue");
  assert.deepEqual(conflict.flowIds.sort(), ["flow-a", "flow-b"]);
});

test("findLaneAssignmentConflicts: flows that would land in the same lane apart from a shared dependency do not conflict", () => {
  const a = flow({ id: "flow-a", boundaries: [ownedBoundary({ id: "shared-dep", side_effects: "writes a row" })] });
  const b = flow({ id: "flow-b", boundaries: [ownedBoundary({ id: "other-owned" }), { id: "shared-dep", system: "Shared", treatment: "real", behavior: "b", side_effects: "writes a row" }] });
  assert.deepEqual(findLaneAssignmentConflicts([a, b]), []);
});

// --- findStateDeclarationConflicts ------------------------------------------

test("findStateDeclarationConflicts: a non-draft state on an implicated flow is flagged", () => {
  const a = flow({ id: "flow-a", state: "active" });
  const priorIssues = [{ type: "duplicate-flow-content", message: "x", flowIds: ["flow-a"] }];
  const issues = findStateDeclarationConflicts([a], priorIssues);
  assert.ok(issues.some((i) => i.type === "state-declaration-conflict" && i.flowIds.includes("flow-a")));
});

test("findStateDeclarationConflicts: draft state on an implicated flow is not itself flagged again", () => {
  const a = flow({ id: "flow-a", state: "draft" });
  const priorIssues = [{ type: "duplicate-flow-content", message: "x", flowIds: ["flow-a"] }];
  assert.deepEqual(findStateDeclarationConflicts([a], priorIssues), []);
});

test("findStateDeclarationConflicts: a non-draft state on a flow with no issues is not flagged", () => {
  const a = flow({ id: "flow-a", state: "active" });
  assert.deepEqual(findStateDeclarationConflicts([a], []), []);
});

// --- reconcilePortfolio: the aggregate --------------------------------------

test("reconcilePortfolio: fails closed (throws) when resolveDataSet is omitted, rather than silently skipping the data-set check (finding #1, closed)", () => {
  const a = flow({ id: "flow-a", data_sets: ["some-set"] });
  assert.throws(() => reconcilePortfolio([a]), /requires a resolveDataSet/);
  assert.throws(() => reconcilePortfolio([a], {}), /requires a resolveDataSet/);
});

test("reconcilePortfolio: a coherent portfolio reports no issues", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({
    id: "flow-b",
    boundaries: [ownedBoundary({ id: "other-owned" })],
    steps: [
      { id: "given-setup", kind: "given", intent: "A different precondition holds." },
      { id: "then-outcome", kind: "then", intent: "A different check.", outcomes: [{ id: "flow-b-outcome", expect: "Different text." }] },
    ],
  });
  const report = reconcilePortfolio([a, b], { resolveDataSet: alwaysFoundDataSet });
  assert.equal(report.isPortfolioCoherent, true);
  assert.deepEqual(report.issues, []);
});

test("reconcilePortfolio: a duplicate pair is surfaced and attributed to both flow ids", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({ id: "flow-b" });
  const report = reconcilePortfolio([a, b], { resolveDataSet: alwaysFoundDataSet });
  assert.equal(report.isPortfolioCoherent, false);
  assert.deepEqual(issuesForFlow(report, "flow-a").map((i) => i.type), issuesForFlow(report, "flow-b").map((i) => i.type));
  assert.ok(issuesForFlow(report, "flow-a").some((i) => i.type === "duplicate-flow-content"));
});

test("reconcilePortfolio: an uninvolved flow carries no issues even when the portfolio overall is incoherent", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({ id: "flow-b" }); // duplicate of a
  const c = flow({
    id: "flow-c",
    boundaries: [ownedBoundary({ id: "flow-c-owned" })],
    steps: [
      { id: "given-setup", kind: "given", intent: "Something else entirely." },
      { id: "then-outcome", kind: "then", intent: "Another check.", outcomes: [{ id: "flow-c-outcome", expect: "Some other text." }] },
    ],
  });
  const report = reconcilePortfolio([a, b, c], { resolveDataSet: alwaysFoundDataSet });
  assert.equal(report.isPortfolioCoherent, false);
  assert.deepEqual(issuesForFlow(report, "flow-c"), []);
});

test("issuesForFlow: fails closed on a malformed or missing report rather than reading as 'no issues'", () => {
  assert.throws(() => issuesForFlow(undefined, "flow-a"));
  assert.throws(() => issuesForFlow({}, "flow-a"));
  assert.throws(() => issuesForFlow({ issues: [] }, "flow-a"));
});

// --- the draft-retention rule is structurally impossible to bypass ---------

test("evaluateFlowForPortfolio: a flow named in an unresolved issue is never eligible", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({ id: "flow-b" });
  const report = reconcilePortfolio([a, b], { resolveDataSet: alwaysFoundDataSet });
  const evaluation = evaluateFlowForPortfolio("flow-a", report);
  assert.equal(evaluation.eligible, false);
  assert.ok(evaluation.issues.length > 0);
});

test("recordFlowApproval: an unresolved flow stays draft even with a fully valid qa-owner approval record", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({ id: "flow-b" });
  const report = reconcilePortfolio([a, b], { resolveDataSet: alwaysFoundDataSet });
  const result = recordFlowApproval("flow-a", report, { approvedBy: "Per", role: "qa-owner", timestamp: "2026-08-30T00:00:00Z" });
  assert.equal(result.approved, false);
  assert.equal(result.state, "draft");
});

test("recordFlowApproval: an unresolved flow stays draft regardless of any extra/forceful field an approval object might carry", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({ id: "flow-b" });
  const report = reconcilePortfolio([a, b], { resolveDataSet: alwaysFoundDataSet });
  // Simulate a caller trying to smuggle an override through the approval
  // payload — evaluateFlowForPortfolio runs first and ignores it entirely.
  const result = recordFlowApproval("flow-a", report, {
    approvedBy: "Per",
    role: "qa-owner",
    forceApprove: true,
    override: "resolved",
    ignoreIssues: true,
  });
  assert.equal(result.approved, false);
  assert.equal(result.state, "draft");
});

test("recordFlowApproval: a resolved flow is approved only with a valid qa-owner/technical-owner record", () => {
  const a = flow({ id: "flow-a" });
  const report = reconcilePortfolio([a], { resolveDataSet: alwaysFoundDataSet });
  assert.equal(report.isPortfolioCoherent, true);

  const missingApproval = recordFlowApproval("flow-a", report, undefined);
  assert.equal(missingApproval.approved, false);
  assert.equal(missingApproval.state, "draft");

  const wrongRole = recordFlowApproval("flow-a", report, { approvedBy: "Dana", role: "domain-expert" });
  assert.equal(wrongRole.approved, false);
  assert.equal(wrongRole.state, "draft");

  const valid = recordFlowApproval("flow-a", report, { approvedBy: "Per", role: "technical-owner", timestamp: "2026-08-30" });
  assert.equal(valid.approved, true);
  assert.equal(valid.approvedBy, "Per");
  assert.equal(valid.role, "technical-owner");
});

test("evaluatePortfolioApproval: one draft-retained flow keeps the whole portfolio not-fully-approved", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({ id: "flow-b" }); // duplicate of a: stays draft
  const c = flow({
    id: "flow-c",
    boundaries: [ownedBoundary({ id: "flow-c-owned" })],
    steps: [
      { id: "given-setup", kind: "given", intent: "Something else entirely." },
      { id: "then-outcome", kind: "then", intent: "Another check.", outcomes: [{ id: "flow-c-outcome", expect: "Some other text." }] },
    ],
  });
  const report = reconcilePortfolio([a, b, c], { resolveDataSet: alwaysFoundDataSet });
  const approvals = {
    "flow-a": { approvedBy: "Per", role: "qa-owner" },
    "flow-b": { approvedBy: "Per", role: "qa-owner" },
    "flow-c": { approvedBy: "Per", role: "qa-owner" },
  };
  const result = evaluatePortfolioApproval([a, b, c], report, approvals);
  assert.equal(result.portfolioFullyApproved, false);
  assert.deepEqual(result.draftFlowIds.sort(), ["flow-a", "flow-b"]);
  assert.deepEqual(result.approvedFlowIds, ["flow-c"]);
});

test("evaluatePortfolioApproval: a fully coherent, fully approved portfolio is fully approved", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({
    id: "flow-b",
    boundaries: [ownedBoundary({ id: "other-owned" })],
    steps: [
      { id: "given-setup", kind: "given", intent: "A different precondition holds." },
      { id: "then-outcome", kind: "then", intent: "A different check.", outcomes: [{ id: "flow-b-outcome", expect: "Different text." }] },
    ],
  });
  const report = reconcilePortfolio([a, b], { resolveDataSet: alwaysFoundDataSet });
  const approvals = {
    "flow-a": { approvedBy: "Per", role: "qa-owner" },
    "flow-b": { approvedBy: "Per", role: "technical-owner" },
  };
  const result = evaluatePortfolioApproval([a, b], report, approvals);
  assert.equal(result.portfolioFullyApproved, true);
  assert.deepEqual(result.draftFlowIds, []);
  assert.deepEqual(result.approvedFlowIds.sort(), ["flow-a", "flow-b"]);
});

// --- buildFlowReview: byte-identical to what would be written --------------

test("buildFlowReview: the reviewed YAML is byte-identical to flow-yaml.mjs's direct renderer", () => {
  const a = flow({ id: "flow-a" });
  const report = reconcilePortfolio([a], { resolveDataSet: alwaysFoundDataSet });
  const review = buildFlowReview(a, report);
  assert.equal(review.yaml, renderFlowDefinitionYAML(a));
});

test("buildFlowReview: reviewing a real stage-5-assembled flow reuses the exact renderer #164 built for writing", () => {
  const interview = {
    id: "update-preserves-safetynet",
    revision: 1,
    title: "Update preserves prior version",
    intent: "Prevent silent loss of prior destination content.",
    criticality: "high",
    state: "draft",
    originTickets: [TICKET],
    testLevel: { selection: "inferred" },
    dataSets: [],
    boundaries: [ownedBoundary()],
    steps: [
      { id: "given-setup", kind: "given", intent: "A folder pair uses Update mode." },
      { id: "then-outcome", kind: "then", intent: "Prior content is preserved.", outcomes: [{ id: "prior-content-preserved", expect: "SafetyNet contains the prior content." }] },
    ],
  };
  const assembled = assembleAndRenderFlowDefinition(interview);
  assert.equal(assembled.valid, true);

  const report = reconcilePortfolio([assembled.flow], { resolveDataSet: alwaysFoundDataSet });
  const review = buildFlowReview(assembled.flow, report);

  // Byte-identical to what stage 5 already rendered and proved round-trips.
  assert.equal(review.yaml, assembled.yaml);
  // And identical to calling the renderer directly a second time.
  assert.equal(review.yaml, renderFlowDefinitionYAML(assembled.flow));
});

test("buildFlowReview: surfaces the reconciliation issues for that flow alongside its exact YAML", () => {
  const a = flow({ id: "flow-a" });
  const b = flow({ id: "flow-b" }); // duplicate
  const report = reconcilePortfolio([a, b], { resolveDataSet: alwaysFoundDataSet });
  const review = buildFlowReview(a, report);
  assert.ok(review.issues.length > 0);
  assert.equal(review.yaml, renderFlowDefinitionYAML(a));
});
