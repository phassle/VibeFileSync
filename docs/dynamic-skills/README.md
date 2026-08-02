# Dynamic Implement skill bundle

This bundle turns one spec-level issue into planned, test-driven, independently reviewed, integrated work while preserving the repository's issue-tracker and Git policies.

## How it works

Dynamic Implement is a technical orchestration layer built on top of Matt Pocock's engineering skills. It turns a high-level GitHub issue into an integrated change by coordinating planning, implementation, testing, independent review, and Git integration.

It uses `wayfinder` to map the codebase and issue dependencies, `implement` and `tdd` to deliver each isolated subtask, and `code-review` to separately assess specification compliance and engineering standards. `to-tickets` can decompose larger work when needed.

For an implementation run, Dynamic Implement reads and plans the issue graph, selects a live-verified model and reasoning-effort step from a calibrated escalation ladder, and assigns each subtask its own branch and worktree. Implementers run focused and full checks before handoff. A clean review process receives no implementation conversation history, and approved work follows the repository's Git workflow into its integration target.

Each completed run records model and effort choices, escalations, test evidence, review outcomes, and integration evidence. This telemetry calibrates future runs, enabling increasingly reliable model routing over time.

## Included skills

Install all three directories as one compatible set:

| Skill | Purpose | Normal entry |
| --- | --- | --- |
| `dynamic-implement` | Orient current work without an argument, or execute one issue through integration | Explicit invocation |
| `dynamic-skills-setup` | Research and live-verify available model and reasoning-effort steps | Manual setup only |
| `dynamic-skills-calibrate` | Convert completed issue telemetry into repository-owned routing knowledge | Invoked before a feature PR or manually |

Do not copy only `SKILL.md`. Each complete directory is required because Dynamic Implement also uses bundled references, scripts, and UI metadata.

## Requirements

- Git and the repository's configured issue-tracker client. GitHub repositories normally require an authenticated `gh` CLI.
- Python 3 for the structured agent activity logger.
- At least one supported coding harness: Codex, Claude Code, GitHub Copilot, OpenCode, or Pi.
- [Matt Pocock's engineering skills](https://github.com/mattpocock/skills). Dynamic Implement requires `wayfinder`, `implement`, `tdd`, `code-review`, and `setup-matt-pocock-skills`; install `to-tickets` as well when large specs may need decomposition.

Install Matt Pocock's current skills with the interactive installer:

```sh
npx skills@latest add mattpocock/skills
```

Select the required skills above, their reported dependencies, and every harness that will run Dynamic Implement. Then run `setup-matt-pocock-skills` once in each repository.

## Install from GitHub

After this bundle is published, use the open [skills CLI](https://github.com/vercel-labs/skills) and replace `<owner>/<repository>` with its GitHub repository:

```sh
npx skills@latest add <owner>/<repository>
```

Select all three Dynamic Implement skills and the desired coding harnesses. Choose global scope for personal use across repositories or project scope when the team will commit the installed skills. If the installer does not offer Pi, use the shared-build manual installation below.

The interactive installer is recommended because supported agent identifiers and installation paths may change. To inspect a release before installing it:

```sh
npx skills@latest add <owner>/<repository> --list
```

## Manual installation

Use the Codex build for Codex and the shared build for Claude Code, GitHub Copilot, OpenCode, and Pi. This distinction preserves Codex-compatible frontmatter while preventing implicit Dynamic Implement and setup invocation on harnesses that support that policy.

Set one source variable to a directory containing these three complete folders:

```text
dynamic-implement/
dynamic-skills-setup/
dynamic-skills-calibrate/
```

Then copy the folders into the appropriate personal location:

| Harness | Build | Personal destination |
| --- | --- | --- |
| Codex | Codex | `~/.codex/skills/` |
| Claude Code | Shared | `~/.claude/skills/` |
| GitHub Copilot | Shared | `~/.copilot/skills/` or `~/.agents/skills/` |
| OpenCode | Shared | `~/.config/opencode/skills/` or `~/.agents/skills/` |
| Pi | Shared | `~/.pi/agent/skills/` or `~/.agents/skills/` |

Example for Codex:

```sh
CODEX_SKILLS_SOURCE=/absolute/path/to/codex-build
mkdir -p ~/.codex/skills
for skill in dynamic-implement dynamic-skills-setup dynamic-skills-calibrate; do
  cp -R "${CODEX_SKILLS_SOURCE}/${skill}" ~/.codex/skills/
done
```

Example for a shared Agent Skills installation:

```sh
SHARED_SKILLS_SOURCE=/absolute/path/to/shared-build
mkdir -p ~/.agents/skills
for skill in dynamic-implement dynamic-skills-setup dynamic-skills-calibrate; do
  cp -R "${SHARED_SKILLS_SOURCE}/${skill}" ~/.agents/skills/
done
```

Remove or replace an older destination directory before copying a new release. Do not merge files from different releases into one installed skill directory.

## OpenCode command adapters

OpenCode needs explicit custom-command adapters for the two user-entered commands. Install the bundle's `dynamic-implement.md` and `dynamic-skills-setup.md` adapters under:

```text
~/.config/opencode/commands/
```

The Dynamic Implement adapter must preserve `DYNAMIC_IMPLEMENT_SLASH_ENTRY=1`; otherwise the root invocation gate rejects the run. Calibration is normally called by the coordinator and does not need a user command adapter.

If a release does not provide the adapters, create `dynamic-implement.md` with:

```markdown
---
description: Run or smoke-test dynamic implementation
---

DYNAMIC_IMPLEMENT_SLASH_ENTRY=1

Load the installed `dynamic-implement` skill through the native skill tool. With no arguments, run its read-only Wayfinder-based orientation mode and stop. Otherwise execute it for this issue, URL, or smoke-test flag: $ARGUMENTS
```

Create `dynamic-skills-setup.md` with:

```markdown
---
description: Manually configure Dynamic Implement capabilities
---

SETUP_DYNAMIC_SKILLS_SLASH_ENTRY=1

Load the installed `dynamic-skills-setup` skill through the native skill tool and execute manual setup. Do not continue into issue implementation: $ARGUMENTS
```

## First-time repository setup

Run Matt Pocock's repository setup first. It records the issue tracker, triage vocabulary, and domain-document layout expected by the engineering skills:

| Harness | Entry |
| --- | --- |
| Codex | `$setup-matt-pocock-skills` |
| Claude Code, GitHub Copilot, OpenCode | `/setup-matt-pocock-skills` |
| Pi | `/skill:setup-matt-pocock-skills` |

Next, run Dynamic Implement capability setup manually:

| Harness | Manual setup entry |
| --- | --- |
| Codex | `$dynamic-skills-setup` or select it through `/skills` |
| Claude Code | `/dynamic-skills-setup` |
| GitHub Copilot | `/dynamic-skills-setup` |
| OpenCode | `/dynamic-skills-setup` through its command adapter |
| Pi | `/skill:dynamic-skills-setup` |

Setup researches the current models and native reasoning-effort values, shows the complete candidate probe matrix and expected paid ceiling, and asks once before any paid live probes. It stores the verified machine-local capability profile at:

```text
~/.agents/dynamic-skills/capabilities.json
```

The model catalog expires after 14 days. Dynamic Implement never runs setup automatically; it stops safely and reports the exact manual command when setup is absent, stale, or incomplete.

The no-issue orientation mode does not require this model capability setup because it creates no model session or implementation state. It still requires `wayfinder` and the repository configuration produced by `setup-matt-pocock-skills`.

## Verify the installation

Confirm that the harness lists all three skills. First test read-only orientation by invoking Dynamic Implement with no argument:

| Harness | Orientation entry |
| --- | --- |
| Codex | `$dynamic-implement` |
| Claude Code | `/dynamic-implement` |
| GitHub Copilot | `/dynamic-implement` |
| OpenCode | `/dynamic-implement` |
| Pi | `/skill:dynamic-implement` |

It should summarize completed, active, blocked, and ready work; apply Wayfinder frontier semantics; propose a dependency-safe next flow; and stop without mutations. If nothing is actionable, it should offer to shape a new feature together.

Then run the structural smoke test:

```text
$dynamic-implement --smoke-test
```

Use the equivalent explicit syntax for another harness. The structural smoke test must not create a branch, worktree, commit, issue update, PR, model session, or paid probe.

After manual setup succeeds, invoke a real issue explicitly:

| Harness | Example |
| --- | --- |
| Codex | `$dynamic-implement #14` |
| Claude Code | `/dynamic-implement #14` |
| GitHub Copilot | `/dynamic-implement #14` |
| OpenCode | `/dynamic-implement #14` |
| Pi | `/skill:dynamic-implement #14` |

Ordinary natural-language intent must not start a root implementation run.

## Team-owned knowledge and upgrades

Installed skill directories contain workflow code, not learned model data. Skill upgrades may replace them safely.

Keep the two data layers separate:

| Data | Location | Ownership |
| --- | --- | --- |
| Executables, authentication state, live model/effort availability | `~/.agents/dynamic-skills/capabilities.json` | Local installation |
| Eval outcomes, cost ranges, observed boundaries, and recommended starting steps | `<repository>/.agents/dynamic-implement/model-calibration.json` | Version-controlled team knowledge |

Never store learned findings inside an installed skill directory. `dynamic-skills-calibrate` updates the repository-owned file through the repository's Git strategy, so every team member receives the same compact evidence and a skill update cannot overwrite it.

## Updating

For a skills CLI installation, inspect and apply available updates with the CLI's current update command. Re-run manual capability setup after a harness version, authentication, model surface, or reasoning-effort control changes—and whenever the 14-day catalog expires.

For a manual installation, replace all three skill directories from the same release. Preserve the local capability profile and repository-owned calibration file; neither belongs inside the replaced directories.

## Troubleshooting

- **Dynamic Implement asks for setup:** expected when the local profile is absent, expired, lacks a catalog fingerprint, or has no live-verified model/effort ladder. Run the displayed manual setup command.
- **A required Matt skill is missing:** reinstall the official engineering set and run `setup-matt-pocock-skills` in the repository.
- **OpenCode rejects the root invocation:** verify the custom command adapter exists and retains `DYNAMIC_IMPLEMENT_SLASH_ENTRY=1`.
- **A reviewer route is unavailable:** rerun manual setup. Never substitute an unverified model or a reviewer carrying implementation context.
- **Old activity lacks effort:** schema-1 logs remain readable, but historical effort is intentionally not guessed. Only new schema-2 events require the model/effort pair.

See the [team guide](../dynamic-implement.md) for orchestration, Git, calibration, observability, and clean-context review behavior.
