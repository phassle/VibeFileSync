#!/usr/bin/env bash
# dynamic-qa/acceptance/lib/approvals.sh
#
# Scripted QA Owner / Technical Owner approvals as test inputs.
#
# The parent spec requires the Setup Review Packet (qa-setup) and the Repair
# Review Packet (qa-generate repair) to carry SEPARATE contract and technical
# approvals — either one may be satisfied or withheld independently of the
# other. This module is the reusable primitive later tickets wire their real
# review-packet fixtures to: one decision file per role, so "withhold the
# technical gate while granting the contract gate" (and every other
# combination) is a two-line fixture setup, not bespoke plumbing per ticket.
#
# Decisions live under $FIXTURE_ROOT/approvals/<role>.decision — plain text,
# not parsed by anything but this module, so a transcript/replay adapter or a
# real coding-harness adapter can read them the same way a human's answer
# would be read: as an external input, never as internal state a test peeks
# into.

approvals_dir() {
  echo "${FIXTURE_ROOT:?fixture_create must run first}/approvals"
}

# approval_grant <role> [reason] / approval_withhold <role> [reason]
#
# <role> is caller-defined (contract gates use "qa-owner", technical gates use
# "technical-owner"; a future repair-review fixture may reuse the same two
# roles, or name its own — the primitive does not hardcode role names).
approval_grant() {
  _approval_write "$1" "approved" "${2:-}"
}

approval_withhold() {
  _approval_write "$1" "withheld" "${2:-}"
}

_approval_write() {
  local role="$1" decision="$2" reason="$3"
  local dir; dir="$(approvals_dir)"
  mkdir -p "$dir"
  {
    echo "role=$role"
    echo "decision=$decision"
    echo "reason=$reason"
  } > "$dir/$role.decision"
}

# approval_decision <role> — "approved", "withheld", or "absent" if no
# scripted answer was ever provided for that role (a case can use "absent" to
# prove a gate refuses to proceed without an explicit answer either way).
approval_decision() {
  local role="$1"
  local f; f="$(approvals_dir)/$role.decision"
  [ -f "$f" ] || { echo "absent"; return 0; }
  grep '^decision=' "$f" | cut -d= -f2
}

# approval_both_satisfied <role-a> <role-b> — convenience for the common
# "both gates must independently read approved" check.
approval_both_satisfied() {
  [ "$(approval_decision "$1")" = "approved" ] && [ "$(approval_decision "$2")" = "approved" ]
}
