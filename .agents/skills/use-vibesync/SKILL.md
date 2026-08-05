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
