#!/usr/bin/env bash
# dynamic-qa/acceptance/run.sh
#
# THE single command that runs the dynamic-qa acceptance harness:
#
#   dynamic-qa/acceptance/run.sh
#
# Runs both tiers described in dynamic-qa/acceptance/README.md:
#
#   Tier 1 (fast, deterministic core) — `node --test` over
#   dynamic-qa/shared/scripts. No fixture repo, no model, no network. This is
#   where almost every later ticket's invalid-artifact / hostile-input /
#   computation assertion belongs.
#
#   Tier 2 (fixture-repository behavioral harness) — every
#   dynamic-qa/acceptance/cases/**/*.case.sh file, each run against its own
#   disposable, structurally isolated fixture (see lib/fixture.sh). Reserved
#   for what is genuinely agentic or genuinely structural (discoverability,
#   approvals, stop states, patches, forbidden mutations).
#
# Exits non-zero if anything in either tier fails. Requires only `bash` and,
# for Tier 1, a `node` binary already on PATH (the same runtime every
# supported coding harness already requires) — no npm install, no network.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DYNAMIC_QA_ROOT="$(cd "$HERE/.." && pwd)"

# shellcheck source=lib/report.sh
. "$HERE/lib/report.sh"
# shellcheck source=lib/fixture.sh
. "$HERE/lib/fixture.sh"
# shellcheck source=lib/assertions.sh
. "$HERE/lib/assertions.sh"
# shellcheck source=lib/approvals.sh
. "$HERE/lib/approvals.sh"
# shellcheck source=lib/transcript.sh
. "$HERE/lib/transcript.sh"
# shellcheck source=lib/harness_real.sh
. "$HERE/lib/harness_real.sh"
# shellcheck source=lib/env_absence.sh
. "$HERE/lib/env_absence.sh"

TOTAL=0
FAILED=0
FAILED_NAMES=""

# --- Tier 1: fast deterministic core -----------------------------------

run_tier1() {
  echo "== Tier 1: deterministic core (node --test) =="
  local core_dir="$DYNAMIC_QA_ROOT/shared/scripts"
  local test_count
  test_count="$(find "$core_dir" -name '*.test.mjs' 2>/dev/null | wc -l | tr -d ' ')"

  if [ "$test_count" = "0" ]; then
    echo "  (no *.test.mjs under dynamic-qa/shared/scripts yet — expected until a"
    echo "   later ticket lands the first deterministic-core module; the seam is"
    echo "   ready: node --test dynamic-qa/shared/scripts)"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "  FAIL: node not found on PATH, but $test_count core test file(s) exist" >&2
    FAILED=$((FAILED + 1))
    FAILED_NAMES="$FAILED_NAMES tier1-core"
    return 0
  fi

  TOTAL=$((TOTAL + 1))
  # Pass explicit file paths rather than the directory: this Node version's
  # `--test <dir>` positional-argument form does not reliably auto-discover
  # *.test.mjs files the way the zero-argument default-glob form does.
  local test_files
  test_files="$(find "$core_dir" -name '*.test.mjs' | sort)"
  if node --test $test_files; then
    echo "  ok: deterministic core tests passed ($test_count file(s))"
  else
    echo "  FAIL: deterministic core tests failed"
    FAILED=$((FAILED + 1))
    FAILED_NAMES="$FAILED_NAMES tier1-core"
  fi
}

# --- Tier 1 self-check: this harness's own worked example --------------
#
# Proves the `node --test` mechanism genuinely runs and genuinely fails a
# case when it should, using a small worked example that ships with the
# harness itself (not the real future core — see selftest/README.md).

run_tier1_selftest() {
  echo "== Tier 1 self-check: harness's own node:test example =="
  local dir="$HERE/selftest"
  [ -d "$dir" ] || { echo "  (no selftest/ directory — skipping)"; return 0; }
  if ! command -v node >/dev/null 2>&1; then
    echo "  FAIL: node not found on PATH — Tier 1 cannot be proven to work" >&2
    FAILED=$((FAILED + 1))
    FAILED_NAMES="$FAILED_NAMES tier1-selftest"
    return 0
  fi
  TOTAL=$((TOTAL + 1))
  local test_files
  test_files="$(find "$dir" -name '*.test.mjs' | sort)"
  if node --test $test_files; then
    echo "  ok: harness self-check passed"
  else
    echo "  FAIL: harness self-check failed"
    FAILED=$((FAILED + 1))
    FAILED_NAMES="$FAILED_NAMES tier1-selftest"
  fi
}

# --- Tier 2: fixture-repository behavioral cases ------------------------

run_one_case() {
  local case_file="$1"
  local name="${case_file#"$HERE/cases/"}"
  name="${name%.case.sh}"

  TOTAL=$((TOTAL + 1))
  report_case_begin

  # Run the case in a subshell so its env exports (HOME, XDG_*, PATH,
  # FIXTURE_*) never leak into the next case or into run.sh itself.
  (
    set -euo pipefail
    fixture_create
    trap fixture_teardown EXIT
    CASE_DIR="$(cd "$(dirname "$case_file")" && pwd)"

    # shellcheck disable=SC1090
    . "$case_file"

    case_setup
    case_run
    case_assert

    if report_case_failed; then
      echo "FAIL: $name"
      report_case_print_failures
      exit 1
    fi
    echo "ok: $name"
  )
  local status=$?
  report_case_end

  if [ "$status" -ne 0 ]; then
    FAILED=$((FAILED + 1))
    FAILED_NAMES="$FAILED_NAMES $name"
  fi
}

run_tier2() {
  echo "== Tier 2: fixture-repository behavioral harness =="
  local case_file
  # Process substitution, not a `| while` pipe: a piped while loop runs in a
  # subshell and would silently lose the TOTAL/FAILED/FAILED_NAMES updates
  # run_one_case makes.
  while IFS= read -r case_file; do
    run_one_case "$case_file"
  done < <(find "$HERE/cases" -name '*.case.sh' | sort)
}

main() {
  run_tier1
  run_tier1_selftest
  run_tier2

  echo
  echo "== dynamic-qa acceptance harness: $TOTAL run, $FAILED failed =="
  if [ "$FAILED" -gt 0 ]; then
    echo "Failed:$FAILED_NAMES"
    exit 1
  fi
  exit 0
}

main "$@"
