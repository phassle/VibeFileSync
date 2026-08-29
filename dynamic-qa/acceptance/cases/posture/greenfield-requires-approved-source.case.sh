# dynamic-qa/acceptance/cases/posture/greenfield-requires-approved-source.case.sh
#
# Acceptance criterion (ticket #163): "Greenfield setup refuses to proceed
# without approved tickets or examples." This genuinely exercises the REAL
# deterministic-core module (shared/scripts/posture.mjs, no model, no
# network) against a fixture repository that has no application code yet
# (the greenfield case), alongside a transcript_play covering the
# human-facing question/stop-state shape. Also proves stage 3's other core
# rule for greenfield: missing evidence stays `unknown`, never a filled-in
# assumption, and only becomes `reported` once a valid approved source
# exists.

case_describe="greenfield setup refuses to proceed for a flow with no approved ticket or example, and never invents evidence for it"

case_setup() {
  approval_grant qa-owner "accountable QA Owner confirmed"
  approval_grant technical-owner "harness review complete"
  # Deliberately no application source at all — the greenfield case.
  mkdir -p "$FIXTURE_REPO"
  printf '# new project, nothing built yet\n' > "$FIXTURE_REPO/README.md"
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  node --input-type=module -e "
    import {
      repositoryShapeSignal,
      requireApprovedGreenfieldEvidence,
      buildGreenfieldFact,
      validateGreenfieldSource,
    } from '$DYNAMIC_QA_ROOT/shared/scripts/posture.mjs';

    const results = {};
    results.shapeSignal = repositoryShapeSignal('$FIXTURE_REPO');

    const noEvidence = requireApprovedGreenfieldEvidence([]);
    results.noEvidenceOk = noEvidence.ok;

    const invalidOnly = requireApprovedGreenfieldEvidence([
      { type: 'verbal-agreement', reference: 'a chat' },
    ]);
    results.invalidOnlyOk = invalidOnly.ok;

    const domainExpertSource = { type: 'approved-example', reference: 'examples/checkout.md', approvedBy: 'dana', approvedByRole: 'domain-expert' };
    results.domainExpertSourceValid = validateGreenfieldSource(domainExpertSource).ok;

    const unknownFact = buildGreenfieldFact('gf:checkout', 'checkout flow has no approved source yet', []);
    results.unknownFactProvenance = unknownFact.provenance;
    results.unknownFactHasEvidence = Object.prototype.hasOwnProperty.call(unknownFact, 'evidence');

    const validSources = [{ type: 'approved-ticket', reference: '#210', approvedBy: 'per', approvedByRole: 'qa-owner' }];
    const withEvidence = requireApprovedGreenfieldEvidence(validSources);
    results.withEvidenceOk = withEvidence.ok;
    const reportedFact = buildGreenfieldFact('gf:checkout', 'checkout flow evidence', validSources);
    results.reportedFactProvenance = reportedFact.provenance;
    results.reportedFactCitesTicket = reportedFact.evidence.includes('#210');

    process.stdout.write(JSON.stringify(results));
  " > "$FIXTURE_LOG/posture-result.json"

  transcript_play "$CASE_DIR/greenfield-requires-approved-source.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "greenfield-blocked-no-approved-source"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "stage 3 must leave the fixture repository byte-for-byte unchanged, same as stages 1-2"

  assert_file_exists "$FIXTURE_LOG/posture-result.json" "the real posture module did not produce a result"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"hasApplicationCode":false' \
    "a repository with no application source should signal that (informational only, never authoritative)"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"noEvidenceOk":false' \
    "greenfield setup must refuse to proceed with zero sources"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"invalidOnlyOk":false' \
    "greenfield setup must refuse to proceed when every offered source is invalid"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"domainExpertSourceValid":false' \
    "a Domain Expert must never be accepted as the approving role for a greenfield source"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"unknownFactProvenance":"unknown"' \
    "absence of evidence must stay unknown, never a filled-in assumption"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"unknownFactHasEvidence":false' \
    "a fact with no approved source must carry no fabricated evidence field"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"withEvidenceOk":true' \
    "greenfield setup must proceed once a valid approved source exists"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"reportedFactProvenance":"reported"' \
    "a fact backed by a valid approved source must be reported, citing that source"
  assert_contains "$FIXTURE_LOG/posture-result.json" '"reportedFactCitesTicket":true' \
    "the reported fact's evidence must name the approved ticket"
}
