# TASK

Merge the following branches into `{{TARGET_BRANCH}}`, which is the branch you are on:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, verify the merge:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo test --features fault-injection --test acceptance
```

4. If anything fails, fix it before proceeding to the next branch

A branch that cannot be merged cleanly and made green is left unmerged. Say so
in a comment on its issue and move on, rather than forcing a resolution you are
unsure about.

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`gh issue close <ID> --comment "Completed by Sandcastle"`

Do not close an issue whose branch you left unmerged.

Here are all the issues:

{{ISSUES}}

# HAND OFF A PULL REQUEST WHEN A SPEC IS FINISHED

Merging into `{{TARGET_BRANCH}}` is not the end of the work. When every ticket
belonging to a spec is done, that spec leaves your hands as a **pull request**
for a human to review. Work is never silently complete.

After closing issues, for each parent Feature issue the merged tickets belong
to, check whether the spec is now finished:

```bash
gh issue view <FEATURE> --json title,url --jq '.title'
gh api repos/{owner}/{repo}/issues/<FEATURE> --jq .sub_issues_summary
```

The spec is finished when `completed` equals `total` and no sub-issue is still
open. If any remain open, do nothing here — you will get another chance after
the next iteration.

When it is finished, open one pull request from `{{TARGET_BRANCH}}` into
`develop`, following this repository's gitflow (`docs/agents/git-workflow.md`):

```bash
git push -u origin {{TARGET_BRANCH}}
gh pr create --base develop --head {{TARGET_BRANCH}} --title "<spec title>" --body-file -
```

The body must let a reviewer judge the work without reconstructing it:

- The parent Feature it closes, written as `Closes #<FEATURE>`.
- Every ticket that landed, one line each with its issue number and title.
- Any ticket left unmerged, with the reason, and an explicit statement that the
  spec is therefore incomplete. Never claim a spec is done when it is not.
- The verification actually run, and its real result. If a gate does not
  meaningfully cover the change — a Rust test suite over a change that touches
  no Rust, for instance — say so plainly rather than presenting a green run as
  evidence it is not.
- Anything a reviewer should look at first, especially a decision made on thin
  information.

Do not merge the pull request. Do not push to `develop`. The pull request is
the handoff: a human decides whether it lands.

If pushing or opening the pull request fails, say so in a comment on the parent
Feature issue rather than leaving the work stranded with no signal.

Once you've merged everything you can, and opened a pull request for any spec
that is now complete, output <promise>COMPLETE</promise>.
