# Failure diagnosis: independent axes and repair eligibility (#158)

`qa-generate`'s repair mode diagnoses every failure on two **genuinely
independent** axes before anything else happens. Neither axis is inferred
from the other.

- **Failure Owner** — `product | binding | environment | unresolved`
- **Repeatability** — `deterministic | intermittent | unknown`

**Failure Class is derived, never assigned.** `deriveFailureClass(owner,
repeatability)` in `shared/scripts/diagnosis.mjs` is the single source of
truth for the full 4 x 3 = 12-combination table:

| Owner \ Repeatability | deterministic | intermittent | unknown |
| --- | --- | --- | --- |
| product | product-regression | product-regression | product-regression |
| binding | binding-defect | test-flake | unclassified-failure |
| environment | environment-failure | test-flake | unclassified-failure |
| unresolved | unclassified-failure | unclassified-failure | unclassified-failure |

## Modules

- `shared/scripts/diagnosis.mjs` — `deriveFailureClass`,
  `validateDiagnosisRecord`, `validateAttempt`, `appendAttempt`,
  `originalAttempt`, `assertOriginalAttemptStaysFailed`, `isRepairEligible`.
- `shared/schemas/dynamic-qa-diagnosis-v1.schema.json` — the Diagnosis
  Record's human-readable shape (business rules that a JSON Schema cannot
  express live in the validator, per this bundle's usual split).

## A retry pass never proves flake

`repeatabilityBasis` names what actually grounds the repeatability call:
`retry-pass | reproduction | hypothesis-probe | historical-evidence |
external-report | insufficient-evidence`. `validateDiagnosisRecord`
structurally refuses any record where `repeatabilityBasis` is `retry-pass`
and `repeatability` is anything but `unknown` — a single passing retry can
justify neither "intermittent" (flake) nor "deterministic" (fixed). It is
recorded, honestly, as an attempt of `kind: "retry"` in the record's own
`attempts` list, and nothing in this module derives a repeatability
conclusion from that list automatically.

## A failed attempt stays failed

`attempts` is append-only. `appendAttempt` never edits an existing entry —
every prior entry is re-frozen and copied verbatim, the new entry is
validated and frozen, and a second `kind: "original"` attempt is refused
outright. `assertOriginalAttemptStaysFailed(before, after)` compares the
`original` attempt across two attempts lists and throws on any drift,
including a changed verdict. The original failed attempt is therefore
provably unchanged after a retry, a repair-verification run, or a
quarantine check — historical evidence stays truthful.

## Routing by owner

- **Product Regression**: keep failed, link/create a product defect
  (`productDefectRef`), **no Binding-mutation field exists on this record
  at all** — a Product Regression cannot hide behind a test edit because
  there is nowhere on the Diagnosis Record to put one.
- **Environment Failure**: `owner: "environment"` requires a non-empty
  `failedCapability` — the exact failed capability, never a vague "infra
  flaked". Test code is never patched for this class.
- **Binding Defect**: the only class eligible for repair (see below).
- **Test Flake** (`binding` or `environment` / `intermittent`): tracked
  with its owner; any Binding stabilization is a distinct, narrower action
  that #159/#160 may build — it is **not** general repair eligibility.
- **Unclassified Failure**: no repair; more safe evidence is requested.

## Repair eligibility: ineligible by default

`isRepairEligible(record)` returns `true` only when **all** of the
following hold: the record passes `validateDiagnosisRecord`, `status ===
"confirmed"`, `owner === "binding"`, and `failureClass ===
"binding-defect"`. Any malformed record, any `provisional` or
`safety-blocked` status, any non-`binding` owner, and the `binding` +
`intermittent` (Test Flake) combination are all ineligible. This function
never throws — a record it cannot make sense of is ineligible, not an
exception a caller must remember to catch. #159/#160 own repair itself;
this ticket owns only the gate deciding whether a diagnosis may reach it.

## Seam: `qa-generate/SKILL.md`

`qa-generate/SKILL.md`'s repair-mode step 3 currently reads (unedited by
this ticket, per coordination — SKILL.md files are owned elsewhere):

> 3. **Diagnose** Failure Owner and Repeatability, emit a Diagnosis Record —
>    placeholder, same scope.

A later wiring ticket should replace that placeholder with a call into
`deriveFailureClass` / `validateDiagnosisRecord` from this module, and wire
step 4's gate ("only `confirmed + binding-owned` crosses into repair —
placeholder, same scope") to `isRepairEligible`.
