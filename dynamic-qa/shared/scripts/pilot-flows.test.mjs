// dynamic-qa/shared/scripts/pilot-flows.test.mjs
//
// Tier 1 coverage for the five VibeFileSync pilot Flow Definitions (ticket
// #172, dynamic-qa/pilot/vibefilesync/flows/*.yaml). These are real
// dynamic-qa-flow-v1 documents, not a fixture invented for this test: they
// validate through the exact same parseFlowDefinitionFile/validateBoundaries/
// validateBoundaryPolicy path a customer repository's own flows go through.
//
// What this file asserts, per the ticket's acceptance criteria:
//   - all five parse and validate cleanly against flow-definition.mjs
//   - each has a stable content digest (round-tripping through
//     canonical-digest.mjs's canonicalize/contentDigest, matching the
//     "digests are computed over the canonical validated data model, not
//     over formatting" contract)
//   - each declares state: deferred (never active — activation needs the
//     real pilot, per run brief decision 3)
//   - each links to at least one real, resolvable-shaped originating ticket URI
//   - boundaries pass the full shape+policy check (boundary-policy.mjs)
//   - covers exactly the five named flows, no more, no fewer

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseFlowDefinitionFile } from "./flow-definition.mjs";
import { validateBoundariesFull } from "./boundary-policy.mjs";
import { contentDigest } from "./canonical-digest.mjs";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = path.join(HERE, "..", "..", "pilot", "vibefilesync", "flows");

const EXPECTED_FLOW_IDS = [
  "update-replacement-retention",
  "mirror-destination-only-retention",
  "verification-failure-preservation",
  "unmounted-source-abort",
  "interrupted-publish-convergence",
];

function readFlowSource(id) {
  return readFileSync(path.join(FLOWS_DIR, `${id}.yaml`), "utf8");
}

function loadFlow(id) {
  return parseFlowDefinitionFile(readFlowSource(id), { filename: id });
}

function parseFlowRaw(id) {
  return parseRestrictedYAML(readFlowSource(id), { filename: id });
}

test("all five pilot flows exist and validate cleanly", () => {
  for (const id of EXPECTED_FLOW_IDS) {
    const { valid, errors } = loadFlow(id);
    assert.equal(valid, true, `${id}: ${JSON.stringify(errors)}`);
  }
});

test("exactly five pilot flow files exist (no more, no fewer)", () => {
  const files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith(".yaml"));
  assert.equal(files.length, EXPECTED_FLOW_IDS.length);
  const idsFromFiles = files.map((f) => f.replace(/\.yaml$/, "")).sort();
  assert.deepEqual(idsFromFiles, [...EXPECTED_FLOW_IDS].sort());
});

test("each pilot flow declares state: deferred, never active", () => {
  for (const id of EXPECTED_FLOW_IDS) {
    const data = parseFlowRaw(id);
    assert.equal(data.state, "deferred", `${id} must be deferred, not active, until the real pilot activates it`);
  }
});

test("each pilot flow links at least one real-shaped originating ticket URI", () => {
  for (const id of EXPECTED_FLOW_IDS) {
    const data = parseFlowRaw(id);
    assert.ok(Array.isArray(data.origin.tickets) && data.origin.tickets.length >= 1, `${id} must name at least one origin ticket`);
    for (const ticket of data.origin.tickets) {
      assert.match(ticket, /^https:\/\/github\.com\/phassle\/VibeFileSync\/issues\/\d+$/, `${id}: ${ticket}`);
    }
  }
});

test("each pilot flow's boundaries pass full shape and policy checks", () => {
  for (const id of EXPECTED_FLOW_IDS) {
    const data = parseFlowRaw(id);
    const issues = validateBoundariesFull(data.boundaries, ["boundaries"]);
    assert.deepEqual(issues, [], `${id}: ${JSON.stringify(issues)}`);
  }
});

test("each pilot flow's content digest is stable across repeated parses, and distinct across flows", () => {
  const digests = new Map();
  for (const id of EXPECTED_FLOW_IDS) {
    const source = readFlowSource(id);
    const digestA = contentDigest(parseRestrictedYAML(source, { filename: id }));
    const digestB = contentDigest(parseRestrictedYAML(source, { filename: id }));
    assert.equal(digestA, digestB, `${id}: two parses of the identical source must digest identically`);
    digests.set(id, digestA);
  }
  const values = [...digests.values()];
  assert.equal(new Set(values).size, values.length, "no two pilot flows may share a content digest");
});

test("a flow's digest is unchanged by reformatting (comments, blank lines) and changes with real content", () => {
  const id = "update-replacement-retention";
  const source = readFlowSource(id);
  const original = parseRestrictedYAML(source, { filename: id });

  const reformatted = source.replace("# Pilot Flow Definition", "#\n# Pilot Flow Definition");
  const reparsed = parseRestrictedYAML(reformatted, { filename: id });
  assert.equal(contentDigest(original), contentDigest(reparsed), "a comment-only change must not move the digest");

  const mutated = { ...original, criticality: "low" };
  assert.notEqual(contentDigest(original), contentDigest(mutated), "a real semantic change must move the digest");
});
