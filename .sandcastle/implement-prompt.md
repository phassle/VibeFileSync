# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view {{TASK_ID}}`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}, which branched from {{BASE_BRANCH}}. Make commits and run tests.

# CONTEXT

This is `vibesync`, a Rust binary for macOS on Apple Silicon. It links macOS
libSystem directly (`copyfile(3)`, `F_FULLFSYNC`), so it only builds and tests
on macOS. Read `AGENTS.md`, `CONTEXT.md` and `.sandcastle/CODING_STANDARDS.md`
before you change anything, and check `docs/adr/` for a decision record that
already covers the area you are touching.

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, all four must pass:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo test --features fault-injection --test acceptance
```

The acceptance suite needs `--features fault-injection`, it does not compile
without it. Never commit with a failing or ignored test. If a test cannot pass
for a reason outside this issue, say so in the issue comment rather than
weakening the test.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
