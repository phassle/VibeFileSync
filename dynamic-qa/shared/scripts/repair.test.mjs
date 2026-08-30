// dynamic-qa/shared/scripts/repair.test.mjs
//
// Tier 1 coverage for guarded repair (#160): ineligible bundles refused
// (reusing #159's categories), a second causal hypothesis ends the
// invocation, every protected-contract category rejects a repair on
// digest drift, a repair widening its own tolerance is rejected, a repair
// whose negative control passes is rejected, a repair breaking neighbouring
// coverage is rejected, dependency/lockfile/workflow/profile/identity
// changes are excluded, the Repair Review Packet carries exactly the six
// required sections, and repair proposes only — it never applies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PROTECTED_CONTRACT_CATEGORIES,
  REPAIR_REVIEW_PACKET_SECTIONS,
  computeProtectedContractDigests,
  checkProtectedContractsUnchanged,
  checkSingleCausalHypothesis,
  checkRepairFilesAreMechanicalOnly,
  classifyRepairFilePath,
  reconstructProofObligations,
  declaredViolationDigest,
  checkNegativeControlNotWeakened,
  checkNeighboringCoverageUnbroken,
  validateRepairReviewPacket,
  evaluateRepairProposal,
} from "./repair.mjs";
import { computeBundleDigest } from "./failure-evidence.mjs";
import { SUPPORTED_SCHEMA as DIAGNOSIS_SCHEMA } from "./diagnosis.mjs";
import { buildNegativeControlPlan, EXECUTED_MODE } from "./negative-controls.mjs";

const SHA = "c".repeat(40);
const DIGEST = `sha256:${"a".repeat(64)}`;

// --- shared fixtures --------------------------------------------------------

const FLOW_DATA = {
  boundaries: [
    { id: "checkout-service", role: "owned" },
    { id: "email-provider", role: "dependency" },
  ],
  steps: [
    { id: "given-a", kind: "given", intent: "..." },
    {
      id: "then-b",
      kind: "then",
      intent: "...",
      outcomes: [
        { id: "outcome-exact", expect: "..." },
        { id: "outcome-numeric", expect: "...", tolerance: { kind: "numeric", abs_epsilon: 1 } },
      ],
    },
  ],
};

function baseDiagnosisRecord(overrides = {}) {
  return {
    schema: DIAGNOSIS_SCHEMA,
    diagnosisId: "diag-001",
    flowId: "checkout-happy-path",
    sourceCommit: SHA,
    generatedAt: "2026-08-30T00:00:00Z",
    owner: "binding",
    repeatability: "deterministic",
    repeatabilityBasis: "reproduction",
    failureClass: "binding-defect",
    status: "confirmed",
    bindingId: "checkout-happy-path-binding",
    causalChain: "Selector changed after a markup update; reproduced unchanged.",
    evidence: ["reproduced on pinned source commit"],
    counterEvidence: [],
    affectedIds: ["checkout-happy-path"],
    attempts: [{ attemptId: "a1", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" }],
    ...overrides,
  };
}

function baseBundle(overrides = {}) {
  const diagnosisOverrides = overrides.diagnosisRecord ?? {};
  const rest = { ...overrides };
  delete rest.diagnosisRecord;
  const withoutDigest = {
    schema: "dynamic-qa-failure-evidence-v1",
    bundleId: "bundle-001",
    repository: "phassle/VibeFileSync",
    sourceCommit: SHA,
    generatedAt: "2026-08-30T00:00:00Z",
    workflow: { provider: "github-actions", workflowFile: "dynamic-qa.yml", runId: "1234", runAttempt: "1" },
    flowId: "checkout-happy-path",
    bindingId: "checkout-happy-path-binding",
    profileId: "checkout-happy-path-profile",
    provenanceDigest: DIGEST,
    originalConclusion: "failed",
    diagnosisRecord: baseDiagnosisRecord(diagnosisOverrides),
    junitFacts: [{ suite: "checkout", name: "happy path", verdict: "failed", message: "assertion failed", durationMs: 120 }],
    expectedVsObserved: [{ expectedOutcomeId: "outcome-exact", expected: "confirmation banner visible", observed: "banner absent" }],
    fixtureBoundaryEnforcement: { boundariesEnforced: ["payment provider stubbed"], fixtureIsolation: "fresh namespace per run" },
    environmentHealth: { checkedAt: "2026-08-30T00:00:00Z", capabilities: [{ name: "runtime.node-available", status: "met" }] },
    approvedDiagnostics: [{ label: "console capture", digest: DIGEST }],
    ...rest,
  };
  return { ...withoutDigest, bundleDigest: computeBundleDigest(withoutDigest) };
}

const ASSERTIONS = [
  { stepId: "then-b", outcomeId: "outcome-exact", location: "checkout.spec.ts:10" },
  { stepId: "then-b", outcomeId: "outcome-numeric", location: "checkout.spec.ts:20" },
];

function correctPlan() {
  return buildNegativeControlPlan(FLOW_DATA);
}

function reportsMatchingPlan(plan) {
  return plan.map((v) => ({
    stepId: v.stepId,
    outcomeId: v.outcomeId,
    mode: EXECUTED_MODE,
    appliedViolation: { outcome: "assertion-failed", declaredViolationDigest: declaredViolationDigest(v) },
  }));
}

function protectedSnapshot(overrides = {}) {
  const snapshot = {};
  for (const category of PROTECTED_CONTRACT_CATEGORIES) snapshot[category] = { category, value: "unchanged" };
  return { ...snapshot, ...overrides };
}

function baseRepairInput(overrides = {}) {
  const plan = correctPlan();
  const snapshot = protectedSnapshot();
  return {
    bundle: baseBundle(),
    hypothesesConsidered: ["Selector changed after a markup update; reproduced unchanged."],
    proposedFiles: [{ path: "tests/checkout.spec.ts", content: "test('checkout', () => { /* fixed selector */ });" }],
    assertions: ASSERTIONS,
    flowData: FLOW_DATA,
    affectedOutcomeIds: ["outcome-exact"],
    protectedContractsBefore: snapshot,
    protectedContractsAfter: snapshot,
    negativeControlReports: reportsMatchingPlan(plan),
    neighboringFlows: [],
    residualRisk: ["none identified"],
    ...overrides,
  };
}

// --- 1. ineligible bundles refused (reuse #159's categories) ---------------

test("evaluateRepairProposal refuses a bundle whose diagnosis owner is product", () => {
  const result = evaluateRepairProposal(
    baseRepairInput({ bundle: baseBundle({ diagnosisRecord: { owner: "product", bindingId: undefined } }) }),
  );
  assert.equal(result.status, "refused");
  assert.equal(result.reasons[0].gate, "bundle-eligibility");
  assert.equal(result.packet, null);
});

test("evaluateRepairProposal refuses a bundle whose diagnosis status is provisional", () => {
  const result = evaluateRepairProposal(baseRepairInput({ bundle: baseBundle({ diagnosisRecord: { status: "provisional" } }) }));
  assert.equal(result.status, "refused");
  assert.equal(result.reasons[0].gate, "bundle-eligibility");
});

test("evaluateRepairProposal refuses a mutated (non-immutable) bundle", () => {
  const bundle = baseBundle();
  bundle.expectedVsObserved[0].observed = "tampered";
  const result = evaluateRepairProposal(baseRepairInput({ bundle }));
  assert.equal(result.status, "refused");
  assert.equal(result.reasons[0].gate, "bundle-eligibility");
});

test("evaluateRepairProposal accepts a confirmed binding-owned deterministic bundle when every other gate passes", () => {
  const result = evaluateRepairProposal(baseRepairInput());
  assert.equal(result.status, "proposal", JSON.stringify(result.reasons));
  assert.ok(result.packet);
});

// --- 2. one causal hypothesis --------------------------------------------

test("checkSingleCausalHypothesis accepts exactly one hypothesis", () => {
  const check = checkSingleCausalHypothesis(["stale selector", "stale selector"]);
  assert.equal(check.valid, true);
  assert.deepEqual(check.distinctHypotheses, ["stale selector"]);
});

test("checkSingleCausalHypothesis refuses a second, distinct causal theory", () => {
  const check = checkSingleCausalHypothesis(["stale selector", "race condition in fixture setup"]);
  assert.equal(check.valid, false);
  assert.equal(check.reason, "second-causal-hypothesis");
});

test("checkSingleCausalHypothesis refuses an empty hypothesis list", () => {
  const check = checkSingleCausalHypothesis([]);
  assert.equal(check.valid, false);
  assert.equal(check.reason, "no-hypothesis");
});

test("evaluateRepairProposal ends the invocation (refusal, not a retry) on a second causal hypothesis", () => {
  const result = evaluateRepairProposal(
    baseRepairInput({ hypothesesConsidered: ["stale selector", "actually a timing race"] }),
  );
  assert.equal(result.status, "refused");
  assert.equal(result.reasons[0].gate, "single-causal-hypothesis");
  assert.equal(result.reasons[0].detail.reason, "second-causal-hypothesis");
  assert.equal(result.packet, null);
});

// --- 3. protected-contract digests: one test per category ------------------

test("PROTECTED_CONTRACT_CATEGORIES enumerates all 15 named off-limits categories", () => {
  assert.deepEqual(
    [...PROTECTED_CONTRACT_CATEGORIES].sort(),
    [
      "boundaries",
      "dataMeaning",
      "dependencies",
      "enforcement",
      "flowSemantics",
      "identities",
      "levelOverrides",
      "lifecycle",
      "lockfiles",
      "networkAccess",
      "profiles",
      "quarantine",
      "requiredCheckPolicy",
      "tolerances",
      "workflows",
    ].sort(),
  );
});

test("checkProtectedContractsUnchanged passes when every category's digest matches", () => {
  const snap = protectedSnapshot();
  const result = checkProtectedContractsUnchanged(snap, snap);
  assert.equal(result.valid, true);
  assert.deepEqual(result.violations, []);
});

for (const category of PROTECTED_CONTRACT_CATEGORIES) {
  test(`checkProtectedContractsUnchanged rejects drift in the "${category}" category`, () => {
    const before = protectedSnapshot();
    const after = protectedSnapshot({ [category]: { category, value: "CHANGED" } });
    const result = checkProtectedContractsUnchanged(before, after);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((v) => v.category === category));
  });

  test(`evaluateRepairProposal refuses a repair when only "${category}" drifted`, () => {
    const before = protectedSnapshot();
    const after = protectedSnapshot({ [category]: { category, value: "CHANGED" } });
    const result = evaluateRepairProposal(baseRepairInput({ protectedContractsBefore: before, protectedContractsAfter: after }));
    assert.equal(result.status, "refused");
    assert.equal(result.reasons[0].gate, "protected-contracts");
    assert.ok(result.reasons[0].detail.violations.some((v) => v.category === category));
  });
}

test("a category absent from the before snapshot but present after is still caught as drift", () => {
  const before = {};
  const after = { flowSemantics: { changed: true } };
  const result = checkProtectedContractsUnchanged(before, after);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => v.category === "flowSemantics"));
});

// --- 4. mechanical-only path scope ------------------------------------------

test("classifyRepairFilePath refuses a Flow Definition path", () => {
  assert.equal(classifyRepairFilePath("qa/flows/checkout.yaml"), "flowSemantics");
});

test("classifyRepairFilePath refuses package.json and a lockfile", () => {
  assert.equal(classifyRepairFilePath("package.json"), "dependencies");
  assert.equal(classifyRepairFilePath("package-lock.json"), "lockfiles");
});

test("classifyRepairFilePath refuses a GitHub Actions workflow file", () => {
  assert.equal(classifyRepairFilePath(".github/workflows/dynamic-qa.yml"), "workflows");
});

test("classifyRepairFilePath allows an ordinary Binding test file", () => {
  assert.equal(classifyRepairFilePath("tests/checkout.spec.ts"), null);
});

test("checkRepairFilesAreMechanicalOnly refuses a proposed edit to a protected path", () => {
  const result = checkRepairFilesAreMechanicalOnly([
    { path: "tests/checkout.spec.ts", content: "ok" },
    { path: "package.json", content: "{}" },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].category, "dependencies");
});

for (const [label, path, category] of [
  ["dependency", "package.json", "dependencies"],
  ["lockfile", "pnpm-lock.yaml", "lockfiles"],
  ["workflow", ".github/workflows/nightly.yml", "workflows"],
  ["profile", "qa/execution-profiles/default.yaml", "profiles"],
  ["identity", "CODEOWNERS", "identities"],
]) {
  test(`evaluateRepairProposal excludes a ${label} change from repair`, () => {
    const result = evaluateRepairProposal(
      baseRepairInput({ proposedFiles: [{ path, content: "x" }] }),
    );
    assert.equal(result.status, "refused");
    assert.equal(result.reasons[0].gate, "mechanical-scope");
    assert.equal(result.reasons[0].detail.violations[0].category, category);
  });
}

// --- 5. THE tolerance-widening / control-weakening guard -------------------

test("checkNegativeControlNotWeakened accepts a report that applied the exact declared violation", () => {
  const plan = correctPlan();
  const reports = reportsMatchingPlan(plan);
  const result = checkNegativeControlNotWeakened(plan, reports);
  assert.equal(result.valid, true);
});

test("checkNegativeControlNotWeakened rejects a report that applied a different (weaker) violation than declared", () => {
  const plan = correctPlan();
  // Simulate a repair that widened its own numeric tolerance: the harness
  // reports "assertion-failed" (so #152's own judge would accept it), but
  // the digest it attests to does not match what the flow's OWN tolerance
  // actually requires — e.g. it perturbed by less than abs_epsilon=1, or
  // against a different outcome's bound altogether.
  const reports = [
    {
      stepId: "then-b",
      outcomeId: "outcome-numeric",
      mode: EXECUTED_MODE,
      appliedViolation: { outcome: "assertion-failed", declaredViolationDigest: "sha256:" + "0".repeat(64) },
    },
  ];
  const result = checkNegativeControlNotWeakened(plan, reports);
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].outcomeId, "outcome-numeric");
});

test("declaredViolationDigest changes when the tolerance's own bound changes", () => {
  const wide = { stepId: "then-b", outcomeId: "outcome-numeric", kind: "numeric", statement: "...abs_epsilon=1..." };
  const widened = { ...wide, statement: "...abs_epsilon=1000..." };
  assert.notEqual(declaredViolationDigest(wide), declaredViolationDigest(widened));
});

test("evaluateRepairProposal rejects a repair whose negative control does not match the flow's own declared violation (tolerance-widening guard)", () => {
  const plan = correctPlan();
  const weakenedReports = plan.map((v) => ({
    stepId: v.stepId,
    outcomeId: v.outcomeId,
    mode: EXECUTED_MODE,
    // Reports "assertion-failed" (would satisfy #152's own judge in
    // isolation) but attests to a digest that does not match the declared
    // violation — exactly the widened-tolerance / weakened-assertion case.
    appliedViolation: { outcome: "assertion-failed", declaredViolationDigest: "sha256:" + "1".repeat(64) },
  }));
  const result = evaluateRepairProposal(baseRepairInput({ negativeControlReports: weakenedReports }));
  assert.equal(result.status, "refused");
  assert.equal(result.reasons[0].gate, "negative-control-not-weakened");
});

// --- 6. a repair without a failing negative control is refused ------------

test("evaluateRepairProposal rejects a repair whose negative control's assertion passed instead of failing", () => {
  const plan = correctPlan();
  const passingReports = plan.map((v) => ({
    stepId: v.stepId,
    outcomeId: v.outcomeId,
    mode: EXECUTED_MODE,
    appliedViolation: { outcome: "assertion-passed", declaredViolationDigest: declaredViolationDigest(v) },
  }));
  const result = evaluateRepairProposal(baseRepairInput({ negativeControlReports: passingReports }));
  assert.equal(result.status, "refused");
  assert.equal(result.reasons[0].gate, "negative-control-coverage");
});

test("evaluateRepairProposal rejects a repair with a missing negative control report", () => {
  const result = evaluateRepairProposal(baseRepairInput({ negativeControlReports: [] }));
  assert.equal(result.status, "refused");
  assert.equal(result.reasons[0].gate, "negative-control-coverage");
});

// --- 7. neighbouring coverage must not break --------------------------------

test("checkNeighboringCoverageUnbroken passes when every neighbour's coverage still holds", () => {
  const result = checkNeighboringCoverageUnbroken([{ flowId: "other-flow", flowData: FLOW_DATA, assertions: ASSERTIONS }]);
  assert.equal(result.valid, true);
});

test("checkNeighboringCoverageUnbroken flags a neighbour whose coverage broke", () => {
  const result = checkNeighboringCoverageUnbroken([
    { flowId: "other-flow", flowData: FLOW_DATA, assertions: [ASSERTIONS[0]] },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.violations[0].flowId, "other-flow");
});

test("evaluateRepairProposal rejects a repair that breaks a neighbouring flow's coverage", () => {
  const result = evaluateRepairProposal(
    baseRepairInput({ neighboringFlows: [{ flowId: "other-flow", flowData: FLOW_DATA, assertions: [ASSERTIONS[0]] }] }),
  );
  assert.equal(result.status, "refused");
  assert.equal(result.reasons[0].gate, "neighboring-coverage");
});

// --- 8. the Repair Review Packet has exactly the six required sections ----

test("validateRepairReviewPacket requires exactly the six named sections", () => {
  assert.deepEqual(
    [...REPAIR_REVIEW_PACKET_SECTIONS].sort(),
    ["diff", "evidence", "mappings", "protectedContractDigests", "residualRisk", "verification"].sort(),
  );
  const missing = validateRepairReviewPacket({ evidence: {}, mappings: [], diff: [] });
  assert.equal(missing.valid, false);
  const extra = validateRepairReviewPacket({
    evidence: {},
    mappings: [],
    protectedContractDigests: {},
    diff: [],
    verification: {},
    residualRisk: [],
    somethingElse: true,
  });
  assert.equal(extra.valid, false);
});

test("a successful evaluateRepairProposal emits a packet with exactly the six required sections", () => {
  const result = evaluateRepairProposal(baseRepairInput());
  assert.equal(result.status, "proposal");
  const check = validateRepairReviewPacket(result.packet);
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.deepEqual(Object.keys(result.packet).sort(), [...REPAIR_REVIEW_PACKET_SECTIONS].sort());
});

test("reconstructProofObligations reconstructs the protected proof obligation read-only from the Flow contract", () => {
  const obligations = reconstructProofObligations(FLOW_DATA, ["outcome-numeric"]);
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].outcomeId, "outcome-numeric");
  assert.equal(obligations[0].kind, "numeric");
});

// --- 9. repair proposes only — it never applies ----------------------------

test("repair.mjs imports no filesystem or process-execution capability — structurally cannot write or run anything", () => {
  const source = readFileSync(fileURLToPath(new URL("./repair.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:fs["']/);
  assert.doesNotMatch(source, /from\s+["']node:child_process["']/);
  assert.doesNotMatch(source, /\bwriteFile\b/);
  assert.doesNotMatch(source, /\bexecSync\b/);
});

test("a refused repair never emits a packet — a refusal is no proposal at all, not a weaker one", () => {
  const result = evaluateRepairProposal(baseRepairInput({ neighboringFlows: [{ flowId: "x", flowData: FLOW_DATA, assertions: [] }] }));
  assert.equal(result.status, "refused");
  assert.equal(result.packet, null);
});

test("a successful proposal's diff section is exactly the caller-supplied proposedFiles, unmodified — evaluateRepairProposal never writes them anywhere", () => {
  const proposedFiles = [{ path: "tests/checkout.spec.ts", content: "test('checkout', () => {});" }];
  const result = evaluateRepairProposal(baseRepairInput({ proposedFiles }));
  assert.equal(result.status, "proposal");
  assert.deepEqual(result.packet.diff, proposedFiles);
});
