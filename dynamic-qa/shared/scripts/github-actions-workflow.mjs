// dynamic-qa/shared/scripts/github-actions-workflow.mjs
//
// Ticket #153: GitHub Actions is dynamic-qa's first named provider adapter
// (DESIGN-dynamic-qa-spec.md §9's provider-neutral contract point 3: "render
// advisory, required, and quarantine lanes without changing policy itself").
// This module is the pure rendering half: it turns a small caller-supplied
// descriptor into workflow YAML text for the advisory pull-request lane.
// github-actions-adapter.mjs (same ticket) is the adapter-contract half that
// decides *whether* to render (Capability Gate, runtime evidence) and
// resolves provider run references; this module never makes that decision,
// it only renders and it only verifies its own output.
//
// Brownfield Bindings enter CI advisory during burn-in (spec §8) so a new
// suite cannot destabilise the existing merge gate. The rendered job uses
// `continue-on-error: true` at the JOB level — GitHub Actions' own
// documented mechanism for "a job may fail internally, but the workflow run
// (and therefore any branch-protection required-check keyed on it) never
// fails because of it" — never a required-check policy change, never a
// silent test skip.
//
// No generic YAML serializer is used (per the run brief's deterministic-core
// decision: no third-party dependency, restricted subset only). The shape
// this module produces is small and fixed, so a plain template is simpler
// and more auditable than a general serializer would be; there is nothing
// here for a generic serializer to get "more right" than a template already
// does.
//
// Hardening is NOT merely "the renderer only knows how to write it safely" —
// checkWorkflowHardening below is a separate, reusable detector that scans
// arbitrary rendered/mutated workflow YAML text and names, individually,
// which hardening property (if any) is missing. It exists for two reasons:
// it is this ticket's own Tier 1 proof that each hardening property is
// independently detected when violated (not just "the happy path looks
// fine"), and it is the concrete implementation of provider-adapter contract
// point 7 ("validate that generated configuration enforces the Execution
// Profile") — a caller runs it against whatever text is about to be written
// to the repository, whether this module produced it or not.
//
// Node-runtime caveat (run brief, explicit): a customer's self-hosted runner
// is not guaranteed to ship Node the way a developer machine or a
// GitHub-hosted runner is. This renderer never assumes an ambient `node` on
// PATH — it always renders an explicit `actions/setup-node` step that
// installs a pinned Node version, so the runtime is a declared, visible part
// of the generated configuration rather than a silent assumption. Deciding
// *whether* the run may proceed at all when the adapter cannot even prove a
// runtime capability is github-actions-adapter.mjs's Safety Blocker, not
// this module's job — see that module for "a missing Node runtime is a
// Safety Blocker and a deferred flow, never a silent skip."

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

// --- immutable action pins -------------------------------------------------
//
// Full 40-character commit SHAs, never a floating tag (`@v4`) — a tag can be
// moved by its owner; a commit SHA cannot. This module has zero network
// access (the deterministic core's hard invariant) and therefore cannot
// itself resolve "the current commit behind tag v4.x" — the SHAs below are
// the pins shipped with this ticket. ASSUMPTION a later implementer/operator
// must re-verify before this generated workflow is ever enabled for a real
// repository: confirm each SHA still corresponds to the intended upstream
// release before first real rollout (the pilot, #171-175, is deliberately
// not being run yet, so nothing here has executed against real CI).
export const CHECKOUT_ACTION_SHA = "692973e3d937129bcbf40652eb9f2f61becf3332"; // actions/checkout, tagged v4.1.7 at authoring time
export const SETUP_NODE_ACTION_SHA = "1e60f620b9541d16bece96c5465dc8ee9832be0a"; // actions/setup-node, tagged v4.0.3 at authoring time
export const CHECKOUT_ACTION_REF = `actions/checkout@${CHECKOUT_ACTION_SHA}`;
export const SETUP_NODE_ACTION_REF = `actions/setup-node@${SETUP_NODE_ACTION_SHA}`;

// --- safe PR events ---------------------------------------------------------
//
// `pull_request` runs with the fork PR's own restricted, read-only
// GITHUB_TOKEN and no repository secrets. `pull_request_target` runs with
// the BASE repository's token and secrets against code checked out from an
// untrusted fork — the canonical GitHub Actions privilege-escalation
// footgun. This adapter only ever emits `pull_request`; `pull_request_target`
// is named here only so checkWorkflowHardening can recognise and reject it
// by name if it ever appears in a workflow this function is asked to verify.
export const SAFE_PR_TRIGGER = "pull_request";
export const FORBIDDEN_PR_TRIGGER = "pull_request_target";

export const DEFAULT_BASE_BRANCHES = Object.freeze(["develop", "main"]); // matches this repo's own acceptance.yml convention
export const DEFAULT_TIMEOUT_MINUTES = 15;

/**
 * Renders the advisory pull-request lane workflow as YAML text.
 *
 * Required: `runsOn` (an existing runner label — this adapter introduces no
 * new infrastructure, per the ticket's acceptance criterion), `nodeVersion`
 * (an explicit pinned version string, e.g. "20" — never "lts/*"),
 * `testCommand` (the exact, deterministic command that runs only the
 * relevant Bindings — selecting *which* Bindings are relevant is impact-path
 * filtering, a caller/adapter concern this renderer does not itself decide),
 * `junitPath` (an exact file path, never a glob — "exact artifact lists" is
 * enforced by construction: this renderer has no parameter that accepts a
 * wildcard).
 *
 * Optional: `workflowName`, `baseBranches` (defaults to this repo's own
 * `develop`/`main` convention), `timeoutMinutes`, `driftGateScript`,
 * `annotationsScript`, `summaryScript` (all default to this bundle's own
 * shipped script paths).
 *
 * Fixed, non-configurable by design (there is no parameter for any of
 * these — hardening is not an opt-in flag a caller could accidentally leave
 * off): `permissions: contents: read` only, `persist-credentials: false` on
 * checkout, SHA-pinned actions, the `pull_request` trigger only, and
 * `continue-on-error: true` at the job level so an advisory failure can
 * never fail the workflow run or gate a merge.
 *
 * Returns the workflow YAML as a string.
 */
export function renderAdvisoryPullRequestLane(config = {}) {
  const {
    workflowName = "dynamic-qa advisory PR lane",
    baseBranches = DEFAULT_BASE_BRANCHES,
    runsOn,
    nodeVersion,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
    testCommand,
    junitPath,
    driftGateScript = "dynamic-qa/shared/scripts/drift-gate-cli.mjs",
    annotationsScript = "dynamic-qa/shared/scripts/github-actions-annotations-cli.mjs",
    summaryScript = "dynamic-qa/shared/scripts/github-actions-summary-cli.mjs",
  } = config;

  if (!nonEmptyString(runsOn)) throw new Error("renderAdvisoryPullRequestLane: runsOn is required (reuse an existing runner label)");
  if (!nonEmptyString(nodeVersion)) throw new Error("renderAdvisoryPullRequestLane: nodeVersion is required — the Node runtime must be declared explicitly, never assumed");
  if (!nonEmptyString(testCommand)) throw new Error("renderAdvisoryPullRequestLane: testCommand is required");
  if (!nonEmptyString(junitPath)) throw new Error("renderAdvisoryPullRequestLane: junitPath is required and must be an exact path, never a glob");
  if (junitPath.includes("*")) throw new Error("renderAdvisoryPullRequestLane: junitPath must be an exact path — wildcard artifact lists are forbidden");

  // An empty baseBranches array would collapse the trigger to "on all
  // branches", silently widening who this advisory lane runs for — guard
  // against that rather than trusting the caller passed a non-empty list.
  const branches = baseBranches.length > 0 ? baseBranches : DEFAULT_BASE_BRANCHES;
  const branchesYaml = branches.map((b) => `"${b}"`).join(", ");

  return `# Generated by dynamic-qa's GitHub Actions adapter (ticket #153). This is an
# advisory pull-request lane: it never gates the merge (continue-on-error:
# true at the job level). Do not hand-edit generated Bindings or this
# workflow without re-running dynamic-qa/qa-generate — drift will be
# detected and blocks before the next test run.
name: ${workflowName}

on:
  pull_request:
    branches: [${branchesYaml}]

permissions:
  contents: read

jobs:
  dynamic-qa-advisory:
    name: dynamic-qa advisory PR lane (does not gate the merge)
    runs-on: ${runsOn}
    timeout-minutes: ${timeoutMinutes}
    continue-on-error: true
    steps:
      - name: Checkout
        uses: ${CHECKOUT_ACTION_REF}
        with:
          persist-credentials: false

      - name: Set up Node (explicit runtime; never assumed ambient on the runner)
        uses: ${SETUP_NODE_ACTION_REF}
        with:
          node-version: "${nodeVersion}"

      - name: Deterministic drift gate (runs before tests)
        run: node ${driftGateScript}

      - name: Run relevant deterministic Bindings
        run: ${testCommand}

      - name: Publish native annotations
        if: always()
        run: node ${annotationsScript} ${junitPath}

      - name: Publish job summary
        if: always()
        run: node ${summaryScript} ${junitPath} >> "$GITHUB_STEP_SUMMARY"
`;
}

// --- the hardening detector -------------------------------------------------

function namedIssue(code, message) {
  return { code, message };
}

const USES_LINE_RE = /^\s*-?\s*uses:\s*([^\s#]+)/gm;

/**
 * Scans rendered (or arbitrarily mutated) GitHub Actions workflow YAML text
 * and names, individually, every missing/violated hardening property this
 * ticket requires. Text-scanning, not a general YAML parser — deliberately:
 * the deterministic core adds no YAML library dependency, and a handful of
 * fixed, security-relevant patterns is exactly what a restricted-subset
 * check should look like (mirrors restricted-yaml.mjs's own "accept only
 * the safe subset" ethos, applied here to detection rather than parsing).
 *
 * Returns `{ valid, errors }`; every violation gets its own named `code` so
 * a Tier 1 test (or a real CI drift check) can assert on exactly which
 * property was violated, never a single generic "unsafe workflow" flag.
 */
export function checkWorkflowHardening(yamlText) {
  const issues = [];
  const text = typeof yamlText === "string" ? yamlText : "";

  // 1. minimal permissions: exactly `contents: read`, nothing else.
  const permissionsMatch = /^permissions:\n((?:^ {2}.*\n?)*)/m.exec(text);
  if (!permissionsMatch) {
    issues.push(namedIssue("permissions.missing", "no top-level permissions block is declared — permissions default to broad read/write on a repository that has not narrowed them"));
  } else {
    const body = permissionsMatch[1];
    const keys = [...body.matchAll(/^ {2}([a-zA-Z-]+):\s*(\S+)/gm)];
    const nonMinimal = keys.filter((m) => !(m[1] === "contents" && m[2] === "read"));
    if (keys.length === 0 || nonMinimal.length > 0 || !keys.some((m) => m[1] === "contents" && m[2] === "read")) {
      issues.push(namedIssue("permissions.not-minimal", `permissions must be exactly "contents: read" and nothing else (found: ${JSON.stringify(keys.map((m) => `${m[1]}:${m[2]}`))})`));
    }
  }

  // 2. persist-credentials: false on the checkout step.
  const checkoutBlockMatch = /uses:\s*actions\/checkout@[^\s#]+[\s\S]*?(?=\n\s*- name:|\n\s*-\s*uses:|$)/.exec(text);
  if (!checkoutBlockMatch || !/persist-credentials:\s*false/.test(checkoutBlockMatch[0])) {
    issues.push(namedIssue("checkout.persist-credentials-not-disabled", "the checkout step does not set persist-credentials: false — a persisted credential on disk is reachable by untrusted PR code"));
  }

  // 3. every `uses:` action reference is pinned to a full 40-hex commit SHA,
  //    never a floating tag.
  for (const m of text.matchAll(USES_LINE_RE)) {
    const ref = m[1];
    if (!/@[0-9a-f]{40}$/.test(ref)) {
      issues.push(namedIssue("actions.not-sha-pinned", `action reference ${JSON.stringify(ref)} is not pinned to a full 40-character commit SHA`));
    }
  }

  // 4. safe PR event only — pull_request_target is never used.
  if (new RegExp(`\\b${FORBIDDEN_PR_TRIGGER}\\b`).test(text)) {
    issues.push(namedIssue("trigger.unsafe-pull-request-target", `${FORBIDDEN_PR_TRIGGER} grants base-repository secrets/token to untrusted fork PR code and must never be used`));
  }
  if (!new RegExp(`^\\s*${SAFE_PR_TRIGGER}:`, "m").test(text)) {
    issues.push(namedIssue("trigger.missing-safe-pull-request-event", `no ${SAFE_PR_TRIGGER} trigger found`));
  }

  // 5. advisory lane never gates the merge.
  if (!/continue-on-error:\s*true/.test(text)) {
    issues.push(namedIssue("advisory.not-continue-on-error", "the job does not set continue-on-error: true — an advisory lane must never be able to fail the merge gate"));
  }

  // 6. unreviewed PR jobs get no secrets, OIDC, protected environment, write
  //    identity, ambient credential, or privileged cache.
  if (/\$\{\{\s*secrets\./.test(text)) {
    issues.push(namedIssue("identity.secret-referenced", "the workflow references a secret — an unreviewed PR job must receive no secret"));
  }
  if (/id-token:\s*write/.test(text)) {
    issues.push(namedIssue("identity.oidc-write-permission", "the workflow requests id-token: write (OIDC) — an unreviewed PR job must receive no OIDC identity"));
  }
  if (/^\s*environment:/m.test(text)) {
    issues.push(namedIssue("identity.protected-environment-declared", "the job declares a protected environment — an unreviewed PR job must not run inside one"));
  }
  if (/contents:\s*write|pull-requests:\s*write|packages:\s*write|actions:\s*write/.test(text)) {
    issues.push(namedIssue("identity.write-permission-granted", "the workflow grants a write permission scope — an unreviewed PR job must receive no write identity"));
  }
  if (/actions\/cache@/.test(text)) {
    issues.push(namedIssue("cache.privileged-cache-used", "the workflow uses a cache action — an unreviewed PR job must receive no privileged/shared cache"));
  }
  if (/^\s*runs-on:\s*self-hosted/m.test(text)) {
    issues.push(namedIssue("environment.self-hosted-runner-used", "the workflow targets a self-hosted runner label — this lane must use existing hosted runners/environments, not new privileged infrastructure"));
  }

  // 7. exact artifact lists: no wildcard glob feeding a reporting step.
  if (/(annotations|summary)[^\n]*\*/.test(text)) {
    issues.push(namedIssue("artifact.wildcard-list", "a reporting step references a wildcard path — artifact lists must be exact, never a glob"));
  }

  return { valid: issues.length === 0, errors: issues };
}
