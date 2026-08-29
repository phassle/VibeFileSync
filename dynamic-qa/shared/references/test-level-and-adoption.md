# Test level inference and adoption (`qa-generate` generation steps 2-3)

Shared reference for `qa-generate`'s generation workflow, built into both
skills by `dynamic-qa/build.sh` from this single source
(`dynamic-qa/shared/references/`) — see `dynamic-qa/DECISIONS.md` §13. It
replaces the placeholder prose #146 left in `qa-generate/SKILL.md` steps 2
and 3 with the real decision procedure, backed by two deterministic-core
modules under `shared/scripts/`: `level-inference.mjs` and `adoption.mjs`.

## Step 2 — adopt an existing test, or generate

Before authoring anything new, ask whether a pre-existing, already-in-repo
deterministic test proves every Expected Outcome the flow declares. This is
answered by `adoption.mjs`'s `evaluateAdoptionCandidate(flowData, candidate)`,
where `candidate` is `{ sourcePath, assertions }` and `assertions` is the
candidate's claimed `[{ stepId, outcomeId, location }]` list — discovering
that mapping (reading the existing test, matching its checks back to Flow
step/outcome IDs) is the one genuinely interpretive part of this step and
belongs in the skill's judgment, not in the deterministic core.

**Adoption is provable, not optimistic.** `evaluateAdoptionCandidate`
delegates the actual coverage question to #146's own
`expected-outcome-coverage.mjs` (`checkAssertionCoverage`) — the same
function generation's own step 4 already uses to gate a freshly written
Binding. There is no second coverage checker. Three outcomes:

- `{ adopt: true, sourcePath, assertions }` — every declared Expected
  Outcome is proven by the candidate's own claimed assertions. Adopt this
  test: do not generate a duplicate. Record it in provenance via
  `adoptionGeneratorFields(sourcePath)`, which returns the exact
  `{ identity: "adopted", adoptedFrom }` shape `provenance.mjs`'s
  `buildBindingRecord` requires for an adopted Binding's `generator` field.
- `{ adopt: false, reason: "partial-coverage", errors }` — the candidate
  proves *some* outcomes but not all (or claims an assertion against an
  outcome the flow does not declare). This never qualifies for adoption,
  no matter how close to complete. Fall through to generation; `errors`
  names exactly which outcomes are unproven, for the review packet.
- `{ adopt: false, reason: "no-candidate" | "unverifiable-candidate" }` —
  no candidate was found, or discovery could not produce a checkable
  assertion list for one. Generation proceeds; adoption never happens on a
  guess that a test with a plausible name "probably" covers the flow.

## Step 3 — infer the cheapest deterministic level

When generation proceeds (no adoption), select a test level with
`level-inference.mjs`'s `selectTestLevel(candidates, options)`.

**There is no universal API-versus-CLI ranking, and this module enforces
none.** A `candidate` is `{ id, safe, provesAllOutcomes, observable, cost }`,
where `id` is an open-ended level name ("api", "cli", "browser", or
whatever the discovered harness actually supports for this flow) and `cost`
is `{ reuse, runtime, fixtureComplexity, boundaryFidelity, maintenance }` —
five non-negative numbers the skill derives from what it observed for *this*
flow against *this* repository's harness (reuse an existing fixture vs.
stand up a new mock server, an existing CLI runner vs. a browser driver not
yet wired in, etc.). The same level id can win on one flow and lose on the
next; only the numbers decide.

**Elimination happens strictly before cost.** A candidate with
`safe: false`, `provesAllOutcomes: false`, or `observable: false` is
discarded — in that check order — with a stated reason, and never enters
cost comparison. Derive `safe` from `resolveBoundaryTreatment`
(`boundary-policy.mjs`, #145): a level that can only be realized through a
forbidden or unhonourable boundary treatment is unsafe. `provesAllOutcomes`
and `observable` are level-specific judgments the skill makes by inspecting
what each candidate layer can actually assert and observe for this flow's
declared outcomes.

Among surviving candidates, `selectTestLevel` sums the five cost fields and
picks the lowest total, breaking ties by ascending `id` for reproducibility.
The result records `selection: "inferred"`, the winning `levelId`, a
`reason` naming the total cost and how many candidates survived, every
`eliminated` candidate with its code (`unsafe` | `incomplete` |
`unobservable`), and the full `ranked` list — write all of it into the
Provenance Manifest's `testLevel` field (§5.5) so the rationale is
reviewable, not just the winner's id.

**A Test Level Override is explicit and reviewed, never inferred.** Pass
`options.override = { levelId, reviewed, reason }` only when a human — the
QA Owner, during Flow Review or a later explicit review — has recorded that
this flow's journey itself is the required evidence (SPEC-135 story 32).
`reviewed` must be `true` as caller-supplied evidence (the same pattern
preflight already uses for its two approval booleans — this skill supplies
evidence, it never re-derives or defaults it), and `reason` must be
non-empty. An override still has to name a level that survived elimination:
it can keep a true end-to-end journey over a cheaper alternative, but it can
never bypass safety, completeness, or observability. Any missing review
evidence, missing reason, or reference to an eliminated/absent level fails
closed (`ok: false`) rather than silently falling back to inference.

## Wiring into `qa-generate/SKILL.md`

This reference is prose-only; it is not itself the skill's numbered
workflow text. See the implementer's report for the exact replacement text
and the exact step 2/3 placeholders it replaces — that edit is made
centrally, not by this ticket, to avoid two tickets colliding on the same
file.
