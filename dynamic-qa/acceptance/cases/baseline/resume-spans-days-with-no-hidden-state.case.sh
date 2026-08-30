# dynamic-qa/acceptance/cases/baseline/resume-spans-days-with-no-hidden-state.case.sh
#
# Acceptance criteria (ticket #167): "Missing baselines produce a Baseline
# Plan and a measurement-required state rather than an estimate" and "Setup
# can be resumed days later purely from repository evidence." Tier 1
# (baseline-plan.test.mjs) already proves this exhaustively at the unit
# level with an in-memory temp directory; this case proves the same
# property end-to-end against the fixture-repository harness other tickets
# build against — a real Baseline Plan file, written under a real
# FIXTURE_REPO, resumed by a fresh process invocation days later with no
# input beyond the repository root, and never touching anything outside
# qa/baseline-plan.yaml.

case_describe="a Baseline Plan resumes across a simulated multi-day gap from qa/baseline-plan.yaml alone, and never touches the rest of the fixture repository"

case_setup() {
  : # baseline-plan.mjs writes exactly one file itself (qa/baseline-plan.yaml);
    # nothing needs to be pre-populated in the fixture repository.
}

case_run() {
  # Day 1: build a plan from partial evidence (real deterministic-core
  # calls, no model, no network) and write it to the fixture repository.
  node --input-type=module -e "
    import {
      buildBaselinePlan, saveBaselinePlanToRepo, unknownQuantity, knownQuantity,
      notApplicableQuantity, makeMetric, REQUIRED_METRIC_IDS,
    } from '$DYNAMIC_QA_ROOT/shared/scripts/baseline-plan.mjs';

    const day1 = new Date('2026-01-01T00:00:00Z');

    function metricFor(id) {
      if (id === 'repair-decisions') {
        return makeMetric({
          id, label: 'repair decisions', query: 'n/a', interval: 'n/a', source: 'n/a',
          provenance: 'reported',
          numerator: notApplicableQuantity('no repair activity exists yet for a new capability'),
          denominator: notApplicableQuantity('no repair activity exists yet for a new capability'),
          collectedAt: null,
        });
      }
      if (id === 'flow-coverage') {
        return makeMetric({
          id, label: 'named-flow coverage', query: 'count adopted vs candidate flows',
          interval: 'trailing-30-days', source: 'provenance.json', provenance: 'observed',
          numerator: knownQuantity(2), denominator: knownQuantity(6), collectedAt: day1.toISOString(),
        });
      }
      // every other required baseline: evidence not collected yet.
      return makeMetric({
        id, label: id, query: 'tbd', interval: 'trailing-30-days', source: 'tbd',
        provenance: 'unknown', numerator: unknownQuantity(), denominator: unknownQuantity(), collectedAt: null,
      });
    }

    const plan = buildBaselinePlan({
      id: 'vibefilesync-pilot-baseline',
      revision: 1,
      owners: { qaOwner: 'qa-owner', technicalOwner: 'tech-owner' },
      repository: 'phassle/VibeFileSync',
      window: { startedAt: day1.toISOString() },
      metrics: REQUIRED_METRIC_IDS.map(metricFor),
      generatedAt: day1.toISOString(),
    }, { now: day1 });

    saveBaselinePlanToRepo('$FIXTURE_REPO', plan);
    process.stdout.write(JSON.stringify({ readiness: plan.readiness }));
  " > "$FIXTURE_LOG/day1.json"

  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before-resume.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  # A separate, later "process" (no session state carried forward — the
  # only argument is the fixture repository root) resumes on day 1 first...
  node --input-type=module -e "
    import { resumeBaselinePlan } from '$DYNAMIC_QA_ROOT/shared/scripts/baseline-plan.mjs';
    const result = resumeBaselinePlan('$FIXTURE_REPO', { now: new Date('2026-01-01T00:00:00Z') });
    process.stdout.write(JSON.stringify({ exists: result.exists, valid: result.valid, readiness: result.readiness }));
  " > "$FIXTURE_LOG/resume-day1.json"

  # ...and again as if 20 days had passed, against the exact same untouched file.
  node --input-type=module -e "
    import { resumeBaselinePlan } from '$DYNAMIC_QA_ROOT/shared/scripts/baseline-plan.mjs';
    const result = resumeBaselinePlan('$FIXTURE_REPO', { now: new Date('2026-01-21T00:00:00Z') });
    process.stdout.write(JSON.stringify({ exists: result.exists, valid: result.valid, readiness: result.readiness }));
  " > "$FIXTURE_LOG/resume-day21.json"
}

case_assert() {
  assert_file_exists "$FIXTURE_REPO/qa/baseline-plan.yaml" "day 1 setup must write the repository-owned Baseline Plan"
  assert_contains "$FIXTURE_LOG/day1.json" '"readiness":"measurement-required"' \
    "a plan with missing evidence must never come out as ready on day 1"

  assert_contains "$FIXTURE_LOG/resume-day1.json" '"exists":true' "resume must find the file it just wrote"
  assert_contains "$FIXTURE_LOG/resume-day1.json" '"valid":true' "an honestly-incomplete plan must remain a VALID document"
  assert_contains "$FIXTURE_LOG/resume-day1.json" '"readiness":"measurement-required"' \
    "missing evidence (flow-coverage aside) must still block readiness on day 1"

  # Nothing about the underlying file changed between the two resumes —
  # readiness moving from measurement-required is a recomputation against
  # the clock, never a rewrite of hidden state.
  assert_contains "$FIXTURE_LOG/resume-day21.json" '"exists":true' "resume 20 days later must still find the same file"
  assert_contains "$FIXTURE_LOG/resume-day21.json" '"valid":true' "the file itself never became invalid merely because time passed"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "resuming must never modify the fixture repository — it only reads qa/baseline-plan.yaml"
}
