---
name: test-vibesync
description: "Run and interpret VibeSync's Rust checks and safety tests. Use after code or dependency changes, before review/release, for targeted regressions, or when validating fault handling and filesystem invariants."
---

# Test VibeSync

Run on Darwin arm64. Unit tests exercise pure seams; `tests/cli.rs:20` spawns the real binary against isolated config/temp trees.

## Targeted loop

1. Identify the nearest named test with `rg -n '^fn .*\(\)' src tests/cli.rs`.
2. Run one test with `cargo test --locked <test-name>`.
3. For an integration-only case, use `cargo test --locked --test cli <test-name>`.
4. Re-run the full gate before declaring success.

## Full gate

1. Run `cargo fmt --check`.
2. Run `cargo clippy --locked --all-targets --all-features -- -D warnings`.
3. Run `cargo test --locked`.
4. Run `cargo test --locked --features fault-injection`.
5. Report passed/failed counts and every skipped gate.

The feature-gated suite covers low-space and mid-copy ENOSPC controls at `src/preconditions.rs:161` and `src/run.rs:148`. Relevant integration assertions: `tests/cli.rs:1063` and `tests/cli.rs:1090`.

Test observable guarantees: no unreviewed mutation (`tests/cli.rs:710`), no partial final path (`tests/cli.rs:789`), old version archived before replacement (`tests/cli.rs:877`), machinery untouched (`tests/cli.rs:648`). Read `docs/adr/0009-acceptance-test-harness.md:1` only when changing crash/convergence coverage.
