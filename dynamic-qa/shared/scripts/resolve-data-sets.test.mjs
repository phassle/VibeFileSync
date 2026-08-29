// dynamic-qa/shared/scripts/resolve-data-sets.test.mjs
//
// Tier 1 coverage for cross-file Named Data Set resolution
// (resolve-data-sets.mjs). #143 deliberately left cross-file existence
// unchecked; this proves a dangling reference fails closed, a valid
// reference resolves, and an existing-but-invalid data set file surfaces
// its own validation errors through the resolving Flow's path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveDataSetFile, resolveFlowDataSets } from "./resolve-data-sets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_SETS_DIR = path.join(HERE, "fixtures", "data-sets", "resolution-dir");

test("resolveDataSetFile finds and validates an existing, valid data set", () => {
  const result = resolveDataSetFile("existing-set", { dataSetsDir: DATA_SETS_DIR });
  assert.equal(result.found, true);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("fail-closed: resolveDataSetFile reports a dangling reference for a missing file", () => {
  const result = resolveDataSetFile("does-not-exist", { dataSetsDir: DATA_SETS_DIR });
  assert.equal(result.found, false);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /not found/.test(e.message)));
});

test("fail-closed: resolveDataSetFile surfaces the referenced file's own validation errors", () => {
  const result = resolveDataSetFile("broken-set", { dataSetsDir: DATA_SETS_DIR });
  assert.equal(result.found, true);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /reserved for a selector/.test(e.message)));
});

test("resolveFlowDataSets resolves every reference on a Flow to real, valid data sets", () => {
  const flowData = { data_sets: ["existing-set"] };
  const result = resolveFlowDataSets(flowData, { dataSetsDir: DATA_SETS_DIR });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("fail-closed: resolveFlowDataSets rejects a dangling data_sets reference", () => {
  const flowData = { data_sets: ["existing-set", "missing-data-set"] };
  const result = resolveFlowDataSets(flowData, { dataSetsDir: DATA_SETS_DIR });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /dangling data_sets reference "missing-data-set"/.test(e.message)));
  assert.ok(result.errors.some((e) => e.path[0] === "data_sets" && e.path[1] === 1));
});

test("fail-closed: resolveFlowDataSets rejects a reference that resolves to an invalid Named Data Set", () => {
  const flowData = { data_sets: ["broken-set"] };
  const result = resolveFlowDataSets(flowData, { dataSetsDir: DATA_SETS_DIR });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /resolves to an invalid Named Data Set/.test(e.message)));
});

test("fail-closed: resolveFlowDataSets still reports a malformed data_sets shape (reused, not forked)", () => {
  const flowData = { data_sets: ["Not-A-Valid-Id"] };
  const result = resolveFlowDataSets(flowData, { dataSetsDir: DATA_SETS_DIR });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /semantic Named Data Set id/.test(e.message)));
});
