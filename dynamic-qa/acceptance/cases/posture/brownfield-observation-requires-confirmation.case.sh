# dynamic-qa/acceptance/cases/posture/brownfield-observation-requires-confirmation.case.sh
#
# Acceptance criterion (ticket #163): "Brownfield observations are recorded
# as observed behaviour and require owner confirmation before becoming
# intended behaviour." This genuinely exercises the REAL deterministic-core
# module (shared/scripts/posture.mjs, no model, no network) against a
# populated fixture repository, alongside a transcript_play covering the
# human-facing question/stop-state shape stage 3 presents. Tier 1
# (posture.test.mjs) already proves the property exhaustively at the unit
# level; this case proves the same property end-to-end against the fixture
# harness other tickets build against — and that stage 3, like stages 1-2,
# writes nothing to the fixture repository.

case_describe="a brownfield observation cannot become an Expected Outcome candidate until the QA Owner explicitly confirms intent, and a confirmed bug never can"

case_setup() {
  approval_grant qa-owner "accountable QA Owner confirmed"
  approval_grant technical-owner "harness review complete"

  mkdir -p "$FIXTURE_REPO/src"
  cat > "$FIXTURE_REPO/src/retry.js" <<'EOF'
function retry(action) {
  try {
    return action();
  } catch (e) {
    // observed: swallows the error silently, never surfaces it
  }
}
module.exports = { retry };
EOF
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  # Real invocation of the deterministic core against the fixture repository.
  node --input-type=module -e "
    import { makeObservationFact, confirmIntent, canBecomeExpectedOutcome } from '$DYNAMIC_QA_ROOT/shared/scripts/posture.mjs';

    const observed = makeObservationFact({
      id: 'obs:retry-swallows-error',
      provenance: 'observed',
      description: 'retry() silently swallows the action error instead of surfacing it',
      evidence: 'src/retry.js',
    });
    const results = {};
    results.unconfirmedEligible = canBecomeExpectedOutcome(observed);

    const confirmedBug = confirmIntent(observed, {
      decision: 'not-intended',
      confirmedBy: 'per',
      confirmedByRole: 'qa-owner',
    });
    results.confirmedBugEligible = canBecomeExpectedOutcome(confirmedBug);
    results.confirmedBugStatus = confirmedBug.intentStatus;

    const confirmedIntended = confirmIntent(observed, {
      decision: 'intended',
      confirmedBy: 'per',
      confirmedByRole: 'qa-owner',
    });
    results.confirmedIntendedEligible = canBecomeExpectedOutcome(confirmedIntended);
    results.confirmedIntendedStatus = confirmedIntended.intentStatus;

    // A Domain Expert can clarify, but must never be the confirming identity.
    try {
      confirmIntent(observed, { decision: 'intended', confirmedBy: 'dana', confirmedByRole: 'domain-expert' });
      results.domainExpertConfirmRejected = false;
    } catch {
      results.domainExpertConfirmRejected = true;
    }

    process.stdout.write(JSON.stringify(results));
  " > "$FIXTURE_LOG/posture-result.json"

  transcript_play "$CASE_DIR/brownfield-observation-requires-confirmation.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "posture-evidence-presented"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "stage 3 must leave the fixture repository byte-for-byte unchanged, same as stages 1-2"

  assert_file_exists "$FIXTURE_LOG/posture-result.json" "the real posture module did not produce a result"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"unconfirmedEligible":false' \
    "a merely-observed behaviour must never be contract-eligible"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"confirmedBugStatus":"confirmed-not-intended"' \
    "an explicitly confirmed bug must be recorded as confirmed-not-intended"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"confirmedBugEligible":false' \
    "an explicitly confirmed BUG must never become contract-eligible"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"confirmedIntendedStatus":"confirmed-intended"' \
    "an explicitly confirmed intended behaviour must be recorded as confirmed-intended"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"confirmedIntendedEligible":true' \
    "only an explicitly confirmed-intended observation may become contract-eligible"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"domainExpertConfirmRejected":true' \
    "a Domain Expert must never be accepted as the confirming identity"
}
