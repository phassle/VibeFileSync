#!/usr/bin/env bash
# dynamic-qa/acceptance/lib/transcript.sh
#
# The scripted/replay adapter for Tier 2 (the fixture-repository behavioral
# harness). Driving a real LLM-backed skill invocation through a real coding
# harness is slow and nondeterministic; this engine plays back a small,
# declarative, per-case transcript instead, so a case can assert on stop
# states, emitted patches, and command logs deterministically without an
# LLM or a network connection.
#
# A transcript never encodes a skill's prompt wording or internal reasoning.
# It encodes exactly what a human driving the harness would see and do:
# which questions arrived, what a scripted owner answered (via
# lib/approvals.sh), which commands the skill claims to run, what artifact or
# patch it writes, and the external stop state it reaches. Later tickets
# supply their own transcripts for their own fixtures (generation, adoption,
# diagnosis, repair) — this module never hardcodes any skill's business
# logic; that logic is either genuinely agentic (out of scope for a
# deterministic replay) or belongs in the deterministic core under
# dynamic-qa/shared/scripts/ (Tier 1), never re-implemented here.
#
# Every replay run is labeled SIMULATED in its own log, so a passing replay
# case can never be mistaken for proof that a real coding harness, driving
# the real installed skill, behaves the same way. Tier 2's "real" adapter
# (lib/harness_real.sh) is what actually proves that, opt-in, when asked for.
#
# Transcript format (one step per non-blank, non-comment line, "|"-delimited):
#
#   ask|<question-id>|<question-text>
#   answer|<question-id>|<from role via approvals, or a literal value>
#   run|<command-description>
#   write|<relative-path-under-FIXTURE_REPO>|<content-literal-or-@file>
#   stop|<stop-reason>
#
# A line's fields after the first "|" may themselves contain "|" — only the
# first two delimiters are significant.

set -euo pipefail

# transcript_play <transcript-file>
#
# Executes the transcript against the current fixture and writes a run log
# to $FIXTURE_LOG/transcript.log (mode=SIMULATED, one line per step, plus a
# final stop_reason= line assert_stop_state reads).
transcript_play() {
  local transcript_file="$1"
  [ -f "$transcript_file" ] || { echo "transcript_play: no such file: $transcript_file" >&2; return 1; }

  local log="$FIXTURE_LOG/transcript.log"
  : > "$log"
  echo "mode=SIMULATED" >> "$log"
  echo "source=$transcript_file" >> "$log"

  local line kind a b
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    kind="${line%%|*}"
    local rest="${line#*|}"
    a="${rest%%|*}"
    b="${rest#*|}"
    [ "$a" = "$rest" ] && b=""

    case "$kind" in
      ask)
        echo "question_id=$a" >> "$log"
        echo "question_text=$b" >> "$log"
        ;;
      answer)
        local decision
        decision="$(approval_decision "$a" 2>/dev/null || echo "$b")"
        [ "$decision" = "absent" ] && decision="$b"
        echo "answer:$a=$decision" >> "$log"
        ;;
      run)
        echo "command=$a" >> "$log"
        echo "command_result=ok" >> "$log"
        ;;
      write)
        mkdir -p "$FIXTURE_REPO/$(dirname "$a")"
        case "$b" in
          @*) cp "${b#@}" "$FIXTURE_REPO/$a" ;;
          *) printf '%s\n' "$b" > "$FIXTURE_REPO/$a" ;;
        esac
        echo "artifact_written=$a" >> "$log"
        ;;
      stop)
        echo "stop_reason=$a" >> "$log"
        ;;
      *)
        echo "transcript_play: unknown step kind '$kind' in $transcript_file" >&2
        return 1
        ;;
    esac
  done < "$transcript_file"

  echo "$log"
}

# transcript_log_path — where the most recent transcript_play wrote its log,
# for a case's own assert_stop_state / assert_command_ran calls.
transcript_log_path() {
  echo "$FIXTURE_LOG/transcript.log"
}
