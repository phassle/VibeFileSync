#!/usr/bin/env bash
# dynamic-qa/acceptance/lib/assertions.sh
#
# Assertion vocabulary for fixture cases. Every function here observes
# EXTERNAL behavior only — files on disk, process exit codes, captured
# stdout/stderr, recorded command logs, snapshot diffs. None of them read
# SKILL.md prose, a skill's private reasoning, or any coding-harness
# transcript wording beyond what a real user would see. That is a deliberate
# design constraint, not an oversight: see dynamic-qa/acceptance/README.md
# "What a case may and may not assert on".
#
# Every assertion calls `case_fail <message>` on failure, which run.sh defines
# to record the failure and continue (so one case reports every violation it
# finds, not just the first).

assert_true() {
  local desc="$1"; shift
  if ! "$@" >/dev/null 2>&1; then
    case_fail "$desc"
  fi
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    case_fail "$desc: expected [$expected], got [$actual]"
  fi
}

assert_exit_code() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    case_fail "$desc: expected exit code $expected, got $actual"
  fi
}

assert_file_exists() {
  local path="$1" desc="${2:-file must exist: $path}"
  [ -f "$path" ] || case_fail "$desc"
}

assert_file_absent() {
  local path="$1" desc="${2:-file must NOT exist: $path}"
  [ -f "$path" ] && case_fail "$desc"
  return 0
}

assert_dir_exists() {
  local path="$1" desc="${2:-directory must exist: $path}"
  [ -d "$path" ] || case_fail "$desc"
}

assert_contains() {
  local haystack_file="$1" needle="$2" desc="${3:-expected content not found: $needle}"
  [ -f "$haystack_file" ] || { case_fail "$desc (file missing: $haystack_file)"; return; }
  grep -qF -- "$needle" "$haystack_file" || case_fail "$desc"
}

assert_not_contains() {
  local haystack_file="$1" needle="$2" desc="${3:-forbidden content present: $needle}"
  [ -f "$haystack_file" ] || return 0
  grep -qF -- "$needle" "$haystack_file" && case_fail "$desc"
  return 0
}

# assert_tree_unchanged <dir> <snapshot-before-file>
#
# The forbidden-mutation assertion: proves a directory tree is byte-for-byte
# identical to a snapshot taken earlier (fixture_snapshot). Used to prove
# "invoking with no argument is side-effect free", "discovery is read-only",
# and any other must-never-happen mutation named by a fixture case.
assert_tree_unchanged() {
  local dir="$1" before_file="$2" desc="${3:-tree must be unchanged: $dir}"
  local after
  after="$(fixture_snapshot "$dir")"
  local before
  before="$(cat "$before_file" 2>/dev/null || true)"
  if [ "$before" != "$after" ]; then
    case_fail "$desc"$'\n'"--- before ---"$'\n'"$before"$'\n'"--- after ---"$'\n'"$after"
  fi
}

# assert_only_paths_changed <dir> <snapshot-before-file> <allowed-path> [<allowed-path>...]
#
# A looser forbidden-mutation assertion: some mutation IS expected (a patch
# was emitted, an artifact was written), but only at the named path(s).
# Anything else that changed is a forbidden mutation.
assert_only_paths_changed() {
  local dir="$1" before_file="$2"; shift 2
  local allowed=" $* "
  local before after
  before="$(cat "$before_file" 2>/dev/null || true)"
  after="$(fixture_snapshot "$dir")"
  local changed
  changed="$(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -E '^[<>]' | awk '{print $2}' | sed 's/^\.\///' | sort -u || true)"
  local rel
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    case "$allowed" in
      *" $rel "*) : ;;
      *) case_fail "forbidden mutation: '$rel' changed but is not in the allowed set ($*)" ;;
    esac
  done <<EOF
$changed
EOF
}

# assert_stop_state <transcript-log-file> <expected-stop-reason>
#
# A stop state is an external, observable outcome: the recorded transcript
# log names the reason the harness stopped. This never inspects prompt
# wording — only the structured reason field a case's own transcript or
# adapter writes.
assert_stop_state() {
  local log_file="$1" expected="$2"
  [ -f "$log_file" ] || { case_fail "no stop state recorded (missing $log_file)"; return; }
  local actual
  actual="$(grep '^stop_reason=' "$log_file" | tail -1 | cut -d= -f2- || true)"
  [ "$actual" = "$expected" ] || case_fail "expected stop reason [$expected], got [$actual]"
}

# assert_command_log <log-file> <expected-command-substring>
#
# Proves a specific command was actually run (part of "deterministic
# commands and results" coverage) by checking the recorded command log
# rather than trusting a claim in prose output.
assert_command_ran() {
  local log_file="$1" expected_substr="$2"
  assert_contains "$log_file" "$expected_substr" "expected command not recorded as run: $expected_substr"
}

assert_command_not_ran() {
  local log_file="$1" forbidden_substr="$2"
  assert_not_contains "$log_file" "$forbidden_substr" "forbidden command was recorded as run: $forbidden_substr"
}
