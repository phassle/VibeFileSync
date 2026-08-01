# Architectural patterns

Use these patterns when extending VibeFileSync. ADRs remain authoritative; this file records repeated implementation shapes.

## Functional core, imperative filesystem shell

Keep comparison and presentation deterministic over explicit values. Put filesystem discovery and CLI effects at module edges.

- `src/plan.rs:93` scans real trees into sorted maps.
- `src/plan.rs:143` computes a Plan without I/O.
- `src/plan.rs:242` renders a Plan without I/O.
- `src/plan.rs:346` and `src/plan.rs:355` orchestrate config, scan, compute, output.
- Pure seams receive dense unit coverage at `src/plan.rs:439`; filesystem behavior uses CLI fixtures at `tests/cli.rs:49`.

When adding planning behavior, extend the Plan model/pure computation first; keep scanning, terminal, and mutation concerns outside it.

## Validate → plan → review → preflight → mutate

Compose safety as ordered gates. Earlier stages may inspect; only the final stage mutates.

1. Strict config load precedes dispatch (`src/main.rs:148`).
2. Resolve pinned volumes before scanning (`src/plan.rs:355`, `src/preconditions.rs:14`).
3. Build and render a fresh plan (`src/run.rs:43`).
4. Enforce run-only preconditions and block Plan errors (`src/run.rs:46`, `src/run.rs:52`).
5. Require confirmation or explicit `--yes` (`src/run.rs:60`).
6. Execute exactly the reviewed actions (`src/run.rs:65`).

Place new abort-before-mutation checks before Run id allocation at `src/run.rs:65`. Keep Dry-run useful unless the check is required for safe enumeration.

## Verified atomic Publish

Never write directly to a final path. Use a sibling temp so publication stays on one filesystem and in one parent directory.

1. Create/copy sibling temp (`src/run.rs:143`, `src/run.rs:253`).
2. Flush data using `sync_all` and `F_FULLFSYNC` (`src/run.rs:292`).
3. Verify source stability and copied data/metadata (`src/run.rs:310`).
4. Archive or deliberately remove the old final object (`src/run.rs:156`, `src/run.rs:184`).
5. Rename temp to final and sync parent (`src/run.rs:163`).
6. Remove temp on any failure (`src/run.rs:174`).

Config rewrites reuse the same temp → sync → rename → parent-sync idiom (`src/config.rs:140`). Tests assert both successful cleanup and failed-gate preservation (`src/config.rs:304`, `src/run.rs:530`).

## SafetyNet is the removal boundary

Route every replacement/deletion through one helper. Default behavior renames the prior destination into `_SafetyNet/<run-id>/<relative-path>` on the same volume (`src/run.rs:184`, `src/run.rs:207`). A permanent delete is an explicit per-run branch, never stored config (`src/main.rs:56`, `src/config.rs:31`).

Protect tool-owned objects at both ends:

- Scanner excludes SafetyNet, Publish temps, and Run locks (`src/plan.rs:76`).
- Run id allocation avoids live locks and existing archive folders (`src/run.rs:396`).
- Prune removes only direct folders matching allocated Run id syntax (`src/run.rs:229`, `src/run.rs:445`).

## Deterministic, versioned boundaries

Prefer behavior scripts and agents can classify without heuristics.

- `BTreeMap` makes config pairs and scan results stable (`src/config.rs:47`, `src/plan.rs:93`).
- Strict `deny_unknown_fields` and config version checks abort on drift (`src/config.rs:31`, `src/config.rs:113`).
- Machine payloads carry versioned schema ids (`src/pair.rs:13`; full policy `docs/adr/0004-cli-surface.md:9`).
- Error classes map to stable exit codes at one CLI boundary (`src/error.rs:11`, `src/main.rs:138`).
- Per-run overrides name the exact bypass; no persistent safety defaults (`src/main.rs:47`, `src/preconditions.rs:103`).

Treat ordering, schema fields, exit classes, and override scope as compatibility surfaces.

## Concentrated macOS boundary

Keep unsafe/libc details narrow and expose Rust `io::Result` functions.

- Volume UUID, filesystem type, and mount enumeration live in `src/volume.rs:37`.
- Copyfile, xattr, and full-sync calls live in `src/run.rs:19`.
- Callers reason in Path, Pair, Plan, and AppError values (`src/preconditions.rs:14`, `src/run.rs:34`).

This codebase targets Darwin arm64. Do not generalize platform support accidentally; isolate a deliberate portability change behind equivalent safe interfaces.

## Inject failures at narrow seams

Use dependency injection for pure lookup seams and a compile-time feature for OS failures.

- Mount relocation accepts a lookup function for deterministic unit tests (`src/preconditions.rs:54`, `src/preconditions.rs:301`).
- `fault-injection` gates free-space and ENOSPC controls (`Cargo.toml:6`, `src/preconditions.rs:161`, `src/run.rs:148`).
- Integration tests assert the externally visible invariant, not helper calls (`tests/cli.rs:1063`, `tests/cli.rs:1090`).

Keep production defaults free of test behavior; expose injections only under the feature.
