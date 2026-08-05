---
name: test-vibesync
description: "Run and interpret VibeSync's Rust checks and safety tests. Use after code or dependency changes, before review/release, for targeted regressions, or when validating fault handling and filesystem invariants."
---

# Test VibeSync

Run on Darwin arm64. Unit tests exercise pure seams; `tests/cli.rs::Fixture` spawns the real binary against isolated config/temp trees.

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

The feature-gated suite covers the low-space gate (`src/preconditions.rs::enforce_space`) and mid-copy ENOSPC through the injection seam (`src/run.rs::fault_at`). Relevant integration assertions: `tests/cli.rs::insufficient_space_aborts_before_mutation_and_its_override_runs_the_copy` and `tests/cli.rs::injected_enospc_discards_temp_retains_commits_and_exits_nonzero`.

Test observable guarantees: no unreviewed mutation (`tests/cli.rs::declining_run_leaves_both_trees_untouched`), no partial final path (`tests/cli.rs::run_publishes_no_temp_files_after_a_successful_copy`), old version archived before replacement (`tests/cli.rs::run_archives_an_updated_destination_before_publishing_the_replacement`), machinery untouched (`tests/cli.rs::plan_never_shows_or_deletes_machinery`), fresh-scan convergence (`tests/cli.rs::rerun_cleans_strays_journals_cleanup_and_scans_fresh`). Read `docs/adr/0009-acceptance-test-harness.md` only when changing crash/convergence coverage.
