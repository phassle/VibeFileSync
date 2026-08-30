# dynamic-qa/acceptance/cases/inventory/discovery-leaves-repo-unchanged.case.sh
#
# Acceptance criteria (ticket #162): "Discovery writes nothing: no repository
# file, provider policy, infrastructure or secret is modified" and "Secret
# names are listed without any value being read or echoed." This case
# genuinely exercises the REAL deterministic-core scanner
# (shared/scripts/inventory.mjs, no model, no network — see the harness
# README's "genuinely exercised" list) against a populated fixture
# repository, alongside a transcript_play covering the human-facing
# question/stop-state shape stage 1-2 present. Tier 1
# (inventory.test.mjs) already proves this exhaustively at the unit level;
# this case proves the same property end-to-end against the fixture harness
# other tickets build against.

case_describe="discovery (stage 1-2) leaves a populated fixture repository byte-unchanged and never echoes a secret value"

case_setup() {
  approval_grant qa-owner "accountable QA Owner confirmed"
  approval_grant technical-owner "harness review complete"

  mkdir -p "$FIXTURE_REPO/src"
  cat > "$FIXTURE_REPO/package.json" <<'EOF'
{"devDependencies": {"jest": "^29.0.0"}}
EOF
  cat > "$FIXTURE_REPO/src/checkout.test.js" <<'EOF'
beforeEach(() => { seed(); });
afterEach(() => { cleanup(); });
jest.mock('./payments');
EOF
  mkdir -p "$FIXTURE_REPO/.github/workflows"
  cat > "$FIXTURE_REPO/.github/workflows/ci.yml" <<'EOF'
name: CI
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
EOF
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  # Real invocation of the deterministic core (no model, no network) against
  # the fixture repository — genuinely exercised, not simulated.
  node --input-type=module -e "
    import { buildSetupInventory } from '$DYNAMIC_QA_ROOT/shared/scripts/inventory.mjs';
    const inv = buildSetupInventory('$FIXTURE_REPO', { now: new Date('2026-01-01T00:00:00Z') });
    process.stdout.write(JSON.stringify(inv));
  " > "$FIXTURE_LOG/inventory.json"

  # The human-facing question/stop-state shape (simulated replay).
  transcript_play "$CASE_DIR/discovery-leaves-repo-unchanged.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "inventory-presented"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "discovery must leave the fixture repository byte-for-byte unchanged"

  assert_file_exists "$FIXTURE_LOG/inventory.json" "the real scanner did not produce an inventory"
  assert_contains "$FIXTURE_LOG/inventory.json" '"secretName":"NPM_TOKEN"' \
    "the secret's NAME must be inventoried"
  assert_not_contains "$FIXTURE_LOG/inventory.json" '"value"' \
    "no fact may carry a value field on a secret"
  assert_not_contains "$FIXTURE_LOG/inventory.json" "secretValue" \
    "no fact may carry a secretValue field at all"
  assert_contains "$FIXTURE_LOG/inventory.json" '"category":"existing-test"' \
    "existing tests must be inventoried"
  assert_contains "$FIXTURE_LOG/inventory.json" '"provenance":"observed"' \
    "at least some facts must be observed (read directly)"
}
