// dynamic-qa/shared/scripts/safe-execution-design.mjs
//
// Ticket #166, qa-setup stage 7 ("Define safe execution" — SPEC-135 User
// Stories 40-41, DESIGN-dynamic-qa-spec.md §5.3/§11). This module is where
// #150's Execution Profile contract + Capability Gate and #151's Trust
// Zones + hard security invariant MEET the human: for every Flow #165's
// portfolio reconciliation cleared, design a safe Execution Profile from
// inventoried fact and gate it before activation is even possible.
//
// This module does NOT re-validate an Execution Profile's shape
// (execution-profile.mjs already does that), re-run the Capability Gate
// (capability-gate.mjs already does that), or re-derive Trust Zone legality
// / the hard security invariant (trust-zones.mjs already does that). It
// composes all three, in a fixed order, into one per-flow decision and one
// portfolio-level entry point. Building a second, parallel safety model
// here — a fresh "is this safe" check that doesn't call #150/#151's
// functions — would be exactly the mistake ticket #166 is written to avoid.
//
// The one invariant every other choice here serves, restated from the
// ticket: A MISSING CAPABILITY NEVER DEGRADES TO A SKIP. Concretely:
//
//   - `deriveExecutionProfileFromInventory` builds a profile section ONLY
//     from what `inventory` actually supplies. A required section absent
//     from `inventory` is never filled with a plausible-looking default
//     (no invented runner class, no invented path allowlist, no invented
//     network policy) — it produces a named Safety Blocker instead, and the
//     profile is left with that section undesigned. This is the acceptance
//     criterion "profiles are derived from the inventory rather than from
//     defaults" made structural: there is no code path in this function
//     that synthesizes a section's content when `inventory` didn't supply
//     it.
//   - `designExecutionProfile` is the sole per-flow decision point, and it
//     always ends by calling #150's `activationDecision` — the same
//     function that already guarantees "no code path returns `activate:
//     true` alongside a non-empty blocker list." This module adds
//     inventory-derivation blockers, profile-validation blockers,
//     boundary-honourability blockers, and Trust Zone blockers to that same
//     list before the decision is made, so every one of those four
//     additional failure classes is gated by the exact same non-bypassable
//     mechanism #150 already built, not a second one.
//   - `designSafeExecutionForApprovedFlows` reads #165's
//     `evaluatePortfolioApproval` output and processes ONLY
//     `approvedFlowIds` — a flow #165 left in `draftFlowIds` never reaches
//     profile design at all, per the ticket's "only approved flows ... reach
//     profile design." It fails closed (throws) on a missing/malformed
//     portfolio-approval result, mirroring
//     `portfolio-reconciliation.mjs`'s `issuesForFlow` fail-closed pattern,
//     so a caller cannot pass `undefined` and have every flow silently
//     treated as approved.
//
// Genuine judgement — presenting a Safety Blocker to the QA/Technical Owner
// in plain language, and choosing among safe options for how to close a gap
// (which runner to provision, which credential to scope) — stays in
// qa-setup/SKILL.md prose. Everything here is composition and naming.

import {
  SUPPORTED_SCHEMA,
  CAPABILITY_CATEGORIES,
  validateExecutionProfile,
  checkExecutionProfileHonoursBoundaries,
} from "./execution-profile.mjs";
import { runCapabilityGate, activationDecision } from "./capability-gate.mjs";
import {
  checkZoneTransition,
  checkAuthoringAuthority,
  checkHardSecurityInvariant,
  checkVerificationCompute,
  checkPrivilegedLaneArtifact,
} from "./trust-zones.mjs";
import { renderExecutionProfileYAML } from "./execution-profile-yaml.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blocker(category, capability, message) {
  return { category, capability, message };
}

// --- deriving an Execution Profile draft from inventory, never defaults ----

// The Execution Profile sections that must come from inventoried fact
// before this Flow's run is enforceable. `profileKey` is the field name in
// the Execution Profile document; `inventoryKey` is the field name this
// module reads it under on the caller-supplied `inventory` object — kept
// identical on purpose, so there is exactly one name per section, but named
// separately here so a future inventory shape can diverge from the profile
// shape without this list changing meaning.
const REQUIRED_PROFILE_SECTIONS = [
  ["owners", "owners"],
  ["allowedPhases", "allowedPhases"],
  ["allowedTestLevels", "allowedTestLevels"],
  ["environments", "environments"],
  ["paths", "paths"],
  ["commands", "commands"],
  ["resources", "resources"],
  ["identities", "identities"],
  ["network", "network"],
  ["effects", "effects"],
  ["diagnostics", "diagnostics"],
  ["evidence", "evidence"],
];

function categoryForProfileKey(profileKey) {
  return CAPABILITY_CATEGORIES.includes(profileKey) ? profileKey : "profile";
}

/**
 * Builds an Execution Profile draft for `flow` from `inventory` alone.
 * `inventory` is a plain object shaped `{ owners, allowedPhases,
 * allowedTestLevels, environments, paths, commands, resources, identities,
 * network, effects, diagnostics, evidence, credentials?, revision? }` — the
 * same field names and shapes `execution-profile.mjs`'s schema expects for
 * each section, because this module does not transform inventoried fact,
 * it only assembles it.
 *
 * Every section in `REQUIRED_PROFILE_SECTIONS` that `inventory` does not
 * supply (the key absent, or explicitly `undefined`) is left OUT of the
 * returned profile entirely — never filled with a default — and produces
 * one named blocker: `inventory.<section>-known`. `credentials` is the one
 * profile section this module treats as legitimately optional even when
 * absent from inventory: `execution-profile.mjs`'s own validator already
 * treats a credential-free profile (`credentials: {}`, no `handle`) as
 * valid ("no credential required by this profile" — that is a real, safe
 * answer, not a gap), so an absent `inventory.credentials` becomes `{}`
 * rather than a blocker. `revision` defaults to `1` only as authoring
 * bookkeeping (like `schema`/`id`), never as a stand-in for enforcement
 * data.
 *
 * Returns `{ profile, blockers }`. `profile` may be incomplete (missing
 * required sections) when `blockers` is non-empty — callers should still
 * run it through `validateExecutionProfile` and the rest of
 * `designExecutionProfile`'s pipeline, which will report the same gaps
 * again in schema-validator form; the two together are how a reviewer sees
 * both "this fact was never inventoried" and "this document is not
 * schema-valid," which are different, both useful, statements.
 */
export function deriveExecutionProfileFromInventory(flow, inventory) {
  if (!flow || typeof flow.id !== "string") {
    throw new Error("deriveExecutionProfileFromInventory requires an assembled Flow Definition with an id");
  }
  const inv = isPlainObject(inventory) ? inventory : {};
  const blockers = [];

  const profile = {
    schema: SUPPORTED_SCHEMA,
    id: flow.id,
    revision: Number.isInteger(inv.revision) && inv.revision >= 1 ? inv.revision : 1,
  };

  for (const [profileKey, inventoryKey] of REQUIRED_PROFILE_SECTIONS) {
    const supplied = Object.prototype.hasOwnProperty.call(inv, inventoryKey) && inv[inventoryKey] !== undefined;
    if (supplied) {
      profile[profileKey] = inv[inventoryKey];
    } else {
      blockers.push(
        blocker(
          categoryForProfileKey(profileKey),
          `inventory.${profileKey}-known`,
          `no inventoried "${profileKey}" evidence was supplied for flow ${JSON.stringify(flow.id)} — an Execution Profile section can only be authored from inventoried fact, never a default value, so this section stays undesigned and the flow stays deferred`,
        ),
      );
    }
  }

  profile.credentials = isPlainObject(inv.credentials) ? inv.credentials : {};

  return { profile, blockers };
}

// --- mapping every other check's issue shape onto the same blocker shape --

function categoryForIssuePath(path) {
  const head = Array.isArray(path) ? path[0] : undefined;
  return CAPABILITY_CATEGORIES.includes(head) ? head : "profile";
}

function mapValidationIssues(errors) {
  return (errors ?? []).map((issue) =>
    blocker(categoryForIssuePath(issue.path), `profile-invalid.${(issue.path ?? []).join(".") || "$"}`, issue.message),
  );
}

function mapHonourabilityIssues(errors) {
  return (errors ?? []).map((issue) => blocker("effects", `boundary-honour.${(issue.path ?? []).join(".") || "$"}`, issue.message));
}

function mapTrustZoneIssues(errors) {
  return (errors ?? []).map((issue) => blocker("trust-zone", issue.error, issue.message));
}

// --- composing #151's Trust Zone checks, conditionally, per zone context --

/**
 * Composes exactly the Trust Zone checks (`trust-zones.mjs`) that apply to
 * one run's context — never a reimplementation of any of them. Every
 * function called here is imported directly from `trust-zones.mjs`:
 *
 *   - `checkHardSecurityInvariant` always runs (the hard invariant applies
 *     "regardless of which zone it happens in" per that module's own
 *     doc); this module feeds it the profile's own `paths`, `network`, and
 *     `credentials` so a caller never has to restate them separately.
 *   - `context.zone` is now REQUIRED (finding #1, closed): omitting it used
 *     to skip `checkAuthoringAuthority` / `checkVerificationCompute` /
 *     `checkPrivilegedLaneArtifact` wholesale, and #170 confirmed
 *     `checkHardSecurityInvariant` alone does not substitute for them when
 *     content is classified trusted. A missing `context.zone` now itself
 *     produces a named, non-bypassable blocker (`trust-zone` /
 *     `zone-not-classified`) that flows into `activationDecision` exactly
 *     like every other blocker — there is no code path where an omitted
 *     zone reads as "nothing to check."
 *   - `checkZoneTransition` runs only when `context.fromZone` is also
 *     supplied (a caller not modelling a transition for this run yet is not
 *     penalized for omitting `fromZone` specifically — `zone` itself is
 *     still required).
 *   - `checkAuthoringAuthority` runs whenever `context.zone` is known.
 *   - `checkVerificationCompute` runs only for
 *     `zone === "candidate-verification"` (the zone it exists to check).
 *   - `checkPrivilegedLaneArtifact` runs only for
 *     `zone === "privileged-publication"` and only when
 *     `context.privilegedArtifact` was supplied.
 *
 * Returns the raw array of `{ error, message }` issues (trust-zones.mjs's
 * own shape) so mapTrustZoneIssues can fold them into this module's
 * blocker shape.
 */
export function checkTrustZoneForExecution(profile, context = {}) {
  const issues = [];
  const { zone, fromZone, contentSource, credentials, environment, sourceCommit, privilegedArtifact } = context;

  if (zone === undefined) {
    issues.push({
      error: "zone-not-classified",
      message:
        "context.zone is required — a run cannot be activated without an explicit Trust Zone classification. Omitting it must never silently skip checkAuthoringAuthority, checkVerificationCompute, or checkPrivilegedLaneArtifact (finding #1, closed)",
    });
  }

  if (fromZone !== undefined && zone !== undefined) {
    const transition = checkZoneTransition(fromZone, zone);
    if (!transition.legal) issues.push({ error: transition.error, message: transition.message });
  }

  if (zone !== undefined) {
    issues.push(...checkAuthoringAuthority(zone, { credentials: credentials ?? profile?.credentials }).errors);
  }

  issues.push(
    ...checkHardSecurityInvariant({
      contentSource,
      credentials: credentials ?? profile?.credentials,
      paths: profile?.paths,
      network: profile?.network,
    }).errors,
  );

  if (zone === "candidate-verification") {
    issues.push(...checkVerificationCompute({ environment, sourceCommit }).errors);
  }

  if (zone === "privileged-publication" && privilegedArtifact !== undefined) {
    issues.push(...checkPrivilegedLaneArtifact(zone, privilegedArtifact).errors);
  }

  return issues;
}

// --- the sole per-flow decision point -------------------------------------

/**
 * Designs and gates the safe Execution Profile for exactly one Flow. This
 * is the one function a caller (qa-setup stage 7) should use — it always
 * runs every stage below, in this fixed order, and always ends by handing
 * every blocker found to #150's `activationDecision`, which is itself the
 * only function that decides `activate`/`state`. There is no early return
 * anywhere in this function that skips a later stage:
 *
 *   1. `deriveExecutionProfileFromInventory` — inventory-derivation
 *      blockers (never defaults).
 *   2. `validateExecutionProfile` (#150) — profile schema/policy blockers.
 *   3. `checkExecutionProfileHonoursBoundaries` (#150) — boundary
 *      honourability blockers, ALWAYS run (even against a schema-invalid
 *      profile; #150's function only reads `effects.allowedBoundaryIds`,
 *      which is either present or simply contributes nothing, never
 *      throws) so a reviewer sees every gap in one pass rather than fixing
 *      schema issues one round-trip at a time before seeing boundary
 *      issues.
 *   4. `checkTrustZoneForExecution` (#151, composed above) — Trust Zone /
 *      hard-security-invariant blockers.
 *   5. `runCapabilityGate` (#150) against `context.environment` —
 *      capability blockers.
 *   6. `activationDecision(gateResult, allOtherBlockers)` (#150) — the
 *      single, non-bypassable activation gate.
 *
 * `inventory` and `context` are both caller-supplied evidence, exactly
 * mirroring #150's and #151's established "environment evidence is
 * caller-supplied" pattern — this module does not discover either from a
 * real repository, sandbox, or provider adapter.
 *
 * Returns `{ flowId, profile, profileYaml, decision }`. `profileYaml` is
 * always rendered (via execution-profile-yaml.mjs, the one rendering path)
 * even when `decision.state` is `"deferred"` — "a profile is generated
 * before activation is possible" holds for a deferred flow too: the draft
 * exists and is reviewable, it is simply not enforceable yet.
 */
export function designExecutionProfile(flow, inventory, context = {}) {
  if (!flow || typeof flow.id !== "string") {
    throw new Error("designExecutionProfile requires an assembled Flow Definition with an id");
  }

  const { profile, blockers: inventoryBlockers } = deriveExecutionProfileFromInventory(flow, inventory);
  const blockers = [...inventoryBlockers];

  const validation = validateExecutionProfile(profile, { expectedId: flow.id });
  blockers.push(...mapValidationIssues(validation.errors));

  const honourability = checkExecutionProfileHonoursBoundaries(profile, flow.boundaries);
  blockers.push(...mapHonourabilityIssues(honourability.errors));

  const trustZoneIssues = checkTrustZoneForExecution(profile, context);
  blockers.push(...mapTrustZoneIssues(trustZoneIssues));

  const gate = runCapabilityGate(profile, context.environment);
  const decision = activationDecision(gate, blockers);

  return {
    flowId: flow.id,
    profile,
    profileYaml: renderExecutionProfileYAML(profile),
    decision,
  };
}

// --- the portfolio-level entry point qa-setup stage 7 calls ---------------

/**
 * Designs and gates a safe Execution Profile for every flow #165's
 * `evaluatePortfolioApproval` cleared — and ONLY those flows.
 * `portfolioApproval` must be a real result of `evaluatePortfolioApproval`
 * (`portfolio-reconciliation.mjs`); this function throws rather than
 * treating a missing/malformed one as "nothing approved yet," mirroring
 * that module's own `issuesForFlow` fail-closed pattern. A flow present in
 * `flows` but NOT in `portfolioApproval.approvedFlowIds` (i.e. it stayed in
 * `draftFlowIds`) is skipped entirely here — it never reaches profile
 * design, per the ticket's explicit acceptance criterion.
 *
 * `inventoryByFlowId` and `contextByFlowId` are plain objects keyed by flow
 * id; a flow with no entry in either is designed against `{}` /
 * `undefined`, which — by `deriveExecutionProfileFromInventory`'s own
 * rule — produces every required-section blocker rather than any default,
 * so an approved flow qa-setup has not yet gathered execution evidence for
 * simply stays deferred with a full, named list of what is missing.
 *
 * Returns an array of `designExecutionProfile` results, one per approved
 * flow, in the same order they appear in `flows`.
 */
export function designSafeExecutionForApprovedFlows(flows, portfolioApproval, { inventoryByFlowId = {}, contextByFlowId = {} } = {}) {
  if (!Array.isArray(flows)) {
    throw new Error("designSafeExecutionForApprovedFlows requires an array of assembled Flow Definitions");
  }
  if (!portfolioApproval || !Array.isArray(portfolioApproval.approvedFlowIds)) {
    throw new Error(
      "designSafeExecutionForApprovedFlows requires a portfolioApproval produced by portfolio-reconciliation.mjs's evaluatePortfolioApproval",
    );
  }

  const approvedSet = new Set(portfolioApproval.approvedFlowIds);
  const results = [];
  for (const flow of flows) {
    if (!flow || typeof flow.id !== "string" || !approvedSet.has(flow.id)) continue;
    results.push(designExecutionProfile(flow, inventoryByFlowId[flow.id], contextByFlowId[flow.id] ?? {}));
  }
  return results;
}
