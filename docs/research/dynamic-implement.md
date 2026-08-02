# Research: `dynamic-implement`

## Question

How should a Codex skill implement an issue that is specified at a feature/spec
level, while using the repository's Matt Pocock skills and its Git workflow?

## Primary-source findings

### Sandcastle provides the orchestration shape, not project policy

The installed Sandcastle template is already the **parallel planner with
review** variant. Its [`main.mts`](../../.sandcastle/main.mts) defines four
operational phases: plan, per-branch implement plus review, then a single
merge; its outer loop replans after every merge so newly unblocked work can be
selected (lines 1–17, 61–224). The local template is generated from Matt
Pocock's Sandcastle package (`@ai-hero/sandcastle` 0.12.0).

The upstream, commit-pinned primary source says the same. The
[parallel-planner template](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner/main.mts)
has a planner that emits a dependency graph and unblocked branch work, runs
issue work concurrently, then has one merger integrate completed branches.
The upstream [README template table](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L750-L762)
describes the template as planning parallelizable issues, executing them on
separate branches, then merging them. The upstream
[review variant](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner-with-review/main.mts#L1-L17)
adds a per-branch reviewer before the merger.

Sandcastle's own branch documentation is a useful safety constraint, but it
does not replace repository policy: concurrent session forks need **distinct
named branches**. `head` shares a working directory and `merge-to-head` can
race merges, so neither is safe for concurrent fan-out
([README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L929-L954)).

### The installed project configuration supplies the missing policy

* [`AGENTS.md`](../../AGENTS.md) and
  [`docs/agents/git-workflow.md`](../agents/git-workflow.md) require gitflow:
  branch each coherent change from `develop` as `feature/<kebab-name>`, never
  commit directly to `develop` or `main`, merge to `develop` via PR or
  `--no-ff`, then delete the feature branch. Documentation follows the same
  flow. Only throwaway `prototype/*` and `research/*` branches are exempt.
* [`docs/agents/issue-tracker.md`](../agents/issue-tracker.md) makes GitHub
  Issues authoritative and requires `gh issue view <number> --comments` when
  a skill fetches a ticket. It also defines native GitHub issue dependencies
  as the canonical representation of blockers.
* [`docs/agents/issue-hierarchy.md`](../agents/issue-hierarchy.md) defines
  **Feature** as the spec/PRD and **Issue** as a single-session tracer-bullet
  ticket. That means a feature-level input is not automatically safe to hand
  to an implementer; it normally needs its child issues and dependency edges.
* [`to-tickets`](../../.agents/skills/to-tickets/SKILL.md) requires those
  tickets to be vertical, independently verifiable, one fresh context window
  each, and to carry blocking edges. It directs agents to work only the
  unblocked frontier and use `$implement` one ticket at a time.
* [`implement`](../../.agents/skills/implement/SKILL.md) requires TDD where
  possible, regular typechecking and focused tests, a full suite before the
  end, `$code-review`, and a commit on the current branch.
* [`tdd`](../../.agents/skills/tdd/SKILL.md) adds a hard precondition that
  test seams are agreed with the user before tests are written. A planner must
  surface a missing seam agreement rather than silently invent it.
* [`code-review`](../../.agents/skills/code-review/SKILL.md) reviews a
  merge-base diff on separate **Standards** and **Spec** axes. It is the
  correct final gate for every slice, rather than a generic code-cleanup pass.

## Recommended `dynamic-implement` workflow

The skill should orchestrate; it should not duplicate `$implement`, TDD, or
`$code-review` rules. It accepts an issue number/URL plus an optional maximum
parallelism.

1. **Establish authority and inspect.** Fetch the supplied issue in full
   (body, labels, comments, dependencies, and hierarchy) with `gh`. Read
   `AGENTS.md`, issue-tracker configuration, domain context/ADRs, and the
   documented Git strategy. Reject an issue that is not a sufficiently
   specified Feature/Issue: explain whether it needs triage, `$to-spec`, or
   `$to-tickets` first.
2. **Plan before writing.** A planner produces an explicit slice plan:
   acceptance criteria, agreed test seams, a dependency/conflict graph,
   deterministic `feature/<kebab-name>` branch names, and a frontier. It may
   only schedule tickets with no open native blocker and no predicted
   overlapping-file/API conflict. A missing test-seam agreement, ambiguous
   acceptance criterion, or unresolved design decision is a blocker to report
   to the user, not a reason to implement a guess.
3. **Run only the frontier in parallel.** Give each ready slice its own named
   feature branch **and its own git worktree** based on the same current
   `develop` commit. Limit concurrency to available agent slots. Never let two
   writers share a worktree or a branch. Future slices wait until their native
   issue blockers are closed and the planner/replanner declares them safe.
4. **Delegate implementation faithfully.** Each implementer receives exactly
   one issue, its full spec context, the planner's test seams and its own
   worktree/branch. It invokes `$implement` for the implementation lifecycle:
   focused red/green loops where appropriate, regular typechecks and focused
   tests, full suite, then `$code-review`; it commits only to its feature
   branch. It does not merge, close the issue, or expand scope.
5. **Gate before integration.** The orchestrator verifies the branch is clean,
   has a committed diff against its original `develop` base, and records the
   test/review evidence. Any unresolved Standards or Spec finding returns to
   that same feature worktree for a fix and repeat review. Failed or no-commit
   branches are never handed to the merger.
6. **One merger owns `develop`.** Merge completed, gated branches serially
   into `develop` using the project rule (`--no-ff` or a PR targeting
   `develop`), resolve conflicts deliberately, and run the combined full suite
   and required static checks after every integration or at least before the
   batch is accepted. Never merge directly to `main`. Delete a feature branch
   only after successful integration.
7. **Complete the issue lifecycle and replan.** Post the merge commit, review
   result, and verification evidence to the issue, then close only merged
   issues. Re-fetch/recompute the issue frontier so dependencies that became
   unblocked can begin; repeat until the requested Feature's descendant issues
   are complete or a concrete external/user blocker remains.

## Required fail-safe for repositories without Git policy

Before creating any branch or worktree, search the repository instructions and
contribution documentation for a documented Git strategy. If none exists,
stop and ask the user to choose one. Offer **gitflow** as the recommended
default: `develop` integration branch, one `feature/<kebab-name>` branch per
slice, PR/`--no-ff` merge back to `develop`, and `main` for releases only.
The skill must not silently assume or create that policy.

## Design implications for the skill artifact

The first action is the planner, as requested. The planner should persist its
plan in the task output (and optionally an issue comment only with user
authorization), then an implementer follows it, then a single merger handles
integration. Replanning after each merge is essential: it makes parallelism
depend on actual completed blockers rather than a stale initial plan.

## Superpowers comparison: parallel workers and blind review

This comparison uses Obra's `superpowers` repository at commit
[`d884ae04edebef577e82ff7c4e143debd0bbec99`](https://github.com/obra/superpowers/tree/d884ae04edebef577e82ff7c4e143debd0bbec99).

### What transfers directly

* **Fresh agents receive curated context, not inherited conversation history.**
  Both `dispatching-parallel-agents` and `subagent-driven-development` say
  agents should never inherit the controller's session context or history;
  the controller constructs only the context required for the task
  ([parallel-agent overview](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/dispatching-parallel-agents/SKILL.md#L8-L14),
  [subagent-driven overview](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/subagent-driven-development/SKILL.md#L6-L12)).
  The parallel form is allowed only for independent domains with no shared
  state, and each prompt must be focused and self-contained
  ([selection rules](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/dispatching-parallel-agents/SKILL.md#L16-L45),
  [prompt contract](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/dispatching-parallel-agents/SKILL.md#L58-L92)).
* **Planning defines independently testable units and their interfaces.** The
  planning skill asks for exact files, produced/consumed interfaces, exact
  commands and expected results, and TDD-sized steps; a task boundary should
  carry its own test cycle and reviewer gate
  ([task sizing and structure](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/writing-plans/SKILL.md#L37-L126)).
* **Workspace isolation is a harness-aware precondition.** The worktree skill
  first detects whether the harness already supplied isolation, prefers a
  native worktree facility, falls back to `git worktree`, and verifies a clean
  test baseline before implementation
  ([worktree workflow](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/using-git-worktrees/SKILL.md#L6-L123)).
* **Completion needs fresh evidence.** The verification skill rejects an
  agent's success report as proof and requires the controller to run and read
  the command that proves the claim
  ([verification gate](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/verification-before-completion/SKILL.md#L16-L50),
  [delegation example](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/verification-before-completion/SKILL.md#L102-L105)).

### Important differences to preserve in `dynamic-implement`

`subagent-driven-development` is not itself a parallel-implementer workflow.
Its task loop dispatches one implementer, reviews that task, and then moves to
the next task; its red flags explicitly prohibit multiple implementation
subagents in parallel because of conflicts
([process](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/subagent-driven-development/SKILL.md#L45-L81),
[red flags](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/subagent-driven-development/SKILL.md#L374-L395)).
`dynamic-implement` can still run independent slices concurrently, but only by
combining the stricter independence test from `dispatching-parallel-agents`
with one branch and worktree per writer, predicted file/API conflict edges,
and serial integration by the merger.

Superpowers' task reviewer is **fresh-context but not fully blind**. It receives
the task brief, global constraints, a diff package, **and the implementer's own
report under “What the Implementer Claims They Built”**, although it is told to
distrust that report and verify claims against the diff
([reviewer inputs and distrust rule](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/subagent-driven-development/task-reviewer-prompt.md#L13-L55)).
That is weaker than the requested `dynamic-implement` rule. Its reviewer must
start as a new process/session with no inherited or forked context and receive
only:

1. the authoritative issue/spec and repository standards needed to judge it;
2. the immutable base/head identifiers and diff/review package; and
3. the review rubric and required output schema.

It must not receive the planner's reasoning, implementer identity, prompts,
conversation, self-review, report, claimed test result, earlier reviewer
findings, or the coordinator's prediction of what is correct. A re-review is
also a new blank reviewer, given the current authoritative spec and complete
current diff rather than the previous review narrative. Test execution evidence
can be verified by the coordinator after the blind verdict; including an
implementer-authored report would reintroduce the bias this rule removes.

Superpowers does advise explicitly selecting a model by task complexity and
using a capable model for final review, but it does **not** require a different
model family from the implementer and does not define a runtime cross-harness
model-discovery profile
([model selection](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/subagent-driven-development/SKILL.md#L99-L130)).
Its porting guide instead defines a per-harness tool-mapping layer and a static
capability checklist, with subagent dispatch explicitly degradable when absent
([harness architecture](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/docs/porting-to-a-new-harness.md#L31-L77),
[capability checklist](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/docs/porting-to-a-new-harness.md#L81-L122)).
Therefore a different-family reviewer and first-run harness probe are additions
to `dynamic-implement`, not behavior that can be inherited from Superpowers.
The blank-context guarantee is the primary gate; model-family diversity is a
secondary preference and must never be used as a substitute for a genuinely
new reviewer session.

## Explicit-only admission

`dynamic-implement` is a user-invoked root command. Ordinary prose, implicit
skill matching, and automatic model selection are not admission evidence. The
portable body uses a binary gate: either the host preserves its native explicit
skill/command invocation, or a local command adapter expands to
`DYNAMIC_IMPLEMENT_SLASH_ENTRY=1`. Downstream skills remain model-reachable
after the root gate so setup, TDD, review, and calibration can complete the
admitted run.

The host syntax cannot be identical because the command surfaces differ:

| Harness | Root entry | Mechanism |
| --- | --- | --- |
| Codex | `$dynamic-implement <issue>` or `/skills` selection | Native explicit skill invocation with `agents/openai.yaml` setting `allow_implicit_invocation: false`; no custom-prompt bridge ([skills](https://learn.chatgpt.com/docs/build-skills)). |
| Claude Code | `/dynamic-implement <issue>` | Native direct skill command with `disable-model-invocation: true`, which removes automatic model admission while retaining the user command ([invocation control](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill)). |
| GitHub Copilot | `/dynamic-implement <issue>` | Native direct skill command; `disable-model-invocation` prevents automatic CLI skill invocation ([CLI skill fields](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)). |
| OpenCode | `/dynamic-implement <issue>` | A Markdown command in `~/.config/opencode/commands/` expands to the admission marker and asks the native skill tool to load the portable body ([custom commands](https://opencode.ai/docs/commands/)). |
| Pi | `/skill:dynamic-implement <issue>` | Native forced skill loading; `disable-model-invocation: true` hides the skill from automatic model discovery while leaving the explicit command available ([skill invocation](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/skills.md#L68-L86)). |

Invocation metadata is a harness adapter rather than portable core behavior.
Codex uses `agents/openai.yaml` with `allow_implicit_invocation: false`; Claude,
Copilot, and Pi recognize the extended `disable-model-invocation: true`
frontmatter. Setup must verify explicit invocation or adapter-marker
preservation without spending model credits before it marks a harness eligible
for root entry.

## Testability and agent activity logs

The root command has two non-mutating test modes. `--smoke-test` checks local
explicit-entry adapters, required skills, repository/tracker/Git-policy
discovery, and logger operation without creating a Goal, branch, worktree,
commit, tracker update, PR, model session, or paid probe.
`--smoke-test=agents <issue>` is a live
read-only rehearsal of planner, implementer preflight, reviewer preflight, and
merger preflight. Because that route can consume model credits, setup must show
the exact routes and obtain approval before launching it.

Every coordinator, role agent, and child agent writes append-only private
events through the bundled `scripts/agent_log.py`. Events cover assignment,
start, observable decisions, command/check batches, file summaries, tests,
reviews, handoffs, next step/blocker, reported usage, and exactly one terminal
state. The script writes both JSONL and a readable line log, validates that each
agent started and terminated, and atomically renders the combined chronological
Markdown/JSONL view. Prompts, transcripts, hidden reasoning, secrets, raw
environment dumps, and full issue/code contents are excluded.

Review logging must preserve the zero-history boundary. Each review pass starts
with a separate empty bundle for the clean review coordinator and Matt
`code-review`'s Standards and Spec children. Each process sees only its own
destination; the main run ledger and earlier logs are absent. The root
coordinator imports and renders those three logs only after the top-level
reviewer exits. A missing or unterminated child log fails the smoke test and
blocks acceptance of the parent handoff.

Each smoke run also preserves a failure-oriented report. Every failed check is
linked to its first event and records expected versus observed behavior, a
minimal reproduction command, the suspected contract/harness boundary, and a
proposed skill or configuration change. Hypotheses stay labelled, and the
smoke run does not repair or rerun the failure; this keeps the evidence useful
for the next deliberate iteration.

## Additional harnesses: OpenCode and Pi

The following findings use OpenCode at commit
[`c69abee0c73253aebae65e87e4e1b9bfa8c38021`](https://github.com/anomalyco/opencode/tree/c69abee0c73253aebae65e87e4e1b9bfa8c38021)
and Pi at commit
[`e022eec37dee52790564f3af93819c34f3f78af1`](https://github.com/badlogic/pi-mono/tree/e022eec37dee52790564f3af93819c34f3f78af1).

### OpenCode

OpenCode natively implements Agent Skills and can load the same minimal
`SKILL.md` core. It discovers project skills in `.opencode/skills/`,
`.claude/skills/`, and `.agents/skills/`, and global skills in
`~/.config/opencode/skills/`, `~/.claude/skills/`, and `~/.agents/skills/`.
It requires `name` and `description` frontmatter and loads full skill content
on demand through its `skill` tool
([Agent Skills documentation](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/web/src/content/docs/skills.mdx#L6-L45),
[tool invocation](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/web/src/content/docs/skills.mdx#L103-L123)).
The shared `~/.agents/skills/dynamic-implement` installation is therefore
already a valid OpenCode personal installation; no OpenCode-only copy is
required.

`opencode run <prompt>` is the noninteractive entry point. `--continue` and
`--session` are the explicit resume paths and `--fork` is valid only with one
of them; without those flags the implementation creates a new session
([CLI contract](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/web/src/content/docs/cli.mdx#L339-L386),
[new-session source](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/opencode/src/cli/cmd/run.ts#L492-L527)).
That makes a direct invocation such as
`opencode run --model <provider/model> --format json <blind-review-prompt>` an
auditable blank reviewer boundary. It must omit `--continue`, `--session`, and
`--fork`; attaching to a server is acceptable only if it still creates a new
session and no session ID is reused.

OpenCode lists configured-provider candidates with `opencode models
[provider]`, using `provider/model` identifiers, and accepts the same format
through `--model`
([model-list command](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/web/src/content/docs/cli.mdx#L306-L334),
[model selection](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/web/src/content/docs/models.mdx#L204-L220)).
`dynamic-skills-setup` should treat that list as candidates, then run a
minimal fresh-session prompt before recording a model as callable; a cached
catalog entry alone is not authentication evidence. Model family must be
derived from the selected model identity, not just provider ID, because a
gateway provider can expose several families.

OpenCode also has native subagents. Its built-in `general` agent is intended
for multiple parallel units, and `subagent_depth` defaults to one level
([agent types](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/web/src/content/docs/agents.mdx#L16-L91),
[depth setting](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/web/src/content/docs/config.mdx#L541-L554)).
The Task tool creates a new child session when no `task_id` is supplied and
prompts that session only with the delegated prompt; supplying `task_id`
resumes an existing child
([Task parameters](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/opencode/src/tool/task.ts#L40-L53),
[child creation and prompt](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/opencode/src/tool/task.ts#L145-L220)).
That is suitable for isolated implementers. For the strict blind reviewer,
the separate `opencode run` process is preferable because it has neither a
parent session nor any temptation to reuse a task ID.

### Pi

Pi also implements the Agent Skills standard. It searches personal
`~/.pi/agent/skills/` and `~/.agents/skills/`, project `.pi/skills/` and
`.agents/skills/`, packages, configured paths, and explicit repeatable
`--skill` paths. Full instructions load on demand, and `/skill:<name>` forces
loading
([skills and locations](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/skills.md#L3-L41),
[loading and invocation](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/skills.md#L43-L86)).
The existing shared `~/.agents/skills/dynamic-implement` installation is valid
for Pi too. Project-local skills require project trust; a personal
`~/.agents/skills` install avoids making setup depend on an interactive trust
prompt.

Pi has a particularly strong direct blind-review command:
`pi -p --no-session --model <provider/model> "/skill:<review-skill> ..."`.
`-p` is noninteractive print mode, `--no-session` makes the run ephemeral, and
`--provider`/`--model` select the provider and model. The invocation must not
use `--continue`, `--resume`, `--session`, or `--fork`
([CLI options](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/usage.md#L190-L264),
[examples](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/usage.md#L266-L298)).
The same command may add `--no-extensions --no-skills --skill <exact-path>` to
load only an explicitly selected review skill; Pi documents explicit
`--skill` paths as additive even when discovery is disabled. Pi's prompt path
expands `/skill:<name>` into the selected `SKILL.md` body before calling the
model
([skill expansion source](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/src/core/agent-session.ts#L1285-L1316)).

Pi exposes callable model candidates through `pi --list-models [search]` and
selects them with `--provider` and `--model`. Its built-in authentication paths
include ChatGPT/Codex, Claude, and GitHub Copilot subscriptions as well as API
key providers
([provider authentication](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/providers.md#L1-L55),
[model CLI options](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/usage.md#L190-L208)).
As with OpenCode, setup should follow discovery with a minimal ephemeral model
call before marking it usable, and should record the actual model family rather
than assuming the harness or provider identifies the family.

Pi intentionally ships **without built-in subagents**. The official repository
instead includes an example extension that launches each subagent as a
separate Pi process with isolated context, supports parallel tasks, and invokes
children as `--mode json -p --no-session`
([core design](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/usage.md#L306-L310),
[subagent example](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/examples/extensions/subagent/README.md#L1-L18),
[parallel limits](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/examples/extensions/subagent/README.md#L88-L100),
[process invocation](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/examples/extensions/subagent/index.ts#L276-L320)).
Therefore setup must not mark Pi as having native subagent dispatch merely
because `pi` exists. It can always mark the direct ephemeral Pi process as an
eligible reviewer harness; parallel orchestration inside Pi requires a detected
extension/package or an explicit external process adapter.

## Full harness audit: durable work and a genuinely fresh reviewer

This audit was repeated against the installed command-line versions on 2026-07-16:
Codex CLI 0.144.0, Claude Code 2.1.211, GitHub Copilot CLI 1.0.71,
OpenCode 1.17.12, and Pi 0.70.5. Repository findings are pinned to Codex
[`0f44bca`](https://github.com/openai/codex/tree/0f44bca9154e056a32fde7a89026b4620599e6f2),
Claude Code
[`c39cb0f`](https://github.com/anthropics/claude-code/tree/c39cb0f14bfe8bb519bae5bfc55add6867c5e2ab),
Copilot CLI
[`fd24cea`](https://github.com/github/copilot-cli/tree/fd24cea5cb11da4e630485ff2d9269318b8c2a4e),
and the OpenCode/Pi commits cited above. A feature being present in one surface
does not imply that every host embedding the same engine exposes it.

### Capability matrix

| Harness | Goal/task durability and continuation | Zero-history review boundary | Skills | Parallel/subagent fit | Models |
| --- | --- | --- | --- | --- | --- |
| **Codex App/runtime + CLI** | **First-class Goal: yes in the current App/runtime.** A goal stores objective, status, optional token budget, token/time accounting; statuses include active, paused, blocked, usage-limited, budget-limited, and complete. It is restored from the state database on resume and automatically launches another turn when the live thread is idle ([tool contract](https://github.com/openai/codex/blob/0f44bca9154e056a32fde7a89026b4620599e6f2/codex-rs/ext/goal/src/spec.rs), [restore/continue runtime](https://github.com/openai/codex/blob/0f44bca9154e056a32fde7a89026b4620599e6f2/codex-rs/ext/goal/src/runtime.rs#L335-L411), [persisted model](https://github.com/openai/codex/blob/0f44bca9154e056a32fde7a89026b4620599e6f2/codex-rs/state/src/model/thread_goal.rs#L14-L80)). Installed feature discovery reports `goals` stable/enabled. **Caveat:** this is an App/app-server capability; do not assume an arbitrary Codex CLI embedding exposes the three goal tools. | **Strong.** Start a separate process: `codex exec --ephemeral --ignore-user-config -s read-only -m <model> <review-prompt>`. Do not use `exec resume`, thread resume, or fork. `--ephemeral` prevents session persistence; the installed help is the source for this still-evolving flag. | Project `.codex/skills` and `.agents/skills`; personal legacy `$CODEX_HOME/skills` plus shared `~/.agents/skills`, loaded by the current core loader ([loader](https://github.com/openai/codex/blob/0f44bca9154e056a32fde7a89026b4620599e6f2/codex-rs/core-skills/src/loader.rs#L300-L420)). | Native multi-agent dispatch is stable/enabled in the installed build and is sufficient for planners/implementers. For the reviewer, use the separate ephemeral CLI process, not a forked or parent-authored child. | Explicit `-m/--model`; app-server provides `model/list` ([protocol](https://github.com/openai/codex/blob/0f44bca9154e056a32fde7a89026b4620599e6f2/codex-rs/app-server/README.md#L202-L204)). There is no equally simple documented `codex models` CLI command; setup may query app-server where available, then smoke-test the chosen ID. |
| **Claude Code** | **Goal-equivalent: no. Durable task list: yes.** Interactive Claude has `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate` (pending/in-progress/completed plus dependencies); print/SDK mode also exposes task tracking ([tools](https://code.claude.com/docs/en/tools-reference)). Tasks survive context compaction and a named `CLAUDE_CODE_TASK_LIST_ID` shares `~/.claude/tasks/<id>/` across sessions ([task-list lifecycle](https://code.claude.com/docs/en/interactive-mode#task-list)). This is durable bookkeeping, **not a Goal engine**: the official lifecycle does not say that an incomplete task starts a new turn after the agent becomes idle or after process exit. Background agents are a separate execution mechanism. | **Strongest native command.** `claude -p --bare --no-session-persistence --model <model> <review-prompt>`. `--bare` strips hooks, plugin sync, auto-memory and `CLAUDE.md` auto-discovery while still allowing an explicitly named skill; `--no-session-persistence` makes the print-mode session non-resumable ([CLI reference](https://code.claude.com/docs/en/cli-usage)). Do not use `--continue`, `--resume`, a fork, or `context: fork`. | Personal `~/.claude/skills`, project `.claude/skills`, plugin skills; direct `/skill-name` invocation; implements the Agent Skills standard ([skills](https://code.claude.com/docs/en/skills#where-skills-live)). Shared `~/.agents/skills` is **not documented as a Claude Code discovery root**, so setup needs a Claude-specific install/symlink/plugin copy. | Native subagents start with isolated context and support parallel work, custom tools/model/worktree, but cannot themselves spawn subagents ([subagents](https://code.claude.com/docs/en/sub-agents#manage-subagent-context)). This is sufficient when the top-level orchestrator owns fan-out. A normal subagent still receives a delegation message and ambient rules, so it is not the strict blind-review boundary. | Explicit `--model` and `/model`; Claude aliases/full IDs are documented ([CLI reference](https://code.claude.com/docs/en/cli-usage)). Native selection is within the Claude family even when routed through Bedrock, Vertex, or Foundry; there is no documented native GPT/Codex-family selector. |
| **GitHub Copilot CLI / desktop-app launcher** | **No Codex-style Goal object.** CLI sessions persist event logs, plans, checkpoints, and tracked files and can resume; `/tasks` manages running subagents/shell commands ([session storage](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference#session-state), [commands](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)). Autopilot does auto-continue until `task_complete`, a blocker/interrupt, or the configured continuation cap ([autopilot](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot)). Thus it has a durable resumable session plus an auto-run mode, but no documented persistent objective/status/budget Goal API. The desktop app is launched by `/app`; app-specific task durability beyond this shared CLI/session surface remains **unknown**. | **Fresh at entry, but not ephemeral.** `copilot -p --model <model> --no-custom-instructions --no-remote --no-remote-export --available-tools '<read-only set>' <review-prompt>`, with no `--continue`, `--resume`, `--connect`, or existing `--session-id`. Prompt-mode memory is disabled unless `--enable-memory` is passed ([flags](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#command-line-options)). A new session starts without prior conversation but is saved afterward; no documented `--no-session-persistence` flag exists. `/review` and `/rubber-duck` inside the implementer's session are useful critiques but fail the strict standalone-process rule. | Project `.github/skills`, `.claude/skills`, `.agents/skills`; personal `~/.copilot/skills`, `~/.agents/skills`; `/skills` and automatic loading ([skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)). | `/fleet` decomposes work and runs independent subagents in parallel, each in a separate context, with custom-agent and per-subtask model choice ([fleet](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet)). Sufficient for orchestration; strict review still uses a new top-level CLI process. | `/model`/`/models` discovers choices and `--model` selects explicitly. Current official choices span Claude, GPT/Codex, Gemini, and MAI ([model table](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#supported-models)); this is the best native different-family reviewer path. |
| **OpenCode** | **No Goal. Session todo: yes.** `todowrite` stores pending/in-progress/completed items in a database table keyed by session, and the server exposes `GET /session/:id/todo` ([todo service](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/opencode/src/session/todo.ts), [server API](https://github.com/anomalyco/opencode/blob/c69abee0c73253aebae65e87e4e1b9bfa8c38021/packages/web/src/content/docs/server.mdx)). Sessions can be listed/resumed, but no primary source documents a named cross-session task list or an idle auto-continuation engine. | **Strong new-session boundary, not proven nonpersistent.** Use the separate `opencode run --model <provider/model> ...` command described above, with no resume/session/fork flags. It creates a new session, but there is no documented ephemeral flag in this command. | Native Agent Skills and shared `~/.agents/skills`, as detailed above. | Native fresh child sessions and parallel `general` agents; sufficient, but a separate `run` process is stricter for review. | `opencode models` plus explicit `provider/model`, followed by a live probe. |
| **Pi** | **No Goal and no built-in todo/task system.** Pi explicitly omits built-in to-dos and subagents; it has resumable conversations but no durable work object or automatic idle continuation ([design](https://github.com/badlogic/pi-mono/blob/e022eec37dee52790564f3af93819c34f3f78af1/packages/coding-agent/docs/usage.md#L300-L313)). | **Strong.** `pi -p --no-session --no-extensions --no-skills --skill <exact-review-skill> --provider <provider> --model <model> <review-prompt>` is a separate, ephemeral process with only the explicitly selected skill. | Native Agent Skills and shared `~/.agents/skills`, as detailed above. | External-process/example extension only, not native; setup must detect/configure that adapter. | `pi --list-models`, explicit provider/model, and a live ephemeral probe. |

### Non-negotiable reviewer isolation contract

“Empty context” cannot literally mean no system prompt or no repository files:
the reviewer must know the acceptance criteria and must be able to read the
diff. It means **zero prior conversational or implementation context**. The
portable guarantee is therefore a brand-new top-level process/session, never a
fork/resume/continued task, supplied only with:

1. the authoritative issue/spec and review rubric;
2. repository standards that are part of the judgment criteria; and
3. immutable base/head identifiers (or the complete current diff).

The process must not receive planner reasoning, implementer prompts, transcript,
memory, self-review, claimed test results, prior reviewer findings, or a parent
agent's summary. Every re-review repeats this procedure in another new session.
Native “fresh subagent context” is insufficient for this contract because the
parent still composes its delegation message and can leak foreknowledge. The
setup probe must test the exact standalone command and reject a harness adapter
that can only fork, resume, or inherit the controller's session.

### What `dynamic-implement` may rely on

Only Codex currently provides the complete persistent Goal lifecycle required
for unattended resume plus automatic idle continuation. Copilot Autopilot can
continue within a running task, but its durable unit is the session, not a Goal.
Claude's named task lists are genuinely durable and dependency-aware, but they
do not themselves schedule another model turn. OpenCode todos are session
state, and Pi has neither feature. Therefore the portable skill core must keep
its own orchestration ledger (issue IDs, branches/worktrees, gates, tests,
reviews, and integration status); a harness adapter may mirror that ledger into
native Goal/task/todo state, but must never treat the latter as the sole source
of truth.

### Resulting capability-probe rules

For every detected harness, `dynamic-skills-setup` should separately record:

1. skill discovery (does the shared `dynamic-implement` name appear/load?);
2. candidate models through that harness's documented catalog/selector
   (`model/list`, `/model`, `opencode models`, or `pi --list-models`);
3. a successful minimal call for each selected model, including model family;
4. native subagent support versus external-process-only support; and
5. a tested blank-review command that starts a new, non-resumed session.

The blank-review command is the acceptance test. A second model family is
useful only after the setup probe has proved that the reviewer starts without
the controller's conversation history.

`docs/research/` did not exist before this note, so this file establishes the
repository's research-note location. It is intentionally on the throwaway
`research/dynamic-implement` branch and must not be merged under the current
gitflow exemption.
