# ISSUES

Here are the open issues in the repo:

<issues-json>

!`gh issue list --state open --label Sandcastle --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

</issues-json>

The list above has already been filtered to issues ready for work.

# RECORDED DEPENDENCIES

Blocking edges may already exist. `/to-tickets` records them as native GitHub
issue dependencies when it creates a ticket set, and a human may have added or
corrected them since. Those are decisions, not hints.

Read them first:

!`gh issue list --state open --label Sandcastle --limit 100 --json number --jq '.[].number' | while read n; do printf '%s blocked_by=%s\n' "$n" "$(gh api repos/{owner}/{repo}/issues/$n --jq '.issue_dependencies_summary.blocked_by' 2>/dev/null)"; done`

`blocked_by` counts **open** blockers only, so it is the live gate: a non-zero
value means that issue is not ready, whatever your own reading of the text
suggests. An issue's body may also carry a `## Blocked by` section listing
issue numbers.

**A recorded edge wins over your inference.** Never treat an issue as unblocked
because you judged the dependency unnecessary — a human approved that edge, and
you are not seeing what they saw. You may only *add* edges you discover; you
may never remove one. If a recorded edge looks wrong, still treat the issue as
blocked, and say so in your reasoning rather than acting on it.

# TASK

For issues with no recorded edges, infer them. For each such issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

For each unblocked issue, assign a branch name using the exact format `sandcastle/issue-{id}` (no slug or other suffix). This must be deterministic so that re-planning the same issue always produces the same branch name and accumulated progress is preserved.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).

Always emit the `<plan>` tags, even when there is nothing to do. If there are no issues to work on at all, output `<plan>{"issues": []}</plan>` so the run can exit cleanly.
