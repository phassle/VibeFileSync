// dynamic-qa/shared/scripts/preflight.mjs
//
// The generation gate ticket #146 exists to build: "given one approved Flow
// Definition, qa-generate emits the smallest conforming deterministic test
// ... Generation first validates contract, lifecycle, approvals, safety,
// source identity, harness, and provenance, and refuses to proceed when any
// of those is unmet" (DESIGN-dynamic-qa-spec.md §7, SPEC-135.md user story
// 49, run notes tickets/146.md). This module IS that validation sequence —
// `qa-generate/SKILL.md` calls it and stops on the first `ready: false`
// result rather than re-implementing any of these checks in prose.
//
// Every rejection carries a short, stable, machine-checkable `reason` code
// (never a warning) plus `issues` with full detail, so a Tier 1 test or a
// Tier 2 fixture case can assert on the exact reason without parsing prose.
//
// Checked, in the ticket's own listed order:
//   1. contract   — the Flow Definition itself is schema-valid
//                    (flow-definition.mjs, reused, not forked).
//   2. lifecycle  — Flow State must be "active". This walking skeleton does
//                    not implement the "deferred flow + complete Activation
//                    Proposal" path DESIGN-dynamic-qa-spec.md §7 step 1
//                    describes — no Activation Proposal artifact exists yet
//                    (#150 territory). "draft", "deferred" and "retired" all
//                    stop here with a precise reason; only "active" proceeds.
//   3. approvals  — the two-approval requirement (SPEC-135 story 3 / spec
//                    §8's "both approvals") is not stored inside the Flow
//                    Definition file itself (no such field exists in
//                    dynamic-qa-flow-v1.schema.json — approvals are a Git/
//                    review-process fact, not repository YAML). Preflight
//                    therefore takes `approvals: { qaOwner, technicalOwner }`
//                    as an explicit input the caller (qa-generate) is
//                    responsible for evidencing before calling this
//                    function — see the ASSUMPTION note below.
//   4. safety     — the flow's Boundary Declarations must satisfy the
//                    cross-cutting policy (boundary-policy.mjs, #145, reused
//                    not reimplemented — flow-definition.mjs only checks
//                    boundary *shape*, never policy), and every referenced
//                    Named Data Set must resolve and validate
//                    (resolve-data-sets.mjs, #144, reused). An Execution
//                    Profile must also be named, resolved, and PROVEN
//                    enforceable (#153 wires this — see below); #146 had
//                    only checked that generation names a profile ID string,
//                    never that the profile artifact itself is well-formed,
//                    honours the flow's boundaries, or is actually enforced
//                    by the real environment. Four checks, in order, none
//                    skippable:
//                      4a. `executionProfileId` is a valid semantic id
//                          (unchanged from #146: reason
//                          "missing-execution-profile-id").
//                      4b. `<executionProfilesDir>/<id>.yaml` resolves and
//                          passes `validateExecutionProfile` (#150, reused)
//                          (reason "invalid-execution-profile").
//                      4c. the resolved profile honours the flow's own
//                          Boundary Declarations via
//                          `checkExecutionProfileHonoursBoundaries` (#150,
//                          reused) (reason
//                          "execution-profile-boundary-mismatch").
//                      4d. `environmentEvidence` — what the real runner/
//                          adapter proves right now — is REQUIRED as an
//                          input (never optional: #150's Capability Gate
//                          note is explicit that "absence of an environment
//                          section is itself a blocker; nothing can degrade
//                          to a skip", so this module treats a caller who
//                          passes no evidence at all as its own distinct
//                          failure, reason "missing-environment-evidence",
//                          rather than silently skipping the gate). Once
//                          evidence is present (even an empty object — an
//                          adapter genuinely proving nothing, which then
//                          fails every category on its own terms), this runs
//                          `runCapabilityGate` + `activationDecision`
//                          (#150/#151, reused) and refuses with reason
//                          "execution-profile-capability-blocked" and
//                          `issues` set to the exact blockers on any open
//                          Safety Blocker.
//                    A GitHub Actions caller (github-actions-adapter.mjs,
//                    #153) is the first real source of `environmentEvidence`
//                    — see that module's `deriveCapabilityEvidence`.
//   5. source identity — a full, exact source commit SHA the candidate will
//                    be verified against (spec §7 step 6, SPEC-135 story 58).
//   6. harness    — a minimal existing-harness descriptor (framework, test
//                    output directory, deterministic run command) must be
//                    supplied; qa-generate cannot invent one.
//   7. provenance — an existing Provenance Manifest, if supplied, must
//                    itself be schema-valid, and this flow's revision must
//                    not regress against what provenance already recorded
//                    (provenance.mjs's checkRevisionMonotonic, reused here
//                    rather than forked).
//
// ASSUMPTION a later implementer must know: this module does not itself
// decide what counts as "approved" beyond Flow State — it trusts its
// caller's `approvals` input. `qa-setup`'s Setup Review Packet is the actual
// authority that produces those two approvals; #146 does not re-implement
// that gate, it only refuses to proceed without evidence of it having
// happened. A later ticket that wires a persisted approval record should
// pass it through here rather than inventing a second gate.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseFlowDefinitionFile } from "./flow-definition.mjs";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";
import { validateBoundaryPolicy } from "./boundary-policy.mjs";
import { resolveFlowDataSets } from "./resolve-data-sets.mjs";
import { isValidSemanticId } from "./id-rules.mjs";
import { validateProvenanceManifest, checkRevisionMonotonic } from "./provenance.mjs";
import { validateExecutionProfile, checkExecutionProfileHonoursBoundaries } from "./execution-profile.mjs";
import { runCapabilityGate, activationDecision } from "./capability-gate.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function fail(reason, issues = []) {
  return { ready: false, reason, issues };
}

/**
 * Runs the full generation preflight gate. Never throws for an ordinary
 * fail-closed condition (a YAML syntax error from a hostile flow file is the
 * one exception — parsing genuinely cannot proceed past it, exactly as
 * parseFlowDefinitionFile documents). Returns:
 *   - `{ ready: false, reason, issues }` on the first unmet precondition,
 *     checked in the fixed order documented above;
 *   - `{ ready: true, flowData, dataSets, executionProfile }` once every
 *     precondition holds, where `dataSets` is the resolved `[{ id, data }]`
 *     list for every `data_sets` reference, ready for provenance
 *     construction, and `executionProfile` is the resolved, validated,
 *     boundary-honouring, Capability-Gate-passing Execution Profile document.
 */
export function runGenerationPreflight({
  flowSource,
  flowFilename,
  dataSetsDir,
  approvals,
  executionProfileId,
  executionProfilesDir,
  environmentEvidence,
  sourceCommit,
  harness,
  existingProvenanceManifest,
} = {}) {
  // 1. contract
  let parsed;
  try {
    parsed = parseFlowDefinitionFile(flowSource, { filename: flowFilename });
  } catch (err) {
    return fail("invalid-flow-contract", [{ path: [], message: `flow file did not parse: ${err.message}` }]);
  }
  if (!parsed.valid) {
    return fail("invalid-flow-contract", parsed.errors);
  }
  // parseFlowDefinitionFile only returns { valid, errors }; recover the
  // actual parsed value the same deterministic way it derived one
  // internally (restricted-YAML parsing is a pure, cheap re-derivation, not
  // a second source of truth).
  const flowData = parseRestrictedYAML(flowSource, { filename: flowFilename });

  // 2. lifecycle
  if (flowData.state !== "active") {
    return fail("flow-not-active", [
      {
        path: ["state"],
        message: `flow state is ${JSON.stringify(flowData.state)}: only an "active" flow (contract and every activation condition already approved) is eligible for generation`,
      },
    ]);
  }

  // 3. approvals
  if (!approvals || approvals.qaOwner !== true) {
    return fail("missing-qa-owner-approval", [
      { path: ["approvals", "qaOwner"], message: "QA Owner contract approval was not evidenced" },
    ]);
  }
  if (approvals.technicalOwner !== true) {
    return fail("missing-technical-owner-approval", [
      { path: ["approvals", "technicalOwner"], message: "Technical Owner approval was not evidenced" },
    ]);
  }

  // 4. safety
  const boundaryIssues = validateBoundaryPolicy(flowData.boundaries, ["boundaries"]);
  if (boundaryIssues.length > 0) {
    return fail("boundary-policy-violation", boundaryIssues);
  }

  const dataSetsResult = resolveFlowDataSets(flowData, { dataSetsDir });
  if (!dataSetsResult.valid) {
    return fail("invalid-data-sets", dataSetsResult.errors);
  }

  // 4a. a concrete Execution Profile must be named by id.
  if (!isValidSemanticId(executionProfileId)) {
    return fail("missing-execution-profile-id", [
      {
        path: ["executionProfileId"],
        message: "generation must name a concrete Execution Profile by id before it may run a candidate",
      },
    ]);
  }

  // 4b. the named profile must actually resolve and be well-formed (#150's
  // validateExecutionProfile, reused — not re-implemented here).
  const profilePath = path.join(executionProfilesDir ?? "", `${executionProfileId}.yaml`);
  if (!executionProfilesDir || !existsSync(profilePath)) {
    return fail("invalid-execution-profile", [
      {
        path: ["executionProfileId"],
        message: `Execution Profile ${JSON.stringify(executionProfileId)} does not resolve under executionProfilesDir — the artifact itself, not just its id, must be present and valid`,
      },
    ]);
  }
  let executionProfile;
  try {
    executionProfile = parseRestrictedYAML(readFileSync(profilePath, "utf8"), { filename: executionProfileId });
  } catch (err) {
    return fail("invalid-execution-profile", [
      {
        path: ["executionProfileId"],
        message: `Execution Profile ${JSON.stringify(executionProfileId)} could not be parsed: ${err.message}`,
      },
    ]);
  }
  const profileValidation = validateExecutionProfile(executionProfile, { expectedId: executionProfileId });
  if (!profileValidation.valid) {
    return fail("invalid-execution-profile", profileValidation.errors);
  }

  // 4c. the profile must honour this flow's own Boundary Declarations
  // (#150's checkExecutionProfileHonoursBoundaries, reused).
  const honoursCheck = checkExecutionProfileHonoursBoundaries(executionProfile, flowData.boundaries);
  if (!honoursCheck.valid) {
    return fail("execution-profile-boundary-mismatch", honoursCheck.errors);
  }

  // 4d. the profile must be proven enforceable against real environment
  // evidence — never optional, never a silent skip (#150's Capability Gate:
  // "absence of an environment section is itself a blocker").
  if (environmentEvidence === undefined || environmentEvidence === null) {
    return fail("missing-environment-evidence", [
      {
        path: ["environmentEvidence"],
        message:
          "generation must supply environment evidence (even an empty object, if the adapter genuinely proves nothing) for the Capability Gate — an absent environment can never silently skip this check",
      },
    ]);
  }
  const gateResult = runCapabilityGate(executionProfile, environmentEvidence);
  const activation = activationDecision(gateResult);
  if (!activation.activate) {
    return fail(
      "execution-profile-capability-blocked",
      activation.blockers.map((b) => ({ path: ["environmentEvidence", b.category, b.capability], message: b.message })),
    );
  }

  // 5. source identity
  if (typeof sourceCommit !== "string" || !FULL_SHA_RE.test(sourceCommit)) {
    return fail("missing-source-commit", [
      {
        path: ["sourceCommit"],
        message: "a full 40-character source commit SHA is required to verify the candidate against a pinned commit",
      },
    ]);
  }

  // 6. harness
  if (
    !harness ||
    typeof harness.framework !== "string" ||
    harness.framework.trim() === "" ||
    typeof harness.testDir !== "string" ||
    harness.testDir.trim() === "" ||
    typeof harness.command !== "string" ||
    harness.command.trim() === ""
  ) {
    return fail("missing-harness-descriptor", [
      {
        path: ["harness"],
        message:
          "an existing-harness descriptor (framework, testDir, deterministic command) is required — qa-generate places code into the customer's existing layout, it never invents one",
      },
    ]);
  }

  // 7. provenance
  if (existingProvenanceManifest !== undefined && existingProvenanceManifest !== null) {
    const manifestValidation = validateProvenanceManifest(existingProvenanceManifest);
    if (!manifestValidation.valid) {
      return fail("invalid-existing-provenance", manifestValidation.errors);
    }
    const monotonic = checkRevisionMonotonic(existingProvenanceManifest, flowData.id, flowData.revision);
    if (!monotonic.ok) {
      return fail("revision-not-monotonic", [
        {
          path: ["revision"],
          message: `flow revision ${flowData.revision} is lower than the revision ${monotonic.existingRevision} already recorded in provenance for ${JSON.stringify(flowData.id)} — revision must never regress`,
        },
      ]);
    }
  }

  // dataSetsResult.valid already proved every reference resolves and passes
  // Named Data Set validation (resolve-data-sets.mjs / named-data-set.mjs).
  // Neither of those modules hands back the parsed data value itself (only
  // { valid, errors }), so this reads and re-parses the already-proven-valid
  // file with the same restricted-YAML parser to recover its actual content
  // for provenance's data-set digest — a cheap, side-effect-free
  // re-derivation of an already-validated file, not a second source of
  // truth or a second validation pass.
  const dataSets = flowData.data_sets.map((id) => {
    const filePath = path.join(dataSetsDir, `${id}.yaml`);
    const data = parseRestrictedYAML(readFileSync(filePath, "utf8"), { filename: id });
    return { id, data };
  });

  return { ready: true, flowData, dataSets, executionProfile };
}
