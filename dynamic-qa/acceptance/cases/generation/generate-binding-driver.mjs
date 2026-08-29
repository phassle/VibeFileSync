// dynamic-qa/acceptance/cases/generation/generate-binding-driver.mjs
//
// Tier 2 driver for the generation cases in this directory. This is real
// code exercising the REAL deterministic core modules under
// dynamic-qa/shared/scripts/ (preflight, binding-verification, provenance)
// against a fixture repository — never a `transcript_play` replay — so a
// passing case here proves the actual core, not a scripted stand-in for it.
//
// The one part this driver stands in for is the genuinely generative step:
// producing framework-specific candidate code is qa-generate/SKILL.md's
// job, driven by a coding agent, and is out of scope for a deterministic
// core module. This driver supplies one small, hand-written, already-clean
// candidate for the fixture's "checkout-completes" flow instead — the exact
// shape binding-verification.mjs is designed to check regardless of who or
// what authored it.
//
// Reads FIXTURE_REPO, FLOW_ID, QA_APPROVED, TECH_APPROVED from the
// environment (set by the calling case's case_setup/case_run). Writes
// `STOP:<reason>` or `WROTE:<relative-path>` lines to stdout, one per line,
// which the calling case's case_run translates into the same
// stop_reason=/artifact_written= log lines transcript_play produces, so
// case_assert can use the exact same assertion vocabulary either way.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(HERE, "..", "..", "..", "shared", "scripts");

const { runGenerationPreflight } = await import(path.join(CORE, "preflight.mjs"));
const { verifyCandidateBinding } = await import(path.join(CORE, "binding-verification.mjs"));
const { buildBindingRecord, insertOrUpdateBindingRecord, serializeProvenanceManifest } = await import(
  path.join(CORE, "provenance.mjs")
);
const { contentDigest } = await import(path.join(CORE, "canonical-digest.mjs"));

const repo = process.env.FIXTURE_REPO;
const flowId = process.env.FLOW_ID;
const qaApproved = process.env.QA_APPROVED === "true";
const techApproved = process.env.TECH_APPROVED === "true";

const flowSource = readFileSync(path.join(repo, "qa", "flows", `${flowId}.yaml`), "utf8");
const dataSetsDir = path.join(repo, "qa", "data");
const testDir = "tests/e2e";
const testFilePath = `${testDir}/${flowId}.spec.mjs`;

const preflight = runGenerationPreflight({
  flowSource,
  flowFilename: flowId,
  dataSetsDir,
  approvals: { qaOwner: qaApproved, technicalOwner: techApproved },
  executionProfileId: "pilot-profile",
  sourceCommit: "b".repeat(40),
  harness: { framework: "node:test", testDir, command: `node --test ${testDir}` },
  existingProvenanceManifest: null,
});

if (!preflight.ready) {
  console.log(`STOP:${preflight.reason}`);
  process.exit(0);
}

const candidateSource = `// generated for Flow generation-happy-path-style fixture "checkout-completes"
// step: then-checkout-completes, outcome: checkout-result-shown
import test from "node:test";
import assert from "node:assert/strict";

test("checkout completes and shows the result", () => {
  const result = "done"; // stands in for driving the fixture's owned boundary
  assert.strictEqual(result, "done");
});
`;

const verification = verifyCandidateBinding({
  flowData: preflight.flowData,
  assertions: [{ stepId: "then-checkout-completes", outcomeId: "checkout-result-shown", location: `${testFilePath}:6` }],
  files: [{ path: testFilePath, content: candidateSource }],
});

if (!verification.accepted) {
  console.log(`STOP:generation-verification-failed:${verification.reasons.join(",")}`);
  process.exit(0);
}

mkdirSync(path.join(repo, testDir), { recursive: true });
writeFileSync(path.join(repo, testFilePath), candidateSource);
console.log(`WROTE:${testFilePath}`);

const record = buildBindingRecord({
  flowData: preflight.flowData,
  dataSets: preflight.dataSets,
  schemaDigests: { flow: "sha256:fixture-flow-schema", data: "sha256:fixture-data-schema" },
  sourceCommit: "b".repeat(40),
  generator: {
    identity: "generated",
    bundleVersion: "0.0.1-acceptance-fixture",
    contentDigest: "sha256:fixture-generator-digest",
    harness: "acceptance-fixture-driver",
  },
  framework: { name: "node:test", version: process.version },
  harnessInputs: { configPaths: [], lockfilePaths: [] },
  outputs: [{ path: testFilePath, digest: contentDigest(candidateSource) }],
  impactPaths: ["src/checkout/**"],
  enforcementLane: "advisory",
  executionProfile: { id: "pilot-profile" },
});

const manifest = insertOrUpdateBindingRecord(null, record, { generatedAt: "2026-01-01T00:00:00Z" });
mkdirSync(path.join(repo, "qa"), { recursive: true });
writeFileSync(path.join(repo, "qa", "provenance.json"), serializeProvenanceManifest(manifest));
console.log("WROTE:qa/provenance.json");

console.log("STOP:generation-complete");
