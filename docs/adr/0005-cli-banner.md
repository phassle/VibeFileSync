# The startup banner is the mark + wordmark (B4), static, on stderr, and only on no-command surfaces

Decided by reacting to a terminal prototype (branch [`prototype/cli-banner`](https://github.com/phassle/VibeFileSync/tree/prototype/cli-banner)) showing four banner variants and a trigger-surface proposal.

1. **Variant: mark + wordmark.** A three-line banner — the ◢█◣/◥█◤ block mark with a truecolor vaporwave gradient (cyan → purple → pink), letter-spaced `V I B E S Y N C` wordmark, and the dim tagline `one-way file sync with SafetyNet · plan → review → run`. The full ANSI-shadow logo, boxed splash, and bare one-liner were rejected. The mark is intended to double as an app-icon shape later.
2. **Static — no animation.** The shimmer sweep was dropped entirely; the banner never redraws.
3. **Trigger surface: no-command invocations only.** The banner renders on bare `vibesync`, `--help`, and `tui` startup. Working verbs (`plan`, `run`, `status`, `history`, `prune`, `pair …`) never print it — their first output line is always content, leaving the ADR-0003/0004 output contracts untouched.
4. **Stream and suppression: stderr, TTY-only.** The banner prints to stderr and only when stderr is a TTY, so it can never corrupt parseable stdout even if the trigger rule were misapplied. `NO_COLOR` drops it to a plain-text one-liner; `VIBESYNC_NO_BANNER=1` suppresses it entirely. No `--quiet` flag in v1 — the TTY check covers scripts.

## Consequences

- The banner needs truecolor; under `NO_COLOR` or a non-truecolor terminal it degrades to the plain wordmark line, so no capability detection beyond `NO_COLOR` and TTY-ness is required in v1.
- The TUI reuses the same three lines as its startup header — no separate splash asset.

Decided on the wayfinder ticket [Prototype the CLI banner (VIBESYNC ASCII logo on startup)](https://github.com/phassle/VibeFileSync/issues/12).
