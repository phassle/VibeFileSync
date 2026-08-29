# dynamic-qa/acceptance/cases/generation/explicit-flow-id-unapproved.case.sh
#
# Behavioural (Tier 2) counterpart to explicit-flow-id-approved: the same
# flow, but the Technical Owner approval was never granted. Generation must
# stop closed with the exact reason "missing-technical-owner-approval" and
# write nothing at all into the fixture repository — the same real
# deterministic-core driver as the approved case, not a transcript replay.

case_describe="qa-generate <flow-id> stops closed with an exact reason and writes nothing when an approval is unmet"

FLOW_ID="checkout-completes"
QA_APPROVED="true"
TECH_APPROVED="false"

case_setup() {
  mkdir -p "$FIXTURE_REPO/qa/flows" "$FIXTURE_REPO/qa/data"
  cat > "$FIXTURE_REPO/qa/flows/$FLOW_ID.yaml" <<'EOF'
schema: dynamic-qa-flow-v1
id: checkout-completes
revision: 1
title: "Checkout completes"
intent: "Prove #146's generation gate refuses an unapproved flow end to end."
criticality: high
state: active
origin:
  tickets:
    - "https://github.com/phassle/VibeFileSync/issues/146"
test_level:
  selection: inferred
data_sets:
  - checkout-basic-case
boundaries:
  - id: checkout-service
    system: "checkout service"
    treatment: real
    role: owned
    behavior: "Submit a checkout for a temporary cart."
    side_effects: "Writes only inside the disposable per-run namespace."
    isolation:
      namespace: "per-run temp directory"
      cleanup: "temp directory removed after each case"
  - id: production-paths
    system: "production paths, user HOME, and external volumes"
    treatment: forbidden
    behavior: "No production or home-directory path is read or written."
    side_effects: "none"
steps:
  - id: given-cart
    kind: given
    intent: "A cart has one item."
  - id: when-checkout
    kind: when
    intent: "The user submits checkout."
  - id: then-checkout-completes
    kind: then
    intent: "Checkout completes."
    outcomes:
      - id: checkout-result-shown
        expect: "The result view reads '${case.result}'."
EOF
  cat > "$FIXTURE_REPO/qa/data/checkout-basic-case.yaml" <<'EOF'
schema: dynamic-qa-data-v1
id: checkout-basic-case
revision: 1
cases:
  - id: basic
    fields:
      result: "done"
EOF
  approval_grant qa-owner
  approval_withhold technical-owner
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  local out
  out="$(FIXTURE_REPO="$FIXTURE_REPO" FLOW_ID="$FLOW_ID" QA_APPROVED="$QA_APPROVED" TECH_APPROVED="$TECH_APPROVED" \
    node "$DYNAMIC_QA_ROOT/acceptance/cases/generation/generate-binding-driver.mjs")"

  local log="$FIXTURE_LOG/transcript.log"
  : > "$log"
  echo "mode=REAL" >> "$log"
  echo "source=generate-binding-driver.mjs (real deterministic core, not a replay)" >> "$log"
  while IFS= read -r line; do
    case "$line" in
      STOP:*) echo "stop_reason=${line#STOP:}" >> "$log" ;;
      WROTE:*) echo "artifact_written=${line#WROTE:}" >> "$log" ;;
    esac
  done <<EOF
$out
EOF
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "missing-technical-owner-approval"
  assert_not_contains "$log" "artifact_written=" \
    "a stopped-closed generation attempt must write no artifact at all"
  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "an unapproved flow must leave the fixture repository completely untouched"
}
