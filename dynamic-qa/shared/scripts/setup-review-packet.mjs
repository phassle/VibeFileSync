// dynamic-qa/shared/scripts/setup-review-packet.mjs
//
// qa-setup stage 10 (ticket #169, SPEC-135 User Stories 47-48): "one Setup
// Review Packet covering contract, data, safety, harness, dependency, CI,
// and unresolved requirements, so approval is informed" and "setup emits a
// patch and stops, so generation, merging, policy changes, and pilot
// execution remain separate actions." This module is the deterministic
// core stage 10's own SKILL.md prose calls — everything checkable by rule
// lives here (run brief decision #5), never in prose.
//
// This is the FIRST point in qa-setup where a repository write is even
// POSSIBLE. Every earlier stage (#162-#168) either reads only, or — in
// #167's Baseline Plan alone, a documented, deliberate exception required
// by SPEC-135 story 44 ("setup resumable... measurement can span days
// without hidden session state") — writes ONE resumable bookkeeping file
// (`qa/baseline-plan.yaml`) so burn-in evidence can accumulate across
// sessions. Every OTHER customer-repository artifact this bundle produces
// (Flow Definitions, Named Data Sets, Execution Profiles, the bundled
// schemas) is held only in memory until THIS module's `emitSetupReviewPacket`
// says both approvals are satisfied and measurement is ready. See
// DECISIONS.md #30 for the full accounting of that one exception.
//
// This module composes; it re-derives nothing:
//   - #165's `evaluatePortfolioApproval` is the ONLY source of which flows
//     are approved vs. draft.
//   - #166's `designExecutionProfile` results are the ONLY source of each
//     flow's Execution Profile and its activation decision.
//   - #167's Baseline Plan / `computeReadiness` is the ONLY source of
//     measurement readiness.
//   - #168's `designProviderNativeCI` result is the ONLY source of the CI
//     proposal.
//   - #162's `authority.mjs` GATE_KEYS / `validateAuthorityRecord` /
//     `gatesAreIndependent` are the ONLY approval-gate model. That module's
//     own header names "the Setup Review Packet here" as one of the two
//     places these gates are reused — this ticket is that reuse, not a
//     second approval model.
//   - flow-yaml.mjs's `renderRestrictedYAMLDocument` (the bundle's one
//     rendering path, per #166's landed note) renders Named Data Sets here
//     too; no second renderer is introduced for them.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GATE_KEYS, validateAuthorityRecord, gatesAreIndependent } from "./authority.mjs";
import { renderRestrictedYAMLDocument } from "./flow-yaml.mjs";
import { computeReadiness, renderBaselinePlanYAML, metricStatus } from "./baseline-plan.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMAS_DIR = path.join(__dirname, "..", "schemas");

// --- the seven required areas, named once ----------------------------------

export const REQUIRED_PACKET_AREAS = Object.freeze([
  "contract",
  "data",
  "safety",
  "harness",
  "dependency",
  "ci",
  "unresolvedRequirements",
]);

// Fact categories stage 2's inventory produces that describe the EXISTING
// test harness (frameworks, fixtures, mocks, clocks, cleanup, reporting,
// and what current tests already prove) — as opposed to CI infrastructure
// facts, which the dependency area reads from the CI proposal's own
// `namedInfrastructure` (already summarized by #168, never re-derived here).
const HARNESS_FACT_CATEGORIES = Object.freeze([
  "test-framework",
  "mock",
  "clock",
  "cleanup",
  "fixture",
  "reporting",
  "existing-test",
  "existing-test-outcome",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// --- per-area builders -------------------------------------------------
//
// Each builder throws a plain Error naming exactly what is missing or
// malformed. assembleSetupReviewPacket (below) catches each area
// independently so a reviewer sees EVERY missing area in one pass — the
// same "every issue in one pass" shape #166's stage 7 composition already
// established — rather than stopping at the first bad input.

function buildContractArea({ flows, portfolioApproval } = {}) {
  if (!Array.isArray(flows)) {
    throw new Error("contract area requires the full array of assembled Flow Definitions");
  }
  if (
    !portfolioApproval ||
    !Array.isArray(portfolioApproval.approvedFlowIds) ||
    !Array.isArray(portfolioApproval.draftFlowIds) ||
    typeof portfolioApproval.portfolioFullyApproved !== "boolean"
  ) {
    throw new Error("contract area requires a portfolioApproval produced by portfolio-reconciliation.mjs's evaluatePortfolioApproval");
  }
  return {
    totalFlows: flows.length,
    approvedFlowIds: [...portfolioApproval.approvedFlowIds],
    draftFlowIds: [...portfolioApproval.draftFlowIds],
    portfolioFullyApproved: portfolioApproval.portfolioFullyApproved,
    flows: flows.map((flow) => ({
      id: flow.id,
      title: flow.title,
      criticality: flow.criticality,
      state: flow.state,
    })),
  };
}

function buildDataArea({ dataSets } = {}) {
  if (!Array.isArray(dataSets)) {
    throw new Error("data area requires an array of validated Named Data Set objects (may be empty)");
  }
  for (const dataSet of dataSets) {
    if (!isPlainObject(dataSet) || typeof dataSet.id !== "string") {
      throw new Error("data area requires every Named Data Set to be a plain object with an id");
    }
  }
  return {
    totalDataSets: dataSets.length,
    dataSetIds: dataSets.map((d) => d.id),
  };
}

function buildSafetyArea({ executionResults } = {}) {
  if (!Array.isArray(executionResults)) {
    throw new Error("safety area requires the array of #166 designExecutionProfile results for every approved flow");
  }
  const activatedFlowIds = [];
  const deferredFlowIds = [];
  const blockersByFlowId = {};
  for (const result of executionResults) {
    if (!result || typeof result.flowId !== "string" || !result.decision || typeof result.decision.activate !== "boolean") {
      throw new Error("safety area requires every entry to be a real designExecutionProfile result ({ flowId, profile, profileYaml, decision })");
    }
    if (result.decision.activate) {
      activatedFlowIds.push(result.flowId);
    } else {
      deferredFlowIds.push(result.flowId);
      blockersByFlowId[result.flowId] = result.decision.blockers ?? [];
    }
  }
  return {
    totalProfiles: executionResults.length,
    activatedFlowIds,
    deferredFlowIds,
    blockersByFlowId,
  };
}

function buildHarnessArea({ harnessFacts } = {}) {
  if (!Array.isArray(harnessFacts)) {
    throw new Error("harness area requires the array of Setup Inventory facts (stage 2's inventory.facts, may be empty)");
  }
  const byCategory = {};
  for (const fact of harnessFacts) {
    if (!fact || typeof fact.category !== "string") continue;
    if (!HARNESS_FACT_CATEGORIES.includes(fact.category)) continue;
    if (!byCategory[fact.category]) byCategory[fact.category] = [];
    byCategory[fact.category].push(fact.id);
  }
  const totalFacts = Object.values(byCategory).reduce((sum, ids) => sum + ids.length, 0);
  return { totalFacts, byCategory };
}

function buildDependencyArea({ ciProposal } = {}) {
  if (!ciProposal || !isPlainObject(ciProposal.namedInfrastructure) || !isPlainObject(ciProposal.runnerMatchesInventory)) {
    throw new Error("dependency area requires a ciProposal produced by ci-design.mjs's designProviderNativeCI");
  }
  return {
    runners: [...ciProposal.namedInfrastructure.runners],
    environments: [...ciProposal.namedInfrastructure.environments],
    triggers: [...ciProposal.namedInfrastructure.triggers],
    existingWorkflowPaths: [...ciProposal.namedInfrastructure.existingWorkflowPaths],
    hasMergeQueue: ciProposal.namedInfrastructure.hasMergeQueue,
    runnerMatchesInventory: { ...ciProposal.runnerMatchesInventory },
  };
}

function buildCiArea({ ciProposal } = {}) {
  if (!ciProposal || !Array.isArray(ciProposal.lanes)) {
    throw new Error("ci area requires a ciProposal produced by ci-design.mjs's designProviderNativeCI");
  }
  return {
    provider: ciProposal.provider,
    lanes: ciProposal.lanes,
    diffChoice: ciProposal.diffChoice,
  };
}

function buildUnresolvedRequirementsArea({ portfolioApproval, executionResults, baselinePlan, ciProposal } = {}) {
  if (
    !portfolioApproval ||
    !Array.isArray(portfolioApproval.draftFlowIds) ||
    !Array.isArray(executionResults) ||
    !baselinePlan ||
    !Array.isArray(baselinePlan.metrics) ||
    !ciProposal ||
    !Array.isArray(ciProposal.lanes)
  ) {
    throw new Error("unresolvedRequirements area requires portfolioApproval, executionResults, baselinePlan, and ciProposal together");
  }

  const items = [];

  for (const flowId of portfolioApproval.draftFlowIds) {
    items.push({ kind: "draft-flow", flowId, reason: "flow has not cleared stage 6 reconciliation/approval" });
  }

  for (const result of executionResults) {
    if (result?.decision?.activate === false) {
      items.push({ kind: "deferred-execution-profile", flowId: result.flowId, blockers: result.decision.blockers ?? [] });
    }
  }

  for (const metric of baselinePlan.metrics) {
    if (isPlainObject(metric) && metricStatus(metric) === "measurement-required") {
      items.push({ kind: "measurement-required-metric", metricId: metric.id });
    }
  }

  for (const lane of ciProposal.lanes) {
    if (lane && lane.assigned === false) {
      items.push({ kind: "unassigned-ci-lane", flowId: lane.flowId, reason: lane.reason, deferredTrigger: lane.deferredTrigger });
    }
  }

  if (ciProposal.runnerMatchesInventory && ciProposal.runnerMatchesInventory.matches === false) {
    items.push({ kind: "runner-not-observed-in-inventory", runner: ciProposal.runnerMatchesInventory.runner });
  }

  return { items };
}

const AREA_BUILDERS = Object.freeze({
  contract: buildContractArea,
  data: buildDataArea,
  safety: buildSafetyArea,
  harness: buildHarnessArea,
  dependency: buildDependencyArea,
  ci: buildCiArea,
  unresolvedRequirements: buildUnresolvedRequirementsArea,
});

/**
 * Assembles the Setup Review Packet from every earlier stage's own result,
 * held entirely in memory. Every one of `REQUIRED_PACKET_AREAS` is built
 * independently; a builder that throws (missing/malformed input for that
 * one area) is recorded in `missingAreas` rather than aborting the whole
 * assembly, so a reviewer — and a Tier 1 test — sees every missing area at
 * once. `complete` is true only when every required area built successfully;
 * `emitSetupReviewPacket` refuses to proceed on anything less.
 *
 * This function itself performs NO repository I/O — it is pure computation
 * over its inputs.
 */
export function assembleSetupReviewPacket(input = {}) {
  const areas = {};
  const missingAreas = [];
  const areaErrors = {};

  for (const name of REQUIRED_PACKET_AREAS) {
    try {
      const area = AREA_BUILDERS[name](input);
      if (area === undefined || area === null) {
        missingAreas.push(name);
        continue;
      }
      areas[name] = area;
    } catch (error) {
      missingAreas.push(name);
      areaErrors[name] = error.message;
    }
  }

  return Object.freeze({
    areas: Object.freeze(areas),
    missingAreas,
    areaErrors: Object.freeze(areaErrors),
    complete: missingAreas.length === 0,
  });
}

/**
 * Validates that a packet (however constructed) actually covers every
 * required area. A packet with anything in `missingAreas`, or one that was
 * not produced by `assembleSetupReviewPacket` at all, is rejected — this is
 * the one place "one packet covers contract, data, safety, harness,
 * dependency, CI, and unresolved requirements" is a checked invariant
 * rather than a naming convention.
 */
export function validateSetupReviewPacket(packet) {
  if (!packet || !isPlainObject(packet.areas) || !Array.isArray(packet.missingAreas)) {
    return { valid: false, missingAreas: [...REQUIRED_PACKET_AREAS] };
  }
  const missingAreas = REQUIRED_PACKET_AREAS.filter((name) => !(name in packet.areas));
  return { valid: missingAreas.length === 0 && packet.missingAreas.length === 0, missingAreas };
}

// --- dual, independent approval — reusing #162's gates, not a second model -

/**
 * Evaluates the Setup Review Packet's approval record using EXACTLY #162's
 * authority-gate primitives (`GATE_KEYS`, `validateAuthorityRecord`,
 * `gatesAreIndependent`) — that module's own header names "the Setup
 * Review Packet" as one of the two places these two gates are reused, so
 * this function is that reuse, not a parallel approval model.
 *
 * `approvalRecord` is the same shape stage 1 already established:
 * `{ qaOwnerGate: { present, identifier }, technicalOwnerGate: { present,
 * identifier } }`. Here `present: true` means "this gate's holder has
 * approved the Setup Review Packet" (contract approval for qaOwnerGate,
 * technical approval for technicalOwnerGate) — the same two independently
 * tracked booleans, applied to a new question, never a new field shape.
 *
 * Returns `{ ok, errors, independent, contractApproved, technicalApproved,
 * bothApproved }`. `ok: false` (a malformed record — missing gate, gate
 * present with no identifier, or the two gates collapsed into one field)
 * makes both `contractApproved`/`technicalApproved` false unconditionally;
 * a well-formed but non-independent record (the same object reference
 * behind both keys) never reads as `bothApproved` either.
 */
export function evaluateSetupReviewApproval(approvalRecord) {
  const validation = validateAuthorityRecord(approvalRecord);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, independent: false, contractApproved: false, technicalApproved: false, bothApproved: false };
  }
  const independent = gatesAreIndependent(approvalRecord);
  const contractApproved = independent && approvalRecord.qaOwnerGate.present === true;
  const technicalApproved = independent && approvalRecord.technicalOwnerGate.present === true;
  return {
    ok: true,
    errors: [],
    independent,
    contractApproved,
    technicalApproved,
    bothApproved: contractApproved && technicalApproved,
  };
}

// --- reading the bundle's own bundled schema files (not customer state) ----

/**
 * Reads every `*.schema.json` file currently shipped in the bundle's own
 * `shared/schemas/` directory. This enumerates rather than hard-codes the
 * file list, so a later ticket that adds a new schema (quarantine,
 * failure-evidence, ...) widens what a patch materialises with no code
 * change here — mirroring #168's own "the adapter widens what this stage
 * can assign with no prompt or code change" pattern. Reads the BUNDLE's own
 * static files, never anything under the customer repository.
 */
export function listBundledSchemaFiles(schemasDir = DEFAULT_SCHEMAS_DIR) {
  return readdirSync(schemasDir)
    .filter((name) => name.endsWith(".schema.json"))
    .sort()
    .map((name) => ({ name, contents: readFileSync(path.join(schemasDir, name), "utf8") }));
}

// --- building the patch's file list (never written until emission) ---------

function referencedDataSetIds(flows) {
  const ids = new Set();
  for (const flow of flows) {
    for (const id of Array.isArray(flow.data_sets) ? flow.data_sets : []) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Builds the exact list of `{ path, contents }` files this patch would add
 * to the customer repository — and ONLY this list. Nothing here writes to
 * disk; the caller (SKILL.md prose, or a later explicit "apply this patch"
 * action this ticket deliberately does not build) decides what happens to
 * the returned files.
 *
 * Scope, matching DESIGN-dynamic-qa-spec.md §5's customer-artifact tree,
 * exactly the subset qa-setup itself is responsible for:
 *   - `qa/flows/<id>.yaml`              — one per APPROVED flow only; a
 *     draft flow (stage 6) is never materialised.
 *   - `qa/data/<id>.yaml`               — one per Named Data Set actually
 *     referenced by an approved flow.
 *   - `qa/execution-profiles/<id>.yaml` — one per stage-7 Execution Profile
 *     result (activated AND deferred both — a deferred flow still has a
 *     reviewable profile draft, per #166's own note).
 *   - `qa/schemas/<file>`               — the bundle's own current schema
 *     files, copied so the drift gate can run in the customer's CI with no
 *     model and no skill installation present (drift-gate.mjs's own
 *     "customer's installed qa/schemas/*.json contract files").
 *   - `qa/baseline-plan.yaml`           — the current Baseline Plan.
 *
 * Excluded, deliberately: `qa/quarantines/*` (nothing is quarantined by
 * setup) and `qa/provenance.json` (no Binding exists yet — Provenance
 * Manifest entries are qa-generate's job, ticket #146 and beyond). The CI
 * proposal itself is never written as a repository file here either — see
 * the module header: "generation, merging, policy changes... remain
 * separate actions."
 */
export function buildSetupPatchFiles({ packet, flows, executionResults, dataSets, baselinePlan, schemasDir = DEFAULT_SCHEMAS_DIR }) {
  const approvedSet = new Set(packet.areas.contract.approvedFlowIds);
  const approvedFlows = flows.filter((flow) => approvedSet.has(flow.id));

  const files = [];

  for (const flow of approvedFlows) {
    files.push({ path: `qa/flows/${flow.id}.yaml`, contents: renderRestrictedYAMLDocument(flow) });
  }

  const referencedIds = referencedDataSetIds(approvedFlows);
  for (const dataSet of dataSets) {
    if (referencedIds.has(dataSet.id)) {
      files.push({ path: `qa/data/${dataSet.id}.yaml`, contents: renderRestrictedYAMLDocument(dataSet) });
    }
  }

  for (const result of executionResults) {
    files.push({ path: `qa/execution-profiles/${result.flowId}.yaml`, contents: result.profileYaml });
  }

  for (const schemaFile of listBundledSchemaFiles(schemasDir)) {
    files.push({ path: `qa/schemas/${schemaFile.name}`, contents: schemaFile.contents });
  }

  files.push({ path: "qa/baseline-plan.yaml", contents: renderBaselinePlanYAML(baselinePlan) });

  // Deterministic order — a reviewer's diff (and a Tier 1 test) sees the
  // same file order every time, independent of input array order.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

// --- the one entry point qa-setup stage 10 calls ----------------------------

/**
 * Emits the Setup Review Packet's patch — or refuses to, structurally, for
 * exactly four reasons, checked in this fixed order:
 *
 *   1. `"incomplete-packet"`     — the packet does not cover all seven
 *      required areas (validateSetupReviewPacket failed).
 *   2. `"invalid-approval-record"` / `"gates-not-independent"` — the
 *      approval record itself is malformed, or its two gates are not
 *      genuinely independent values.
 *   3. `"contract-approval-withheld"` / `"technical-approval-withheld"` /
 *      `"both-approvals-withheld"` — one or both of the two independently
 *      required approvals is not present.
 *   4. `"measurement-required"`  — the Baseline Plan is not `"ready"` yet
 *      (SPEC-135 story 42: missing pilot baselines must never be forced
 *      forward past this stage).
 *
 * Only when NONE of the above apply does this function build and return
 * the patch's file list (`buildSetupPatchFiles`) — and it returns, it does
 * not write anything. There is no branch of this function that writes a
 * file, calls a generator, merges anything, or changes provider/CI policy:
 * "emit a patch and stop" is a structural property of this function's own
 * control flow, not a convention a caller has to remember to honour.
 */
export function emitSetupReviewPacket({ packet, approvalRecord, flows, executionResults, dataSets, baselinePlan, schemasDir } = {}) {
  const packetValidation = validateSetupReviewPacket(packet);
  if (!packetValidation.valid) {
    return { emitted: false, reason: "incomplete-packet", missingAreas: packetValidation.missingAreas };
  }

  const approval = evaluateSetupReviewApproval(approvalRecord);
  if (!approval.ok) {
    return { emitted: false, reason: "invalid-approval-record", errors: approval.errors };
  }
  if (!approval.independent) {
    return { emitted: false, reason: "gates-not-independent" };
  }
  if (!approval.contractApproved || !approval.technicalApproved) {
    const reason =
      !approval.contractApproved && !approval.technicalApproved
        ? "both-approvals-withheld"
        : !approval.contractApproved
          ? "contract-approval-withheld"
          : "technical-approval-withheld";
    return { emitted: false, reason, contractApproved: approval.contractApproved, technicalApproved: approval.technicalApproved };
  }

  const readiness = baselinePlan && Array.isArray(baselinePlan.metrics) ? computeReadiness(baselinePlan) : "measurement-required";
  if (readiness !== "ready") {
    return { emitted: false, reason: "measurement-required", readiness };
  }

  const files = buildSetupPatchFiles({ packet, flows, executionResults, dataSets, baselinePlan, schemasDir });
  return Object.freeze({
    emitted: true,
    files,
    summary: { fileCount: files.length, paths: files.map((f) => f.path) },
  });
}

export { GATE_KEYS };
