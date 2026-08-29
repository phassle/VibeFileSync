# GitHub Actions adapter (#153)

GitHub Actions is dynamic-qa's first named provider adapter
(DESIGN-dynamic-qa-spec.md §9). It renders a fast, advisory pull-request lane
for the customer's relevant deterministic Bindings — brownfield Bindings
enter CI advisory during burn-in (spec §8) so a new suite can never
destabilise an existing merge gate.

## Modules

- `shared/scripts/github-actions-workflow.mjs` — pure renderer
  (`renderAdvisoryPullRequestLane`) plus a reusable hardening detector
  (`checkWorkflowHardening`) that names, individually, any missing/violated
  hardening property in arbitrary rendered/mutated workflow YAML text.
- `shared/scripts/github-actions-adapter.mjs` — the seven-point
  provider-adapter contract: detection (`detectProviderConfiguration`),
  capability evidence shaping (`deriveCapabilityEvidence`), planning
  (`planAdvisoryPullRequestLane`, which composes the Capability Gate with
  the renderer and never renders while a blocker is open), the supported
  trigger list (`SUPPORTED_TRIGGERS`), run-reference resolution
  (`resolveRunReference`), and post-render profile enforcement
  (`checkGeneratedConfigEnforcesProfile`).
- `shared/scripts/junit-report.mjs` — a restricted-subset JUnit XML reader
  (no third-party dependency), used by:
  - `shared/scripts/github-actions-annotations-cli.mjs` — native GitHub
    Actions annotations (`::error::` workflow commands), no action needed.
  - `shared/scripts/github-actions-summary-cli.mjs` — a concise job summary
    written to `$GITHUB_STEP_SUMMARY`, no action needed.
- `shared/scripts/result-envelope.mjs` — the Result Envelope v1 contract
  (`shared/schemas/dynamic-qa-result-envelope-v1.schema.json`) that a
  privileged-publication lane may consume, gated by trust-zones.mjs's
  `checkPrivilegedLaneArtifact` (reused, not duplicated).

## Hardening (a security requirement, this is not a style preference)

Every rendered workflow: a safe `pull_request` trigger only (never
`pull_request_target`); minimal `permissions: contents: read`;
`persist-credentials: false` on checkout; full-commit-SHA-pinned actions
(never a floating tag); a job-level `continue-on-error: true` so an
advisory failure can never fail the workflow run or gate a merge; no
secret, OIDC (`id-token: write`), protected environment, write permission
scope, privileged cache action, or self-hosted runner. `checkWorkflowHardening`
detects each property's violation individually and by name — it is the same
function used both to prove the renderer's own output is hardened and to
implement contract point 7 (validate that generated configuration enforces
the Execution Profile) against arbitrary text.

## The Node-runtime caveat

Node is guaranteed on a developer machine and a GitHub-hosted runner, but
NOT automatically on a minimal self-hosted runner. The renderer always
emits an explicit `actions/setup-node` step (never assumes an ambient
`node`), and the adapter additionally REQUIRES the Execution Profile to
declare a `runtime.node-available` capability
(`checkNodeRuntimeCapabilityDeclared`) and the environment to report it
`met` — a missing or unmet Node runtime is always a named Safety Blocker and
a deferred flow (`planAdvisoryPullRequestLane` returns
`{ rendered: false, state: "deferred", blockers }`), never a silent skip.

## Sharding

Not introduced. DESIGN-dynamic-qa-spec.md §8 is explicit: "sharding only
after measured need." The renderer's `testCommand` is a single, precomputed
command string — the seam for a later ticket to shard is there (a caller
could pass a matrix of `testCommand`s once real runtime data justifies it),
but nothing in this ticket adds a matrix strategy, and none should be added
without measured runtime evidence.

## Seams for later tickets

- **Nightly full suite, manual/provider-API trigger, merge-group trigger**
  (DESIGN-dynamic-qa-spec.md §8's other three Provider-native CI exposures)
  are NOT built by this ticket — `SUPPORTED_TRIGGERS` names only
  `pull_request`; `DEFERRED_TRIGGERS` names the other three explicitly as an
  open seam, not silently folded into the PR lane.
- **Impact-path-based Binding selection** ("a pull request runs only the
  Bindings relevant to the change") is NOT implemented here — this
  renderer's `testCommand` is a precomputed, already-scoped command string a
  caller supplies. Selecting *which* Bindings are relevant from impact paths
  is a separate concern for whichever ticket owns impact-path evaluation.
- **Full semantic inventory of an existing arbitrary workflow's content**
  (contract point 1) is out of scope: `detectProviderConfiguration` is
  read-only and filename-level only. dynamic-qa's restricted-YAML parser is
  deliberately scoped to dynamic-qa's own schemas, not arbitrary
  third-party GitHub Actions YAML.
- **Required-lane and quarantine-lane rendering** (adapter contract point 3
  names all three: advisory, required, quarantine) are NOT built by this
  ticket — only `renderAdvisoryPullRequestLane` exists. A later ticket
  should add sibling renderers reusing the same hardening detector rather
  than duplicating it.
- **Action-pin freshness**: `CHECKOUT_ACTION_SHA` / `SETUP_NODE_ACTION_SHA`
  in `github-actions-workflow.mjs` are placeholders shaped as real 40-hex
  commit SHAs (the deterministic core has zero network access and cannot
  resolve them itself) — re-verify each against the intended upstream
  release before this generated workflow is ever enabled for a real
  repository. The pilot (#171-175) is deliberately not being run yet.
- **Wiring this adapter's invocation into `qa-generate/SKILL.md`'s own step
  sequence** is left to a coordinated follow-up — see that file's step 5
  note.
