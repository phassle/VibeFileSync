# dynamic-qa/acceptance/cases/authority/no-explicit-invocation.case.sh
#
# Acceptance criterion (ticket #162): "Setup runs only on explicit invocation
# and refuses to start from an incidental mention." This proves the stage 1
# invocation gate (shared/scripts/authority.mjs's evaluateInvocation, its own
# node:test coverage in authority.test.mjs) reaches an external stop state
# BEFORE any authority elicitation or repository read/write, when the
# invocation is not explicit.

case_describe="qa-setup refuses to start from a natural-language mention, not an explicit invocation"

case_setup() {
  # Populate a plausible-looking customer repository, so a wrongly-permissive
  # implementation would have real content available to (wrongly) touch.
  mkdir -p "$FIXTURE_REPO/src"
  printf 'module.exports = {};\n' > "$FIXTURE_REPO/src/app.js"
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"
  transcript_play "$CASE_DIR/no-explicit-invocation.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "not-explicit-invocation"
  assert_contains "$log" "answer:invocation-source=natural-language-mention" \
    "the non-explicit invocation source that triggered the stop was not recorded"
  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "a run that never passes the invocation gate must leave the fixture repository untouched"
}
