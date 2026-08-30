# The Failure Evidence Bundle: strict, structured, immutable (#159)

`qa-generate repair --evidence <bundle>` is the only path into repair, and
this bundle is the only thing that may accompany it. **Default invocation of
`qa-generate` is generation, never repair** — repair happens only when the
bundle is named explicitly. There is no natural-language shortcut into
repair: a prompt, a pasted stack trace, or a scraped console log is not a
Failure Evidence Bundle and cannot satisfy this requirement.

## Modules

- `shared/scripts/failure-evidence.mjs` —
  `validateFailureEvidenceBundle`, `computeBundleDigest`,
  `checkBundleImmutability`, `explainRepairIneligibility`,
  `isBundleRepairEligible`.
- `shared/schemas/dynamic-qa-failure-evidence-v1.schema.json` — the bundle's
  human-readable shape.

## Why prose logs structurally cannot authorize repair

Every field in the schema is one of: an enum, a `sha256:<64-hex>` digest, an
ISO-8601 timestamp, a full 40-character commit SHA, or a string bounded to
`MAX_TEXT_FIELD_LENGTH` (500) characters and run through
`secret-detection.mjs`'s `detectSecretValue`. There is **no** `rawLog`,
`logExcerpt`, `notes`, or any other unbounded free-text field defined
anywhere in the schema or the validator's known-key sets
(`assertKnownKeys` is fail-closed on every nested object, exactly like
every other validator in this bundle). Concretely:

- A caller who passes a bare string, or an object missing the required
  structure, is rejected by `validateFailureEvidenceBundle`'s very first
  checks — before any business rule even runs.
- A caller who tries to smuggle a full console dump into one of the few
  text-carrying fields (`junitFacts[].message`, `expectedVsObserved[].expected
  /.observed`, `fixtureBoundaryEnforcement.fixtureIsolation`,
  `approvedDiagnostics[].label`) is rejected for exceeding the 500-character
  bound, with the exact reason: *"exceeds the 500-character bounded-evidence
  length ... prose logs cannot authorize a code change; only bounded,
  structured facts qualify as repair evidence."*
- The same fields are scrubbed: any value `detectSecretValue` flags is
  rejected with *"looks like unscrubbed secret material"*, so evidence must
  also be scrubbed before it can be evidence at all (see #155's diagnostics
  scrubbing, which this bundle assumes has already run upstream — this
  validator is a second, independent backstop, not a substitute for it).
- Raw diagnostic content is never inline: `approvedDiagnostics` only ever
  carries a `label` plus a `sha256:` digest pointer.

## Immutable: bundleDigest

`bundleDigest` is `canonical-digest.mjs`'s `contentDigest` computed over
every other field. `computeBundleDigest(bundle)` recomputes it;
`checkBundleImmutability(bundle)` compares the stored value against that
recomputation and reports any disagreement — including a single-field edit
made to "improve" evidence to justify a conclusion the original run never
supported. Evidence cannot be edited to justify a conclusion.

## Named run, tied to a source commit

`repository` / `sourceCommit` / `workflow` mirror `result-envelope.mjs`'s
identity fields exactly — the same shape `github-actions-adapter.mjs`'s
`resolveRunReference` already produces from a real run's
`GITHUB_REPOSITORY` / `GITHUB_SHA` / `GITHUB_RUN_ID` / `GITHUB_RUN_ATTEMPT`.
`sourceCommit` must be a full 40-character SHA, never a branch name. The
embedded `diagnosisRecord`'s own `sourceCommit`/`flowId`/`bindingId` must
agree with the bundle's own — `validateFailureEvidenceBundle` cross-checks
this explicitly, so a bundle cannot be recycled to authorize repair of an
unrelated failure by swapping identity while keeping an old diagnosis (or
the reverse).

## Eligibility reuses #158 exactly — it is not re-derived

The bundle embeds exactly one already-produced Diagnosis Record
(`diagnosisRecord`, validated with diagnosis.mjs's own
`validateDiagnosisRecord`, composed rather than reimplemented).
`isBundleRepairEligible(bundle)` composes, in order: shape validation,
immutability, then `diagnosis.mjs`'s `isRepairEligible(bundle.diagnosisRecord)`
— unchanged. Ineligible stays the default. `explainRepairIneligibility`
names the exact reason for every ineligible category:

| Category | Named reason |
| --- | --- |
| malformed diagnosis | "diagnosisRecord is malformed — a malformed Diagnosis Record can never authorize repair" |
| safety-blocked | "routes to the Technical Owner as a Safety Blocker, never to repair" |
| provisional | "the diagnosis is incomplete and must be confirmed before repair can be considered" |
| product | "routes to the Product Owner, never to a Binding repair" |
| environment | "routes to the accountable environment owner, never to repair" |
| unresolved | "diagnosis is incomplete; ask for exact safe evidence, never repair on an unresolved owner" |
| test-flake (binding/intermittent) | "eligible only for optional Binding stabilization, never general repair" |
| unclassified-failure | "did not reach a confirmed binding-defect conclusion, never repair" |
| confirmed + binding + binding-defect | eligible (`null`) |

## One causal hypothesis: what this ticket models, and what #160 owns

`diagnosisRecord.causalChain` is a single non-empty string (diagnosis.mjs),
never an array, so a bundle structurally cannot embed more than one causal
hypothesis inside its diagnosis, and the bundle's own closed key set
(`BUNDLE_KEYS` in failure-evidence.mjs) has no second field — an
`alternativeHypotheses` list, for instance — where a caller could attach one
beside it. **What this module does not own:** actually pursuing only one
causal hypothesis DURING a repair attempt (DESIGN-dynamic-qa-spec.md §7 step
6's "a second causal theory or failed candidate stops; no repair loop") is
repair-execution behavior, not a property of the bundle's shape. **#160
owns that.**

## Seam: `qa-generate/SKILL.md`

`qa-generate/SKILL.md`'s repair-mode steps 1 and 4 currently read (unedited
by this ticket, per coordination — `SKILL.md` files are owned elsewhere):

> 1. **Validate the Failure Evidence Bundle** and original failed conclusion —
>    placeholder for build-scope item 6 (`failure evidence, diagnosis,
>    proposal-only repair, negative-control gate, and quarantine validation`).
>
> 4. **Gate**: only `confirmed + binding-owned` crosses into repair —
>    placeholder, same scope.

A later wiring ticket should replace step 1's placeholder with a call into
`validateFailureEvidenceBundle` / `checkBundleImmutability` from this
module, and step 4's placeholder with `isBundleRepairEligible` (which
already composes #158's `isRepairEligible`).
