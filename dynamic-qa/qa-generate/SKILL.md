---
name: qa-generate
description: "Generate or adopt deterministic Bindings for approved Flow Definitions, or diagnose a deterministic CI failure and propose a guarded Binding repair. Use only when explicitly invoked; never starts from natural-language intent."
disable-model-invocation: true
metadata:
  version: "{{BUNDLE_VERSION}}"
---

STATUS: skeletal build. This `SKILL.md` establishes the explicit-invocation
contract, the installation precondition, and placeholders for the stages spec
issue #135 assigns to later tickets (#143 onward). It does not yet implement
generation, adoption, or repair behavior — that content is deliberately not
invented here. See `dynamic-qa/DESIGN-dynamic-qa-spec.md ## 7. qa-generate
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

## Stages not yet built (placeholders for later tickets)

Each numbered stage below is a placeholder. Do not invent its content here;
implement it in the ticket that owns it.

### Generation mode

1. **Validate** schemas, Flow State, approvals, origin tickets, data, Execution
   Profile, Capability Gate, source commit, existing harness, and current
   provenance — placeholder for ticket(s) under build-scope item 4
   (`qa-generate generation/adoption, level selection, Flow-to-Binding mapping,
   provenance, and candidate verification`).
2. **Reuse or generate** the smallest conforming Binding — placeholder, same
   scope.
3. **Infer the cheapest deterministic level** — placeholder, same scope.
4. **Map every assertion** to stable Flow step and Expected Outcome IDs —
   placeholder, same scope.
5. **Update provenance and CI enrollment** in the same patch — placeholder,
   same scope; also build-scope item 5 (`deterministic drift/result tooling
   plus GitHub Actions adapter`).
6. **Verify the candidate** on the pinned source commit — placeholder, same
   scope.
7. **Present one review packet, emit a patch, and stop** — placeholder, same
   scope.

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
