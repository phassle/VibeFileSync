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
