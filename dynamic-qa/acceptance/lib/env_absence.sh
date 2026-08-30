#!/usr/bin/env bash
# dynamic-qa/acceptance/lib/env_absence.sh
#
# Verifies that ordinary CI runs happen with all model and browser-agent
# processes and credentials absent (a non-negotiable invariant: ordinary PR
# and nightly regression runs call no LLM and no browser agent). This does
# NOT scan the ambient machine — a developer's own shell may legitimately
# have Claude Code credentials exported for unrelated work, and a
# machine-wide `ps` scan would make this flaky on exactly the box a later
# implementer develops on. Instead it proves the harness's OWN mechanism: any
# child process it spawns is launched through an explicitly scrubbed
# environment, and that scrubbing is checked directly rather than assumed.

set -euo pipefail

# Deny-listed credential-shaped environment variable names for known model
# and browser-agent providers. Extend this list, never remove from it,
# should a later ticket add a new provider adapter.
DYNAMIC_QA_CREDENTIAL_DENYLIST="ANTHROPIC_API_KEY OPENAI_API_KEY OPENAI_ORG_ID GOOGLE_API_KEY GEMINI_API_KEY AZURE_OPENAI_API_KEY COHERE_API_KEY MISTRAL_API_KEY GITHUB_COPILOT_TOKEN CLAUDE_API_KEY CODEX_API_KEY BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID"

# Process name substrings for known model CLIs and browser-automation
# drivers. Matched against descendant processes only (see
# env_absence_run_scrubbed below) — never a whole-machine scan.
DYNAMIC_QA_FORBIDDEN_PROCESS_PATTERNS="claude codex ollama chromium chrome playwright puppeteer geckodriver chromedriver"

# env_absence_run_scrubbed <log-file> -- <command...>
#
# Runs <command...> through `env -i` with an explicit allowlist (PATH, HOME,
# the fixture's XDG_* vars, LANG) and none of the deny-listed credential
# vars, even if they happen to be set in the outer shell. Writes the child's
# own `env` dump to "<log-file>.env" and its live descendant process list to
# "<log-file>.procs" — two separate files, deliberately, so a forbidden
# process-name check can never false-positive on a substring that happens to
# appear in an unrelated environment variable's *value* (a real hazard: a
# sandboxed run's own tmp/HOME path can legitimately contain a harness name
# such as "claude" with nothing whatsoever running).
#
# <command...> is started in the background so its process tree can be
# sampled WHILE it runs, not before it starts (a command started and waited
# on synchronously has no descendants yet at the moment a scan would run).
# The command's own process and every descendant it spawns are sampled
# repeatedly until it exits, so a forbidden process that only lives for part
# of the command's run is still observed. The command's real exit status is
# preserved end to end: `wait` recovers it from the backgrounded job, the
# inner shell re-exits with it, and env_absence_run_scrubbed returns it as
# its own exit status (the last statement `env -i ... /bin/sh -c '...'`
# already propagated this before backgrounding was introduced; the explicit
# `exit "$status"` below keeps that guarantee true afterward).
env_absence_run_scrubbed() {
  local log_file="$1"; shift
  [ "$1" = "--" ] && shift

  local env_file="${log_file}.env" proc_file="${log_file}.procs" out_file="${log_file}.stdout"
  : > "$env_file"; : > "$proc_file"; : > "$out_file"

  env -i \
    PATH="$PATH" \
    HOME="${FIXTURE_HOME:-$HOME}" \
    XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-}" \
    XDG_DATA_HOME="${XDG_DATA_HOME:-}" \
    XDG_CACHE_HOME="${XDG_CACHE_HOME:-}" \
    XDG_STATE_HOME="${XDG_STATE_HOME:-}" \
    LANG="${LANG:-C}" \
    DYNAMIC_QA_ENV_FILE="$env_file" \
    DYNAMIC_QA_PROC_FILE="$proc_file" \
    /bin/sh -c '
      env > "$DYNAMIC_QA_ENV_FILE"
      : > "$DYNAMIC_QA_PROC_FILE"

      # Print the comm= of every LIVE descendant of $1, walked recursively
      # (not just direct children) using a breadth-first queue over
      # `pgrep -P`. A command that starts a shell or package runner that in
      # turn starts a forbidden model or browser-agent process puts that
      # process at depth 2+ — a direct-children-only check would miss it
      # entirely, so this walks the whole tree, one generation at a time,
      # until no generation produces any further children.
      list_descendant_comms() {
        root_pid="$1"
        command -v pgrep >/dev/null 2>&1 || return 0
        frontier="$root_pid"
        while [ -n "$frontier" ]; do
          next=""
          for p in $frontier; do
            children="$(pgrep -P "$p" 2>/dev/null)"
            for c in $children; do
              ps -o comm= -p "$c" 2>/dev/null
              next="$next $c"
            done
          done
          frontier="$next"
        done
      }

      "$@" &
      cmd_pid=$!

      # Sample the command process and its full descendant tree at least
      # once, then keep sampling until the command has exited. A do-while
      # shape (sample first, check afterward) guarantees at least one sample
      # even for a command that finishes before the loop gets to check it
      # again.
      while :; do
        ps -o comm= -p "$cmd_pid" 2>/dev/null >> "$DYNAMIC_QA_PROC_FILE"
        list_descendant_comms "$cmd_pid" >> "$DYNAMIC_QA_PROC_FILE"
        kill -0 "$cmd_pid" 2>/dev/null || break
        sleep 0.02
      done

      wait "$cmd_pid"
      status=$?
      exit "$status"
    ' _ "$@" > "$out_file" 2>&1

  # log_file itself stays as a manifest pointing at the three real files, so
  # a case can still pass one path to assert_contains for the command output.
  {
    echo "env_file=$env_file"
    echo "proc_file=$proc_file"
    echo "stdout_file=$out_file"
    cat "$out_file"
  } > "$log_file"
}

# assert_no_credential_leak <log-file>
#
# <log-file> is the manifest env_absence_run_scrubbed wrote; the actual env
# dump lives at "<log-file>.env", checked with an anchored "^VAR=" match so a
# credential name appearing inside some other variable's value never counts.
assert_no_credential_leak() {
  local log_file="$1" var
  local env_file="${log_file}.env"
  [ -f "$env_file" ] || { case_fail "no env dump found at $env_file"; return; }
  for var in $DYNAMIC_QA_CREDENTIAL_DENYLIST; do
    if grep -q "^${var}=" "$env_file" 2>/dev/null; then
      case_fail "credential env var leaked into scrubbed child: $var"
    fi
  done
}

# assert_no_forbidden_descendant_processes <log-file>
#
# Checked only against "<log-file>.procs" — real process `comm` names, one
# per line, never the env dump or the command's own stdout — so a tmp/HOME
# path that happens to contain a harness name never counts as that harness
# actually running.
assert_no_forbidden_descendant_processes() {
  local log_file="$1" pattern
  local proc_file="${log_file}.procs"
  [ -f "$proc_file" ] || { case_fail "no process list found at $proc_file"; return; }
  for pattern in $DYNAMIC_QA_FORBIDDEN_PROCESS_PATTERNS; do
    if grep -qi "$pattern" "$proc_file" 2>/dev/null; then
      case_fail "forbidden model/browser-agent process observed among descendants: $pattern"
    fi
  done
}
