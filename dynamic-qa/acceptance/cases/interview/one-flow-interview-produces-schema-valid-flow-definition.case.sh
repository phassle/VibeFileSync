# dynamic-qa/acceptance/cases/interview/one-flow-interview-produces-schema-valid-flow-definition.case.sh
#
# Acceptance criteria (ticket #164):
#   - "Each interview produces exactly one Flow Definition, linked to its
#     originating tickets"
#   - "Interviews ask one question at a time and stop on unresolved
#     disagreement rather than assuming"
#
# This genuinely exercises the REAL deterministic-core modules
# (shared/scripts/posture.mjs, flow-assembly.mjs, flow-yaml.mjs,
# flow-definition.mjs — no model, no network) end to end: a brownfield
# observation is confirmed intended through #163's own choke point, the
# interview's structured answers are assembled into a Flow Definition,
# rendered as restricted-YAML text, and re-validated — the same "generate ->
# validate -> canonical digest is stable" round trip Tier 1 already proves
# at the unit level (flow-assembly.test.mjs), now shown end to end against
# the fixture harness other tickets build against. Stage 5, like stages 1-4,
# writes nothing to the fixture repository — the rendered YAML is a review
# artifact in $FIXTURE_LOG, not a repository file, since only stage 10's
# Setup Review Packet may write.
#
# `assembleAndRenderFlowDefinition` validates the Flow Definition's *shape*
# only (#143/#145's boundaries.mjs, via flow-definition.mjs) — by design,
# #145's cross-cutting boundary-policy.mjs (owned-outcome-stays-real,
# volatile-can-never-be-real, forbidden-must-be-honourable, and real side
# effects require isolation.namespace/isolation.cleanup) is a separate,
# later gate that qa-generate's preflight.mjs runs before Binding
# generation, not something stage 5's own assembly re-checks. That split is
# intentional (a QA Owner may still be shaping a boundary's exact isolation
# strategy after the Flow Review), but it means a Flow Review this case
# presents as "agreed" must still be genuinely boundary-policy-compliant —
# otherwise the QA Owner would approve a Flow Definition that is silently
# guaranteed to fail later, at generation time, for a reason stage 5 never
# surfaced. This case's fixture boundary therefore also declares
# `isolation.namespace`/`isolation.cleanup` (a real side-effect boundary
# requires both), and `case_run` additionally calls the real
# `validateBoundaryPolicy` directly against the assembled flow's boundaries
# and asserts it comes back clean — so this case genuinely proves the
# reviewed Flow Definition would also survive the later boundary-policy
# gate, not merely that it is schema-shaped.

case_describe="a one-flow interview, asked one question at a time, produces exactly one schema-valid Flow Definition linked to its originating ticket"

case_setup() {
  approval_grant qa-owner "accountable QA Owner confirmed"
  approval_grant technical-owner "harness review complete"

  mkdir -p "$FIXTURE_REPO/src"
  cat > "$FIXTURE_REPO/src/update.js" <<'EOF'
function update(destination, source) {
  // observed: writes source content over destination without keeping a copy
  destination.write(source.read());
}
module.exports = { update };
EOF
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/repo-before.snapshot"
  fixture_snapshot "$FIXTURE_REPO" > "$BEFORE_SNAPSHOT"

  node --input-type=module -e "
    import { makeObservationFact, confirmIntent } from '$DYNAMIC_QA_ROOT/shared/scripts/posture.mjs';
    import { assembleAndRenderFlowDefinition } from '$DYNAMIC_QA_ROOT/shared/scripts/flow-assembly.mjs';
    import { validateBoundaryPolicy } from '$DYNAMIC_QA_ROOT/shared/scripts/boundary-policy.mjs';
    import { writeFileSync } from 'node:fs';

    // Stage 3's choke point, reused rather than re-derived: the observation
    // only becomes eligible once the QA Owner explicitly confirms intent.
    const observed = makeObservationFact({
      id: 'obs:update-preserves-prior',
      provenance: 'observed',
      description: 'update() should preserve the prior destination content before overwriting it',
      evidence: 'src/update.js',
    });
    const confirmed = confirmIntent(observed, {
      decision: 'intended',
      confirmedBy: 'per',
      confirmedByRole: 'qa-owner',
    });

    const interview = {
      id: 'update-preserves-safetynet',
      revision: 1,
      title: 'Update preserves the prior destination version before overwriting it',
      intent: 'Prevent silent loss of the previous destination content when Update replaces it.',
      criticality: 'high',
      state: 'draft',
      originTickets: ['https://github.com/phassle/VibeFileSync/issues/18'],
      testLevel: { selection: 'inferred' },
      dataSets: [],
      boundaries: [
        {
          id: 'vibesync-cli',
          system: 'vibesync CLI',
          treatment: 'real',
          behavior: 'Invoke the CLI Update mode against a temporary folder pair.',
          side_effects: 'Writes only inside disposable temporary directories created for this run.',
          role: 'owned',
          isolation: {
            namespace: 'a fresh temporary source/destination folder pair created for this run',
            cleanup: 'the temporary folder pair is removed once the run ends, including on failure',
          },
        },
      ],
      steps: [
        { id: 'given-changed-destination', kind: 'given', intent: 'A folder pair uses Update mode with a differing destination.' },
        { id: 'when-run', kind: 'when', intent: 'The QA Owner approves Run.' },
        {
          id: 'then-safetynet-preserves-prior',
          kind: 'then',
          intent: 'The prior destination content is preserved in SafetyNet.',
          outcomes: [
            {
              id: 'safetynet-has-prior-content',
              expect: 'Exactly one SafetyNet Run folder contains the prior destination content.',
              evidenceFact: confirmed,
            },
          ],
        },
      ],
    };

    const result = assembleAndRenderFlowDefinition(interview);

    // This case's own claim (see the header comment) is not just schema
    // validity — it is that the reviewed Flow Definition is also genuinely
    // boundary-policy-compliant, i.e. would still pass at qa-generate's
    // later preflight gate. assembleAndRenderFlowDefinition never calls
    // validateBoundaryPolicy itself (that gate lives in preflight.mjs), so
    // this case calls the real function directly against the assembled
    // flow's boundaries rather than only asserting schema validity and
    // assuming the rest.
    const boundaryPolicyIssues = result.valid
      ? validateBoundaryPolicy(result.flow.boundaries, ['boundaries'])
      : null;

    writeFileSync('$FIXTURE_LOG/flow-review.yaml', result.valid ? result.yaml : '');
    process.stdout.write(JSON.stringify({
      valid: result.valid,
      errors: result.errors,
      flowId: result.valid ? result.flow.id : null,
      originTickets: result.valid ? result.flow.origin.tickets : null,
      digest: result.valid ? result.digest : null,
      boundaryPolicyIssues,
    }));
  " > "$FIXTURE_LOG/interview-result.json"

  transcript_play "$CASE_DIR/one-flow-interview-produces-schema-valid-flow-definition.transcript" >/dev/null
}

case_assert() {
  local log; log="$(transcript_log_path)"
  assert_stop_state "$log" "flow-review-presented"

  # One question at a time: every ask/answer pair in the transcript is its
  # own line, so a distinct question_id is recorded per question rather than
  # one combined prompt.
  local question_count
  question_count="$(grep -c '^question_id=' "$log")"
  assert_eq "stage 5 must ask one question at a time" "6" "$question_count"

  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT" \
    "stage 5 must leave the fixture repository byte-for-byte unchanged — nothing is written until stage 10's Setup Review Packet"

  assert_file_exists "$FIXTURE_LOG/interview-result.json" "the real flow-assembly module did not produce a result"
  assert_contains "$FIXTURE_LOG/interview-result.json" '"valid":true' \
    "assembling the interview's answers must produce a schema-valid Flow Definition"
  assert_contains "$FIXTURE_LOG/interview-result.json" '"flowId":"update-preserves-safetynet"' \
    "exactly one Flow Definition, with the interviewed flow's own id, must be produced"
  assert_contains "$FIXTURE_LOG/interview-result.json" 'https://github.com/phassle/VibeFileSync/issues/18' \
    "the assembled Flow Definition must link its originating ticket"

  assert_file_exists "$FIXTURE_LOG/flow-review.yaml" "stage 5's exact YAML Flow Review artifact was not produced"
  assert_contains "$FIXTURE_LOG/flow-review.yaml" 'schema: "dynamic-qa-flow-v1"' \
    "the rendered review YAML must declare the v1 schema"

  # Schema-valid is not the whole claim: the agreed Flow Review must also be
  # genuinely boundary-policy-compliant, so a QA Owner who approves it here
  # is never surprised by a boundary-policy rejection later at qa-generate's
  # preflight gate. `boundaryPolicyIssues` comes from calling the real
  # validateBoundaryPolicy (boundary-policy.mjs) against the assembled
  # flow's own boundaries, not a re-assertion of schema validity.
  assert_contains "$FIXTURE_LOG/interview-result.json" '"boundaryPolicyIssues":[]' \
    "the vibesync-cli boundary declares real side effects, so it must also satisfy validateBoundaryPolicy (owned/real, and isolation.namespace + isolation.cleanup present) with zero issues — not merely pass schema shape validation"
}
