# Execution Profiles and the Capability Gate (`qa-setup` stage 7)

Shared reference for `qa-setup`'s stage 7. Built into both skills by
`dynamic-qa/build.sh` from this single source (`dynamic-qa/shared/references/`)
— see `dynamic-qa/DECISIONS.md`.

The mechanical parts of this stage are deterministic-core modules,
`shared/scripts/execution-profile.mjs` and `shared/scripts/capability-gate.mjs`,
covered by their own `node:test` suites (`execution-profile.test.mjs`,
`capability-gate.test.mjs`). This document describes what those checks do
and why, so `qa-setup/SKILL.md`'s stage 7 prose can stay short and point
here.

## Why an Execution Profile exists

Before a Flow can run anywhere — a candidate-verification sandbox, a PR
check, a nightly job — something has to say, precisely and checkably, what
that run is allowed to touch: which paths, which commands, which runner
class, which network targets, which identities, which side effects, which
resource ceilings, and what evidence proves all of that is actually true
right now rather than merely declared. A permissive environment is not
evidence of safety. The Execution Profile is that precise declaration; the
Capability Gate is what checks it against reality before activation.

Both artifacts exist **before** activation, not after. `qa-setup` generates
a safe Execution Profile as part of building the Flow's contract; the
Capability Gate then has to pass before that Flow may ever move out of
`deferred`.

## The artifact: `dynamic-qa-execution-profile-v1`

One strict file per profile, id-named the same way a Flow Definition is
(`qa/execution-profiles/<profile-id>.yaml`, filename equals the immutable
semantic id). `execution-profile.mjs`'s `validateExecutionProfile(data,
{ expectedId })` is the fail-closed validator — unknown keys, an
unsupported schema version, and every rule below all reject with every
issue reported, never just the first, exactly like `flow-definition.mjs`.

A profile declares, in eight fields matching the ticket's own list, plus
owners/phases/credentials/diagnostics:

- **`paths`** — `allowedRead` / `allowedWrite`, both required keys (may be
  empty arrays — undeclared filesystem reach is forbidden by default, so a
  profile must say so explicitly, never omit the keys).
- **`commands`** — `allowed`, the exact command allowlist.
- **`environments`** — `runnerClass`, `disposable` (must be exactly `true`
  — generated code runs on disposable, unprivileged compute, never a
  persistent or shared runner), `disposabilityEvidence`, `sandbox`, plus
  optional `osLimits`/`containerLimits`.
- **`network`** — see its own section below; defaults to `none`.
- **`identities`** — `approvedNonProduction`, plus two **required, non-empty**
  positive-deny lists: `denyProduction` and `denyMetadata`. An identifier
  can never appear in both an approved list and a deny list — approval
  never silently overrides a deny.
- **`effects`** — `allowedBoundaryIds`, `reversibleSideEffects`, and (when
  that is `true`) required `namespace`/`cleanup`, plus optional
  `rate`/`concurrency`.
- **`resources`** — `maxProcesses`, `maxCpuSeconds`, `maxMemoryMb`,
  `maxFileSizeMb`, `maxWallTimeSeconds`, each a required positive number.
- **`evidence`** — `adapter` plus a non-empty `capabilities` list, one entry
  per capability the Capability Gate must find `"met"` in the environment
  before activation, each with a stable, exact `capability` name and a
  `category` from the same eight-category set. An Execution Profile with an
  empty capability list names nothing for the gate to check and is itself
  rejected.

`credentials` (a named handle, audience, scopes, lifetime, injection phase,
revocation — never a secret value) and `diagnostics` (capture classes,
capture conditions, a named scrubber, size/audience/retention) round out the
full spec §5.3 field list; they may be minimal (`credentials: {}` when no
credential is required) but are always present as explicit statements, not
absent keys.

## Network defaults to none — modelled as a fixed rule, not a preference

`network.mode` is `"none"` or `"exact-allowlist"`. When it is `"none"`, no
other network key may be present at all — a profile cannot leave a stray
allowlist or recheck flag lying next to a `"none"` declaration.

`"exact-allowlist"` requires **every** one of the following, simultaneously,
never partially:

- a non-empty `allowlist`, each entry an exact single-host `https://` origin
  and a `service` name. `execution-profile.mjs`'s `classifyOriginRisk(origin)`
  (exported for `capability-gate.mjs` to reuse rather than re-deriving the
  same logic) classifies every origin as `exact | wildcard | metadata |
  internal | malformed`. Only `exact` is accepted — a wildcard character, a
  CIDR-style range, a bare path-less-but-multi-host origin, a cloud/instance
  metadata address (`169.254.169.254`, `metadata.google.internal`, ...), or
  a private/internal/loopback/link-local address (`10.0.0.0/8`,
  `192.168.0.0/16`, `172.16.0.0/12`, `127.0.0.1`, `localhost`, `0.0.0.0`) is
  rejected — at both the profile-validation level and, redundantly, at the
  capability-gate level as belt-and-braces against a misconfigured or
  hostile adapter.
- `dnsRecheck: true`, `redirectRecheck: true` — the allowlist is rechecked
  after DNS resolution and after any redirect, not trusted from the literal
  string alone.
- `denyMetadataRange: true`, `denyInternalRange: true`, `denyPublicRange: true`.
- `externallyEnforced: true` plus a named `enforcementMechanism`. **This is
  the field that encodes "a permissive hosted runner does not satisfy exact
  egress" as a fixed comparison, not a judgement call.** It must be
  reported `true` by something outside the test process itself — a network
  policy, an egress proxy, a firewall. A runner that only relies on the
  test code's own good behaviour reports `false` (or omits the field
  entirely) and the Capability Gate blocks activation with the exact
  Safety Blocker `network.egress-externally-enforced`; the flow stays
  `deferred`, never running unsafely and never silently downgraded to
  "none".

## The Capability Gate: profile vs. actual environment

`runCapabilityGate(profile, environment)` is the second, independent check:
not "is this profile well-formed" but "does the actual environment prove it
enforces what this profile declares." It always runs all eight category
checks — paths, commands, environments, network, identities, effects,
resources, evidence — unconditionally and in a fixed order, concatenating
every blocker found. There is no early return once one category fails, and
no code path that skips a category because the caller's environment
evidence happened to omit that section; an entirely missing section is
itself a blocker, never treated as "not applicable."

It returns `{ passed, blockers }`. Each blocker is
`{ category, capability, message }` — `capability` is always the exact
stable name of the missing or mismatched thing (`paths.read-allowlist-enforced`,
`identities.no-denied-identity-active`, `network.egress-externally-enforced`,
or the profile's own declared `evidence.capabilities[].capability` string
for provider-adapter evidence) — never a generic "gate failed" message.

`activationDecision(gateResult, extraBlockers = [])` is the one function a
caller should use to decide whether to activate a Flow. It composes the
gate's own blockers with any additional ones the caller supplies (e.g. a
boundary-honourability failure, see below) and never returns
`activate: true` while any blocker is open:

```js
{ activate: false, state: "deferred", blockers }   // any blocker present
{ activate: true,  state: "activatable", blockers: [] }  // none
```

A Flow cannot be activated while any Safety Blocker is open — there is no
default-open path through this function, and no "warning" state between
`deferred` and `activatable`.

## Honourability: can this profile realise this Flow's boundaries?

`#145` (Boundary Declaration policy) explicitly left this to `#150`:
"whether a flow's boundaries can be realised against a concrete Execution
Profile's allowed-boundary IDs." `checkExecutionProfileHonoursBoundaries(profile,
flowBoundaries)` answers it by reusing `boundary-policy.mjs`'s
`resolveBoundaryTreatment` directly, never reimplementing the lookup:

- Every boundary id in `profile.effects.allowedBoundaryIds` must resolve to
  something other than `"forbidden"` against the Flow's own declared
  boundaries. An undeclared boundary resolves `"forbidden"` by construction
  (per #145); a profile that permits it anyway claims a capability the
  Flow's own contract never granted it, and is unhonourable.
- Every Flow boundary declared `real` with non-`"none"` side effects (the
  case `boundary-policy.mjs` already requires isolation for) must both
  appear in the profile's `allowedBoundaryIds` and have the profile itself
  declare `effects.namespace`/`effects.cleanup` — a profile that omits the
  isolation a real-side-effect boundary requires cannot honour that
  boundary either, even if it lists the id.

This returns the same `{ valid, errors }` shape as every other validator in
the bundle. A caller folds its `errors` into `activationDecision`'s
`extraBlockers` so an unhonourable profile blocks activation the same way a
missing capability does — one gate, not two independent ones a reviewer
has to remember to check separately.

## What is not built here

No stage of `qa-setup/SKILL.md` yet calls any of these four functions —
this reference and the deterministic-core modules exist so a later ticket
that wires stage 7 (and the activation-approval flow) can call them
directly rather than re-deriving any of this logic in prose.
`preflight.mjs` (#146) still only checks that an Execution Profile ID is a
valid semantic ID string; it does not load, validate, or gate the profile
itself. Environment evidence is entirely caller-supplied — no ticket yet
discovers it from a real sandbox or a real GitHub Actions runner; the
provider-adapter contract is the natural place to populate it, shaped to
exactly `capability-gate.mjs`'s `environment` parameter. No YAML
authoring/rendering surface exists yet for
`qa/execution-profiles/<profile-id>.yaml` (no `execution-profile-yaml.mjs`
mirroring `flow-yaml.mjs`); tests exercise the validator against plain JS
objects.
