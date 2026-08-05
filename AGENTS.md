# VibeFileSync agent guide

## Agent behavior

Be extremely concise. Sacrifice grammar for concision.
At the end of each plan, list unresolved questions.

- Read only relevant linked docs; preserve `CONTEXT.md` terminology.
- Surface conflicts with an ADR. Never silently override a decision.
- Reference code by **symbol**, never by line number: `` `src/run.rs::execute_reviewed_plan` ``, not `src/run.rs:‹line›`. A line number is a position, so every insertion above it silently retargets the reference — path and line both still exist, and nothing catches it. A symbol survives edits above it, and breaks loudly when it stops existing. Sections likewise: `` `Cargo.toml [dependencies]` ``. Enforced by `tests/docs_references.rs`. Never paste source into docs.
- Treat safety invariants, exit codes, and versioned schemas as public contracts.

## WHAT: stack and layout

- macOS Apple Silicon, single Rust 2021 binary named `vibesync`; no library crate (`Cargo.toml [package]`, `Cargo.toml [features]`).
- Rust runtime: `clap`, `serde`, strict TOML, JSON, `tempfile`, `libc`, `ratatui`, `crossterm` (`Cargo.toml [dependencies]`).
- macOS filesystem integration uses `getattrlist`, `statfs`, `copyfile`, xattrs, `F_FULLFSYNC` (`src/volume.rs::getattrlist`, `src/run.rs::F_FULLFSYNC`, `src/run.rs::copyfile`).
- Tests use Rust unit tests plus real-binary integration tests with `assert_cmd`, `predicates`, temp trees (`Cargo.toml [dev-dependencies]`, `tests/cli.rs::Fixture`).
- Node dependencies support Sandcastle agent orchestration only; not product runtime (`package.json "devDependencies"`, `.sandcastle/main.mts`).

Module map:

- `src/main.rs::main` — Clap surface and exit boundary; config validated before command behaviour in `src/main.rs::run`.
- `src/config.rs::CURRENT_VERSION` — schema version; strict load `src/config.rs::load`, atomic save `src/config.rs::save`; `$XDG_CONFIG_HOME` honoured in `src/config.rs::config_path`.
- `src/pair.rs::add` — the single Folder-pair writer (also serves `--replace` and the TUI form); `src/pair.rs::remove`.
- `src/volume.rs::volume_uuid` — volume UUID is the sole identity; `src/volume.rs::filesystem_type`, `src/volume.rs::expected_degradations`.
- `src/preconditions.rs::resolve_pair` — mount relocation and abort-before-mutation guards; six-state classifier `src/preconditions.rs::classify_pair`; run-only gates `src/preconditions.rs::check_run`.
- `src/plan.rs::traverse` — single tree walk; per-entry diff `src/plan.rs::classify_source_entry`; human rendering `src/plan.rs::render`; NDJSON stream `src/plan.rs::run_json`.
- `src/structural_conflict.rs::ConflictSet` — owns the "destination object blocks a copy, archive it once before Publish" rule end to end; review-subset query `src/structural_conflict.rs::included_structural_deletes`; `plan::StructuralConflict` stays the data type.
- `src/run.rs::run` — human/JSON Run; review/reconcile/execute `src/run.rs::execute_reviewed_plan`; verification gate `src/run.rs::verify_temp`; SafetyNet rename `src/run.rs::archive_by_rename`.
- `src/tui.rs::run` — TUI entry; staged lifecycle `src/tui.rs::run_pair_flow`; pair selector `src/tui.rs::select_pair`. Largest module: read the stage you are changing, not the file.
- `src/event.rs::run_start` — NDJSON event constructors; the schema agents parse. Additive changes only.
- `src/journal.rs::Journal` — retained run record, pair lock, Status/History.
- `tests/cli.rs::Fixture` — CLI fixture; TUI driver `tests/cli.rs::vibesync_in_tty_with_input`.

Current implementation: Pair CRUD (including `pair add --replace` to redefine a pair in one atomic save), human/NDJSON Dry-run and Run, SafetyNet, convergence cleanup, Journal, Status/History, Prune, and a staged `ratatui` TUI (`src/tui.rs`) covering Select, Compare, Review, Confirm, Run, and Result. `pair list` additionally supports `--check` (per-pair volume-state classification) and `--source <PATH>` (filter by directory).

## WHY: product and constraints

VibeFileSync mirrors or updates folders onto APFS/exFAT external drives without silently losing prior destination versions (`README.md`). Safety is product behavior:

- Review first: fresh plan precedes every Run; confirmation or explicit `--yes` gates mutation (`docs/adr/0003-dryrun-diff-and-review.md`).
- SafetyNet: archive any replaced/removed destination object by same-volume rename (`docs/adr/0001-safetynet-archive-by-rename.md`).
- Verified Publish: sibling temp → durability → verification → archive old → rename → parent sync (`src/run.rs::copy_file`, `src/run.rs::verify_temp`).
- Convergence: rerun from a fresh scan after interruption; Journal never becomes copy authority (`docs/adr/0007-journal-design.md`).
- Abort by default: volume, empty-source, and free-space guards need explicit per-run overrides (`docs/adr/0002-run-preconditions.md`).

## HOW: commands

Run product commands through Cargo: `cargo run --locked -- <vibesync-args>`. Config defaults to `~/.config/vibesync/config.toml`; tests isolate it through `XDG_CONFIG_HOME` (`src/config.rs::config_path`, `tests/cli.rs::Fixture`).

### Workflow 1: build

1. Confirm Darwin arm64 and stable Rust: `uname -srm`; `rustc --version`; `cargo --version`.
2. Compile reproducibly: `cargo build --locked`.
3. Smoke the CLI without touching sync data: `cargo run --locked -- --help`.
4. For distributable binary: `cargo build --release --locked`; output `target/release/vibesync`.

Detailed procedure: `.agents/skills/build-vibesync/SKILL.md`.

### Workflow 2: test

1. Check formatting mechanically: `cargo fmt --check`.
2. Run linter gate: `cargo clippy --locked --all-targets --all-features -- -D warnings`.
3. Run default suite: `cargo test --locked`.
4. Run injected ENOSPC/space-check paths: `cargo test --locked --features fault-injection`.
5. Dry-run output is pinned by golden captures under `tests/captures/` (`tests/plan_captures.rs`). These are never hand-edited; one command regenerates every one of them, after which the diff under `tests/captures/` is reviewed before committing: `REGEN_CAPTURES=1 cargo test --locked --test plan_captures --features fault-injection`.

Detailed procedure: `.agents/skills/test-vibesync/SKILL.md`. Test architecture: `docs/adr/0009-acceptance-test-harness.md`.

### Workflow 3: release

1. Start from clean, current `develop`; create `release/<version>` (`docs/agents/git-workflow.md`).
2. Update `version` in `Cargo.toml [package]`; regenerate `Cargo.lock` with Cargo; review only intended version changes.
3. Run Workflow 2, then `cargo build --release --locked`.
4. Merge release branch to `main` via PR or `--no-ff`; never direct-commit (`docs/agents/git-workflow.md`).
5. Merge release branch back to `develop`; delete branch. Ask maintainer before tagging/publishing: no tag, signing, artifact, or automation policy exists.

Detailed procedure: `.agents/skills/release-vibesync/SKILL.md`.

## Working rules

- Gitflow mandatory. Create `feature/<kebab-name>` from `develop` for every coherent code/docs/ADR change; PR targets `develop` (`docs/agents/git-workflow.md`).
- `main` receives release/hotfix merges only. Prototype/research branch exemptions are throwaway and never merged (`docs/agents/git-workflow.md`).
- Validate config before command-specific behavior (`src/main.rs::run`).
- Keep `plan` read-only; mutation belongs behind Run review and preconditions (`src/plan.rs::traverse`, `src/run.rs::execute_reviewed_plan`).
- Preserve deterministic ordering and schema versions (`src/plan.rs::traverse`, `src/config.rs::CURRENT_VERSION`).
- Exercise filesystem behavior through real temp trees; use the `fault-injection` feature for hard-to-force failures (`tests/cli.rs::Fixture`, `Cargo.toml [features]`).
- Scripted TUI tests rendezvous on the child's own output, never on elapsed time (`docs/adr/0011-scripted-tui-input-synchronisation.md`).
- Let `rustfmt`/Clippy own style. Add no prose formatting rules.

## Progressive-disclosure index

Domain and architecture:

- `CONTEXT.md` — normative product vocabulary; read before naming domain concepts.
- `docs/architectural_patterns.md` — recurring code structure and safety patterns; read for design/refactors.
- `docs/adr/0001-safetynet-archive-by-rename.md` — SafetyNet ordering and retention contract.
- `docs/adr/0002-run-preconditions.md` — deterministic pre-mutation guards and overrides.
- `docs/adr/0003-dryrun-diff-and-review.md` — human/NDJSON plan and review-first UX.
- `docs/adr/0004-cli-surface.md` — commands, schemas, exit taxonomy.
- `docs/adr/0005-cli-banner.md` — banner surface, stream, suppression.
- `docs/adr/0006-config-format-and-location.md` — strict TOML, pair identity, config/state split.
- `docs/adr/0007-journal-design.md` — retained NDJSON Journal and convergence role.
- `docs/adr/0008-post-copy-verification.md` — verification gate and metadata degradation.
- `docs/adr/0009-acceptance-test-harness.md` — crash/fault acceptance strategy and invariants.
- `docs/adr/0010-commander-two-sided-review.md` — two-sided action table for TUI review; supersedes ADR-0003 §3.
- `docs/adr/0011-scripted-tui-input-synchronisation.md` — how scripted-keystroke TUI tests rendezvous with the child.
- `docs/adr/0012-run-record-resolved-paths.md` — `run_start` also records the resolved source and destination.

Agent operations:

- `docs/agents/domain.md` — how to consume glossary and ADRs.
- `docs/agents/git-workflow.md` — full gitflow and branch exemptions.
- `docs/agents/issue-tracker.md` — GitHub issue/PR commands and wayfinding operations.
- `docs/agents/issue-hierarchy.md` — Idea → Epic → Feature → Issue model.
- `docs/agents/triage-labels.md` — canonical label mapping.

Specialized only:

- `docs/dynamic-implement.md` — team setup and use of Dynamic Implement.
- `docs/dynamic-skills/README.md` — cross-agent skill bundle installation.
- `docs/research/dynamic-implement.md` — primary-source orchestration research; read only when changing that system.
