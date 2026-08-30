# Provider-native CI lanes (#154)

DESIGN-dynamic-qa-spec.md §8 names four Provider-native CI exposures. #153 built
the first (`pull_request`); this ticket completes the set. All four are rendered
by the GitHub Actions adapter (`shared/scripts/github-actions-workflow.mjs` /
`github-actions-adapter.mjs`) — none is hand-written per repository.

## The four lanes

| Lane | Trigger | Gating | Renderer | Plan function |
|---|---|---|---|---|
| PR (advisory) | `pull_request` | advisory (`continue-on-error: true`) | `renderAdvisoryPullRequestLane` | `planAdvisoryPullRequestLane` (#153) |
| Nightly full suite | `schedule` | advisory (`continue-on-error: true`) | `renderNightlyFullSuiteLane` | `planNightlyFullSuiteLane` |
| Manual/provider | `workflow_dispatch` | advisory (`continue-on-error: true`) | `renderManualTriggerLane` | `planManualTriggerLane` |
| Merge-group | `merge_group` | **required** (no `continue-on-error`) | `renderMergeGroupLane` | `planMergeGroupLane` |

Every lane still shares the PR lane's fixed hardening: `permissions: contents:
read` only; `persist-credentials: false` on checkout; full-commit-SHA-pinned
actions; no secret, OIDC (`id-token: write`), protected environment, write
permission scope, privileged cache action, or self-hosted runner. Each property
is detected individually by `checkWorkflowHardening(yaml, { lane, trigger })`,
which now accepts a `lane` (`"advisory"` | `"required"`) and `trigger`
(`"pull_request"` | `"schedule"` | `"workflow_dispatch"` | `"merge_group"`)
option — both default to #153's original values, so every existing caller is
unaffected.

## Why nightly and manual stay advisory, and merge-group does not

Nightly and manual runs are not tied to any merge being decided at the moment
they run — a scheduled run observes the default branch's continuing health, and
a manual/provider-requested run produces evidence on demand. Neither should be
able to fail a merge gate, so both keep `continue-on-error: true`, exactly like
the PR lane.

A merge-group run is different in kind: DESIGN-dynamic-qa-spec.md §8 and
SPEC-135 User Story 68 exist specifically so that "required checks continue
gating queued merges." Masking its failure with `continue-on-error` would
silently defeat the only reason the lane exists. `renderMergeGroupLane`
therefore omits it, and `checkWorkflowHardening({ lane: "required" })` flags the
opposite mutation (`required.continue-on-error-present`) the same way the
advisory lanes flag a missing one (`advisory.not-continue-on-error`).

The repository operator still has to add the merge-group job's `name:` to
branch protection's required-status-checks list — this renderer emits the
workflow, it does not reach into repository settings itself (the same
"discovery is read-only, nothing is touched until separate approvals" invariant
that governs every other part of this bundle).

## How a manual trigger requests evidence without owning policy

SPEC-135 User Story 67: "As a coding agent, I want an explicit manual or
provider trigger, so that I can request deterministic regression evidence
without owning QA policy." This is enforced structurally, not by convention:
`renderManualTriggerLane` emits `workflow_dispatch: {}` with **no `inputs:`
block at all**. There is nothing in the trigger for a requester (a human, a
coding agent, or an MCP integration via the REST API) to set — the command,
runner, permissions, and identity are exactly the ones this renderer already
fixed from the Execution Profile, not something the dispatch event can
override. `checkWorkflowHardening` names a violation of this explicitly
(`dispatch.inputs-not-permitted`) if arbitrary YAML is later mutated to add
inputs — proving the guarantee is checked, not just asserted by the renderer's
absence of a parameter.

## The trust asymmetry, modeled deliberately

A nightly or merge-group run is not the same trust context as an unreviewed PR,
and this is modeled via `trust-zones.mjs` rather than copied blindly from the PR
lane's restrictions. `github-actions-adapter.mjs`'s `classifyLaneContentSource`
maps each trigger to one of `trust-zones.mjs`'s content-source classifications:

- `pull_request` and `workflow_dispatch` → `"branch"` (untrusted). A PR head can
  be an unreviewed fork; a manual dispatch can target any caller-selected ref,
  and this adapter cannot tell from the event alone that the content is any more
  trustworthy than an ordinary branch — so it is conservatively classified the
  same as a PR.
- `schedule` (nightly) and `merge_group` → `"reviewed-base-branch"` (trusted).
  A scheduled run executes against the default branch tip; a merge-group run
  combines commits from PRs that already passed required review to enter the
  queue.

This classification genuinely changes what `checkHardSecurityInvariant` would
PERMIT for the trusted lanes — `github-actions-adapter.test.mjs` proves an
identical permissive identity/paths/network shape is accepted for
`schedule`/`merge_group` content and rejected for `pull_request`/
`workflow_dispatch` content. The conclusion this ticket draws, however, is that
none of the four lanes should use the extra room the trust classification would
allow: every renderer still uses the same minimal identity (no secrets, no
OIDC, no write permission, no privileged cache, no self-hosted runner)
regardless of trust zone, because none of these lanes has a functional need for
more than checking out, running deterministic tests, and publishing
JUnit/annotations/summary. Trust classification says what would be allowed;
least privilege says none of it should be used. `checkLaneTrustInvariant`
exists so a future ticket that DOES need broader capability for a trusted lane
has a tested, named seam to reason from, rather than having to re-derive the
classification from scratch.

## Sharding

Not introduced by this ticket either. Every one of the four renderers still
takes a single precomputed `testCommand` string — #153's seam, unchanged.
DESIGN-dynamic-qa-spec.md §8 / SPEC-135 User Story 70: "sharding only after
measured runtime need." No runtime measurement exists yet (the pilot, #171-175,
has not run), so no matrix strategy is added. Nightly's `testCommand` is
expected to run the full active portfolio rather than an impacted subset, but
which command string to pass is an adapter/caller concern, not something this
ticket's renderers decide or shard.

## Suggested wiring text for `qa-generate/SKILL.md` (not applied by this ticket)

This ticket does not edit `qa-generate/SKILL.md` (out of its coordination
scope — see the run brief). Step 5's existing note already points at
`shared/references/github-actions-adapter.md` for the GitHub Actions adapter
and says wiring its invocation into this skill's step sequence is left to a
coordinated follow-up. Whoever does that wiring should also point at this
document; suggested addition to that same sentence:

> — see `dynamic-qa/shared/references/github-actions-adapter.md` for the
> GitHub Actions adapter this bundle ships (#153) and
> `dynamic-qa/shared/references/ci-lanes.md` for the nightly, manual/provider,
> and merge-group lanes it also renders (#154); wiring their invocation into
> this skill's own step sequence is left to a coordinated follow-up, not done
> in this edit.
