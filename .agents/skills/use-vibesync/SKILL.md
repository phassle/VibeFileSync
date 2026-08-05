---
name: use-vibesync
description: "Operate the vibesync CLI on the user's behalf, so they don't have to run it themselves."
disable-model-invocation: true
---

# Use VibeSync

Speak `CONTEXT.md`'s vocabulary throughout, with no synonyms: Folder pair, Pair name, Mirror, Update, SafetyNet, Run folder, Prune, Journal, Run id, Dry-run, Compare, Publish, Convergence, Verification, Expected degradation, Run preconditions.

## Binary invocation

Prefer the `vibesync` binary on `PATH`. Where it is not installed, fall back to `cargo run --locked --`, matching `AGENTS.md`'s build workflow — append the same arguments after the `--`.

## Design context — refer, don't restate

This skill assumes `CONTEXT.md` and the ADRs below; consult them rather than restating their content here:

- `docs/adr/0002-run-preconditions.md` — abort-by-default Run preconditions: mount state, volume identity, free space.
- `docs/adr/0003-dryrun-diff-and-review.md` — review-first Dry-run/Run and the human/NDJSON diff shape.
- `docs/adr/0004-cli-surface.md` — command grammar and exit-code taxonomy.
- `docs/adr/0007-journal-design.md` — the Journal as forensic record, not resume authority.
- `docs/adr/0008-post-copy-verification.md` — the per-file Verification gate.
- `docs/adr/0010-commander-two-sided-review.md` — the TUI's two-sided action table.
- `docs/adr/0011-scripted-tui-input-synchronisation.md` — scripted TUI input rendezvous.

## Add a Folder pair

Adding a **new** Folder pair does not mutate the destination, so it runs immediately: no review, no
confirmation gate. (Redefining an *existing* pair, with `--replace`, is a different operation and out of
scope here.)

Before saving, tell the human which Sync mode they picked, in plain language:

- **Mirror** — the destination becomes an exact copy of the source; this includes removing destination
  files and folders that no longer exist on the source.
- **Update** — new and changed source files are copied to the destination; the mode does not remove a
  destination object merely because it is missing from the source.

Lead with the Mirror warning — that is the mode where the human is most likely to be surprised by the
next Run.

The human supplies the Pair name, the source, the destination, and the Sync mode; the binary pins both
volume UUIDs when it saves the pair.

- Real binary: `vibesync pair add <pair> --source <PATH> --destination <PATH> --mode <mirror|update>`
- Development fallback: `cargo run --locked -- pair add <pair> --source <PATH> --destination <PATH> --mode <mirror|update>`

Give the Pair name as the command's only positional argument. Confirm back that the pair was saved.

## Pair list — direct, ungated, read-only

`pair list` never mutates the destination, so it runs immediately: no review, no confirmation gate.

- Real binary: `vibesync pair list`
- Development fallback: `cargo run --locked -- pair list`

Report back the Folder pairs it returns.

## Read-only reporting — status, history, filtered pair list

Like `pair list`, these commands never mutate the destination, so each runs immediately: no review, no
confirmation gate.

### Status

Reports the last run's outcome for one Folder pair, read from the Journal (ADR-0007) — forensic only, not
a resume mechanism.

- Real binary: `vibesync status <pair>`
- Development fallback: `cargo run --locked -- status <pair>`

Give the Pair name as the command's only argument. Report back the Run id, result, action counts, bytes,
and warning count it prints, along with any stray temp files it lists.

### History

Reports past runs for one Folder pair over time, also read from the Journal (ADR-0007).

- Real binary: `vibesync history <pair>`
- Development fallback: `cargo run --locked -- history <pair>`
- JSON form: `vibesync history --json <pair>`
- JSON development fallback: `cargo run --locked -- history --json <pair>`

Give the Pair name as the command's argument; add `--json` for the machine-readable form. Report back one
entry per past Run id: its Run id, result, action counts, bytes, and warning count.

### Filtered pair list

`pair list --check` classifies each side of every Folder pair's volume state — advisory only, per the Run
preconditions ADR-0002 — so a missing drive is visible before a sync is attempted, not after.

- Real binary: `vibesync pair list --check`
- Development fallback: `cargo run --locked -- pair list --check`

`pair list --source <PATH>` narrows the listing to the Folder pair whose source matches that directory.

- Real binary: `vibesync pair list --source <PATH>`
- Development fallback: `cargo run --locked -- pair list --source <PATH>`

Report back whichever Folder pairs, and whichever volume-state classification, the command returns.

## Compare — plan with a two-sided action table

`plan --json` never mutates the destination, so it runs immediately: no review, no confirmation gate.

- Real binary: `vibesync plan --json <pair>`
- Development fallback: `cargo run --locked -- plan --json <pair>`

Compare a Folder pair by running it and parsing the `vibefilesync.plan/v1` NDJSON stream it emits, then rendering a two-sided action-table summary in chat — copies on one side, replacements and removals on the other, each with its own count (e.g. "12 copy, 3 replace, 1 remove"). This is the chat rendering of ADR-0010's two-sided review, which supersedes ADR-0003 §3 for the review surface; do not re-derive its rationale here. Read the counts from the closing `summary` event's `counts` object rather than tallying `action` rows yourself, and report them by the plain labels above rather than the raw field names: `counts.copy` is "copy" (the addition side); `counts.update` (an existing destination file's content to be replaced — note this is the action-level field name, distinct from the Sync mode also called Update) is "replace"; `counts.delete` (a destination object to be removed) is "remove". "Replace" and "remove" together are the other side.

Surface the pair's Sync mode from the opening `plan_start` event's `mode` field as part of the same summary, before any confirm. This is the safety point of the review, and it matters in both modes: by default every removal this table shows goes through SafetyNet on a real run, archived by rename before anything is removed — but that default can be overridden per run, so it must be visible ahead of time regardless. Destination-only removals (an object present on the destination and absent from the source) are Mirror-only; Update never produces these. But a source object structurally replacing a destination object of the other kind (a source file over a destination directory, or a source directory over a destination file) removes that destination object in both modes and is counted in `counts.delete`, so `counts.delete` can be non-zero in Update — the summary is not additive-only.

This is the review surface only: parsing and rendering the summary. Confirming and running the plan is a separate step this skill does not cover here.

## Exclude paths before a Run

After rendering the Compare table from the unfiltered `plan --json` stream above, offer the human the
chance to drop specific rows before any Run: let them pick one or more of the exact relative paths already
shown in that stream's `action` events' `path` field, taken verbatim — no glob engine, no invented syntax
(ADR-0004 §3), on `run` rather than on `plan`. A path either matches one of those printed strings exactly
or it excludes nothing.

Carry the paths the human picks forward as repeated `--exclude <PATH>` flags on the Run this shapes. Run
mutates the destination; assembling this flag list is where this section's job ends — Run's own
confirmation gate and event stream are a separate concern this section does not cover.

- Real binary: `vibesync run <pair> --exclude <PATH> --exclude <PATH>`
- Development fallback: `cargo run --locked -- run <pair> --exclude <PATH> --exclude <PATH>`

Repeat `--exclude <PATH>` once per chosen path.
