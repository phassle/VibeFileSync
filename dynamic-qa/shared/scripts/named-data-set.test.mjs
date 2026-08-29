// dynamic-qa/shared/scripts/named-data-set.test.mjs
//
// Tier 1 (node --test) coverage for the Named Data Set v1 contract
// (named-data-set.mjs). The rule this module exists to enforce — "a rule
// with no test proving it rejects is not done" — means every fail-closed
// path below has its own fixture and its own assertion that it actually
// rejects, not just a happy-path smoke test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateNamedDataSet, parseNamedDataSetFile } from "./named-data-set.mjs";
import { YamlSyntaxError } from "./restricted-yaml.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "data-sets");

function readFixture(...segments) {
  return readFileSync(path.join(FIXTURES, ...segments), "utf8");
}

// --- happy path --------------------------------------------------------

test("a well-formed Named Data Set validates cleanly", () => {
  const source = readFixture("valid.yaml");
  const result = parseNamedDataSetFile(source, { filename: "changed-destination-basic" });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test("a secret_handle reference is accepted without carrying the secret value", () => {
  const result = validateNamedDataSet({
    schema: "dynamic-qa-data-v1",
    id: "handles-only",
    revision: 1,
    cases: [{ id: "a", fields: { apiToken: { secret_handle: "demo-api-token" } } }],
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("id must match the filename (the immutable data-set ID contract)", () => {
  const source = readFixture("valid.yaml");
  const result = parseNamedDataSetFile(source, { filename: "some-other-filename" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /does not match its filename/.test(e.message)));
});

// --- restricted-YAML rules inherited from #143 --------------------------

test("fail-closed: YAML alias is rejected", () => {
  const source = readFixture("invalid", "alias.yaml");
  assert.throws(() => parseNamedDataSetFile(source), YamlSyntaxError);
});

test("fail-closed: YAML anchor is rejected", () => {
  const source = readFixture("invalid", "anchor.yaml");
  assert.throws(() => parseNamedDataSetFile(source), YamlSyntaxError);
});

test("fail-closed: custom YAML tag is rejected", () => {
  const source = readFixture("invalid", "custom-tag.yaml");
  assert.throws(() => parseNamedDataSetFile(source), YamlSyntaxError);
});

test("fail-closed: duplicate YAML key is rejected", () => {
  const source = readFixture("invalid", "duplicate-key.yaml");
  assert.throws(() => parseNamedDataSetFile(source), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /duplicate key/i);
    return true;
  });
});

// --- schema-level fail-closed rules --------------------------------------

test("fail-closed: unknown top-level key is rejected", () => {
  const source = readFixture("invalid", "unknown-key.yaml");
  const result = parseNamedDataSetFile(source, { filename: "unknown-key-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unknown key "adapter_hint"/.test(e.message)));
});

test("fail-closed: unsupported schema version is rejected", () => {
  const source = readFixture("invalid", "unsupported-schema-version.yaml");
  const result = parseNamedDataSetFile(source, { filename: "unsupported-schema-version-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unsupported schema version/.test(e.message)));
});

test("fail-closed: field name must match the case.<field> substitution pattern", () => {
  const result = validateNamedDataSet({
    schema: "dynamic-qa-data-v1",
    id: "bad-field-name",
    revision: 1,
    cases: [{ id: "a", fields: { "not a valid name!": "irrelevant" } }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /must match/.test(e.message)));
});

test("fail-closed: a case field value that is an arbitrary mapping (not a secret_handle) is rejected", () => {
  const source = readFixture("invalid", "malformed-field-value.yaml");
  const result = parseNamedDataSetFile(source, { filename: "malformed-field-value-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /adapter configuration does not belong/.test(e.message)));
});

// --- secret-value rejection: one case per detector shape ----------------

test("fail-closed: a private-key header value is rejected", () => {
  const source = readFixture("invalid", "secret-private-key.yaml");
  const result = parseNamedDataSetFile(source, { filename: "secret-private-key-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /secret value forbidden.*private-key header/s.test(e.message)));
});

test("fail-closed: an AWS access key ID value is rejected", () => {
  const source = readFixture("invalid", "secret-aws-key.yaml");
  const result = parseNamedDataSetFile(source, { filename: "secret-aws-key-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /AWS access key ID/.test(e.message)));
});

test("fail-closed: a JWT-shaped value is rejected", () => {
  const source = readFixture("invalid", "secret-jwt.yaml");
  const result = parseNamedDataSetFile(source, { filename: "secret-jwt-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /JWT/.test(e.message) && /heuristic/.test(e.message)));
});

test("fail-closed: a Bearer-token-shaped value is rejected", () => {
  const source = readFixture("invalid", "secret-bearer.yaml");
  const result = parseNamedDataSetFile(source, { filename: "secret-bearer-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /Bearer/.test(e.message)));
});

test("fail-closed: a connection string with embedded credentials is rejected", () => {
  const source = readFixture("invalid", "secret-connection-string.yaml");
  const result = parseNamedDataSetFile(source, { filename: "secret-connection-string-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /embedded/.test(e.message)));
});

test("fail-closed: a high-entropy opaque value is rejected (heuristic)", () => {
  const source = readFixture("invalid", "secret-high-entropy.yaml");
  const result = parseNamedDataSetFile(source, { filename: "secret-high-entropy-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /high-entropy/.test(e.message) && /heuristic/.test(e.message)));
});

test("fail-closed: a secret_handle value that itself looks like a secret is rejected", () => {
  const source = readFixture("invalid", "forbidden-secret-handle-value.yaml");
  const result = parseNamedDataSetFile(source, { filename: "forbidden-secret-handle-value-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /secret_handle must name a handle, never contain the secret value/.test(e.message)));
});

// --- structural prohibitions: exact, not heuristic -----------------------

test("fail-closed: a URL-shaped value is rejected (exact scheme:// match)", () => {
  const source = readFixture("invalid", "forbidden-url-value.yaml");
  const result = parseNamedDataSetFile(source, { filename: "forbidden-url-value-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /URL value forbidden \(exact match/.test(e.message)));
});

test("fail-closed: a field named for a selector is rejected", () => {
  const source = readFixture("invalid", "forbidden-field-selector.yaml");
  const result = parseNamedDataSetFile(source, { filename: "forbidden-field-selector-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /reserved for a selector/.test(e.message)));
});

test("fail-closed: a field named for a command is rejected", () => {
  const source = readFixture("invalid", "forbidden-field-command.yaml");
  const result = parseNamedDataSetFile(source, { filename: "forbidden-field-command-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /reserved for a command/.test(e.message)));
});

test("fail-closed: a field named for adapter configuration is rejected", () => {
  const source = readFixture("invalid", "forbidden-field-adapter.yaml");
  const result = parseNamedDataSetFile(source, { filename: "forbidden-field-adapter-data-set" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /reserved for adapter configuration/.test(e.message)));
});
