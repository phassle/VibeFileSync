# Negative controls (#152)

A generated assertion is only evidence if it can fail. Before a candidate
Binding is reported as verified, every Expected Outcome's assertion must be
proven to still fail for the violation it is supposed to catch — otherwise a
plausible-but-wrong selector, a mis-wired API call, or an always-true
assertion is indistinguishable from a working test.

## What the deterministic core does

`dynamic-qa/shared/scripts/negative-controls.mjs`:

- `buildNegativeControlPlan(flowData, boundaries)` derives one
  `DeclaredViolation` per Expected Outcome directly from the Flow contract
  already on file — the outcome's own tolerance kind and, when declared, the
  `role: "owned"` boundary the outcome is proving something about. Nothing is
  invented per candidate: the same outcome/tolerance/boundary always derives
  the same violation statement.
- `judgeNegativeControl(report)` judges one reported control run. It accepts
  only a report whose `mode` is the exact literal `"executed"` **and** whose
  `appliedViolation.outcome` is exactly `"assertion-failed"`. Anything else —
  a missing/blank/`"simulated"`/`"skipped"`/`"assumed"` mode, an
  `"assertion-passed"` outcome (the always-true-assertion case), or a
  `"crash"`/`"timeout"` outcome (an unrelated failure, not the declared
  violation) — is rejected with a precise, named reason
  (`not-executed`, `assertion-did-not-fail`, `unrelated-failure`,
  `malformed-report`).
- `checkNegativeControlCoverage(assertions, reports)` requires every
  generated assertion's Expected Outcome to have an *accepted* control
  report. A missing control is a failure, not a warning, in the same
  `{ valid, errors }` Issues shape used across the deterministic core.

## The computation/execution seam

Everything above is pure and total — no I/O, no clock, no process, no
harness-specific code. It never runs an assertion itself. Actually
translating a `DeclaredViolation`'s statement into a concrete fixture/input
mutation, running the candidate's unchanged assertion against that mutation
in the approved candidate-verification sandbox, and observing what really
happened is harness-specific and belongs to the generation/verification
pipeline. That pipeline must hand back a `NegativeControlReport`
(`{ stepId, outcomeId, mode: "executed", appliedViolation: { outcome } }`)
only when the run genuinely happened — never from a dry run, a plan, or an
assumption. `judgeNegativeControl` has no code path that treats a missing or
non-`"executed"` `mode` as success, so a simulated or unrun control can never
be recorded as satisfied.

## Exact integration text

Replace `qa-generate/SKILL.md` step 6's placeholder sentence:

> Negative controls, neighbor- flow verification, and the drift gate itself
> remain placeholders — #148 and #152 own that machinery; until it lands,
> running the new test once and requiring it to pass is the whole of this
> step.

with:

> Negative controls are required, not optional. For every assertion in the
> mapping built in step 4, call `buildNegativeControlPlan` (from
> `dynamic-qa/shared/scripts/negative-controls.mjs`) with the Flow's
> validated data and boundaries to derive that Expected Outcome's
> `DeclaredViolation`. Realize each violation's `statement` as a concrete
> fixture/input mutation in the candidate's own harness, run the candidate's
> unchanged assertion against the mutation in the approved
> candidate-verification sandbox, and record exactly what happened as a
> `NegativeControlReport` — `mode: "executed"` only when the run genuinely
> happened. Then call `checkNegativeControlCoverage` with the same
> assertion mapping and every collected report. On `{ valid: false }`,
> discard the candidate, report the exact rejection reasons
> (`not-executed`, `assertion-did-not-fail`, `unrelated-failure`,
> `malformed-report`), and stop — an assertion whose control passes, or
> whose control never ran, is rejected here, not reported as verified.
> Neighbor-flow verification and the drift gate itself remain placeholders
> — #148 owns that machinery.

Neighbor-flow verification and the drift gate are explicitly out of scope
for #152 and remain #148's territory.
