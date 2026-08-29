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

## 8. Named Data Set contract (#144)

(Numbered 8, not 7, because section 7 above already existed when this ticket's
briefing was written; appended here rather than colliding with it.)

**Schema and validator.** `shared/schemas/dynamic-qa-data-v1.schema.json` plus
`shared/scripts/named-data-set.mjs` follow #143's Flow Definition pattern
exactly: strict root keys, `schema`/`id`/`revision` checked the same way,
filename===id, an Issues-collecting validator that reports every problem
rather than stopping at the first, and `parseNamedDataSetFile` combining
restricted-YAML parsing with schema validation. No new YAML-level rule was
added; all of #143's restricted-YAML fail-closed rules (aliases, anchors,
custom tags, duplicate keys, block scalars, flow collections, tabs) apply
unchanged because this module calls the same `parseRestrictedYAML`.

**The no-secret-values rule splits into two kinds of check, deliberately not
blurred together:**

- *Exact, structural:* a fixed denylist of reserved field names
  (`shared/scripts/named-data-set.mjs`'s `RESERVED_FIELD_CATEGORIES`) rejects
  any field literally named for a selector, URL/endpoint, command, or
  adapter-configuration setting, regardless of its value — those belong to
  the Binding or the Execution Profile, never to case data. A field value
  that starts with an unambiguous `scheme://` is rejected the same way
  (`URL_SHAPE_RE`), independent of field name.
- *Secret-value detection* (`shared/scripts/secret-detection.mjs`) is its own
  module, imported by `named-data-set.mjs` rather than folded in, precisely
  because it mixes exact rules (a PEM private-key header, known vendor token
  prefixes such as AWS/GitHub/Slack/Stripe, an HTTP `Bearer` prefix, a
  `scheme://user:pass@host` connection string) with two rules that are
  necessarily heuristic and are labelled as such in every message they
  produce: the three-segment dot-separated JWT shape, and a generic
  high-entropy-opaque-string backstop. The heuristic rules can false-positive
  on a legitimately non-secret opaque identifier (a UUID, a content hash used
  as fixture data); the deliberate choice, given the "safe to review and
  clone" invariant, is to fail closed anyway rather than risk a false
  negative. `secret_handle` names are run through the same detector, since a
  handle is supposed to be a name, never itself shaped like the secret it
  stands in for.

**Cross-file resolution (`shared/scripts/resolve-data-sets.mjs`).** #143 left
a Flow's `data_sets` references checked for shape only (`data-set-refs.mjs`),
never for existence. This ticket adds `resolveDataSetFile(id, { dataSetsDir })`
(reads `<dataSetsDir>/<id>.yaml`, parses and validates it against the Named
Data Set v1 contract, and reports `found: false` for a missing file rather
than throwing) and `resolveFlowDataSets(flowData, { dataSetsDir })`, which
re-applies `validateDataSetReferences` (reused, not forked) and then resolves
every well-formed reference, reporting a dangling reference or an
existing-but-invalid data set with the path rooted at the referencing
`data_sets[<index>]`. This is deliberately kept as its own small, generic
module — not merged into `named-data-set.mjs` or `flow-definition.mjs` — so
#145/#146 can reuse the same "resolve an ID against a directory of
`<id>.yaml` files, using this file-level validator" step (#146's
provenance/drift gate will need the same resolve-and-validate sequence to
fold a data set's digest into the provenance manifest) rather than
reimplementing it.

**Assumption for later tickets.** The `dataSetsDir` a caller passes to
`resolveDataSetFile`/`resolveFlowDataSets` is not itself discovered by this
module — a real invocation is expected to pass `<repository>/qa/data`
(per DESIGN-dynamic-qa-spec.md §5's customer-repository layout). No
assumption is made here about where that directory lives relative to the
Flow file being resolved; that wiring is left to whichever ticket first
drives this end-to-end against a real customer-repository tree (likely
#145's flow+boundary reconciliation or #146's provenance/drift gate).
## 9. Boundary Declaration policy (#145)

**Decision.** `boundaries.mjs` (#143) validates only shape. `boundary-policy.mjs`
(new, #145) layers the cross-cutting policy on top by importing
`validateBoundaries`/`BOUNDARY_TREATMENTS` from it rather than forking it, and
adds two reviewed, human-authored fields to a Boundary Declaration —
`role: owned | dependency` and `volatile: boolean` — plus an `isolation:
{ namespace, cleanup }` block, all optional at the shape layer (so #143's
existing fixtures/tests are untouched) and enforced at the policy layer.

**Why explicit fields instead of inferring from `system`/`behavior` text.**
Guessing which boundary is "the" owned outcome, or which is inherently
volatile (time, randomness, a third party, payments, unverified behaviour),
from free-text keyword matching would be exactly the silent heuristic #143
already refused for judging Expected Outcome prose (see #143's own
`DECISIONS.md` §6 note on "genuinely product language" staying human review).
A rename of descriptive text could silently flip which boundary the policy
treats as owned. `role` and `volatile` make that judgement an explicit,
reviewed field on the Flow Definition itself instead.

**The five enforced rules, each producing a hard error naming the offending
boundary ID, never a warning:**

1. Exactly one boundary declares `role: owned`, and it must stay `treatment:
   real` — a fake cannot prove itself. Zero or more than one `owned` boundary
   is refused.
2. A boundary with `volatile: true` can never be `treatment: real` — third
   parties, payments, time, randomness, and unverified behaviour are
   simulated or forbidden, never real, so tests stay deterministic and
   side-effect free.
3. A `treatment: forbidden` boundary must be honourable: its `side_effects`
   must be `"none"`. A forbidden boundary that also claims real side effects
   cannot be honoured and is refused, never silently downgraded to
   `simulated`.
4. Undeclared external reach fails closed:
   `resolveBoundaryTreatment(id, boundaries)` returns `"forbidden"` for any
   ID not present in the declared list — never `"real"`, never a silent
   pass-through default. Any later ticket that needs to ask "is touching this
   boundary allowed?" (Binding generation, an Execution Profile check, the
   drift gate) should call this rather than reimplementing a
   lookup-with-fallback.
5. A `treatment: real` boundary with non-`"none"` `side_effects` must declare
   `isolation.namespace` and `isolation.cleanup` (both non-empty strings), so
   test order and interrupted cleanup cannot corrupt later runs.

**Left for a later ticket.** Execution Profile honourability — whether a
flow's boundaries can actually be realized by a concrete Execution Profile's
"allowed Boundary IDs, reversible side effects, namespace, cleanup, rate, and
concurrency" (DESIGN-dynamic-qa-spec.md §5.3) — is not built here. That
requires the Execution Profile artifact itself, which no landed ticket has
built yet; `boundary-policy.mjs` only validates the Flow Definition's own
Boundary Declarations for internal consistency. `resolveBoundaryTreatment` is
written so an Execution Profile validator can reuse it directly rather than
reimplementing boundary lookup.
## 10. Posture-specific evidence (#163)

**Extended #162's Fact shape, did not fork it.** Stage 3 needed two new
things a plain `observed`/`reported`/`unknown` Fact cannot express: (a) that
a brownfield observation is evidence, never intended behaviour, until an
accountable human says otherwise, and (b) that greenfield evidence must
trace to an approved ticket or example. Both landed as an extension of
`fact.mjs` rather than a parallel evidence system:

- Two new categories: `brownfield-observation` and `greenfield-source`.
- One new dimension, exclusive to `brownfield-observation`: `intentStatus`
  (`unconfirmed` | `confirmed-intended` | `confirmed-not-intended`), plus
  `confirmedBy`/`confirmedByRole` once it leaves `unconfirmed`. Every other
  category is still forbidden from carrying these fields — `makeFact` and
  `validateFact` both fail closed on the combination, the same posture as
  the pre-existing secret-value checks.

**The only legal path off `unconfirmed` runs through `posture.mjs`'s
`confirmIntent`.** `makeObservationFact` refuses to construct a
pre-confirmed observation (no back door around the interview), and
`confirmIntent` requires a `qa-owner`/`technical-owner` identity —
never `domain-expert`. `canBecomeExpectedOutcome(fact)` is the single choke
point stage 5 (a later ticket) must call before letting an observation
become a Flow contract's Expected Outcome; it is false for `unconfirmed`
*and* for `confirmed-not-intended` — an explicitly confirmed bug must never
qualify either, only `confirmed-intended` does.

**Posture is an explicit declaration, never a repository-shape guess.**
`posture.mjs`'s `evaluatePostureDeclaration` mirrors `authority.mjs`'s
explicit-invocation gate: it accepts only `qa-owner-declaration` /
`technical-owner-declaration` as a `source`, and fails closed
(`posture-not-explicit`) on `inferred-from-repository-shape` or
`assumed-default`. `repositoryShapeSignal` (read-only, via `repo-walk.mjs`)
exists purely to inform the human answering the question — it is
deliberately never accepted as a `source` value itself.

**Greenfield evidence requires an approved source or stays `unknown`.**
`requireApprovedGreenfieldEvidence` is a hard stop when no source, or only
invalid sources, are offered. `buildGreenfieldFact` returns a `reported`
fact (citing the approved ticket/example as evidence) only once a valid
source exists, and `unknown` — never a filled-in assumption — otherwise.

**Domain Expert scoping (AC3) reuses #162, not new code.**
`authority.validateAuthorityRecord` already rejects an unscoped Domain
Expert entry; this ticket's `confirmIntent`/`validateGreenfieldSource` add
the second half — a Domain Expert can never be the *identity* that confirms
intent or approves a greenfield source, only `qa-owner`/`technical-owner`
can. Together these mean a Domain Expert's participation is bounded both by
scope (which flows they may speak to) and by role (they can never act as
the accountable decision-maker).

**Seam left for #164 (stage 4, ranking candidate flows).** Stage 4 is
expected to read `Fact[]` — including `brownfield-observation` facts with
`intentStatus: "confirmed-intended"` and `greenfield-source` facts — as
input to risk/value ranking. Nothing in this ticket writes a ranking or
scoring function; `canBecomeExpectedOutcome` and `buildGreenfieldFact`'s
provenance are the seam #164 should read, not reimplement.

## 11. Binding generation and provenance (#146)

**Decision.** #146 adds five new deterministic-core modules under
`shared/scripts/` — `preflight.mjs`, `provenance.mjs`,
`expected-outcome-coverage.mjs`, `forbidden-patterns.mjs`, and
`binding-verification.mjs` — plus `shared/schemas/dynamic-qa-provenance-v1.
schema.json`. Together they are the whole of what `qa-generate/SKILL.md`'s
generation mode is now allowed to trust: a candidate Binding is accepted or
rejected by this code, never solely by the model that authored it.

**Two gates, not one.** `preflight.mjs` is the *pre*-generation gate: given a
Flow ID, decide whether generation may even be attempted (contract,
lifecycle, approvals, safety, source identity, harness, provenance — in that
order, each with its own stable `reason` code). `binding-verification.mjs`
(composing `expected-outcome-coverage.mjs` and `forbidden-patterns.mjs`) is
the *post*-generation gate: given a candidate's assertions and files, decide
whether it may be accepted. Splitting these matters because the ticket's own
framing is "if the core cannot verify that every Expected Outcome ID is
covered and no forbidden pattern is present, generation fails" — that check
has to run on whatever the generative (agentic) step actually produced, not
on the flow it was asked to realize.

**"Approved" is an explicit input, not a re-derived judgment.** No approvals
field exists on the Flow Definition schema (approvals are a Git/review-
process fact, not repository YAML — `qa-setup`'s Setup Review Packet is the
actual authority). `preflight.mjs` therefore takes
`approvals: { qaOwner, technicalOwner }` as caller-supplied evidence and
refuses to proceed without both being explicitly `true`. It does not
re-implement the approval gate, only refuses to generate without evidence of
it. Likewise, Flow State `active` stands in for "activation conditions
approved" — the "deferred flow + complete Activation Proposal" resumption
path DESIGN-dynamic-qa-spec.md §7 step 1 describes is out of scope until
#150's Execution Profile / Capability Gate machinery exists; `deferred` and
`retired` both stop with `flow-not-active` for now, same as `draft`.

**Digest reuse, not a second scheme.** `provenance.mjs` computes every digest
(`flowDigest`, each data set's digest) via `canonical-digest.mjs`'s
`contentDigest`, over the same validated data models #143/#144 already
produce — never over raw YAML text, never via a new hash function.

**Deterministic ordering is a checked invariant, not a writer habit.**
`provenance.mjs` fixes each record's key order (`RECORD_KEY_ORDER`) and sorts
every order-insignificant collection (`bindings` by `flowId`, `dataSets` by
`id`, `outputs`/`configPaths`/`lockfilePaths` by `path`, `impactPaths`
lexicographically) before serializing, AND `validateProvenanceManifest`
rejects an out-of-order collection as invalid — so a hand-edited or
differently-assembled manifest cannot silently pass by getting re-sorted on
the way out. `generatedAt` is caller-supplied (an injected clock), never
`Date.now()`, so identical inputs always serialize to identical bytes.

**Revision monotonicity is claimed here, per #143's open note.** #143 left
"monotonic non-decrease across revisions" to "the provenance/drift-gate
ticket (#146/#148)". `provenance.mjs` exports `checkRevisionMonotonic`
(reused by `preflight.mjs`'s own gate) rather than leaving it to #148 — #148
should call this function directly on future re-generation rather than
reimplementing the lookup, exactly as `resolveBoundaryTreatment` set the
precedent for #145.

**Forbidden-pattern detection is exact API-name/marker matching, not
sentiment.** `forbidden-patterns.mjs` flags fixed sleeps (`time.sleep`,
`Thread.sleep`, Playwright `waitForTimeout`/`networkidle`, a numeric Cypress
`cy.wait`, the `setTimeout(resolve, N)` JS sleep idiom, shell `sleep N`),
stub/placeholder markers (`TODO`, `FIXME`, "not implemented",
`NotImplementedError`, a literal `PLACEHOLDER`, an always-true assertion),
and skip/pending markers (`.skip(`, `x`-prefixed suites, `.todo(`,
`@pytest.mark.skip`, `@Disabled`, `@Ignore`, `unittest.skip`, `pending(`) —
by fixed regex, one detector function per family so each is independently
Tier-1-tested, deliberately excluding a Cypress *alias* wait (`cy.wait('@x')`)
since that is a real network readiness signal, not a fixed sleep.

**Seams left for later tickets, explicitly:**
- **#147** (test-level inference / adoption): `qa-generate/SKILL.md`'s step
  3 hard-codes "honor `flowData.test_level` as-is, prefer the cheapest layer
  this skill can directly verify" — no inference machinery. Step 2's
  "reuse an existing test" path is a placeholder ("no obviously matching
  existing test" → generate new); #147 owns real adoption detection.
- **#148** (drift gate): consumes `qa/provenance.json`; should call
  `checkRevisionMonotonic` and `validateProvenanceManifest` directly rather
  than reimplementing them. Deterministic-CI enrollment beyond the
  provenance write itself (spec §7 step 5's other half) is #148's, not
  built here.
- **#150** (Execution Profiles / Capability Gate): `executionProfileId` is
  taken as an opaque, caller-supplied semantic ID and required to be
  present; no Execution Profile artifact is read, validated, or
  capability-gated here. `provenance.mjs`'s `executionProfile.digest` field
  is optional until #150 defines what to digest.
- **#152** (negative controls): `qa-generate/SKILL.md` step 6 notes negative
  controls are not yet run; the hook is "verify the candidate once" only.
- **#149** (Browser Binding conventions): untouched; #146's Tier 2 fixture
  and worked SKILL.md example are both non-browser (a small `node:test`
  Binding), deliberately, to avoid inventing selector/hook conventions that
  are #149's to define.

**Revision monotonicity ownership, stated plainly (per the run brief's
ask):** #146 (this ticket) owns and implements it, in `provenance.mjs`,
exported for #148 to reuse.

## 12. Risk ranking and one-flow interviews (#164)

**Ranking never invents a candidate — this is structural, not a review
convention.** `candidate-ranking.mjs`'s `rankCandidateFlows` only reorders
and annotates the exact array of `makeCandidateFlow` results it receives;
there is no function anywhere in the module that can grow that array. A
smaller-than-guidance portfolio is a valid outcome the module is built to
accept, not a gap it tries to close.

**Five factors stay individually visible.** `scoreCandidateFlow` returns
`impact`, `frequency`, `changeExposure`, `escapeHistory` (a raw count,
capped at 3 for scoring, with the raw count also reported), and
`cheaperCoverageExists` (the one factor that SUBTRACTS from the total)
before it ever sums them into `total`. Every one of Tier 1's "does this
factor move the ranking" tests exercises a single factor's change against
an otherwise-fixed candidate.

**Portfolio size is guidance, with an override only above the band, never a
cap that truncates.** `evaluatePortfolioSize` returns `allowed: true`
unconditionally below the 5-10 band (SPEC-135.md story 15's "first-class,
comfortable outcome" is enforced as literally no refusal code path exists
for that case), and requires a reviewed `qa-owner`/`technical-owner`
override (reusing `fact.mjs`'s `CONFIRMING_ROLES`, not reinventing the role
check) only above 10. It never truncates a list on its own — a caller who
gets `allowed: false` must go get review, not silently drop flows.

**Stage 5 assembles and validates, never re-derives #163's or #143's
rules.** `flow-assembly.mjs`'s `evidenceIsEligibleForExpectedOutcome`
delegates brownfield eligibility entirely to `posture.canBecomeExpectedOutcome`
and greenfield eligibility to the `provenance: "reported"` `posture.mjs`
already computes — no `intentStatus` re-reading anywhere in this module.
`assembleFlowDefinition` builds the schema-shaped object and then calls
`flow-definition.mjs`'s own `validateFlowDefinition` — the schema and
fail-closed rules (missing origin ticket, unapproved custom tolerance,
forbidden template markers) are #143's, exercised again end to end here,
never re-implemented.

**A new module, `flow-yaml.mjs`, renders — deliberately not a general YAML
writer.** It only emits the restricted subset `restricted-yaml.mjs` (#143)
accepts (always-quoted scalar strings, `[]`/`{}` for empty collections, no
block scalars or flow collections), so `assembleAndRenderFlowDefinition` can
prove the full "generate → validate → canonical digest is stable" round
trip Tier 1 and Tier 2 both test: render, re-parse, re-validate, and compare
`canonical-digest.mjs`'s digest of the original and re-parsed values.

**Seam left for #165 (stage 6, portfolio reconciliation).** Stage 6 is
expected to read the set of assembled, validated Flow Definitions this
ticket's stage 5 produces (in memory — nothing here writes to the
repository) to find duplicates, contradictions, and shared boundaries
across the whole portfolio. Nothing in this ticket performs cross-flow
reconciliation; `assembleFlowDefinition`'s single-flow validation is not a
substitute for it.

## 13. Test level inference and adoption (#147)

Two new modules in `shared/scripts/`: `level-inference.mjs`
(`selectTestLevel`) and `adoption.mjs` (`evaluateAdoptionCandidate`,
`adoptionGeneratorFields`), plus their `node:test` suites. New prose in
`shared/references/test-level-and-adoption.md`, built into both skills by
the existing generic `references/shared` copy step — no `build.sh` change
was needed. **`qa-generate/SKILL.md` itself is untouched by this ticket**,
per the run brief's strict coordination rule (concurrent tickets #148,
#150, #152, #165 are all touching that file's neighboring steps); the
implementer's report to the run coordinator carries the exact replacement
text for steps 2 and 3 and the exact placeholder prose it replaces.

**Adoption reuses #146's coverage checker; it does not duplicate it.**
`evaluateAdoptionCandidate` calls `expected-outcome-coverage.mjs`'s
`checkAssertionCoverage` on the existing candidate's own claimed
`{ stepId, outcomeId, location }` assertion list — the identical function
and identical shape generation's own step 4 already uses to gate a freshly
authored Binding. "Provable, not optimistic" (the run brief's phrase) is
realized structurally: adoption can only succeed by passing the same
completeness gate a generated Binding must pass, never by a separate,
looser heuristic. A candidate proving only some outcomes, or claiming an
assertion against an outcome the flow does not declare, is
`partial-coverage` and never adopted; an absent or shape-invalid candidate
(no assertion list to check at all) is `no-candidate` /
`unverifiable-candidate` and generation proceeds. Discovering the candidate
and its claimed assertion list from repository source is left to the
skill's own judgment (this is the one place in this ticket's scope that is
genuinely interpretive, not computable) — this module only judges a claim
once discovery hands it one.

**Level inference has no fixed level hierarchy anywhere in the module.** A
candidate is `{ id, safe, provesAllOutcomes, observable, cost }`, where `id`
is an open-ended level name and the three booleans gate elimination
strictly before cost is ever summed. `cost` is five caller-supplied
non-negative numbers — `reuse`, `runtime`, `fixtureComplexity`,
`boundaryFidelity`, `maintenance` — matching the run brief and ticket text
verbatim; `boundaryFidelity` is a cost input here, not an elimination gate,
because a level that can technically prove an outcome only by simulating
away the flow's owned boundary is *expensive*, not automatically
disqualified (a level that cannot prove the outcome at all is `incomplete`
and eliminated regardless of its cost numbers). The lowest total wins, ties
break by ascending `id`. Two tests exist specifically to prove "no universal
API-vs-CLI ranking": one flow shape where `api` wins on cost, and a second,
opposite-shaped flow where `cli` wins with the identical two ids present —
the winner is a pure function of the cost numbers, never a hard-coded
preference.

**A Test Level Override is explicit, reviewed, and still elimination-gated.**
`options.override = { levelId, reviewed, reason }` bypasses cost ranking,
never elimination or the review requirement: `reviewed` must be `true` as
caller-supplied evidence (never defaulted, never inferred from a "seems
important" heuristic — the same discipline #145 already established for
`role`/`volatile`), `reason` must be non-empty, and `levelId` must name a
candidate that survived elimination. Naming an eliminated or absent level,
or omitting/falsifying `reviewed`, fails closed (`ok: false`) rather than
silently falling back to inference.

**Assumption later implementers inherit:** this ticket does not define how
`qa-generate` discovers a candidate's `{ stepId, outcomeId, location }`
list from existing repository test source, nor how it derives each
level candidate's `safe`/`observable`/cost numbers for a concrete flow —
both are skill-prose judgment calls the two modules above take as already-
formed input. Anyone wiring these modules into the real generation flow
(the run coordinator's central `qa-generate/SKILL.md` edit, or a later
ticket) still has to write that discovery/derivation logic; it is out of
this ticket's scope because it is genuinely interpretive, not computable.
## 16. Negative controls (#152)

**Decision.** A new module, `shared/scripts/negative-controls.mjs`, is the
whole of the negative-control gate: "prove that each assertion still fails
for the violation it is supposed to catch" (tickets/152.md) is split into a
pure derivation half and a pure judgment half, with the actual
harness-specific execution left as a documented seam — see the module's own
footer comment and `shared/references/negative-controls.md`.

**Derivation reuses the Flow contract, never invents a violation.**
`deriveDeclaredViolation` reads only what #143/#145 already validate: the
outcome's own `tolerance.kind` (spec 5.1's seven v1 kinds) and, when
declared, the flow's `role: "owned"` boundary (#145's vocabulary — the
boundary the outcome is actually proving something about). Each tolerance
kind gets its own tech-neutral violation statement: `numeric`/`temporal`
name the exact epsilon window the observed value must move outside of;
`presentation` requires breaking a non-ignorable aspect (content, values,
behavior, accessibility, counts), never an ignored one (layout, style,
position); `unordered-set` requires an actual membership change, not
reordering; `custom` has no deterministic notion of what invalidates an
approved comparison, so it surfaces the approver's own `reason`/
`approved_by` rather than inventing one, and is still marked as requiring a
control (`requiresManualStatement: true`), never exempted.
`buildNegativeControlPlan` walks every outcome via
`expected-outcome-coverage.mjs`'s own `collectExpectedOutcomeIds` — a third
declaration-order walk was never written.

**Judgment is fail-closed on the reported execution mode, not just the
result.** `judgeNegativeControl` accepts a `NegativeControlReport` only when
`mode` is the exact literal `"executed"` — no allowance for "probably ran"
exists, so a report claiming `"simulated"`, `"skipped"`, `"assumed"`, or
simply omitting `mode` is rejected as `not-executed` by the same code path,
regardless of what `appliedViolation` claims. Among genuinely executed
reports: `"assertion-passed"` is rejected as `assertion-did-not-fail` (the
always-true-assertion case the ticket exists to catch), and `"crash"`/
`"timeout"` are rejected as `unrelated-failure` — the acceptance criterion
"the control exercises the declared violation, not an unrelated failure
such as a crash or timeout" is a distinct rejection reason from "did not
fail", not folded into it, so a review packet can tell the two apart.

**Coverage is per Expected Outcome, matching #146's own proof model.**
`checkNegativeControlCoverage` requires one accepted control per
`{stepId, outcomeId}` an assertion mapping references — multiple assertions
proving the same outcome share that outcome's one control, exactly as
`expected-outcome-coverage.mjs` treats coverage as per-outcome, not
per-assertion. A missing report is a distinct, named error from a rejected
one, and a later weaker report (e.g. a `"simulated"` report following a
genuine `"executed"` rejection) never silently overwrites an already-good
verdict for the same key, nor can a later report resurrect a key whose only
verdict is a rejection.

**Not built here, and not #152's to build:** actually executing an
assertion against a mutated fixture in a real harness (API/CLI/browser);
wiring this module into `qa-generate/SKILL.md` step 6 (prose integration is
handed back centrally per the run brief's coordination rule — see
`shared/references/negative-controls.md` for the exact replacement text and
placeholder); neighbor-flow verification and the drift gate itself, both
still #148's territory per #146's own seam note.

**Seam left for #160 (guarded repair).** Repair's own verify step
(DESIGN-dynamic-qa-spec.md §7 repair-workflow step 6: "verify the exact
failure, a deterministic negative control, neighboring tests, protected-
contract digests") should call `buildNegativeControlPlan` and
`judgeNegativeControl`/`checkNegativeControlCoverage` directly — the same
Expected Outcome/tolerance/boundary contract is read-only during repair, so
the same derivation applies unchanged. Nothing repair-specific (e.g.
guarding against the repair candidate widening a tolerance to make its own
control pass more easily) is built here; #160 owns making sure a repair
candidate cannot satisfy this gate by changing the contract instead of the
code.
## 14. Deterministic drift gate (#148)

**"Unrelated product changes are not drift" is structural, not a filter.**
`drift-gate.mjs`'s `evaluateBindingDrift` only ever compares digests for the
exact closure of paths a Binding's own Provenance Manifest record already
names — its Flow Definition, its recorded Named Data Sets by id, its two
schema contracts, its recorded harness config/lockfile paths, its recorded
outputs, and its named Execution Profile. There is no code path anywhere in
this module that reads or hashes any other file, so an arbitrary product
source file cannot appear as a mismatch by construction — it is never fed
in, not filtered out. Impact paths stay a downstream "which tests to run"
concern (already the design's own framing), never an input to drift itself.

**"A new bundle release alone is not drift" is the same kind of guarantee.**
`record.generator.bundleVersion` is never read or compared anywhere in
`evaluateBindingDrift`. Only a digest mismatch on the recorded schema
contracts (`record.schemas.flow`/`.data`, against the customer's currently-
installed `qa/schemas/*.json`) or an optional caller-supplied
`isFrameworkSupported` predicate returning `false` can mark a Binding stale
for a "contract" reason — a bundle version bump with every recorded input
otherwise unchanged produces zero mismatches.

**Hand-edited Bindings get their own reason code, not a generic rejection.**
An output-file digest mismatch is reported as `OUTPUT_EDITED` (naming the
edited path(s)), kept distinct from `OUTPUT_MISSING` and from every other
mismatch code. The gate still marks the Binding `stale` — drift blocks until
an explicit adoption or repair proposal verifies the edit and updates
provenance, per DESIGN-dynamic-qa-spec.md §5.5 — but the report vocabulary
never says "rejected" or "overwritten": nothing is deleted or silently
regenerated here. Ownership of hand-edited customer-owned tests is real;
traceability is not lost.

**Reuse, not reinvention, per #146's landed note and the run brief's
instruction:** revision monotonicity is `provenance.mjs`'s
`checkRevisionMonotonic`; manifest shape/ordering is its
`validateProvenanceManifest`; every digest is `canonical-digest.mjs`'s
`contentDigest`. No second digest scheme or provenance validator exists in
this ticket.

**The standalone CI entry point is `drift-gate-cli.mjs`.** `node
dynamic-qa/shared/scripts/drift-gate-cli.mjs [repository-root]` reads only
files already in the repository (`qa/provenance.json`, `qa/flows/*.yaml`,
`qa/data/*.yaml`, `qa/schemas/*.json`, `qa/execution-profiles/*.yaml`, plus
each Binding's own recorded paths) and exits non-zero with an exact reason
per stale/missing Binding — no model, no browser agent, no network call
anywhere in its code. It is deliberately a thin filesystem/CLI shell around
`drift-gate.mjs`'s pure decision functions, which is what Tier 1 actually
unit-tests; the CLI itself is exercised end-to-end (a real fixture
repository, a real hand-edit, a real unrelated file) rather than mocked, and
is left to the acceptance harness / a later CI-wiring ticket to fixture
formally rather than duplicating that proof as a unit test.

**Retired-flow cleanup is flagged, not performed.** `evaluatePortfolioDrift`
reports `RETIRED_FLOW_PROVENANCE` for any record whose flow is retired; nothing
in this ticket deletes that record automatically.

**Assumptions later implementers must know:**
- Execution Profile digest comparison only runs when both the record names a
  `executionProfile.digest` and the gate could resolve
  `qa/execution-profiles/<id>.yaml` — #150 owns that artifact; its absence
  never manufactures a false mismatch here, it just skips the check.
- Adapter/framework contract compatibility is an optional injected predicate
  (`isFrameworkSupported`), not a concrete registry — no adapter-contract
  registry exists yet in this bundle (#149/#150 territory). Whichever ticket
  first defines supported adapters should pass a real predicate into
  `drift-gate-cli.mjs` rather than inventing a second drift check.
- "Incompatible schema" is modeled purely as a digest mismatch on the
  installed `qa/schemas/*.json` contract files versus what a Binding's
  provenance recorded — not as a separate schema-version-string registry.
  A cosmetic reformat of a schema JSON file does not move its digest
  (`contentDigest` canonicalizes key order); a real content change does.
## 15. Execution Profiles and the Capability Gate (#150)

**Modules.** `shared/scripts/execution-profile.mjs` (fail-closed validator +
`checkExecutionProfileHonoursBoundaries`) and `shared/scripts/capability-gate.mjs`
(`runCapabilityGate`, `activationDecision`), +55 Tier 1 tests across
`execution-profile.test.mjs` and `capability-gate.test.mjs`. Schema:
`shared/schemas/dynamic-qa-execution-profile-v1.schema.json`. No fixture
directory was added — every case is exercised through inline JS fixtures in
the two test files (a plain object mutated per case reads more clearly here
than a YAML file per case would, and the profile has no restricted-YAML
authoring surface of its own yet — `qa-setup`'s eventual stage 7 will decide
whether Execution Profiles are hand-authored YAML like Flow Definitions or
machine-assembled the way Provenance Manifests are).

**The artifact is deliberately two layers, matching every other schema in
this bundle.** `execution-profile.mjs` validates that one profile is
well-formed policy — the eight enforceable categories the ticket names
(paths, commands, environments, network, identities, effects, resources,
evidence) are all present and internally consistent. `capability-gate.mjs`
is a second, independent check: does the *actual environment* prove it can
enforce what the profile declares? A profile can be schema-valid and still
fail the gate (e.g. it declares `exact-allowlist` correctly, but the runner
reports `externallyEnforced: false`). Conflating these two would let a
well-written profile stand in for evidence that was never collected.

**A missing capability never degrades to a skip — this is structural, not
convention.** `runCapabilityGate` calls all eight `check*` functions
unconditionally, in a fixed order, and concatenates every blocker found;
there is no early return and no code path that omits a category because a
piece of environment evidence happened to be absent (absence itself
produces a blocker). `activationDecision(gateResult, extraBlockers)` is the
only function callers should use to decide whether to activate, and there
is no code path through it that returns `activate: true` alongside a
non-empty blocker list — `blockers.length > 0` always short-circuits to
`{ activate: false, state: "deferred", blockers }`. A Safety Blocker is
`{ category, capability, message }`: `capability` is always the exact stable
name of the missing/mismatched thing (`network.egress-externally-enforced`,
`identities.no-denied-identity-active`, or the profile's own declared
`evidence.capabilities[].capability` string for provider-adapter evidence),
never a generic "gate failed".

**Network is the security-invariant category, modelled explicitly rather
than left as a preference.** `network.mode` defaults to `"none"`; when it is
`"none"` the schema-shape validator (`assertKnownKeys`) refuses any other
network key at all, so a profile cannot leave stray allowlist config lying
around next to a `"none"` declaration. `"exact-allowlist"` requires, all
simultaneously and all literally `true`/non-empty: a non-empty `allowlist`
of exact single-host `https://` origins (`classifyOriginRisk` in
`execution-profile.mjs` — exported for `capability-gate.mjs` to reuse rather
than re-deriving — classifies each origin as `exact | wildcard | metadata |
internal | malformed`; anything but `exact` is refused at both the profile
level and, redundantly, at the capability-gate level as belt-and-braces),
`dnsRecheck`, `redirectRecheck`, `denyMetadataRange`, `denyInternalRange`,
`denyPublicRange`, and `externallyEnforced`, plus a named
`enforcementMechanism`. **`externallyEnforced` is the one field that encodes
"a permissive hosted runner does not satisfy exact egress" as a fixed
comparison, not a judgement call**: it must be reported `true` by something
outside the test process itself (a network policy, egress proxy, or
firewall); a runner that only relies on the test code's own good behaviour
reports `false` (or omits the field) and the Capability Gate blocks it with
`network.egress-externally-enforced`, leaving the flow `deferred`.

**Honourability (explicitly handed to this ticket by #145) reuses
`resolveBoundaryTreatment` directly, never a fork of the lookup.**
`checkExecutionProfileHonoursBoundaries(profile, flowBoundaries)` checks two
directions: every id in `profile.effects.allowedBoundaryIds` must resolve to
something other than `"forbidden"` against the flow's own declared
boundaries (an undeclared boundary resolves `"forbidden"` by construction,
per #145 — a profile that permits it anyway is unhonourable); and every flow
boundary declared `real` with non-`"none"` side effects must both appear in
`allowedBoundaryIds` and have the profile itself declare
`effects.namespace`/`effects.cleanup` — a profile that omits the isolation a
real-side-effect boundary requires cannot honour it either. This function
returns the same `{ valid, errors }` shape as every other validator in this
module; a caller wires its `errors` into `activationDecision`'s
`extraBlockers` to fold honourability into the same "no open blocker, no
activation" gate.

**Provenance's `executionProfile.id` (#146) stays an opaque reference by
design — this ticket does not touch `provenance.mjs` or its schema.** #146
already requires generation to name a profile by semantic id
(`preflight.mjs`'s `missing-execution-profile-id` check) and left the
artifact and its digest to this ticket. `provenance.mjs`'s
`executionProfile.digest` field is still optional; a later ticket wiring
`buildBindingRecord`'s caller to also pass
`contentDigest(validatedExecutionProfileData)` can fill it in without a
schema change (the provenance schema's `executionProfile` object already
allows `additionalProperties: true` beyond its required `id`).

**Reference doc and the `qa-setup` SKILL.md placeholder — integrated by the
run's central editor, not by this ticket.** Per the run's strict
coordination rule, this ticket does not touch `qa-setup/SKILL.md` or
`qa-generate/SKILL.md`. It adds
`shared/references/execution-profiles.md` (the prose walkthrough of the
schema, the eight-category Capability Gate, the Safety Blocker shape, and
the network/honourability invariants above) and reports the exact
placeholder line in `qa-setup/SKILL.md`'s "Stages not yet built" section for
the central editor to replace:

> `7. **Define safe execution (Execution Profiles, Capability Gate)** —
> placeholder, same scope.`

**Seams left, explicitly, for #151, #153, #166:**
- No stage of `qa-setup/SKILL.md` yet calls `validateExecutionProfile`,
  `checkExecutionProfileHonoursBoundaries`, `runCapabilityGate`, or
  `activationDecision` — this ticket builds the deterministic core only, per
  the run brief's "implement only your ticket" rule. Whichever ticket wires
  `qa-setup`'s stage 7 (safe-execution design) and the activation-approval
  flow should call these four functions directly rather than reimplementing
  any of their logic.
- `preflight.mjs` (#146) still only checks that an Execution Profile ID is a
  valid semantic ID string — it does not load, validate, or gate the
  profile itself. A ticket wiring real activation (this looks like #153's
  territory — Flow State / Enforcement State independence and the
  activation approvals SPEC-135 story 63 describes) should call
  `validateExecutionProfile` and `runCapabilityGate` from inside (or
  alongside) `runGenerationPreflight`, and should treat a non-empty
  `activationDecision(...).blockers` result exactly like this ticket's
  other `{ ready: false, reason, issues }` failures — never proceed past an
  open Safety Blocker.
- Environment evidence (`capability-gate.mjs`'s second `environment`
  argument) is entirely caller-supplied here; no ticket yet discovers it
  from a real sandbox or a real GitHub Actions runner. The provider-adapter
  contract (SPEC-135 story 100, DESIGN-dynamic-qa-spec.md's "provider
  adapter... Execution Profile validation") is the natural place to
  populate it for real, and should shape its adapter output to exactly this
  module's `environment` parameter shape rather than inventing a second one.
- No YAML authoring/rendering surface exists yet for
  `qa/execution-profiles/<profile-id>.yaml` (no `execution-profile-yaml.mjs`
  mirroring `flow-yaml.mjs`). Tests exercise `validateExecutionProfile`
  against plain JS objects; a ticket that needs to read/write the file from
  disk should add a thin restricted-YAML parse/render pair the same way
  `flow-definition.mjs` and `flow-yaml.mjs` do for Flow Definitions, rather
  than growing that concern inside `execution-profile.mjs` itself.
## 17. Portfolio reconciliation (#165)

**A new module, `portfolio-reconciliation.mjs`, is the whole-of-portfolio
computation #164's stage 5 explicitly left open.** It runs six independent
detectors — duplicate flows, contradictory Expected Outcomes, conflicting
boundary treatments for a shared dependency, colliding isolation
namespaces, unresolved Named Data Set references, and candidate-lane
disagreement over a shared real dependency — plus a state-declaration
check that folds in whatever the first six found. Every issue names the
exact flows and fields in conflict; none of them merge, drop, or auto-pick
a side.

**"Unresolved disagreement keeps a flow draft" (SPEC-135 story 39) is made
structurally impossible to bypass, not just documented as a rule.**
`issuesForFlow(report, flowId)` throws rather than returning `[]` when it is
not given a real `reconcilePortfolio` result, so a caller cannot
accidentally read "no report" as "no issues." `evaluateFlowForPortfolio`
and `recordFlowApproval` call it FIRST, before ever inspecting an approval
record; every "this flow has an outstanding issue" path returns `{
approved: false, state: "draft" }` and `recordFlowApproval`'s signature
carries no override, force-approve, or "resolved" parameter that could flip
that outcome. `evaluatePortfolioApproval` rolls per-flow results up to
`portfolioFullyApproved`, which is `false` whenever even one flow stayed
draft — reported as an ordinary, expected stopping point, never an error to
route around.

**The lane-assignment check compares each flow's OTHER signals, not the
shared boundary itself.** A shared real, side-effecting boundary alone
already pushes every flow that declares it toward "nightly" (see
`classifyCandidateLane`); flagging that agreement as a "conflict" would be
noise. `findLaneAssignmentConflicts` instead sets the shared boundary
aside for each flow and asks what its remaining boundaries and test-level
override would imply — a genuine disagreement about the OTHER signals is
what gets named, so this stage does not manufacture false conflicts out of
every flow-plus-flow pair that happens to share a real dependency.

**Exact-YAML review is byte-identical by construction, not by comparison.**
`buildFlowReview` calls #164's `flow-yaml.mjs` `renderFlowDefinitionYAML`
directly — it does not wrap, re-implement, or format-adjust it. There is
exactly one rendering code path in the whole bundle for a Flow Definition's
YAML text; stage 5's Flow Review, stage 6's portfolio review, and any
eventual repository write all go through it.

**Data-set and CI-lane checks stay honest about what they don't know.**
`findDataSetIssues` takes an optional caller-supplied `resolveDataSet`
function (mirroring #144's "caller supplies `dataSetsDir`" contract) and
skips the check entirely when omitted, rather than guessing at resolution.
`classifyCandidateLane`/`findLaneAssignmentConflicts` are explicitly NOT CI
design — no lane, trigger, or job concept exists in the schema yet (that is
stage 9, a later ticket); this is only the coherence signal stage 9 will
need so it does not inherit an unresolved disagreement about how often a
shared risk should run.

**Only the `qa-setup/SKILL.md` stage 6 placeholder was filled in.** No
other stage's prose changed, and `qa-generate/SKILL.md` was not touched, per
the run brief's coordination rule for this ticket.

**Seams left for #166 and #167, explicitly:** neither Execution Profiles,
the Capability Gate (stage 7), Baseline Plans (stage 8), provider-native CI
design (stage 9), nor the Setup Review Packet (stage 10) exist yet. This
ticket's `evaluatePortfolioApproval`/`recordFlowApproval` results
(`approvedFlowIds`, `draftFlowIds`, per-flow approval records) are the
handoff shape later stages should read rather than re-deriving "which flows
are cleared to proceed."

## 18. Browser Binding conventions (#149)

**Modules.** `shared/scripts/browser-conventions.mjs`
(`detectHookConvention`, `validateSelector`, `proposeHook`), +23 Tier 1
tests in `browser-conventions.test.mjs`. `shared/scripts/forbidden-patterns.mjs`
gained three browser-specific fixed-sleep patterns (`selenium-driver-sleep`,
`webdriverio-pause`, `puppeteer-legacy-waitfor`) rather than a second
detector — #146's `detectFixedSleep` already owns "fixed sleep instead of a
bounded readiness signal" for every framework; this ticket only filled a gap
in its pattern set. Reference: `shared/references/browser-bindings.md`.

**Reuse-first, never impose.** `detectHookConvention(files)` counts real
attribute-assignment uses (`data-cy="..."`, not a bare substring match
inside a comment) of each of nine known hook attribute names across the
repository's existing source, and returns the attribute with a strictly
highest non-zero count. Two or more tied at the top is reported
`ambiguous: true` rather than guessed at — SPEC-135's "reuse the deliberate
convention" only holds when the convention is actually unambiguous.
`proposeHook` then follows whatever `detectHookConvention` found, and falls
back to `data-testid` only when nothing was detected — the literal name
`data-testid` is never forced over an equivalent convention already in use.

**A hook is proposed only for a critical or ambiguous point with no stable
selector already**, per SPEC-135 user story 34 and the ticket's acceptance
criteria — `proposeHook` returns `proposed: false` for every other point,
including the reason, so the product is never polluted with a blanket test
attribute. This is a gate on the caller-supplied `{ critical, ambiguous,
hasStableSelector }` flags, not a judgment this module makes itself: the
genuinely generative call — is *this* interaction point actually critical
or ambiguous — stays in `qa-generate`'s prose, per the run brief's
"extract the computation, not the judgment."

**Five forbidden selector classes, one named error code each.**
`validateSelector` rejects, in this checked order so overlaps resolve
deterministically: `xpath-selector`, `dom-position-selector`,
`generated-id-selector`, `hashed-class-selector`, and
`transient-attribute-selector`. A stable role/accessible-name contract
(`getByRole`, `getByLabel`, `[role=]`, `[aria-label=]`,
`[aria-labelledby=]`) is always accepted (`kind: "role-or-accessibility"`),
and a selector targeting a known or caller-supplied hook attribute is
accepted as `kind: "stable-hook"`. Anything else this module does not
specifically forbid is accepted as `kind: "unclassified"` — this ticket
only enumerates what must be refused; it does not attempt to enumerate
every selector shape that is fine.

**Reference doc and the `qa-generate/SKILL.md` placeholder — integrated by
the run's central editor, not by this ticket.** Per the run's strict
coordination rule, this ticket does not touch `qa-generate/SKILL.md` or
`qa-setup/SKILL.md`. It adds `shared/references/browser-bindings.md` (the
prose walkthrough above) and reports the exact text for the central editor
to extend in `qa-generate/SKILL.md`'s generation-mode step 2:

> `2. **Reuse or generate the smallest conforming Binding.** Inspect the`
> `   existing test layout and framework (from the preflight `harness``
> `   descriptor) for a deterministic test already proving every Expected`
> `   Outcome from step 1's `flowData`; adopt it if so. Otherwise author the`
> `   smallest new Binding file that fits the existing layout's conventions —`
> `   this is the one genuinely generative part of this workflow, and belongs`
> `   here in prose, not in the deterministic core. #147 owns the actual`
> `   adoption-detection heuristics; until then, treat "no obviously matching`
> `   existing test" as "generate new".`

The central editor should append (not replace) a sentence such as: "When
the target level is browser, follow
`dynamic-qa/shared/references/browser-bindings.md` for selector and hook
conventions — call `detectHookConvention`, `validateSelector`, and
`proposeHook` from `dynamic-qa/shared/scripts/browser-conventions.mjs`
rather than choosing selectors freehand."

**Seams left, explicitly, for whichever ticket wires real browser
generation:**
- Nothing yet calls `browser-conventions.mjs` from `qa-generate`'s actual
  generation flow or from `binding-verification.mjs`'s candidate-acceptance
  gate — this ticket builds the deterministic core only, per the run
  brief's "implement only your ticket" rule. The natural integration point
  is step 4 (`verifyCandidateBinding`): a browser candidate's selectors
  should be extracted and run through `validateSelector` the same way its
  assertions are run through `checkAssertionCoverage`, and a forbidden
  selector should reject the candidate exactly like a forbidden pattern
  does today.
- Discovering each candidate selector's literal string from a generated
  test file (so it can be handed to `validateSelector`) is not built here —
  this module takes already-extracted selector strings and interaction
  points as input, the same shape of gap #147 flagged for level-inference's
  `safe`/`observable`/cost derivation.
- `detectHookConvention`'s known-attribute list (nine common `data-*`
  names) is a starting set, not exhaustive; a customer with an
  unrecognized attribute name still gets `validateSelector`'s
  `options.hookAttribute` escape hatch, but nothing today auto-populates
  that option from a genuinely novel convention `detectHookConvention`
  cannot name.
