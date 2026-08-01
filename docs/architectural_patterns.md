# Architectural patterns

Use these patterns when extending VibeFileSync. ADRs remain authoritative; this file records repeated implementation shapes.

## Functional core, imperative filesystem shell

Keep comparison and presentation deterministic over explicit values. Put filesystem discovery and CLI effects at module edges.

- `src/plan.rs:105` scans real trees into sorted maps.
- `src/plan.rs:155` computes a Plan without I/O.
- `src/plan.rs:284` renders a Plan without I/O.
- `src/plan.rs:397` and `src/plan.rs:858` orchestrate config, scan, compute, output.
- Pure seams receive dense unit coverage at `src/plan.rs:988`; filesystem behavior uses CLI fixtures at `tests/cli.rs:53`.

When adding planning behavior, extend the Plan model/pure computation first; keep scanning, terminal, and mutation concerns outside it.

## Validate → plan → review → preflight → mutate

Compose safety as ordered gates. Earlier stages may inspect; only the final stage mutates.

1. Strict config load precedes dispatch (`src/main.rs:149`).
2. Acquire pair lock, resolve pinned volumes, and scan (`src/run.rs:118`, `src/plan.rs:858`).
3. Render/report the initial reviewed Plan (`src/run.rs:119`).
4. Block Plan errors, then enforce run-only preconditions (`src/run.rs:125`, `src/run.rs:133`).
5. Require confirmation or explicit `--yes` (`src/run.rs:143`).
6. Persist the reviewed action set in the Journal (`src/run.rs:152`).
7. Clean strays, rescan, and retain only reviewed work (`src/run.rs:170`, `src/run.rs:222`, `src/run.rs:264`).
8. Execute the reconciled reviewed actions (`src/run.rs:268`).

Place new abort-before-mutation checks before Journal creation at `src/run.rs:152`. Keep Dry-run useful unless the check is required for safe enumeration.

## Verified atomic Publish

Never write directly to a final path. Use a sibling temp so publication stays on one filesystem and in one parent directory.

1. Allocate/copy sibling temp (`src/run.rs:336`, `src/run.rs:1023`, `src/run.rs:580`).
2. Flush data using `sync_all` and `F_FULLFSYNC` (`src/run.rs:588`, `src/run.rs:1070`).
3. Verify source stability and copied data/metadata (`src/run.rs:589`, `src/run.rs:1088`).
4. Archive or deliberately remove the old final object (`src/run.rs:590`, `src/run.rs:906`).
5. Rename temp to final and sync parent (`src/run.rs:597`).
6. Remove temp on any failure (`src/run.rs:611`).

Config rewrites reuse the same temp → sync → rename → parent-sync idiom (`src/config.rs:140`). Tests assert both successful cleanup and failed-gate preservation (`src/config.rs:304`, `src/run.rs:1260`).

## SafetyNet is the removal boundary

Route every replacement/deletion through one helper. Default behavior renames the prior destination into `_SafetyNet/<run-id>/<relative-path>` on the same volume (`src/run.rs:906`, `src/run.rs:976`). A permanent delete is an explicit per-run branch, never stored config (`src/main.rs:57`, `src/config.rs:31`).

Protect tool-owned objects at both ends:

- Scanner excludes SafetyNet, Publish temps, and Run locks (`src/plan.rs:88`).
- Journal Run id allocation avoids existing archives and journal files (`src/journal.rs:47`).
- Prune removes only direct folders matching allocated Run id syntax (`src/run.rs:1000`, `src/journal.rs:483`).

## Journal records; scans decide

Keep the append-only Journal as forensic/history output, never planning authority (`src/journal.rs:41`, `src/journal.rs:218`). Persist the reviewed action set, then rescan after cleanup and intersect fresh work with that set (`src/run.rs:152`, `src/run.rs:222`, `src/run.rs:264`). Status and History read records without changing sync decisions (`src/journal.rs:296`, `src/journal.rs:319`, `src/journal.rs:346`).

## Deterministic, versioned boundaries

Prefer behavior scripts and agents can classify without heuristics.

- `BTreeMap` makes config pairs and scan results stable (`src/config.rs:50`, `src/plan.rs:105`).
- Strict `deny_unknown_fields` and config version checks abort on drift (`src/config.rs:31`, `src/config.rs:113`).
- Machine payloads carry versioned schema ids (`src/pair.rs:13`; full policy `docs/adr/0004-cli-surface.md:9`).
- Error classes map to stable exit codes at one CLI boundary (`src/error.rs:11`, `src/main.rs:139`).
- Per-run overrides name the exact bypass; no persistent safety defaults (`src/main.rs:48`, `src/preconditions.rs:103`).

Treat ordering, schema fields, exit classes, and override scope as compatibility surfaces.

## Concentrated macOS boundary

Keep unsafe/libc details narrow and expose Rust `io::Result` functions.

- Volume UUID, filesystem type, and mount enumeration live in `src/volume.rs:37`.
- Copyfile, xattr, and full-sync calls live in `src/run.rs:31`.
- Callers reason in Path, Pair, Plan, Journal, and AppError values (`src/preconditions.rs:14`, `src/run.rs:59`).

This codebase targets Darwin arm64. Do not generalize platform support accidentally; isolate a deliberate portability change behind equivalent safe interfaces.

## Inject failures at narrow seams

Use dependency injection for pure lookup seams and a compile-time feature for OS failures.

- Mount relocation accepts a lookup function for deterministic unit tests (`src/preconditions.rs:54`, `src/preconditions.rs:301`).
- `fault-injection` gates free-space and ENOSPC controls (`Cargo.toml:6`, `src/preconditions.rs:161`, `src/run.rs:582`).
- Integration tests assert the externally visible invariant, not helper calls (`tests/cli.rs:1575`, `tests/cli.rs:1602`).

Keep production defaults free of test behavior; expose injections only under the feature.
