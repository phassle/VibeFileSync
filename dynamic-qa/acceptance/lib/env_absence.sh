#!/usr/bin/env bash
# dynamic-qa/acceptance/lib/env_absence.sh
#
# Verifies that ordinary CI runs happen with all model and browser-agent
# CREDENTIALS absent, and SAMPLES the launched command's process tree for
# any forbidden-looking process observed while it ran (a non-negotiable
# invariant: ordinary PR and nightly regression runs call no LLM and no
# browser agent). This does NOT scan the ambient machine — a developer's
# own shell may legitimately have Claude Code credentials exported for
# unrelated work, and a machine-wide `ps` scan would make this flaky on
# exactly the box a later implementer develops on. Instead it proves the
# harness's OWN mechanism: any child process it spawns is launched through
# an explicitly scrubbed environment, and that scrubbing is checked
# directly rather than assumed.
#
# Two guarantees of very different strength live in this file (CodeRabbit
# re-review finding on PR #177, env_absence.sh:104 — see DECISIONS.md §35
# for the full writeup):
#
#   - Credential absence (assert_no_credential_leak) is checked against a
#     complete, deterministic `env` dump of the scrubbed child — every
#     variable the child process actually had is in that dump, so this
#     assertion is a real, complete proof, not a sample. This is the
#     load-bearing guarantee: ordinary CI has no model credentials in its
#     environment at all, so even a forbidden process that DID start would
#     have nothing to call out with.
#
#   - Process-name sampling (assert_no_forbidden_process_name_observed,
#     renamed from assert_no_forbidden_descendant_processes) is NECESSARILY
#     a best-effort, sampled OBSERVATION, not a complete execution audit. A
#     forbidden process that starts and exits between two `ps` samples (or
#     before the very first one) never has its `comm` written to
#     $DYNAMIC_QA_PROC_FILE, and this check then passes having never seen
#     it. A complete audit would require an exec-event tracer (dtrace,
#     eBPF/execsnoop, or an OS-level sandbox policy recording every
#     descendant `exec`) — none of those is portable or available
#     unprivileged across the platforms this harness runs on, so this file
#     does not pretend to provide one. The polling loop is tightened to
#     sample as fast as is reasonable (see the do-while shape and the 0.02s
#     interval below) purely as a diagnostic aid — catching more of what
#     happens to be slow enough to observe — never as a claim of
#     completeness.

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

# assert_no_forbidden_process_name_observed <log-file>
#
# NOT a complete execution audit — see the file-level comment above and
# DECISIONS.md §35. This asserts only that repeated `ps` SAMPLING of the
# command's process tree never CAUGHT a forbidden-looking process name
# while it ran. A forbidden process that starts and exits between two
# samples (or before the first one) leaves no trace here and this
# assertion passes regardless — that gap is real and is not closed by
# tightening the sample interval, only narrowed. Name it what it proves:
# "observed" and "sampling", never "no forbidden process ran".
#
# Checked only against "<log-file>.procs" — real process `comm` names, one
# per line, never the env dump or the command's own stdout — so a tmp/HOME
# path that happens to contain a harness name never counts as that harness
# actually running.
assert_no_forbidden_process_name_observed() {
  local log_file="$1" pattern
  local proc_file="${log_file}.procs"
  [ -f "$proc_file" ] || { case_fail "no process sample list found at $proc_file"; return; }
  for pattern in $DYNAMIC_QA_FORBIDDEN_PROCESS_PATTERNS; do
    if grep -qi "$pattern" "$proc_file" 2>/dev/null; then
      case_fail "forbidden-looking model/browser-agent process name sampled among descendants: $pattern"
    fi
  done
}
