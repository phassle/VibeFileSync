# The binary is `vibesync`, hot-path verbs are top-level, run --json streams NDJSON events, and exit codes are a rich taxonomy

Decided by reacting to a terminal prototype (branch [`prototype/cli-surface`](https://github.com/phassle/VibeFileSync/tree/prototype/cli-surface)) showing three command grammars, two run-JSON contracts, and two exit-code taxonomies.

1. **Binary name: `vibesync`.** `vfs` was rejected (reads as "virtual filesystem" to the target audience), `vibefilesync` as too long for an everyday command.
2. **Command grammar: frequent verbs top-level, management namespaced.** `vibesync plan|run|status|history <pair>` and `vibesync prune <pair>` are top-level; pair management is `vibesync pair add|list|remove`; `vibesync tui [<pair>]` launches the TUI. Fully-namespaced (kubectl-style) and flat-verb (`ls`/`rm`) grammars were rejected — the first taxes the hot path, the second reads ambiguously in scripts.
3. **Per-run flags** (all per-run only, never config, per ADR-0001/0002/0003): `--yes`, `--json`, `--permanent-delete`, `--allow-empty-source`, `--ignore-space-check`, and, on `run`, repeatable `--exclude <relative-path>` — exact paths as `plan` prints them, no glob engine in v1. The read-only `plan` surface has no exclusion flag; Run and the TUI own review filtering.
4. **`run --json` is an NDJSON event stream** (schema id `vibefilesync.run/v1`), same envelope as the plan stream from ADR-0003: `run_start`, `action_start`, `progress` (large files only, throttled), `action_done` (with `result`, `verified`, `safety_net`), trailing `summary`. Summary-only JSON was rejected: an agent watching a long run must see live state without polling. Cron consumers read the final `summary` line.
5. **Schema stability rule:** every JSON payload carries a `schema` field. After a schema is released, changes within `/v1` are additive-only — removing a field or changing a meaning bumps the version. Before the first release, a provisional `/v1` may be corrected in place only by explicitly revising its governing ADR and acceptance tests; feature #14 used that exception to finalize the Plan, Run, and Journal contracts. `pair list --json` and `history --json` follow the same convention (`vibefilesync.pairs/v1`, `vibefilesync.history/v1`).
6. **Exit codes — rich taxonomy:** 0 clean · 1 partial (run finished, ≥1 action failed) · 2 precondition abort (ADR-0002 guards, pre-mutation) · 3 blocked plan (plan contains error actions under `--yes`, ADR-0003) · 4 interrupted (signal/crash; Journal holds state, rerun resumes) · 64 usage (BSD sysexits). The minimal 0/1/2 contract was rejected — agent-first scripts branch on the class (retry on 4, alert on 2/3) without parsing JSON.
7. **No `restore` subcommand in v1.** The `_SafetyNet/` tree is deliberately visible and Finder-browsable; restore is manual copy-back. Ruled out of scope on the map.

## Consequences

- `status` and `history` require persisted per-run records (result, counts, bytes, run id) — this requirement inherits into the Journal design ticket ([#10](https://github.com/phassle/VibeFileSync/issues/10)): the journal (or a sibling record) must survive the run to feed them.
- The plan/v1 and run/v1 streams share the `type`/`op`/`path` vocabulary, so agent consumers parse one shape for both dry-runs and executions.
- `run --exclude` takes exact paths from an unfiltered `plan --json` stream, so the agent workflow is: `plan --json` → filter rows → `run --exclude … --yes`. Glob support, if ever, is additive.

Decided on the wayfinder ticket [Prototype the CLI surface (subcommands + --json schemas)](https://github.com/phassle/VibeFileSync/issues/7).
