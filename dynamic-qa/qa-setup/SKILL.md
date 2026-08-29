---
name: qa-setup
description: "Create or resume the QA-owned critical-flow contract, safe execution profiles, measurement plan, and provider-native CI proposal for the current repository. Use only when explicitly invoked; never starts from natural-language intent."
disable-model-invocation: true
metadata:
  version: "{{BUNDLE_VERSION}}"
---

STATUS: skeletal build. This `SKILL.md` establishes the explicit-invocation
contract, the installation precondition, and placeholders for the stages spec
issue #135 assigns to later tickets (#143 onward). It does not yet implement
discovery, interview, execution-profile, baseline, or CI-proposal behavior —
that content is deliberately not invented here. See `dynamic-qa/DESIGN-dynamic-qa-spec.md
## 6. qa-setup SKILL.md outline` (run notes) for the full target workflow this
file will grow into.

## Explicit invocation only

`qa-setup` never starts from natural-language intent, a coordinator inferring
work, or another skill invoking it implicitly. `disable-model-invocation: true`
above is the portable half of that gate; the Codex build additionally carries
`policy.allow_implicit_invocation: false` in its `agents/openai.yaml` overlay
(see `dynamic-qa/codex/qa-setup/agents/openai.yaml`). A harness without either
mechanism must still only start this skill from an explicit user or coordinator
selection — never from matching this description against a request.

Entry forms this skill will accept once built:

```text
qa-setup
qa-setup resume
qa-setup review <flow-id>
```

## Invoking with no argument is side-effect free

The bare `qa-setup` form only orients: it reports whether setup is new or
resumable and what evidence exists. Until the discovery stage below is built,
the bare form MUST do nothing beyond that report. No repository file, provider
policy, secret, or piece of infrastructure is created, edited, or touched by
invoking `qa-setup` with no argument, at any stage of this skill's
implementation.

## Installation precondition: a verified Dynamic setup profile

Before doing anything else — including the no-argument orientation report —
confirm a present, schema-current, unexpired, `verified` `dynamic-skills-setup`
capability profile exists for the harness in use (see
`~/.agents/dynamic-skills/capabilities.json`, or the path named by
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

This mirrors `dynamic-implement`'s own manual-setup-entry table exactly; `qa-setup`
does not define a setup command of its own.

## Stages not yet built (placeholders for later tickets)

Each numbered stage below is a placeholder. Do not invent its content here;
implement it in the ticket that owns it.

1. **Orient and establish authority** — placeholder for ticket(s) under build-scope
   item 3 (`qa-setup workflow, review packet, measurement pause/resume, lifecycle,
   and capability gate`).
2. **Inventory facts read-only** — placeholder, same scope.
3. **Enter through posture-specific evidence (brownfield/greenfield)** — placeholder,
   same scope.
4. **Rank candidate flows** — placeholder, same scope.
5. **Interview one flow at a time** — placeholder, same scope.
6. **Reconcile the portfolio** — placeholder, same scope.
7. **Define safe execution (Execution Profiles, Capability Gate)** — placeholder,
   same scope.
8. **Establish measurement readiness (Baseline Plan)** — placeholder, same scope.
9. **Design CI last (provider-native proposal)** — placeholder, same scope.
10. **Review once, then emit (Setup Review Packet, dual approval)** — placeholder,
    same scope.

## Dependencies

Requires the installed `grilling` and `domain-modeling` skills (Matt Pocock
skill set, tracked in `skills-lock.json`). Uses the repository's issue tracker
and documented Git workflow. Never creates its own product backlog.

## Self-containment

This skill reads only files under its own installed directory
(`SKILL.md`, `references/`, `assets/`, `scripts/`) plus the
`dynamic-skills-setup` capability profile named above. It never reads from a
sibling `qa-generate` installation, and is installable on its own.
