// dynamic-qa/shared/scripts/flow-yaml.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFlowDefinitionYAML } from "./flow-yaml.mjs";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";
import { validateFlowDefinition } from "./flow-definition.mjs";
import { contentDigest } from "./canonical-digest.mjs";

function sampleFlow() {
  return {
    schema: "dynamic-qa-flow-v1",
    id: "sample-flow",
    revision: 1,
    title: "Sample flow",
    intent: "Prove the round trip.",
    criticality: "high",
    state: "draft",
    origin: { tickets: ["https://github.com/phassle/VibeFileSync/issues/1"] },
    test_level: { selection: "inferred" },
    data_sets: [],
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
      { id: "given-setup", kind: "given", intent: "A folder pair exists." },
      {
        id: "then-outcome",
        kind: "then",
        intent: "The result matches.",
        outcomes: [
          { id: "result-matches", expect: "The result reads '${case.value}'." },
          { id: "nothing-else-remains", expect: "No stray files remain.", tolerance: { kind: "exact" } },
        ],
      },
    ],
  };
}

test("renderFlowDefinitionYAML produces text that parses back to an equal value", () => {
  const flow = sampleFlow();
  const yaml = renderFlowDefinitionYAML(flow);
  const parsed = parseRestrictedYAML(yaml, { filename: flow.id });
  assert.deepEqual(parsed, flow);
});

test("rendered YAML validates against the v1 schema", () => {
  const flow = sampleFlow();
  const yaml = renderFlowDefinitionYAML(flow);
  const parsed = parseRestrictedYAML(yaml, { filename: flow.id });
  const { valid, errors } = validateFlowDefinition(parsed, { expectedId: flow.id });
  assert.equal(valid, true, JSON.stringify(errors));
});

test("reformatting through render+parse preserves the canonical digest", () => {
  const flow = sampleFlow();
  const before = contentDigest(flow);
  const yaml = renderFlowDefinitionYAML(flow);
  const parsed = parseRestrictedYAML(yaml, { filename: flow.id });
  const after = contentDigest(parsed);
  assert.equal(before, after);
});

test("a semantic change to the flow changes the digest across the round trip", () => {
  const flow = sampleFlow();
  const before = contentDigest(parseRestrictedYAML(renderFlowDefinitionYAML(flow), { filename: flow.id }));
  const changed = { ...flow, criticality: "low" };
  const after = contentDigest(parseRestrictedYAML(renderFlowDefinitionYAML(changed), { filename: changed.id }));
  assert.notEqual(before, after);
});

test("special characters in scalar text survive the round trip", () => {
  const flow = sampleFlow();
  flow.title = 'A "quoted" title with a backslash \\ and a newline\nin it';
  const yaml = renderFlowDefinitionYAML(flow);
  const parsed = parseRestrictedYAML(yaml, { filename: flow.id });
  assert.equal(parsed.title, flow.title);
});

test("empty data_sets renders as [] and round-trips to an empty array", () => {
  const flow = sampleFlow();
  flow.data_sets = [];
  const yaml = renderFlowDefinitionYAML(flow);
  assert.match(yaml, /data_sets: \[\]/);
  const parsed = parseRestrictedYAML(yaml, { filename: flow.id });
  assert.deepEqual(parsed.data_sets, []);
});

test("renderFlowDefinitionYAML rejects a non-object input", () => {
  assert.throws(() => renderFlowDefinitionYAML(null));
  assert.throws(() => renderFlowDefinitionYAML("nope"));
});
