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

`docs/research/` did not exist before this note, so this file establishes the
repository's research-note location. It is intentionally on the throwaway
`research/dynamic-implement` branch and must not be merged under the current
gitflow exemption.
