// dynamic-qa/shared/scripts/flow-assembly.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleFlowDefinition, assembleAndRenderFlowDefinition, evidenceIsEligibleForExpectedOutcome } from "./flow-assembly.mjs";
import { makeObservationFact, confirmIntent, buildGreenfieldFact } from "./posture.mjs";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";
import { validateFlowDefinition } from "./flow-definition.mjs";
import { contentDigest } from "./canonical-digest.mjs";

const TICKET = "https://github.com/phassle/VibeFileSync/issues/18";

function baseInterview(overrides = {}) {
  return {
    id: "update-preserves-safetynet",
    revision: 1,
    title: "Update preserves prior version",
    intent: "Prevent silent loss of prior destination content.",
    criticality: "high",
    state: "draft",
    originTickets: [TICKET],
    testLevel: { selection: "inferred" },
    dataSets: [],
    boundaries: [
      {
        id: "vibesync-cli",
        system: "vibesync CLI",
        treatment: "real",
        behavior: "Invoke the CLI.",
        side_effects: "none",
        role: "owned",
      },
    ],
    steps: [
      { id: "given-setup", kind: "given", intent: "A folder pair uses Update mode." },
      {
        id: "then-outcome",
        kind: "then",
        intent: "Prior content is preserved.",
        outcomes: [{ id: "prior-content-preserved", expect: "SafetyNet contains the prior content." }],
      },
    ],
    ...overrides,
  };
}

// --- evidenceIsEligibleForExpectedOutcome: reuses #163's choke point ------

test("a confirmed-intended brownfield observation is eligible evidence", () => {
  const observed = makeObservationFact({ id: "obs:x", provenance: "observed", evidence: "src/x.js" });
  const confirmed = confirmIntent(observed, { decision: "intended", confirmedBy: "per", confirmedByRole: "qa-owner" });
  assert.equal(evidenceIsEligibleForExpectedOutcome(confirmed), true);
});

test("an unconfirmed brownfield observation is never eligible evidence", () => {
  const observed = makeObservationFact({ id: "obs:y", provenance: "observed", evidence: "src/y.js" });
  assert.equal(evidenceIsEligibleForExpectedOutcome(observed), false);
});

test("a confirmed-not-intended brownfield observation (a bug) is never eligible evidence", () => {
  const observed = makeObservationFact({ id: "obs:z", provenance: "observed", evidence: "src/z.js" });
  const confirmedBug = confirmIntent(observed, { decision: "not-intended", confirmedBy: "per", confirmedByRole: "qa-owner" });
  assert.equal(evidenceIsEligibleForExpectedOutcome(confirmedBug), false);
});

test("a greenfield source backed by a valid approved ticket is eligible evidence", () => {
  const fact = buildGreenfieldFact("gf:1", "new flow", [
    { type: "approved-ticket", reference: TICKET, approvedBy: "per", approvedByRole: "qa-owner" },
  ]);
  assert.equal(evidenceIsEligibleForExpectedOutcome(fact), true);
});

test("a greenfield source with no valid approved source is never eligible evidence", () => {
  const fact = buildGreenfieldFact("gf:2", "new flow", []);
  assert.equal(evidenceIsEligibleForExpectedOutcome(fact), false);
});

test("evidenceIsEligibleForExpectedOutcome fails closed on an unrecognized fact shape", () => {
  assert.equal(evidenceIsEligibleForExpectedOutcome({ category: "existing-test", provenance: "observed" }), false);
  assert.equal(evidenceIsEligibleForExpectedOutcome(null), false);
  assert.equal(evidenceIsEligibleForExpectedOutcome(undefined), false);
});

// --- assembleFlowDefinition: interview answers -> validated contract -----

test("a well-formed interview assembles a schema-valid Flow Definition", () => {
  const { valid, errors, flow } = assembleFlowDefinition(baseInterview());
  assert.equal(valid, true, JSON.stringify(errors));
  assert.equal(flow.id, "update-preserves-safetynet");
  assert.equal(flow.schema, "dynamic-qa-flow-v1");
});

test("an interview producing an outcome backed by ineligible evidence fails assembly", () => {
  const observed = makeObservationFact({ id: "obs:unconfirmed", provenance: "observed", evidence: "src/x.js" });
  const interview = baseInterview({
    steps: [
      {
        id: "then-outcome",
        kind: "then",
        intent: "Prior content is preserved.",
        outcomes: [{ id: "prior-content-preserved", expect: "SafetyNet contains the prior content.", evidenceFact: observed }],
      },
    ],
  });
  const { valid, errors } = assembleFlowDefinition(interview);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /not eligible to become an Expected Outcome/.test(e.message)));
});

test("an interview whose evidence IS confirmed-intended assembles successfully", () => {
  const observed = makeObservationFact({ id: "obs:confirmed", provenance: "observed", evidence: "src/x.js" });
  const confirmed = confirmIntent(observed, { decision: "intended", confirmedBy: "per", confirmedByRole: "qa-owner" });
  const interview = baseInterview({
    steps: [
      {
        id: "then-outcome",
        kind: "then",
        intent: "Prior content is preserved.",
        outcomes: [{ id: "prior-content-preserved", expect: "SafetyNet contains the prior content.", evidenceFact: confirmed }],
      },
    ],
  });
  const { valid, errors } = assembleFlowDefinition(interview);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("a flow with no originating ticket link fails assembly", () => {
  const { valid, errors } = assembleFlowDefinition(baseInterview({ originTickets: [] }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /tickets/.test(e.path.join("."))));
});

test("a custom tolerance without approval fails assembly", () => {
  const interview = baseInterview({
    steps: [
      {
        id: "then-outcome",
        kind: "then",
        intent: "Prior content is preserved.",
        outcomes: [
          {
            id: "prior-content-preserved",
            expect: "SafetyNet contains the prior content.",
            tolerance: { kind: "custom" },
          },
        ],
      },
    ],
  });
  const { valid, errors } = assembleFlowDefinition(interview);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /explicit QA Owner approval/.test(e.message)));
});

test("a custom tolerance WITH explicit approval passes assembly", () => {
  const interview = baseInterview({
    steps: [
      {
        id: "then-outcome",
        kind: "then",
        intent: "Prior content is preserved.",
        outcomes: [
          {
            id: "prior-content-preserved",
            expect: "SafetyNet contains the prior content.",
            tolerance: { kind: "custom", approved_by: "per (qa-owner)", reason: "layout varies by terminal width" },
          },
        ],
      },
    ],
  });
  const { valid, errors } = assembleFlowDefinition(interview);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("assembleFlowDefinition never returns a flow when invalid", () => {
  const { valid, flow } = assembleFlowDefinition(baseInterview({ originTickets: [] }));
  assert.equal(valid, false);
  assert.equal(flow, undefined);
});

// --- assembleAndRenderFlowDefinition: the full generate -> validate -> ---
// --- digest round trip ----------------------------------------------------

test("assembleAndRenderFlowDefinition produces YAML that re-validates and keeps a stable digest", () => {
  const result = assembleAndRenderFlowDefinition(baseInterview());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(typeof result.yaml, "string");

  const reparsed = parseRestrictedYAML(result.yaml, { filename: result.flow.id });
  const { valid: reparsedValid, errors: reparsedErrors } = validateFlowDefinition(reparsed, { expectedId: result.flow.id });
  assert.equal(reparsedValid, true, JSON.stringify(reparsedErrors));

  assert.equal(result.digest, contentDigest(result.flow));
  assert.equal(contentDigest(reparsed), result.digest);
});

test("assembleAndRenderFlowDefinition propagates an invalid interview without rendering", () => {
  const result = assembleAndRenderFlowDefinition(baseInterview({ originTickets: [] }));
  assert.equal(result.valid, false);
  assert.equal(result.yaml, undefined);
  assert.equal(result.digest, undefined);
});
