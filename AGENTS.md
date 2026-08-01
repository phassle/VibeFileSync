# VibeFileSync agent guide

## Agent behavior

Be extremely concise. Sacrifice grammar for concision.
At the end of each plan, list unresolved questions.

- Read only relevant linked docs; preserve `CONTEXT.md:5` terminology.
- Surface conflicts with an ADR. Never silently override a decision.
- Prefer file:line references over copied source.
- Treat safety invariants, exit codes, and versioned schemas as public contracts.

## WHAT: stack and layout

- macOS Apple Silicon, single Rust 2021 binary named `vibesync`; no library crate (`Cargo.toml:1`, `Cargo.toml:6`).
- Rust runtime: `clap`, `serde`, strict TOML, JSON, `tempfile`, `libc` (`Cargo.toml:11`).
- macOS filesystem integration uses `getattrlist`, `statfs`, `copyfile`, xattrs, `F_FULLFSYNC` (`src/volume.rs:37`, `src/run.rs:19`).
- Tests use Rust unit tests plus real-binary integration tests with `assert_cmd`, `predicates`, temp trees (`Cargo.toml:20`, `tests/cli.rs:20`).
- Node dependencies support Sandcastle agent orchestration only; not product runtime (`package.json:2`, `.sandcastle/main.mts:1`).

Module map:

- `src/main.rs:23` — Clap surface, strict config-first dispatch, exit boundary.
- `src/config.rs:13` — versioned config types, strict load, atomic save.
- `src/pair.rs:42` — Folder pair CRUD and volume pinning.
- `src/volume.rs:47` — macOS volume identity/filesystem queries.
- `src/preconditions.rs:14` — mount relocation and abort-before-mutation guards.
- `src/plan.rs:93` — tree scan; `src/plan.rs:143` pure diff; `src/plan.rs:242` rendering.
- `src/run.rs:34` — review/preflight/execution; `src/run.rs:131` verified Publish; `src/run.rs:231` Prune.
- `tests/cli.rs:49` — CLI fixture; acceptance-style behavior tests start at `tests/cli.rs:131`.

Current implementation: Pair CRUD, human Dry-run, Run, SafetyNet, Prune. `plan --json`, `run --json`, Status, History, TUI remain stubs (`src/main.rs:155`, `src/main.rs:189`).

## WHY: product and constraints

VibeFileSync mirrors or updates folders onto APFS/exFAT external drives without silently losing prior destination versions (`README.md:7`). Safety is product behavior:

- Review first: fresh plan precedes every Run; confirmation or explicit `--yes` gates mutation (`docs/adr/0003-dryrun-diff-and-review.md:8`).
- SafetyNet: archive any replaced/removed destination object by same-volume rename (`docs/adr/0001-safetynet-archive-by-rename.md:3`).
- Verified Publish: sibling temp → durability → verification → archive old → rename → parent sync (`src/run.rs:131`).
- Convergence: rerun from a fresh scan after interruption; Journal never becomes copy authority (`docs/adr/0007-journal-design.md:5`).
- Abort by default: volume, empty-source, and free-space guards need explicit per-run overrides (`docs/adr/0002-run-preconditions.md:3`).

## HOW: commands

Run product commands through Cargo: `cargo run --locked -- <vibesync-args>`. Config defaults to `~/.config/vibesync/config.toml`; tests isolate it through `XDG_CONFIG_HOME` (`src/config.rs:95`, `tests/cli.rs:20`).

### Workflow 1: build

1. Confirm Darwin arm64 and stable Rust: `uname -srm`; `rustc --version`; `cargo --version`.
2. Compile reproducibly: `cargo build --locked`.
3. Smoke the CLI without touching sync data: `cargo run --locked -- --help`.
4. For distributable binary: `cargo build --release --locked`; output `target/release/vibesync`.

Detailed procedure: `.agents/skills/build-vibesync/SKILL.md:1`.

### Workflow 2: test

1. Check formatting mechanically: `cargo fmt --check`.
2. Run linter gate: `cargo clippy --locked --all-targets --all-features -- -D warnings`.
3. Run default suite: `cargo test --locked`.
4. Run injected ENOSPC/space-check paths: `cargo test --locked --features fault-injection`.

Detailed procedure: `.agents/skills/test-vibesync/SKILL.md:1`. Test architecture: `docs/adr/0009-acceptance-test-harness.md:3`.

### Workflow 3: release

1. Start from clean, current `develop`; create `release/<version>` (`docs/agents/git-workflow.md:5`).
2. Update `Cargo.toml:3`; regenerate `Cargo.lock` with Cargo; review only intended version changes.
3. Run Workflow 2, then `cargo build --release --locked`.
4. Merge release branch to `main` via PR or `--no-ff`; never direct-commit (`docs/agents/git-workflow.md:7`).
5. Merge release branch back to `develop`; delete branch. Ask maintainer before tagging/publishing: no tag, signing, artifact, or automation policy exists.

Detailed procedure: `.agents/skills/release-vibesync/SKILL.md:1`.

## Working rules

- Gitflow mandatory. Create `feature/<kebab-name>` from `develop` for every coherent code/docs/ADR change; PR targets `develop` (`docs/agents/git-workflow.md:5`).
- `main` receives release/hotfix merges only. Prototype/research branch exemptions are throwaway and never merged (`docs/agents/git-workflow.md:9`).
- Validate config before command-specific behavior (`src/main.rs:148`).
- Keep `plan` read-only; mutation belongs behind Run review and preconditions (`src/plan.rs:338`, `src/run.rs:34`).
- Preserve deterministic ordering and schema versions (`src/plan.rs:89`, `src/pair.rs:13`).
- Exercise filesystem behavior through real temp trees; use the `fault-injection` feature for hard-to-force failures (`tests/cli.rs:49`, `src/run.rs:148`).
- Let `rustfmt`/Clippy own style. Add no prose formatting rules.

## Progressive-disclosure index

Domain and architecture:

- `CONTEXT.md:1` — normative product vocabulary; read before naming domain concepts.
- `docs/architectural_patterns.md:1` — recurring code structure and safety patterns; read for design/refactors.
- `docs/adr/0001-safetynet-archive-by-rename.md:1` — SafetyNet ordering and retention contract.
- `docs/adr/0002-run-preconditions.md:1` — deterministic pre-mutation guards and overrides.
- `docs/adr/0003-dryrun-diff-and-review.md:1` — human/NDJSON plan and review-first UX.
- `docs/adr/0004-cli-surface.md:1` — commands, schemas, exit taxonomy.
- `docs/adr/0005-cli-banner.md:1` — banner surface, stream, suppression.
- `docs/adr/0006-config-format-and-location.md:1` — strict TOML, pair identity, config/state split.
- `docs/adr/0007-journal-design.md:1` — retained NDJSON Journal and convergence role.
- `docs/adr/0008-post-copy-verification.md:1` — verification gate and metadata degradation.
- `docs/adr/0009-acceptance-test-harness.md:1` — crash/fault acceptance strategy and invariants.

Agent operations:

- `docs/agents/domain.md:1` — how to consume glossary and ADRs.
- `docs/agents/git-workflow.md:1` — full gitflow and branch exemptions.
- `docs/agents/issue-tracker.md:1` — GitHub issue/PR commands and wayfinding operations.
- `docs/agents/issue-hierarchy.md:1` — Idea → Epic → Feature → Issue model.
- `docs/agents/triage-labels.md:1` — canonical label mapping.

Specialized only:

- `docs/dynamic-implement.md:1` — team setup and use of Dynamic Implement.
- `docs/dynamic-skills/README.md:1` — cross-agent skill bundle installation.
- `docs/research/dynamic-implement.md:1` — primary-source orchestration research; read only when changing that system.
