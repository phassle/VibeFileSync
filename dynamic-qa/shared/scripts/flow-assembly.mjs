// dynamic-qa/shared/scripts/flow-assembly.mjs
//
// Ticket #164, qa-setup stage 5 ("Interview one flow at a time"). This
// module is the computation stage 5's interview drives: given the structured
// answers one per-flow interview produces, assemble exactly one Flow
// Definition and validate it against #143's contract
// (flow-definition.mjs / dynamic-qa-flow-v1.schema.json). The interview
// itself — phrasing one question at a time, deciding when disagreement is
// unresolved, interpreting a free-text answer — is genuine judgement and
// stays in qa-setup/SKILL.md prose; assembling the resulting data into a
// schema-shaped object and checking it is not, so it lives here instead.
//
// The evidence choke point (ticket #163, DO NOT RE-DERIVE):
//
//   `posture.canBecomeExpectedOutcome(fact)` is the ONLY function that may
//   decide whether a brownfield-observation fact is contract-eligible. This
//   module imports and calls it rather than re-reading `intentStatus`
//   itself. `evidenceIsEligibleForExpectedOutcome` below extends the same
//   posture to greenfield-source facts (whose eligibility rule already lives
//   entirely in posture.mjs's `buildGreenfieldFact`: `provenance` is
//   `"reported"` only when a valid approved source backs it, `"unknown"`
//   otherwise) — this module still does not invent a new eligibility rule,
//   it reads the provenance posture.mjs already computed.

import { validateFlowDefinition, SUPPORTED_SCHEMA } from "./flow-definition.mjs";
import { canBecomeExpectedOutcome } from "./posture.mjs";
import { renderFlowDefinitionYAML } from "./flow-yaml.mjs";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";
import { canonicalize, contentDigest } from "./canonical-digest.mjs";

/**
 * Whether a Fact (fact.mjs) may back an Expected Outcome. Dispatches on the
 * fact's own category rather than re-deriving either category's rule:
 *
 *   - "brownfield-observation": delegates entirely to
 *     posture.canBecomeExpectedOutcome — true only once an accountable human
 *     (qa-owner or technical-owner, never a Domain Expert) has explicitly
 *     confirmed the observation as intended.
 *   - "greenfield-source": eligible exactly when posture.mjs already marked
 *     it "reported" — which only happens when
 *     requireApprovedGreenfieldEvidence found at least one valid approved
 *     ticket/example. An "unknown" greenfield-source fact (no valid source)
 *     is never eligible.
 *   - anything else (including no fact at all): not eligible. An Expected
 *     Outcome may still be authored without citing a specific evidence
 *     fact — this function only gates the case where one IS cited, so an
 *     interview cannot cite ineligible evidence and claim it anyway.
 */
export function evidenceIsEligibleForExpectedOutcome(fact) {
  if (!fact || typeof fact !== "object") return false;
  if (fact.category === "brownfield-observation") {
    return canBecomeExpectedOutcome(fact);
  }
  if (fact.category === "greenfield-source") {
    return fact.provenance === "reported";
  }
  return false;
}

function buildOutcome(input, path, issues) {
  const outcome = { id: input?.id, expect: input?.expect };
  if (input && input.tolerance !== undefined) outcome.tolerance = input.tolerance;
  if (input && Object.prototype.hasOwnProperty.call(input, "evidenceFact")) {
    if (!evidenceIsEligibleForExpectedOutcome(input.evidenceFact)) {
      issues.push({
        path,
        message: `evidence fact ${JSON.stringify(input.evidenceFact && input.evidenceFact.id)} cited for outcome ${JSON.stringify(
          input.id,
        )} is not eligible to become an Expected Outcome — a brownfield observation must be confirmed-intended by the QA Owner or Technical Owner, and a greenfield source must be backed by a valid approved ticket/example, before it can be cited here`,
      });
    }
  }
  return outcome;
}

function buildStep(input, path, issues) {
  const step = { id: input?.id, kind: input?.kind, intent: input?.intent };
  if (input && Array.isArray(input.outcomes)) {
    step.outcomes = input.outcomes.map((outcome, i) => buildOutcome(outcome, [...path, "outcomes", i], issues));
  }
  return step;
}

/**
 * Assembles one Flow Definition from a single flow interview's structured
 * answers, then validates it against #143's contract. Returns
 * { valid, errors, flow }: `flow` is present only when `valid` is true — the
 * same "never a partially-valid result" posture as flow-definition.mjs's own
 * validator.
 *
 * `interview` shape (all fields are the interview's resolved answers, not
 * free text):
 *   { id, revision, title, intent, criticality, state,
 *     originTickets: string[], testLevel: { selection, value?, reason? },
 *     dataSets: string[], boundaries: object[],
 *     steps: [{ id, kind, intent, outcomes?: [{ id, expect, tolerance?,
 *       evidenceFact? }] }] }
 */
export function assembleFlowDefinition(interview = {}) {
  const issues = [];

  const flow = {
    schema: SUPPORTED_SCHEMA,
    id: interview.id,
    revision: interview.revision,
    title: interview.title,
    intent: interview.intent,
    criticality: interview.criticality,
    state: interview.state,
    origin: { tickets: Array.isArray(interview.originTickets) ? interview.originTickets : [] },
    test_level: interview.testLevel,
    data_sets: Array.isArray(interview.dataSets) ? interview.dataSets : [],
    boundaries: Array.isArray(interview.boundaries) ? interview.boundaries : [],
    steps: Array.isArray(interview.steps)
      ? interview.steps.map((step, i) => buildStep(step, ["steps", i], issues))
      : [],
  };

  // Evidence-eligibility issues are checked before, and independently of,
  // schema validation: an evidence problem is a stage-5 interview blocker
  // (see qa-setup/SKILL.md), not a schema shape problem, and must be
  // reported even if the rest of the flow happens to be schema-valid.
  if (issues.length > 0) {
    return { valid: false, errors: issues, flow: undefined };
  }

  const { valid, errors } = validateFlowDefinition(flow, { expectedId: flow.id });
  return { valid, errors, flow: valid ? flow : undefined };
}

/**
 * assembleFlowDefinition, plus rendering the result as restricted-YAML text
 * (for stage 5's "exact YAML Flow Review", SPEC-135.md story 37) and
 * re-parsing that text to PROVE the round trip: the rendered text parses
 * back to a schema-valid Flow Definition whose canonical digest is
 * byte-identical to the original assembled value's digest. Returns
 * { valid, errors, flow, yaml, digest } — `yaml`/`digest` are present only
 * when `valid` is true.
 */
export function assembleAndRenderFlowDefinition(interview = {}) {
  const result = assembleFlowDefinition(interview);
  if (!result.valid) return result;

  const yaml = renderFlowDefinitionYAML(result.flow);
  const reparsed = parseRestrictedYAML(yaml, { filename: result.flow.id });
  const reparsedValidation = validateFlowDefinition(reparsed, { expectedId: result.flow.id });
  if (!reparsedValidation.valid) {
    // A rendering bug that produces YAML the validator rejects is a defect
    // in THIS module, not the interview's answers — fail closed rather than
    // hand back YAML that would not survive a real qa-generate read.
    return {
      valid: false,
      errors: [
        {
          path: [],
          message: "rendered Flow Definition YAML failed to re-validate after round-tripping through the restricted-YAML parser — this is a flow-yaml.mjs rendering defect",
        },
        ...reparsedValidation.errors,
      ],
      flow: undefined,
    };
  }

  const originalDigest = contentDigest(result.flow);
  const reparsedDigest = contentDigest(reparsed);
  if (originalDigest !== reparsedDigest) {
    return {
      valid: false,
      errors: [
        {
          path: [],
          message: `canonical digest changed across the YAML round trip (${originalDigest} -> ${reparsedDigest}) — reformatting must never change the digest`,
        },
      ],
      flow: undefined,
    };
  }

  return { valid: true, errors: [], flow: result.flow, yaml, digest: originalDigest };
}

export { canonicalize, contentDigest };
