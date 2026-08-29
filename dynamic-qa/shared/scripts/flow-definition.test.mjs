// dynamic-qa/shared/scripts/flow-definition.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  validateFlowDefinition,
  parseFlowDefinitionFile,
} from "./flow-definition.mjs";
import { YamlSyntaxError } from "./restricted-yaml.mjs";
import { contentDigest } from "./canonical-digest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "flows");

function readFixture(...segments) {
  return readFileSync(path.join(FIXTURES, ...segments), "utf8");
}

// --- happy path ------------------------------------------------------------

test("a well-formed Flow Definition validates cleanly", () => {
  const source = readFixture("valid.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "update-preserves-safetynet" });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test("id must match the filename (the immutable Flow ID contract)", () => {
  const source = readFixture("valid.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "some-other-filename" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /does not match its filename/.test(e.message)));
});

// --- fail-closed rules: one test per rule, each proving an actual rejection

test("fail-closed: YAML alias is rejected", () => {
  const source = readFixture("invalid", "alias.yaml");
  assert.throws(() => parseFlowDefinitionFile(source), YamlSyntaxError);
});

test("fail-closed: YAML anchor is rejected", () => {
  const source = readFixture("invalid", "anchor.yaml");
  assert.throws(() => parseFlowDefinitionFile(source), YamlSyntaxError);
});

test("fail-closed: custom YAML tag is rejected", () => {
  const source = readFixture("invalid", "custom-tag.yaml");
  assert.throws(() => parseFlowDefinitionFile(source), YamlSyntaxError);
});

test("fail-closed: duplicate YAML key is rejected", () => {
  const source = readFixture("invalid", "duplicate-key.yaml");
  assert.throws(() => parseFlowDefinitionFile(source), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /duplicate key/i);
    return true;
  });
});

test("fail-closed: executable-expression-like Expected Outcome text is rejected", () => {
  const source = readFixture("invalid", "executable-expression.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "executable-expression-flow" });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => /not a scalar "case\.<field>" reference/.test(e.message)),
    JSON.stringify(result.errors),
  );
});

test("fail-closed: unknown top-level key is rejected", () => {
  const source = readFixture("invalid", "unknown-key.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "unknown-key-flow" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unknown key "selector"/.test(e.message)), JSON.stringify(result.errors));
});

test("fail-closed: unsupported schema version is rejected", () => {
  const source = readFixture("invalid", "unsupported-schema-version.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "unsupported-schema-version-flow" });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => /unsupported schema version/.test(e.message)),
    JSON.stringify(result.errors),
  );
});

test("fail-closed: a custom tolerance without explicit approval is rejected", () => {
  const source = readFixture("invalid", "custom-tolerance-without-approval.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "custom-tolerance-without-approval-flow" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /requires explicit QA Owner approval/.test(e.message)), JSON.stringify(result.errors));
});

test("fail-closed: presentation tolerance cannot relax a non-presentation aspect", () => {
  const source = readFixture("invalid", "presentation-tolerance-forbidden-aspect.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "presentation-tolerance-forbidden-aspect-flow" });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => /may only ignore layout \| style \| position/.test(e.message)),
    JSON.stringify(result.errors),
  );
});

test("fail-closed: a boundary treatment outside real|simulated|forbidden is rejected", () => {
  const source = readFixture("invalid", "boundary-invalid-treatment.yaml");
  const result = parseFlowDefinitionFile(source, { filename: "boundary-invalid-treatment-flow" });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => /treatment must be exactly one of real \| simulated \| forbidden/.test(e.message)),
    JSON.stringify(result.errors),
  );
});

// --- tolerance scoping -------------------------------------------------

test("a tolerance applies to exactly one Expected Outcome (structurally: it is nested under it)", () => {
  const result = validateFlowDefinition({
    schema: "dynamic-qa-flow-v1",
    id: "two-outcome-flow",
    revision: 1,
    title: "t",
    intent: "i",
    criticality: "low",
    state: "draft",
    origin: { tickets: ["https://example.com/1"] },
    test_level: { selection: "inferred" },
    data_sets: [],
    boundaries: [{ id: "b", system: "s", treatment: "real", behavior: "b", side_effects: "none" }],
    steps: [
      { id: "given-a", kind: "given", intent: "i" },
      { id: "when-b", kind: "when", intent: "i" },
      {
        id: "then-c",
        kind: "then",
        intent: "i",
        outcomes: [
          { id: "outcome-exact", expect: "exact one." },
          { id: "outcome-tolerant", expect: "approximate one.", tolerance: { kind: "numeric", abs_epsilon: 0.5 } },
        ],
      },
    ],
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

// --- canonical digests: reformatting vs. semantic change ----------------

function parsedValueOf(fixtureName) {
  // Bypass filename-vs-id checking for this comparison — only the parsed,
  // validated data model matters for the digest, not which file it came
  // from.
  const source = readFixture(fixtureName);
  const result = parseFlowDefinitionFile(source);
  assert.equal(result.valid, true, `${fixtureName}: ${JSON.stringify(result.errors)}`);
  return result;
}

// parseFlowDefinitionFile only returns the validation result, not the parsed
// value, so re-parse with parseRestrictedYAML directly for the digest input
// (the "canonical validated data model" is exactly what was validated).
import { parseRestrictedYAML } from "./restricted-yaml.mjs";

test("digest: reformatting a valid flow (comments, key order, quote style, whitespace) does not change it", () => {
  parsedValueOf("valid.yaml");
  parsedValueOf("valid-reformatted.yaml");
  const original = parseRestrictedYAML(readFixture("valid.yaml"));
  const reformatted = parseRestrictedYAML(readFixture("valid-reformatted.yaml"));
  assert.equal(contentDigest(original), contentDigest(reformatted));
});

test("digest: a semantic change to a valid flow changes it", () => {
  parsedValueOf("valid-semantic-change.yaml");
  const original = parseRestrictedYAML(readFixture("valid.yaml"));
  const changed = parseRestrictedYAML(readFixture("valid-semantic-change.yaml"));
  assert.notEqual(contentDigest(original), contentDigest(changed));
});
