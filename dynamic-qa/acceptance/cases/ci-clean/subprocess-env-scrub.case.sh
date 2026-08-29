# dynamic-qa/acceptance/cases/ci-clean/subprocess-env-scrub.case.sh
#
# Spec requirement: "The harness verifies that ordinary CI runs with all
# model and browser-agent processes and credentials absent." This case
# proves the scrubbing mechanism a real replay/real-harness invocation would
# run under actually removes every deny-listed credential, even when the
# outer environment running the acceptance harness itself has one set (a
# realistic case for a developer's own machine) — see lib/env_absence.sh for
# why this checks the harness's own mechanism rather than scanning the whole
# machine's process list.

case_describe="a scrubbed child process sees no model/browser-agent credentials, even if the outer shell has them"

case_setup() {
  : # nothing to populate in the fixture repository; this exercises the
    # environment-scrubbing mechanism itself.
}

case_run() {
  # Simulate a developer machine that happens to have a real credential
  # exported for unrelated work — the scrub must still remove it from the
  # child, proving the mechanism does not merely rely on it being absent by
  # accident.
  ANTHROPIC_API_KEY="sk-not-a-real-key-fixture-only" \
    env_absence_run_scrubbed "$FIXTURE_LOG/scrub.log" -- /bin/echo "scrubbed child ran"
}

case_assert() {
  assert_no_credential_leak "$FIXTURE_LOG/scrub.log"
  assert_no_forbidden_descendant_processes "$FIXTURE_LOG/scrub.log"
  assert_contains "$FIXTURE_LOG/scrub.log" "scrubbed child ran" \
    "the scrubbed child never actually ran its command"
}
