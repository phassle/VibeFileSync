#!/usr/bin/env bash
# dynamic-qa/acceptance/lib/harness_real.sh
#
# The REAL invocation adapter: actually drives an installed skill through a
# real, supported coding harness CLI (Claude Code today; extend
# harness_real_invoke's dispatch as other supported harnesses' headless
# entrypoints become available). This is the genuine embodiment of "invokes
# the installed skills as a user would, not by importing internals" — it
# shells out to the harness binary exactly as a person at a terminal would,
# against a fixture whose HOME/XDG already has the skill installed by
# dynamic-qa/install.sh --target.
#
# This adapter is available but NEVER required: it needs network access and
# real model credentials, both of which the acceptance harness's default run
# must do without (see dynamic-qa/acceptance/README.md "Genuinely exercised
# vs simulated"). It only runs when a case explicitly opts in AND the
# environment explicitly acknowledges the network/credential cost — there is
# no silent fallback to the replay adapter on failure, because that would let
# a simulated pass masquerade as a real one.

set -euo pipefail

# harness_real_requested — true if the case (or the whole run) asked for real
# invocation.
harness_real_requested() {
  [ "${DYNAMIC_QA_HARNESS:-replay}" = "real" ]
}

# harness_real_available <harness-name> — checks the named harness's CLI is
# on PATH. Does not check login/credential state; that is discovered only by
# actually invoking it.
harness_real_available() {
  case "$1" in
    claude-code) command -v claude >/dev/null 2>&1 ;;
    codex) command -v codex >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# harness_real_invoke <harness-name> <skill> <entry-args...>
#
# Requires DYNAMIC_QA_HARNESS=real AND DYNAMIC_QA_ALLOW_NETWORK=1 (a separate,
# explicit acknowledgment that this invocation will use network access and
# real model credentials — set only by a human or CI job that has both). A
# case that calls this without both set fails loudly rather than silently
# degrading to a replay.
harness_real_invoke() {
  local harness_name="$1" skill="$2"; shift 2
  local entry_args="$*"

  if ! harness_real_requested; then
    echo "harness_real_invoke: DYNAMIC_QA_HARNESS=real was not requested" >&2
    return 1
  fi
  if [ "${DYNAMIC_QA_ALLOW_NETWORK:-0}" != "1" ]; then
    echo "harness_real_invoke: refusing to run — set DYNAMIC_QA_ALLOW_NETWORK=1 to" >&2
    echo "acknowledge this invocation uses network access and real model credentials." >&2
    return 1
  fi
  if ! harness_real_available "$harness_name"; then
    echo "harness_real_invoke: '$harness_name' CLI not found on PATH" >&2
    return 1
  fi

  local log="$FIXTURE_LOG/real-invocation.log"
  {
    echo "mode=REAL"
    echo "harness=$harness_name"
    echo "skill=$skill"
    echo "entry_args=$entry_args"
  } > "$log"

  case "$harness_name" in
    claude-code)
      # Headless, non-interactive: -p prints the response and exits, exactly
      # the entrypoint a scripted CI job would use. HOME already points at
      # the fixture, so claude discovers only the fixture's installed
      # ~/.claude/skills, never a real personal skill root.
      ( cd "$FIXTURE_REPO" && claude -p "/$skill $entry_args" ) >> "$log" 2>&1
      ;;
    codex)
      ( cd "$FIXTURE_REPO" && codex exec "\$$skill $entry_args" ) >> "$log" 2>&1
      ;;
  esac
  echo "exit_code=$?" >> "$log"
  echo "$log"
}
