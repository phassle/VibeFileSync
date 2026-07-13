# Run preconditions are deterministic, abort by default, and overridable only per-run

Every run checks, before mutating the destination:

1. **Volume identity** — Folder pairs pin both source and destination to their volume UUIDs at configuration time. At run start each configured path's volume UUID is compared to the stored one; on mount-point drift (e.g. `/Volumes/Backup` → `/Volumes/Backup 1`) the run relocates by UUID and loudly reports the drift — the pair follows the volume, not the path. A pinned UUID mounted nowhere is a hard abort. This is also the unmounted-source guard: an unmounted external source never reaches directory enumeration.
2. **Empty-source tripwire** — in Mirror mode, a source that enumerates empty against a non-empty destination aborts the run unless the explicit per-run flag `--allow-empty-source` is present.
3. **Free-space preflight** — needed space is the total size of new + changed files, with no credit for replacements or deletions (SafetyNet archives by rename, so nothing is freed mid-run). Estimate exceeding destination free space aborts, overridable per-run with `--ignore-space-check`. Preflight also reports `_SafetyNet/` total size as a warning, never a blocker.

If the destination fills mid-run anyway (override used, or external writes), the run aborts cleanly: the in-progress temp is discarded, the Journal keeps committed files, and the process exits non-zero with a clear "destination full" error — recovery is the existing crash path, resuming at file granularity on rerun.

## Consequences

- No heuristics (no ratio-based "deleting too much" warnings), no interactive prompts, no config-file overrides: every guard is a single deterministic condition, and every bypass is a fresh per-run flag — the same philosophy as ADR-0001's permanent-delete flag. Scripted and agent-driven runs get predictable behavior and clear non-zero exits.
- Pair configuration must capture volume UUIDs (via `getattrlist` `ATTR_VOL_UUID`, available for both APFS and exFAT) — the config format decision inherits this requirement.
- The CLI surface inherits two per-run flags: `--allow-empty-source` and `--ignore-space-check`.

Decided on the wayfinder ticket [Decide run preconditions & sanity guards](https://github.com/phassle/VibeFileSync/issues/5).
