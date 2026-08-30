# Posture-Specific Evidence (`qa-setup` stage 3)

Shared reference for `qa-setup`'s stage 3. Built into both skills by
`dynamic-qa/build.sh` from this single source (`dynamic-qa/shared/references/`)
— see `dynamic-qa/DECISIONS.md`.

The mechanical parts of this stage are a deterministic-core module,
`shared/scripts/posture.mjs`, covered by its own `node:test` suite
(`posture.test.mjs`) and by extensions to `shared/scripts/fact.mjs` (two new
categories, one new intent-confirmation dimension — see that file's own
header comment). This document describes what those checks do and why, so
`qa-setup/SKILL.md`'s stage 3 prose can stay short and point here.

## Why posture matters this much

Brownfield and greenfield need opposite defaults for the same question —
"what does the application do?" — because one has a running application to
observe and the other does not:

- **Brownfield**: the application exists. What it currently does is real,
  observable evidence — but it is evidence of *current* behaviour, not proof
  of *intended* behaviour. Today's bug, silently accepted, becomes
  tomorrow's regression contract if setup ever treats "this is what happens"
  as "this is what should happen."
- **Greenfield**: the application does not exist yet. There is nothing to
  observe. Setup cannot invent plausible-sounding behaviour for a flow that
  has no implementation — it can only work from what has already been
  approved (a ticket describing the intended behaviour, or a worked
  example), and must say `unknown` rather than guess when neither exists.

Conflating the two — applying brownfield's "observe and confirm" evidence
rules to a greenfield flow, or vice versa — corrupts the resulting contract
either by freezing a bug or by inventing an application. Stage 3 exists to
keep them structurally separate.

## Posture is declared explicitly, never guessed from repository shape

`posture.evaluatePostureDeclaration({ source, posture })` mirrors
`authority.evaluateInvocation`'s explicit-invocation gate exactly:

- `posture` must be `"brownfield"` or `"greenfield"` (`posture.POSTURES`); any
  other value fails closed with `stopReason: "unrecognized-posture"`.
- `source` must be `"qa-owner-declaration"` or `"technical-owner-declaration"`
  — an accountable human stating it. `"inferred-from-repository-shape"` and
  `"assumed-default"` are explicitly recognized as **disallowed** sources
  (`stopReason: "posture-not-explicit"`), and anything unrecognized fails
  closed the same way (`"unrecognized-posture-source"`).

`posture.repositoryShapeSignal(repoRoot)` exists to **inform** the question —
a repository heavy with application code is strong evidence for brownfield,
an empty one for greenfield — but it is read-only (built on `repo-walk.mjs`,
the same primitives stage 2's inventory uses) and its result is never itself
an accepted `source` value. A wrong-but-plausible guess from repository shape
alone is exactly the failure mode this gate exists to prevent.

## Brownfield: observation is evidence, never intended behaviour

Every fact about current application behaviour is constructed with
`posture.makeObservationFact`, which always produces a
`brownfield-observation` fact starting `intentStatus: "unconfirmed"`
(`fact.mjs` rejects any attempt to construct one pre-confirmed — there is no
back door around the interview).

The **only** way an observation's `intentStatus` changes is
`posture.confirmIntent(fact, { decision, confirmedBy, confirmedByRole })`:

- `decision` must be `"intended"` or `"not-intended"` — the accountable
  human decides which, after being asked plainly.
- `confirmedBy` must name a non-empty identity, and `confirmedByRole` must be
  `"qa-owner"` or `"technical-owner"` — **never** `"domain-expert"`. A
  Domain Expert may be consulted on what an observed behaviour means or
  whether it looks intentional (that judgement call is exactly the kind of
  flow-specific clarification `qa-setup/SKILL.md` invites them for, scoped to
  the flow in question), but they can never be the identity that moves the
  fact's status — doing so would let flow-specific clarification stand in
  for QA ownership, which the parent spec forbids.

`posture.canBecomeExpectedOutcome(fact)` is the single choke point a later
stage (stage 5's per-flow interview, a subsequent ticket) must call before
treating an observation as eligible to become a Flow Definition's Expected
Outcome. It is `true` only for `intentStatus: "confirmed-intended"` with a
valid confirming identity attached — **not** for `"unconfirmed"`, and
**not** for `"confirmed-not-intended"` either: an explicitly confirmed bug
must never quietly become the contract just because someone looked at it.

## Greenfield: approved-source-only evidence

`posture.validateGreenfieldSource(source)` validates one evidence source:

```
{ type: "approved-ticket" | "approved-example",
  reference: <ticket id/URL or example path>,
  approvedBy: <non-empty identity>,
  approvedByRole: "qa-owner" | "technical-owner" }
```

`approvedByRole` excludes `"domain-expert"` for the same reason
`confirmIntent` does — approving that a flow's intended behaviour is what a
ticket or example says is an ownership decision, not a clarification.

`posture.requireApprovedGreenfieldEvidence(sources)` is the hard stop: an
empty list, or a list where every entry fails `validateGreenfieldSource`,
returns `ok: false` and setup must not proceed for that greenfield flow.
There is no partial-credit path — a single invalid-shaped "source" cannot be
waved through.

`posture.buildGreenfieldFact(id, description, sources)` produces one
`greenfield-source` fact:

- `provenance: "reported"`, citing the approved ticket/example as
  `evidence`, when at least one valid source exists;
- `provenance: "unknown"` — never a filled-in assumption, never a default —
  when none does. This mirrors stage 2's rule that an unanswerable fact is
  recorded honestly rather than guessed.

## What stays in `qa-setup/SKILL.md` prose, not here

Deliberately **not** in the deterministic core: whether the human's stated
posture is credible given what stage 2's inventory shows (e.g. someone
declaring "greenfield" over a repository full of the very application code
`repositoryShapeSignal` reports); how to phrase the intent-confirmation
question so it invites an honest "no, that's a bug" answer rather than a
reflexive "yes"; and how to react once a Domain Expert has clarified a
flow's behaviour, before the accountable human confirms. Those are judgement
calls for the prompt, not checkable rules — see `qa-setup/SKILL.md`'s stage
3 section.
