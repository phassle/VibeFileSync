# dynamic-qa build decisions

This file is the decision record for `dynamic-qa`'s own packaging and distribution
choices. `dynamic-qa` is a separate bounded context from VibeFileSync: this file,
not a VibeFileSync ADR under `docs/adr/`, is where those decisions live, and its
vocabulary must never enter VibeFileSync's `CONTEXT.md`.

## 1. Build source location: top-level `dynamic-qa/` in this repository

**Decision.** The build source tree for the `qa-setup` / `qa-generate` bundle lives
at top-level `dynamic-qa/` in the VibeFileSync repository. Installed output is
produced by `dynamic-qa/build.sh` and lands outside the repository (default
`~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/commands/`, and
optionally `~/.claude/skills/`), never inside it.

**Alternatives considered and rejected:**

- **Authoring the two skills directly inside a skills directory**
  (`~/.agents/skills/dynamic-qa/qa-setup`, etc.), with no repository build source at
  all. Rejected: it leaves the bundle unreviewable through the repository's normal
  PR flow, untested by any CI, and with no single canonical copy to diff the
  Codex/shared/OpenCode builds against — exactly the packaging guarantee this
  ticket exists to build. This was the pre-existing state (`dynamic-qa/SPEC.md` and
  `README.md` only, no `SKILL.md`) and is explicitly what the bundle is moving away
  from.

- **`tools/dynamic-qa-build/`** (nested under a generic repository tooling
  directory). This was the shape sketched during packaging research (see
  `skills-packaging.md` in the run notes) and was seriously considered. Rejected in
  favour of top-level visibility: `dynamic-qa` is a separate bounded context with
  its own domain vocabulary, its own release cadence, and its own acceptance
  harness — nesting it under `tools/` would present it as internal build
  infrastructure *for* VibeFileSync rather than as a distinct system that happens
  to be developed in this repository. A top-level directory makes that boundary
  obvious to anyone browsing the repository tree, matches how `dynamic-qa/` was
  already reserved at top level for the spec and README before this ticket, and
  keeps the directory name itself as the one piece of vocabulary that's allowed to
  leak into the host repo (a location, not a glossary term).

**Consequence.** `tests/docs_references.rs` (VibeFileSync's own doc-reference
checker) does not currently discover `dynamic-qa/` — it only governs root guides,
`docs/`, `.sandcastle/`, and `*-vibesync`-suffixed skills. Markdown under
`dynamic-qa/` is therefore free of that check's symbol-reference notation
requirement; this is a deliberate consequence of keeping dynamic-qa's own
documentation self-contained, not an oversight. If a later ticket wants that
enforcement extended to `dynamic-qa/`, it should say so explicitly rather than
assuming it already applies.

## 2. Bundle versioning and content-addressing: new machinery, not reused

**Decision.** `dynamic-qa/BUNDLE_VERSION` holds one semver string, and
`dynamic-qa/build.sh` computes an immutable content digest over the built `shared`
tree (sorted relative paths, each file hashed, digests concatenated and hashed
again — same shape as `capabilities.json`'s per-harness ladder fingerprint:
canonicalize first, exclude timestamps and machine paths, then hash). Both are
written to `dist/dynamic-qa/BUNDLE_MANIFEST.json` and stamped into each shipped
`SKILL.md`'s `metadata.version` field at build time.

**Why not reuse an existing scheme.** Neither existing first-party convention on
this machine is sufficient by itself: `dynamic-implement`/`dynamic-skills-setup`/
`dynamic-skills-calibrate` carry only a bare `metadata.version` semver with no
digest and no build step; `skills-lock.json` only tracks externally vendored
(`mattpocock/skills`) content by hash, not first-party bundles. This ticket
introduces the first per-bundle immutable content digest and byte-identical
packaging check for the Dynamic skill family; it is new machinery, and later
`dynamic-qa` tickets should extend it rather than invent a second scheme.

## 4. Deterministic core (Node, built-ins only) + a two-tier acceptance harness

**Decision.** The bundle is not "Markdown prompts that ask an agent to
validate." Anything that is pure computation — schema validation,
canonicalization and content digests, the drift gate, quarantine expiry,
diagnostics scrubbing, evidence-bundle parsing, threshold evaluation, and
capability-gate checks — is real executable code in a deterministic core at
`dynamic-qa/shared/scripts/` (see the `PLACEHOLDER.md` there), because the
spec requires ordinary PR and nightly regression runs to call no LLM and no
browser agent. The core is plain JavaScript (ESM), Node.js built-in modules
only: no TypeScript, no transpile step, no `npm install`, no third-party
dependency. Where strict YAML or JSON Schema handling is needed, later
tickets hand-write a restricted-subset parser / validator here rather than
add a library dependency — an empty supply chain is a security requirement
for this bundle (attacker-controlled content must never combine with broad
capability), not a style preference. Core tests use the built-in `node:test`
and `node:assert` modules, so the fast tier needs no test-framework
dependency either.

**Why Node.** Claude Code and the other coding-agent harnesses this bundle
targets are themselves Node CLIs, so Node is already present on any machine
where these skills can run at all — the core adds no new runtime requirement
to a customer's box. (This guarantee covers the developer machine running
the agent, not automatically a minimal self-hosted CI runner; GitHub-hosted
runners ship Node. Whoever builds the GitHub Actions adapter should state
the runtime it depends on explicitly and treat a missing runtime as a Safety
Blocker with the flow deferred, never a silent skip — not solved here.)

**Consequence for the acceptance harness** (`dynamic-qa/acceptance/`, ticket
#142): it runs two tiers. Tier 1 runs `node --test` directly against
`dynamic-qa/shared/scripts` — no fixture repository, no model, no network,
seconds not minutes. Tier 2 is the disposable fixture-repository harness,
reserved for what is genuinely agentic (elicitation, generation, adoption,
diagnosis, repair proposals) plus genuinely structural cross-harness checks
(discoverability, packaging). The rule for every later ticket: if you find
yourself asserting on model behavior for something that is really just
computation, extract the computation into Tier 1 instead — see
`dynamic-qa/acceptance/README.md` for the full contract.

**Resolved by #143.** `build_shared`/`verify_shared_copies_identical` now copy
and byte-diff `shared/scripts/**/*.mjs` (implementation modules only — `*.test.mjs`
and `fixtures/` stay out of the shipped skill tree; they exist for this
bundle's own acceptance harness, not a customer's installed skill) the same
way they already handled `shared/schemas` and `shared/references`.

## 6. Flow Definition v1: restricted-YAML scope, tolerance nesting, extension seams

**Restricted-YAML subset excludes block scalars (`|`/`>`).** Every string value
must fit on one line (plain, single-, or double-quoted). This keeps the parser
small and its fail-closed surface easy to reason about; it also means a long
Expected-Outcome or intent description must be written as one quoted line
rather than a folded/literal block. If a later ticket finds this genuinely too
restrictive, extending the parser to support block scalars is additive (a new
node kind), not a rewrite.

**Empty-collection literals `[]` and `{}` are allowed** as the one exception to
"no flow-style collections": block style has no other way to spell an empty
list or map (`data_sets: []` on a flow that needs no named data), and the
literal empty form carries none of flow style's aliasing/nesting risk.
Non-empty flow-style (`[1, 2]`, `{a: 1}`) is still rejected.

**A tolerance is nested directly under the Expected Outcome it applies to**,
rather than declared in a separate list cross-referenced by outcome ID. This
was a genuine reading choice against DESIGN-dynamic-qa-spec.md §5.1's
"optional tolerance attached to exactly one Expected Outcome": nesting makes
the 1:1 relationship a structural invariant (there is no ID to get wrong or
duplicate) instead of a rule the validator has to check separately. A future
ticket that finds a real need for tolerances to be declared out-of-line (e.g.
sharing one tolerance across a named pattern) should treat that as a new,
explicitly-considered decision, not a silent reinterpretation.

**Extension seams left for #144/#145.** `boundaries.mjs` and
`data-set-refs.mjs` each validate only the shape of what a Flow Definition
embeds/references (Boundary Declarations are inline in the flow file per
§5.1; Named Data Sets are referenced by ID). Both modules say in their own
header comment exactly what they do *not* check (the owned-outcome/undeclared-
reach policy for boundaries; data-set file existence and the data set's own
schema for `data_sets`) so #144/#145 extend them by importing and layering
rather than forking.

## 7. Two skills only, no third `qa-heal` skill

Restated from the parent spec for anyone reading this file in isolation: exactly
`qa-setup` and `qa-generate` are built. Repair is an explicit mode of
`qa-generate` (`qa-generate repair --evidence ...`); no `qa-heal` directory exists
anywhere in this build source, and none should be added.
