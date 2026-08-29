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

- [ ] 1. Toolchain verified (`node -v`, `npm -v`, `git`, `cargo`, `gh`, `claude`)
      Note:
- [ ] 2. Repo cloned/updated, on `chore/sandcastle-host-macos`
      Note:
- [ ] 3. `npm install` + `npm run sandcastle:typecheck` clean
      Note:
- [ ] 4. **`cargo test` green** (this is the verification the laptop could not run)
      Note:
- [ ] 5. **`cargo test --features fault-injection --test acceptance` green**
      Note:
- [ ] 6. `.sandcastle/.env` filled by Per; `git status --porcelain .sandcastle/.env` empty
      Note:
- [ ] 7. `Sandcastle` label exists; Per picked the first issue
      Note:
- [ ] 8. First watched run done (MAX_ITERATIONS=1, CONCURRENCY=1, PERMISSION_MODE=auto)
      Note:
- [ ] 9. Branch + `RALPH:` commits confirmed present
      Note:

Blocked on Per (do not proceed alone): steps 6 and 7, and the go-ahead before
any unattended run. Never enter tokens or credentials yourself.

## Notes from ai-server session

(append here — what broke, what you changed, what you need)

## Notes from laptop session

- Branch prepared and pushed as commit `9189923`. `npm run sandcastle:typecheck`
  verified clean here. No Rust toolchain on the laptop, so steps 4 and 5 are
  genuinely unverified — treat a failure there as a real finding, not as
  something the laptop already knew about.
- If cargo is red: do not start the agent loop. Diagnose, fix by hand on this
  branch, push, and note it above. A loop started from a red build burns its
  iterations on the pre-existing bug.
- If `main.mts` misbehaves at runtime, the likely spots are the `noSandbox`
  import path (`@ai-hero/sandcastle/sandboxes/no-sandbox`) and the
  `onSandboxReady` hook running `cargo fetch --locked`.
