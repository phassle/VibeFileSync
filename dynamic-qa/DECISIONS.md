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

## 19. Trust zones and disposable verification (#151)

**Module.** `shared/scripts/trust-zones.mjs`, 28 Tier 1 tests in
`trust-zones.test.mjs`. No schema, no fixtures — every function takes plain
JS values (zone names, small caller-supplied descriptors), matching how
#150 tests `capability-gate.mjs` inline rather than through fixture files.

**This ticket answers a different question than #150, deliberately not a
parallel safety model.** #150's Execution Profile + Capability Gate decide
whether one Flow's run may activate. This ticket decides whether the *zone
a run happens in* is itself a legal place for that run to be, and whether
the run's content/identity/filesystem/network shape violates the hard
security invariant regardless of which zone it's in. `trust-zones.mjs`
imports `classifyOriginRisk` from `execution-profile.mjs` rather than a
second regex, and every reference to Execution Profile shapes (`paths`,
`network`, `credentials`) mirrors #150's own field names exactly so a
caller can pass the same objects to both layers.

**The four Trust Zones are a fixed, linear pipeline, not a graph.**
`contract-authoring -> candidate-verification -> low-trust-ci ->
privileged-publication` is the only legal direction. `checkZoneTransition`
checks every ordered pair of the four zone names and returns a distinct
named error for each of the 13 illegal ones — categorized as `skip`
(jumping ahead, most importantly `contract-authoring ->
privileged-publication`, which would let untrusted evidence inherit write
authority directly), `backward` (flowing back down the pipeline, most
importantly out of `privileged-publication`), `self-loop`, or
`unknown-zone` — rather than one generic "illegal transition" flag. A test
enumerates all 16 ordered pairs and asserts the 13 illegal ones produce 13
distinct error names, so no two illegal transitions can silently collide on
the same name.

**The hard security invariant is three independent, named comparisons, not
a paragraph.** SPEC-135 User Story 84's exact source list — repository,
application, issue, branch, test, MCP, dependency, action, cache, artifact,
model output — is `UNTRUSTED_CONTENT_SOURCES`, an explicit frozen array,
not an inferred guess. Classification is fail-closed the other direction
too: the *only* content source this module treats as trusted is the
literal string `"reviewed-base-branch"` (DESIGN-dynamic-qa-spec.md §11
zone 4's "separate reviewed base-branch code"); anything else — including a
source absent from either list — classifies untrusted by default.
`checkHardSecurityInvariant` then checks, independently (never
`else if`, so a config violating more than one is reported for all of
them): untrusted content + a privileged credential scope
(`trust-invariant.untrusted-content-with-privileged-identity`, privilege
detected via a `write|push|publish|deploy|admin|protected-branch` scope
pattern — deliberately orthogonal to #150's production/non-production
identity axis, since a non-production service account can still hold
write/publish authority); untrusted content + broad filesystem access
(`trust-invariant.untrusted-content-with-broad-filesystem`, "broad" meaning
`/`, `~`, `$HOME`, or a wildcard path entry); and untrusted content +
unrestricted network reach
(`trust-invariant.untrusted-content-with-unrestricted-network`, "restricted"
requiring both an all-`exact`-origin allowlist per `classifyOriginRisk` and
`externallyEnforced: true` — reusing capability-gate.mjs's own "a permissive
hosted runner does not satisfy exact egress" rule at the zone-assignment
level).

**Authoring isolation from privileged publication is checked twice, on
purpose.** `checkZoneTransition` already refuses the direct
`contract-authoring -> privileged-publication` jump; `checkAuthoringAuthority`
separately refuses `contract-authoring` holding a privileged credential
scope at all, regardless of any attempted transition — so a reviewer
cannot satisfy the invariant merely by not modelling a transition, only by
the authoring zone never being granted write/publish authority in the
first place.

**Disposable, unprivileged, pinned-commit verification is one function,
three named failures.** `checkVerificationCompute({ environment,
sourceCommit })` requires `environment.disposable === true`,
`environment.unprivilegedUser === true` (this module's own field, distinct
from and in addition to #150's `environments.disposable` *profile*
declaration — this checks the concrete compute evidence for *this run*),
and `sourceCommit` matching the exact same 40-hex-character SHA format
`provenance.mjs`'s `validateProvenanceManifest` requires — mirrored, not
imported, since `provenance.mjs` does not export that regex separately.
Environment evidence here is caller-supplied, following #150's established
pattern exactly (say so in the module header rather than pretending it is
discovered).

**Privileged lanes accept exactly two artifact kinds.**
`checkPrivilegedLaneArtifact(zone, artifact)` only constrains
`zone === "privileged-publication"` (every other zone passes unconditionally
— this rule is specific to the one zone the spec says must never become an
execution bridge). `artifact.kind === "code"` gets its own named error,
`trust-zone.privileged-lane-refuses-code`, since executing generated code
directly in the privileged lane is the single most direct execution-bridge
route; every other kind but `"result-envelope"` and `"recompute"` —
including `cache`/`path`/`command`/`url`, the exact artifact classes
DESIGN-dynamic-qa-spec.md §11 zone 4 names — gets the general
`trust-zone.privileged-lane-refuses-artifact`.

**Seams left for #153, #155, #170:**
- No caller anywhere assigns a real run to a Trust Zone yet, or calls any
  function in this module from a `qa-setup`/`qa-generate` stage.
  `preflight.mjs` (#146) and stage 7's wiring (#150's seam, still open)
  are the natural callers.
- `contentSource`, `credentials`, `environment.unprivilegedUser`, and
  `sourceCommit` are all caller-supplied here, exactly as #150 left
  environment evidence caller-supplied. No adapter or sandbox discovers any
  of them from a real filesystem, credential store, or CI provider yet.
- The Result Envelope artifact this module's `checkPrivilegedLaneArtifact`
  accepts is referenced by name only (`kind: "result-envelope"`); no
  schema for its actual contents exists yet. A ticket that defines it
  should keep `trust-zones.mjs`'s acceptance check as the gate, rather than
  duplicating an artifact-kind check elsewhere.
- `qa-setup/SKILL.md`'s stage 7 prose integration is deferred to the
  coordinator — see the exact replacement text and placeholder reported
  separately.

## 21. qa-setup stage 7 safe execution design (#166)

**Modules.** `shared/scripts/safe-execution-design.mjs` (21 Tier 1/2 tests
in `safe-execution-design.test.mjs`) and `shared/scripts/execution-profile-yaml.mjs`
(5 tests in `execution-profile-yaml.test.mjs`) — the YAML authoring/rendering
surface #150 explicitly left unbuilt. `flow-yaml.mjs` gained one new export,
`renderRestrictedYAMLDocument` (the pre-existing renderer body, now named and
exported generically; `renderFlowDefinitionYAML` is now a one-line wrapper
over it with identical behaviour). Reference:
`shared/references/safe-execution-design.md`. `qa-setup/SKILL.md`'s stage 7
placeholder is filled in, superseding both #150's and #151's deferred
inserts for that placeholder — see below.

**This ticket is a composition, not a third safety model, and is
structured to make that checkable rather than asserted.** Every function
`execution-profile.mjs`, `capability-gate.mjs`, and `trust-zones.mjs` already
exported is called directly from `safe-execution-design.mjs`; none of their
logic is reimplemented. Concretely:

- `deriveExecutionProfileFromInventory` (new, this ticket) assembles a
  profile's required sections (`owners`, `allowedPhases`,
  `allowedTestLevels`, `environments`, `paths`, `commands`, `resources`,
  `identities`, `network`, `effects`, `diagnostics`, `evidence`) **only**
  from what a caller-supplied `inventory` object actually names. A section
  `inventory` omits is left OUT of the profile entirely — never filled with
  a plausible default — and produces exactly one named blocker,
  `inventory.<section>-known`. This is "profiles are derived from the
  inventory rather than from defaults" (acceptance criterion 2) made
  structural: there is no branch in this function that invents section
  content. `credentials` alone is treated as legitimately optional when
  absent, because `execution-profile.mjs`'s own validator already accepts
  `credentials: {}` as "no credential required," a real answer, not a gap.
- `checkTrustZoneForExecution` (new, this ticket) composes exactly the
  subset of #151's checks that apply to one run's context —
  `checkHardSecurityInvariant` unconditionally, `checkZoneTransition` /
  `checkAuthoringAuthority` / `checkVerificationCompute` /
  `checkPrivilegedLaneArtifact` conditionally on which zone fields the
  caller supplied — and returns their raw `{ error, message }` issues
  unmodified for the caller to fold in.
- `designExecutionProfile` (new, this ticket) is the sole per-flow decision
  point. It runs, in fixed order: inventory derivation, `validateExecutionProfile`
  (#150), `checkExecutionProfileHonoursBoundaries` (#150, always run —
  never gated behind schema validity passing first, so a reviewer sees
  every gap in one pass), `checkTrustZoneForExecution` (composed above),
  `runCapabilityGate` (#150), and finally hands every blocker collected to
  `activationDecision` (#150) — the exact same non-bypassable function
  #150 already built, never a second one. There is no code path in this
  module that returns an activation result without going through
  `activationDecision`.

**A missing capability is guaranteed to defer, never skip, structurally —
by reusing #150's own guarantee, not a new one.** `activationDecision`
already guarantees "no code path returns `activate: true` alongside a
non-empty blocker list." This ticket's contribution is only to make sure
every one of its OWN four new failure classes (inventory-derivation gaps,
profile-validation issues, boundary-honourability issues, Trust Zone
issues) actually reaches that same function's `blockers` argument rather
than being handled — or silently dropped — anywhere else. `designExecutionProfile`
always returns a result (never `undefined`/`null`, never throws for an
ordinary gap) with a rendered `profileYaml` even when `decision.state` is
`"deferred"`: "a profile is generated before activation is possible" holds
for a deferred flow too — the draft exists and is reviewable, it is simply
not enforceable yet.

**Only #165's approved flows reach profile design, checked the same
fail-closed way #165 itself established.** `designSafeExecutionForApprovedFlows`
reads `evaluatePortfolioApproval`'s `approvedFlowIds` directly and skips
every flow not in that set (i.e. anything #165 left in `draftFlowIds`)
without designing a profile for it at all. It throws — rather than
treating a missing/malformed `portfolioApproval` as "nothing approved" —
mirroring `portfolio-reconciliation.mjs`'s `issuesForFlow` fail-closed
convention exactly, so this stage cannot silently run ahead of stage 6 or
against a stale approval result.

**The YAML authoring/rendering surface reuses `flow-yaml.mjs`'s renderer
directly — there is one rendering path, not two.** `flow-yaml.mjs`'s
internal renderer (previously only reachable through the
Flow-Definition-specific `renderFlowDefinitionYAML`) is now also exported
generically as `renderRestrictedYAMLDocument`; `renderFlowDefinitionYAML`
is unchanged in behaviour, now a one-line wrapper over that same function.
`execution-profile-yaml.mjs` calls `renderRestrictedYAMLDocument` directly
for Execution Profiles rather than duplicating
`renderMappingLines`/`renderSequenceLines` a second time, and calls
`restricted-yaml.mjs`'s `parseRestrictedYAML` directly for the read side
(fail-closed on aliases/tags/duplicate keys, exactly as every other schema
in this bundle) plus `execution-profile.mjs`'s own `validateExecutionProfile`.
No second parser or renderer was written anywhere in this ticket.

**`qa-setup/SKILL.md`'s stage 7 placeholder is filled in, superseding both
#150's and #151's deferred inserts for it — this ticket incorporates both
Execution Profiles/Capability Gate (#150) and Trust Zones (#151) in one
prose section rather than two separate ones.** The status line and the
"stages not yet built" list were both updated (stage 7 moved out of the
placeholder list; the remaining placeholders renumbered 8–10 in place,
content unchanged). Only stage 7's block was touched — `qa-generate/SKILL.md`
was not touched, per the run's strict coordination rule for this ticket.

**Seams left, explicitly, for #167 (stage 8) and #169 (Setup Review
Packet):**
- Nothing writes `qa/execution-profiles/<id>.yaml` to the repository yet —
  stage 7 only produces an in-memory `profileYaml` string for review, per
  this bundle's "nothing is written to the repository until the Setup
  Review Packet's dual approval" rule. The Setup Review Packet ticket is
  the natural place to actually stage the file for the one emitted patch.
- `environment` and Trust Zone `context` remain entirely caller-supplied
  here, exactly as #150 and #151 left them — no provider adapter populates
  either for real yet. The GitHub Actions adapter (#153's territory) should
  shape its output to this module's parameter shapes rather than inventing
  new ones.
- Baseline readiness (stage 8) and provider-native CI design (stage 9) both
  assume this stage's blocker-free, activatable result as their
  precondition — neither should assume a flow can safely run before its
  Execution Profile and Trust Zone assignment clear every blocker here.
- The Result Envelope schema `checkPrivilegedLaneArtifact` gates still does
  not exist (per #151's own seam note); this ticket's composition is ready
  the moment a later ticket defines one.

**Assumption a later implementer must know:** `designExecutionProfile`'s
`context` argument (`zone`, `fromZone`, `contentSource`, `credentials`,
`environment`, `sourceCommit`, `privilegedArtifact`) is optional field by
field — omitting `zone` skips zone-transition/authoring-authority checks
entirely (not a blocker), and omitting `contentSource` classifies as
untrusted by `classifyContentTrust`'s fail-closed default, which still
correctly triggers `checkHardSecurityInvariant` against whatever
`paths`/`network`/`credentials` the profile declares. A caller that wants
zone legality actually checked must supply `zone` explicitly; this stage
does not infer a zone from anything.
## 22. qa-setup stage 8 measurement readiness (#167)

**Module.** `shared/scripts/baseline-plan.mjs`, 28 Tier 1 tests in
`baseline-plan.test.mjs`. Schema doc: `shared/schemas/dynamic-qa-baseline-plan-v1.schema.json`.
Reference: `shared/references/baseline-plan.md`. `qa-setup/SKILL.md` stage 8
filled in.

**The three-state Quantity type is the whole ticket, modeled at the type
level rather than in prose.** A numerator or denominator is always exactly
one of `unknownQuantity()` (no evidence), `notApplicableQuantity(reason)`
(does not apply here, reason mandatory), or `knownQuantity(value)` (a real
measured number — 0 is an entirely ordinary `known` value, distinguished
from `unknown` by tag, never by value). There is no fourth "just missing"
state and no function anywhere in the module that turns `unknown` or
`not-applicable` into a number. `isQuantity` and every consumer
(`metricStatus`, `computeReadiness`) only recognize these three exact
shapes.

**`buildBaselinePlan` has no `readiness` parameter.** Readiness is always
`computeReadiness`'s own derivation from the metrics/window actually
given — there is no argument, override, or force path that lets a caller
assert `ready` ahead of the evidence. `validateBaselinePlan` independently
re-derives readiness and reports a mismatch as an issue, so a hand-edited
YAML file cannot simply declare `readiness: ready` either.

**Two clocks are deliberately kept separate — read this before touching
either.** `validateBaselinePlan`'s anti-fabrication check anchors the
burn-in recompute to `now ?? data.generatedAt`, NOT the real wall clock: a
plan honestly `measurement-required` on the day it was written must stay
*valid* forever after, even once real time quietly clears the 14-day/20-run
burn-in gate — going stale is not fabrication. `resumeBaselinePlan`
separately recomputes *current* readiness against the real (or injected)
clock every call, independent of the stored value's own validity check.
This split is what makes "measurement can span days" true without
rewriting the file in between: do not collapse these two clocks back into
one, or either a stale-but-honest document becomes falsely invalid, or a
day-one document falsely reports `ready` before the burn-in gate clears.

**Resume takes exactly one required argument: `repoRoot`.**
`resumeBaselinePlan(repoRoot, { now })` reads only
`qa/baseline-plan.yaml` (`BASELINE_PLAN_REPO_PATH`) from disk — no cache,
no module-level state, no session identifier. A missing file reports
`{ exists: false, readiness: "measurement-required" }` without error, a
normal starting point rather than a failure.

**Assumption for #169/#171: `RUN_COUNT_METRIC_ID` is pinned to
`pr-check-latency-p95`'s denominator** as the source of "20 relevant
completed PR runs" from SPEC-135's Implementation Decisions. This ticket
never collects a real count; a later ticket that finds a better source
should change this constant deliberately, in one place, rather than
re-deriving the burn-in gate elsewhere.

**No real VibeFileSync baseline data was created or written by this
ticket.** All tests exercise disposable temp directories only.
## 20. GitHub Actions adapter and the advisory PR lane (#153)

**GitHub Actions is the first named provider adapter**
(DESIGN-dynamic-qa-spec.md §9). Two new modules split the concern the same
way #150 split Execution Profile shape from Capability Gate enforcement:
`shared/scripts/github-actions-workflow.mjs` is the pure renderer plus a
reusable hardening detector; `shared/scripts/github-actions-adapter.mjs` is
the seven-point provider-adapter contract (detect, prove capability
evidence, render without deciding policy, name supported triggers, publish
JUnit/annotations/summary, resolve a run reference, validate that generated
configuration enforces the profile). Only the advisory pull-request lane is
built. Required and quarantine lane rendering (contract point 3 names all
three) are an explicit seam for a later ticket, reusing the same hardening
detector rather than duplicating it.

**The hardening detector is the acceptance mechanism, not just the
renderer's own self-check.** `checkWorkflowHardening(yamlText)` scans
arbitrary rendered/mutated workflow YAML text (a targeted line-scanner, not
a general YAML parser — no dependency added) and names, individually, any
of: missing/non-minimal `permissions`, a checkout step missing
`persist-credentials: false`, a tag-pinned (not full-40-hex-SHA-pinned)
action, the unsafe `pull_request_target` trigger, a job missing
`continue-on-error: true` (which is how the advisory lane is structurally
prevented from ever failing the merge gate — GitHub Actions' own documented
job-level mechanism, not a policy convention this bundle merely asks for), a
referenced secret, a requested OIDC `id-token: write` permission, a
declared protected environment, a granted write permission scope, a
privileged cache action, or a self-hosted runner label. Every one of these
has its own Tier 1 test that mutates one property at a time and asserts the
exact named code — proving each is *individually* detected, never bundled
into one generic "unsafe" flag.

**No third-party action beyond `actions/checkout` and `actions/setup-node`,
both full-commit-SHA pinned.** Native GitHub Actions annotations and the job
summary are produced by this bundle's own zero-dependency scripts
(`github-actions-annotations-cli.mjs`, `github-actions-summary-cli.mjs`)
reading a restricted-subset JUnit XML parser (`junit-report.mjs`, refuses an
`<!ENTITY` declaration and any processing instruction beyond the XML
declaration) rather than adding and pinning a third-party JUnit-reporter
action — one fewer supply-chain dependency to pin, verify, and keep current.
**Action-pin freshness is an explicit, named assumption, not a silent
claim**: the deterministic core has zero network access and cannot itself
resolve "the current commit behind tag vX" — the two SHAs shipped are
placeholders shaped as real pins, flagged in the module header for
re-verification before the generated workflow is ever enabled for a real
repository (the pilot, #171-175, is deliberately not being run yet).

**The Node-runtime caveat is a Safety Blocker, never a silent skip.** Node
is guaranteed on a developer machine and a GitHub-hosted runner, but not
automatically on a minimal self-hosted runner. The renderer always emits an
explicit `actions/setup-node` step (never assumes an ambient `node`); the
adapter additionally requires the Execution Profile to declare a
`runtime.node-available` capability at all
(`checkNodeRuntimeCapabilityDeclared` — #150's generic Capability Gate only
checks a capability that IS named, so a profile author omitting it entirely
would otherwise sail through unblocked) and the environment to report that
exact capability `met`. `planAdvisoryPullRequestLane` composes this check
with `runCapabilityGate`/`activationDecision` (#150, reused) and never
returns a rendered workflow while either has an open blocker — the missing/
unmet case returns `{ rendered: false, state: "deferred", blockers }`,
mirroring #150's own "no default-open path" invariant exactly.

**The Result Envelope schema is defined** (#151 explicitly left this open):
`shared/schemas/dynamic-qa-result-envelope-v1.schema.json` plus
`shared/scripts/result-envelope.mjs`. Small, non-executable (a closed schema
with no free-form script/command/path/URL field defined at all — nothing
here a privileged lane could "run"), schema-validated, and independently
size-bounded (`MAX_ENVELOPE_BYTES` = 16 KiB, checked separately from shape
validity — an oversized-but-shape-valid envelope is still refused).
`validatePrivilegedResultEnvelopeArtifact` composes
`trust-zones.mjs`'s `checkPrivilegedLaneArtifact` (#151) as the sole zone
gate — reused, never duplicated — before this module's own shape/size
checks run.

**`preflight.mjs`'s safety check (step 4) now validates the actual
Execution Profile artifact and proves it enforceable, not just an ID
string** (#150's explicit hand-off: "preflight.mjs still only checks the
profile ID is a valid semantic string, not the artifact"). Four sub-checks,
in order, none skippable: 4a. the id is a valid semantic string (unchanged);
4b. `<executionProfilesDir>/<id>.yaml` resolves and passes
`validateExecutionProfile` (#150, reused) — reason
`invalid-execution-profile`; 4c. the resolved profile honours the flow's
own Boundary Declarations via `checkExecutionProfileHonoursBoundaries`
(#150, reused) — reason `execution-profile-boundary-mismatch`; 4d.
`environmentEvidence` is now a REQUIRED input (never optional — an absent
environment is its own distinct failure, `missing-environment-evidence`,
never silently skipped, per #150's "absence of an environment section is
itself a blocker" note) and, once present, `runCapabilityGate`/
`activationDecision` (#150/#151, reused) must pass or the call fails
closed with reason `execution-profile-capability-blocked` and `issues` set
to the exact named blockers. `runGenerationPreflight`'s success payload now
also returns the resolved `executionProfile`. `qa-generate/SKILL.md`'s step
1 prose was updated to match (this is squarely preflight.mjs's own
description, not qa-setup/qa-generate stage territory the concurrent
tickets own).

**Sharding is not introduced.** `renderAdvisoryPullRequestLane`'s
`testCommand` is a single precomputed command string; the seam for a
matrix strategy exists (a caller could pass several `testCommand`s once
measured runtime data justifies it) but nothing here adds one.

**Seams left for #154, #155, #157, #158, #168:**
- Nightly full suite, manual/provider-API trigger, and merge-group trigger
  (DESIGN-dynamic-qa-spec.md §8's other three Provider-native CI exposures)
  are named (`DEFERRED_TRIGGERS`) but not built — only `pull_request`
  (`SUPPORTED_TRIGGERS`).
- Impact-path-based Binding selection ("only the Bindings relevant to the
  change") is not implemented — `testCommand` is caller-precomputed.
- Required-lane and quarantine-lane rendering are not built — only
  `renderAdvisoryPullRequestLane` exists.
- Full semantic inventory of an existing arbitrary workflow's content
  (adapter contract point 1) stays filename-level only —
  `detectProviderConfiguration` never parses third-party workflow YAML.
- Wiring `planAdvisoryPullRequestLane`'s invocation into
  `qa-generate/SKILL.md`'s own step sequence is left to a coordinated
  follow-up — see `shared/references/github-actions-adapter.md` for the
  exact contract a wiring step should call, and that SKILL.md's step 5 note
  for the placeholder pointer.
- Action-pin SHAs (`CHECKOUT_ACTION_SHA`, `SETUP_NODE_ACTION_SHA`) need
  re-verification against real upstream tags before first real rollout.

## 26. Failure diagnosis axes (#158)

**Failure Owner and Repeatability are two genuinely independent axes, and
Failure Class is derived, never assigned** (DESIGN-dynamic-qa-spec.md §5.6
and §12). `shared/scripts/diagnosis.mjs`'s `deriveFailureClass(owner,
repeatability)` is the single source of truth for the full 4 x 3 = 12
combinations — the design table's own collapsed rows ("Product / any",
"Binding or Environment / intermittent") are expanded here explicitly so
every combination has exactly one documented answer, not an inferred one.
Schema: `shared/schemas/dynamic-qa-diagnosis-v1.schema.json` (human-readable
contract only, same split as every other schema in this bundle — the actual
hand-written, fail-closed validation is `validateDiagnosisRecord`).

**A retry pass never proves flake — enforced structurally, not by
convention.** The Diagnosis Record's `repeatabilityBasis` field names what
actually grounds a repeatability call (`retry-pass | reproduction |
hypothesis-probe | historical-evidence | external-report |
insufficient-evidence`). `validateDiagnosisRecord` rejects any record where
`repeatabilityBasis === "retry-pass"` and `repeatability !== "unknown"` — a
single passing retry can justify neither "intermittent" (flake) nor
"deterministic" (fixed). The retry itself is still recorded honestly, as an
attempt of `kind: "retry"` in the record's own `attempts` list; nothing in
this module derives a repeatability conclusion from that list.

**A failed attempt stays failed, by construction of an append-only API, not
by promise.** `attempts` only grows via `appendAttempt`, which re-freezes
every prior entry and copies it verbatim rather than editing in place,
and refuses a second `kind: "original"` attempt outright (there is no
function anywhere in this module that can replace or edit an existing
entry). `assertOriginalAttemptStaysFailed(before, after)` compares the
`original` attempt across two attempts-list snapshots and throws on any
field drift, including a changed verdict. Verified across the full
retry -> repair-verification -> quarantine-check sequence in
`diagnosis.test.mjs`.

**Routing by owner is structural, not a policy note.** A Product Regression
carries no Binding-mutation field anywhere on the Diagnosis Record schema —
there is nowhere to put one, so a test cannot hide changed behaviour even
by accident. An Environment Failure (`owner: "environment"`) requires a
non-empty `failedCapability` — the validator rejects a vague "infra
flaked". Binding Defect is the only class this ticket makes eligible for
repair.

**Repair eligibility defaults to ineligible.** `isRepairEligible(record)`
first runs the record through `validateDiagnosisRecord` (a malformed record
is ineligible, full stop), then requires simultaneously `status ===
"confirmed"`, `owner === "binding"`, and `failureClass ===
"binding-defect"`. This is narrower than "any confirmed Binding-owned
diagnosis": the `binding` + `intermittent` (Test Flake) combination is
confirmed and Binding-owned but is **not** granted general repair
eligibility here — DESIGN-dynamic-qa-spec.md §12's policy table names a
distinct, narrower "optional Binding stabilization" action for that row,
left for #159/#160 to build if they choose to. `isRepairEligible` never
throws; an input it cannot make sense of is ineligible, not an exception a
caller must remember to catch.

**`qa-generate/SKILL.md` was not touched** (owned elsewhere per run
coordination). Its repair-mode step 3 placeholder — "Diagnose Failure Owner
and Repeatability, emit a Diagnosis Record — placeholder, same scope." —
and step 4's gate placeholder are the exact seams a later wiring ticket
should replace with calls into `deriveFailureClass` /
`validateDiagnosisRecord` / `isRepairEligible`. See
`shared/references/failure-diagnosis.md` for the full routing table and
the seam note.

**Not built here (left for #159/#160/#157):** the actual repair proposal,
negative-control gate, and Repair Review Packet (#159/#160); Quarantine
Record shape and expiry (#157's territory — Flow State / Binding Freshness
/ Enforcement State lifecycle axes are deliberately not modelled by this
module); a Failure Evidence Bundle schema/validator (referenced by DESIGN
§5.6 as a companion artifact, distinct from the Diagnosis Record this
ticket builds); and wiring this module's functions into
`qa-generate/SKILL.md`'s actual step sequence.
## 25. Flow State, Binding Freshness and Enforcement State (#157)

**Three axes, three existing owners — nothing redeclared.** `Flow State`
(`draft`/`deferred`/`active`/`retired`) already lives in
`flow-definition.mjs`'s `FLOW_STATES` (#143); `Binding Freshness`
(`absent`/`current`/`stale`) is already mechanically derived by
`drift-gate.mjs`'s `FRESHNESS_STATES` (#148); `Enforcement State`
(`advisory`/`required`) already lives in `provenance.mjs`'s
`ENFORCEMENT_LANES` (#146/#153). New module `shared/scripts/lifecycle-
state.mjs` (43 tests, `lifecycle-state.test.mjs`) re-exports all three
rather than inventing a fourth copy, and adds only the rules layer: allowed
Flow State transitions, the nine-requirement Activation checklist,
brownfield/greenfield enforcement defaults, and Qualifying-Run-based
promotion. Reference: `shared/references/lifecycle-axes.md`.

**"A failure must never silently rewrite policy" is enforced structurally,
not by convention.** Each axis has exactly one function that can change it
(`applyFlowStateChange`, `applyBindingFreshnessReport`,
`applyEnforcementPromotion`), and each declares a fixed, tiny delta-key set
(`{to, context}` / `{freshness}` / `{qualifyingRunSummary, approval}`).
Every one of the three rejects on shape alone — before any transition logic
runs — when the delta carries a key outside its own set. A real
test-runner result (`{passed, bindingId, failureReason}`) shares no key
name with any of the three sets, so it cannot even be constructed as an
argument that would express a state change to any of them; there is no
parameter path from "a test failed" into a state change to close off,
because none exists to begin with. On success each function spreads the
caller's record and replaces exactly its own key, so the other two axes
pass through unmodified by construction. There is also no reverse-direction
function anywhere (no "demote enforcement", no "mark stale") — the
guarantee is the absence of the function, not a guard sitting in front of
one.

**Activation: nine requirements, all checked, first-unmet named.**
`checkActivationRequirements(evidence)` runs all nine of the ticket's named
requirements unconditionally (approved product behaviour, deterministic
observability, stable interaction points, isolated data and cleanup,
enforceable boundaries, a passing Capability Gate, a verified candidate
Binding, current provenance, both approvals — the last one reusing
`authority.mjs`'s `qaOwnerGate`/`technicalOwnerGate` shape directly rather
than a bespoke boolean pair) and reports every unmet one, naming the first
as the refusal reason. `decideFlowActivation` mirrors #150's
`activationDecision` shape: no path returns `activate: true` with any
requirement unmet. Note: DESIGN-dynamic-qa-spec.md §8 restates the same
requirements at slightly finer granularity (splitting "generated/adopted
candidate" from "isolated verification" where the ticket's own text
combines them as "a verified candidate Binding") — not a real conflict, the
ticket's nine-item list is what is implemented, per the run brief's
tie-break rule.

**Flow State transitions** follow DESIGN-dynamic-qa-spec.md §8's table
exactly (`retired` never appears as a `from`, which is the whole terminal
rule). `active -> deferred` refuses when `suspension.reason` is
`test-failure`/`flaky`/`slow`/`inconvenient` — suspension is an exceptional
reviewed decision the flow genuinely cannot run, never a red-suite escape
hatch. `-> retired` requires `retirement.approvedBy` plus
`bindingRemoved: true` and `ciEnrollmentRemoved: true` together, and
returns an `auditRecord` on success — retirement is a reviewed contract
change, never implicit.

**Brownfield vs. greenfield:** `resolveActivationEnforcementDefault`
returns `advisory` for `"brownfield"`, `required` for `"greenfield"`, and
refuses (`enforcementState: null`) on anything else rather than guessing a
third default.

**Promotion models exactly the ticket's own gate, not the pilot's full
measurement.** DESIGN-dynamic-qa-spec.md §8's full Burn-in Qualification
(14 days, 20 Qualifying Runs, five commits, 100 executions, ≤1%
flake/false-positive, PR-fast p95 budget, continuous safety/provenance
health, ...) is explicitly the pilot's job (#171-175) — nobody fabricates
that measurement here. `decidePromotion({ qualifyingRunSummary, approval })`
requires both `qualifyingCount >= MIN_QUALIFYING_RUNS` (20) and an explicit
`{ granted: true, approver }`; the parameter shape has no `elapsedDays` or
`greenStreak` field at all, so neither can promote alone — the exclusion is
structural, same technique as the cross-axis-write guard above.

**Seams left for #161 and #172:** no on-disk storage/schema wiring (this
module operates on plain in-memory lifecycle records and evidence a caller
assembles); no `qa-setup`/`qa-generate` `SKILL.md` wiring (neither file was
touched, per this ticket's coordination note); the nine activation
booleans (`capabilityGatePassed`, `provenanceCurrent`, etc.) are entirely
caller-supplied — wiring them to real `runCapabilityGate` (#150) and
`evaluateBindingDrift` (#148) results is left to the caller; quarantine and
Failure Owner/Repeatability are explicitly out of scope (#158's territory)
and this module's guarantees hold regardless of how #158 eventually
classifies a failure, because no failure-shaped object can be expressed as
a delta to any axis to begin with.
## 27. qa-setup stage 9 provider-native CI design (#168)

**Ordering is structural, not a convention.** `shared/scripts/ci-design.mjs`'s
`designProviderNativeCI` throws unless
`portfolioApproval.portfolioFullyApproved === true` (#165's own field) —
there is no code path that reaches lane assignment, the smallest-diff
choice, or the proposal artifact for a portfolio with any flow still in
`draftFlowIds`. This is deliberately stronger than #166's per-flow gate:
SPEC-135 story 45 is about the whole portfolio, not one flow's readiness.

**Real lane assignment is this ticket's own job, not #165's
`classifyCandidateLane`.** #165 was explicit that its lane signal
(`pr-fast-candidate` / `nightly-candidate`) is a coherence check only, with
no lane/trigger concept in its schema. `assignFlowLane` treats that signal
as one input among three: the required trigger it implies, whether the
flow's own #166 `designExecutionProfile` result actually activated, and
whether #153's GitHub Actions adapter can render that trigger today
(`SUPPORTED_TRIGGERS` vs. `DEFERRED_TRIGGERS`). A flow failing either of
the latter two never gets a lane; `assigned: false` always names why
(`execution-profile-not-activatable` or
`trigger-not-yet-supported-by-adapter`, with the exact deferred-trigger
label in the second case).

**Not hard-coded to "only pull_request exists."** `LANE_TRIGGERS` names all
four Provider-native CI exposures (PR-fast, nightly-full, manual,
merge-queue) up front. Availability is decided at call time against
caller-supplied `supportedTriggers`/`deferredTriggers` (defaulted to, never
copied from, #153's own exported lists) — this is the concrete seam for
#154's concurrent work: once the adapter's `SUPPORTED_TRIGGERS` grows, this
module's lane assignment widens automatically, with a dedicated test
(`assignFlowLane picks up a newly supported trigger with no code change`)
proving it.

**Smallest diff is decided on real numbers, not a reflexive new file.**
`summarizeCiInventory` groups #162's own CI Facts
(`inventory-ci.mjs`'s `scanCiWorkflows`) by each fact's own `evidence`
field to reconstruct which existing workflow already has which
trigger/runner. `chooseSmallestDiff` scores every workflow with a real,
hosted runner as an amend candidate (its estimated diff is the job-block
slice of the exact YAML `renderAdvisoryPullRequestLane`, #153, would
produce for a new file, plus a small named constant only when the required
trigger is not already present) against that same renderer's actual
full-file line count, and prefers amend on a tie or smaller estimate.
Applied to this repository, `.github/workflows/acceptance.yml` already has
a matching `pull_request` trigger and a real hosted runner (`macos-14`) —
amending it, not adding `dynamic-qa.yml`, is what stage 9 proposes here. A
self-hosted-only workflow is never proposed as an amend target. Tested both
ways: amend-preferred (an eligible, matching existing workflow) and
new-file (no eligible workflow inventoried, and separately, a self-hosted-
only workflow).

**The proposal cites only real, inventoried infrastructure.**
`namedInfrastructure` (runners, environments, triggers, existing workflow
paths) is read straight from the CI Facts summary, never invented.
`runnerMatchesInventory` separately flags when an Execution Profile's own
`runnerClass` was never actually observed in the CI inventory, rather than
silently treating an unobserved runner as reusable.

**`qa-setup/SKILL.md` stage 9 is filled in.** Its own STATUS line and stage
8 cross-reference are corrected too (ticket #167 had already landed stage
8's content but left STATUS saying "stages 1–7 built... 8–10 remain
placeholders" — a stale line this ticket did not want stage 10's future
implementer to trust).

**Only the advisory lane is ever proposed** (`enforcementState:
"advisory"` on every assigned lane) — #153 built no required/quarantine
renderer, and inventing an enforcement state this module cannot actually
render would be exactly the kind of guess the run brief forbids.

**Seams left for #169 and beyond:**
- No actual amend-renderer exists — this module decides whether to amend
  and estimates its size, but producing the exact merged YAML for an
  existing third-party workflow file is left to whichever ticket wires
  this proposal into a real patch (stage 10's Setup Review Packet, or a
  later `qa-generate` step).
- Nightly-full, manual/API, and merge-group lanes stay `assigned: false`
  until #154 lands their triggers in the adapter.
- `github-actions-workflow.mjs` and `github-actions-adapter.mjs` are
  untouched by this ticket — #154/#155's concurrent edits to those modules
  land independently; this ticket only ever calls their exported
  functions/constants.
## 24. Low-trust hardening and diagnostics scrubbing (#155)

**Completes #153's hardening with allowlisting, and adds the diagnostics
scrub/suppress gate the spec's §11 "Safe execution" requires.** Two new
modules, both reusing rather than duplicating what #144/#151/#153 already
built: `shared/scripts/diagnostics-scrub.mjs` and
`shared/scripts/workflow-hardening.mjs`. No edit was needed to
`github-actions-workflow.mjs` — the new module imports only its
already-exported `CHECKOUT_ACTION_SHA`/`SETUP_NODE_ACTION_SHA` constants, so
concurrent work on that file (#154) is untouched.

**Diagnostics scrubbing reuses #144's secret detector, not a second one.**
`secret-detection.mjs` gained two free-text variants of its existing
patterns — `redactSecretsInText` (finds and replaces every secret-shaped
substring in a blob) and `textStillContainsSecretShapedValue` (re-scans for
verification) — because `detectSecretValue` only judges one anchored
scalar, and a log/DOM/trace/JUnit body is prose containing many values.
Every pattern mirrored down is the exact same rule, never a new one.

**The five diagnostic kinds this ticket names split into exactly two
buckets, matching the spec's two retention windows:** rich (log, dom,
trace, screenshot — off by default, failure-only when enabled, 7-day
retention) and bundle (junit — always produced, scrubbed, 30-day
retention). `prepareDiagnosticForUpload(kind, diagnostic, opts)` is the
single entry point; `buildDiagnosticsManifest` turns a caller's list into
an exact (never globbed) artifact manifest plus a withheld list with named
reasons.

**Scrub failure suppresses upload — structurally, not by convention.**
`prepareDiagnosticForUpload` is the only function that can return
`{ upload: true, artifact }`, and every text-kind path reaches that only
after `redactSecretsInText` runs AND `textStillContainsSecretShapedValue`
re-scans the redacted output and returns `false`. No branch skips the
re-scan; no other exported function hands back raw or redacted content, so
there is no side door to an unscrubbed upload. Screenshots (the one binary
kind) have no in-process scrub at all — no image parser exists or will be
added — so they are suppressed outright absent an explicit,
externally-verified `verifiedRedacted: true`; suppression is their only
possible outcome from this module, never redaction. An oversized artifact
is likewise suppressed rather than truncated, since truncation could cut a
redaction placeholder in half. The one dependency-injection seam
(`opts.verify`) exists solely so this ticket's own tests can force the
"cannot trust this scrub" branch deterministically; production callers
never override it.

**Action/reusable-workflow allowlisting completes #153's SHA-pinning.**
`checkActionAndReusableWorkflowAllowlist` scans every `uses:` reference
(action step or reusable-workflow call — identical YAML shape) and names,
individually: `action.not-pinned`, `action.not-allowlisted`, and
`action.sha-mismatch` (an allowlisted identity re-pinned to an unapproved
SHA needs fresh approval, not silent acceptance).
`DEFAULT_ALLOWLISTED_ACTIONS` names exactly #153's two actions; growing it
is an explicit caller choice, never assumed.

**A privileged lane refuses low-trust code and artifacts, on both the
YAML-shape and the data axis.** `checkPrivilegedLaneRefusesLowTrustBridge`
detects the "pwn request" bridge shape in workflow text: a privileged job
(secrets/OIDC/protected-environment/write-permission) declared alongside a
`pull_request_target`/`workflow_run` trigger, or downloading an artifact
with no visible Result Envelope validation reference.
`assertPrivilegedJobRefusesArtifact` is the structured-data form, composing
trust-zones.mjs's `checkPrivilegedLaneArtifact` (#151) directly — the sole
gate, never re-implemented. The advisory PR lane itself is proven, by this
ticket's test, to carry none of the six privileged identities an unreviewed
PR job must never receive, reusing `checkWorkflowHardening` rather than a
hand-rolled re-scan.

**Seams for #156/#170:** no required/quarantine lane renderer exists yet to
wire the bridge check against beyond this ticket's own fixtures; no caller
wires `prepareDiagnosticForUpload`/`buildDiagnosticsManifest` into a real
generated workflow step, the Failure Evidence Bundle schema (§5.6), or
`retention-days` on a rendered `actions/upload-artifact` step; no real
Playwright trace/DOM/screenshot capture pipeline feeds this module's
`{ text }`/`{ bytes, verifiedRedacted }` shape yet. Per the run brief,
`qa-generate/SKILL.md` was deliberately not edited — see
`shared/references/diagnostics-and-hardening.md`'s closing section for the
exact placeholder text a later coordinated edit should add to that
skill's step 5.
## 23. Nightly, manual and merge-group lanes (#154)

Completes DESIGN-dynamic-qa-spec.md §8's four Provider-native CI exposures:
#153 built `pull_request`; this ticket adds `schedule` (nightly full suite),
`workflow_dispatch` (manual/provider trigger), and `merge_group`.
`SUPPORTED_TRIGGERS` in `github-actions-adapter.mjs` now names all four;
`DEFERRED_TRIGGERS` is empty.

**Three new renderers in `github-actions-workflow.mjs`**
(`renderNightlyFullSuiteLane`, `renderManualTriggerLane`,
`renderMergeGroupLane`) and three matching plan functions in
`github-actions-adapter.mjs` (`planNightlyFullSuiteLane`,
`planManualTriggerLane`, `planMergeGroupLane`), each composing the
Node-runtime declaration check, the Capability Gate, and its own renderer
exactly like #153's `planAdvisoryPullRequestLane` — no default-open path for
any of the four lanes. `renderAdvisoryPullRequestLane` itself is untouched
(additive-only edit, since #155 also edits this file concurrently).

**Gating semantics differ by lane, deliberately.** Nightly and manual stay
ADVISORY (`continue-on-error: true`) — neither is tied to a merge decision at
the moment it runs. Merge-group is REQUIRED — it deliberately omits
`continue-on-error`, because the entire point of a merge-group trigger (spec
§8, SPEC-135 User Story 68) is that its result gates the merge queue's
required checks; masking its failure would defeat the lane's reason for
existing. `checkWorkflowHardening` gained a `lane` option
(`"advisory"` | `"required"`, default `"advisory"` — unchanged #153
behaviour) so it can flag BOTH directions: `advisory.not-continue-on-error`
when an advisory lane is missing it, and the new
`required.continue-on-error-present` when a required lane wrongly has it.
The repository operator must still add the merge-group job's name to branch
protection's required-status-checks list — this adapter renders the workflow,
it does not reach into repository settings.

**A manual/provider trigger cannot change policy by construction, not
convention.** `renderManualTriggerLane` emits `workflow_dispatch: {}` with NO
`inputs:` block at all — there is nothing in the trigger for a coding agent
or MCP integration to set, so a request cannot influence the command, runner,
permissions, or identity this renderer already fixed from the Execution
Profile. `checkWorkflowHardening` gained a `trigger` option and a new
`dispatch.inputs-not-permitted` check that fires if mutated YAML adds inputs
back in, and a `trigger.missing-declared-event` check (replacing #153's
PR-only `trigger.missing-safe-pull-request-event`) generalizes "the expected
event is actually declared" across all four triggers. `pull_request_target`
stays forbidden unconditionally, regardless of trigger.

**The trust asymmetry is modeled via `trust-zones.mjs`, not copied blindly.**
New `classifyLaneContentSource(triggerName)` in `github-actions-adapter.mjs`
maps `pull_request`/`workflow_dispatch` to `"branch"` (untrusted — a fork PR
head, or a manual dispatch against a caller-selected ref this adapter cannot
verify is reviewed) and `schedule`/`merge_group` to `"reviewed-base-branch"`
(trusted — the default branch tip, or a merge queue's already-individually-
approved constituent PRs). `checkLaneTrustInvariant` composes this with
`checkHardSecurityInvariant` (#151, reused). The classification is real, not
decorative: an identical permissive identity/paths/network shape is accepted
for `schedule`/`merge_group` content and rejected for `pull_request`/
`workflow_dispatch` content (tested). The deliberate conclusion, however, is
that every lane this ticket actually renders keeps the same minimal identity
(no secrets, no OIDC, no write permission, no privileged cache, no
self-hosted runner) regardless of trust zone — none of the four lanes has a
functional need for more than checkout + deterministic test run + JUnit/
annotations/summary publication. Trust classification says what would be
PERMITTED; least privilege says none of the extra room is USED.

**`checkGeneratedConfigEnforcesProfile` gained an optional third parameter**
(`{ lane, trigger }`, both defaulting to #153's original values) so each
lane's post-render enforcement check runs against its own correct gating and
trigger expectations. Additive; every existing call site (`profile, yaml`)
is unaffected.

**Sharding is still not introduced.** All three new renderers keep #153's
single precomputed `testCommand` seam — nightly's is expected to be the full
active portfolio rather than an impacted subset, but which string to pass is
a caller/adapter concern, not this ticket's. No runtime measurement exists
yet (the pilot, #171-175, has not run), so no matrix strategy is added,
matching spec §8 / SPEC-135 User Story 70 exactly.

**Documentation:** prose lives in the new `shared/references/ci-lanes.md`
(per-lane gating rationale, the trust-asymmetry writeup, and a suggested —
not applied — addition to `qa-generate/SKILL.md`'s step 5 note, since that
file is #168's territory in this run). `shared/references/
github-actions-adapter.md` updated to reflect all four triggers now
supported and one REQUIRED renderer added.

**Left for later tickets:** PR-lane graduation from advisory to required
after burn-in, and quarantine-lane rendering (adapter contract point 3 names
all three: advisory, required, quarantine — this ticket adds only the one
new REQUIRED renderer, for merge-group). Impact-path-based Binding selection,
full semantic inventory of third-party workflow YAML, and action-pin
freshness re-verification remain exactly as #153 left them.

## 29. Quarantine overlay (#161)

`shared/scripts/quarantine.mjs` (37 tests), schema
`shared/schemas/dynamic-qa-quarantine-v1.schema.json`, reference
`shared/references/quarantine.md`.

**Overlay, not a fourth axis.** This module imports no mutator from
`lifecycle-state.mjs` (#157) and exports none of its own. A Quarantine
Record's full key set (`QUARANTINE_KEYS`) shares no key with any of the
three axes' delta shapes (`{to,context}` / `{freshness}` /
`{qualifyingRunSummary,approval}`), proven by
`quarantineSharesNoKeyWithLifecycleAxisDeltas()` and by three tests that
pass a real Quarantine Record straight into `applyFlowStateChange`,
`applyBindingFreshnessReport`, and `applyEnforcementPromotion` and confirm
each refuses it on foreign keys alone.

**Both approvals, always already granted.** `createQuarantineRecord` is the
only constructor and reuses `authority.mjs`'s `qaOwnerGate`/
`technicalOwnerGate` shape, tightened so both gates must already be
`present:true` with a named `identifier` — there is no pending/partial
state a caller can construct a valid record from. No function anywhere in
the bundle derives a Quarantine Record automatically from a Diagnosis
Record or a failed run; quarantine is always this explicit human call.

**Default seven-day expiry, fail-closed on both expiry and malformed
shape.** `DEFAULT_QUARANTINE_DAYS = 7`; `defaultExpiry(startAt)` computes
it when a caller omits `expiresAt`. `isQuarantineActive(record, now)`
returns `{active:false, reason:"expired"}` once `now >= expiresAt`, and
`{active:false, reason:"malformed"}` for any record failing
`validateQuarantineRecord` (missing approval, bad timestamp, wrong
`effectiveLane`, etc.) — both collapse to the same "no exception" outcome
for every downstream function; there is no third, more permissive state.

**Never counts as pass, coverage, or qualification — proven three ways.**
`quarantineReportStatus` hard-codes `countsAsPass`/`countsAsCoverage`/
`countsAsQualifying` to the literal `false` whenever quarantine is active,
regardless of the caller's own `testPassed` value.
`contributesToCoverage` returns `false` for any actively-quarantined
`bindingId`. `excludeQuarantinedFromQualifyingRuns` /
`summarizeQualifyingRunsExcludingQuarantine` filter matching runs out
*before* handing the rest to #157's own, unmodified `isQualifyingRun` /
`summarizeQualifyingRuns` — reusing that Qualifying Run model exactly,
rather than re-implementing it, to prove a quarantined Binding cannot
qualify.

**Visibility.** `describeQuarantineForReporting` always names the
`flowId`/`bindingId` and the exact reason (`active` / `expired` /
`malformed`), even for a malformed record, with `missingProtection: true`
on an active quarantine — a quarantined flow never silently disappears
from a report.

**Coordination note:** neither `SKILL.md` was touched (per this ticket's
coordination note); the existing repair-mode placeholder text in
`qa-generate/SKILL.md` ("failure evidence, diagnosis, proposal-only
repair, negative-control gate, and quarantine validation") is unchanged.
Failure Evidence Bundle modeling is #159's territory and is not
duplicated here — `originatingFailureRef` is only a stable pointer.

## 28. Failure Evidence Bundle (#159)

**Repair is explicitly invoked with a strict Failure Evidence Bundle;
scraped prose logs cannot authorize a code change — this is structural, not
a convention.** `shared/schemas/dynamic-qa-failure-evidence-v1.schema.json`
and `shared/scripts/failure-evidence.mjs` define the only artifact
`qa-generate repair --evidence <bundle>` may accept. Every field is an
enum, a `sha256:` digest, a full 40-character commit SHA, an ISO-8601
timestamp, or a string bounded to `MAX_TEXT_FIELD_LENGTH` (500) characters
and passed through `secret-detection.mjs`'s `detectSecretValue`. There is
no `rawLog`/`logExcerpt`/`notes`/any other unbounded free-text field
anywhere in the schema, and `assertKnownKeys` is fail-closed on every
nested object — a bare string or a free-text blob fails
`validateFailureEvidenceBundle`'s very first check, and an overlong or
secret-shaped value in one of the few bounded text fields
(`junitFacts[].message`, `expectedVsObserved[].expected/.observed`,
`fixtureBoundaryEnforcement.fixtureIsolation`,
`approvedDiagnostics[].label`) is rejected by name.

**Immutable.** `bundleDigest` is `canonical-digest.mjs`'s `contentDigest`
over every other field. `computeBundleDigest` / `checkBundleImmutability`
recompute and compare; any post-hoc edit — including one that "improves"
evidence to fit a conclusion — is detected and refused.

**Named run, tied to a source commit.** `repository` / `sourceCommit` /
`workflow` mirror `result-envelope.mjs`'s identity fields exactly (the
shape `github-actions-adapter.mjs`'s `resolveRunReference` already produces
from a real run). The embedded `diagnosisRecord`'s own
`sourceCommit`/`flowId`/`bindingId` must agree with the bundle's own —
cross-checked explicitly, so a bundle cannot be recycled across an
unrelated commit, flow, or Binding by mixing old and new identity.

**Eligibility reuses #158's `isRepairEligible` exactly — never
re-derived.** The bundle embeds exactly one already-produced Diagnosis
Record, validated with `diagnosis.mjs`'s own `validateDiagnosisRecord`.
`isBundleRepairEligible` composes shape validation, immutability, then
`isRepairEligible(bundle.diagnosisRecord)` unchanged.
`explainRepairIneligibility` names the exact reason for every ineligible
category: malformed, safety-blocked, provisional, product, environment,
unresolved, and confirmed-binding-but-intermittent (test-flake) all get
their own message; only confirmed + binding + binding-defect returns
eligible with no reason. Every one of the 12 Owner x Repeatability
combinations is covered by fixtures.

**One causal hypothesis is a structural bundle property, but pursuing only
one during repair is #160's job.** `diagnosisRecord.causalChain` is a
single non-empty string, never an array, and the bundle's closed key set
has no second field (e.g. an `alternativeHypotheses` list) where a caller
could attach a second hypothesis beside it — both are rejected by
`validateFailureEvidenceBundle`. Actually stopping a repair attempt after
one causal theory fails (DESIGN-dynamic-qa-spec.md §7 step 6: "a second
causal theory or failed candidate stops; no repair loop") is
repair-execution behavior, not a bundle-shape property, and belongs to
#160.

**Seams for #160:** `isBundleRepairEligible(bundle)` is the single function
`qa-generate repair`'s gate (step 4) should call. `qa-generate/SKILL.md` is
unedited per coordination — see `shared/references/failure-evidence.md`
for the exact repair-mode step 1 / step 4 placeholder text this ticket
leaves in place.

## 30. Setup Review Packet and emit-then-stop (#169)

**This is the first point `qa-setup` can write, and the module structurally
guarantees it.** `shared/scripts/setup-review-packet.mjs` composes #165's
`evaluatePortfolioApproval`, #166's `designExecutionProfile` results, #167's
Baseline Plan / `computeReadiness`, and #168's `designProviderNativeCI`
result into one packet and one emission gate — it re-derives none of them.
Every other customer-repository artifact (Flow Definitions, Named Data
Sets, Execution Profiles, the bundled schemas) stays in memory until
`emitSetupReviewPacket` succeeds; #167's Baseline Plan file remains the one
documented exception (SPEC-135 story 44 — resumable measurement across
days), not a precedent this ticket weakens or extends.

**Seven required areas, each independently checked.**
`assembleSetupReviewPacket` builds `REQUIRED_PACKET_AREAS` (contract, data,
safety, harness, dependency, ci, unresolvedRequirements) from dedicated
builders that each throw on their own missing/malformed upstream input;
the assembler catches every area's failure separately into `missingAreas`
rather than aborting on the first bad input, so a reviewer sees every gap
at once — the same shape #166's stage 7 composition already established
for Safety Blockers. `validateSetupReviewPacket` rejects anything short of
all seven.

**Dual approval reuses #162's gates — not a second model.**
`evaluateSetupReviewApproval` calls `authority.mjs`'s
`validateAuthorityRecord`/`gatesAreIndependent` directly on the same
`{ qaOwnerGate, technicalOwnerGate }` shape stage 1 already established;
`authority.mjs`'s own header names "the Setup Review Packet" as one of the
two places `GATE_KEYS` is reused. `present: true` here means "approved the
packet" rather than "holds this role" — the field shape and independence
rules are unchanged. Withholding either gate, or both, is independent and
total; a non-independent record (same object behind both keys) never reads
as `bothApproved`.

**Emit-then-stop is a structural property of the function's own control
flow.** `emitSetupReviewPacket` checks, in fixed order: packet
completeness, approval-record validity/independence, both gates satisfied,
then Baseline Plan readiness (`measurement-required` blocks emission here
too, re-checked so stage 8's own stop cannot be bypassed by reaching stage
10 anyway). Only then does it return the patch's file list — there is no
code path that writes a file, calls a generator, merges anything, or
changes provider/CI policy, and the return value carries no
`apply`/`merge`/`generate`/`run`/`activate` handle for a caller to invoke
next.

**Exactly the expected patch — no amend-renderer built here either.**
`buildSetupPatchFiles` emits, in a fixed sorted order: `qa/flows/<id>.yaml`
(approved flows only), `qa/data/<id>.yaml` (only data sets an approved
flow references), `qa/execution-profiles/<id>.yaml` (every stage 7 result,
activated and deferred alike), `qa/schemas/<file>` (the bundle's own
current schema files, enumerated from `shared/schemas/` rather than
hard-coded), and `qa/baseline-plan.yaml`. Deliberately excluded:
`qa/quarantines/*` (nothing is quarantined by setup) and
`qa/provenance.json` (no Binding exists yet — that is qa-generate's job).
#168 explicitly left "no actual amend-renderer exists... producing the
exact merged YAML for an existing third-party workflow file" as a seam for
"stage 10's Setup Review Packet, or a later qa-generate step" — this ticket
does NOT build that renderer: the CI proposal is presented in the packet's
`ci`/`dependency` areas for review, but never becomes a patch file, and no
`.github/workflows/` change is ever part of this patch. That remains open
for whichever ticket actually applies CI policy.

**qa-setup/SKILL.md stage 10 filled in; STATUS line now reads "all ten
stages built."** No stale placeholder list remains.

**FLAGGED FOR REVIEW — a naming tension between this ticket's brief and
DESIGN-dynamic-qa-spec.md §5.4/SPEC-135 story 44:** the ticket brief for
#169 frames stage 10 as "the first and only place qa-setup writes," but
#167 (landed, and DESIGN §5.4 explicitly) already has stage 8 write
`qa/baseline-plan.yaml` directly on `measurement-required`, precisely so
burn-in evidence can accumulate across sessions without hidden state. Per
run brief decision #4, where the ticket brief and the more specific design
doc conflict, this is worth surfacing rather than silently resolving either
way: this module treats the Baseline Plan file as the one pre-existing,
spec-mandated exception (unchanged, not touched by this ticket) and
guarantees the STRUCTURAL "everything else waits for approval" property for
every other artifact instead of re-litigating #167's own write.

**Seams for #170/#171:** `emitSetupReviewPacket`'s returned `files` array
is the exact handoff — a later ticket applies it (writes it to the real
repository, opens a PR, whatever this repository's own Git workflow
already is) as a genuinely separate action; this ticket deliberately builds
no "apply this patch" function. `dataSets` is caller-supplied in memory
(stage 5 authors Named Data Sets the same way it authors flows) — nothing
here reads `qa/data/` from disk, since nothing is written there until this
same emission. No Provenance Manifest (`qa/provenance.json`) is produced
here; that begins with qa-generate's first Binding.

## 33. Untrusted-content proof (#170)

The adversarial ticket: attack every already-landed defence
(#150/#151/#153/#154/#155/#159) with hostile fixtures and prove content
cannot authorize capability, per SPEC-135 User Stories 84-92 and the
Testing Decisions paragraph's hostile-fixture list. No new defence was
built — this ticket only attacks existing ones and reports honestly.

**All hostile fixtures live in Tier 1** (`shared/scripts/hostile-fixtures.test.mjs`,
25 tests, one section per SPEC-135 category: repository/application/MCP
prompt injection, malicious branch/test names, dependency hooks,
artifact/cache poisoning, secret patterns, redirects/DNS changes,
metadata/internal reach, privilege escalation, diagnostic scrub failure) —
every category is pure computation, so per the run brief's own tiering rule
nothing here needed Tier 2. One Tier 2 case was added anyway
(`acceptance/cases/hostile/repo-injection-leaves-tree-unchanged.case.sh`)
specifically to prove the model/credential-absence property
(`ci-clean/subprocess-env-scrub.case.sh`'s mechanism) holds against a
fixture repository actively saturated with prompt-injection content, not
only in the clean case — and that the hostile Flow Definition is refused
with its exact named error while the fixture tree stays byte-unchanged.

**Every attack fixture is paired with a named-error assertion**, never "it
happened to fail": e.g. a Flow `expect` field carrying `$(curl ... | sh)` is
rejected citing the exact forbidden-template-marker message; a dependency's
postinstall-hook-shaped payload trying to reach `privileged-publication`
directly is rejected as `trust-zone.illegal-transition.skip:...` and,
independently, `trust-zone.privileged-lane-refuses-code`; an allowlist
origin of `169.254.169.254`/`metadata.google.internal`/`10.0.0.5` is
rejected via `classifyOriginRisk` returning `"metadata"`/`"internal"` and
the capability gate's `network.allowlist-entries-exact`; an environment
claiming an exact-allowlist match with `dnsRecheck`/`redirectRecheck: false`
is rejected by name, proving the "redirect/DNS change after allowlist
evaluation is caught by recheck" property against a concrete adversarial
reproduction, not only the pre-existing #150 test coverage it composes.
Full category -> fixture -> named-error map:
`shared/references/hostile-fixtures.md`.

**No attack succeeded.** Every category SPEC-135 names was reproducible
against the real, already-landed deterministic core and was refused.

**The two soft spots this ticket was explicitly asked to probe are both
real as coded, and both currently latent, not live-exploitable** — because
neither `portfolio-reconciliation.mjs`'s `reconcilePortfolio` nor
`safe-execution-design.mjs`'s `designExecutionProfile` is yet wired to a
real, attacker-reachable caller (both take fully caller-supplied
evidence/options with no adapter deriving them from a real repository or
sandbox yet — an explicit, pre-existing seam #151/#165 already documented,
not a new discovery). Full reasoning and recommendations (make
`resolveDataSet` and `context.zone` required rather than silently-skippable,
before either function gets a real caller) are in
`shared/references/hostile-fixtures.md`.

**One additional, smaller finding surfaced while attacking the "malicious
branch/test name" category:** `id-rules.mjs`'s `SEMANTIC_ID_RE` has no
maximum length — an attacker-controlled branch name made of 300 lowercase
letters passes `isValidSemanticId`. It cannot escape the safe character set
(no path traversal, no shell metacharacter survives), so it does not alter
command construction or artifact-path *target*, but an unbounded-length
identifier fully within attacker control does reach filenames with no cap.
Reported rather than silently treated as covered; a follow-up should add a
length bound.

**Coordination respected:** neither `github-actions-adapter.mjs` nor
`qa-generate/SKILL.md`/`repair.mjs` (owned by concurrent #156/#160) was
edited — `github-actions-adapter.mjs`'s existing exports
(`classifyLaneContentSource`, `checkLaneTrustInvariant`) are only imported
and attacked from the new test file. All prose lives in
`shared/references/hostile-fixtures.md`, a new file, so neither in-flight
ticket's `SKILL.md` was touched.
