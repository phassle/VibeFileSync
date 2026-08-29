---
name: qa-setup
description: "Create or resume the QA-owned critical-flow contract, safe execution profiles, measurement plan, and provider-native CI proposal for the current repository. Use only when explicitly invoked; never starts from natural-language intent."
disable-model-invocation: true
metadata:
  version: "{{BUNDLE_VERSION}}"
---

STATUS: stages 1–5 built (ticket #162: authority and sourced inventory;
ticket #163: posture-specific evidence; ticket #164: risk ranking and
one-flow interviews). Stages 6–10 remain placeholders for later tickets — do
not invent their content here. See
`dynamic-qa/DESIGN-dynamic-qa-spec.md ## 6. qa-setup SKILL.md outline` (run
notes) for the full target workflow this file will grow into,
`dynamic-qa/shared/references/authority-and-inventory.md` for stages 1–2,
`dynamic-qa/shared/references/posture-specific-evidence.md` for stage 3, and
`dynamic-qa/shared/references/candidate-ranking-and-interviews.md` for
stages 4–5 below.

## Explicit invocation only

`qa-setup` never starts from natural-language intent, a coordinator inferring
work, or another skill invoking it implicitly. `disable-model-invocation: true`
above is the portable half of that gate; the Codex build additionally carries
`policy.allow_implicit_invocation: false` in its `agents/openai.yaml` overlay
(see `dynamic-qa/codex/qa-setup/agents/openai.yaml`). A harness without either
mechanism must still only start this skill from an explicit user or coordinator
selection — never from matching this description against a request.

Entry forms this skill will accept once built:

```text
qa-setup
qa-setup resume
qa-setup review <flow-id>
```

## Invoking with no argument is side-effect free

The bare `qa-setup` form only orients: it reports whether setup is new or
resumable and what evidence exists (stage 2's Setup Inventory is part of that
report). The bare form MUST do nothing beyond authority checks and read-only
inventory. No repository file, provider policy, secret, or piece of
infrastructure is created, edited, or touched by invoking `qa-setup` with no
argument, at any stage of this skill's implementation — discovery stops well
before the Setup Review Packet (stage 10) that is the earliest point any
write is permitted.

## Installation precondition: a verified Dynamic setup profile

Before doing anything else — including the no-argument orientation report —
confirm a present, schema-current, unexpired, `verified` `dynamic-skills-setup`
capability profile exists for the harness in use (see
`~/.agents/dynamic-skills/capabilities.json`, or the path named by
`DYNAMIC_SKILLS_PROFILE`). "Verified" here additionally requires that harness's
`mattCodeReview: true` and a matching `reviewRoutes[]` entry, per the parent
spec's dependency on that field for review-route trust.

If the profile is absent, stale (past its harness's `catalog.expiresAt`), on an
unsupported `schemaVersion`, or not `verified` for this harness, **stop
immediately** and print the exact manual setup command for the current host —
do not invoke `dynamic-skills-setup` yourself:

| Host | Manual setup entry |
| --- | --- |
| Codex CLI/IDE/app | `$dynamic-skills-setup`, or select `dynamic-skills-setup` through `/skills`. |
| Claude Code | `/dynamic-skills-setup` |
| GitHub Copilot CLI/app | `/dynamic-skills-setup` |
| OpenCode | `/dynamic-skills-setup` through the installed custom-command adapter. |
| Pi | `/skill:dynamic-skills-setup` |

This mirrors `dynamic-implement`'s own manual-setup-entry table exactly; `qa-setup`
does not define a setup command of its own.

## Stage 1: Orient and establish authority

Before eliciting any flow, establish the responsible QA Owner's authority so
an agent can never impersonate the accountable human.

1. **Check the invocation gate first.** Classify how this run started
   (explicit user command, explicit coordinator selection, or anything else)
   and evaluate it against `shared/scripts/authority.mjs`'s
   `evaluateInvocation`. Anything other than an explicit command or explicit
   coordinator selection — a natural-language mention, an inferred intent,
   another skill invoking this one on its own initiative, or a source this
   skill doesn't recognize — stops immediately with reason
   `not-explicit-invocation` (or `unrecognized-invocation-source`). Nothing
   past this point runs.
2. **Identify who holds each gate.** Ask, in plain language, who is the
   responsible QA Owner for this repository and who is the Technical Owner
   for harness/CI/dependency consequences. These are two independently
   tracked gates (`qaOwnerGate`, `technicalOwnerGate`) — never a single
   combined "approved" answer. It is fine for one human to hold both gates;
   it is not fine to record them as one field. Validate the resulting
   record with `authority.validateAuthorityRecord` before proceeding —a gate
   marked present with no named identifier, or a record that tries to merge
   the two gates, fails closed.
3. **Stop if no QA Owner is present.** Setup does not proceed into flow
   elicitation while the QA Owner gate is absent. Print a readiness
   checklist naming what is missing and stop. This is a judgment call about
   whether the named human's authority is credible for this repository —
   ask, listen, and decide; do not accept a bare assertion of role at face
   value if it is inconsistent with what discovery (stage 2) or the
   conversation so far shows.
4. **A Domain Expert joins flows, not ownership.** If a Domain Expert is
   named (someone who can answer specific flow questions but is not
   accountable for QA policy), record them with an explicit, non-empty
   `scope` — the flow(s) their input applies to. An unscoped "expert" is
   indistinguishable from a QA Owner and `validateAuthorityRecord` rejects
   it. Domain Experts are invited into stage 5's per-flow interview later;
   they are never asked to approve the portfolio or the review packet.

See `shared/references/authority-and-inventory.md` for the full rationale
and the deterministic core's test coverage for each rule above.

## Stage 2: Inventory facts read-only

Before asking the QA Owner anything about policy, inspect what is actually
in the repository, so they decide policy instead of reciting facts you could
have found yourself.

1. **Run the inventory scan.** Call
   `shared/scripts/inventory.mjs`'s `buildSetupInventory(repoRoot)`. It
   combines:
   - existing tests and the outcome they already prove
     (`inventory-tests.scanExistingTests`);
   - frameworks, fixtures, mocks, clocks, cleanup, reporting
     (`inventory-tests.scanTestFrameworks`, `scanTestSupportKeywords`);
   - CI triggers, runners, services, environments, merge queues, checks,
     artifacts, and secret **names** (`inventory-ci.scanCiWorkflows`).
   Every returned fact carries `observed`, `reported`, or `unknown`
   provenance (`fact.mjs`); the whole inventory is validated before use.
   This scan is read-only by construction — see
   `shared/references/authority-and-inventory.md` for how that is enforced
   and tested.
2. **Present the inventory as evidence, not intended behavior.** Summarize
   what was found (`inventory.summarizeProvenance` gives the
   observed/reported/unknown counts) and be explicit about what is
   `unknown` — do not fill a gap with a plausible-sounding guess. A fact
   about current repository state is never itself a claim about what
   *should* happen; that judgment belongs to the QA Owner in later stages.
3. **Never write anything here.** The Setup Inventory is ephemeral — it
   exists to inform this conversation, not to be committed to the
   repository. Nothing from this stage touches a repository file, provider
   policy, secret, or piece of infrastructure.

See `shared/references/authority-and-inventory.md` for the detailed
breakdown of every fact category and how secret names are handled without
ever reading a value.

## Stage 3: Enter through posture-specific evidence

Brownfield and greenfield need opposite defaults for the same question —
"what should this flow do?" — because one has a running application to
observe and the other does not. This stage exists so the two never get
conflated: an observed bug must never quietly become tomorrow's contract,
and a not-yet-built flow must never get an invented one.

1. **Establish posture explicitly, before anything else in this stage.**
   Ask the QA Owner (or, for harness/CI-flavoured questions, the Technical
   Owner) directly: is this repository brownfield (the application exists)
   or greenfield (it does not yet)? Classify the answer's source
   (`qa-owner-declaration` or `technical-owner-declaration`) and evaluate it
   with `shared/scripts/posture.mjs`'s `evaluatePostureDeclaration`. Do
   **not** decide posture yourself from what stage 2's inventory or
   `posture.repositoryShapeSignal` shows — that signal exists only to give
   the human something concrete to react to ("discovery found substantial
   application code — does 'greenfield' still sound right?"), never to
   settle the question on your own. Anything other than an explicit
   declaration — inferring it from repository shape, assuming a default, or
   a source this skill doesn't recognize — stops immediately with reason
   `posture-not-explicit` (or `unrecognized-posture-source` /
   `unrecognized-posture`). Nothing past this point runs until posture is
   settled.
2. **Brownfield: gather observations, then ask before any of them count.**
   For each behaviour discovery finds worth surfacing, construct it with
   `posture.makeObservationFact` — it always starts `unconfirmed`. Present
   each observation to the QA Owner (bringing in a scoped Domain Expert from
   stage 1 only for the specific question their knowledge answers, never as
   the one who decides) and ask plainly: is this intended, or is it a bug?
   Record the answer with `posture.confirmIntent`, which requires the
   confirming identity to be the QA Owner or Technical Owner —
   **never** the Domain Expert, even if the Domain Expert is the one who
   explained what the behaviour actually does. An observation that stays
   `unconfirmed`, or that the accountable human confirms as
   `not-intended` (a bug), must never be treated as if it were a candidate
   Expected Outcome later — `posture.canBecomeExpectedOutcome` is `false`
   for both, and only `true` once confirmed `intended` by the right
   identity. Do not soften this into "probably fine" or a lighter tolerance
   instead of an explicit question; an unresolved observation is a stage-3
   blocker to carry forward, not a shortcut to fill in.
3. **Greenfield: work only from approved tickets and examples.** With no
   running application to observe, ask the QA Owner which already-approved
   ticket(s) or worked example(s) describe each candidate flow's intended
   behaviour, and record each as a source (`type`, `reference`,
   `approvedBy`, `approvedByRole`) for
   `shared/scripts/posture.mjs`'s `requireApprovedGreenfieldEvidence`. A
   flow with no valid approved source stays blocked for this stage — do not
   invent plausible-sounding behaviour to fill the gap, and do not accept a
   Domain Expert's description alone as the approving authority
   (`approvedByRole` must be the QA Owner or Technical Owner). Use
   `posture.buildGreenfieldFact` to record the result: `reported`,
   citing the approved source, once one exists; `unknown` — not a guess —
   otherwise.
4. **Carry every posture-3 blocker forward, do not paper over it.**
   Disagreement about intent, an observation nobody will confirm either way,
   or a greenfield flow with no approved source all become exact blockers on
   that flow going into stage 4's ranking — never a weaker Expected Outcome,
   a widened tolerance, or a flow silently dropped from consideration.

See `shared/references/posture-specific-evidence.md` for the full rationale,
the exact shape of `brownfield-observation` and `greenfield-source` facts,
and the deterministic core's test coverage for each rule above.

## Stage 4: Rank broadly, then refine

Build the broad Candidate Flow list before any deep interview, so which
flows earn stage 5's interview is a risk-based decision, not an accident of
whichever flow came to mind first.

1. **Build the Candidate Flow list from real evidence only.** Draw
   candidates from stage 2's inventory and stage 3's confirmed evidence
   (`intentStatus: "confirmed-intended"` brownfield observations,
   `greenfield-source` facts with `provenance: "reported"`) — never from
   imagination. For each candidate, construct it with
   `shared/scripts/candidate-ranking.mjs`'s `makeCandidateFlow`, which fails
   closed on a missing originating ticket link, exactly as stage 5's Flow
   Definition will (AC: "each flow linked to originating tickets, so its
   purpose and implementation context remain traceable").
2. **Rank on all five factors, and show all five.** Call
   `candidate-ranking.mjs`'s `rankCandidateFlows` and present every
   candidate's `factorScores` — impact, frequency, change exposure, escape
   history, and whether cheaper coverage already exists — never a single
   combined number alone. Ask the QA Owner whether the ranking matches their
   own sense of risk; a mismatch between the mechanical ranking and the QA
   Owner's judgment is worth surfacing explicitly, not silently overriding
   either way.
3. **The QA Owner decides the portfolio; this stage never pads it.** Once
   the QA Owner has chosen which ranked candidates to carry into stage 5,
   call `evaluatePortfolioSize` with that count. Present the result plainly:
   below the 5–10 guidance band is always a comfortable, allowed outcome —
   ask only whether the QA Owner is confident nothing else rises to this
   level of risk, never whether they want to "round up" to a number. Above
   the guidance band, present the override requirement (a named
   `qa-owner`/`technical-owner` approver plus a reason) rather than silently
   dropping candidates to fit under it. There is no candidate-generating
   function anywhere in the deterministic core — a smaller-than-guidance
   portfolio is never a problem this stage tries to solve by inventing
   coverage.
4. **Carry every stage-3 blocker forward into ranking, not around it.** A
   flow with an unresolved brownfield disagreement or no approved
   greenfield source cannot yet be scored honestly — surface it as a
   blocked candidate, never silently drop it or rank it as if its evidence
   were settled.

See `shared/references/candidate-ranking-and-interviews.md` for the full
rationale and the deterministic core's test coverage for each rule above.

## Stage 5: Interview one flow at a time

For each ranked candidate the QA Owner selected, run one interview and
produce exactly one strict, tech-neutral Flow Definition — never several
flows from one interview, and never a partial one left half-assembled.

1. **Ask one question at a time.** Resolve identity, Given/When/Then,
   Expected Outcomes, Named Data Sets, every boundary/side effect, and
   per-outcome tolerances through a sequence of single, plain-language
   questions — never a combined form asking for several fields at once.
   Give an evidence-backed recommendation where stage 2/3 evidence supports
   one, but let the QA Owner's answer override it.
2. **Cite evidence only through the choke point already built.** When an
   Expected Outcome's wording rests on a specific brownfield observation or
   greenfield source, cite that fact and let
   `shared/scripts/flow-assembly.mjs`'s `evidenceIsEligibleForExpectedOutcome`
   decide eligibility — for a brownfield fact this delegates entirely to
   ticket #163's `posture.canBecomeExpectedOutcome`; do not read
   `intentStatus` directly here. An Expected Outcome may also be authored
   without citing a specific fact (e.g. it follows directly from the
   approved ticket already backing the whole flow); the choke point only
   blocks the case where ineligible evidence is cited and claimed anyway.
3. **State outcomes in product language; tolerances are exact by default.**
   Ask what the QA Owner would actually observe as correct, in plain
   product terms — never a selector, route, or framework detail. A
   tolerance other than exact must be attached to that one outcome and
   requires the QA Owner's explicit choice; a `custom` tolerance
   additionally requires their explicit approval and a stated reason
   (`flow-assembly.mjs`/`flow-definition.mjs` fail assembly without both).
4. **Stop on unresolved disagreement rather than assuming.** If the QA
   Owner and a consulted Domain Expert disagree about a flow's intended
   behaviour, or an answer leaves a required field ambiguous, stop and
   carry the disagreement forward as a blocker — do not soften the
   Expected Outcome, guess a plausible tolerance, or silently pick a side to
   keep the interview moving.
5. **Assemble, validate, and present the exact YAML for review.** Once every
   question for this flow is answered, call
   `flow-assembly.mjs`'s `assembleAndRenderFlowDefinition` to build the Flow
   Definition, validate it against #143's contract, render it as restricted-
   YAML text, and prove the render round-trips (re-parses to the same
   canonical digest). Present that exact YAML to the QA Owner as the
   "Flow Review" — this is the literal source-of-truth contract they are
   agreeing to, not a paraphrase of it. A validation failure (including an
   ineligible cited evidence fact, a missing originating ticket, or an
   unapproved custom tolerance) is a blocker to resolve with the QA Owner
   before moving to the next flow, never a shape to quietly relax.

See `shared/references/candidate-ranking-and-interviews.md` for the full
rationale and the deterministic core's test coverage for each rule above.

## Stages not yet built (placeholders for later tickets)

Each numbered stage below is a placeholder. Do not invent its content here;
implement it in the ticket that owns it.

6. **Reconcile the portfolio** — placeholder, same scope.
7. **Define safe execution (Execution Profiles, Capability Gate)** — placeholder,
   same scope.
8. **Establish measurement readiness (Baseline Plan)** — placeholder, same scope.
9. **Design CI last (provider-native proposal)** — placeholder, same scope.
10. **Review once, then emit (Setup Review Packet, dual approval)** — placeholder,
    same scope.

## Dependencies

Requires the installed `grilling` and `domain-modeling` skills (Matt Pocock
skill set, tracked in `skills-lock.json`). Uses the repository's issue tracker
and documented Git workflow. Never creates its own product backlog.

## Self-containment

This skill reads only files under its own installed directory
(`SKILL.md`, `references/`, `assets/`, `scripts/`) plus the
`dynamic-skills-setup` capability profile named above. It never reads from a
sibling `qa-generate` installation, and is installable on its own.
