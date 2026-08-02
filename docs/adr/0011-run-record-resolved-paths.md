# `run_start` additionally records the resolved source and destination

Folder pairs become editable in place (ADR-0010): a pair can be repointed at a new destination, or
a volume can relocate under a stored UUID (ADR-0006), and either changes what a run actually reads
from and writes to without changing the pair's name. Journal and history stay keyed by pair name
(ADR-0007 §4), so without a per-run record of where the run went, a single pair's history could
silently span two different destinations, and a relocated volume would leave no trace of the
location a run actually used.

## Decision

1. **New fields on `run_start`, both schemas.** `source` and `destination` are added to the
   `run_start` event on `vibefilesync.run/v1` (the stdout stream) and `vibefilesync.journal/v1`
   (the retained per-run record), each the absolute path text of the corresponding side.
2. **Resolved, not configured.** Both fields carry the path the run actually used after volume
   resolution (ADR-0006's UUID-plus-relative-path lookup) — never the string stored in config.
   A pair whose volume has relocated therefore records the mount it actually read from or wrote
   to, matching the existing precondition-notice behavior for a relocated volume.
3. **Additive only.** No existing `run_start` field changes shape or meaning; a journal or stream
   consumer that has never heard of `source`/`destination` keeps parsing every other field
   unchanged, per the additive-only compatibility rule ADR-0007 §3 and §14 already established for
   `/v1` schemas.

## Consequences

- `history`/`status` readers that inspect only `run_id`, `pair`, `counts`, etc. are unaffected;
  readers that want to show where a run went can now do so per-run instead of assuming the pair's
  currently configured paths.
- A hand-authored or legacy journal line lacking these fields still parses; the two fields are
  read as absent, not as a parse error.
- Removing a Folder pair still never deletes its run records (ADR-0007 §4); those records now also
  keep an honest account of which source/destination each one used, even after the pair itself is
  edited or removed.

Decided as part of the Commander-style Folder pair configuration work
([#46](https://github.com/phassle/VibeFileSync/issues/46)), resolving
[#49](https://github.com/phassle/VibeFileSync/issues/49).
