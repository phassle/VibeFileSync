# VibeFileSync

A native macOS (Apple Silicon) one-way file-sync tool: pick Folder pairs, choose a Sync mode, run it repeatedly — a crash-safe successor to the FreeFileSync concept. Pure-Rust binary, CLI-first, with a thin TUI on the same engine.

## Language

**Folder pair**:
A configured source directory and destination directory that sync runs operate on.
_Avoid_: sync pair, job, profile

**Pair name**:
The unique user-chosen identifier of a Folder pair — the handle runs are invoked with and the key run records reference. Renaming a pair creates a new identity.
_Avoid_: pair id, profile name, job name

**Mirror**:
The Sync mode that makes the destination an exact copy of the source, including removals — every removal or replacement goes through SafetyNet.
_Avoid_: backup mode, clone

**Update**:
The additive-only Sync mode — new and changed source files are copied; nothing on the destination is ever removed.
_Avoid_: copy mode, additive sync

**SafetyNet**:
The retention guarantee that the previous destination version is durably kept — by renaming it into the destination's `_SafetyNet/` tree — before any operation in any Sync mode removes or replaces an existing destination object, unless permanent deletion was explicitly selected for that run.
_Avoid_: trash, recycle bin, versioning (as a synonym — versioning is one mechanism SafetyNet may use)

**Run folder**:
The subfolder of `_SafetyNet/`, named by the Run id, holding everything one run archived with relative paths preserved — the unit of restore and of Prune.
_Avoid_: snapshot, backup set

**Prune**:
The explicit command that deletes SafetyNet Run folders; the only way archived versions are ever deleted in v1.
_Avoid_: cleanup, auto-purge

**Journal**:
The retained per-run record of a run's intent, per-file transitions (`pending → in-progress → committed`), and outcome. Forensic and historical only — a rerun's fresh scan, never the Journal, decides what to copy; it is not a mid-file resume mechanism.
_Avoid_: WAL, database, index

**Run id**:
The UTC timestamp identity (`YYYYMMDDTHHMMSSZ`) a run is known by everywhere — the Journal file name, the SafetyNet Run folder name, and the `run_id` field in JSON events.
_Avoid_: run timestamp, session id

**Dry-run**:
A run that produces the diff of planned actions without mutating the destination; the reviewable plan a real run executes.
_Avoid_: preview, simulation

**Publish**:
The atomic step that makes a verified temp file appear under its final destination name (rename + parent-directory sync), after any SafetyNet archiving of what it replaces.
_Avoid_: commit (reserved for the Journal state), finalize

**Convergence**:
The guarantee that the next run after any interruption or fault reaches the correct destination state through its own fresh scan — one rerun, no manual repair, nothing replayed.
_Avoid_: recovery, self-healing, resume (reserved for the rejected mid-file sense)

**Verification**:
The per-file gate a copy must pass before any destination change — the copied temp matches the source at the tier the run selected, and the source still matches what the run planned from.
_Avoid_: validation, integrity check

**Expected degradation**:
A metadata property the destination volume is known to be unable to preserve — a fact about the Folder pair stated once per run, never a per-file failure or warning.
_Avoid_: warning (reserved for unexpected metadata mismatches), metadata loss

**Run preconditions**:
The sanity checks a run must pass before mutating the destination — e.g. source volume actually mounted (an unmounted source reads as an empty directory), volume identity matches the Folder pair, sufficient free space.
_Avoid_: preflight checks, guards
