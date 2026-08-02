# Config is strict TOML at ~/.config/vibesync, pairs are keyed by name, and Sync mode is per-pair with no flag override

The config story for v1:

1. **Format & location.** A single TOML file at `~/.config/vibesync/config.toml` (honoring `$XDG_CONFIG_HOME`). Mutable state — the Journal, run history — lives separately under `~/Library/Application Support/VibeFileSync/` (owned by the journal ticket, [#10](https://github.com/phassle/VibeFileSync/issues/10)). Config is where devs and agents expect CLI config and is dotfile-manageable; state goes where macOS wants it. Putting everything in Application Support (the original suggestion) was rejected as hostile to shell workflows; putting state in `~/.config` was rejected because run records aren't config.
2. **Layout.** All pairs as `[pairs.<name>]` tables in the one file. `pair add`/`pair remove` rewrite it atomically (write temp + rename — the tool's own Publish idiom). File-per-pair (conf.d style) was rejected as extra surface for a v1 with a handful of pairs.
3. **Pair identity: the name IS the identity.** A user-chosen slug (lowercase letters, digits, dashes; unique) is the TOML table key, the `<pair>` argument on the CLI, and what history/Journal records reference. No hidden stable IDs. Renaming a pair = remove + add, which orphans that pair's history linkage — accepted and documented for v1. The stable-ID-plus-display-name design was rejected as two identifiers and resolution logic v1 doesn't need.
4. **What lives in config: only what defines a pair.** `source`, `destination`, `source_volume_uuid`, `destination_volume_uuid`, and required `mode = "mirror" | "update"`. Everything behavioral stays per-run flags per ADR-0001/0002/0004 (`--yes`, `--json`, `--permanent-delete`, `--allow-empty-source`, `--ignore-space-check`, `--exclude`). No persistent include/exclude filters, no `[defaults]` section, no global settings in v1 (banner/color use env vars per ADR-0005).
5. **Sync mode is per-pair and immutable per run.** No `--mode` flag, no config-default-with-override: a pair's destructive semantics never hinge on a flag, so a cron/agent invocation can't flip an additive pair into deleting mode via a typo. Wanting both behaviors on the same folders means defining two pairs.
6. **Volume UUID contract.** `pair add` stats both volumes (per ADR-0002, `getattrlist` `ATTR_VOL_UUID`) and writes the UUIDs alongside the paths. The file stays hand-editable; editing a path onto a different volume trips the ADR-0002 UUID-mismatch abort on the next run, whose error message says to re-run `vibesync pair add` to re-pin. No `pair repin` command in v1 — **amended** ([#52](https://github.com/phassle/VibeFileSync/issues/52)): `pair add --replace` redefines an existing pair (source, destination, and/or mode) through the same single-writer `pair add` path, in one atomic save, re-pinning both UUIDs and refreshing the volume names. This is the re-pinning route the precondition error above points at; it keeps the pair's name, and therefore its history (§3's remove+add cost applies only when the name itself changes — still the only way to rename, which stays unsupported).
7. **Versioned and strict.** Required top-level `version = 1`, additive-only evolution within v1 (same rule as the JSON schemas in ADR-0004). Unknown keys and missing required fields are hard load errors (exit 2, naming the offender) — a typo like `mod = "mirror"` must abort, not silently default. Lenient parsing was rejected as contradicting abort-by-default.

```toml
version = 1

[pairs.photos]
source = "/Users/per/Photos"
source_volume_uuid = "A1B2…"        # written by `pair add`
destination = "/Volumes/Backup/Photos"
destination_volume_uuid = "C3D4…"   # written by `pair add`
mode = "mirror"
```

## Consequences

- Config load failures are precondition aborts (exit 2 in the ADR-0004 taxonomy), before any destination mutation.
- History/Journal records (ticket #10) reference pairs by name; a renamed pair starts fresh history.
- `pair add` is the only writer that pins UUIDs; there is no separate cache to drift from the file.
- The config file alone reproduces a machine's pair setup (modulo re-pinning UUIDs on different hardware).

Decided on the wayfinder ticket [Decide config format & location](https://github.com/phassle/VibeFileSync/issues/8).
