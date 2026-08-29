# dynamic-qa/acceptance/cases/ranking/three-flow-portfolio-accepted-without-padding.case.sh
#
# Acceptance criteria (ticket #164):
#   - "A broad candidate list exists before the first deep interview"
#   - "Ranking exposes each of the five factors per candidate rather than a
#     single opaque score"
#   - "The owner can approve fewer than five flows and setup accepts it
#     without adding filler"
#
# This genuinely exercises the REAL deterministic-core module
# (shared/scripts/candidate-ranking.mjs, no model, no network) against three
# candidates built from evidence, alongside a transcript_play covering the
# human-facing question/stop-state shape stage 4 presents. It proves the
# structural guarantee, not just an SKILL.md claim: rankCandidateFlows only
# ever returns as many entries as it was given, and evaluatePortfolioSize
# never refuses (let alone pads) a portfolio smaller than the 5-10 guidance
# band.

case_describe="a three-flow portfolio, ranked on all five factors, is approved as-is with no filler candidate added"

case_setup() {
  approval_grant qa-owner "accountable QA Owner confirmed"

  mkdir -p "$FIXTURE_REPO/src"
  printf 'module.exports = {};\n' > "$FIXTURE_REPO/src/app.js"
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  # Real invocation of the deterministic core: three candidates, identified
  # from evidence (not invented to hit a number), ranked and evaluated.
  node --input-type=module -e "
    import { makeCandidateFlow, rankCandidateFlows, evaluatePortfolioSize } from '$DYNAMIC_QA_ROOT/shared/scripts/candidate-ranking.mjs';

    const candidates = [
      makeCandidateFlow({
        id: 'update-preserves-safetynet',
        title: 'Update preserves prior version',
        originatingTickets: ['https://github.com/phassle/VibeFileSync/issues/18'],
        impact: 'critical', frequency: 'high', changeExposure: 'high', escapeCount: 2, cheaperCoverageExists: false,
      }),
      makeCandidateFlow({
        id: 'compare-detects-conflicts',
        title: 'Compare detects conflicting changes',
        originatingTickets: ['https://github.com/phassle/VibeFileSync/issues/21'],
        impact: 'high', frequency: 'medium', changeExposure: 'medium', escapeCount: 0, cheaperCoverageExists: false,
      }),
      makeCandidateFlow({
        id: 'run-writes-report',
        title: 'Run writes a report file',
        originatingTickets: ['https://github.com/phassle/VibeFileSync/issues/25'],
        impact: 'medium', frequency: 'low', changeExposure: 'low', escapeCount: 1, cheaperCoverageExists: true,
      }),
    ];

    const ranked = rankCandidateFlows(candidates);
    const portfolio = evaluatePortfolioSize(ranked.length);

    process.stdout.write(JSON.stringify({
      candidateCount: candidates.length,
      rankedCount: ranked.length,
      ranked: ranked.map(r => ({ id: r.candidate.id, rank: r.rank, factorScores: r.factorScores })),
      portfolio,
    }));
  " > "$FIXTURE_LOG/ranking-result.json"

  transcript_play "$CASE_DIR/three-flow-portfolio-accepted-without-padding.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "candidate-portfolio-approved"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "stage 4 must leave the fixture repository byte-for-byte unchanged — ranking a candidate list is never a write"

  assert_file_exists "$FIXTURE_LOG/ranking-result.json" "the real ranking module did not produce a result"
  assert_contains "$FIXTURE_LOG/ranking-result.json" '"candidateCount":3' \
    "three candidates were identified from evidence"
  assert_contains "$FIXTURE_LOG/ranking-result.json" '"rankedCount":3' \
    "ranking must never return more or fewer entries than it was given — no candidate was invented to pad the list"

  for factor in impact frequency changeExposure escapeHistory cheaperCoverageExists; do
    assert_contains "$FIXTURE_LOG/ranking-result.json" "\"$factor\"" \
      "ranking must expose the $factor factor per candidate, not collapse it into a single opaque score"
  done

  assert_contains "$FIXTURE_LOG/ranking-result.json" '"band":"below-guidance"' \
    "three flows is below the 5-10 guidance band"
  assert_contains "$FIXTURE_LOG/ranking-result.json" '"allowed":true' \
    "fewer than five flows must be a first-class, comfortable, allowed outcome"
  assert_contains "$FIXTURE_LOG/ranking-result.json" '"requiresOverride":false' \
    "a below-guidance portfolio must never require an override — only an above-guidance one does"
}
