# TASK

Review the code changes on branch `{{BRANCH}}`.

This runs in two parts, and the order matters. **First** review against the spec,
because code that follows every standard while implementing the wrong thing is
still wrong, and a clarity pass will not notice. **Then** improve clarity,
consistency and maintainability while preserving exact functionality.

# CONTEXT

## The originating issue - what this change was supposed to do

!`gh issue view {{TASK_ID}} --json number,title,body,labels --jq '"#\(.number) \(.title)\n\n\(.body)"'`

If that issue has a parent Feature, read it too: its acceptance criteria and its
`## Testing Decisions` are the contract this branch is judged against.

## Branch diff

!`git diff {{BASE_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{BASE_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

0. **Check the change against the spec, and report that separately.** Does the
   branch do what the issue asked - every acceptance criterion, not most of
   them? Is anything asserted by a test that the issue never asked for? Is any
   criterion unmet, or met only in appearance? Report spec findings under their
   own heading and do not let them be reworded into style findings; a spec
   failure and a standards failure are different failures and one must never
   mask the other. If an acceptance criterion is unmet, say so plainly and do
   not paper over it with a refactor.

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Prefer `match` over nested `if let` chains when branching on an enum
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there `unwrap`/`expect` calls on values that can fail at runtime, new `unsafe` blocks without a safety comment, or unchecked assumptions about filesystem state?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

6. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on this branch
2. Run `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test` and `cargo test --features fault-injection --test acceptance` to ensure nothing is broken
3. Commit describing the refinements

If the code is already clean and well-structured, do nothing.

Once complete, output <promise>COMPLETE</promise>.
