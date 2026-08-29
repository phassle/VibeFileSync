# dynamic-qa/acceptance/cases/authority/qa-owner-gate-blocks-independent-of-technical-owner.case.sh
#
# Acceptance criteria (ticket #162): "Authority is verified before any flow
# elicitation begins" and the QA Owner (contract) / Technical Owner gates
# "remain independently governed." This proves a GRANTED Technical Owner
# gate can never satisfy or rescue a WITHHELD QA Owner gate — the two are
# read from separate lib/approvals.sh records, never merged.

case_describe="a withheld QA Owner gate stops setup even when the Technical Owner gate is granted"

case_setup() {
  approval_withhold qa-owner "no accountable QA Owner has been named yet"
  approval_grant technical-owner "harness/CI review already complete"
  mkdir -p "$FIXTURE_REPO/src"
  printf 'module.exports = {};\n' > "$FIXTURE_REPO/src/app.js"
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"
  transcript_play "$CASE_DIR/qa-owner-gate-blocks-independent-of-technical-owner.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "missing-qa-owner-authority"
  assert_contains "$log" "answer:qa-owner=withheld" \
    "the QA Owner gate's own withheld decision was not recorded"
  assert_contains "$log" "answer:technical-owner=approved" \
    "the Technical Owner gate's own granted decision was not recorded — it must be visible as independent of the QA Owner gate, not merged away"
  if approval_both_satisfied qa-owner technical-owner; then
    case_fail "both-satisfied must be false: a granted Technical Owner gate must never read as satisfying the withheld QA Owner gate"
  fi
  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "a run that stops on a missing QA Owner must leave the fixture repository untouched"
}
