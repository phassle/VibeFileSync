# dynamic-qa/acceptance/cases/generation/explicit-flow-id-approved.case.sh
#
# Behavioural (Tier 2) case for #146's walking skeleton: explicit Flow ID
# generation on an approved (state: active, both approvals granted) flow
# writes exactly the Binding test file and qa/provenance.json into the
# customer's existing layout, and nothing else. Drives the real
# deterministic core (generate-binding-driver.mjs -> preflight.mjs,
# binding-verification.mjs, provenance.mjs) — not a transcript replay.

case_describe="qa-generate <flow-id> on an approved flow writes a Binding into the existing layout plus qa/provenance.json, and nothing else"

FLOW_ID="checkout-completes"
QA_APPROVED="true"
TECH_APPROVED="true"

case_setup() {
  mkdir -p "$FIXTURE_REPO/qa/flows" "$FIXTURE_REPO/qa/data" "$FIXTURE_REPO/qa/execution-profiles"
  cat > "$FIXTURE_REPO/qa/flows/$FLOW_ID.yaml" <<'EOF'
schema: dynamic-qa-flow-v1
id: checkout-completes
revision: 1
title: "Checkout completes"
intent: "Prove #146's generation gate end to end against an approved flow."
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
  cat > "$FIXTURE_REPO/qa/execution-profiles/pilot-profile.yaml" <<'EOF'
schema: dynamic-qa-execution-profile-v1
id: pilot-profile
revision: 1
owners:
  qaOwner: Per
  technicalOwner: Alex
allowedPhases:
  - candidate-verification
  - pr
allowedTestLevels:
  - cli
environments:
  runnerClass: github-hosted-ubuntu
  disposable: true
  disposabilityEvidence: fresh hosted VM per job, destroyed after
  sandbox: vm
paths:
  allowedRead:
    - /repo
  allowedWrite:
    - /repo/tmp
commands:
  allowed:
    - node --test tests/e2e
resources:
  maxProcesses: 4
  maxCpuSeconds: 60
  maxMemoryMb: 512
  maxFileSizeMb: 10
  maxWallTimeSeconds: 120
identities:
  approvedNonProduction:
    - ci-bot
  denyProduction:
    - prod-service-account
  denyMetadata:
    - "169.254.169.254"
network:
  mode: none
effects:
  allowedBoundaryIds:
    - checkout-service
  reversibleSideEffects: true
  namespace: "run-${case.id}"
  cleanup: "remove the per-run temp tree"
credentials: {}
diagnostics:
  classes: []
  captureConditions:
    - failure-only
  scrubber: redact-secrets
  maxSizeMb: 5
  audience: qa-owner
  retentionDays: 7
evidence:
  adapter: github-actions
  capabilities:
    - capability: runtime.node-available
      category: evidence
EOF
  approval_grant qa-owner
  approval_grant technical-owner
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
  assert_stop_state "$log" "generation-complete"

  assert_file_exists "$FIXTURE_REPO/tests/e2e/$FLOW_ID.spec.mjs" \
    "the Binding was not written into the existing test layout"
  assert_file_exists "$FIXTURE_REPO/qa/provenance.json" \
    "qa/provenance.json was not written in the same patch"

  assert_contains "$FIXTURE_REPO/qa/provenance.json" '"flowId": "checkout-completes"' \
    "provenance does not record the generated flow's id"
  assert_contains "$FIXTURE_REPO/qa/provenance.json" '"enforcementLane": "advisory"' \
    "provenance does not record an enforcement lane"

  assert_only_paths_changed "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "tests/e2e/$FLOW_ID.spec.mjs" "qa/provenance.json"
}
