# TUI review is a two-sided action table, superseding ADR-0003's dual-pane rejection

Decided by reacting to a terminal prototype (branch [`prototype/commander-panes`](https://github.com/phassle/VibeFileSync/tree/prototype/commander-panes)) showing four review layouts and four volume/first-use states on the same fake Mirror plan.

[ADR-0003](0003-dryrun-diff-and-review.md) §3 chose an action list and rejected "the FreeFileSync-style dual-pane" because "the action is the unit of review, not the source/destination correspondence". That reasoning survives; its conclusion does not. The two are not in tension once a row is both at once.

1. **The reviewed row is the action, and it is two-sided.** One table, one row per planned action, with columns: include mark, operation name, source cell, direction glyph, destination cell, and reason. Ticking a row still consents to an operation — ADR-0003 §3's actual argument — while the row also shows the source/destination correspondence the parent Idea asks a Commander-style interface for.
2. **Unchanged rows are hidden by default**, with a count in the table title and a key to reveal them. Review should show what will happen; the unchanged majority is context, available on request. This is what makes a two-sided table as dense to review as a pure action list.
3. **One table, not two panes.** The literal dual-pane layout (two independently bordered, independently scrolling lists with an operation gutter) was rejected: it requires two scroll positions to stay correlated for the correspondence to mean anything, and every copy or delete leaves one side as an em dash, so half the pixels carry no information. A single table has one scroll position by construction.
4. **The two-pane browsing surface stays**, for choosing a source and destination and managing Folder pairs. Panes are the *configuration* surface; the table is the *review* surface. Both live in the same TUI.
5. **Every ADR-0003 safety contract is unchanged.** Review-first with no path to mutation without confirmation or `--yes`; exclusions are per-run and never persisted; an included error row blocks the run until excluded or fixed at the source; the TUI still lands on a confirm screen with recomputed totals before executing.

## Consequences

- ADR-0003 §3 is superseded. ADR-0003 §1 (human CLI diff grouped by operation), §2 (NDJSON plan stream), §4 (review-first everywhere), and §5 (errors block the run) all stand unchanged.
- The two-sided row is presentation derived from the plan the engine already produces — the TUI gains no diff logic of its own.
- Wide rows truncate on narrow terminals. Column priority and reflow were settled afterwards by [Decide keyboard, focus, and terminal behavior](https://github.com/phassle/VibeFileSync/issues/43): columns drop by priority — include mark, operation, source, destination, reason — and below 80 columns the two-sided table degrades into a single-path action list rather than scrolling sideways. No width may hide which side an action affects.

Decided on the wayfinder ticket [Prototype the Commander-style Folder pair and diff workflow](https://github.com/phassle/VibeFileSync/issues/41).
