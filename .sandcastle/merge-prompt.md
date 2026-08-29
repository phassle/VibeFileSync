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

Once you've merged everything you can, output <promise>COMPLETE</promise>.
