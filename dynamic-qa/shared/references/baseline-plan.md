# Measurement readiness and the Baseline Plan (`qa-setup` stage 8)

Shared reference for `qa-setup`'s stage 8. Built into both skills by
`dynamic-qa/build.sh` from this single source (`dynamic-qa/shared/references/`)
— see `dynamic-qa/DECISIONS.md`.

The mechanical parts of this stage are one deterministic-core module,
`shared/scripts/baseline-plan.mjs`, covered by its own `node:test` suite
(`baseline-plan.test.mjs`). This document describes what that module does
and why, so `qa-setup/SKILL.md`'s stage 8 prose can stay short and point
here.

## Why this stage exists

Pilot activation must be blocked until baselines exist, so improvement can
actually be measured rather than asserted (SPEC-135 story 103). If setup
simply invented a plausible-looking baseline — "coverage is probably
around 40%", "let's call escapes zero for now" — every later "the pilot
improved things" claim would be unfalsifiable. So stage 8 does the opposite
of what an eager assistant might reach for: when the evidence a baseline
needs is not there yet, the correct output is a **strict record that says
so**, not a number.

## The core rule: missing evidence never becomes a number

There is exactly one place a numerator or denominator can hold an actual
number: `knownQuantity(value)`. Everything else is `unknownQuantity()`
(evidence not yet collected) or `notApplicableQuantity(reason)` (the metric
does not apply here, with a mandatory stated reason). These are three
distinct, tagged, mutually exclusive shapes — never three interpretations
of the same field. A missing denominator can never masquerade as a good
(zero) result, because "we don't have a denominator" and "we measured a
denominator of zero" are different `kind` tags, not different numbers.

Zero is not a special case handled by extra logic: a measured zero is just
`knownQuantity(0)`, exactly as ordinary as `knownQuantity(47)`. It is
distinguished from `unknownQuantity()` and `notApplicableQuantity(...)` by
tag alone.

## The Metric shape

Every metric — always all six required baselines, always present, even
when not-applicable — carries:

- `id`, `label`: one of the six fixed baseline ids (`flow-coverage`,
  `escaped-regressions`, `pr-check-latency-p95`, `flake-rate`,
  `maintenance-time`, `repair-decisions`).
- `query`, `interval`, `source`: the **explicit collection method** —
  required on every metric, always, regardless of whether any evidence has
  been collected yet. This is what satisfies the acceptance criterion that
  coverage/escapes/latency/flake/maintenance baselines each have an
  explicit collection method: the method is part of the metric's
  definition, not something derived after a number shows up.
- `numerator`, `denominator`: each a Quantity (`unknown` |
  `not-applicable` | `known`).
- `provenance`: `observed` | `reported` | `unknown` — reuses
  `fact.mjs`'s existing three-value provenance model directly (ticket #162)
  rather than inventing a parallel one.
- `collectedAt`: a real ISO timestamp when either side is `known`; `null`
  otherwise. A timestamp with no known value would misleadingly claim a
  real collection happened.

`baseline-plan.mjs`'s `validateMetric` (via `validateBaselinePlan`) rejects
a metric missing any of these fields outright — "a metric missing any of
these is not a metric" is enforced structurally, not left to review.
`numerator` and `denominator` must be `not-applicable` together, never only
one side: a metric cannot be half not-applicable.

## Readiness: `measurement-required` | `ready`

`metricStatus(metric)` reduces one metric to `ready` (both sides `known`),
`not-applicable` (both sides `not-applicable`), or `measurement-required`
(anything else — including any `unknown` on either side). It never returns
`ready` or `not-applicable` from an incomplete or mismatched pair.

`computeReadiness(plan, { now })` folds this across the whole plan:

1. Any required metric at `measurement-required` forces the whole plan to
   `measurement-required` — one missing baseline is enough to block.
2. Otherwise every metric is `ready` or legitimately `not-applicable`
   (with a reason — e.g. `repair-decisions` is not-applicable for a brand
   new capability with no repair history yet, per SPEC-135's
   Implementation Decisions). The plan is still not `ready` until the
   burn-in gate also clears: at least `MIN_BURN_IN_CALENDAR_DAYS` (14) have
   elapsed since `window.startedAt`, and the designated run-count metric
   (`RUN_COUNT_METRIC_ID`, currently `pr-check-latency-p95`'s denominator)
   is at least `MIN_RELEVANT_PR_RUNS` (20).

`buildBaselinePlan` is the **only constructor**, and it has no `readiness`
parameter at all — readiness is always derived by `computeReadiness` from
the metrics/window actually given. There is no path through this module
that lets a caller assert "ready" ahead of the evidence.

`validateBaselinePlan` re-derives readiness independently and reports an
issue if a document's stored `readiness` disagrees with what its own
metrics/window support **as of its own `generatedAt`** (not the real wall
clock — see "Resume" below for why). A hand-edited YAML file cannot simply
declare `readiness: ready`; the validator recomputes and catches the
mismatch.

## Resume: repository-owned evidence, no hidden session state

`resumeBaselinePlan(repoRoot, { now })` takes exactly one required
argument — the repository root — and reads `qa/baseline-plan.yaml`
(`BASELINE_PLAN_REPO_PATH`) from disk. It holds no cache, no module-level
state, and accepts no session identifier. Two calls from two entirely
separate process invocations, started days apart, pointed at the same
repository, produce the same result, because the only input is the
repository's own file.

Two clocks matter here, deliberately kept separate:

- **Structural validity** (`validateBaselinePlan`'s anti-fabrication
  check) is anchored to the document's own `generatedAt`, not the real
  clock. A plan that was honestly `measurement-required` on the day it was
  written must stay *valid* as real time passes and the burn-in window
  quietly elapses — going stale is not fabrication.
- **Current readiness** (`resumeBaselinePlan`'s returned `readiness`) is
  recomputed against the real (or injected, for tests) clock every time,
  independent of the stored value. This is exactly how a plan flips from
  `measurement-required` to `ready` between two resumes of the same
  untouched file: nothing rewrites the file in between, the calendar just
  moves.

If no plan exists yet, `resumeBaselinePlan` reports
`{ exists: false, readiness: "measurement-required" }` without error — a
missing plan is a normal starting point, not a failure.

`saveBaselinePlanToRepo(repoRoot, plan)` refuses to write anything that
does not itself pass `validateBaselinePlan` — the repository never ends up
holding a plan this module would reject on its own next read.

## Round-tripping

`renderBaselinePlanYAML` / `parseBaselinePlanDocument` follow
`flow-yaml.mjs` / `restricted-yaml.mjs`'s exact discipline: a deliberately
restricted YAML subset, so writing a plan and reading it back reproduces
an identical document (same `canonical-digest.mjs` digest), including the
distinction between a `not-applicable` reason and a measured `0`.

## What stage 8 asks the QA Owner, in conversation

The mechanics above compute status; the judgement stage 8 prose retains is
narrow:

- Confirming which collection method (`query`/`interval`/`source`) is
  actually correct for this repository's coverage, escapes, latency, flake,
  and maintenance-time baselines — the module never invents these; they
  must be supplied.
- Confirming a `not-applicable` claim's reason is genuine (e.g. "this is a
  new capability with no repair history" is a real reason; "we don't feel
  like measuring this" is not).
- Presenting a `measurement-required` result as a normal, expected
  stopping point — never as a failure to explain away, and never a
  prompt to estimate a number in its place.

## Seam left for #169 / #171

This ticket builds the Baseline Plan machinery only. It never collects a
real VibeFileSync metric and never writes `qa/baseline-plan.yaml` for the
real repository. A later ticket that actually runs the pilot:

- Supplies real `query`/`source` values per metric (this module only
  requires them to be non-empty strings — it does not know how to execute
  a query against GitHub Actions, the issue tracker, or anything else).
- Calls `knownQuantity(...)` only from code that genuinely measured a
  value — this module provides no shortcut around that.
- Should re-examine `RUN_COUNT_METRIC_ID` (currently pinned to
  `pr-check-latency-p95`'s denominator as the "relevant completed PR runs"
  sample size) if a better source for that count turns up.
