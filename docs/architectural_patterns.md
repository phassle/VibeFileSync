# Architectural patterns

Use these patterns when extending VibeFileSync. ADRs remain authoritative; this file records repeated implementation shapes.

## Functional core, imperative filesystem shell

Keep comparison and presentation deterministic over explicit values. Put filesystem discovery and CLI effects at module edges.

- `src/plan.rs::scan` scans real trees into sorted maps.
- `src/plan.rs::compute` computes a Plan without I/O.
- `src/plan.rs::render` renders a Plan without I/O.
- `src/plan.rs::run` and `src/plan.rs::run_json` orchestrate config, scan, compute, output.
- Pure seams receive dense unit coverage at `src/plan.rs::tests`; filesystem behavior uses CLI fixtures at `tests/cli.rs::Fixture`.

When adding planning behavior, extend the Plan model/pure computation first; keep scanning, terminal, and mutation concerns outside it.

## Validate → plan → review → preflight → mutate

Compose safety as ordered gates. Earlier stages may inspect; only the final stage mutates.

1. Strict config load precedes dispatch (`src/main.rs::run`).
2. Acquire pair lock, resolve pinned volumes, and scan (`src/preconditions.rs::resolve_pair`, `src/plan.rs::scan`).
3. Render/report the initial reviewed Plan (`src/run.rs::execute_reviewed_plan`).
4. Block Plan errors, then enforce run-only preconditions (`src/plan.rs::PlanError`, `src/preconditions.rs::check_run`).
5. Require confirmation or explicit `--yes` (`src/run.rs::execute_reviewed_plan`).
6. Persist the reviewed action set in the Journal (`src/journal.rs::Journal`).
7. Clean strays, rescan, and retain only reviewed work (`src/run.rs::execute_reviewed_plan`, `src/run.rs::discovered_after_review`, `src/run.rs::retain_reviewed_actions`).
8. Execute the reconciled reviewed actions (`src/run.rs::execute_reviewed_plan`).

Place new abort-before-mutation checks before Journal creation at `src/run.rs::execute_reviewed_plan`. Keep Dry-run useful unless the check is required for safe enumeration.

## Verified atomic Publish

Never write directly to a final path. Use a sibling temp so publication stays on one filesystem and in one parent directory.

1. Allocate/copy sibling temp (`src/run.rs::copy_file`).
2. Flush data using `sync_all` and `F_FULLFSYNC` (`src/run.rs::F_FULLFSYNC`, `src/run.rs::copy_file`).
3. Verify source stability and copied data/metadata (`src/run.rs::verify_temp`).
4. Archive or deliberately remove the old final object (`src/run.rs::archive_by_rename`).
5. Rename temp to final and sync parent (`src/run.rs::copy_file`).
6. Remove temp on any failure (`src/run.rs::verify_temp`).

Config rewrites reuse the same temp → sync → rename → parent-sync idiom (`src/config.rs::save`). Tests assert both successful cleanup and failed-gate preservation (`src/config.rs::save_is_atomic_and_does_not_leave_temp_files_on_success`, `src/run.rs::temp_suffixes_are_sibling_dot_files`).

## SafetyNet is the removal boundary

Route every replacement/deletion through one helper. Default behavior renames the prior destination into `_SafetyNet/<run-id>/<relative-path>` on the same volume (`src/run.rs::archive_by_rename`). A permanent delete is an explicit per-run branch, never stored config (`src/main.rs::Command`, `src/config.rs::Config`).

A destination object that blocks a copy (a file where source now wants a directory, or vice versa) is archived once before that copy Publishes. The rule that decides *when* — classification, the one-shot ordering invariant, and the review-subset derivation — lives entirely in `src/structural_conflict.rs::ConflictSet`; `src/run.rs::archive_by_rename` remains the sole *how*.

Protect tool-owned objects at both ends:

- Scanner excludes SafetyNet, Publish temps, and Run locks (`src/plan.rs::is_machinery`).
- Journal Run id allocation avoids existing archives and journal files (`src/journal.rs::create`).
- Prune removes only direct folders matching allocated Run id syntax (`src/run.rs::prune`, `src/journal.rs::is_run_id`).

## Journal records; scans decide

Keep the append-only Journal as forensic/history output, never planning authority (`src/journal.rs::Journal`, `src/journal.rs::acquire`). Persist the reviewed action set, then rescan after cleanup and intersect fresh work with that set (`src/run.rs::retain_reviewed_actions`, `src/run.rs::missing_reviewed_actions`). Status and History read records without changing sync decisions (`src/journal.rs::status`, `src/journal.rs::history_human`, `src/journal.rs::history_json`).

## Deterministic, versioned boundaries

Prefer deterministic behavior that scripts and agents can classify without heuristics.

- `BTreeMap` makes config pairs and scan results stable (`src/config.rs::Config`, `src/plan.rs::scan`).
- Strict `deny_unknown_fields` and config version checks abort on drift (`src/config.rs::Config`, `src/config.rs::load`).
- Machine payloads carry versioned schema ids (`src/config.rs::CURRENT_VERSION`; full policy `docs/adr/0004-cli-surface.md`).
- Error classes map to stable exit codes at one CLI boundary (`src/error.rs::AppError`, `src/main.rs::main`).
- Per-run overrides name the exact bypass; no persistent safety defaults (`src/main.rs::Command`, `src/preconditions.rs::check_run`).

Treat ordering, schema fields, exit classes, and override scope as compatibility surfaces.

## Concentrated macOS boundary

Keep unsafe/libc details narrow and expose Rust `io::Result` functions.

- Volume UUID, filesystem type, and mount enumeration live in `src/volume.rs::volume_uuid`.
- Copyfile, xattr, and full-sync calls live in `src/run.rs::copyfile` and `src/run.rs::F_FULLFSYNC`.
- Callers reason in Path, Pair, Plan, Journal, and AppError values (`src/preconditions.rs::resolve_pair`, `src/run.rs::run`).

This codebase targets Darwin arm64. Do not generalize platform support accidentally; isolate a deliberate portability change behind equivalent safe interfaces.

## Staged interface, one writer per concern

The TUI is a state machine over named stages, not a screen that mutates as it draws. Each stage owns a model; draw functions are pure over `&Model` and render whatever the model already decided.

- `Screen` and `FormStage` name every stage the interface can be in (`src/tui.rs::Screen`, `src/tui.rs::FormStage`).
- `run_pair_flow` drives the lifecycle; stage transitions are explicit, never implicit in a draw (`src/tui.rs::run_pair_flow`).
- The TUI never constructs a `Pair` or calls `config::save`. `pair::add` stays the single writer, so a pair saved through the panes is byte-identical to one saved by `pair add` (`src/pair.rs::add`).
- Presentation state — scroll offset, hidden-row toggles — lives on the model so it survives a redraw or resize (`src/tui.rs::ReviewModel`).

Add a stage by extending the enum and the flow, not by branching inside a renderer.

## No single keystroke mutates

Every operation that writes config or touches the destination passes a confirm screen first. This is a keyboard-map invariant, not a per-feature choice: adjacent keys must never cause opposite outcomes.

- Removal, Run, and pair create/edit all route through a confirm stage; only the accept key performs the write (`src/tui.rs::run_pair_flow`).
- The reject key returns to the previous stage with the pending edit intact; nothing is written and nothing is lost.
- A crash restores the terminal — raw mode, cursor, alternate screen — from one guard's `Drop`, which runs during unwinding (`src/tui.rs::TerminalSession`).

A new mutating key needs a confirm stage before it needs a binding.

## Render tested in-process, behaviour tested through a pty

Two seams, chosen by what is being asserted.

- Rendered content and interaction go through `Terminal<TestBackend>` at an explicit width, which is what makes responsive breakpoints testable at all. The seam lives in `src/tui.rs`'s own test module — read the buffer through `src/tui.rs::buffer_text`, or `src/tui.rs::buffer_text_sized` when the assertion is about a specific width.
- End-to-end behaviour drives the real binary in a pseudo-terminal with scripted keystrokes from `tests/cli.rs::Fixture`, and **rendezvouses on the child's own output rather than on elapsed time** — a sleep decides which stage a test actually exercises (`docs/adr/0011-scripted-tui-input-synchronisation.md`).
- A panic path is exercised with `panic!`, never `abort()`: aborting skips unwinding, so it cannot prove a `Drop`-based guard ran.

Reach for the pty only when the assertion needs a real terminal; prefer `TestBackend` for anything about what was drawn.

## Inject failures at narrow seams

Use dependency injection for pure lookup seams and a compile-time feature for OS failures.

- Mount relocation accepts a lookup function for deterministic unit tests (`src/preconditions.rs::resolve_path_with_lookup`, `src/preconditions.rs::classify_side_with_lookup`).
- `fault-injection` gates free-space and ENOSPC controls (`Cargo.toml [features]`, `src/preconditions.rs::available_space`, `src/run.rs::execute_reviewed_plan`).
- Integration tests assert the externally visible invariant, not helper calls (`tests/cli.rs::bad_config_aborts_before_an_unimplemented_verb_runs`, `tests/cli.rs::run_accepts_the_adr_0004_per_run_flags`).

Keep production defaults free of test behavior; expose injections only under the feature.
