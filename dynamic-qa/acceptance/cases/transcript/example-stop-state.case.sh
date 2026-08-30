# dynamic-qa/acceptance/cases/transcript/example-stop-state.case.sh
#
# THE WORKED EXAMPLE this README points a later ticket at when adding a new
# fixture case. It is intentionally small and does not test any real
# qa-setup/qa-generate behavior (there is none yet to test beyond what
# cases/structural and cases/ci-clean already cover) — it demonstrates the
# transcript-replay engine's shape: a question is asked, a scripted answer is
# read from the approvals primitive, and the run reaches a named stop state
# without writing anything to the fixture repository. Copy this file's shape
# for a real generation/adoption/diagnosis/repair fixture once qa-generate
# has real behavior to assert on.

case_describe="transcript replay reaches a named stop state and writes nothing when the answer is 'absent'"

case_setup() {
  : # no scripted answer for "capability-gate" is provided — approval_decision
    # will read back "absent", driving the transcript's own fallback.
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"
  transcript_play "$CASE_DIR/example-stop-state.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_contains "$log" "mode=SIMULATED" \
    "a replay run must always label itself SIMULATED, never REAL"
  assert_stop_state "$log" "missing-capability-profile"
  assert_contains "$log" "question_id=capability-gate" \
    "the question the transcript asked was not recorded"
  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "a stop state reached before any write step must leave the fixture repository untouched"
}
