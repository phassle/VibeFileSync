# Setup Review Packet, emit patch and stop (qa-setup stage 10)

Ticket #169. SPEC-135 User Stories 47–48: "As a responsible QA Owner, I
want one Setup Review Packet covering contract, data, safety, harness,
dependency, CI, and unresolved requirements, so that approval is informed"
and "As a responsible QA Owner, I want setup to emit a patch and stop, so
that generation, merging, policy changes, and pilot execution remain
separate actions."

This document is the human-facing walkthrough for stage 10. It does not
restate #162's authority-gate rationale, #165's portfolio-approval
rationale, #166's Execution Profile rationale, #167's Baseline Plan
rationale, or #168's CI-design rationale — see their own reference docs.
This explains how stage 10's own module
(`shared/scripts/setup-review-packet.mjs`) composes them into one packet
and one emission gate.

## This is the earliest point qa-setup can write

Stages 1–9 either read only, or — #167's Baseline Plan alone, a documented
exception SPEC-135 story 44 requires ("setup resumable... measurement can
span days without hidden session state") — write ONE resumable bookkeeping
file. Every other customer-repository artifact this bundle produces (Flow
Definitions, Named Data Sets, Execution Profiles, the bundled schemas) is
held only in memory until `emitSetupReviewPacket` says both approvals are
satisfied and measurement is ready. See DECISIONS.md #30 for the full
accounting of that one exception and how it differs from what this ticket
guarantees for every other artifact.

## Seven required areas, checked, not just named

`assembleSetupReviewPacket` builds each of `REQUIRED_PACKET_AREAS`
(contract, data, safety, harness, dependency, ci, unresolvedRequirements)
independently from a dedicated builder. A builder throws when its own
required upstream input (portfolioApproval, executionResults, a
baselinePlan, a ciProposal, ...) is missing or malformed; the assembler
catches each area's failure separately and records it in `missingAreas`
rather than aborting the whole assembly. This mirrors #166's own "every
Safety Blocker in one pass" composition: a reviewer — and
`validateSetupReviewPacket` — sees every missing area at once, never just
the first one encountered. A packet with anything in `missingAreas` is
rejected by `validateSetupReviewPacket`, structurally, before it is ever
presented as "the packet."

Each area is a straight read of an earlier ticket's own result — nothing
here re-derives portfolio approval, execution activation, CI lane
assignment, or measurement readiness:

- **contract** — every flow, which are approved vs. draft (#165).
- **data** — every Named Data Set supplied (in-memory; setup authors these
  the same way it authors flows, so nothing here reads from disk).
- **safety** — every Execution Profile result, split into activated vs.
  deferred, with each deferred flow's exact Safety Blockers (#166).
- **harness** — the existing test-framework/fixture/mock/clock/
  cleanup/reporting facts stage 2 already inventoried.
- **dependency** — the CI proposal's own named infrastructure (runners,
  environments, triggers, existing workflow paths) and whether the
  profile's runner class was actually observed in this repository's CI
  (#168's `runnerMatchesInventory`) — read from the CI proposal, never
  re-scanned.
- **ci** — the CI proposal itself: provider, lanes, and the smallest-diff
  choice (#168).
- **unresolvedRequirements** — draft flows, deferred profiles' blockers,
  `measurement-required` baseline metrics, and unassigned CI lanes, named
  plainly so approving this packet means approving it WITH these gaps
  visible, never a packet that looks more finished than it is.

## Dual approval reuses #162's gates — it is not a second model

`authority.mjs`'s own header names "the Setup Review Packet" as one of the
two places `GATE_KEYS` (`qaOwnerGate`, `technicalOwnerGate`) is reused —
this ticket is that reuse. `evaluateSetupReviewApproval` calls
`validateAuthorityRecord` and `gatesAreIndependent` directly; the only new
meaning is that `present: true` here answers "has this gate's holder
approved the Setup Review Packet" rather than "does this person hold this
role." The acceptance-harness primitive built for exactly this reuse
(`acceptance/cases/approvals/independent-gates.case.sh`, ticket #162's
concurrent groundwork) is wired to this real gate in
`acceptance/cases/review-packet/withholding-either-approval-emits-nothing.case.sh`.

Withholding either gate, or both, is independent and total: neither
`contractApproved` alone nor `technicalApproved` alone ever produces
`bothApproved: true`, and a malformed or non-independent record (the same
object behind both gate keys) is rejected before either boolean is even
read.

## Emit-then-stop is structural, not a convention

`emitSetupReviewPacket` checks, in this fixed order, and returns
`{ emitted: false, reason }` on the first failure:

1. packet completeness (`"incomplete-packet"`),
2. approval-record validity and gate independence
   (`"invalid-approval-record"` / `"gates-not-independent"`),
3. both gates satisfied (`"contract-approval-withheld"` /
   `"technical-approval-withheld"` / `"both-approvals-withheld"`),
4. Baseline Plan readiness (`"measurement-required"` — #167's own stop
   condition, re-checked here so reaching stage 10 can never bypass it).

Only when none of the above apply does the function build and return the
patch's file list. There is no branch that writes a file, calls a
generator, merges anything, or changes provider/CI policy — the function's
return value is the entire output, and it carries no action handle at all
(no `apply`, `merge`, `generate`, `run`, or `activate` key) for a caller to
invoke next. Presenting that patch to the QA Owner and Technical Owner, for
them to apply through this repository's own normal review process, is the
last thing `qa-setup` does.

## Exactly the expected patch, nothing else

`buildSetupPatchFiles` produces, in a fixed sorted order:

- `qa/flows/<id>.yaml` — approved flows only; a draft flow is never
  materialised.
- `qa/data/<id>.yaml` — only Named Data Sets an approved flow actually
  references (`flow.data_sets`).
- `qa/execution-profiles/<id>.yaml` — every stage 7 result, activated and
  deferred alike (a deferred flow still has a reviewable profile draft).
- `qa/schemas/<file>` — the bundle's own CURRENT schema files, enumerated
  from `shared/schemas/` rather than hard-coded, so a later ticket that
  ships a new schema (quarantine, failure-evidence, ...) widens the patch
  with no code change here — the same "the adapter widens what this stage
  can assign with no prompt or code change" pattern #168 established.
- `qa/baseline-plan.yaml` — the current plan.

Deliberately excluded: `qa/quarantines/*` (nothing is quarantined by
setup) and `qa/provenance.json` (no Binding exists yet — Provenance
Manifest entries are qa-generate's job). The CI proposal is presented in
the packet's `ci` area but is never itself a patch file — no
`.github/workflows/` change is ever part of this patch.

## Assumption a later implementer must know

The `dataSets` array `emitSetupReviewPacket`/`buildSetupPatchFiles` take is
supplied entirely in memory by the caller (stage 5's interview authors
Named Data Sets the same way it authors flows) — this module never reads
`qa/data/` from disk, because nothing has been written there yet at
setup time. `resolve-data-sets.mjs` (#145/#146's disk-reading resolver) is
a different concern for a later, generation-time gate, not this stage.
