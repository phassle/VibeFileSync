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
`setup-dynamic-skills` should treat that list as candidates, then run a
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

### Resulting capability-probe rules

For both harnesses, `setup-dynamic-skills` should separately record:

1. skill discovery (does the shared `dynamic-implement` name appear/load?);
2. candidate models (`opencode models` or `pi --list-models`);
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
