# Authority and Sourced Inventory (qa-setup stages 1–2)

Shared reference for `qa-setup`'s first two stages. Built into both skills
by `dynamic-qa/build.sh` from this single source
(`dynamic-qa/shared/references/`) — see `dynamic-qa/DECISIONS.md`.

The mechanical parts of both stages are deterministic-core modules under
`shared/scripts/` (`authority.mjs`, `fact.mjs`, `inventory.mjs`,
`inventory-tests.mjs`, `inventory-ci.mjs`, `repo-walk.mjs`), covered by their
own `node:test` suites. This document describes what those modules check and
why, so the skill's own prose can stay short and point here instead of
re-deriving the rules inline.

## Stage 1 — Orient and establish authority

**The explicit-invocation gate.** `qa-setup` may only begin from an explicit
user command or an explicit coordinator selection
(`authority.evaluateInvocation`). A natural-language mention of QA, testing,
or coverage — however clearly it implies the human wants setup run — must
never start it, change QA policy, or touch the repository. An invocation
whose source the harness cannot classify fails closed exactly like a
recognized-but-disallowed source: silence about provenance is never treated
as permission.

**Two gates, never one.** The Setup Review Packet at the end of setup (a
later ticket, #169) requires separate QA Owner (contract) and Technical
Owner approvals. That separation starts here: stage 1 establishes who holds
each role using two independently tracked gate records
(`authority.GATE_KEYS`: `qaOwnerGate`, `technicalOwnerGate`), never a single
combined "approved" field. `authority.validateAuthorityRecord` fails closed
on a record that tries to collapse the two, or that marks a gate present
without naming who holds it.

Setup must not proceed past stage 1 into flow elicitation while the QA Owner
gate is absent — an agent operating without a verified accountable human on
the other end of that gate would be impersonating QA policy authority, which
the parent spec forbids outright. The Technical Owner gate can remain absent
longer (harness/CI decisions come later, in stages 7–9), but stage 1 records
whether it is known so later stages don't have to ask again.

**Domain Experts join flows, not ownership.** A Domain Expert may answer the
specific interview questions (stage 5, later ticket) that need their
knowledge, but can never become the QA Owner of record. Structurally, that
means every Domain Expert entry in the authority record must declare a
non-empty `scope` (the flow ids their input applies to) —
`validateAuthorityRecord` rejects an unscoped Domain Expert because an
unscoped one is indistinguishable from a QA Owner. The same human may
legitimately hold the QA Owner gate and also appear as a scoped Domain
Expert, or hold both the QA Owner and Technical Owner gates — the rule is
about the STRUCTURE of the record (a scope must exist, the two gates must
stay separate keys), not about forcing different people into different
roles.

What is deliberately **not** in the deterministic core: whether a named
human genuinely holds QA Owner accountability in this organization. That
judgment call — asking who is responsible, weighing what they say, deciding
when a claimed authority is credible — is exactly the kind of thing that
needs a model, and stays in `qa-setup/SKILL.md`'s stage 1 prose.

## Stage 2 — Inventory facts read-only

**Discovery never writes.** Every scanner in `shared/scripts/inventory-*.mjs`
is built exclusively on `repo-walk.mjs`'s read-only primitives (directory
listing, file read, existence check, stat) — the module never imports a
mutating `node:fs` function, checked both by a static source scan and by a
runtime test that wires every mutating `fs` export to throw and confirms a
real scan still succeeds. No repository file, provider policy, secret, or
piece of infrastructure is touched by inventory scanning, at any point.

**Every fact is provenance-tagged.** `fact.mjs` defines the three allowed
values — `observed` (the scanner read this directly from a file it opened),
`reported` (backed by a named piece of evidence that was itself observed,
e.g. a coverage/JUnit report file whose *existence* was observed even though
its full claims aren't independently re-verified), and `unknown` (the
scanner could not determine this and says so). `validateFact`/
`validateInventory` fail closed on any fact missing provenance, carrying an
unrecognized category, or (for a `secret-name` fact) carrying anything
value-shaped.

**What gets inventoried:**

- **Existing tests and the outcomes they already prove**
  (`inventory-tests.scanExistingTests`): one `observed` fact per test-shaped
  file found by path/name convention, plus one summary
  `existing-test-outcome` fact — `reported` when a known report artifact
  (`junit.xml`, a coverage summary, …) exists to back a claim about what
  currently passes, `unknown` otherwise. This scanner never reads test
  bodies to infer pass/fail; that would be a claim static scanning cannot
  support.
- **Frameworks, fixtures, mocks, clocks, cleanup, reporting**
  (`inventory-tests.scanTestFrameworks`, `scanTestSupportKeywords`):
  framework facts from concrete markers (a `package.json` dependency, a
  `Cargo.toml`/`pytest.ini` presence); fixture/mock/clock/cleanup/reporting
  facts from literal keyword evidence inside test-shaped files, each citing
  the file it was found in — never the file's full content.
- **CI triggers, runners, services, environments, merge queues, checks,
  artifacts, secret names** (`inventory-ci.scanCiWorkflows`): parsed from
  `.github/workflows/*.yml` with a small line-oriented extractor (not a full
  YAML parser — see the module's own comment for why). `merge_group` is
  recorded as its own `ci-merge-queue` fact, distinct from an ordinary
  trigger, because the parent spec treats merge-queue support as a distinct
  concern from PR/push triggers.

**Secret names, never values.** `scanCiWorkflows` captures only the `NAME`
inside a `secrets.NAME` or `secrets['NAME']` reference. There is no code
path anywhere in the deterministic core that reads or stores an actual
secret value — `fact.makeFact`/`validateFact` actively reject a
`secret-name` fact carrying a `value`, and reject a `secretValue` field on
any fact at all, so even a future scanner mistake would fail loudly at fact
construction rather than silently leaking something.

**The Setup Inventory itself is ephemeral.** `inventory.buildSetupInventory`
returns a plain in-memory object for the responsible QA Owner's review
during the interview — it is never written to the repository as a persisted
artifact (see `DESIGN-dynamic-qa-spec.md`'s domain-language table: "Setup
Inventory | Ephemeral … never policy"). Nothing is written to disk until a
Setup Review Packet gets separate approvals, which is out of scope for
stages 1–2.
