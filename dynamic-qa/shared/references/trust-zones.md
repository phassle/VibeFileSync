# Trust Zones and disposable candidate verification (`qa-setup` stage 7)

Shared reference describing the four Trust Zones safe execution runs in
and the hard security invariant every one of them must satisfy. Built into
both skills by `dynamic-qa/build.sh` from this single source
(`dynamic-qa/shared/references/`) — see `dynamic-qa/DECISIONS.md` §19.

The mechanical parts of this document are a deterministic-core module,
`shared/scripts/trust-zones.mjs`, covered by its own `node:test` suite
(`trust-zones.test.mjs`). This document describes what those checks do and
why, so `qa-setup/SKILL.md`'s stage 7 prose can stay short and point here.

This document complements, and does not replace, `execution-profiles.md`:
that document covers whether one Flow's Execution Profile is well-formed
and whether the actual environment proves it enforces that profile (the
Capability Gate). This document covers a different question — which of
four isolated Trust Zones a run happens in, whether moving between them is
legal, and whether the run's content/identity/filesystem/network shape
violates the hard security invariant regardless of zone.

## The four Trust Zones

Safe execution is modelled as a fixed, linear pipeline of four isolated
zones. Evidence and artifacts may only move forward, one step at a time:

1. **Contract authoring** — a fresh worktree, path/command allowlists, no
   production or publish identity, no secret in prompts, model credentials
   isolated by the harness, sensitive tracing off. Produces proposals only.
2. **Candidate verification** — generated code is arbitrary code. Runs on
   a fresh VM or one-job disposable runner, as an unprivileged user, with
   resource limits and a scoped filesystem — no host socket, device, home
   directory, credential store, metadata endpoint, or sibling-job access.
   Network denied unless an externally enforced exact allowlist is in
   force. Verification is pinned to the exact source commit under test, so
   a verified candidate is always evidence-backed.
3. **Low-trust deterministic CI** — no model or agent, no write identity,
   no OIDC, no ambient secret. The same sandbox and egress rules as
   candidate verification. Provenance is checked first; outputs are
   scrubbed. A failure stays failed. Unreviewed PR jobs get no protected
   environment capability.
4. **Privileged publication/policy** — separately reviewed base-branch
   code and a protected identity. Never executes low-trust code,
   artifacts, caches, paths, commands, or URLs. Accepts only a validated
   Result Envelope, or recomputes independently. Most CI needs no zone at
   this level at all.

`trust-zones.mjs` exports these four names as `TRUST_ZONES`, in pipeline
order: `contract-authoring`, `candidate-verification`, `low-trust-ci`,
`privileged-publication`.

## Zone transitions: one legal direction, every illegal one named

`checkZoneTransition(from, to)` is the only function that decides whether
moving evidence, artifacts, or authority from one zone to another is
legal. Of the 16 ordered pairs across four zones, exactly three are legal
— the three forward, adjacent steps of the pipeline above. Every other
pair is illegal and rejected with a distinct, named error rather than a
single generic flag:

- **`skip`** — jumping ahead by more than one stage. The most important
  case is `contract-authoring -> privileged-publication`: untrusted
  evidence produced during authoring must never inherit write authority
  directly, even by skipping verification and CI entirely.
- **`backward`** — flowing back down the pipeline, most importantly *out
  of* `privileged-publication` — a validated result must never become a
  route back into lower-trust zones.
- **`self-loop`** — a zone transitioning into itself; not a modelled
  movement.
- **`unknown-zone`** — either name is not one of the four zones.

Each error name embeds the exact `from`/`to` pair
(`trust-zone.illegal-transition.<category>:<from>-><to>`), so a caller or
test can assert on precisely which illegal transition was rejected.

## The hard security invariant

**Attacker-controlled content or executable code never combines with
privileged identity, broad filesystem access, or unrestricted network
reach** (SPEC-135 User Story 84, Implementation Decisions). This is not a
convention reviewers have to remember — `checkHardSecurityInvariant` checks
it as three independent, named comparisons against one concrete
configuration:

- Content source classification is an explicit table, not an inferred
  guess. `UNTRUSTED_CONTENT_SOURCES` lists every source SPEC-135 names:
  repository, application, issue, branch, test, MCP, dependency, action,
  cache, artifact, model output. The only content source treated as
  trusted is the literal string `"reviewed-base-branch"` — anything else,
  including a source absent from either list, classifies untrusted,
  fail-closed.
- **Untrusted content + a privileged identity** —
  `trust-invariant.untrusted-content-with-privileged-identity` — a
  credential scope naming write, push, publish, deploy, admin, or
  protected-branch authority. This is deliberately orthogonal to the
  Execution Profile's production/non-production identity axis: a
  non-production service account can still hold write/publish authority,
  and that combination with untrusted content is refused regardless.
- **Untrusted content + broad filesystem access** —
  `trust-invariant.untrusted-content-with-broad-filesystem` — an allowed
  path of `/`, `~`, `$HOME`, or containing a wildcard.
- **Untrusted content + unrestricted network reach** —
  `trust-invariant.untrusted-content-with-unrestricted-network` — network
  reach only classifies "restricted" when every allowlist origin is
  `exact` (reusing `execution-profile.mjs`'s `classifyOriginRisk`) *and*
  `externallyEnforced: true` is reported; anything else, including an
  allowlist that is present but not externally enforced, is unrestricted.

All three are checked independently, never `else if` — a configuration
that violates more than one is reported for all of them, not just the
first found.

## Authoring cannot write with publication authority

Checked twice, deliberately. `checkZoneTransition` already refuses the
direct `contract-authoring -> privileged-publication` jump. Separately,
`checkAuthoringAuthority(zone, { credentials })` refuses the
`contract-authoring` zone holding a privileged credential scope at all,
regardless of whether any transition is attempted — so the invariant
cannot be satisfied merely by never modelling a transition; the authoring
zone must never be granted write/publish authority in the first place.

## Verification: disposable, unprivileged, pinned to the source commit

`checkVerificationCompute({ environment, sourceCommit })` requires, all
three, named separately:

- `environment.disposable === true` —
  `trust-zone.verification-requires-disposable-compute`.
- `environment.unprivilegedUser === true` —
  `trust-zone.verification-requires-unprivileged-compute`. This is this
  module's own field, distinct from and in addition to the Execution
  Profile's `environments.disposable` declaration (#150): that is a
  profile's *policy statement*; this is concrete compute evidence for
  *this run*.
- `sourceCommit` matching a full 40-character commit SHA — the same
  format `provenance.mjs`'s `validateProvenanceManifest` requires of its
  own `sourceCommit` field (mirrored here, not imported, since
  `provenance.mjs` does not export that check separately) —
  `trust-zone.verification-requires-pinned-commit`. A branch name or short
  SHA is rejected; verification must be evidence-backed against an exact,
  traceable commit.

Environment evidence is caller-supplied here, exactly as #150 left
Capability Gate environment evidence caller-supplied — no ticket yet
discovers `unprivilegedUser` or `disposable` from a real sandbox or CI
adapter.

## Privileged lanes never execute low-trust code or artifacts

`checkPrivilegedLaneArtifact(zone, artifact)` only constrains
`zone === "privileged-publication"`; every other zone passes
unconditionally. `artifact.kind === "code"` gets its own named error,
`trust-zone.privileged-lane-refuses-code` — executing generated code
directly in the privileged lane is the most direct route to an execution
bridge. Every other kind except `"result-envelope"` and `"recompute"` —
including `cache`, `path`, `command`, and `url`, the exact artifact classes
DESIGN-dynamic-qa-spec.md §11 names — gets
`trust-zone.privileged-lane-refuses-artifact`. A missing or unrecognized
`kind` is refused fail-closed, never accepted by default.

## What is not built here

No caller anywhere yet assigns a real run to a Trust Zone, or calls any
function in this module from a `qa-setup` or `qa-generate` stage.
`contentSource`, `credentials`, `environment.unprivilegedUser`, and
`sourceCommit` are all caller-supplied; no adapter or sandbox discovers any
of them from a real filesystem, credential store, or CI provider yet. The
Result Envelope artifact this module's privileged-lane check accepts by
name has no schema of its own yet — a later ticket defining it should keep
this module's acceptance check as the gate rather than duplicating an
artifact-kind check elsewhere.
