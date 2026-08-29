# dynamic-qa/acceptance/cases/review-packet/discovery-through-stage-9-leaves-repo-unchanged.case.sh
#
# Acceptance criterion (ticket #169): "Nothing is written to the repository
# until both approvals are given" — proved end-to-end, not just at the unit
# level (setup-review-packet.test.mjs already proves the module's own gating
# exhaustively). This case runs the REAL deterministic core through every
# stage discovery (#162) through CI design (#168) touches — inventory scan,
# portfolio reconciliation/approval, safe execution profile design, a
# Baseline Plan, and provider-native CI design — entirely in memory against
# a real, populated fixture repository, and proves the fixture tree is
# byte-for-byte unchanged afterward. Only THEN does it call
# emitSetupReviewPacket with both approvals present, and proves that is the
# first and only point new content exists (still only as an in-memory
# patch — nothing is written by emission itself either; see
# assert_tree_unchanged after emission too).
#
# Note: ticket #167 documents ONE deliberate exception elsewhere in
# qa-setup — SKILL.md stage 8 prose writes qa/baseline-plan.yaml directly so
# multi-day burn-in evidence can accumulate across sessions (SPEC-135 story
# 44; see DECISIONS.md #30 for the full accounting). This case does not
# exercise that SKILL.md-level write path — it builds the Baseline Plan
# purely in memory (buildBaselinePlan) exactly as every other stage-6/7/9
# artifact is held in memory, so it can assert the stronger, literal
# byte-unchanged property this module itself guarantees through stage 9.

case_describe="discovery through stage 9 (inventory, reconciliation, execution profiles, baseline plan, CI design) leaves a populated fixture repository byte-unchanged; only an approved emission produces new content"

case_setup() {
  approval_grant qa-owner "accountable QA Owner confirmed"
  approval_grant technical-owner "harness review complete"

  mkdir -p "$FIXTURE_REPO/src" "$FIXTURE_REPO/.github/workflows"
  cat > "$FIXTURE_REPO/package.json" <<'EOF'
{"devDependencies": {"jest": "^29.0.0"}}
EOF
  cat > "$FIXTURE_REPO/src/checkout.test.js" <<'EOF'
beforeEach(() => { seed(); });
afterEach(() => { cleanup(); });
EOF
  cat > "$FIXTURE_REPO/.github/workflows/acceptance.yml" <<'EOF'
name: CI
on:
  pull_request:
jobs:
  test:
    runs-on: macos-14
    steps:
      - run: npm test
EOF
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before-stage10.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  # Real deterministic-core calls, stage 2 through stage 9, entirely in
  # memory against the real fixture repository. No model, no network.
  node --input-type=module -e "
    import { buildSetupInventory } from '$DYNAMIC_QA_ROOT/shared/scripts/inventory.mjs';
    import { reconcilePortfolio, evaluatePortfolioApproval } from '$DYNAMIC_QA_ROOT/shared/scripts/portfolio-reconciliation.mjs';
    import { designSafeExecutionForApprovedFlows } from '$DYNAMIC_QA_ROOT/shared/scripts/safe-execution-design.mjs';
    import { buildBaselinePlan, knownQuantity, notApplicableQuantity, makeMetric, REQUIRED_METRIC_IDS } from '$DYNAMIC_QA_ROOT/shared/scripts/baseline-plan.mjs';
    import { designProviderNativeCI } from '$DYNAMIC_QA_ROOT/shared/scripts/ci-design.mjs';
    import { assembleSetupReviewPacket, evaluateSetupReviewApproval, emitSetupReviewPacket } from '$DYNAMIC_QA_ROOT/shared/scripts/setup-review-packet.mjs';

    const inventory = buildSetupInventory('$FIXTURE_REPO', { now: new Date('2026-01-01T00:00:00Z') });

    const flow = {
      schema: 'dynamic-qa-flow-v1', id: 'checkout-flow', revision: 1,
      title: 'Checkout completes', intent: 'prove checkout works', criticality: 'high', state: 'active',
      origin: { tickets: ['https://github.com/phassle/VibeFileSync/issues/1'] },
      test_level: { selection: 'inferred' }, data_sets: [], boundaries: [], steps: [],
    };
    const flows = [flow];

    const reconciliation = reconcilePortfolio(flows, {});
    const portfolioApproval = evaluatePortfolioApproval(flows, reconciliation, {
      'checkout-flow': { approvedBy: 'qa-owner-alice', role: 'qa-owner' },
    });

    const executionInventory = {
      owners: { qaOwner: 'qa-owner-alice', technicalOwner: 'tech-owner-bob' },
      allowedPhases: ['ci'], allowedTestLevels: ['api'],
      environments: { runnerClass: 'macos-14', disposable: true, disposabilityEvidence: 'fresh runner per job', sandbox: 'github-actions-hosted-runner', osLimits: {}, containerLimits: {} },
      paths: { allowedRead: ['src/**'], allowedWrite: ['tmp/**'] },
      commands: { allowed: ['npm test'] },
      resources: { maxProcesses: 4, maxCpuSeconds: 600, maxMemoryMb: 2048, maxFileSizeMb: 100, maxWallClockSeconds: 900 },
      identities: { approvedNonProduction: ['ci-bot'], deniedProductionOrMetadata: ['prod-*', '169.254.169.254'] },
      network: { policy: 'none' },
      effects: { allowedBoundaryIds: [], reversibleSideEffects: [], namespace: 'run-\${case.runId}', cleanup: 'automatic', rate: 'unbounded', concurrency: 1 },
      diagnostics: { classes: ['junit'], captureConditions: ['on-failure'], scrubber: 'default', size: 'bounded', audience: 'ci-log', retention: '30-days' },
      evidence: { provider: 'github-actions', capabilities: [] },
    };
    const executionResults = designSafeExecutionForApprovedFlows(flows, portfolioApproval, {
      inventoryByFlowId: { 'checkout-flow': executionInventory },
      contextByFlowId: {},
    });

    function readyMetric(id) {
      if (id === 'repair-decisions') {
        return makeMetric({ id, label: id, query: 'n/a', interval: 'n/a', source: 'n/a', provenance: 'reported', numerator: notApplicableQuantity('no repair activity yet'), denominator: notApplicableQuantity('no repair activity yet'), collectedAt: null });
      }
      const denom = id === 'pr-check-latency-p95' ? 25 : 30;
      return makeMetric({ id, label: id, query: 'select ' + id, interval: 'trailing-30-days', source: 'github-actions', provenance: 'observed', numerator: knownQuantity(3), denominator: knownQuantity(denom), collectedAt: '2026-06-01T00:00:00Z' });
    }
    const baselinePlan = buildBaselinePlan({
      id: 'pilot-baseline', revision: 1, owners: { qaOwner: 'qa-owner-alice', technicalOwner: 'tech-owner-bob' },
      repository: 'phassle/VibeFileSync', window: { startedAt: '2026-05-01T00:00:00Z' },
      metrics: REQUIRED_METRIC_IDS.map(readyMetric), generatedAt: '2026-05-01T00:00:00Z',
    }, { now: new Date('2026-06-01T00:00:00Z') });

    const ciProposal = designProviderNativeCI({
      portfolioApproval, flows,
      executionResultsByFlowId: { 'checkout-flow': executionResults[0] },
      ciInventoryFacts: inventory.facts,
      renderConfig: { runsOn: 'macos-14', nodeVersion: '20', testCommand: 'node --test dynamic-qa/shared/scripts/*.test.mjs', junitPath: 'qa/reports/junit.xml' },
    });

    const packet = assembleSetupReviewPacket({
      flows, portfolioApproval, dataSets: [], executionResults, baselinePlan, ciProposal, harnessFacts: inventory.facts,
    });

    process.stdout.write(JSON.stringify({
      packetComplete: packet.complete,
      readiness: baselinePlan.readiness,
      portfolioFullyApproved: portfolioApproval.portfolioFullyApproved,
    }));

    // Stash everything a second process would need, so case_run's second
    // invocation (the actual emission) is a genuinely separate step, not a
    // continuation of this one's in-memory state.
    const fs = await import('node:fs');
    fs.writeFileSync('$FIXTURE_LOG/stage9-state.json', JSON.stringify({ flows, portfolioApproval, executionResults, baselinePlan, ciProposal, dataSets: [] }));
  " > "$FIXTURE_LOG/stage9.json"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "discovery through stage 9 must leave the fixture repository byte-for-byte unchanged"

  # Now the approved emission — a genuinely separate step reading only the
  # stashed stage-9 state, never a continuation of the same process.
  node --input-type=module -e "
    import { assembleSetupReviewPacket, emitSetupReviewPacket } from '$DYNAMIC_QA_ROOT/shared/scripts/setup-review-packet.mjs';
    const fs = await import('node:fs');
    const state = JSON.parse(fs.readFileSync('$FIXTURE_LOG/stage9-state.json', 'utf8'));
    const harnessFacts = [];
    const packet = assembleSetupReviewPacket({ ...state, harnessFacts });
    const approvalRecord = {
      qaOwnerGate: { present: true, identifier: 'qa-owner-alice' },
      technicalOwnerGate: { present: true, identifier: 'tech-owner-bob' },
    };
    const result = emitSetupReviewPacket({ packet, approvalRecord, ...state });
    process.stdout.write(JSON.stringify({ emitted: result.emitted, fileCount: result.files ? result.files.length : 0, paths: result.summary ? result.summary.paths : [] }));
  " > "$FIXTURE_LOG/emission.json"
}

case_assert() {
  assert_contains "$FIXTURE_LOG/stage9.json" '"packetComplete":true' \
    "the packet must cover all seven areas from real stage 2-9 output"
  assert_contains "$FIXTURE_LOG/stage9.json" '"readiness":"ready"' \
    "the in-memory baseline plan built here must be ready"
  assert_contains "$FIXTURE_LOG/stage9.json" '"portfolioFullyApproved":true' \
    "the single flow must be fully approved for CI design to have run at all"

  assert_contains "$FIXTURE_LOG/emission.json" '"emitted":true' \
    "emission must succeed once both approvals are present and measurement is ready"
  assert_contains "$FIXTURE_LOG/emission.json" '"qa/flows/checkout-flow.yaml"' \
    "the emitted patch must name the approved flow's file"
  assert_contains "$FIXTURE_LOG/emission.json" '"qa/execution-profiles/checkout-flow.yaml"' \
    "the emitted patch must name the flow's Execution Profile file"

  # Emission itself is still only a computed, in-memory patch: even after a
  # successful, fully-approved emission, the fixture repository on disk must
  # remain untouched — emitSetupReviewPacket returns files, it does not
  # write them.
  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "emitSetupReviewPacket itself must never write to the repository — it returns a patch, it does not apply one"
}
