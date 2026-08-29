---
name: qa-setup
description: "Create or resume the QA-owned critical-flow contract, safe execution profiles, measurement plan, and provider-native CI proposal for the current repository. Use only when explicitly invoked; never starts from natural-language intent."
disable-model-invocation: true
metadata:
  version: "{{BUNDLE_VERSION}}"
---

STATUS: stages 1–2 built (ticket #162: authority and sourced inventory).
Stages 3–10 remain placeholders for later tickets (#163 onward) — do not
invent their content here. See `dynamic-qa/DESIGN-dynamic-qa-spec.md
## 6. qa-setup SKILL.md outline` (run notes) for the full target workflow this
file will grow into, and `dynamic-qa/shared/references/authority-and-inventory.md`
for the detailed rationale behind stages 1–2 below.

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
resumable and what evidence exists (stage 2's Setup Inventory is part of that
report). The bare form MUST do nothing beyond authority checks and read-only
inventory. No repository file, provider policy, secret, or piece of
infrastructure is created, edited, or touched by invoking `qa-setup` with no
argument, at any stage of this skill's implementation — discovery stops well
before the Setup Review Packet (stage 10) that is the earliest point any
write is permitted.

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

## Stage 1: Orient and establish authority

Before eliciting any flow, establish the responsible QA Owner's authority so
an agent can never impersonate the accountable human.

1. **Check the invocation gate first.** Classify how this run started
   (explicit user command, explicit coordinator selection, or anything else)
   and evaluate it against `shared/scripts/authority.mjs`'s
   `evaluateInvocation`. Anything other than an explicit command or explicit
   coordinator selection — a natural-language mention, an inferred intent,
   another skill invoking this one on its own initiative, or a source this
   skill doesn't recognize — stops immediately with reason
   `not-explicit-invocation` (or `unrecognized-invocation-source`). Nothing
   past this point runs.
2. **Identify who holds each gate.** Ask, in plain language, who is the
   responsible QA Owner for this repository and who is the Technical Owner
   for harness/CI/dependency consequences. These are two independently
   tracked gates (`qaOwnerGate`, `technicalOwnerGate`) — never a single
   combined "approved" answer. It is fine for one human to hold both gates;
   it is not fine to record them as one field. Validate the resulting
   record with `authority.validateAuthorityRecord` before proceeding —a gate
   marked present with no named identifier, or a record that tries to merge
   the two gates, fails closed.
3. **Stop if no QA Owner is present.** Setup does not proceed into flow
   elicitation while the QA Owner gate is absent. Print a readiness
   checklist naming what is missing and stop. This is a judgment call about
   whether the named human's authority is credible for this repository —
   ask, listen, and decide; do not accept a bare assertion of role at face
   value if it is inconsistent with what discovery (stage 2) or the
   conversation so far shows.
4. **A Domain Expert joins flows, not ownership.** If a Domain Expert is
   named (someone who can answer specific flow questions but is not
   accountable for QA policy), record them with an explicit, non-empty
   `scope` — the flow(s) their input applies to. An unscoped "expert" is
   indistinguishable from a QA Owner and `validateAuthorityRecord` rejects
   it. Domain Experts are invited into stage 5's per-flow interview later;
   they are never asked to approve the portfolio or the review packet.

See `shared/references/authority-and-inventory.md` for the full rationale
and the deterministic core's test coverage for each rule above.

## Stage 2: Inventory facts read-only

Before asking the QA Owner anything about policy, inspect what is actually
in the repository, so they decide policy instead of reciting facts you could
have found yourself.

1. **Run the inventory scan.** Call
   `shared/scripts/inventory.mjs`'s `buildSetupInventory(repoRoot)`. It
   combines:
   - existing tests and the outcome they already prove
     (`inventory-tests.scanExistingTests`);
   - frameworks, fixtures, mocks, clocks, cleanup, reporting
     (`inventory-tests.scanTestFrameworks`, `scanTestSupportKeywords`);
   - CI triggers, runners, services, environments, merge queues, checks,
     artifacts, and secret **names** (`inventory-ci.scanCiWorkflows`).
   Every returned fact carries `observed`, `reported`, or `unknown`
   provenance (`fact.mjs`); the whole inventory is validated before use.
   This scan is read-only by construction — see
   `shared/references/authority-and-inventory.md` for how that is enforced
   and tested.
2. **Present the inventory as evidence, not intended behavior.** Summarize
   what was found (`inventory.summarizeProvenance` gives the
   observed/reported/unknown counts) and be explicit about what is
   `unknown` — do not fill a gap with a plausible-sounding guess. A fact
   about current repository state is never itself a claim about what
   *should* happen; that judgment belongs to the QA Owner in later stages.
3. **Never write anything here.** The Setup Inventory is ephemeral — it
   exists to inform this conversation, not to be committed to the
   repository. Nothing from this stage touches a repository file, provider
   policy, secret, or piece of infrastructure.

See `shared/references/authority-and-inventory.md` for the detailed
breakdown of every fact category and how secret names are handled without
ever reading a value.

## Stages not yet built (placeholders for later tickets)

Each numbered stage below is a placeholder. Do not invent its content here;
implement it in the ticket that owns it.

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
