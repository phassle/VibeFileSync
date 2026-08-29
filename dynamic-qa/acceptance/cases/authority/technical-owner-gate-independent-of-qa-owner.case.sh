# dynamic-qa/acceptance/cases/authority/technical-owner-gate-independent-of-qa-owner.case.sh
#
# Acceptance criterion (ticket #162): the QA Owner gate and Technical Owner
# gate "remain independently governed." The other half of the pair proven by
# qa-owner-gate-blocks-independent-of-technical-owner.case.sh: a WITHHELD
# Technical Owner gate does not block progress past stage 1 when the QA
# Owner gate is granted (the Technical Owner's approval belongs to later
# stages — harness/CI/dependency consequences, stages 7-9 — not to stage 1's
# entry condition). Proceeding into stage 2 must still leave the fixture
# repository untouched, since discovery is read-only.

case_describe="a withheld Technical Owner gate does not block stage 1 -> stage 2 when the QA Owner gate is granted"

case_setup() {
  approval_grant qa-owner "accountable QA Owner confirmed"
  approval_withhold technical-owner "harness review not started yet"
  mkdir -p "$FIXTURE_REPO/src"
  printf 'module.exports = {};\n' > "$FIXTURE_REPO/src/app.js"
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"
  transcript_play "$CASE_DIR/technical-owner-gate-independent-of-qa-owner.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "inventory-presented"
  assert_contains "$log" "answer:qa-owner=approved" \
    "the granted QA Owner gate was not recorded"
  assert_contains "$log" "answer:technical-owner=withheld" \
    "the withheld Technical Owner gate was not recorded — it must stay visible as independent, not silently upgraded by the QA Owner's approval"
  if approval_both_satisfied qa-owner technical-owner; then
    case_fail "both-satisfied must be false: a granted QA Owner gate must never read as satisfying a withheld Technical Owner gate"
  fi
  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "stage 2 discovery must leave the fixture repository untouched even once stage 1 has passed"
}
