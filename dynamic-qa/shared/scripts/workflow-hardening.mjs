// dynamic-qa/shared/scripts/workflow-hardening.mjs
//
// Ticket #155, completing #153's GitHub Actions hardening
// (github-actions-workflow.mjs's `checkWorkflowHardening`) with the two
// properties that ticket left as an explicit seam: action/reusable-workflow
// ALLOWLISTING (on top of #153's SHA-pinning) and a privileged lane's
// refusal to execute low-trust code or artifacts (DESIGN-dynamic-qa-spec.md
// §11, Trust Zone 4).
//
// This module does not re-implement anything #153 or #151 already built:
//   - action/reusable-workflow SHA-pin scanning reuses the same `uses:` line
//     shape #153's `checkWorkflowHardening` already scans (a fresh regex
//     here, not an exported one, because github-actions-workflow.mjs's own
//     regex is a private implementation detail of that module — see the
//     coordination note below).
//   - the actual "does a privileged lane accept this artifact" decision is
//     ALWAYS trust-zones.mjs's `checkPrivilegedLaneArtifact` (#151),
//     composed here, never duplicated.
//
// Coordination note (run brief, #154 also edits github-actions-workflow.mjs):
// this module imports ONLY the already-exported, unchanged constants
// `CHECKOUT_ACTION_SHA` / `SETUP_NODE_ACTION_SHA` from that module. No edit
// to github-actions-workflow.mjs was needed or made for this ticket.

import { CHECKOUT_ACTION_SHA, SETUP_NODE_ACTION_SHA } from "./github-actions-workflow.mjs";
import { checkPrivilegedLaneArtifact } from "./trust-zones.mjs";

function namedIssue(code, message) {
  return { code, message };
}

// --- 1. actions and reusable workflows: immutably pinned AND allowlisted ---
//
// #153 already proved every `uses:` reference is pinned to a full 40-hex
// commit SHA (checkWorkflowHardening's `actions.not-sha-pinned`). Pinning
// alone still lets an approver's own PR add a new, never-reviewed action —
// pinned to whatever SHA that PR chooses. The allowlist below is the
// second, independent property: only a name this bundle has explicitly
// approved (and only at the exact SHA that approval covers) may appear at
// all, in either an action step or a reusable-workflow call (both share the
// identical `uses: owner/repo[/path]@ref` YAML shape, so one scanner covers
// both).

export const DEFAULT_ALLOWLISTED_ACTIONS = Object.freeze({
  "actions/checkout": CHECKOUT_ACTION_SHA,
  "actions/setup-node": SETUP_NODE_ACTION_SHA,
});

const USES_REF_RE = /^\s*-?\s*uses:\s*([^\s#]+)/gm;
const FULL_SHA_SUFFIX_RE = /@([0-9a-f]{40})$/;

/**
 * Scans workflow YAML text for every `uses:` reference (action step or
 * reusable-workflow call) and names, individually:
 *   - `action.not-pinned` — no full 40-hex commit SHA suffix at all;
 *   - `action.not-allowlisted` — pinned, but the owner/repo identity is not
 *     in `allowlist`;
 *   - `action.sha-mismatch` — the identity IS allowlisted, but pinned to a
 *     different SHA than the allowlist approved (a changed pin needs a new,
 *     explicit approval, not silent acceptance).
 *
 * Returns `{ valid, errors }`, mirroring every other checker in this
 * bundle.
 */
export function checkActionAndReusableWorkflowAllowlist(yamlText, allowlist = DEFAULT_ALLOWLISTED_ACTIONS) {
  const issues = [];
  const text = typeof yamlText === "string" ? yamlText : "";

  for (const m of text.matchAll(USES_REF_RE)) {
    const ref = m[1];
    const shaMatch = FULL_SHA_SUFFIX_RE.exec(ref);
    FULL_SHA_SUFFIX_RE.lastIndex = 0;

    if (!shaMatch) {
      issues.push(namedIssue("action.not-pinned", `reference ${JSON.stringify(ref)} is not pinned to a full 40-character commit SHA`));
      continue;
    }

    const withoutSha = ref.slice(0, ref.length - shaMatch[0].length);
    const segments = withoutSha.split("/");
    const identity = segments.length >= 2 ? `${segments[0]}/${segments[1]}` : withoutSha;
    const allowedSha = allowlist[identity];

    if (!allowedSha) {
      issues.push(
        namedIssue(
          "action.not-allowlisted",
          `${JSON.stringify(identity)} (from ${JSON.stringify(ref)}) is not in the action/reusable-workflow allowlist — only explicitly approved identities may be used`,
        ),
      );
    } else if (allowedSha !== shaMatch[1]) {
      issues.push(
        namedIssue(
          "action.sha-mismatch",
          `${JSON.stringify(identity)} is pinned to ${JSON.stringify(shaMatch[1])} but the allowlist approved exactly ${JSON.stringify(allowedSha)} — a changed pin requires re-approval, not silent acceptance`,
        ),
      );
    }
  }

  return { valid: issues.length === 0, errors: issues };
}

// --- 2. a privileged lane refuses low-trust code and artifacts -------------

const LOW_TRUST_BRIDGE_TRIGGERS = Object.freeze(["pull_request_target", "workflow_run"]);

const JOB_BLOCK_START_RE = /^ {2}([A-Za-z0-9_.-]+):[ \t]*$/gm;

function splitJobs(yamlText) {
  const jobsIndex = yamlText.indexOf("\njobs:");
  if (jobsIndex === -1) return [];
  const jobsSection = yamlText.slice(jobsIndex);
  const starts = [...jobsSection.matchAll(JOB_BLOCK_START_RE)];
  const jobs = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : jobsSection.length;
    jobs.push({ name: starts[i][1], block: jobsSection.slice(start, end) });
  }
  return jobs;
}

/**
 * A job block is "privileged" when it (or the workflow around it) grants any
 * of the identities an unreviewed PR job must never receive — the same list
 * github-actions-workflow.mjs's checkWorkflowHardening already scans for on
 * the advisory lane, applied here per-job so a mixed workflow (an advisory
 * job alongside a privileged one) can be told apart.
 */
function isPrivilegedJobBlock(block) {
  return (
    /\$\{\{\s*secrets\./.test(block) ||
    /id-token:\s*write/.test(block) ||
    /^\s*environment:/m.test(block) ||
    /(?:contents|pull-requests|packages|actions):\s*write/.test(block)
  );
}

/**
 * Scans a whole workflow file's YAML text for the "pwn request" bridge
 * pattern: a privileged job (secrets/OIDC/protected-environment/write
 * identity) that either (a) runs in response to a trigger that hands an
 * external contributor control over the executed ref/code
 * (`pull_request_target`, `workflow_run`), or (b) downloads an artifact
 * without any visible reference to Result Envelope validation — i.e. it
 * would consume a raw low-trust artifact rather than the one thing a
 * privileged lane may accept (result-envelope.mjs, gated by
 * checkPrivilegedLaneArtifact).
 *
 * This is a workflow-shape detector; the authoritative artifact-kind gate
 * remains `checkPrivilegedLaneArtifact` (see
 * `assertPrivilegedJobRefusesArtifact` below) — this function exists
 * because a real workflow YAML never spells "kind: code" anywhere, so the
 * GitHub-Actions-specific bridge shape needs its own named detection.
 */
export function checkPrivilegedLaneRefusesLowTrustBridge(yamlText) {
  const issues = [];
  const text = typeof yamlText === "string" ? yamlText : "";

  const presentBridgeTriggers = LOW_TRUST_BRIDGE_TRIGGERS.filter((t) => new RegExp(`^\\s*${t}:`, "m").test(text));
  const jobs = splitJobs(text);
  const privilegedJobs = jobs.filter((j) => isPrivilegedJobBlock(j.block));

  if (presentBridgeTriggers.length > 0 && privilegedJobs.length > 0) {
    issues.push(
      namedIssue(
        "privileged-lane.low-trust-trigger-with-privileged-identity",
        `the workflow declares ${JSON.stringify(presentBridgeTriggers)} alongside privileged job(s) ${JSON.stringify(privilegedJobs.map((j) => j.name))} — a privileged identity must never run in response to a low-trust event that lets external content control the executed ref/code (the classic "pwn request" bridge)`,
      ),
    );
  }

  for (const job of privilegedJobs) {
    if (/actions\/download-artifact@/.test(job.block) && !/result-envelope/i.test(job.block)) {
      issues.push(
        namedIssue(
          "privileged-lane.downloads-artifact-without-envelope-validation",
          `privileged job ${JSON.stringify(job.name)} downloads an artifact with no visible reference to Result Envelope validation — a privileged lane may only accept a validated Result Envelope or an independent recompute, never a raw low-trust artifact`,
        ),
      );
    }
  }

  return { valid: issues.length === 0, errors: issues };
}

/**
 * The direct, non-textual form of "a privileged lane refuses low-trust code
 * and artifacts": composes trust-zones.mjs's `checkPrivilegedLaneArtifact`
 * (#151) — the sole gate, never re-implemented — against a caller-supplied
 * artifact descriptor, keyed only on whether the consuming job is
 * privileged. Use this where a caller already has a structured artifact
 * descriptor (a Result Envelope wrapper, a code bundle, a cache handle)
 * rather than raw workflow YAML text.
 */
export function assertPrivilegedJobRefusesArtifact(isPrivilegedJob, artifact) {
  return checkPrivilegedLaneArtifact(isPrivilegedJob ? "privileged-publication" : "low-trust-ci", artifact);
}
