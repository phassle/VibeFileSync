#!/usr/bin/env bash
# dynamic-qa/acceptance/lib/report.sh
#
# Minimal pass/fail bookkeeping shared by run.sh and every case body.

CASE_FAILURES_FILE=""

report_case_begin() {
  CASE_FAILURES_FILE="$(mktemp "${TMPDIR:-/tmp}/dynamic-qa-case-failures.XXXXXX")"
  : > "$CASE_FAILURES_FILE"
}

# case_fail <message> — record a failure without stopping the case; a case
# should report every violation it finds in one run, not just the first.
case_fail() {
  echo "  FAIL: $*" >> "$CASE_FAILURES_FILE"
}

report_case_failed() {
  [ -s "$CASE_FAILURES_FILE" ]
}

report_case_print_failures() {
  cat "$CASE_FAILURES_FILE"
}

report_case_end() {
  rm -f "$CASE_FAILURES_FILE"
}
