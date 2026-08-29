# Flow State, Binding Freshness, and Enforcement State

Shared reference for the lifecycle rules layer over the bundle's three
independent lifecycle axes (DESIGN-dynamic-qa-spec.md §8, SPEC-135.md user
stories 60-64). The deterministic-core module is
`shared/scripts/lifecycle-state.mjs`, covered by
`lifecycle-state.test.mjs`. This document explains what it does and why, so
`qa-setup/SKILL.md` and `qa-generate/SKILL.md`'s own step prose can stay
short and point here rather than re-deriving the rules.

## Three axes, three owners

| Axis | Values | Owned/stored by |
| --- | --- | --- |
| Flow State | `draft`, `deferred`, `active`, `retired` | the Flow Definition contract (`flow-definition.mjs` `FLOW_STATES`) |
| Binding Freshness | `absent`, `current`, `stale` | mechanically derived by the drift gate (`drift-gate.mjs` `FRESHNESS_STATES`, ticket #148) |
| Enforcement State | `advisory`, `required` | recorded in the Provenance Manifest (`provenance.mjs` `ENFORCEMENT_LANES`, ticket #146/#153) |

`lifecycle-state.mjs` re-exports all three enums from the modules that
already own them rather than redeclaring a fourth copy. The independence
this ticket asks for starts here: each axis's value already lives in a
different artifact, validated by a different ticket's module, before this
ticket adds a single rules layer describing how each one may change.

## "A failure must never silently rewrite policy" is structural, not conventional

Each axis has exactly one function that can change it:

- `applyFlowStateChange(record, delta)` — `delta` may only ever contain
  `{ to, context }`.
- `applyBindingFreshnessReport(record, delta)` — `delta` may only ever
  contain `{ freshness }`, and only copies through a value already computed
  by `drift-gate.mjs`'s `evaluateBindingDrift`; nothing here re-derives
  staleness.
- `applyEnforcementPromotion(record, delta)` — `delta` may only ever contain
  `{ qualifyingRunSummary, approval }`.

Every one of the three calls `foreignKeyErrors(delta, <that axis's allowed
keys>, <axis label>)` first, before any transition logic runs. A real
test-runner result — the shape a test actually produces, e.g.
`{ passed, bindingId, failureReason }` — shares no key name with any of the
three allowed-key sets, so handing it to *any* of the three functions is
refused on shape alone: `"<axis> delta carries key(s) ... that do not
belong to the <axis> axis"`. There is no parameter path from "a test
failed" into a state change; a caller cannot even construct a call that
would express it, let alone have that call succeed.

On success, each function returns a **new** record built by spreading the
caller's existing record and replacing exactly its own key — the other two
keys pass through untouched by construction, not by a hand-written
selective-merge that a future edit could widen into an accidental
cross-write.

There is also no reverse-direction function at all: nothing here can move
`required -> advisory` or write `stale` over a Flow's Binding. Demotion and
re-marking staleness are out of scope by omission — the absence of the
function is the guarantee, not a runtime guard sitting in front of one.

## Activation: nine independently-checked requirements

`checkActivationRequirements(evidence)` runs all nine of the ticket's named
requirements, unconditionally, in this fixed order — every one is checked
(no short-circuit), and the result names the **first** unmet one as the
refusal reason:

1. `productBehaviourApproved` — approved product behaviour
2. `deterministicObservability` — deterministic observability
3. `stableInteractionPoints` — stable interaction points
4. `dataIsolationAndCleanup` — isolated data and cleanup
5. `enforceableBoundaries` — enforceable boundaries
6. `capabilityGatePassed` — a passing Capability Gate
7. `candidateBindingVerified` — a verified candidate Binding
8. `provenanceCurrent` — current provenance
9. `bothApprovalsGranted` — both approvals (reuses `authority.mjs`'s
   `qaOwnerGate`/`technicalOwnerGate` shape directly, so "both approvals"
   can never collapse into one combined boolean here either)

`decideFlowActivation(evidence)` is the one function callers use to decide
whether a Flow may move to `active`; mirrors `capability-gate.mjs`'s
`activationDecision` shape deliberately — there is no code path that
returns `activate: true` while any requirement is unmet.

Note: DESIGN-dynamic-qa-spec.md §8 restates this list with slightly
different granularity (splitting "a generated/adopted candidate" and
"isolated verification" where the ticket's own text combines them into "a
verified candidate Binding"). Per the run brief's tie-break rule, the
ticket's nine-item list is what is implemented and tested; the two
descriptions are not in genuine conflict, just different levels of detail
over the same evidence.

## Flow State transitions

`ALLOWED_FLOW_TRANSITIONS` is the fixed table from DESIGN-dynamic-qa-spec.md
§8: `draft -> deferred`, `draft -> active`, `deferred -> active`,
`active -> deferred`, and `{draft, deferred, active} -> retired`. `retired`
never appears as a `from` — its terminal status is the absence of any row
naming it as a source, not a separate special case bolted on top.

`decideFlowStateTransition(from, to, context)` adds the evidence each
transition needs beyond "is this pair in the table":

- `draft -> deferred` requires `context.contractApproved === true`.
- `-> active` requires `decideFlowActivation(context.activationEvidence)`
  to succeed.
- `active -> deferred` requires `context.suspension.reason`, and refuses
  when that reason is one of `FORBIDDEN_SUSPENSION_REASONS` (`test-failure`,
  `flaky`, `slow`, `inconvenient`) — suspension is an exceptional reviewed
  decision that the flow genuinely cannot run, never a QA escape hatch for
  a red suite.
- `-> retired` requires `context.retirement.approvedBy` (a named QA Owner)
  plus `bindingRemoved: true` and `ciEnrollmentRemoved: true` — the live
  Binding and CI enrollment must be removed in the same reviewed change.
  The successful result carries an `auditRecord` (`{ from, to, ...retirement
  }`) so the reviewed change has something concrete to persist; retirement
  can never be reached implicitly through `applyFlowStateChange` without
  this evidence.

## Brownfield vs. greenfield defaults

`resolveActivationEnforcementDefault(posture)`:

- `"brownfield"` -> `advisory` — a brownfield Binding enters advisory
  burn-in on activation, so a new suite cannot destabilize the existing
  merge gate.
- `"greenfield"` -> `required` — a greenfield flow stays `deferred` until
  an implementation change can activate a passing Binding; enforcement
  starts `required` immediately with that first active Binding.
- anything else -> `enforcementState: null` with a reason naming the
  unrecognized posture. There is no silent third default.

## Promotion: measured Qualifying Runs plus explicit approval, never either alone

DESIGN-dynamic-qa-spec.md §8's full Burn-in Qualification is a much larger
measured set (at least 14 days, 20 Qualifying Runs, five source commits,
100 individual candidate executions, a clean pass per Binding, at most 1%
confirmed false-positive/flaky failures, no unresolved flake in the final
10 runs, all failures classified, no unresolved product failure in the
promotion set, PR-fast p95 within budget, continuous safety/provenance
health). **That full measurement is the pilot's job (#171-175), not this
ticket's** — per the run brief, tickets #171-175 build machinery only and
nobody fabricates pilot evidence.

What this ticket models is the one gate its own acceptance criteria name:

- `isQualifyingRun(run)` — a Qualifying Run needs a real `sourceCommit`, a
  real `bindingId`, a `"clean-pass"` outcome, and an explicit
  `comparable: true` flag. An intermittent, failed, or non-comparable run
  never counts.
- `summarizeQualifyingRuns(runs)` — reduces a run list to
  `{ qualifyingCount, totalRuns, distinctSourceCommits }`. There is no
  `elapsedDays` or `greenStreak` field in this shape at all — those are
  exactly the inputs the spec says must never alone change enforcement, so
  they have no representation here for the next function to accidentally
  read.
- `decidePromotion({ qualifyingRunSummary, approval })` — promotes
  (`{ promote: true, enforcementState: "required" }`) only when
  `qualifyingRunSummary.qualifyingCount >= MIN_QUALIFYING_RUNS` (20, the
  spec's own number) **and** `approval` is explicit
  (`{ granted: true, approver: "<name>" }`). Passing only one produces
  `{ promote: false, reasons: [...] }` naming exactly which is missing.
  Because the parameter shape has no field for elapsed time or an
  unqualified streak, no caller can even construct an input that promotes
  on those grounds — the exclusion is structural, the same technique as
  the cross-axis-write guard above.
- `applyEnforcementPromotion(record, delta)` additionally refuses when
  `record.enforcementState !== "advisory"` — promotion only ever applies to
  a Binding currently in the advisory lane it is meant to graduate out of.

## What is not built here (seams for #161 and #172)

- **No storage/schema wiring.** `lifecycle-state.mjs` operates on plain
  in-memory `{ flowState, bindingFreshness, enforcementState }` records and
  evidence objects a caller assembles; it does not read or write
  `qa/flows/*.yaml`, `qa/provenance.json`, or any other on-disk artifact
  itself. A caller composes this module's decisions with
  `flow-definition.mjs`/`provenance.mjs`'s own persistence.
- **No wiring into `qa-setup/SKILL.md` or `qa-generate/SKILL.md` step
  prose.** Per this ticket's coordination note, neither `SKILL.md` was
  touched; a later ticket should call `decideFlowActivation`,
  `decideFlowStateTransition`, and `decidePromotion` from the relevant
  step rather than re-deriving any of this logic in prose.
- **Environment evidence for the nine activation requirements is entirely
  caller-supplied.** `capabilityGatePassed`/`provenanceCurrent` are
  booleans this module trusts; wiring them to real
  `runCapabilityGate`/`evaluateBindingDrift` results is the caller's job
  (natural fit: #150's and #148's own modules, already reused elsewhere in
  the bundle).
- **Quarantine is out of scope here.** Per DESIGN-dynamic-qa-spec.md §12,
  quarantine is a separate, expiring policy overlay that leaves the three
  base axes visible and unaffected; #158 owns Failure Owner/Repeatability
  and is the natural place for quarantine's own machinery, not this module.
- **Failure Class derivation (Failure Owner × Repeatability) is explicitly
  #158's territory**, not modelled here at all — this module's "a failure
  changes no axis" guarantee holds regardless of how #158 eventually
  classifies a failure, because no failure-shaped object can be expressed
  as a delta to begin with.
