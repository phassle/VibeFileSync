# Dynamic Implement team guide

Dynamic Implement turns one spec-level tracker issue into planned, tested, independently reviewed, integrated work. The issue graph is the shared goal across harnesses; local Goals/tasks and the run ledger mirror it.

## Install

Install both portable skill directories for the harnesses used by the team:

- `dynamic-implement`
- `setup-dynamic-skills`

Also install Matt Pocock's official engineering skills. `implement`, `tdd`, `code-review`, and `setup-matt-pocock-skills` are mandatory. Dynamic Implement stops before mutation when they are unavailable.

Common personal locations:

| Harness | Skill location |
| --- | --- |
| Codex | `~/.codex/skills/` |
| Claude Code | `~/.claude/skills/` |
| GitHub Copilot | `~/.copilot/skills/` or `~/.agents/skills/` |
| OpenCode | `~/.config/opencode/skills/` or `~/.agents/skills/` |
| Pi | `~/.pi/agent/skills/` or `~/.agents/skills/` |

Keep capability profiles, credentials, calibration caches, and run ledgers outside the repository. The default capability profile is `~/.agents/dynamic-skills/capabilities.json`.

## Set up capabilities

Run `setup-dynamic-skills` on first use, after authentication/harness changes, when a selected route fails, or after the model catalog expires.

Setup performs three separate jobs:

1. Research current selectable models from installed harness surfaces and official documentation.
2. Live-verify only the routes the user approves and can actually call.
3. Map verified routes to Small/Luna, Medium/Terra, and Large/Sol.

The researched catalog expires after 14 days. A refresh researches the current model surface again before extending the expiry. Catalog freshness is separate from outcome calibration: the catalog says which models exist now; issue telemetry teaches which tier comparable work needed.

A tier bump is real only when it maps to a distinct verified route. Setup records no-op tier mappings explicitly. Paid probes require prior disclosure and approval.

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

Escalation begins at the smallest suitable verified tier. Two valid material non-clean review/fix passes trigger a bump even if the later pass reveals different findings. A higher-tier replacement receives an artifact handoff—SHAs, diffs, failing commands, raw reports, acceptance rows, and cited scope decisions—so it learns from prior attempts without inheriting conversation or private reasoning.

Per-issue telemetry records triage, routes, escalation, reported cost/usage, review outcome, and integration evidence in a managed issue-body section. Unknown cost remains `null`; it is never estimated. Before the feature PR, calibration reads all completed child issues and prepares routing feedback for the next root run.

## Independent review

Acceptance review starts in a new top-level process with zero conversation history. It receives only base/head SHAs, authoritative spec, repository standards, test seams, and permitted verification commands. It never receives the implementation plan, prior findings, claimed test results, or attempt history.

Matt's `code-review` remains mandatory and keeps Standards and Spec separate. When stale agent slots prevent its two native children, the coordinator launches exactly two concurrent ephemeral leaf reviewers with the unchanged Matt briefs. Each leaf performs one axis directly and cannot delegate again. Repository state must be unchanged before and after review.

## Observe and resume

Every role writes structured English events to its private directory. The coordinator announces the run-state path. Follow live activity with:

```sh
tail -F <run-state>/activity/*/activity.log
```

An agent is valid only with `started` and exactly one terminal `completed`, `blocked`, or `error` event. Missing terminal events, redundant leaf spawning, stale `pending_init` slots, and sandbox write failures are recorded as workflow evidence. External ephemeral processes may replace unavailable native slots when they preserve model, skill, isolation, logging, Git, and review contracts.

On resume, the coordinator re-fetches tracker state and inspects every recorded branch/worktree before choosing the next dependency-safe issue. A newly reopened blocker or defect may therefore become the next frontier even when an older plan named another issue.
