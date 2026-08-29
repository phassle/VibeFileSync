# Safe execution design (qa-setup stage 7)

Ticket #166. SPEC-135 User Stories 40–41: "As a Technical Owner, I want safe
Execution Profiles generated before activation ... so that paths, commands,
environments, network, identities, effects, resources, and evidence are
enforceable" and "As a responsible QA Owner, I want an exact Safety Blocker
when a capability is missing, so that the flow stays deferred instead of
running unsafely."

This document is the human-facing walkthrough for stage 7. It does not
restate #150's or #151's rationale in full — see
`shared/references/execution-profiles.md` and
`shared/references/trust-zones.md` for those — it explains how stage 7
composes them.

## Why this is a composition, not a third safety model

Two earlier tickets already built everything stage 7 needs to *check*:

- **#150** built the Execution Profile v1 contract (`execution-profile.mjs`)
  and the Capability Gate (`capability-gate.mjs`) — the schema for a Flow's
  enforceable policy across eight categories, and the gate proving a real
  environment enforces what a profile declares. `activationDecision` is the
  one function that decides whether a flow may activate, and it never
  returns `activate: true` alongside an open blocker.
- **#151** built the four Trust Zones and the hard security invariant
  (`trust-zones.mjs`) — which zone a run happens in, which zone-to-zone
  transitions are legal, and the checkable rule that untrusted content never
  combines with a privileged identity, broad filesystem access, or
  unrestricted network reach.

Stage 7's own module, `shared/scripts/safe-execution-design.mjs`, adds
exactly three things neither ticket built, and nothing else:

1. **Deriving an Execution Profile draft from inventory, never from
   defaults** (`deriveExecutionProfileFromInventory`) — #150 explicitly left
   "no YAML authoring/rendering surface" and no derivation logic for this
   ticket.
2. **Composing which Trust Zone checks apply to one run's context**
   (`checkTrustZoneForExecution`) — #151 built the checks; nothing wired
   them together against one concrete profile/context pair yet.
3. **One per-flow decision, and one portfolio-level entry point**
   (`designExecutionProfile`, `designSafeExecutionForApprovedFlows`) — the
   seam #150 and #151 both explicitly left for "whichever ticket wires
   qa-setup's stage 7."

Everything else — schema validation, the eight capability checks, zone
transition legality, the hard security invariant — is called, never
reimplemented.

## Profiles are derived from inventory, never from defaults

`deriveExecutionProfileFromInventory(flow, inventory)` builds an Execution
Profile's required sections (`owners`, `allowedPhases`, `allowedTestLevels`,
`environments`, `paths`, `commands`, `resources`, `identities`, `network`,
`effects`, `diagnostics`, `evidence`) *only* from what `inventory` supplies.
A section `inventory` does not supply is left entirely out of the profile —
never filled with a plausible-looking value — and produces a named blocker,
`inventory.<section>-known`. This is the acceptance criterion "profiles are
derived from the inventory rather than from defaults" made structural: there
is no code path here that synthesizes a section's content.

`credentials` is the one section this stage treats as legitimately optional
when absent from inventory: `execution-profile.mjs`'s own validator already
treats a credential-free profile as a valid, safe answer ("no credential
required"), so an absent `inventory.credentials` becomes `{}`, not a
blocker.

## Composing the Trust Zone checks

`checkTrustZoneForExecution(profile, context)` runs:

- `checkHardSecurityInvariant` — **always**, fed the profile's own `paths`,
  `network`, and `credentials` (the invariant applies "regardless of which
  zone it happens in").
- `checkZoneTransition` — only when `context.fromZone` and `context.zone`
  are both known.
- `checkAuthoringAuthority` — whenever `context.zone` is known.
- `checkVerificationCompute` — only for `zone === "candidate-verification"`.
- `checkPrivilegedLaneArtifact` — only for `zone === "privileged-publication"`
  with a supplied `context.privilegedArtifact`.

`zone`, `fromZone`, `contentSource`, `credentials`, `environment`,
`sourceCommit`, and `privilegedArtifact` are all caller-supplied context,
mirroring #150's and #151's own "environment evidence is caller-supplied"
pattern exactly — no adapter or sandbox discovers any of them here.

## The one per-flow decision: `designExecutionProfile`

Runs, in this fixed order, and always ends at `activationDecision`:

1. `deriveExecutionProfileFromInventory` — inventory-derivation blockers.
2. `validateExecutionProfile` (#150) — schema/policy blockers.
3. `checkExecutionProfileHonoursBoundaries` (#150) — boundary-honourability
   blockers, always run (never gated behind step 2 passing).
4. `checkTrustZoneForExecution` (#151, composed above) — Trust Zone /
   hard-security-invariant blockers.
5. `runCapabilityGate` (#150) against `context.environment` — capability
   blockers.
6. `activationDecision(gateResult, allOtherBlockers)` (#150) — the single,
   non-bypassable activation gate.

Every blocker from steps 1–4 is folded into the same list #150's
`activationDecision` already refuses to activate past. There is no second
"is this safe" decision anywhere in this stage.

**A profile is always generated, even when the flow stays deferred.** The
Execution Profile YAML draft (`profileYaml`, rendered through
`execution-profile-yaml.mjs` — the one rendering path this bundle uses,
shared with `flow-yaml.mjs`) is produced whether or not the flow activates.
"Safe Execution Profiles generated before activation" holds for a deferred
flow too: the draft exists and is reviewable, it is simply not enforceable
yet.

## Only #165's approved flows reach profile design

`designSafeExecutionForApprovedFlows(flows, portfolioApproval, {
inventoryByFlowId, contextByFlowId })` takes stage 6's
`evaluatePortfolioApproval` result directly and processes only
`approvedFlowIds`. A flow stage 6 left in `draftFlowIds` never reaches
profile design at all — it fails closed (throws) on a missing or malformed
`portfolioApproval`, mirroring `portfolio-reconciliation.mjs`'s
`issuesForFlow` fail-closed pattern, so this function cannot be called
before stage 6 finished, or against a stale result, without erroring loudly.

## What stays in prose, not in the deterministic core

Presenting a named blocker to the QA/Technical Owner in plain language, and
choosing among safe options to close a gap (which runner to provision,
which credential scope to request) is genuine judgement and stays in
`qa-setup/SKILL.md`'s stage 7 prose. This module never resolves a blocker on
its own behalf, and has no override, force, or auto-approve parameter
anywhere in its API — closing a gap always means re-running
`designExecutionProfile` after the underlying inventory or environment
evidence actually changed.

## Seams left for later tickets

- **No provider adapter populates `environment` or `context` for real.**
  Both remain entirely caller-supplied here, exactly as #150 and #151 left
  them; the GitHub Actions adapter (#153's territory) is the natural place
  to derive real environment evidence and Trust Zone context, and should
  shape its output to exactly this module's parameter shapes rather than
  inventing new ones.
- **Nothing writes `qa/execution-profiles/<id>.yaml` to the repository
  yet.** Stage 7 only produces an in-memory `profileYaml` string for
  review, per this bundle's "discovery/design stays read-only until the
  Setup Review Packet" rule (SPEC-135 story 48). The Setup Review Packet
  stage (#169) is the natural place to actually stage the file for the one
  emitted patch.
- **Baseline readiness (stage 8, #168) and provider-native CI design
  (stage 9) both come after this stage, not before** — a Flow's Execution
  Profile and Trust Zone assignment must exist and be blocker-free before
  either baseline collection or CI design assumes anything can safely run.
- **Result Envelope schema still does not exist** (noted by #151); this
  stage's `checkPrivilegedLaneArtifact` composition is ready for it the
  moment a later ticket defines one.
