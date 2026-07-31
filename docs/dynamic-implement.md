# Dynamic Implement team guide

Dynamic Implement turns one spec-level tracker issue into planned, tested, independently reviewed, integrated work. The issue graph is the shared goal across harnesses; local Goals/tasks and the run ledger mirror it.

## Install

For complete GitHub, skills CLI, manual, and per-harness installation instructions, see the [Dynamic Implement skill bundle README](dynamic-skills/README.md).

Install these portable skill directories for the harnesses used by the team:

- `dynamic-implement`
- `setup-dynamic-skills`
- `calibrate-dynamic-models`

Also install Matt Pocock's official engineering skills. `implement`, `tdd`, `code-review`, and `setup-matt-pocock-skills` are mandatory. Dynamic Implement stops before mutation when they are unavailable.

Common personal locations:

| Harness | Skill location |
| --- | --- |
| Codex | `~/.codex/skills/` |
| Claude Code | `~/.claude/skills/` |
| GitHub Copilot | `~/.copilot/skills/` or `~/.agents/skills/` |
| OpenCode | `~/.config/opencode/skills/` or `~/.agents/skills/` |
| Pi | `~/.pi/agent/skills/` or `~/.agents/skills/` |

Keep credentials, the machine-local capability profile, disposable caches, and run ledgers outside the repository. The default capability profile is `~/.agents/dynamic-skills/capabilities.json`.

Keep learned model/effort outcomes in the repository at `.agents/dynamic-implement/model-calibration.json`. This tracked file belongs to the team and survives skill installation or upgrades. Never store learned findings inside `.agents/skills/`, `~/.agents/skills/`, or `~/.codex/skills/`.

## Set up capabilities

Run `setup-dynamic-skills` manually on first use, after authentication/harness changes, when a selected route fails, or after the model catalog expires. Dynamic Implement never starts setup automatically: it stops before mutation, reports the exact missing/stale evidence, and tells the user which setup command to invoke. After setup succeeds, invoke Dynamic Implement again.

| Harness | Manual setup entry |
| --- | --- |
| Codex | `$setup-dynamic-skills` or select it through `/skills` |
| Claude Code | `/setup-dynamic-skills` |
| GitHub Copilot | `/setup-dynamic-skills` |
| OpenCode | `/setup-dynamic-skills` through its command adapter |
| Pi | `/skill:setup-dynamic-skills` |

Setup performs three separate jobs:

1. Research current selectable models and every native reasoning-effort value from installed harness surfaces and official documentation.
2. Show the complete model/effort probe matrix and expected paid ceiling, then live-verify only combinations the user approves and can actually call.
3. Map verified routes to Small/Luna, Medium/Terra, and Large/Sol and build one deterministic flat escalation ladder.

The researched catalog expires after 14 days. A refresh researches the complete model/effort surface again before extending the expiry. Catalog freshness is separate from outcome calibration: the local catalog says which exact combinations this installation can call now; issue telemetry and the tracked team profile teach which combination comparable work needed.

A ladder step is usable only when its exact harness, model, and effort combination passed a live probe. Setup orders all verified effort steps within a model before moving to the next genuinely stronger model, then deduplicates no-op tier mappings. Advertised or declined combinations remain candidates and are never selected automatically. Paid probes require prior disclosure and approval.

## Invoke explicitly

Root runs are slash/skill-entry only; ordinary prose cannot start implementation.

| Harness | Entry |
| --- | --- |
| Codex | `$dynamic-implement <issue>` or select it through `/skills` |
| Claude Code | `/dynamic-implement <issue>` |
| GitHub Copilot | `/dynamic-implement <issue>` |
| OpenCode | `/dynamic-implement <issue>` through its command adapter |
| Pi | `/skill:dynamic-implement <issue>` |

Use one coordinator per root issue. Never run the same issue concurrently in two harnesses. To move from Codex to Claude, stop at a safe checkpoint and invoke the same root issue in Claude; it reconciles the tracker, ledger, Git branches, worktrees, tests, and reviews before continuing.

All generated natural-language output is English: progress, prompts, logs, reports, commits, tracker text, and documentation. Existing authored repository/tracker text remains unchanged.

## Goal and Git state

The tracker root issue and descendants are authoritative. The durable run ledger records technical evidence. Codex Goal, Claude task lists, OpenCode todos, and similar host features are mirrors—not alternative backlogs.

The run remains active until every planned unit reaches the repository's documented integration target. A safe user-requested pause preserves the active goal and exact resumption action.

Dynamic Implement follows the repository's Git strategy. When no strategy exists, it asks and recommends gitflow. Under gitflow:

```text
feature/<root-id>-<root-slug>
feature/<root-id>-<root-slug>-issue-<child-id>
```

Worker branch and worktree names always include both the root feature issue id and concrete child issue id. Each writing agent owns one branch/worktree; one merger owns the integration worktree.

## Planning, implementation, and escalation

The fresh planner decomposes the full issue graph, orders dependencies, identifies shared-file/API conflicts, and classifies each issue as small, medium, or large. It selects logical size, not vendor model ids.

Implementers invoke Matt's `implement`, use TDD at agreed public seams, run focused and full checks, run Matt's two-axis review, and commit before handoff.

The start is selected by planner triage plus the repository-owned calibration profile, not by always beginning at the cheapest step. Escalation first raises effort on the current model and changes model only after its verified effort steps are exhausted. A valid material non-clean review/fix pass may raise effort early. A replacement receives an artifact handoff—SHAs, diffs, failing commands, raw reports, acceptance rows, and cited scope decisions—so it learns from prior attempts without inheriting conversation or private reasoning.

Calibration may schedule at most one controlled, low-risk boundary probe one verified step below a predicted start for a comparable group. It is never repeated on every issue and never used for reviewers. A lower-step capability failure followed by success at the predicted step is useful boundary evidence; it does not bypass the multi-issue threshold for changing the team default.

Per-issue telemetry records triage, exact model and effort, ladder step, boundary-probe purpose, escalation, reported cost/usage, review outcome, and integration evidence in a managed issue-body section. Unknown cost or effort remains `null`/`unknown`; historical values are never guessed. Before the feature PR, calibration reads all completed child issues and atomically updates `.agents/dynamic-implement/model-calibration.json` on the feature branch for the next root run.

## Independent review

Acceptance review starts in a new top-level process with zero conversation history. It receives only base/head SHAs, authoritative spec, repository standards, test seams, and permitted verification commands. It never receives the implementation plan, prior findings, claimed test results, or attempt history.

Matt's `code-review` remains mandatory and keeps Standards and Spec separate. When stale agent slots prevent its two native children, the coordinator launches exactly two concurrent ephemeral leaf reviewers with the unchanged Matt briefs. Each leaf performs one axis directly and cannot delegate again. Repository state must be unchanged before and after review.

## Observe and resume

Every role writes structured English events to its private directory. Schema-v2 events always record model and effort together. The coordinator announces the run-state path. Follow live activity with:

```sh
tail -F <run-state>/activity/*/activity.log
```

An agent is valid only with `started` and exactly one terminal `completed`, `blocked`, or `error` event. Missing terminal events, redundant leaf spawning, stale `pending_init` slots, and sandbox write failures are recorded as workflow evidence. External ephemeral processes may replace unavailable native slots when they preserve model, skill, isolation, logging, Git, and review contracts.

On resume, the coordinator re-fetches tracker state and inspects every recorded branch/worktree before choosing the next dependency-safe issue. A newly reopened blocker or defect may therefore become the next frontier even when an older plan named another issue.
