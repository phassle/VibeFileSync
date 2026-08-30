---
name: qa-generate
description: "Generate or adopt deterministic Bindings for approved Flow Definitions, or diagnose a deterministic CI failure and propose a guarded Binding repair. Use only when explicitly invoked; never starts from natural-language intent."
disable-model-invocation: true
metadata:
  version: "{{BUNDLE_VERSION}}"
---

STATUS: partial build. #146 lands the walking-skeleton generation path for
one explicit Flow ID: preflight validation, the smallest conforming Binding
in the customer's existing layout, the assertion↔Expected-Outcome-ID
completeness gate, the forbidden-pattern gate, and the Provenance Manifest.
`--all-ready` remains a placeholder for a later ticket (build-scope item 4).
Repair mode (build-scope item 6) is real as of #160: bundle validation,
diagnosis, protected-contract-digest gating, the negative-control guard, and
the Repair Review Packet are all backed by
`scripts/repair.mjs`, composing #159's
`failure-evidence.mjs` and #152's `negative-controls.mjs` unchanged. See
`dynamic-qa/DESIGN-dynamic-qa-spec.md ## 7. qa-generate SKILL.md outline`
(run notes) for the full target workflow this file will grow into. Repair is
a mode of this skill; no separate `qa-heal` skill exists or will exist.

## Explicit invocation only

`qa-generate` never starts from natural-language intent, a coordinator
inferring work, or another skill invoking it implicitly. `disable-model-invocation:
true` above is the portable half of that gate; the Codex build additionally
carries `policy.allow_implicit_invocation: false` in its `agents/openai.yaml`
overlay (see `dynamic-qa/codex/qa-generate/agents/openai.yaml`). Default
behavior, once built, is generation — never repair — and repair always
requires an explicit evidence source.

Entry forms this skill will accept once built:

```text
qa-generate <flow-id>
qa-generate --all-ready
qa-generate repair --evidence <bundle-path-or-provider-run>
```

## Invoking with no argument is side-effect free

`qa-generate` has no defined no-argument workflow: none of the three entry
forms above omits an argument. Invoking it with no argument MUST print usage
guidance only. No repository file, provider policy, secret, or piece of
infrastructure is created, edited, or touched by invoking `qa-generate` with no
argument, at any stage of this skill's implementation.

## Installation precondition: a verified Dynamic setup profile

Before doing anything else — including printing usage guidance for a
no-argument invocation — confirm a present, schema-current, unexpired,
`verified` `dynamic-skills-setup` capability profile exists for the harness in
use (see `~/.agents/dynamic-skills/capabilities.json`, or the path named by
`DYNAMIC_SKILLS_PROFILE`). "Verified" here additionally requires that harness's
`mattCodeReview: true` and a matching `reviewRoutes[]` entry, per the parent
spec's dependency on that field for review-route trust.

If the profile is absent, stale (past its harness's `catalog.expiresAt`), on an
unsupported `schemaVersion`, or not `verified` for this harness, **stop
immediately** and print the exact manual setup command for the current host —
do not invoke `dynamic-skills-setup` yourself:

| Host | Manual setup entry |
| --- | --- |
| Codex CLI/IDE/app | `$dynamic-skills-setup`, or select `dynamic-skills-setup` through `/skills`. |
| Claude Code | `/dynamic-skills-setup` |
| GitHub Copilot CLI/app | `/dynamic-skills-setup` |
| OpenCode | `/dynamic-skills-setup` through the installed custom-command adapter. |
| Pi | `/skill:dynamic-skills-setup` |

This mirrors `dynamic-implement`'s own manual-setup-entry table exactly;
`qa-generate` does not define a setup command of its own.

## Stages built by #146/#160, and stages still placeholders

`--all-ready` (looping this workflow per ready flow, stopping per flow on its
own blocker) remains a placeholder for a later ticket. Single explicit-Flow-ID
generation is real as of #146; repair mode is real as of #160.

### Generation mode

1. **Preflight.** Call `runGenerationPreflight` from
   `scripts/preflight.mjs` with the flow's source text and
   filename, the repository's `qa/data` directory, the two approval booleans
   evidenced by the repository's own review/approval history (see that
   module's header comment — `qa-generate` supplies this evidence, it does
   not re-derive it), the Execution Profile ID this generation targets plus
   the repository's `qa/execution-profiles` directory (#153 wired the actual
   artifact resolution, well-formedness, and boundary-honourability checks
   into preflight — this is no longer just an ID-string check), environment
   evidence proving the Capability Gate is satisfied (never omit this input:
   an absent environment is itself refused, not skipped — a real CI adapter,
   e.g. `github-actions-adapter.mjs`'s `deriveCapabilityEvidence`, is the
   intended real source), the exact pinned source commit SHA, the
   existing-harness descriptor (framework, test directory, deterministic run
   command) discovered from the repository, and the current
   `qa/provenance.json` if one exists. On `{ ready: false }`, **stop
   immediately** and report the exact `reason` code and `issues` — never
   proceed, never guess, never retry with different inputs. On
   `{ ready: true }`, the returned `flowData`, `dataSets`, and
   `executionProfile` are what every later step below uses; do not re-parse
   the flow, re-resolve its data sets, or re-validate its profile.
2. **Reuse or generate the smallest conforming Binding.** Inspect the
   existing test layout and framework (from the preflight `harness`
   descriptor) for a deterministic test already proving every Expected
   Outcome from step 1's `flowData`; adopt it if so. Otherwise author the
   smallest new Binding file that fits the existing layout's conventions —
   this is the one genuinely generative part of this workflow, and belongs
   here in prose, not in the deterministic core. #147 owns the actual
   adoption-detection heuristics; until then, treat "no obviously matching
   existing test" as "generate new".
3. **Infer the cheapest deterministic level.** Placeholder pending #147's
   inference machinery. Until then, honor `flowData.test_level` exactly: an
   `inferred` selection with no override machinery yet available means
   choosing the cheapest layer this skill can directly verify (prefer API/CLI
   over browser when the flow's boundaries make both faithful); an
   `override` selection's `value` is authoritative and must be used as-is.
4. **Map every assertion to stable Flow step and Expected Outcome IDs, then
   verify.** Build the candidate's assertion list as
   `{ stepId, outcomeId, location }` entries mirroring exactly which step and
   outcome each assertion proves, and pass every file the candidate writes
   plus that assertion list to `verifyCandidateBinding` in
   `scripts/binding-verification.mjs`. This is the checked
   gate the run brief requires: **the deterministic core decides
   acceptance, never the model that authored the candidate.** On
   `{ accepted: false }`, discard the candidate, report the exact
   `reasons` (`incomplete-outcome-coverage`, `forbidden-pattern-present`) and
   their `coverage`/`forbidden` detail, and stop — do not patch around a
   rejected candidate by weakening coverage or silencing a forbidden
   pattern.
5. **Build and write the Provenance Manifest in the same patch.** Once
   accepted, call `buildBindingRecord` then `insertOrUpdateBindingRecord`
   from `scripts/provenance.mjs` with: `flowData` and
   `dataSets` from step 1; digests of the pinned flow/data JSON Schema files
   in use; the exact pinned `sourceCommit`; a `generator` object naming
   `identity: "generated"` (or `"adopted"` plus `adoptedFrom` for step 2's
   adoption path), the installed `BUNDLE_VERSION`, a content digest
   identifying the exact generator code, and the coding harness/model that
   authored the candidate; the discovered `framework`/adapter identity and
   version; `harnessInputs` naming any config/lockfile paths this generation
   read, each with its own digest; `outputs` naming every file the candidate
   wrote, each with its own digest; conservative `impactPaths`; the
   `enforcementLane` — brownfield candidates are `advisory`; a first active
   greenfield Binding is `required` unless repo governance records an
   explicit exception (spec §8); and `executionProfile: { id }` (digest
   optional until a caller fills it via `contentDigest`, per #150's
   hand-off). Write the serialized result (`serializeProvenanceManifest`) to
   `<repository>/qa/provenance.json` in the same patch as the Binding
   file(s) — never separately. The deterministic drift gate
   (`drift-gate-cli.mjs`, #148) enforces this manifest on every later CI run;
   this step only writes it. Rendering the actual provider CI lane the
   Binding runs in is a separate concern from this manifest write — see
   `references/shared/github-actions-adapter.md` for the GitHub
   Actions adapter this bundle ships (#153); wiring its invocation into this
   skill's own step sequence is left to a coordinated follow-up, not done in
   this edit.
6. **Verify the candidate.** Run the affected flow's new/adopted test in the
   approved candidate-verification sandbox (safe execution Trust Zone 2,
   spec §11) against the pinned source commit. Negative controls and
   neighbor-flow verification remain placeholders — #152 owns that
   machinery; until it lands, running the new test once and requiring it to
   pass is the whole of this step.
7. **Present one review packet, emit a patch, and stop.** Show the level
   rationale, the Flow-to-Binding mapping (every assertion's stepId/outcomeId
   pair from step 4), the exact diff (Binding file(s) plus
   `qa/provenance.json`), the preflight/verification results, and note any
   residual risk (e.g. level inference not yet built, adoption detection not
   yet built). Require the same approvals preflight already evidenced —
   `qa-generate` does not ask again, it reports what it already required.
   Emit the patch and stop: this skill never merges, activates a required
   check, or runs anything beyond step 6's single verification pass.

### Repair mode (`qa-generate repair --evidence ...`)

Repair pursues exactly one causal hypothesis, never applies its own patch,
and never widens its own permissions or its own tolerance. Everything below
is real as of #160, backed by `scripts/repair.mjs`
(orchestrator: `evaluateRepairProposal`), composing #159's
`failure-evidence.mjs` and #152's `negative-controls.mjs` unchanged.

1. **Validate the Failure Evidence Bundle** and original failed conclusion.
   Parse the bundle named by `--evidence` and call `isBundleRepairEligible`
   from `scripts/failure-evidence.mjs` — this composes
   #159's own `validateFailureEvidenceBundle` (shape/structure),
   `checkBundleImmutability` (digest recomputation — any post-hoc edit is
   refused), and #158's `isRepairEligible` (only `confirmed + binding +
   binding-defect` may proceed). A structurally invalid bundle, a mutated
   bundle, or an ineligible diagnosis (product, environment, unresolved,
   provisional, safety-blocked, or confirmed-binding-but-intermittent) is a
   Safety Blocker or a routed refusal, respectively — **stop immediately**,
   report `explainRepairIneligibility`'s named reason, and never proceed on
   a guess. This is `evaluateRepairProposal`'s first gate
   (`reasons[0].gate === "bundle-eligibility"`).
2. **Reconstruct the exact contract** (read-only). Call
   `reconstructProofObligations(flowData, affectedOutcomeIds)` — this reuses
   #152's `buildNegativeControlPlan` exactly, deriving each affected Expected
   Outcome's declared violation straight from the (untouched) Flow contract:
   the exact step, outcome, tolerance kind, owned boundary, and the epsilon/
   set/presentation bound it requires. `flowData` and `affectedOutcomeIds`
   (from the bundle's `expectedVsObserved`) are never edited here or later —
   this step only reads.
3. **Diagnose** Failure Owner and Repeatability, emit a Diagnosis Record.
   The bundle already embeds one produced Diagnosis Record (#158's
   `validateDiagnosisRecord` shape); step 1's `isBundleRepairEligible` has
   already confirmed it meets the repair-eligible combination. A fresh
   probe is only ever a single additional reproduction/hypothesis-probe
   attempt appended via #158's `appendAttempt` — never a second causal
   theory (see step 6's one-hypothesis gate).
4. **Gate**: only `confirmed + binding-owned` crosses into repair. This is
   the same call as step 1 (`isBundleRepairEligible`) — there is no separate
   re-derivation. Everything else stays failed and routes to its
   accountable owner with no Binding patch.
5. **Propose one path-scoped, mechanical repair.** Author the smallest
   Binding-only diff (selectors, waits, fixture wiring, framework syntax —
   never Flow semantics, tolerances, boundaries, data meaning, level
   overrides, lifecycle, enforcement, dependencies, lockfiles, workflows,
   profiles, identities, network access, quarantine, or required-check
   policy). Before presenting anything, call
   `checkRepairFilesAreMechanicalOnly(proposedFiles)` — a path-based
   denylist layer that refuses `qa/flows/*`, `qa/data/*`,
   `qa/execution-profiles/*`, `qa/quarantine*`, `.github/workflows/*`,
   `.github/*required-checks*`/`*branch-protection*`, `package.json`, any
   lockfile, and `CODEOWNERS` outright, independent of whether the content
   actually changed. Also run the existing forbidden-pattern scan
   (`scanGeneratedFiles`, #146) over the proposed diff — no new skips,
   fixme markers, or always-true assertions.
6. **Verify** the exact failure, a negative control, protected-contract
   digests, and neighbouring coverage. Compose, in order, exactly as
   `evaluateRepairProposal` does:
   - **One causal hypothesis.** `checkSingleCausalHypothesis(hypotheses)`
     over every distinct causal-hypothesis string this invocation
     considered (normally just the bundle's own `causalChain`). More than
     one distinct hypothesis is a **refusal that ends the invocation**, not
     a retry with the next theory — repair must never become a loop.
   - **Protected-contract digests.** Snapshot every one of the 15 named
     off-limits categories (`PROTECTED_CONTRACT_CATEGORIES`: `flowSemantics`,
     `tolerances`, `boundaries`, `dataMeaning`, `levelOverrides`,
     `lifecycle`, `enforcement`, `dependencies`, `lockfiles`, `workflows`,
     `profiles`, `identities`, `networkAccess`, `quarantine`,
     `requiredCheckPolicy`) before and after the proposed diff, and call
     `checkProtectedContractsUnchanged(before, after)` — this reuses
     `canonical-digest.mjs`'s `contentDigest` (never a new hashing scheme).
     Any drift in ANY category rejects the repair outright.
   - **Assertion coverage still complete.** `checkAssertionCoverage`
     (#146, reused) over the post-repair assertion list against `flowData`.
   - **A failing negative control is required**, reusing #152's
     `checkNegativeControlCoverage` over the plan built in step 2 and the
     harness's `NegativeControlReport`s — a missing, simulated, or
     assertion-passed control refuses the repair.
   - **The tolerance-widening / control-weakening guard** — the check #152
     explicitly left unbuilt. `checkNegativeControlNotWeakened(plan,
     reports)` requires every report to attest
     `appliedViolation.declaredViolationDigest` equal to
     `declaredViolationDigest(declaredViolation)` for that outcome — a
     digest the harness computes over the perturbation it actually applied,
     never copied from the plan. A repair that quietly widens its own
     tolerance or weakens an assertion so a larger, easier perturbation
     still reports `"assertion-failed"` produces a *different* digest here
     and is rejected, even though #152's own `judgeNegativeControl` alone
     would have accepted it.
   - **Neighbouring coverage.** `checkNeighboringCoverageUnbroken(neighbors)`
     re-runs `checkAssertionCoverage` per neighbouring flow against its
     post-repair assertions.
7. **Emit a Repair Review Packet and stop.** When every gate in steps 1–6
   passes, `evaluateRepairProposal` assembles the ONE packet with exactly
   six sections (`REPAIR_REVIEW_PACKET_SECTIONS`): `evidence` (bundle id,
   run identity, embedded diagnosis), `mappings` (step 2's reconstructed
   proof obligations), `protectedContractDigests` (the full before/after
   digest maps), `diff` (the proposed files, verbatim — never written to
   disk), `verification` (every check result from step 6), and
   `residualRisk`. Require the same QA Owner proof-obligation approval and
   Technical Owner code/harness/safety approval the parent spec names.
   **This skill emits a patch as data and stops — it never applies it,
   never merges, never activates a required check, and never runs the
   pilot.** The historical failed attempt remains failed; only reviewed
   code plus a later ordinary CI run can become green. Any single failing
   gate in steps 1–6 refuses the repair instead — a refusal never emits a
   packet, and repair never proceeds partially or patches around one
   failed gate by weakening another.

## Dependencies

Follows the repository's Git workflow and issue/ticket links. Operates only in
an isolated authoring worktree and an approved candidate-verification
environment (neither exists yet in this skeleton).

## Self-containment

This skill reads only files under its own installed directory
(`SKILL.md`, `references/`, `assets/`, `scripts/`) plus the
`dynamic-skills-setup` capability profile named above. It never reads from a
sibling `qa-setup` installation, and is installable on its own.
