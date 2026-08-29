# The provider-neutral adapter contract (#156)

DESIGN-dynamic-qa-spec.md §9 requires a provider-neutral CI adapter contract,
extracted from a working adapter rather than designed ahead of it: "v1 ships a
GitHub Actions adapter. Other providers are separate adapters against the same
contract; absence of an adapter is an exact blocker, not permission to invent
generic YAML." This ticket extracts that contract from #153/#154/#155's
GitHub Actions adapter, refactors that adapter to be expressed entirely
through it, and ships a reusable conformance suite plus a second,
independently-written fixture adapter proving the suite is genuinely
reusable — not a second real provider (explicitly out of scope).

## Modules

- `shared/scripts/adapter-contract.mjs` — the contract itself: the seven
  points and six security obligations as data, plus one behavioral checker
  function per point/obligation. Imports nothing provider-specific; every
  check operates only on a neutral `adapter` object and caller-supplied
  `fixtures`.
- `shared/scripts/adapter-conformance.mjs` — `runAdapterConformanceSuite(adapter,
  fixtures)`, the single reusable entry point. Always runs every point and
  every obligation, unconditionally, in a fixed order — mirroring
  `capability-gate.mjs`'s `runCapabilityGate` composition style.
- `shared/scripts/github-actions-adapter.mjs` — refactored (not rewritten) to
  expose the neutral shape via a new exported `adapter` object, `planLane`
  (generalizes the four existing `plan*` functions), `emitReporting`, and
  `emitFailureBundle`. Every pre-existing function/export is unchanged and
  still directly callable.
- `shared/scripts/fixture-adapter.mjs` — a second, independently-implemented,
  fully-conforming "fixture-ci" adapter (JSON-shaped configuration, not
  YAML) used only to prove reusability. Composes `capability-gate.mjs`,
  `diagnostics-scrub.mjs`, and `junit-report.mjs` directly — nothing from
  the GitHub Actions modules.
- `shared/scripts/adapter-conformance.test.mjs` — the Tier 1 proof described
  below.

## The neutral adapter object shape

```
identity            : string
detect(existingWorkflowFilenames)                -> { provider, existingWorkflows, hasDynamicQaWorkflow, defaultWorkflowPath }
deriveCapabilityEvidence(input)                   -> environment evidence (the 8 Capability Gate categories)
planLane({ lane, trigger, profile, environmentEvidence, workflowConfig, workflowPath }) -> { rendered, state, config?, path?, blockers? }
supportedTriggers    : string[] (subset of pull_request/schedule/workflow_dispatch/merge_group)
deferredTriggers     : string[]
supportedLanes       : string[] (subset of advisory/required/quarantine)
deferredLanes        : string[]
emitReporting(junitXmlText)                       -> { summary, annotations }
emitFailureBundle(diagnostics, opts)               -> { artifacts, withheld }   (diagnostics-scrub.mjs's manifest shape)
resolveRunReference(env)                           -> { repository, sourceCommit, workflow }
checkGeneratedConfigEnforcesProfile(profile, config, opts) -> { valid, errors }
```

`config` is deliberately neutral naming (not `yaml`) — a provider's rendered
configuration need not be YAML at all; `fixture-adapter.mjs`'s is JSON.
`github-actions-adapter.mjs`'s existing `plan*` functions still return `yaml`
unchanged (no existing caller is affected); `planLane` normalizes that to
`config` for contract-neutral callers.

## The seven contract points

Numbered identically to DESIGN-dynamic-qa-spec.md §9 (the ticket's own prose
names "reporting" and "failure-bundle emission" as two obligations of the
same point 5):

1. **discovery** — `detect`, read-only, filename-level inventory.
2. **capability evidence** — `deriveCapabilityEvidence`, shaping what the
   provider concretely proves into the Capability Gate's environment-evidence
   shape, honestly (an evidence-derivation function proven to report a
   capability "met" regardless of input is a rubber stamp and fails
   conformance).
3. **lane rendering** — `planLane`, rendering advisory/required/quarantine
   lanes without changing policy itself; never renders while the Capability
   Gate has an open blocker (no default-open path).
4. **triggers** — `supportedTriggers`/`deferredTriggers`, declaring which of
   the four Provider-native CI triggers this adapter supports.
5. **reporting and failure-bundle emission** — `emitReporting` (JUnit-derived
   annotations/summary) and `emitFailureBundle` (a strict, scrubbed,
   exact-path failure bundle, composing `diagnostics-scrub.mjs`'s
   `buildDiagnosticsManifest`).
6. **provider-run resolution** — `resolveRunReference`, a pure function
   normalizing the provider's own run environment into Result Envelope
   identity fields.
7. **Execution Profile validation** — `checkGeneratedConfigEnforcesProfile`,
   the sole security-enforcement gate every obligation below routes through.

`checkAdapterShape` in `adapter-contract.mjs` checks structural conformance
(the right methods/arrays exist); each point also has its own behavioral
checker (`checkDiscoveryPoint`, `checkCapabilityEvidencePoint`, ...,
`checkProfileEnforcementPoint`) that calls the adapter and asserts on what it
actually does, not merely that it exists.

## The six security obligations

"Portability must not weaken security... the contract must make the security
obligations explicit and checkable: an adapter that cannot enforce exact
egress, minimal permissions, immutable pins, no-persisted-credential,
privileged/low-trust separation, or diagnostics scrubbing must fail
conformance rather than degrade." (the ticket, verbatim) Each is its own named
checker in `adapter-contract.mjs`, fail-closed: an adapter or fixtures bag
that cannot even be probed for an obligation FAILS that obligation — there is
no "untestable, so presumed fine" path.

| Obligation | How it is probed |
|---|---|
| exact egress | `planLane` is fed environment evidence whose network mode violates the profile's requirement (e.g. `"open"` against a `"none"` profile); a conforming adapter must refuse to render (`rendered: false`) — this reuses `capability-gate.mjs`'s own network check, never a second one. |
| minimal permissions | `checkGeneratedConfigEnforcesProfile` is fed a deliberately broad-permissions configuration; it must report `valid: false`. |
| immutable pins | Same gate, fed a configuration whose action/step reference is a floating tag rather than an exact, immutable pin. |
| no persisted credential | Same gate, fed a configuration that persists a credential across steps. |
| privileged/low-trust separation | Same gate, fed a configuration combining a privileged identity with a low-trust trigger (the "pwn request" bridge shape). |
| diagnostics scrubbing | `emitFailureBundle` is called with `opts.verify` forced to report "still contains a secret-shaped value" (the documented test seam in `diagnostics-scrub.mjs`) for every diagnostic; a conforming adapter must withhold all of them (empty `artifacts`) because it composes the fail-safe redact-then-reverify gate rather than bypassing it. |

For GitHub Actions, the first four security-config obligations are proven
via `checkGeneratedConfigEnforcesProfile`, which now ALSO composes #155's
`checkActionAndReusableWorkflowAllowlist` (immutable pins + an explicit
approval, not pinning alone) and `checkPrivilegedLaneRefusesLowTrustBridge`
(the "pwn request" bridge check) — both existed since #155 but were never
wired into this adapter's own enforcement gate until this ticket. See
"What changed in the GitHub Actions adapter" below.

## Running the conformance suite against an arbitrary adapter

```js
import { runAdapterConformanceSuite } from "./adapter-conformance.mjs";
import { adapter as githubActionsAdapter } from "./github-actions-adapter.mjs";
import { adapter as fixtureCiAdapter } from "./fixture-adapter.mjs";

const ghResult = runAdapterConformanceSuite(githubActionsAdapter, ghFixtures());
const fixtureResult = runAdapterConformanceSuite(fixtureCiAdapter, fixtureCiFixtures());
```

`fixtures` is adapter-specific probe data (profile, workflowConfig, a
fully-met and a blocked environment evidence, a conforming and a
non-conforming rendered configuration, JUnit XML text, clean diagnostics, and
one deliberately-violating fixture per security obligation) — the same
caller-supplied-evidence pattern `capability-gate.mjs` and `trust-zones.mjs`
already use. The suite's own code never differs between adapters; only the
data does. `shared/scripts/adapter-conformance.test.mjs` runs it against both
`githubActionsAdapter` and `fixtureCiAdapter` and asserts both are fully
conformant, proving reusability directly.

## What changed in the GitHub Actions adapter

No pre-existing function's signature or behaviour changed, and every
pre-existing test still passes unmodified. Two things are new:

- `checkGeneratedConfigEnforcesProfile` (point 7) now additionally composes
  `checkActionAndReusableWorkflowAllowlist` and
  `checkPrivilegedLaneRefusesLowTrustBridge` (both #155). Every lane this
  adapter has ever rendered already satisfies both (only the two
  `DEFAULT_ALLOWLISTED_ACTIONS` entries are ever emitted, pinned to the exact
  SHAs that allowlist approves; no lane declares `pull_request_target`/
  `workflow_run` alongside a privileged job), so no existing assertion's
  expected result changes. What changes is that a configuration violating
  either property — previously invisible to this adapter's own enforcement
  gate, an open seam #155's own notes named for this ticket — is now caught.
  This is a security strengthening the ticket requires, not a behaviour
  change to anything this adapter renders.
- `planLane`, `emitReporting`, `emitFailureBundle`, `SUPPORTED_LANES`,
  `DEFERRED_LANES`, and the exported `adapter` object are new, additive
  surface closing the seams #153/#154/#155's own notes left explicitly open
  for this ticket ("no caller wires `prepareDiagnosticForUpload`/
  `buildDiagnosticsManifest` into a real generated workflow step... #156";
  "quarantine-lane rendering... remain[s] open for a later ticket" — declared
  honestly via `DEFERRED_LANES`, not attempted here).

## Left open

- **Quarantine-lane rendering.** `DEFERRED_LANES = ["quarantine"]` on the
  GitHub Actions adapter — declared, not built. A later ticket that adds it
  need only add one more `plan*` function and register it in
  `LANE_PLANNERS`/`SUPPORTED_LANES`.
- **A second real provider.** Deliberately out of scope per the ticket;
  `fixture-adapter.mjs` proves the contract is provider-neutral without
  shipping one.
- **Full semantic inventory of an arbitrary third-party workflow** (point 1)
  remains read-only/filename-level, exactly as #153 left it.
