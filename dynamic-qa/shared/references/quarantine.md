# Quarantine (#161)

Quarantine is a separate, expiring policy overlay — never a fourth lifecycle
axis. It leaves Flow State, Binding Freshness, and Enforcement State
(`shared/scripts/lifecycle-state.mjs`, #157) exactly as they are, routes the
named Binding to a named advisory lane, and blocks qualification. A skipped
test, a retry, a `fixme`, a deleted CI enrollment, or an expected-failure
marker is not quarantine — none of those is tracked, expiring, or dual-approved.

Module: `shared/scripts/quarantine.mjs`. Schema:
`shared/schemas/dynamic-qa-quarantine-v1.schema.json`.

## What a Quarantine Record requires

- Both approvals, already granted: `approvals.qaOwnerGate` and
  `approvals.technicalOwnerGate`, reusing `authority.mjs`'s own gate shape —
  never a single combined `approved` field.
- A tracked issue (`trackedIssue`, a stable http(s) URI) and an
  `acceptedRisk` statement.
- The originating `diagnosisId` and `originatingFailureRef` — quarantine
  attaches to a diagnosed failure (#158); it does not precede or replace a
  diagnosis, and it never models the Failure Evidence Bundle itself (#159
  owns that schema).
- `evidence`, a non-empty list, frozen at creation and never edited by any
  function this module exports.
- `startAt` / `expiresAt`, with `expiresAt` defaulting to `startAt` + 7 days
  (`DEFAULT_QUARANTINE_DAYS`) when a caller does not supply one. Once
  written, a record always carries an explicit `expiresAt` — there is no
  "never expires" state.
- `effectiveLane`, always exactly `"advisory"` — quarantine can only ever
  loosen a Binding's own CI gating for itself.

`createQuarantineRecord` is the only constructor. It throws unless both
approval gates are already present — there is no default, partial, or
pending-approval path, so nothing in this bundle can manufacture a
Quarantine Record without that explicit human input already in hand.

## Fail-closed: expired and malformed both mean "no exception"

`isQuarantineActive(record, now)` returns `{ active, reason }` with
`reason` one of `"malformed" | "expired" | null`. Both non-active reasons
collapse to the same outcome for every caller in this module: the Binding
is reported exactly as if no quarantine existed, falling back to its real
Flow State / Binding Freshness / Enforcement State. There is no third,
more permissive state, and no code path that reads an expired or malformed
record as still granting the exception.

## Never counts as pass, coverage, or qualification

- `quarantineReportStatus({ testPassed, quarantine, now })` returns
  `countsAsPass: false`, `countsAsCoverage: false`, `countsAsQualifying:
  false` as literals whenever quarantine is active — not a computation over
  `testPassed`, so a caller cannot construct an active-quarantine case that
  reports any of the three as true.
- `contributesToCoverage(bindingId, quarantines, now)` returns `false` for
  any Binding under active quarantine.
- `excludeQuarantinedFromQualifyingRuns` / `summarizeQualifyingRunsExcludingQuarantine`
  filter runs belonging to an actively-quarantined `bindingId`/`flowId`
  **before** handing them to `lifecycle-state.mjs`'s own, unmodified
  `isQualifyingRun` / `summarizeQualifyingRuns` (#157) — reusing that model
  exactly, rather than re-implementing it, to prove a quarantined flow
  cannot qualify.

## Visibility: "missing protection", never silent

`describeQuarantineForReporting(record, now)` always names the Binding and
the reason, even for a malformed or expired record — a quarantined flow
never simply disappears from a report or folds into a generic "OK" line.
An active quarantine's row carries `missingProtection: true`.

## Cannot touch the three lifecycle axes

`quarantine.mjs` imports no mutator from `lifecycle-state.mjs`
(`applyFlowStateChange`, `applyBindingFreshnessReport`,
`applyEnforcementPromotion` are never imported or re-exported), and a
Quarantine Record's own key set shares no key with any of the three axes'
delta shapes (`{to,context}` / `{freshness}` /
`{qualifyingRunSummary,approval}`) — passing a Quarantine Record directly
to any of those three functions is refused on foreign keys alone, before
any transition logic runs (`quarantine.test.mjs` proves this for all
three).

## Automatic quarantine is out of scope

Nothing in `diagnosis.mjs`, `lifecycle-state.mjs`, or this module derives a
Quarantine Record from a Diagnosis Record, a failed run, or an expiry timer.
Quarantine is always an explicit human decision recorded through
`createQuarantineRecord` with both approvals already in hand.
