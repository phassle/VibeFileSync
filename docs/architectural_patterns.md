# Architectural patterns

Use these patterns when extending VibeFileSync. ADRs remain authoritative; this file records repeated implementation shapes.

## Functional core, imperative filesystem shell

Keep comparison and presentation deterministic over explicit values. Put filesystem discovery and CLI effects at module edges.

- `src/plan.rs:170` scans real trees into sorted maps.
- `src/plan.rs:290` computes a Plan without I/O.
- `src/plan.rs:493` renders a Plan without I/O.
- `src/plan.rs:606` and `src/plan.rs:614` orchestrate config, scan, compute, output.
- Pure seams receive dense unit coverage at `src/plan.rs:1355`; filesystem behavior uses CLI fixtures at `tests/cli.rs:445`.

When adding planning behavior, extend the Plan model/pure computation first; keep scanning, terminal, and mutation concerns outside it.

## Validate → plan → review → preflight → mutate

Compose safety as ordered gates. Earlier stages may inspect; only the final stage mutates.

1. Strict config load precedes dispatch (`src/main.rs:172`).
2. Acquire pair lock, resolve pinned volumes, and scan (`src/run.rs:332`, `src/plan.rs:170`).
3. Render/report the initial reviewed Plan (`src/run.rs:369`).
4. Block Plan errors, then enforce run-only preconditions (`src/run.rs:394`, `src/run.rs:397`).
5. Require confirmation or explicit `--yes` (`src/run.rs:420`).
6. Persist the reviewed action set in the Journal (`src/run.rs:437`).
7. Clean strays, rescan, and retain only reviewed work (`src/run.rs:448`, `src/run.rs:505`, `src/run.rs:537`).
8. Execute the reconciled reviewed actions (`src/run.rs:545`).

Place new abort-before-mutation checks before Journal creation at `src/run.rs:437`. Keep Dry-run useful unless the check is required for safe enumeration.

## Verified atomic Publish

Never write directly to a final path. Use a sibling temp so publication stays on one filesystem and in one parent directory.

1. Allocate/copy sibling temp (`src/run.rs:928`, `src/run.rs:1052`).
2. Flush data using `sync_all` and `F_FULLFSYNC` (`src/run.rs:23`, `src/run.rs:1052`).
3. Verify source stability and copied data/metadata (`src/run.rs:1518`).
4. Archive or deliberately remove the old final object (`src/run.rs:1265`).
5. Rename temp to final and sync parent (`src/run.rs:1052`).
6. Remove temp on any failure (`src/run.rs:1207`).

Config rewrites reuse the same temp → sync → rename → parent-sync idiom (`src/config.rs:136`). Tests assert both successful cleanup and failed-gate preservation (`src/config.rs:342`, `src/run.rs:1686`).

## SafetyNet is the removal boundary

Route every replacement/deletion through one helper. Default behavior renames the prior destination into `_SafetyNet/<run-id>/<relative-path>` on the same volume (`src/run.rs:1265`, `src/run.rs:1272`). A permanent delete is an explicit per-run branch, never stored config (`src/main.rs:57`, `src/config.rs:31`).

Protect tool-owned objects at both ends:

- Scanner excludes SafetyNet, Publish temps, and Run locks (`src/plan.rs:88`).
- Journal Run id allocation avoids existing archives and journal files (`src/journal.rs:47`).
- Prune removes only direct folders matching allocated Run id syntax (`src/run.rs:1296`, `src/journal.rs:483`).

## Journal records; scans decide

Keep the append-only Journal as forensic/history output, never planning authority (`src/journal.rs:41`, `src/journal.rs:218`). Persist the reviewed action set, then rescan after cleanup and intersect fresh work with that set (`src/run.rs:152`, `src/run.rs:222`, `src/run.rs:264`). Status and History read records without changing sync decisions (`src/journal.rs:281`, `src/journal.rs:304`, `src/journal.rs:331`).

## Deterministic, versioned boundaries

Prefer deterministic behavior that scripts and agents can classify without heuristics.

- `BTreeMap` makes config pairs and scan results stable (`src/config.rs:50`, `src/plan.rs:105`).
- Strict `deny_unknown_fields` and config version checks abort on drift (`src/config.rs:31`, `src/config.rs:113`).
- Machine payloads carry versioned schema ids (`src/config.rs:13`; full policy `docs/adr/0004-cli-surface.md:9`).
- Error classes map to stable exit codes at one CLI boundary (`src/error.rs:11`, `src/main.rs:139`).
- Per-run overrides name the exact bypass; no persistent safety defaults (`src/main.rs:48`, `src/preconditions.rs:122`).

Treat ordering, schema fields, exit classes, and override scope as compatibility surfaces.

## Concentrated macOS boundary

Keep unsafe/libc details narrow and expose Rust `io::Result` functions.

- Volume UUID, filesystem type, and mount enumeration live in `src/volume.rs:93`.
- Copyfile, xattr, and full-sync calls live in `src/run.rs:31`.
- Callers reason in Path, Pair, Plan, Journal, and AppError values (`src/preconditions.rs:14`, `src/run.rs:59`).

This codebase targets Darwin arm64. Do not generalize platform support accidentally; isolate a deliberate portability change behind equivalent safe interfaces.

## Staged interface, one writer per concern

The TUI is a state machine over named stages, not a screen that mutates as it draws. Each stage owns a model; draw functions are pure over `&Model` and render whatever the model already decided.

- `Screen` and `FormStage` name every stage the interface can be in (`src/tui.rs:236`, `src/tui.rs:1793`).
- `run_pair_flow` drives the lifecycle; stage transitions are explicit, never implicit in a draw (`src/tui.rs:1021`).
- The TUI never constructs a `Pair` or calls `config::save`. `pair::add` stays the single writer, so a pair saved through the panes is byte-identical to one saved by `pair add` (`src/pair.rs:43`).
- Presentation state — scroll offset, hidden-row toggles — lives on the model so it survives a redraw or resize (`src/tui.rs:241`).

Add a stage by extending the enum and the flow, not by branching inside a renderer.

## No single keystroke mutates

Every operation that writes config or touches the destination passes a confirm screen first. This is a keyboard-map invariant, not a per-feature choice: adjacent keys must never cause opposite outcomes.

- Removal, Run, and pair create/edit all route through a confirm stage; only the accept key performs the write (`src/tui.rs:1021`).
- The reject key returns to the previous stage with the pending edit intact; nothing is written and nothing is lost.
- A crash restores the terminal — raw mode, cursor, alternate screen — from one guard's `Drop`, which runs during unwinding (`src/tui.rs:592`).

A new mutating key needs a confirm stage before it needs a binding.

## Render tested in-process, behaviour tested through a pty

Two seams, chosen by what is being asserted.

- Rendered content and interaction go through `Terminal<TestBackend>` at an explicit width, which is what makes responsive breakpoints testable at all (`tests/cli.rs:445`).
- End-to-end behaviour drives the real binary in a pseudo-terminal with scripted keystrokes, and **rendezvouses on the child's own output rather than on elapsed time** — a sleep decides which stage a test actually exercises (`docs/adr/0011-scripted-tui-input-synchronisation.md:1`).
- A panic path is exercised with `panic!`, never `abort()`: aborting skips unwinding, so it cannot prove a `Drop`-based guard ran.

Reach for the pty only when the assertion needs a real terminal; prefer `TestBackend` for anything about what was drawn.

## Inject failures at narrow seams

Use dependency injection for pure lookup seams and a compile-time feature for OS failures.

- Mount relocation accepts a lookup function for deterministic unit tests (`src/preconditions.rs:55`, `src/preconditions.rs:226`).
- `fault-injection` gates free-space and ENOSPC controls (`Cargo.toml:6`, `src/preconditions.rs:326`, `src/run.rs:653`).
- Integration tests assert the externally visible invariant, not helper calls (`tests/cli.rs:1575`, `tests/cli.rs:1602`).

Keep production defaults free of test behavior; expose injections only under the feature.
