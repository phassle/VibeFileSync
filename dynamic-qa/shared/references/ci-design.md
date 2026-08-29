# Provider-native CI design (qa-setup stage 9)

Ticket #168. SPEC-135 User Stories 45–46: "As a Technical Owner, I want
provider-native CI designed only after the flow portfolio is approved, so
that infrastructure does not distort QA intent" and "As a Technical Owner,
I want setup to propose the smallest existing-harness and CI diff, so that
dynamic-qa adds minimal maintenance burden."

This document is the human-facing walkthrough for stage 9. It does not
restate #153's adapter contract or hardening rationale — see
`shared/references/github-actions-adapter.md` for that — it explains how
stage 9's own module (`shared/scripts/ci-design.mjs`) uses it.

## Ordering is structural, not a convention

`designProviderNativeCI` throws unless
`portfolioApproval.portfolioFullyApproved === true`. There is no code path
in the module that reaches lane assignment, the smallest-diff choice, or
the proposal artifact without first passing that check — CI design is
**unreachable** with an unapproved portfolio, the same way #166 makes
profile design unreachable for a malformed portfolio approval. This is
deliberately stronger than #166's per-flow gate: SPEC-135 story 45 is about
the whole portfolio agreeing on what QA intent is, not about any one flow's
readiness, so the gate here checks `portfolioFullyApproved`, not merely
that the caller supplied approved flow ids.

## Real lane assignment vs. the coherence signal

#165's `classifyCandidateLane` (`portfolio-reconciliation.mjs`) answers one
narrow question — "does this flow's own boundaries/test-level suggest
PR-fast or nightly coverage" — as a **coherence signal only**; #165 was
explicit that no lane/trigger concept exists in its schema. Stage 9 is
where a real lane assignment happens, and `assignFlowLane` treats that
signal as exactly one input among three:

1. **the signal** — which trigger this flow's own risk profile would need
   (`pull_request` for `pr-fast-candidate`, `schedule` for
   `nightly-candidate`);
2. **the flow's own #166 Execution Profile activation** — a flow whose
   `designExecutionProfile` result has `decision.activate !== true` never
   gets a lane, full stop; its Safety Blockers are cited, not silently
   dropped;
3. **whether the provider adapter can actually render that trigger today**
   — checked against a caller-supplied `supportedTriggers` list, defaulted
   to #153's own `SUPPORTED_TRIGGERS` (currently `["pull_request"]` only).

A flow failing check 2 or 3 is never silently folded into a lane it does
not qualify for; `assigned: false` always carries a named `reason`
(`execution-profile-not-activatable` or
`trigger-not-yet-supported-by-adapter`) and, for the latter, the exact
`deferredTrigger` label from #153's `DEFERRED_TRIGGERS`.

## Not hard-coded to "only pull_request exists"

`LANE_TRIGGERS` names all four Provider-native CI exposures
DESIGN-dynamic-qa-spec.md §8 requires — `pr-fast`, `nightly-full`,
`manual`, `merge-queue` — up front, whether or not the adapter can render
them yet. Availability is decided at call time against
`supportedTriggers`/`deferredTriggers` parameters (defaulted to, never
copied from, #153's own exported lists). This is the concrete seam for
#154's concurrent work: the day the adapter's `SUPPORTED_TRIGGERS` grows to
include `schedule`/`workflow_dispatch`/`merge_group`, `assignFlowLane`
picks that up immediately — no change to this module's own code, only to
the list a caller passes (or, once #154 lands, the very same import this
module already uses by default).

## Smallest diff: amend vs. new file, decided on real numbers

`chooseSmallestDiff` never treats "add a new `dynamic-qa.yml`" as the
default. It reads stage 2's own CI Facts (`inventory-ci.mjs`'s
`scanCiWorkflows`, summarized here by `summarizeCiInventory`) grouped by
each fact's own `evidence` field — the workflow file the fact was actually
observed in — and scores every workflow with a real, hosted runner as an
amend candidate:

- the **amend** estimate is the job-block slice of the exact YAML
  `renderAdvisoryPullRequestLane` (#153) would produce for a brand-new
  file, plus (only when the required trigger is not already present in
  that workflow) a small, named, fixed allowance for the `on:` block
  addition (`TRIGGER_ADDITION_LINES`, documented in the module: the exact
  existing `on:` shape differs per repository, and this module never
  re-renders a third party's workflow YAML, so this is charged as an
  explicit constant rather than a computed guess);
- the **new-file** estimate is that same renderer's full output, measured
  directly (`nonBlankLineCount`), never assumed.

Amend wins whenever its estimate is smaller than **or equal to** the new-
file estimate — "preferred... when it is smaller" is read as "never worse,
and simpler when tied," matching the ticket's "minimal maintenance burden"
framing. A self-hosted-only workflow is never proposed as an amend target:
capability evidence for a self-hosted runner's own Node availability is
#153's own named seam, not something to assume here. When no eligible
existing workflow exists at all, `new-file` is the only path, named
honestly rather than forced into a false "smaller" comparison.

Applied to this repository today: `.github/workflows/acceptance.yml`
already carries a `pull_request` trigger on `develop`/`main` with a real,
hosted runner (`macos-14`) — exactly what the advisory PR lane needs, with
its trigger already present. Amending it (append one job) scores smaller
than a new file, and that is what stage 9 proposes here — not a reflexive
`dynamic-qa.yml`. This is a proposal only: `designProviderNativeCI` never
writes a file or touches `.github/workflows/` itself.

## The proposal names only real, inventoried infrastructure

`designProviderNativeCI`'s `namedInfrastructure` (runners, environments,
triggers, existing workflow paths) is read straight from
`summarizeCiInventory`'s grouping of stage 2's own Facts — never a
plausible-looking label invented by this module. `runnerMatchesInventory`
additionally flags, by name, when the runner an Execution Profile actually
declares (`renderConfig.runsOn`, itself #166's inventory-derived
`environments.runnerClass`) was never observed in the CI inventory at all —
surfacing a mismatch rather than silently treating an unobserved runner as
reusable.

## What this stage still leaves open

- **Only the advisory lane is ever proposed** (`enforcementState:
  "advisory"` on every assigned lane) — #153 built no required/quarantine
  renderer yet, and inventing an enforcement state this stage cannot
  actually render would be exactly the kind of guess the run brief
  forbids.
- **Nightly-full, manual/API, and merge-group lanes stay unassigned** until
  #154 teaches the adapter to render their triggers — named via
  `deferredTrigger`, never silently dropped.
- **No actual amend renderer exists.** This module decides *whether* to
  amend and estimates the size, but producing the exact merged YAML for an
  existing third-party workflow file is left to whichever ticket wires this
  proposal into a real patch (stage 10's Setup Review Packet, or a later
  `qa-generate` step) — consistent with "no CI change is applied at this
  stage."
- **Sharding is not introduced**, matching #153's own `testCommand`
  seam.

See `shared/references/github-actions-adapter.md`,
`shared/references/portfolio-reconciliation.md`, and
`shared/references/safe-execution-design.md` for the modules this stage
composes.
