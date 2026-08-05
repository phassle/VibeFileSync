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

## When a Run cannot start — exit 3 and exit 64

Two ways a Run never reaches the confirmation gate or the stream `## Run — review, confirm, stream` describes: the reviewed plan itself cannot execute, or the invocation was malformed before any command logic ran. Neither is exit 2's Run preconditions abort or exit 4's mid-run interruption — the distinction is *when* each check fires, not how "blocked" happens to sound next to "interrupted".

### Exit 3 — blocked plan (`src/error.rs::EXIT_BLOCKED_PLAN`, 3)

`EXIT_BLOCKED_PLAN`'s doc comment: "The reviewed plan contains an included error action and cannot run." `src/run.rs::review_plan` checks the plan's error list before the confirmation gate `## Run` already describes — satisfied there by the human's chat "yes" plus the agent's own `--yes` — is even consulted, and returns early on that check alone while an error action is still included. Per ADR-0003 §5, an included plan error "blocks confirmation while included: the user must exclude the row … or resolve it at the source. No auto-skip-with-warning." Exit 3 is what that blocking looks like from outside: the plan an agent normally runs under `--yes` turned out to contain a row the binary refuses to execute.

Concretely, a plan error arrives as its own `op: "error"` row inside the same `vibefilesync.plan/v1` stream `## Compare` already parses (`src/plan.rs::PlanError`), carrying a `path` and a `reason`. That row is "the new failed action" the acceptance criterion means.

**No Run.** `review_plan`'s error check runs before any journal is opened, so exit 3 means mutation never started — not a partial one. On exit 3, send the human back to `## Compare` with that error row surfaced, so they can exclude it or fix it at the source and re-plan; this section does not re-describe the two-sided table or the confirm step, both of which belong to `## Compare` and `## Run`.

Distinguish from its neighbours, since all three read as "the run didn't happen":

- Exit 2 (sibling #91's) is a Run preconditions failure at invocation time — a different check, on different grounds, than an error already sitting in the plan.
- Exit 4 (sibling #90's) happens only after a journal already exists — a run that started and could not finish reliably.
- Exit 3 is earlier than both: the check that produces it runs before the journal exists and before the confirmation gate is reached, so it is not a mutation gone wrong — it is a plan that never qualified to run.

### Exit 64 — usage (`src/error.rs::EXIT_USAGE`, 64)

`EXIT_USAGE` covers a malformed invocation: an unparseable CLI invocation caught before any command runs (`src/main.rs::main`), and `AppError::Usage` cases raised deeper in — a bad, duplicate, or missing pair name, or a non-existent source/destination path.

**Report and stop — no retry, no override offer.** On exit 64, report the usage error text to the human as written and stop there. Do not retry the same invocation unmodified, and do not offer any of the per-run overrides `## Run`'s sibling sections cover (`--permanent-delete`, `--allow-empty-source`, `--ignore-space-check`) — none of them addresses a malformed invocation, and offering one here would wrongly imply exit 64 is a Run preconditions failure that can be bypassed the way exit 2 can be.
