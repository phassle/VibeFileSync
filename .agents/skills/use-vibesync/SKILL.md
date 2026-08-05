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

## Run — review, confirm, stream

The Compare table above (with whatever `--exclude` flags the human chose) is the review. Only after the
human replies with an explicit "yes" in chat does the agent invoke the Run itself — never on an unconfirmed
Compare, and never because a plan merely rendered cleanly. The order is fixed: review first, then the
human's explicit chat "yes", and only then does the agent pass `--yes` to the binary.

`--yes` suppresses the binary's own interactive confirmation prompt (the CLI otherwise "prints the plan and
asks y/N", ADR-0003 §4). That is legitimate only because the review and the human's "yes" already happened
in chat before the agent ran anything — the confirmation moved, it was not removed. An agent has no TTY to
answer the binary's own prompt with, so `--yes` is how that same review-first requirement is honoured in a
TTY-less context, not a way to bypass it.

- Real binary: `vibesync run <pair> --yes --json --exclude <PATH> --exclude <PATH>`
- Development fallback: `cargo run --locked -- run <pair> --yes --json --exclude <PATH> --exclude <PATH>`

Carry forward whichever `--exclude <PATH>` flags the previous section assembled; omit them entirely when
the human excluded nothing.

`--json` streams the Run as NDJSON, schema `vibefilesync.run/v1` — a different schema from Compare's
`vibefilesync.plan/v1`, with its own event types. Surface these live as they arrive, not as a wall of JSON
at the end:

- `action_done` rows, one per finished action, each as it arrives. `result` is this action's outcome
  ("done" for a successful action on this stream). `verified` names the Verification tier that action
  passed — "standard" or "full" under `--verify` — and is the agent's **only** source of truth for
  Verification; report what it says and do not re-hash, re-stat, or otherwise re-check the file yourself,
  since Verification is the binary's own per-file gate strictly before Publish (ADR-0008), not something
  the agent repeats. `safety_net` is the path the previous destination object was archived to by rename,
  or `null` when nothing was archived for that action. That archiving is the run's default, not a
  standing guarantee (ADR-0001): a run started with `--permanent-delete` removes the replaced or removed
  object directly instead, so a `null` on such a run reflects that the run itself opted out, not that
  nothing needed archiving. `--permanent-delete` is named here only to explain why `safety_net` can
  legitimately be `null`; deciding whether to offer it for a given run is a separate concern this section
  does not cover.
- `progress` rows for large files in flight. The binary throttles these itself — only for Copy and Update
  actions at or above its own size threshold, and at its own fixed time interval thereafter — so surface
  each one as it arrives rather than batching or re-throttling them further.
- a trailing `summary` event once the Run finishes: action and byte counts, a warning count, and how many
  actions the fresh scan discovered after the reviewed plan was fixed. Read it, but do not print it verbatim.

On exit 0, report "done" and stop. Do not dump the `summary` event's JSON to the human — they already saw
the reviewed plan in the Compare table; the live `action_done` rows and the final "done" are enough.

Fault exits are a separate concern this section does not cover.

## Steering — TUI, restore, and resume requests

Three requests this skill answers by telling the human what to do, rather than attempting it.

### TUI request

The TUI takes over a real terminal interactively. The agent has no TTY to offer it and never launches or drives the TUI itself — tell the human to run it themselves:

- Real binary: `vibesync tui [<pair>]`
- Development fallback: `cargo run --locked -- tui [<pair>]`

The Pair name is optional: give it to open the TUI focused on that Folder pair, or omit it to open unfocused. (ADR-0011 records why even a scripted driver with a real pseudo-terminal must rendezvous on the TUI's own terminal output rather than on elapsed time; an agent with no terminal at all has no such surface to synchronize on.)

### Restore request

There is no `restore` subcommand in v1 (ADR-0004 §7). Tell the human that `_SafetyNet/` is deliberately visible and Finder-browsable, and that restoring something is a manual copy back from its Run folder to the original location. This only has something to copy back if that Run folder exists: by default, a removed or replaced destination object is archived into SafetyNet before it is touched, but a run given `--permanent-delete` bypasses SafetyNet for that run, and there is nothing left to restore from afterward.

The skill does not fabricate a `restore` command; never invent this invocation.

### Resume request ("pick up where it left off" after an interruption)

Refuse the request as asked — there is no mid-file resume in this product, the sense `CONTEXT.md`'s Convergence entry names only to reject. The Journal (ADR-0007) is a forensic, historical record of what happened on past runs; it is never copy authority and never decides what the next run copies. Tell the human the correct next step is to rerun the Folder pair: its own fresh scan converges on the correct destination state — one rerun, nothing replayed from the Journal, no manual repair.

## Prune — a gated mutation

Prune deletes archived versions permanently, with nothing left to fall back on afterward, so it goes
through the same review-first mutation gate the Run section above establishes (ADR-0003, ADR-0010
re-anchored as a chat gate): list what would be deleted, agent summary, the human's explicit chat "yes",
then execute. Do not re-derive that gate's rationale here — see the Run section. The one difference from
Run: Prune has no `--yes`-style flag to lean on, because Prune takes no flags at all. Every command in
this section's gate therefore happens in chat, before the agent runs anything.

1. **List.** Show the SafetyNet Run folders under the pair's destination that this Prune would delete,
   each by its Run id. `src/run.rs::prune` walks the pair's `_SafetyNet/` directory and removes exactly the
   directory entries whose name is a Run id (`src/journal.rs::is_run_id`); a differently named entry there —
   a manually renamed folder, a stray file — is left alone, and so is everything outside `_SafetyNet/`,
   including the pair's current destination content (`tests/cli.rs::prune_removes_run_folders_but_nothing_else`
   asserts both: a `_SafetyNet` entry not shaped like a Run id survives, and destination content outside
   `_SafetyNet` survives). `prune` has no Compare/Dry-run step of its own; build this list yourself from
   `_SafetyNet/`'s Run-id-named entries before offering the human anything to confirm.
2. **Summary.** Name, by Run id, what each Run folder holds — that Run's full archived set, relative paths
   preserved, the unit Prune deletes. Make the permanence explicit: this is the only way archived versions
   are ever deleted in v1, there is no `--permanent-delete`-style bypass to offer here (see below), and
   nothing is recoverable afterward.
3. **Human "yes".** Only after the human's explicit chat "yes" does the agent invoke `prune` — never on an
   unconfirmed list.
4. **Execute.**
   - Real binary: `vibesync prune <pair>`
   - Development fallback: `cargo run --locked -- prune <pair>`

`prune` takes the Pair name as its only argument and accepts no flags at all — there is no
`--permanent-delete` option on this subcommand. That flag exists only on `run`, as a per-run SafetyNet
bypass for that run's own removals (ADR-0001, ADR-0002); it has no referent here, because everything Prune
deletes is, by definition, already inside `_SafetyNet/` — there is no un-archived removal on this path for
a bypass to apply to. Do not offer `--permanent-delete` on `prune` and do not invent an equivalent flag for
it; there is nothing to bypass.
