# Handover: bring up Sandcastle for VibeFileSync on ai-server

Paste this into a Claude Code session on ai-server. There is a peer Claude
session running on Per's laptop that prepared everything; you coordinate with
it via git on the branch `chore/sandcastle-host-macos` in
`https://github.com/phassle/VibeFileSync`. Everything you need is below — no
prior session to ask, but if something on the branch looks wrong, commit a fix
to that same branch and push; the laptop session watches it.

## What is already done (do not redo)

The branch `chore/sandcastle-host-macos` is pushed to origin. It contains one
commit (`9189923`, "Adapt Sandcastle config for macOS host runs") that makes
`.sandcastle/` runnable on a macOS host:

- `.sandcastle/main.mts` uses Sandcastle's `noSandbox` provider (the Docker
  sandbox cannot work: `src/run.rs` links macOS libSystem — `copyfile(3)`,
  `F_FULLFSYNC` — so nothing compiles in a Linux container). Isolation is a
  git worktree per issue. It caps concurrency (default 2), gives each branch
  its own `CARGO_TARGET_DIR` under `~/.cache/vibesync-sandcastle`, and passes
  `TARGET_BRANCH` to the prompts (review-prompt referenced it but it was
  never passed before).
- The three prompt files use the four cargo commands as the feedback loop:
  `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features
  -- -D warnings`, `cargo test`, and
  `cargo test --features fault-injection --test acceptance` (the acceptance
  suite does not compile without the feature flag).
- `package.json` has `npm run sandcastle` and `npm run sandcastle:typecheck`;
  `.sandcastle/tsconfig.json` is new. `npm run sandcastle:typecheck` was
  verified clean on the laptop.
- **Not yet verified anywhere: the cargo commands themselves.** The laptop has
  no Rust toolchain. Verifying the Rust side green is YOUR first job.

Do NOT apply any patch file — older instructions mention
`sandcastle-macos-host.patch`; it is already merged into the branch.

## Your tasks

Work through these in order. Tags: `[RUN]` = do it yourself, `[MANUAL]` = stop
and ask Per (tokens, logins — never enter credentials yourself), `[VERIFY]` =
do not continue until the expected result appears.

### 1. `[VERIFY]` Toolchain

```bash
node -v && npm -v && git --version && cargo --version && gh --version && claude --version
```

Expected: Node 22+, working cargo, gh, claude. If something is missing,
install it (`brew install node git gh`, rustup via
`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`,
claude via `curl -fsSL https://claude.ai/install.sh | bash`). If `gh auth
status` or `claude` are not logged in, that is `[MANUAL]` — ask Per.

### 2. `[RUN]` Get the repo on the branch

```bash
mkdir -p ~/code && cd ~/code
test -d VibeFileSync || git clone https://github.com/phassle/VibeFileSync.git
cd VibeFileSync
git fetch origin
git checkout chore/sandcastle-host-macos && git pull
```

Keep this checkout dedicated to the loop. Do not hand-edit it while the loop
runs.

### 3. `[VERIFY]` JS side

```bash
npm install
npm run sandcastle:typecheck && echo "SANDCASTLE CONFIG OK"
```

### 4. `[VERIFY]` Rust side is green BEFORE any agent touches it

```bash
cargo test
cargo test --features fault-injection --test acceptance
```

This is the verification the laptop could not run. If it is red, diagnose and
fix by hand first — commit the fix to `chore/sandcastle-host-macos` and push
so the laptop session sees it. An agent loop started from a red build spends
its iterations on the bug, not the ticket.

### 5. `[MANUAL]` Tokens — stop and hand this to Per

```bash
cp .sandcastle/.env.example .sandcastle/.env
claude setup-token          # Per runs this and pastes the token
open -e .sandcastle/.env    # Per pastes CLAUDE_CODE_OAUTH_TOKEN and GH_TOKEN
```

- `CLAUDE_CODE_OAUTH_TOKEN`: from `claude setup-token` (subscription, not API
  billing).
- `GH_TOKEN`: fine-grained PAT scoped to `phassle/VibeFileSync`, Issues
  read/write + Metadata read, from
  <https://github.com/settings/personal-access-tokens/new>.

Never create, read out, or paste these values yourself. Then `[VERIFY]`:

```bash
git status --porcelain .sandcastle/.env
```

Expected: no output (`.sandcastle/.gitignore` already excludes it).

### 6. `[RUN]` Ticket queue

The planner only sees open issues labelled `Sandcastle`
(`.sandcastle/plan-prompt.md`, do not change the filter).

```bash
gh label list | grep -i sandcastle || gh label create Sandcastle \
  --description "Queued for the Sandcastle agent loop" --color 0E8A16
gh issue list --state open --label Sandcastle
```

Which issues get the label is Per's call — `[MANUAL]`, show him the open list
(`gh issue list --state open`) and let him pick. For the first run, exactly
one small issue.

### 7. `[VERIFY]` First run, watched — one issue, one cycle, gated permissions

```bash
SANDCASTLE_MAX_ITERATIONS=1 \
SANDCASTLE_CONCURRENCY=1 \
SANDCASTLE_PERMISSION_MODE=auto \
npm run sandcastle
```

Afterwards:

```bash
git branch --list 'sandcastle/*'
git log --oneline chore/sandcastle-host-macos..sandcastle/issue-<NUMBER>
```

Expected: a branch per planned issue with `RALPH:`-prefixed commits. Phase
logs land in `.sandcastle/logs/` — read the implementer log if a branch came
back empty. Report the outcome to Per before going unattended.

### 8. The real run, detached (only after 7 looks good and Per says go)

Inside a `herdr` session:

```bash
cd ~/code/VibeFileSync
npm run sandcastle
```

Note the merger merges into whatever branch the run starts from — right now
that is `chore/sandcastle-host-macos`, which doubles as the integration
branch until a few cycles have been reviewed. Per reviews merge commits like
a junior's PR before anything moves toward `develop`.

## Knobs (env, all optional)

| Variable | Default | Effect |
| --- | --- | --- |
| `SANDCASTLE_MAX_ITERATIONS` | 10 | plan/execute/merge cycles |
| `SANDCASTLE_CONCURRENCY` | 2 | pipelines in flight (each a full cargo build) |
| `SANDCASTLE_MODEL` | `opus` | model alias for Claude Code |
| `SANDCASTLE_PERMISSION_MODE` | `bypassPermissions` | `auto` = per-tool approval |
| `SANDCASTLE_TARGET_CACHE` | `~/.cache/vibesync-sandcastle` | per-branch cargo target dirs |

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Planner exits with empty plan | No open issue has the `Sandcastle` label, or `gh` not authenticated. |
| `StructuredOutputError` from planner | Bad `<plan>` JSON; read `.sandcastle/logs/`, usually a `gh` failure inside the prompt's shell expansion. |
| Agent stalls silently | Permission prompt: mode is `default`/`acceptEdits`, or `.env` did not load. |
| `linking with cc failed` / `copyfile` undefined | Build is running on Linux somehow; confirm `main.mts` imports `no-sandbox`. |
| Acceptance tests fail to compile | Missing `--features fault-injection`. |
| Pipelines crawl | CPU-bound cargo builds; lower `SANDCASTLE_CONCURRENCY`. |
| Leftover worktree after a crash | `git worktree list`, then `git worktree remove .sandcastle/worktrees/<name>`. |
| Merger closed an issue that is not done | Remove label, reopen, sharpen the ticket. |

## Coordination protocol with the laptop session

- Shared channel: the branch `chore/sandcastle-host-macos` on origin.
- If you change anything (a fix from step 4, config tweaks), commit and push
  to that branch with a clear message. Pull before you start work.
- Do not force-push, do not rebase the branch, do not touch `develop`.
- `.sandcastle/.env` stays untracked, always.

## Out of scope

- `.sandcastle/CODING_STANDARDS.md` is still TypeScript-flavoured; a later
  pass, not now.
- Model pinning: the alias `opus` is deliberate.
- Local LM Studio models: not part of this bring-up.
