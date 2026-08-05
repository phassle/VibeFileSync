# Quickstart — running the app

Prerequisite: macOS Apple Silicon, `rustc` installed.

## 1. Build

```bash
cargo build --locked          # dev binary → target/debug/vibesync
# or, for a distributable binary:
cargo build --release --locked  # → target/release/vibesync
```

Smoke-test without touching sync data:

```bash
cargo run --locked -- --help
```

## 2. Create a Folder pair

A pair names a one-way source → destination and pins both volumes by UUID.

```bash
cargo run --locked -- pair add <name> \
  --source <source-directory> \
  --destination <destination-directory> \
  --mode mirror   # or: update
```

List pairs:

```bash
cargo run --locked -- pair list
cargo run --locked -- pair list --check        # volume state per pair
cargo run --locked -- pair list --source <path>  # find the pair for a directory
```

Remove a pair:

```bash
cargo run --locked -- pair remove <name>
```

## 3. Start the TUI (recommended)

Fully keyboard-driven interface: Select → Compare → Review → Confirm → Run → Result.

```bash
cargo run --locked -- tui                 # pair selector
cargo run --locked -- tui <name>          # start directly on one pair
```

## 4. Or: the CLI pass (review-first)

**Plan** shows the planned actions without writing:

```bash
cargo run --locked -- plan <name>         # human-readable format
cargo run --locked -- plan <name> --json  # NDJSON, schema vibefilesync.plan/v1
```

**Run** executes — asking first:

```bash
cargo run --locked -- run <name>                # confirmation prompt
cargo run --locked -- run <name> --yes          # skip the prompt (cron/agent)
cargo run --locked -- run <name> --verify       # full hash verification
```

Common per-run overrides: `--allow-empty-source`, `--ignore-space-check`, `--exclude <PATH>` (repeatable).

## 5. After the run

```bash
cargo run --locked -- status <name>     # outcome of the latest run
cargo run --locked -- history <name>    # earlier runs
cargo run --locked -- prune <name>      # clear out old SafetyNet runs
```

## Safety behaviour worth knowing

- **Review-first**: every Run begins with a fresh Plan.
- **SafetyNet**: replaced or removed destination objects are archived by rename into `_SafetyNet/<run-id>/`.
- **Convergence** after an interruption: just run `run` again; never repair by hand.
- **Abort by default**: volume, empty-source and free-space checks require explicit per-run overrides.

## Exit codes (for scripts and agents)

| Code | Meaning |
| --- | --- |
| 0 | clean run |
| 1 | partial |
| 2 | precondition abort |
| 3 | blocked plan |
| 4 | interrupted |
| 64 | usage error |

## Configuration

`~/.config/vibesync/config.toml` (honours `$XDG_CONFIG_HOME`).

## Further reading

- [`README.md`](../README.md) — product overview.
- [`CONTEXT.md`](../CONTEXT.md) — domain vocabulary.
- [`docs/adr/`](adr/) — ADR-0001…0012.
