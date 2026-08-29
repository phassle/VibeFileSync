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
`--all-ready` and `repair` remain placeholders for later tickets (build-scope
items 4 and 6). See `dynamic-qa/DESIGN-dynamic-qa-spec.md ## 7. qa-generate
SKILL.md outline` (run notes) for the full target workflow this file will grow
into. Repair is a mode of this skill; no separate `qa-heal` skill exists or
will exist.

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

## Stages built by #146 (single explicit `<flow-id>`), and stages still placeholders

`--all-ready` (looping this workflow per ready flow, stopping per flow on its
own blocker) and `repair` remain placeholders for a later ticket. Everything
below is single explicit-Flow-ID generation, real as of #146.

### Generation mode

1. **Preflight.** Call `runGenerationPreflight` from
   `dynamic-qa/shared/scripts/preflight.mjs` with the flow's source text and
   filename, the repository's `qa/data` directory, the two approval booleans
   evidenced by the repository's own review/approval history (see that
   module's header comment — `qa-generate` supplies this evidence, it does
   not re-derive it), the Execution Profile ID this generation targets (an ID
   only — the Execution Profile artifact itself is #150's), the exact pinned
   source commit SHA, the existing-harness descriptor (framework, test
   directory, deterministic run command) discovered from the repository, and
   the current `qa/provenance.json` if one exists. On `{ ready: false }`,
   **stop immediately** and report the exact `reason` code and `issues` —
   never proceed, never guess, never retry with different inputs. On
   `{ ready: true }`, the returned `flowData` and `dataSets` are what every
   later step below uses; do not re-parse the flow or re-resolve its data
   sets.
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
   `dynamic-qa/shared/scripts/binding-verification.mjs`. This is the checked
   gate the run brief requires: **the deterministic core decides
   acceptance, never the model that authored the candidate.** On
   `{ accepted: false }`, discard the candidate, report the exact
   `reasons` (`incomplete-outcome-coverage`, `forbidden-pattern-present`) and
   their `coverage`/`forbidden` detail, and stop — do not patch around a
   rejected candidate by weakening coverage or silencing a forbidden
   pattern.
5. **Build and write the Provenance Manifest in the same patch.** Once
   accepted, call `buildBindingRecord` then `insertOrUpdateBindingRecord`
   from `dynamic-qa/shared/scripts/provenance.mjs` with: `flowData` and
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
   optional until #150 defines the artifact). Write the serialized result
   (`serializeProvenanceManifest`) to `<repository>/qa/provenance.json` in
   the same patch as the Binding file(s) — never separately.
   Deterministic-CI enrollment beyond this manifest write is #148's
   territory (the drift gate) and not yet built here.
6. **Verify the candidate.** Run the affected flow's new/adopted test in the
   approved candidate-verification sandbox (safe execution Trust Zone 2,
   spec §11) against the pinned source commit. Negative controls, neighbor-
   flow verification, and the drift gate itself remain placeholders — #148
   and #152 own that machinery; until it lands, running the new test once
   and requiring it to pass is the whole of this step.
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

1. **Validate the Failure Evidence Bundle** and original failed conclusion —
   placeholder for build-scope item 6 (`failure evidence, diagnosis,
   proposal-only repair, negative-control gate, and quarantine validation`).
2. **Reconstruct the exact contract** (read-only) — placeholder, same scope.
3. **Diagnose** Failure Owner and Repeatability, emit a Diagnosis Record —
   placeholder, same scope.
4. **Gate**: only `confirmed + binding-owned` crosses into repair — placeholder,
   same scope.
5. **Propose one path-scoped, mechanical repair** — placeholder, same scope.
6. **Verify** the exact failure, a negative control, and protected-contract
   digests — placeholder, same scope.
7. **Emit a Repair Review Packet, require dual approval, and stop** —
   placeholder, same scope. The historical failure remains failed.

## Dependencies

Follows the repository's Git workflow and issue/ticket links. Operates only in
an isolated authoring worktree and an approved candidate-verification
environment (neither exists yet in this skeleton).

## Self-containment

This skill reads only files under its own installed directory
(`SKILL.md`, `references/`, `assets/`, `scripts/`) plus the
`dynamic-skills-setup` capability profile named above. It never reads from a
sibling `qa-setup` installation, and is installable on its own.
