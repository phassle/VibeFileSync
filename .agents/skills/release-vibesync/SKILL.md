---
name: release-vibesync
description: "Prepare and integrate a VibeSync release using this repository's manual gitflow. Use when cutting a version, creating a release branch, validating a release build, or merging an approved release to main and back to develop."
---

# Release VibeSync

Follow manual gitflow (`docs/agents/git-workflow.md:1`). No CI workflow, release artifact automation, signing policy, or established tag convention exists in this checkout.

## Preconditions

1. Require an explicit version and authorization for release-state changes.
2. Inspect `git status --short --branch`, local/remote divergence, and existing tags.
3. Preserve unrelated work. Start only from a clean, current `develop`.
4. Stop before push, PR, merge, tag, or publication unless the user authorized that action.

## Prepare release

1. Create `release/<version>` from `develop`; releases are the exception to normal feature branches (`docs/agents/git-workflow.md:5`).
2. Update package version at `Cargo.toml:3`.
3. Run `cargo check` to regenerate `Cargo.lock`; confirm the diff contains only intended release changes.
4. Update release-facing docs only when the requested release needs them. Do not invent changelog or artifact files.
5. Invoke `$test-vibesync` and require every full gate to pass.
6. Invoke `$build-vibesync` for `cargo build --release --locked`.
7. Smoke `target/release/vibesync --version` and `target/release/vibesync --help`.
8. Commit intentionally on the release branch.

## Integrate approved release

1. Merge `release/<version>` into `main` through a PR or `--no-ff`; never direct-commit to `main` (`docs/agents/git-workflow.md:7`).
2. Tag or publish only after the maintainer supplies the convention and artifact destination.
3. Merge the same release branch back into `develop` with `--no-ff` so version/release edits remain integrated.
4. Re-run the full test gate if conflict resolution changed content.
5. Delete the release branch after both integrations succeed.
6. Report commit ids, merges, tests, binary path, and anything intentionally not published.

Normal feature/docs PRs still target `develop`; only release/hotfix integration advances `main` (`docs/agents/git-workflow.md:5`).
