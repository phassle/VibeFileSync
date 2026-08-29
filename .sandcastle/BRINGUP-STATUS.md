# Sandcastle bring-up status

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
- [ ] 6. `.sandcastle/.env` filled by Per; `git status --porcelain .sandcastle/.env` empty
      Note: BLOCKED on Per. .sandcastle/.env created from .env.example but both token values are still empty. `git status --porcelain .sandcastle/.env` is empty, so the ignore rule works.
- [ ] 7. `Sandcastle` label exists; Per picked the first issue
      Note: BLOCKED on Per. Label already existed (colour #F9A825, desc 'Issues for Sandcastle to work on') - left as is, did not recreate. ZERO open issues carry it. See note below: the backlog has no small ticket.
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
  Per has chosen to have a new small Rust-scoped ticket drafted for his approval
  rather than force one of the three; that is in progress.
- The CARGO_TARGET_DIR question is still open here too - ~/.cache/vibesync-sandcastle
  does not exist yet because no pipeline has run. Will check it right after the
  first watched run and report back.

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
- Remaining unknown at runtime: whether `noSandbox`'s `env` is actually
  forwarded into the agent's shell, i.e. whether `CARGO_TARGET_DIR` takes
  effect. Cheap check on the server once a pipeline has run:
  `ls ~/.cache/vibesync-sandcastle/` should contain a dir per branch. If it
  is empty while builds are happening, the env is not being passed and
  concurrent pipelines are sharing one cargo lock — say so here.
