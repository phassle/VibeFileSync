# dynamic-qa/acceptance/cases/approvals/independent-gates.case.sh
#
# Acceptance criterion: "Scripted QA Owner and Technical Owner approvals are
# test inputs, and can satisfy or withhold the contract and technical gates
# independently."
#
# This proves the reusable primitive (lib/approvals.sh) a later ticket wires
# to the real Setup Review Packet / Repair Review Packet gates: every
# combination of the two roles' decisions is independent of the other.

case_describe="qa-owner (contract gate) and technical-owner (technical gate) approvals are independent"

case_setup() {
  : # this case exercises the approvals primitive directly; no repository
    # content is needed.
}

case_run() {
  : # each assertion below drives its own combination
}

case_assert() {
  # Combination 1: both approved.
  approval_grant qa-owner "contract review complete"
  approval_grant technical-owner "technical review complete"
  assert_eq "qa-owner reads approved" "approved" "$(approval_decision qa-owner)"
  assert_eq "technical-owner reads approved" "approved" "$(approval_decision technical-owner)"
  assert_true "both-satisfied is true when both approved" approval_both_satisfied qa-owner technical-owner

  # Combination 2: contract approved, technical withheld — must not read as
  # both satisfied, and withholding one must never overwrite the other.
  approval_withhold technical-owner "blocked on a failing negative control"
  assert_eq "qa-owner still reads approved after technical-owner changes" "approved" "$(approval_decision qa-owner)"
  assert_eq "technical-owner reads withheld" "withheld" "$(approval_decision technical-owner)"
  if approval_both_satisfied qa-owner technical-owner; then
    case_fail "both-satisfied must be false when technical-owner is withheld"
  fi

  # Combination 3: contract withheld, technical approved — the opposite
  # direction, proving neither role can satisfy the other's gate.
  approval_grant technical-owner "technical review complete"
  approval_withhold qa-owner "contract terms not yet agreed"
  assert_eq "qa-owner reads withheld" "withheld" "$(approval_decision qa-owner)"
  assert_eq "technical-owner reads approved" "approved" "$(approval_decision technical-owner)"
  if approval_both_satisfied qa-owner technical-owner; then
    case_fail "both-satisfied must be false when qa-owner is withheld"
  fi

  # Combination 4: no scripted answer at all reads as absent, distinct from
  # either approved or withheld — a gate must never treat silence as assent.
  local dir; dir="$(approvals_dir)"
  rm -f "$dir/qa-owner.decision" "$dir/technical-owner.decision"
  assert_eq "qa-owner with no scripted answer reads absent" "absent" "$(approval_decision qa-owner)"
  if approval_both_satisfied qa-owner technical-owner; then
    case_fail "both-satisfied must be false when no answer was ever scripted"
  fi
}
