# SafetyNet archives by same-volume rename, ordered archive → publish → commit

Any operation that would remove or replace an existing destination object — in Mirror *and* Update — first renames the old version into a visible `_SafetyNet/<run-timestamp>/<relative-path>` tree at the pair's destination root. Rename (not copy) makes archiving near-instant for any file size and behaves identically on APFS and exFAT; because the old object is moved aside first, the subsequent publish rename never overwrites an existing file, so we never depend on atomic-replace rename semantics or on APFS-only primitives (clonefile, renameatx swap) for correctness.

## Consequences

- A crash between archive and publish leaves the file temporarily absent from the destination tree (retained in `_SafetyNet`); restart discards the temp and re-queues the copy. The invariant is "the old version is never lost," not "the destination path is continuously populated."
- `_SafetyNet/` consumes destination disk space and is never pruned automatically in v1 — deletion happens only via an explicit `prune` subcommand; runs warn in preflight on size/free-space pressure.
- Bypassing SafetyNet (permanent delete) is a per-run flag only, never a config setting — every bypass is a fresh, deliberate act at run time.

Decided on the wayfinder ticket [Decide the SafetyNet contract](https://github.com/phassle/VibeFileSync/issues/4).
