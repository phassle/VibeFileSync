# VibeFileSync pilot fixtures (tickets #171-#175)

This directory holds the machinery for the VibeFileSync brownfield pilot
(SPEC-135.md §13). It is NOT a real `qa/` installation, is NOT enrolled in
any CI lane, and contains NO pilot measurement data.

- `flows/*.yaml` — the five pilot Flow Definitions (ticket #172), each
  `state: deferred`. They validate against
  `dynamic-qa/shared/scripts/flow-definition.mjs` and
  `dynamic-qa/shared/scripts/boundary-policy.mjs` exactly like a customer
  repository's own flows, but they describe real, already-shipped
  VibeFileSync safety behaviour: see each file's header comment for the
  originating ADR/tickets and the existing `tests/cli.rs` /
  `tests/acceptance/main.rs` test each Binding is meant to adopt or extend.
- No Bindings, Baseline Plan, Provenance Manifest, or pilot report live
  here. Building those against a real repository run is explicitly out of
  scope for this ticket set (run brief decision 3): the pilot's own
  execution — collecting baselines, activating the five flows, reporting
  results, seeding defects, and deciding promotion — is separately
  evidenced, human-in-the-loop work tracked on #171-#175 themselves.

## Why `state: deferred`, not `active`

Activation requires the nine requirements
`dynamic-qa/shared/scripts/lifecycle-state.mjs::checkActivationRequirements`
already models (product behaviour, deterministic observability, a passing
Capability Gate, current provenance, both QA and Technical approval, and
more) plus a real Baseline Plan reaching `readiness: "ready"`
(`dynamic-qa/shared/scripts/baseline-plan.mjs`). None of that evidence
exists yet — these files exist so the deterministic core has something real
to validate against, not to assert that the pilot has started.

## Where the pilot's reporting/promotion machinery lives

- `dynamic-qa/shared/scripts/pilot-report.mjs` (#173) — the Pilot Report
  contract: every metric exposes numerator, denominator, query, interval,
  source and provenance; a missing or unknown metric fails its own check
  and the whole report's `status`.
- `dynamic-qa/shared/scripts/seeded-defects.mjs` (#174) — the Seeded
  Binding Defect Case contract: a defect can only ever be Binding-owned
  (never a product change), must stay red until an accepted repair lands,
  and yields proposal-only output.
- `dynamic-qa/shared/scripts/pilot-promotion.mjs` (#175) — evaluates
  SPEC-135's seven pilot-success thresholds against a Pilot Report and a
  Seeded Defect summary, names the metric each evaluation used, and never
  promotes on a missing measurement or a missing approval.

All three are real executable code with their own `node --test` coverage
(`dynamic-qa/shared/scripts/*.test.mjs`) — no fabricated baseline, pilot
result, or approval is anywhere in this bundle.
