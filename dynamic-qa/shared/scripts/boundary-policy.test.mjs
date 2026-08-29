// dynamic-qa/shared/scripts/boundary-policy.test.mjs
//
// Tests the #145 policy layer on top of boundaries.mjs's shape validation:
// one case per policy rule, plus the inherited restricted-YAML and
// unknown-key/unsupported-version fail-closed rules exercised through
// fixtures/boundaries/ (this module's own fixture directory, distinct from
// #143's fixtures/flows/). Every rule with no test proving it rejects is not
// done — see dynamic-qa-notes/tickets/145.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseFlowDefinitionFile, validateFlowDefinition } from "./flow-definition.mjs";
import { parseRestrictedYAML, YamlSyntaxError } from "./restricted-yaml.mjs";
import { validateBoundaryPolicy, resolveBoundaryTreatment, validateBoundariesFull } from "./boundary-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "boundaries");

function readFixture(...segments) {
  return readFileSync(path.join(FIXTURES, ...segments), "utf8");
}

// Loads a fixture's boundaries array the same way a real caller would:
// restricted-YAML parse, then shape validation, then hand the parsed
// `boundaries` field to the policy layer. Asserts shape is valid first, so a
// policy-rule test never accidentally passes because the fixture was
// malformed in an unrelated way.
function boundariesOf(fixturePath) {
  const source = readFixture(...fixturePath);
  const data = parseRestrictedYAML(source);
  const shapeResult = validateFlowDefinition(data);
  assert.equal(shapeResult.valid, true, `fixture shape must be valid: ${JSON.stringify(shapeResult.errors)}`);
  return data.boundaries;
}

// --- happy path --------------------------------------------------------

test("a fully compliant boundaries declaration set has no policy issues", () => {
  const boundaries = boundariesOf(["valid.yaml"]);
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.deepEqual(issues, []);
});

test("parseFlowDefinitionFile accepts the same fixture end to end", () => {
  const source = readFixture("valid.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "boundary-policy-valid" });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

// --- rule: every crossed dependency/side effect carries exactly one
// classification (inherited from #143's boundaries.mjs; re-proven here
// against this module's own fixture family) -----------------------------

test("rule: treatment must be exactly one of real | simulated | forbidden", () => {
  const boundaries = [
    { id: "b", system: "s", treatment: "mocked", behavior: "b", side_effects: "none", role: "owned" },
  ];
  const result = validateFlowDefinition({
    schema: "dynamic-qa-flow-v1",
    id: "x",
    revision: 1,
    title: "t",
    intent: "i",
    criticality: "low",
    state: "draft",
    origin: { tickets: ["https://example.com/1"] },
    test_level: { selection: "inferred" },
    data_sets: [],
    boundaries,
    steps: [{ id: "given-a", kind: "given", intent: "i" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /treatment must be exactly one of real \| simulated \| forbidden/.test(e.message)));
});

// --- rule: the owned outcome under test cannot be declared simulated ---

test("rule: a boundary marked role: owned cannot be declared simulated", () => {
  const boundaries = boundariesOf(["invalid", "owned-outcome-simulated.yaml"]);
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.ok(
    issues.some((i) => i.message.includes("vibesync-cli") && /cannot be declared "simulated"/.test(i.message)),
    JSON.stringify(issues),
  );
});

test("rule: exactly one boundary must declare role: owned -- zero is refused", () => {
  const boundaries = boundariesOf(["invalid", "no-owned-boundary.yaml"]);
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.ok(issues.some((i) => /no boundary declares role: owned/.test(i.message)), JSON.stringify(issues));
});

test("rule: exactly one boundary must declare role: owned -- more than one is refused", () => {
  const boundaries = boundariesOf(["invalid", "multiple-owned-boundaries.yaml"]);
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.ok(issues.some((i) => /but so does another boundary/.test(i.message)), JSON.stringify(issues));
});

// --- rule: third parties, payments, time, randomness, unverified
// behaviour are simulated or forbidden, never real -----------------------

test("rule: a volatile boundary can never be declared real", () => {
  const boundaries = boundariesOf(["invalid", "volatile-declared-real.yaml"]);
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.ok(
    issues.some((i) => i.message.includes("payment-provider") && /is volatile/.test(i.message)),
    JSON.stringify(issues),
  );
});

test("rule: time and randomness are declarable as simulated so a flow can be deterministic", () => {
  // The `valid.yaml` fixture's system-clock boundary is volatile: true,
  // treatment: simulated -- this is the affirmative case: declaring a
  // volatile dependency as simulated is accepted, not merely tolerated.
  const boundaries = boundariesOf(["valid.yaml"]);
  const clock = boundaries.find((b) => b.id === "system-clock");
  assert.equal(clock.volatile, true);
  assert.equal(clock.treatment, "simulated");
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.deepEqual(issues, []);
});

// --- rule: a flow whose declarations cannot be honoured is refused,
// never silently downgraded ----------------------------------------------

test("rule: a forbidden boundary that claims side effects cannot be honoured", () => {
  const boundaries = boundariesOf(["invalid", "forbidden-with-side-effects.yaml"]);
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.ok(
    issues.some((i) => i.message.includes("production-paths") && /cannot be honoured/.test(i.message)),
    JSON.stringify(issues),
  );
});

// --- rule: undeclared external reach fails closed -----------------------

test("rule: resolveBoundaryTreatment defaults an undeclared boundary id to forbidden, never real", () => {
  const boundaries = boundariesOf(["valid.yaml"]);
  assert.equal(resolveBoundaryTreatment("vibesync-cli", boundaries), "real");
  assert.equal(resolveBoundaryTreatment("some-undeclared-system", boundaries), "forbidden");
  assert.equal(resolveBoundaryTreatment("anything", []), "forbidden");
  assert.equal(resolveBoundaryTreatment("anything", undefined), "forbidden");
});

// --- rule: per-run namespace isolation with cleanup capability ----------

test("rule: a boundary with real side effects must declare isolation.namespace and isolation.cleanup", () => {
  const boundaries = boundariesOf(["invalid", "missing-isolation.yaml"]);
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.ok(
    issues.some((i) => i.message.includes("safetynet-archive") && /namespace isolation with cleanup capability/.test(i.message)),
    JSON.stringify(issues),
  );
});

test("rule: a real boundary declaring side_effects: none needs no isolation block", () => {
  const boundaries = boundariesOf(["valid.yaml"]);
  const cli = boundaries.find((b) => b.id === "vibesync-cli");
  assert.equal(cli.side_effects, "none");
  assert.ok(!("isolation" in cli));
  const issues = validateBoundaryPolicy(boundaries, ["boundaries"]);
  assert.deepEqual(issues, []);
});

// --- inherited fail-closed rules, re-proven against this module's own
// fixture family (fixtures/boundaries/, distinct from #143's fixtures/flows/) --

test("inherited: a YAML alias inside a boundaries document is rejected", () => {
  const source = readFixture("invalid", "alias.yaml");
  assert.throws(() => parseFlowDefinitionFile(source), YamlSyntaxError);
});

test("inherited: an unknown key on a boundary declaration is rejected", () => {
  const source = readFixture("invalid", "unknown-key.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "boundary-unknown-key-flow" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unknown key "selector"/.test(e.message)), JSON.stringify(result.errors));
});

test("inherited: an unsupported schema version is rejected", () => {
  const source = readFixture("invalid", "unsupported-schema-version.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "boundary-unsupported-schema-version-flow" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unsupported schema version/.test(e.message)), JSON.stringify(result.errors));
});

// --- validateBoundariesFull convenience export --------------------------

test("validateBoundariesFull reports shape issues without also running policy checks", () => {
  const issues = validateBoundariesFull(
    [{ id: "b", system: "s", treatment: "not-a-treatment", behavior: "b", side_effects: "none" }],
    ["boundaries"],
  );
  assert.ok(issues.some((i) => /treatment must be exactly one of/.test(i.message)));
  assert.ok(!issues.some((i) => /role: owned/.test(i.message)));
});

test("validateBoundariesFull runs policy checks once shape is clean", () => {
  const boundaries = boundariesOf(["invalid", "no-owned-boundary.yaml"]);
  const issues = validateBoundariesFull(boundaries, ["boundaries"]);
  assert.ok(issues.some((i) => /no boundary declares role: owned/.test(i.message)));
});
