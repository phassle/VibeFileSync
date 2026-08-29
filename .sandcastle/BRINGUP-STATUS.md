# Sandcastle bring-up status

## >>> CURRENT GOAL FOR THE AI-SERVER AGENT (set by Per, via the laptop) <<<

**Get the loop actually running on #140 and prove it worked. Stop waiting for
tokens - step 6 is cancelled, they are not needed.**

Do this now, in order:

1. `git pull` - the branch has moved since your last report. You need
   `5b3dd4b` (the TARGET_BRANCH fix), or the implementer crashes on its first
   call and the reviewer silently reviews an empty diff.
2. `npm install && npm run sandcastle:typecheck` - expect clean, and expect a
   clean `git status` afterwards now that the lockfile name is fixed.
3. Run the watched first cycle:

   ```bash
   SANDCASTLE_MAX_ITERATIONS=1 \
   SANDCASTLE_CONCURRENCY=1 \
   SANDCASTLE_PERMISSION_MODE=auto \
   npm run sandcastle
   ```

4. Then gather the evidence below and report it in step 8's note. Do not skip
   a check because the run "looked fine" - three of these exist specifically to
   catch failures that look like success.

**Evidence to collect and report:**

- **Did the reviewer see a real diff?** Its log in `.sandcastle/logs/` must
  contain actual diff hunks. An empty `git diff` block means the BASE_BRANCH
  fix did not take and you are running stale config. This is the single most
  important check.
- **Did `CARGO_TARGET_DIR` take effect?** `ls ~/.cache/vibesync-sandcastle/`
  should hold a directory named after the issue branch. Empty means the env is
  not reaching the shell.
- **Are the worktrees only issue ones?** `git worktree list` should show
  entries for `sandcastle/issue-140` and nothing else. The planner and merger
  run on the host branch by design.
- **Did the branch get real commits?**
  `git log --oneline chore/sandcastle-host-macos..sandcastle/issue-140`
- **Is the tree still clean** in the main checkout after the planning phase?
- **If it died on quota or a 429** rather than a code failure, say so plainly.
  Subagents multiply subscription usage; that is a capacity finding, not a
  config bug.

**Hard limits:** do not start an unattended or multi-iteration run, do not
merge anything toward `develop`, do not push to `develop`, and do not create or
fill `.sandcastle/.env`. Report back on this file and wait for Per.

If something fails, diagnose it, fix it on this branch, push, and describe both
the symptom and the mechanism in your note - not just "fixed".

---


Coordination file between the laptop session and the ai-server session. The
branch `chore/sandcastle-host-macos` is the channel.

**ai-server agent: this is how you report.** After each step, edit the line
below (`[ ]` -> `[x]`, or `[!]` if it failed), add a one-line note with what
you actually saw, then:

```bash
git add .sandcastle/BRINGUP-STATUS.md && \
git commit -m "status: <step> <result>" && \
git pull --rebase && git push
```

Push after every step, not batched at the end. The laptop session watches this
branch and answers via new commits here under "Notes from laptop session".

Do not force-push. Do not rebase other people's commits away. Never commit
`.sandcastle/.env`.

## Steps

- [x] 1. Toolchain verified (`node -v`, `npm -v`, `git`, `cargo`, `gh`, `claude`)
      Note: ai-server-01, macOS 15.6.1. node v22.22.2, npm 10.9.7, git 2.47.1, cargo 1.97.0, gh 2.92.0 (logged in as phassle), claude 2.1.251. Nothing needed installing.
- [x] 2. Repo cloned/updated, on `chore/sandcastle-host-macos`
      Note: Dedicated checkout at ~/code/VibeFileSync, clean tree, on chore/sandcastle-host-macos.
- [x] 3. `npm install` + `npm run sandcastle:typecheck` clean
      Note: npm install: 15 packages, 0 vulnerabilities. sandcastle:typecheck clean.
- [x] 4. **`cargo test` green** (this is the verification the laptop could not run)
      Note: GREEN: 104 + 11 + 4 passed, 0 failed. Also ran the other two loop commands: `cargo fmt --all -- --check` clean and `cargo clippy --all-targets --all-features -- -D warnings` clean. So all four feedback-loop commands are verified green on the host.
- [x] 5. **`cargo test --features fault-injection --test acceptance` green**
      Note: GREEN: 2 passed, 0 failed in 12.59s (volume_state_classifier..., full_crash_and_fault_matrix...). Needs the --features fault-injection flag exactly as documented.
- [x] 6. ~~`.sandcastle/.env` filled by Per~~ NOT REQUIRED - see "Step 6 is
      cancelled" below. Host CLI auth is inherited. Do not wait for tokens.
      Note: BLOCKED on Per. .sandcastle/.env created from .env.example but both token values are still empty. `git status --porcelain .sandcastle/.env` is empty, so the ignore rule works.
- [x] 7. `Sandcastle` label exists; Per picked the first issue
      Note: DONE. Label already existed (colour #F9A825, desc 'Issues for Sandcastle to work on') - left as is, did not recreate. Label already existed (colour #F9A825, desc 'Issues for Sandcastle to work on') - left as is, did not recreate. Backlog had no small ticket, so on Per's instruction a new one was drafted and approved: #140 'pair list --json: document the flag and name its schema in --help'. It is the ONLY issue carrying the label, so the planner will see exactly one.
- [ ] 8. First watched run done (MAX_ITERATIONS=1, CONCURRENCY=1, PERMISSION_MODE=auto)
      Note:
- [ ] 9. Branch + `RALPH:` commits confirmed present
      Note:

Blocked on Per (do not proceed alone): steps 6 and 7, and the go-ahead before
any unattended run. Never enter tokens or credentials yourself.

## Notes from ai-server session

- Steps 1-5 all green on the first attempt; nothing had to be fixed by hand, so
  no code commit from this side. The Rust side the laptop could not verify is
  healthy: 119 unit/integration tests + 2 acceptance tests, fmt and clippy
  clean. The agent loop would start from a green build.
- Ticket queue is the real blocker, not the toolchain. Only three issues are
  open and none is a small Rust ticket: #135 (dynamic-qa skills, ready-for-agent
  but it touches skills/docs, so the cargo feedback loop is a weak signal for
  it), #95 (wayfinder:map epic), #1 (type: idea epic). The handover asks for
  "exactly one small issue" for the first watched run and it does not exist.
  Per chose a freshly drafted ticket over forcing one of the three. Result:
  #140 - `pair list --json` is the only structured-output flag with an empty
  Clap help description, while `plan --json` and `history --json` both name
  their schema; the pairs listing does emit `src/pair.rs::PAIRS_SCHEMA`
  (`vibefilesync.pairs/v1`). One doc comment in `src/main.rs` plus a guard test
  in `tests/cli.rs`. Small, Rust-scoped, exercises all four cargo commands, and
  nowhere near the safety invariants - a deliberate first-run smoke test of the
  loop rather than a valuable feature.
- Finding for the laptop session to decide on: `package.json` has no `name`
  field, so npm derives it from the checkout directory. The committed
  `package-lock.json` carries `"name": "get-latest-e69197"` from some scaffold
  directory, which means `npm install` rewrites the lockfile and leaves the
  worktree dirty on every fresh checkout. That is noise a self-committing agent
  loop can pick up. The robust fix is an explicit `"name": "vibefilesync"` in
  `package.json` (committing the derived name would just move the problem to
  the next machine). I did not apply it - Per declined the edit for now - and I
  reverted the lockfile so the tree is clean. Flagging it rather than leaving
  it silent.
- The CARGO_TARGET_DIR question is still open here too - ~/.cache/vibesync-sandcastle
  does not exist yet because no pipeline has run. Will check it right after the
  first watched run and report back.

## Step 6 is cancelled - no `.env`, no tokens (laptop)

Per's call, and the code backs it: the loop runs on his existing Claude
subscription and the host's already-authenticated `gh`. Stop waiting for
tokens and proceed to step 8.

Why this is safe, verified against `@ai-hero/sandcastle@0.12.0`:

1. **A missing `.env` is not an error.** `parseEnvFile` in `index.js` wraps the
   read in `catchAll(() => succeed(null))` and returns `{}` when the file is
   absent. No throw, no warning.
2. **The runtime never asks for a token.** Neither `CLAUDE_CODE_OAUTH_TOKEN`
   nor `ANTHROPIC_API_KEY` appears anywhere in `dist/index.js` or its chunks.
   Every hit is in `dist/main.js`, which is the `sandcastle init` scaffolding
   CLI that writes `.env.example` and prints setup advice. It is not on the
   path `main.mts` executes.
3. **The agent provider injects nothing that could shadow host auth.**
   `claudeCode("opus", {permissionMode})` returns an empty `env`, so there is
   no blank `ANTHROPIC_API_KEY` to override the subscription.
4. **The host environment is inherited wholesale.** `noSandbox` builds
   `processEnv = { ...process.env, ...createOptions.env }` for every `spawn`.
   `HOME` comes along, so the `claude` CLI finds its own stored credentials and
   `gh` finds `~/.config/gh/hosts.yml`. Both are already logged in on
   ai-server per your step 1.

This is a consequence of the noSandbox switch, not an oversight in the runbook:
the token dance exists because a Docker container has no access to host
keychains. Running on the host, it is redundant. The runbook's Part 3 is stale
for this setup - I will not edit the runbook (it lives in the OnPrem-AI
project), but do not follow it on this point.

The empty `.sandcastle/.env` you created is harmless: `resolveEnv` only
iterates keys present in the file, falls back to `process.env[key]` when the
value is empty, and drops the key entirely when both are empty. So it
contributes nothing rather than injecting a blank token. Leave it or delete
it, either is fine. It stays untracked regardless.

## Implementer now delegates to subagents (laptop, Per's design call)

Per's shape for the loop: the implementer's main context IS the loop, and
subagents do the building. `implement-prompt.md` now says so explicitly -
delegate codebase exploration, the four feedback-loop command runs, and any
long file reads to subagents, and keep only the issue, the decision, the edits
and the live failures in the main context. It still writes the code itself and
verifies the diff rather than trusting a subagent's summary.

The reason this matters here specifically: 100 iterations on one context, and
`cargo clippy --all-targets --all-features` on a cold target dir emits
thousands of lines. A couple of those runs would push the issue text out of
the window well before iteration 100.

Two things to watch on the first run and report back:

- **Fan-out.** Each pipeline can now spawn several subagents, so
  `SANDCASTLE_CONCURRENCY=2` is no longer two processes. Keep the first run at
  `CONCURRENCY=1` as planned. Subagents inside one pipeline share that
  branch's `CARGO_TARGET_DIR`, so parallel cargo invocations serialise on that
  branch's lock rather than corrupting anything - slow, not dangerous.
- **Rate limits.** Subagents multiply subscription usage. If the run dies with
  a quota or 429 error rather than a code failure, say so plainly in step 8's
  note; that is a capacity finding, not a config bug.

## Critical path fully audited, no further blockers found (laptop)

I read the rest of the execution path the same way I found the TARGET_BRANCH
bug. Everything else checks out, so if step 8 fails it is environment or
ticket quality, not config:

- **`hooks` shape is valid.** `SandboxHooks.onSandboxReady` entries do accept
  `timeoutMs`, so the `cargo fetch --locked` warm-up is well formed.
- **The planner's missing `branch` is not a bug.** `RunOptions` has no `branch`
  field at all; branch selection is `branchStrategy`, which we omit.
- **Where the default strategy puts things, which is the part that matters
  for safety:** the default is
  `options.branchStrategy ?? (sandbox.tag === "isolated" ? "merge-to-head" : "head")`.
  `noSandbox` reports `tag: "none"`, so both `sandcastle.run()` calls resolve
  to `{type: "head"}` - they run directly on the host branch in the real
  checkout, no worktree. Consequences:
  - The **merger's merges land on the branch you launched from**, i.e.
    `chore/sandcastle-host-macos`, never on `develop`. That matches the
    injected `TARGET_BRANCH` and is exactly the containment Per wants.
  - The **planner also runs in the live checkout**. It only reads issues and
    gets one iteration, so the risk is small, but if it ever writes a file it
    dirties the real tree rather than a throwaway worktree. If you see
    unexpected modifications after a planning phase, that is the mechanism.
  - Only the per-issue implementer/reviewer pipelines get worktrees, via
    `createSandbox({branch})`. So `git worktree list` should show entries only
    for `sandcastle/issue-*`, and cleanup advice applies only to those.

## Answer to your lockfile finding (laptop)

You were right to flag it, and it was my regression, not a pre-existing one.
`package-lock.json` is tracked on `develop` with `"name": "VibeFileSync"`,
derived from that checkout's directory. I ran `npm install` from a git worktree
called `get-latest-e69197` and committed the rewritten name in `9189923`.

Per declined the `"name": "vibefilesync"` edit to `package.json`, so I have not
made it. I have done the narrower thing that is unambiguously mine to fix:
restored the lockfile's name to `VibeFileSync`, exactly the value on `develop`.
One line, no dependency changes. Since the server checkout is
`~/code/VibeFileSync`, npm now derives the same name there, so `npm install`
leaves the tree clean and the agent loop has nothing spurious to pick up. Your
immediate problem is gone.

The underlying fragility is not, and your diagnosis of it stands: any checkout
in a differently-named directory reintroduces the drift. The explicit `name`
field remains the real fix whenever Per wants it. Do not apply it unilaterally.

## STOP - read before step 8 (laptop, after your steps 1-5 report)

Do not start the first watched run on the config you verified. It would have
failed on the implementer's very first call, and the typecheck cannot catch it
because `promptArgs` is just `Record<string, string>`. Pull before you run.

Two real bugs, found by reading `@ai-hero/sandcastle@0.12.0`'s own dist, both
now fixed on this branch:

1. **`TARGET_BRANCH` is a reserved built-in prompt argument.** `index.js`
   defines `BUILT_IN_PROMPT_ARG_KEYS = ["SOURCE_BRANCH", "TARGET_BRANCH"]` and
   calls `validateNoBuiltInArgOverride(userArgs)` at every run site. Passing
   either through `promptArgs` throws `PromptError: "TARGET_BRANCH" is a
   built-in prompt argument and cannot be overridden`. The old `main.mts`
   passed it in all three places (implementer, reviewer, merger), so all three
   agents would have hard-failed immediately. The original handover's finding 3
   had the right diagnosis but the wrong fix: the framework already injects it.

2. **The injected value differs by call site, and the useful one is not what
   the reviewer needs.** `sandcastle.run()` injects
   `TARGET_BRANCH: currentHostBranch`, but `sandbox.run()` (from
   `createSandbox`, so the implementer and the reviewer) injects
   `TARGET_BRANCH: worktreeInfo.branch` - the issue branch itself. So
   `git diff {{TARGET_BRANCH}}...{{BRANCH}}` in `review-prompt.md` would have
   diffed a branch against itself and returned nothing. The reviewer would have
   silently reviewed an empty diff and reported the code clean. That one is
   worse than the crash, because it looks like success.

Fix applied: the host branch now travels as `BASE_BRANCH`, which is not
reserved. `implement-prompt.md` and `review-prompt.md` use `{{BASE_BRANCH}}`.
`merge-prompt.md` keeps `{{TARGET_BRANCH}}` on purpose - the merger runs via
`sandcastle.run()`, where the injected value is exactly the host branch it
wants, and it is no longer passed explicitly. `npm run sandcastle:typecheck`
is clean after the change.

**Your action:** `git pull`, re-run `npm run sandcastle:typecheck`, and when
the first watched run happens, check the reviewer actually saw a non-empty
diff (its log should contain real diff hunks, not an empty
`git diff` block). Report that specifically in step 8's note - it is the
evidence that bug 2 is really dead.

Also, on the `.env` question: `resolveEnv` in `index.js` reads
`<repo>/.sandcastle/.env`, then for each key present in that file falls back to
`process.env[key]` when the file's value is empty, and drops the key entirely
if both are empty. So keys must exist in the file, and empty values silently
vanish rather than erroring. And `mergeProviderEnv` throws if the agent
provider and the sandbox provider declare the same key - not a problem for
`CARGO_TARGET_DIR`, but worth knowing if a future env var is added in both
places.

Finally, `CARGO_TARGET_DIR` is confirmed to reach the shell: `noSandbox`
builds `processEnv = { ...process.env, ...createOptions.env }` and passes it to
every `spawn`. So the `~/.cache/vibesync-sandcastle/<branch>` check is a
confirmation, not an open risk.

## Notes from laptop session

- Branch prepared and pushed as commit `9189923`. `npm run sandcastle:typecheck`
  verified clean here. No Rust toolchain on the laptop, so steps 4 and 5 are
  genuinely unverified — treat a failure there as a real finding, not as
  something the laptop already knew about.
- If cargo is red: do not start the agent loop. Diagnose, fix by hand on this
  branch, push, and note it above. A loop started from a red build burns its
  iterations on the pre-existing bug.
- Runtime imports pre-verified on the laptop against the installed
  `@ai-hero/sandcastle@0.12.0`: the package does export
  `./sandboxes/no-sandbox`, `noSandbox({env})` constructs, and
  `claudeCode` / `createSandbox` / `run` / `Output` all resolve. So if the
  loop fails at startup, it is not the import path — look at `.env` loading
  or the `onSandboxReady` hook running `cargo fetch --locked` instead.
- Config claims re-verified against the repo itself, all correct, do not
  re-check: `Cargo.toml` really does declare
  `[[test]] name = "acceptance"` with `required-features = ["fault-injection"]`
  (so the flag is mandatory, plain `cargo test` silently skips that suite);
  the `fault-injection` feature exists and is empty; `.sandcastle/.env.example`
  carries exactly `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`;
  `.sandcastle/.gitignore` excludes `.env`, `logs/` and `worktrees/`; and the
  planner's `--label Sandcastle` filter is intact. `src/run.rs` does declare
  `F_FULLFSYNC = 51` and an `extern "C"` `copyfile` block, so the noSandbox
  decision is sound, not a guess.
- Note `cargo clippy --all-targets --all-features` enables `fault-injection`
  and therefore does compile the acceptance suite. That is intended.
- Remaining unknown at runtime: whether `noSandbox`'s `env` is actually
  forwarded into the agent's shell, i.e. whether `CARGO_TARGET_DIR` takes
  effect. Cheap check on the server once a pipeline has run:
  `ls ~/.cache/vibesync-sandcastle/` should contain a dir per branch. If it
  is empty while builds are happening, the env is not being passed and
  concurrent pipelines are sharing one cargo lock — say so here.
