# dynamic-qa/acceptance/cases/review-packet/withholding-either-approval-emits-nothing.case.sh
#
# Acceptance criterion (ticket #169): "Withholding either approval leaves
# the repository untouched" — contract (qa-owner) approval and technical
# approval each independently gate emission; withholding either one, even
# with the other fully granted and every other input ready, must emit
# nothing. This case wires the reusable approvals.sh primitive
# (acceptance/cases/approvals/independent-gates.case.sh built it for exactly
# this reuse) to the REAL emitSetupReviewPacket gate.

case_describe="withholding qa-owner (contract) approval, or technical-owner approval, or both, emits nothing from a real, otherwise-ready Setup Review Packet"

case_setup() {
  : # this case drives the deterministic core directly; no repository
    # content is required to prove the approval gate itself.
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  # combination 1: contract approved, technical withheld
  approval_grant qa-owner "contract review complete"
  approval_withhold technical-owner "blocked on a failing negative control"
  _run_emission "$(approval_decision qa-owner)" "$(approval_decision technical-owner)" > "$FIXTURE_LOG/combo1.json"

  # combination 2: contract withheld, technical approved — the opposite direction
  approval_withhold qa-owner "contract terms not yet agreed"
  approval_grant technical-owner "technical review complete"
  _run_emission "$(approval_decision qa-owner)" "$(approval_decision technical-owner)" > "$FIXTURE_LOG/combo2.json"

  # combination 3: both withheld
  approval_withhold qa-owner "contract terms not yet agreed"
  approval_withhold technical-owner "blocked on a failing negative control"
  _run_emission "$(approval_decision qa-owner)" "$(approval_decision technical-owner)" > "$FIXTURE_LOG/combo3.json"

  # combination 4 (control): both approved — proves the harness itself is
  # capable of emitting, so combos 1-3 emitting nothing is a real gate, not
  # a broken fixture.
  approval_grant qa-owner "contract review complete"
  approval_grant technical-owner "technical review complete"
  _run_emission "$(approval_decision qa-owner)" "$(approval_decision technical-owner)" > "$FIXTURE_LOG/combo4-control.json"
}

_run_emission() {
  local qa_decision="$1" technical_decision="$2"
  node --input-type=module -e "
    import { assembleSetupReviewPacket, emitSetupReviewPacket } from '$DYNAMIC_QA_ROOT/shared/scripts/setup-review-packet.mjs';
    import { buildBaselinePlan, knownQuantity, notApplicableQuantity, makeMetric, REQUIRED_METRIC_IDS } from '$DYNAMIC_QA_ROOT/shared/scripts/baseline-plan.mjs';

    const flow = {
      schema: 'dynamic-qa-flow-v1', id: 'checkout-flow', revision: 1,
      title: 'Checkout completes', intent: 'x', criticality: 'high', state: 'active',
      origin: { tickets: ['https://github.com/phassle/VibeFileSync/issues/1'] },
      test_level: { selection: 'inferred' }, data_sets: [], boundaries: [], steps: [],
    };
    const flows = [flow];
    const portfolioApproval = { approvedFlowIds: ['checkout-flow'], draftFlowIds: [], portfolioFullyApproved: true, perFlow: [] };
    const executionResults = [{
      flowId: 'checkout-flow',
      profile: { environments: { runnerClass: 'macos-14' } },
      profileYaml: 'schema: \"dynamic-qa-execution-profile-v1\"\nid: \"checkout-flow\"\n',
      decision: { activate: true, state: 'activatable', blockers: [] },
    }];

    function readyMetric(id) {
      if (id === 'repair-decisions') {
        return makeMetric({ id, label: id, query: 'n/a', interval: 'n/a', source: 'n/a', provenance: 'reported', numerator: notApplicableQuantity('none yet'), denominator: notApplicableQuantity('none yet'), collectedAt: null });
      }
      const denom = id === 'pr-check-latency-p95' ? 25 : 30;
      return makeMetric({ id, label: id, query: 'select ' + id, interval: 'trailing-30-days', source: 'github-actions', provenance: 'observed', numerator: knownQuantity(3), denominator: knownQuantity(denom), collectedAt: '2026-06-01T00:00:00Z' });
    }
    const baselinePlan = buildBaselinePlan({
      id: 'pilot-baseline', revision: 1, owners: { qaOwner: 'qa-owner-alice', technicalOwner: 'tech-owner-bob' },
      repository: 'phassle/VibeFileSync', window: { startedAt: '2026-05-01T00:00:00Z' },
      metrics: REQUIRED_METRIC_IDS.map(readyMetric), generatedAt: '2026-05-01T00:00:00Z',
    }, { now: new Date('2026-06-01T00:00:00Z') });

    const ciProposal = {
      provider: 'github-actions', approvedFlowIds: ['checkout-flow'],
      lanes: [{ flowId: 'checkout-flow', laneName: 'pr-fast', requiredTrigger: 'pull_request', assigned: true, enforcementState: 'advisory' }],
      diffChoice: undefined,
      namedInfrastructure: { runners: ['macos-14'], environments: [], triggers: ['pull_request'], existingWorkflowPaths: ['.github/workflows/acceptance.yml'], hasMergeQueue: false },
      runnerMatchesInventory: { runner: 'macos-14', matches: true },
    };

    const packet = assembleSetupReviewPacket({ flows, portfolioApproval, dataSets: [], executionResults, baselinePlan, ciProposal, harnessFacts: [] });

    const approvalRecord = {
      qaOwnerGate: { present: '$qa_decision' === 'approved', identifier: 'qa-owner-alice' },
      technicalOwnerGate: { present: '$technical_decision' === 'approved', identifier: 'tech-owner-bob' },
    };
    const result = emitSetupReviewPacket({ packet, approvalRecord, flows, executionResults, dataSets: [], baselinePlan, ciProposal });
    process.stdout.write(JSON.stringify({ emitted: result.emitted, reason: result.reason ?? null }));
  "
}

case_assert() {
  assert_contains "$FIXTURE_LOG/combo1.json" '"emitted":false' "technical-owner withheld must emit nothing"
  assert_contains "$FIXTURE_LOG/combo1.json" '"reason":"technical-approval-withheld"' "combo1 must name the withheld technical gate"

  assert_contains "$FIXTURE_LOG/combo2.json" '"emitted":false' "qa-owner (contract) withheld must emit nothing"
  assert_contains "$FIXTURE_LOG/combo2.json" '"reason":"contract-approval-withheld"' "combo2 must name the withheld contract gate"

  assert_contains "$FIXTURE_LOG/combo3.json" '"emitted":false' "both withheld must emit nothing"
  assert_contains "$FIXTURE_LOG/combo3.json" '"reason":"both-approvals-withheld"' "combo3 must name both gates withheld"

  assert_contains "$FIXTURE_LOG/combo4-control.json" '"emitted":true' \
    "control case: both approved must actually emit, proving combos 1-3 are a real gate and not a broken fixture"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "withholding either approval (or both) must leave the fixture repository untouched"
}
