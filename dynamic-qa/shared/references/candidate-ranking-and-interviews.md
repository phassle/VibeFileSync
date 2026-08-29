# Candidate Ranking and One-Flow Interviews (`qa-setup` stages 4-5)

Shared reference for `qa-setup`'s stages 4 and 5. Built into both skills by
`dynamic-qa/build.sh` from this single source (`dynamic-qa/shared/references/`)
— see `dynamic-qa/DECISIONS.md`.

The mechanical parts of these stages are deterministic-core modules:
`shared/scripts/candidate-ranking.mjs` (stage 4) and
`shared/scripts/flow-assembly.mjs` plus `shared/scripts/flow-yaml.mjs`
(stage 5), each covered by its own `node:test` suite. This document
describes what those modules do and why, so `qa-setup/SKILL.md`'s stage 4-5
prose can stay short and point here.

## Why a broad list, ranked, before any deep interview

A per-flow interview (stage 5) is expensive: it asks the QA Owner many
detailed questions and produces a strict contract. Running it against
whatever flow happens to come to mind first makes the resulting portfolio an
accident of attention, not a reflection of risk. Stage 4 exists to force the
opposite order: build the broad Candidate Flow list from stage 2's inventory
and stage 3's confirmed evidence FIRST, rank it explicitly, and only then
choose which candidates earn a stage 5 interview.

## Ranking is explainable, never a single opaque score

`candidate-ranking.mjs`'s `scoreCandidateFlow(candidate)` returns all five
factors SPEC-135.md names (stories 13-14) individually:

- `impact`, `frequency`, `changeExposure` — ordinal (`low`/`medium`/`high`/
  `critical`), scored 0-3.
- `escapeHistory` — a raw count of past escaped regressions, capped at 3 for
  scoring (the raw count is still reported as `escapeHistoryRawCount`, never
  hidden).
- `cheaperCoverageExists` — a boolean; when `true` it SUBTRACTS from the
  total rather than adding, because cheaper coverage already existing is
  exactly the case where this flow's place in an expensive portfolio is
  weaker, not stronger.

`total` is the plain, documented sum of those five contributions —
never computed, hidden, or overridden by anything else. `rankCandidateFlows`
sorts by `total` descending, ties broken by ascending candidate id, so the
same input always produces the same order (Tier 1: "ranking is deterministic
and explainable for a fixed input"). Changing any one of the five factors
changes a candidate's `total` and therefore its rank — Tier 1 proves this for
each factor independently.

## Every candidate links its originating ticket(s)

`makeCandidateFlow` throws (fails closed) on an empty or malformed
`originatingTickets` list — the same "no candidate without a traceable
source" requirement the Flow Definition schema (`origin.tickets`, #143)
enforces later for the flow itself (SPEC-135.md story 17).

## Never pad to a quota — this is structural, not a convention

There is no function in `candidate-ranking.mjs` that invents, duplicates, or
synthesizes a Candidate Flow. `rankCandidateFlows` only ever reorders and
annotates the exact array it was given — it can never return more entries
than it received (Tier 1: "rankCandidateFlows never returns more entries
than it was given"). If a QA Owner wants a bigger portfolio, the only path
is back through discovery (stages 2-3) to find more real evidence; there is
no shortcut through this module that could quietly generate a plausible-
looking filler flow.

## The 5-10 portfolio size is guidance, not a hard cap

`evaluatePortfolioSize(selectedCount, override)`:

- **Below 5**: always `allowed: true`, `requiresOverride: false`. Approving
  fewer flows than the guidance minimum, when that is genuinely sufficient
  coverage, is a first-class, comfortable outcome (SPEC-135.md story 15) —
  there is no code path in this function that can refuse or flag it as
  deficient beyond the informational `band: "below-guidance"` label.
- **5 through 10**: `allowed: true`, `requiresOverride: false` — the normal
  band (story 16).
- **Above 10**: requires an explicit, reviewed override — a named approver
  holding the `qa-owner` or `technical-owner` role (`fact.mjs`'s
  `CONFIRMING_ROLES`, reused rather than reinvented) plus a plain-language
  reason. Without a valid override, `allowed: false` — but this function
  never itself truncates the candidate list to fit under the cap. Silent
  truncation would be the "quota" failure mode in reverse: a portfolio that
  quietly loses real, evidence-backed coverage to satisfy a guidance number
  is exactly as wrong as one that invents coverage to reach it.

## Stage 5: one flow, one Flow Definition, one interview at a time

`flow-assembly.mjs`'s `assembleFlowDefinition(interview)` takes one flow's
resolved interview answers (never free text — the interview's own judgement
about phrasing questions and interpreting answers stays in
`qa-setup/SKILL.md` prose) and assembles exactly one Flow Definition, then
validates it against #143's `flow-definition.mjs` — never a parallel or
looser check. `assembleAndRenderFlowDefinition` additionally renders the
result as restricted-YAML text (`flow-yaml.mjs`) for stage 5's "exact YAML
Flow Review" (SPEC-135.md story 37) and PROVES the round trip: the rendered
text re-parses to a schema-valid Flow Definition whose canonical digest
(`canonical-digest.mjs`, #143) is identical to the original assembled
value's digest.

### The evidence choke point is reused, never re-derived

`evidenceIsEligibleForExpectedOutcome(fact)` is how an Expected Outcome may
cite a specific evidence fact:

- `brownfield-observation` → delegates entirely to `posture.mjs`'s
  `canBecomeExpectedOutcome` (ticket #163's choke point). This module does
  not read `intentStatus` itself.
- `greenfield-source` → eligible exactly when `posture.mjs` already recorded
  `provenance: "reported"` (which only happens once
  `requireApprovedGreenfieldEvidence` found a valid approved source). An
  `"unknown"` greenfield fact is never eligible.
- anything else, including no cited fact at all, is not eligible to be
  cited as evidence — but an Expected Outcome MAY be authored without
  citing a specific fact; this function only gates the case where one IS
  cited and is not eligible.

An interview that tries to cite an unconfirmed observation, a confirmed bug,
or an unbacked greenfield source as an Expected Outcome's evidence fails
assembly with a specific, non-silent error naming the outcome and the fact.

### Tolerances, Given/When/Then, and product language

These are #143's contract, unchanged here: tolerances nest under their one
Expected Outcome and are exact by default; a `custom` tolerance requires
`approved_by` and `reason` (schema-enforced, re-exercised end to end by this
ticket's own tests); Given/When/Then steps are plain `given`/`when`/`then`
kinds with tech-neutral `intent` text — no Cucumber runtime, no BDD library,
just the schema's own step-kind enum (SPEC-135.md story 20). Expected
Outcome text is checked for product language the same narrow,
literal-denylist way #143 already does (`flow-definition.mjs`'s
`FORBIDDEN_TEMPLATE_MARKERS`); this ticket adds no new text-content rule.

## What stays in `qa-setup/SKILL.md` prose, not here

Deliberately **not** in the deterministic core: how to phrase each interview
question so exactly one is asked at a time; how to tell genuine unresolved
disagreement apart from a QA Owner who just needs the question restated;
how to react to a free-text description of a flow's behaviour before
recording it as a structured interview answer; and whether a candidate's
qualitative factor levels (`impact`/`frequency`/`changeExposure`) are
well-judged given the evidence stage 2/3 found. Those are judgement calls
for the prompt, not checkable rules.
