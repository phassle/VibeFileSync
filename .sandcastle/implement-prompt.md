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

You are the loop, not the builder. You get up to 100 iterations on this issue,
and anything you read into your own context stays there for all of them. Cargo
output is the worst offender: one `cargo clippy --all-targets --all-features`
on a cold target dir can be thousands of lines, and a few of those crowd out
the issue you are actually working on.

So delegate the bulky work to subagents and keep your own context as the thin
driver that decides what happens next:

- Exploring the codebase to find where a change belongs, tracing a call path,
  or working out which tests cover an area: send a subagent, ask for the file
  and line answer, not the excerpts.
- Running the four feedback-loop commands: send a subagent and ask it to report
  pass/fail plus only the failing output. Do not pull a clean 119-test run into
  your context to learn one word.
- Reading long files or ADRs to answer a specific question: send a subagent
  with the question.

Keep in your own context: the issue text, the decision you are making, and the
failures you are actively resolving. You own the decisions; the subagents own
the volume. Always verify the resulting diff yourself rather than trusting a
subagent's summary that the edit went in.

## The test and the implementation come from different subagents

This one is not negotiable. **Never let a single subagent write both the test
and the code it tests.** An agent holding both sides will, when the test fails,
quietly adjust the test until it passes - not from dishonesty, but because
making the pair agree is the shortest path and it can see both sides. The test
then encodes what the code does instead of what the issue asked for, and it
passes forever without protecting anything. That failure is invisible in a
green run, which is exactly what makes it dangerous.

So split the work:

1. **RED - a test subagent** writes one failing test from the issue and the
   Expected behaviour, and never sees your implementation plan. Give it the
   issue text and the relevant existing test conventions, not your intended
   diff. Have it confirm the test fails, and report *how* it fails - a test
   that passes before the change, or fails for an unrelated reason such as a
   compile error, is not a red test.
2. **GREEN - an implementation subagent** makes that test pass without editing
   it. State plainly that the test file is read-only for this subagent. If it
   reports the test is wrong, that comes back to you as a claim to judge, not
   as a licence to edit.
3. **REPEAT** for the next behaviour, with fresh subagents each time.
4. **REFACTOR** once the behaviour is covered, with the tests held fixed.

If a test genuinely does need to change - the issue was misread, or the test
asserts something the spec never asked for - **you** make that call in your own
context and say so in the commit message. Never let the agent that is trying to
turn the test green be the one that decides the test was wrong.

Run the four feedback-loop commands in a third subagent, separate from both, so
the run that judges the work is not made by the agent that produced it.

Refactoring is not part of the red-green loop. It happens after the behaviour is
covered, with the tests held fixed.

## Test only at seams the spec already agreed

Do not invent a seam. When this issue has a parent Feature, its
`## Testing Decisions` section names the modules to be tested and the prior art
to follow - that is the agreed seam, and the RED subagent must be given it
along with the issue text. If no parent Feature says, ask rather than guessing:
a test at an unagreed seam locks in a shape nobody approved.

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
