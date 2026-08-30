# dynamic-qa/acceptance/cases/ci-clean/subprocess-env-scrub-catches-grandchild.case.sh
#
# CodeRabbit re-review finding on PR #177 (env_absence.sh:82): the previous
# fix round sampled process trees with `pgrep -P "$cmd_pid"` alone, which
# returns only DIRECT children. A command that starts an intermediate shell
# or package runner, which in turn starts a forbidden model or
# browser-agent process, puts that process at depth 2+ below the command
# the harness actually launched — a direct-children-only scan silently
# misses it, and the env-absence assertion would pass without ever having
# observed the forbidden process.
#
# This case proves the fix is genuinely complete by building a fixture
# where the forbidden-looking process is a GRANDCHILD (started by an
# intermediate shell), not a direct child of the launched command:
#
#   cmd_pid (outer.sh)
#     -> middle.sh (a direct child; itself harmless)
#          -> inner.sh, which execs into a process named "chromium"
#             (via `exec -a`, so its ppid is middle.sh's pid, never
#             cmd_pid's) — a true grandchild.
#
# The success criterion here is the OPPOSITE of the other ci-clean case:
# this fixture deliberately contains a forbidden-looking process, so the
# case passes when the recursive descendant walk DOES record it in the
# ".procs" file (proving env_absence_run_scrubbed's sampling reaches every
# generation, not just the first) — never by asserting the process is
# absent.

case_describe="env_absence_run_scrubbed's descendant sampling reaches a grandchild process started by an intermediate shell, not just direct children"

case_setup() {
  cat > "$FIXTURE_ROOT/inner.sh" <<'EOF'
#!/bin/sh
# Renames this process's comm to a forbidden-pattern name via `exec -a`,
# without spawning anything further. Its parent is middle.sh, never the
# command the harness directly launched.
exec -a chromium sleep 2
EOF
  cat > "$FIXTURE_ROOT/middle.sh" <<EOF
#!/bin/sh
"$FIXTURE_ROOT/inner.sh" &
wait
EOF
  cat > "$FIXTURE_ROOT/outer.sh" <<EOF
#!/bin/sh
"$FIXTURE_ROOT/middle.sh" &
wait
EOF
  chmod +x "$FIXTURE_ROOT/inner.sh" "$FIXTURE_ROOT/middle.sh" "$FIXTURE_ROOT/outer.sh"
}

case_run() {
  env_absence_run_scrubbed "$FIXTURE_LOG/grandchild.log" -- "$FIXTURE_ROOT/outer.sh"
}

case_assert() {
  # Positive assertion, deliberately not assert_no_forbidden_descendant_processes:
  # the whole point of this fixture is that a forbidden-looking process IS
  # present, two generations down. Proving the harness observed it is what
  # demonstrates the recursive walk works; a case that instead asserted
  # absence would pass for the wrong reason if the walk regressed to
  # direct-children-only again (the exact bug this case guards against).
  assert_contains "$FIXTURE_LOG/grandchild.log.procs" "chromium" \
    "the descendant sampling must observe a forbidden-looking process even when it is a grandchild (started by an intermediate shell), not only a direct child"
}
