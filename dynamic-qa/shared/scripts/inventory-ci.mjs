// dynamic-qa/shared/scripts/inventory-ci.mjs
//
// Setup Inventory stage 2 scanner: CI triggers, runners, services,
// environments, merge queues, checks, artifacts, and secret NAMES.
//
// This is intentionally NOT a general YAML parser. It extracts a small,
// well-known set of GitHub Actions workflow shapes with line-oriented
// pattern matching, which is enough to produce sourced facts without adding
// a YAML library dependency (the bundle's deterministic core has zero
// third-party dependencies — see dynamic-qa/DECISIONS.md and the run brief).
// A line this scanner cannot confidently classify contributes nothing,
// rather than a guessed fact — silence, not a wrong answer.
//
// SECRET SAFETY: this module only ever captures the NAME inside a
// `secrets.<NAME>` or `secrets["<NAME>"]` reference. It never reads, stores,
// or echoes an actual secret value — GitHub Actions workflow YAML has no
// syntax that would even embed one (secret values live outside the repo, in
// provider configuration); this scanner simply never introduces a `value`
// field on a secret-name fact, and fact.mjs's makeFact/validateFact refuse
// to construct or validate one that tries to.

import { walkFiles, readTextFile } from "./repo-walk.mjs";
import { makeFact } from "./fact.mjs";

const WORKFLOW_DIR_PATTERN = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const SECRET_REF_PATTERNS = [/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g, /secrets\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/g];

function findWorkflowFiles(repoRoot) {
  return walkFiles(repoRoot).filter((p) => WORKFLOW_DIR_PATTERN.test(p));
}

function extractTriggers(text) {
  // `on:` can be a bare key, a list, or a map. We only need the trigger
  // NAMES, so pull recognized event keywords appearing after `on:` up to
  // the next top-level (non-indented) key.
  const onMatch = text.match(/^on:\s*(.*)$/m);
  if (!onMatch) return [];
  const events = new Set();
  const KNOWN = ["push", "pull_request", "workflow_dispatch", "schedule", "merge_group", "release", "repository_dispatch"];
  // Look at the `on:` line itself (may hold a bare event or a flow-list).
  for (const kw of KNOWN) {
    if (new RegExp(`(^|[\\s\\[,])${kw}(\\s*:|\\s*,|\\s*\\]|\\s*$)`).test(onMatch[1])) events.add(kw);
  }
  // Then the indented block that follows `on:` (block-mapping form).
  const lines = text.split("\n");
  const onIndex = lines.findIndex((l) => /^on:\s*$/.test(l) || /^on:/.test(l));
  if (onIndex !== -1) {
    for (let i = onIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\S/.test(line)) break; // back to a top-level key: block ended
      const m = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (m && KNOWN.includes(m[1])) events.add(m[1]);
    }
  }
  return [...events];
}

function extractAll(text, regex) {
  const out = new Set();
  let m;
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

// extractBareBlockKeys(text, "services") -> string names of the direct
// children of every `services:` (or `jobs:`, etc.) bare-key block in the
// document, computed from actual line indentation rather than a fixed
// column count — so it stays correct regardless of how deeply the block is
// nested (workflow-level vs. job-level `services:`), and regardless of
// blank lines inside the block. A "direct child" is a line at exactly the
// shallowest indentation found under the block header that is itself a bare
// `key:` line (a name introducing a nested mapping, not a `key: value`
// line) — that is what distinguishes a service/job NAME from one of its
// settings (e.g. `image:`, `runs-on:`) one level deeper.
function extractBareBlockKeys(text, keyName) {
  const lines = text.split("\n");
  const headerRe = new RegExp(`^(\\s*)${keyName}:\\s*$`);
  const names = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(headerRe);
    if (!header) continue;
    const parentIndent = header[1].length;
    let childIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") continue; // blank lines never end or count toward the block
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= parentIndent) break; // back to the header's own level or shallower: block ended
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue; // a deeper setting of a child, not a child itself
      const bareKey = line.match(/^\s*([A-Za-z0-9_.\-]+):\s*$/);
      if (bareKey) names.push(bareKey[1]);
    }
  }
  return names;
}

// scanCiWorkflows(repoRoot) -> Fact[]
//
// One "ci-provider" fact when any workflow file exists, plus per-workflow
// trigger/runner/service/environment/merge-queue/check/artifact/secret-name
// facts. All "observed": every value here was read directly from a workflow
// file that was itself opened.
export function scanCiWorkflows(repoRoot) {
  const facts = [];
  const workflowFiles = findWorkflowFiles(repoRoot);
  if (workflowFiles.length === 0) return facts;

  facts.push(
    makeFact({
      id: "ci-provider:github-actions",
      category: "ci-provider",
      description: `${workflowFiles.length} GitHub Actions workflow file(s) found under .github/workflows/`,
      provenance: "observed",
      evidence: workflowFiles[0],
    })
  );

  const seenTriggers = new Set();
  const seenRunners = new Set();
  const seenServices = new Set();
  const seenEnvironments = new Set();
  const seenChecks = new Set();
  const seenArtifacts = new Set();
  const seenSecrets = new Set();
  let mergeQueueSeen = false;

  for (const relPath of workflowFiles) {
    const text = readTextFile(repoRoot, relPath);
    if (text === null) continue;

    for (const trigger of extractTriggers(text)) {
      if (trigger === "merge_group") {
        if (!mergeQueueSeen) {
          mergeQueueSeen = true;
          facts.push(
            makeFact({
              id: "ci-merge-queue:enabled",
              category: "ci-merge-queue",
              description: "a merge_group trigger was found — this repository uses a merge queue",
              provenance: "observed",
              evidence: relPath,
            })
          );
        }
        continue;
      }
      const id = `ci-trigger:${trigger}`;
      if (seenTriggers.has(id)) continue;
      seenTriggers.add(id);
      facts.push(
        makeFact({ id, category: "ci-trigger", description: `'${trigger}' trigger found`, provenance: "observed", evidence: relPath })
      );
    }

    for (const runner of extractAll(text, /runs-on:\s*([A-Za-z0-9_.\-]+)/g)) {
      const id = `ci-runner:${runner}`;
      if (seenRunners.has(id)) continue;
      seenRunners.add(id);
      facts.push(
        makeFact({ id, category: "ci-runner", description: `runs-on: ${runner}`, provenance: "observed", evidence: relPath })
      );
    }

    for (const serviceName of extractBareBlockKeys(text, "services")) {
      const id = `ci-service:${serviceName}`;
      if (seenServices.has(id)) continue;
      seenServices.add(id);
      facts.push(
        makeFact({ id, category: "ci-service", description: `service '${serviceName}' declared`, provenance: "observed", evidence: relPath })
      );
    }

    for (const env of extractAll(text, /^\s*environment:\s*([A-Za-z0-9_.\-]+)/gm)) {
      const id = `ci-environment:${env}`;
      if (seenEnvironments.has(id)) continue;
      seenEnvironments.add(id);
      facts.push(
        makeFact({ id, category: "ci-environment", description: `environment: ${env}`, provenance: "observed", evidence: relPath })
      );
    }

    if (/uses:\s*actions\/upload-artifact/.test(text)) {
      const id = `ci-artifact:upload-artifact:${relPath}`;
      if (!seenArtifacts.has(id)) {
        seenArtifacts.add(id);
        facts.push(
          makeFact({
            id,
            category: "ci-artifact",
            description: "actions/upload-artifact step found",
            provenance: "observed",
            evidence: relPath,
          })
        );
      }
    }

    // Check names: the workflow's own top-level `name:` (column 0, the
    // display name a required-check policy would reference), plus each job
    // id under `jobs:` (a job's key is what GitHub reports as its check
    // context when the job carries no explicit `name:`).
    const workflowName = text.match(/^name:\s*(.+)$/m);
    if (workflowName) {
      const trimmed = workflowName[1].trim();
      const id = `ci-check:${trimmed}`;
      if (trimmed && !seenChecks.has(id)) {
        seenChecks.add(id);
        facts.push(
          makeFact({ id, category: "ci-check", description: `workflow name: ${trimmed}`, provenance: "observed", evidence: relPath })
        );
      }
    }
    for (const jobId of extractBareBlockKeys(text, "jobs")) {
      const id = `ci-check:${jobId}`;
      if (seenChecks.has(id)) continue;
      seenChecks.add(id);
      facts.push(makeFact({ id, category: "ci-check", description: `job id: ${jobId}`, provenance: "observed", evidence: relPath }));
    }

    // Secret NAMES only — see the module comment. Never a value.
    for (const pattern of SECRET_REF_PATTERNS) {
      for (const secretName of extractAll(text, pattern)) {
        const id = `secret-name:${secretName}`;
        if (seenSecrets.has(id)) continue;
        seenSecrets.add(id);
        facts.push(
          makeFact({
            id,
            category: "secret-name",
            description: `secret '${secretName}' is referenced by name; its value was never read`,
            provenance: "observed",
            evidence: relPath,
            secretName,
          })
        );
      }
    }
  }

  return facts;
}
