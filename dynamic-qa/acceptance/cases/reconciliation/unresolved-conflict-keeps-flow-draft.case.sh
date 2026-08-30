# dynamic-qa/acceptance/cases/reconciliation/unresolved-conflict-keeps-flow-draft.case.sh
#
# Acceptance criteria (ticket #165):
#   - "Cross-flow duplicates and contradictions are surfaced with the
#     specific conflicting elements named"
#   - "A flow with unresolved disagreement stays draft and does not enter
#     the approved portfolio"
#   - "Approval is recorded per flow and for the portfolio as a whole"
#
# This genuinely exercises the REAL deterministic-core module
# (shared/scripts/portfolio-reconciliation.mjs, no model, no network)
# against two flows that duplicate each other, alongside a transcript_play
# covering the human-facing question/stop-state shape stage 6 presents:
# the QA Owner is shown the conflict and a THIRD, unrelated flow is
# approved, while the two conflicting flows are presented and left
# unresolved this session. This is genuinely behavioural, not just a unit
# property: it proves that even with an explicit, valid qa-owner approval
# record in hand, the conflicting flows cannot be approved — the module
# checks reconciliation status BEFORE it ever looks at the approval input —
# and that the portfolio as a whole is correctly reported as not fully
# approved.

case_describe="two duplicate flows are named as a conflict and stay draft even with an explicit qa-owner approval attempt, while an unrelated third flow is approved and the portfolio is correctly reported as not fully approved"

case_setup() {
  approval_grant qa-owner "accountable QA Owner confirmed"

  mkdir -p "$FIXTURE_REPO/src"
  printf 'module.exports = {};\n' > "$FIXTURE_REPO/src/app.js"
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  # Real invocation of the deterministic core: two flows that duplicate each
  # other's Given/When/Then content under different ids, plus one genuinely
  # different flow. All three receive an explicit qa-owner approval attempt.
  node --input-type=module -e "
    import { reconcilePortfolio, evaluatePortfolioApproval } from '$DYNAMIC_QA_ROOT/shared/scripts/portfolio-reconciliation.mjs';

    function ownedBoundary(id) {
      return { id, system: 'vibesync CLI', treatment: 'real', behavior: 'Invoke the CLI.', side_effects: 'none', role: 'owned' };
    }

    const flowA = {
      schema: 'dynamic-qa-flow-v1', id: 'update-preserves-safetynet', revision: 1,
      title: 'Update preserves prior version', intent: 'Prevent silent loss.',
      criticality: 'high', state: 'draft',
      origin: { tickets: ['https://github.com/phassle/VibeFileSync/issues/18'] },
      test_level: { selection: 'inferred' }, data_sets: [], boundaries: [ownedBoundary('vibesync-cli')],
      steps: [
        { id: 'given-setup', kind: 'given', intent: 'A folder pair uses Update mode.' },
        { id: 'then-outcome', kind: 'then', intent: 'Prior content is preserved.', outcomes: [{ id: 'prior-content-preserved', expect: 'SafetyNet contains the prior content.' }] },
      ],
    };
    // Same GWT content as flowA under a different id/title — a duplicate.
    const flowB = {
      ...flowA,
      id: 'update-keeps-old-version',
      title: 'Update keeps the old version around',
      origin: { tickets: ['https://github.com/phassle/VibeFileSync/issues/19'] },
      boundaries: [ownedBoundary('vibesync-cli-2')],
    };
    // Genuinely different flow — no conflict.
    const flowC = {
      schema: 'dynamic-qa-flow-v1', id: 'compare-detects-conflicts', revision: 1,
      title: 'Compare detects conflicting changes', intent: 'Surface conflicting edits.',
      criticality: 'high', state: 'draft',
      origin: { tickets: ['https://github.com/phassle/VibeFileSync/issues/21'] },
      test_level: { selection: 'inferred' }, data_sets: [], boundaries: [ownedBoundary('vibesync-cli-3')],
      steps: [
        { id: 'given-setup', kind: 'given', intent: 'Two folders were edited independently.' },
        { id: 'then-outcome', kind: 'then', intent: 'A conflict is reported.', outcomes: [{ id: 'conflict-reported', expect: 'A conflict report lists both edits.' }] },
      ],
    };

    const flows = [flowA, flowB, flowC];
    // findDataSetIssues (and therefore reconcilePortfolio) now requires a
    // real resolver rather than silently skipping the check when omitted
    // (finding #1, closed); none of these fixture flows declare data_sets,
    // so the resolver's own behaviour never matters here.
    const report = reconcilePortfolio(flows, { resolveDataSet: () => ({ found: true }) });

    const approval = { approvedBy: 'per', role: 'qa-owner', timestamp: '2026-08-30' };
    const approvals = { 'update-preserves-safetynet': approval, 'update-keeps-old-version': approval, 'compare-detects-conflicts': approval };
    const portfolio = evaluatePortfolioApproval(flows, report, approvals);

    process.stdout.write(JSON.stringify({
      isPortfolioCoherent: report.isPortfolioCoherent,
      duplicateIssueTypes: report.issues.map((i) => i.type),
      approvedFlowIds: portfolio.approvedFlowIds,
      draftFlowIds: portfolio.draftFlowIds.slice().sort(),
      portfolioFullyApproved: portfolio.portfolioFullyApproved,
    }));
  " > "$FIXTURE_LOG/reconciliation-result.json"

  transcript_play "$CASE_DIR/unresolved-conflict-keeps-flow-draft.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "portfolio-not-fully-approved"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "stage 6 must leave the fixture repository byte-for-byte unchanged — reconciliation and review are never a write"

  assert_file_exists "$FIXTURE_LOG/reconciliation-result.json" "the real reconciliation module did not produce a result"
  assert_contains "$FIXTURE_LOG/reconciliation-result.json" '"isPortfolioCoherent":false' \
    "the duplicate pair must make the portfolio incoherent"
  assert_contains "$FIXTURE_LOG/reconciliation-result.json" '"duplicate-flow-content"' \
    "the duplicate must be named by type, not left as an unlabeled disagreement"
  assert_contains "$FIXTURE_LOG/reconciliation-result.json" '"approvedFlowIds":["compare-detects-conflicts"]' \
    "only the genuinely distinct third flow may be approved"
  assert_contains "$FIXTURE_LOG/reconciliation-result.json" '"draftFlowIds":["update-keeps-old-version","update-preserves-safetynet"]' \
    "both conflicting flows must stay draft even though a valid qa-owner approval was attempted for them"
  assert_contains "$FIXTURE_LOG/reconciliation-result.json" '"portfolioFullyApproved":false' \
    "one draft-retained flow must keep the whole portfolio not-fully-approved"
}
