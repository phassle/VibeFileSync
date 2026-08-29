# Portfolio Reconciliation (`qa-setup` stage 6)

Shared reference for `qa-setup`'s stage 6. Built into both skills by
`dynamic-qa/build.sh` from this single source (`dynamic-qa/shared/references/`)
— see `dynamic-qa/DECISIONS.md`.

The mechanical parts of this stage are one deterministic-core module,
`shared/scripts/portfolio-reconciliation.mjs`, covered by its own `node:test`
suite. This document describes what it does and why, so
`qa-setup/SKILL.md`'s stage 6 prose can stay short and point here.

## Why reconciliation is a separate stage from the interview

Stage 5 (#164) assembles and validates exactly one Flow Definition per
interview, in isolation — it never looks at any other flow. A portfolio
built purely from independently-sensible interviews can still be
incoherent: two flows can duplicate each other, use the same Expected
Outcome id to mean two different things, classify the same dependency
differently, or point at a shared real side effect without agreeing how it
should be isolated or how often it should run. Stage 6 is the one place
that looks at the *whole* set at once.

## What `portfolio-reconciliation.mjs` checks, and what each proves

- **`findDuplicateFlows`** — the same flow id declared twice, or two
  different flow ids whose Given/When/Then steps and Expected Outcome
  wording are identical once normalized (ignoring id/title/revision). A
  duplicate is one contract authored twice, not two independently justified
  flows.
- **`findContradictoryOutcomes`** — the same Expected Outcome id reused
  across flows with different wording. A stable semantic outcome id
  (SPEC-135 story 19) is supposed to mean one claim everywhere it appears;
  divergent wording under the same id is a named contradiction to resolve,
  never something this module picks a side on.
- **`findBoundaryTreatmentConflicts`** — the same Boundary Declaration id
  (the same crossed dependency, per #145) classified differently across
  flows: different `real`/`simulated`/`forbidden` treatment, or disagreement
  about whether it is `volatile`.
- **`findIsolationNamespaceCollisions`** — two flows both declare a `real`,
  side-effecting boundary with the literal same `isolation.namespace`.
  Individually well-formed per #145, but identical across flows means
  concurrent runs of both flows could corrupt each other's data.
- **`findDataSetIssues`** — a flow's `data_sets` reference that does not
  resolve against a caller-supplied resolver (mirroring #144's
  `resolve-data-sets.mjs` contract: the resolver, and therefore knowledge of
  where Named Data Sets live, is always the caller's to supply). Omitting
  the resolver skips this check rather than guessing at resolution.
- **`classifyCandidateLane` / `findLaneAssignmentConflicts`** — a
  lightweight signal (real side-effecting boundary, or an explicit
  end-to-end/browser test-level override, implies a nightly candidate;
  otherwise pr-fast) used to flag when two flows sharing a real
  side-effecting dependency would, apart from that shared dependency,
  otherwise land in different candidate lanes. This is NOT CI design (that
  is stage 9, a later ticket) — it is only the coherence signal stage 6
  needs so stage 9 does not inherit an unresolved disagreement about how
  often a shared risk should be exercised.
- **`findStateDeclarationConflicts`** — a flow that declares a state other
  than `draft` while some other check above named it in an unresolved
  issue. A flow cannot claim to be further along than the reconciliation it
  has not cleared.

`reconcilePortfolio(flows, { resolveDataSet })` runs every detector and
returns `{ issues, issuesByFlowId, isPortfolioCoherent }`. It never removes,
merges, or auto-resolves anything it finds; there is no "resolved" input at
all. Resolving a conflict happens by a human changing the underlying Flow
Definitions until a re-run stops reporting it.

## The draft-retention rule is structural, not a review step

SPEC-135 story 39 — "unresolved disagreement keeps a flow draft" — is
enforced so that it cannot be bypassed by mistake or by intent:

- `issuesForFlow(report, flowId)` throws if `report` is not a real
  `reconcilePortfolio` result. A caller cannot pass `undefined` or a stray
  object and have it silently read as "no issues".
- `evaluateFlowForPortfolio` and `recordFlowApproval` call `issuesForFlow`
  FIRST, before looking at any approval input. Every "this flow has an
  outstanding issue" path returns `{ approved: false, state: "draft" }`.
  `recordFlowApproval` accepts nothing that can flip that outcome — there is
  no override, force-approve, or "resolved" flag in its signature.
- Only once a flow is eligible does `recordFlowApproval` look at the
  approval record itself, and even then requires an explicit
  `qa-owner`/`technical-owner` record (`fact.mjs`'s `CONFIRMING_ROLES` —
  reused, not reinvented; a Domain Expert may inform a flow but never
  approves it, consistent with #163's `confirmIntent`).
- `evaluatePortfolioApproval` rolls per-flow results up to a portfolio-level
  `portfolioFullyApproved` boolean. One draft-retained flow keeps it
  `false` — the spec's framing is that the portfolio is simply not fully
  approved, not that this is an error to route around.

## The exact-YAML review is byte-identical by construction

`buildFlowReview(flow, reconciliationReport)` renders a flow's YAML by
calling `flow-yaml.mjs`'s `renderFlowDefinitionYAML` directly — the same
renderer #164 built for stage 5's own Flow Review, and the same renderer a
later write to the repository would use. There is exactly one rendering
path; this module imports it rather than reimplementing or wrapping it, so
there is no second code path that could drift from what would actually be
written.

## Where the genuine judgement stays

Presenting a named conflict to the QA Owner in plain language, and deciding
(as a human) how to reconcile it — rename an outcome, reclassify a
boundary, drop a duplicate, adjust a namespace — is real judgement and
stays in `qa-setup/SKILL.md` prose. This module only ever names a specific
structural disagreement between specific flows; it never interprets which
side of a disagreement is right.
