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

## When a Run does not finish cleanly — exit 1 and exit 4

The Run section above covers exit 0. Two fault exits need their own handling, both resolved by Convergence
(ADR-0007) rather than by the Journal: a rerun always proceeds from that rerun's own fresh scan, never from
a replay of Journal state, and the agent never attempts a mid-file resume — see Steering's Resume request
above for that refusal; this section only adds what exit 1 and exit 4 themselves require.

### Exit 1 — partial (one or more actions failed)

A Run that finishes but leaves one or more actions failed exits with status 1. There is no named constant
for this exit code — `src/error.rs::EXIT_OK`, `src/error.rs::EXIT_PRECONDITION`,
`src/error.rs::EXIT_BLOCKED_PLAN`, `src/error.rs::EXIT_INTERRUPTED`, and `src/error.rs::EXIT_USAGE`, and
none of them is exit 1 — but the exit code is real behaviour: ADR-0004 §6 documents "1 partial (run
finished, ≥1 action failed)" in its taxonomy, and `src/run.rs::finalize` returns it literally whenever the
run's failed-action count is non-zero.

Identify which actions failed by reading `src/event.rs::action_failed` rows already surfaced on the run
stream as they arrived — do not re-scan the destination to discover them. `src/event.rs::action_done` and
`src/event.rs::action_failed` are the two separate constructors for a finished action, and only one of the
two ever carries a failure: see the discrepancy note below for why `action_done` is not that source. An
`action_failed` row's `reason` field is drawn from the closed `src/failure.rs::FailureReason` vocabulary
(`verify_mismatch`, `source_changed`, `destination_full`, `reconciliation_changed`, `dependency_failed`,
`filesystem_error`). Report back each failed action's path and reason from the `action_failed` rows already
seen, then offer the human a rerun — the same `vibesync run` invocation shown above, with the same
`--yes --json` gate and confirmation this section does not repeat; a rerun is just another Run of the same
Folder pair, and its own fresh scan is what converges on the correct destination state, not anything read
back out of the Journal.

### Exit 4 — interrupted (signal or crash)

Exit 4, `src/error.rs::EXIT_INTERRUPTED`, is a Run that started but could not complete reliably — its own
doc comment's phrasing — and did not reach its final `summary`. Whether the destination was actually
touched before the interruption landed is not knowable from the exit code alone: the interruption check
`crate::interrupt::check` runs before `src/run.rs::dispatch`'s own action loop even begins, so a signal
caught that early can produce exit 4 with nothing yet copied, updated, or deleted. Do not tell the human the
destination was already being mutated; the honest answer is "possibly, possibly not" — and that uncertainty
is exactly why the next step is a rerun rather than a manual read of what was touched: Convergence
(ADR-0007) means the rerun's own fresh scan settles the destination's real state regardless of how much or
how little the interrupted run did. On this exit, rerun the same Folder pair once, automatically — the same
`vibesync run` invocation as above, re-issued without waiting for a fresh human "yes", since a rerun's own
fresh scan is what Convergence (ADR-0007) relies on to make that one automatic retry safe. ADR-0004 §6
glosses this exit as "Journal holds state, rerun resumes"; read that gloss alongside ADR-0007's own
consequences, which state the same "rerun resumes" more precisely: the rerun re-scans and converges, and
never replays the Journal. This section follows ADR-0007's more precise wording rather than reproducing
ADR-0004 §6's looser gloss.

Bound the retry: exactly one automatic rerun. If that rerun also exits 4, stop — do not rerun a second
time automatically, and do not loop. Surface the second failure to the human instead and let them decide
the next step.

### A discrepancy this section does not silently resolve

Issue #90's own acceptance criterion 4 says failed actions are read from `action_done` stream events. That
is not what the source does: `action_done`'s `result` field is hardcoded to the literal string `"done"` and
never carries a failure value, so a failed action can never appear as an `action_done` row — it always
arrives as the separate `action_failed` row this section documents above (`src/event.rs::action_done` and
`src/event.rs::action_failed`; `src/run.rs::dispatch` chooses between them per action). ADR-0004 §4's
run-stream event list (`run_start`, `action_start`, `progress`, `action_done`, `summary`) is also incomplete
for the same reason: it omits `action_failed` entirely. Issue #90's text and ADR-0004 §4 agree with each
other and both disagree with the implementation; this section documents what the source actually emits
rather than the issue's wording, and the discrepancy against both issue #90 criterion 4 and ADR-0004 §4 is
reported in this unit's handoff rather than corrected here.

## When a Run aborts on a Run precondition — exit 2

Exit 2 (`EXIT_PRECONDITION`, `src/error.rs`) means the binary aborted before touching the destination, per ADR-0002's abort-by-default. Exit 2 is not one failure — read the binary's own error message to identify which Run precondition fired before naming it back to the human; never guess from the exit code alone.

Two Run preconditions are enforced by `run` itself (`src/preconditions.rs::check_run`, reached only at the run edge so a dry-run can still explain what would happen) and each has exactly one matching per-run override. All three flags named in this section are fields of the `Run` variant in `src/main.rs::Command`, confirmed against `vibesync run --help`.

- **Empty source against a non-empty Mirror destination** — Mirror mode, the source scans as empty, the destination does not (an unmounted source volume also reads this way, per `CONTEXT.md`'s Run preconditions entry). The message names it: "source is empty while Mirror destination is non-empty". Offer `--allow-empty-source` only.
- **Insufficient destination free space** — the plan's new-and-changed bytes exceed the destination's available space. The message names it: "destination free space is insufficient". Offer `--ignore-space-check` only.

A third class also aborts with exit 2 but has **no matching override at all**: volume-identity mismatch and self-overlap, both raised earlier in `src/preconditions.rs::resolve_pair`, before `check_run` ever runs — a pinned volume not mounted, a foreign volume at the stored path, or source and destination naming the same or a nested directory (its message contains "same directory" or "nested inside"). No flag relaxes any of these; the fix sits outside the Run (remount the volume, or remove and re-add the Folder pair). Never invent or offer an override for this class — report the message as-is and stop.

Offer only the override that matches the Run precondition actually named in the message, one at a time, each its own explicit yes/no question in chat: never bundled with another override, never applied because the human said yes to a different one, and never applied silently (ADR-0002). This is what keeps abort-by-default meaningful through the agent layer, not an aside. On an explicit "yes", re-invoke with that single flag added to the same `run --yes --json` invocation `## Run` above already establishes, carrying forward any `--exclude` flags already in play; on "no", stop and report the abort as-is.

- Real binary: `vibesync run <pair> --yes --json --allow-empty-source`
- Real binary: `vibesync run <pair> --yes --json --ignore-space-check`
- Development fallback: prefix either with `cargo run --locked --`, per `## Binary invocation`.

`--permanent-delete` does not belong in the mapping above. No Run precondition fires for it, and no exit 2 ever names it — it is not a Run precondition at all, but a SafetyNet bypass. By default, a replaced or removed destination object is archived by rename before removal; a run given `--permanent-delete` removes the object directly instead (`src/run.rs::remove_file`), and `tests/cli.rs::permanent_delete_bypasses_safetynet_for_this_run` asserts the object is gone afterward with no `_SafetyNet` left behind at all — that default-vs-bypass is conditional, never state it as an unqualified guarantee either way. Never offer `--permanent-delete` in response to an exit 2 abort, and never bundle it with `--allow-empty-source` or `--ignore-space-check`. If the human wants to skip SafetyNet for a run, that is its own separate explicit yes/no question, asked on its own terms, subject to the same never-auto-applied, never-silent rule as the two precondition overrides above.

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

## Redefining and removing a Folder pair — gated mutations

`pair add --replace` (redefining an existing Folder pair's volumes) and `pair remove` (deleting a pair) are the
two Folder pair mutations this section covers, and each is irreversible for its own reason. Both go through the
same review-first gate as a Run (ADR-0003; re-anchored as a chat gate by ADR-0010): report what will be lost →
agent summary → the human's explicit chat "yes" → only then does the agent invoke the command.

That gate is entirely agent-mediated, not something the binary offers. Neither `src/pair.rs::add` nor
`src/pair.rs::remove`, nor `src/main.rs::run_pair`, contains a confirmation prompt, a review step, or a
`--yes`-style flag for either operation — both write their result and save immediately once called, with no
branch that waits for input. This is unlike Run's own `--yes`, above, which suppresses a real interactive y/N
prompt the binary does ask; here there is no prompt to suppress, because the binary never asks one in the
first place. So the report, the summary, and the "yes" are steps the agent performs *before* calling either
command at all — never a flag or prompt the binary itself provides — and the agent must never invoke either
command on an unconfirmed report.

Both saves are atomic: `pair add --replace` rewrites the pair's config entry in one save (ADR-0006 §6), and
`pair remove` deletes it in one save, so neither can leave the config half-written. Atomicity is not safety —
it only means the write itself cannot corrupt the file. It says nothing about whether what that write discards
can be gotten back, and for both of these mutations, it cannot: once the save completes, there is no undo.

### `pair add --replace` — redefining which volumes a pair points at

Report the new source, destination, and Sync mode the human is proposing, and that saving will re-pin both
volume UUIDs to that new source and destination. Saving discards the pair's previous volume binding: the old
source path, destination path, and both volume UUIDs are overwritten in the same save and are not recorded
anywhere else, so there is no way back to what the pair pointed at before. The Pair name and its Journal
history are unaffected by `--replace` — only what the name points at changes.

- Real binary: `vibesync pair add <pair> --source <PATH> --destination <PATH> --mode <mirror|update> --replace`
- Development fallback: `cargo run --locked -- pair add <pair> --source <PATH> --destination <PATH> --mode <mirror|update> --replace`

This is the one case the Add a Folder pair section above places out of its own scope. Do not re-derive
Sync-mode wording or volume-UUID pinning here; refer to that section for what those mean, and use this one
only for what changes when `--replace` is set.

### `pair remove` — deleting a pair

Report the Pair name being removed, and that afterward the human will no longer be able to run `status` or
`history` against that name. What the command itself deletes is narrower than it sounds: it removes only the
pair's entry from the config, and never touches the Journal on disk. But the status and history commands
above both resolve a Pair name through the config before they will read its Journal, and a removed name no
longer resolves — so that Journal history becomes unreachable through this product from that point on, even
though the underlying records are not the thing the command deleted. Report it that way, not as "the history
is deleted."

- Real binary: `vibesync pair remove <pair>`
- Development fallback: `cargo run --locked -- pair remove <pair>`

Do not tell the human `_SafetyNet/` can recover a removed pair or its Journal history. SafetyNet archives
destination *objects* that a Run replaces or removes (ADR-0001); it has no relationship to the pair config or
the Journal, and nothing in either of this section's mutations writes to it.

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

