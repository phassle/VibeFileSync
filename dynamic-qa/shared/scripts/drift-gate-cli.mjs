#!/usr/bin/env node
// dynamic-qa/shared/scripts/drift-gate-cli.mjs
//
// THE standalone CI entry point for the deterministic drift gate (#148):
//
//   node dynamic-qa/shared/scripts/drift-gate-cli.mjs [repository-root]
//
// Run this before test execution. It calls no model, no browser agent, and
// makes no network request — it only reads files already checked into the
// repository (`qa/provenance.json`, `qa/flows/*.yaml`, `qa/data/*.yaml`,
// `qa/schemas/*.json`, `qa/execution-profiles/*.yaml`, plus the recorded
// harness config/lockfile and output paths) and compares digests. Exits `0`
// when every active Binding is current and no retired flow still carries a
// provenance record; exits `1` and prints an exact reason per stale or
// missing Binding otherwise. A repository with no `qa/` directory at all
// exits `0` — there is nothing yet to enforce.
//
// This file intentionally does the filesystem/CLI plumbing only. Every
// actual freshness decision is `drift-gate.mjs`'s `evaluateBindingDrift` /
// `evaluatePortfolioDrift` (Tier 1 tested there with in-memory fixtures, no
// filesystem involved) — this script is not itself unit-tested; it is
// exercised by `dynamic-qa/tests/smoke.sh` / the acceptance harness as the
// thing a real CI job actually invokes.
//
// Directory layout followed (DESIGN-dynamic-qa-spec.md §5, the "Customer-
// repository artifacts" tree `qa-setup` creates):
//   qa/provenance.json
//   qa/flows/<flow-id>.yaml
//   qa/data/<data-set-id>.yaml
//   qa/schemas/dynamic-qa-flow-v1.schema.json
//   qa/schemas/dynamic-qa-data-v1.schema.json
//   qa/execution-profiles/<profile-id>.yaml

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";
import { parseFlowDefinitionFile } from "./flow-definition.mjs";
import { validateProvenanceManifest } from "./provenance.mjs";
import { contentDigest } from "./canonical-digest.mjs";
import { evaluateBindingDrift, evaluatePortfolioDrift } from "./drift-gate.mjs";

// Raw JSON read — throws on missing file or malformed JSON. Callers below
// always wrap this (or replicate its try/catch) so a corrupt file becomes
// an explicit `undefined` digest for drift-gate.mjs to fail closed on,
// never an uncaught crash that skips the check entirely.
export function readJSON(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function schemaDigestOf(schemasDir, filename) {
  const p = path.join(schemasDir, filename);
  if (!existsSync(p)) return undefined;
  try {
    return contentDigest(readJSON(p));
  } catch {
    return undefined;
  }
}

export function digestPathList(list, repoRoot) {
  return (list ?? []).map(({ path: relPath }) => {
    const abs = path.join(repoRoot, relPath);
    if (!existsSync(abs)) return { path: relPath, digest: undefined };
    try {
      return { path: relPath, digest: contentDigest(readFileSync(abs, "utf8")) };
    } catch {
      // Unreadable (e.g. a permissions error, or a directory at that path)
      // is reported the same way as missing: an explicit undefined digest,
      // never an uncaught crash.
      return { path: relPath, digest: undefined };
    }
  });
}

export function resolveDataSetDigest(id, dataSetsDir) {
  const filePath = path.join(dataSetsDir, `${id}.yaml`);
  if (!existsSync(filePath)) return { id, digest: undefined };
  try {
    const data = parseRestrictedYAML(readFileSync(filePath, "utf8"), { filename: id });
    return { id, digest: contentDigest(data) };
  } catch {
    return { id, digest: undefined };
  }
}

export function executionProfileDigest(profileId, profilesDir) {
  if (!profileId) return undefined;
  const filePath = path.join(profilesDir, `${profileId}.yaml`);
  if (!existsSync(filePath)) return undefined;
  try {
    const data = parseRestrictedYAML(readFileSync(filePath, "utf8"), { filename: profileId });
    return contentDigest(data);
  } catch {
    return undefined;
  }
}

function loadFlows(flowsDir) {
  if (!existsSync(flowsDir)) return [];
  return readdirSync(flowsDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const filename = f.slice(0, -".yaml".length);
      const filePath = path.join(flowsDir, f);
      const source = readFileSync(filePath, "utf8");
      const validation = parseFlowDefinitionFile(source, { filename });
      const data = parseRestrictedYAML(source, { filename });
      return { filename, filePath, valid: validation.valid, errors: validation.errors, data };
    });
}

export function runDriftGate(repoRoot) {
  const qaDir = path.join(repoRoot, "qa");
  const provenancePath = path.join(qaDir, "provenance.json");
  const flowsDir = path.join(qaDir, "flows");
  const dataSetsDir = path.join(qaDir, "data");
  const schemasDir = path.join(qaDir, "schemas");
  const profilesDir = path.join(qaDir, "execution-profiles");

  if (!existsSync(qaDir)) {
    return { ok: true, messages: ["no qa/ directory present — nothing to enforce yet"] };
  }

  let manifest = null;
  if (existsSync(provenancePath)) {
    try {
      manifest = readJSON(provenancePath);
    } catch (err) {
      return { ok: false, messages: [`qa/provenance.json could not be parsed as JSON: ${err.message}`] };
    }
    const manifestValidation = validateProvenanceManifest(manifest);
    if (!manifestValidation.valid) {
      return {
        ok: false,
        messages: [
          "qa/provenance.json failed schema validation:",
          ...manifestValidation.errors.map((e) => `  ${e.message}`),
        ],
      };
    }
  }

  const flows = loadFlows(flowsDir);
  const invalidFlows = flows.filter((f) => !f.valid);
  if (invalidFlows.length > 0) {
    return {
      ok: false,
      messages: invalidFlows.flatMap((f) => [
        `${f.filePath} failed Flow Definition validation (incompatible/unsupported schema mandates regeneration):`,
        ...f.errors.map((e) => `  ${e.message}`),
      ]),
    };
  }

  const activeFlows = flows.filter((f) => f.data.state === "active");
  const retiredFlowIds = flows.filter((f) => f.data.state === "retired").map((f) => f.data.id);

  const schemaDigests = {
    flow: schemaDigestOf(schemasDir, "dynamic-qa-flow-v1.schema.json"),
    data: schemaDigestOf(schemasDir, "dynamic-qa-data-v1.schema.json"),
  };

  const bindings = activeFlows.map((f) => {
    const flowData = f.data;
    const record = (manifest?.bindings ?? []).find((b) => b.flowId === flowData.id);
    const dataSetDigests = (record?.dataSets ?? flowData.data_sets ?? []).map((entry) =>
      resolveDataSetDigest(typeof entry === "string" ? entry : entry.id, dataSetsDir),
    );
    const harnessInputDigests = record
      ? {
          configPaths: digestPathList(record.harnessInputs?.configPaths, repoRoot),
          lockfilePaths: digestPathList(record.harnessInputs?.lockfilePaths, repoRoot),
        }
      : { configPaths: [], lockfilePaths: [] };
    const outputDigests = record ? digestPathList(record.outputs, repoRoot) : [];

    return {
      flowId: flowData.id,
      flowRevision: flowData.revision,
      flowDigest: contentDigest(flowData),
      dataSetDigests,
      schemaDigests,
      harnessInputDigests,
      outputDigests,
      executionProfileDigest: record
        ? executionProfileDigest(record.executionProfile?.id, profilesDir)
        : undefined,
    };
  });

  const portfolio = evaluatePortfolioDrift({ manifest, bindings, retiredFlowIds });

  const messages = [];
  for (const result of portfolio.results) {
    if (result.freshness === "current") {
      messages.push(`current: ${result.flowId}`);
    } else {
      messages.push(`${result.freshness}: ${result.flowId}`);
      for (const reason of result.reasons) messages.push(`  [${reason.code}] ${reason.message}`);
    }
  }
  for (const cleanup of portfolio.retiredCleanup) {
    messages.push(`cleanup-needed: ${cleanup.flowId}`);
    messages.push(`  [${cleanup.code}] ${cleanup.message}`);
  }
  if (activeFlows.length === 0 && portfolio.retiredCleanup.length === 0) {
    messages.push("no active Bindings found — nothing to enforce yet");
  }

  return { ok: portfolio.ok, messages };
}

function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
  const { ok, messages } = runDriftGate(repoRoot);
  for (const m of messages) console.log(m);
  process.exit(ok ? 0 : 1);
}
