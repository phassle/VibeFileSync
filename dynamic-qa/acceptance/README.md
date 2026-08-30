# dynamic-qa acceptance harness

The verification gate for every `dynamic-qa` bundle ticket after this one
(ticket #142). Roughly 28 later tickets add cases here; this document is the
API contract they build against.

## Run it

```
dynamic-qa/acceptance/run.sh
```

One command, no arguments, no setup. Requires `bash` and, for Tier 1, a
`node` binary already on `PATH` — the same runtime every supported coding
harness (Claude Code, Codex, and the rest) already requires, so this adds no
new dependency to a customer's machine. No network access is required or
used by the default run.

## Two tiers

`dynamic-qa` is not "Markdown prompts that ask an agent to validate."
Anything that is pure computation — schema validation, canonicalization and
content digests, the drift gate, quarantine expiry, diagnostics scrubbing,
evidence-bundle parsing, threshold evaluation, capability-gate checks — is
real executable code in a **deterministic core**, because the spec requires
ordinary PR and nightly regression runs to call no LLM and no browser agent.
The acceptance harness mirrors that split with two tiers, and the rule for
choosing between them is:

> If you find yourself asserting on model behavior for something that is
> really just computation, extract the computation into the deterministic
> core and write a Tier 1 test instead. Tier 2 is reserved for what is
> genuinely agentic and stays as small as it can honestly be.

### Tier 1 — the deterministic core (`node --test dynamic-qa/shared/scripts`)

- Lives at `dynamic-qa/shared/scripts/` (see `PLACEHOLDER.md` there): plain
  JavaScript (ESM), Node built-in modules only, **no third-party
  dependencies, no build step, no `npm install`**. An empty supply chain is
  a security requirement here (attacker-controlled content must never
  combine with broad capability), not a style preference.
- One `<name>.mjs` implementation module per concern, one `<name>.test.mjs`
  alongside it using the built-in `node:test` / `node:assert` modules.
- No fixture repository, no `HOME`/XDG isolation, no model, no network — it
  runs in seconds and needs none of Tier 2's machinery.
- Where strict YAML parsing is needed, hand-write a restricted-subset parser
  that rejects aliases, custom tags, duplicate keys and executable
  expressions, rather than adding a YAML library. Same for JSON Schema
  validation: hand-written checks against this bundle's own schemas
  (`dynamic-qa/shared/schemas/`), not an added validator dependency.
- **This is where nearly all invalid-artifact and hostile-input assertions
  belong**: unknown fields, unsupported schema versions, duplicate YAML
  keys, aliases/tags, executable content, invalid IDs/revisions, secret
  values, stale digests, missing provenance, expired quarantine, malformed
  failure/result evidence, dependency-hook and cache-poisoning payloads,
  secret patterns, redirect/DNS-change payloads. All of these are "does this
  parser/validator reject this input", not "does the agent behave correctly"
  — write them as `node:test` cases against the deterministic core.
- `run.sh` runs `node --test dynamic-qa/shared/scripts` as-is. It reported "no
  test files yet" and exited cleanly before #143 landed the first core
  module (restricted-YAML parsing, Flow Definition schema validation,
  canonical digests); nothing about running the harness had to change when
  that happened, and nothing should for the next module either.
- `dynamic-qa/build.sh` copies `shared/scripts/**/*.mjs` (implementation
  modules only, not `*.test.mjs` or `fixtures/`) into each skill's installed
  tree and byte-diffs the two copies, the same way it already handled
  `shared/schemas` and `shared/references`.

A worked example proving the mechanism itself lives at
`dynamic-qa/acceptance/selftest/` — see that directory's own README for why
it is kept separate from the real core.

### Tier 2 — the fixture-repository behavioral harness (`cases/`)

Reserved for what is genuinely agentic or genuinely structural: elicitation
and the approval gates, generation, adoption, diagnosis, repair proposals,
and discoverability/packaging across supported coding harnesses. Every case
runs against its own **disposable fixture repository** — created, driven,
and destroyed per test (`lib/fixture.sh`), never reused across cases.

Structural isolation, enforced rather than assumed:

- `HOME` and every `XDG_*` variable point inside the fixture's own tempdir
  for the whole case — the same pattern `tests/cli.rs::Fixture` uses for
  VibeFileSync's own integration tests. No developer home directory is ever
  read or written.
- `curl`, `wget`, `ssh`, `scp`, `nc`, `ncat`, and `telnet` are shadowed by
  shims on the fixture's own `PATH` that fail loudly the moment they are
  invoked; `git` is shadowed to allow local/`file://` use but refuse
  anything that looks like a remote host. A case (or anything it invokes)
  that tries to reach a real production system, the public Internet, a
  third party, or an external volume fails the test, instead of merely
  violating an unenforced convention.
- Nothing is mounted from, or written to, any location outside the
  fixture's own tempdir; the fixture is `rm -rf`'d on exit via a trap, even
  on failure.

## What a case may and may not assert on

Good tests observe **public workflow behavior**:

- the explicit questions asked and the stop state reached,
- the patch emitted and the artifacts written (and that they validate
  against schema, once Tier 1 schema validators exist to check them
  against),
- the commands run and their results,
- **forbidden mutations** — things that must never happen, scoped to a
  fixture repository or install target and proven by snapshot diff, not by
  reading a claim in output.

Good tests must **not** assert on prompt wording, a skill's internal helper
structure, private parser steps, or agent reasoning. `lib/assertions.sh`'s
entire vocabulary is deliberately built only from things a real user would
see: files on disk, exit codes, captured logs, snapshot diffs. If an
assertion you want to write requires reading `SKILL.md` prose or a script's
internal function, that is a sign the thing you actually want to test
belongs in Tier 1 instead.

## The fixture/assertion API — add a case here

A case is one `dynamic-qa/acceptance/cases/<category>/<name>.case.sh` file,
discovered automatically by `run.sh` (no registration list to update). It
must define three functions:

```bash
case_describe="one-line summary of what this case proves"

case_setup() {
  # Populate $FIXTURE_REPO (the stand-in customer repository) here, e.g.:
  #   mkdir -p "$FIXTURE_REPO/.dynamic-qa/flows"
  #   printf '...' > "$FIXTURE_REPO/.dynamic-qa/flows/checkout.yaml"
  # Script approvals here too, if the case needs them from the start:
  #   approval_grant qa-owner
  #   approval_withhold technical-owner
  :
}

case_run() {
  # Drive the harness. Prefer the replay adapter for determinism:
  #   transcript_play "$CASE_DIR/my-case.transcript"
  # Real invocation is available but opt-in and never silently substituted:
  #   harness_real_invoke claude-code qa-setup ""
  :
}

case_assert() {
  # Observe external behavior only. Every assert_* helper calls case_fail on
  # violation and keeps checking, so one run reports every problem it finds.
  assert_stop_state "$(transcript_log_path)" "some-expected-reason"
  assert_tree_unchanged "$FIXTURE_REPO" "$BEFORE_SNAPSHOT"
}
```

`run.sh` gives every case, inside its own disposable fixture and its own
subshell:

| Available to a case | What it is |
| --- | --- |
| `$FIXTURE_ROOT`, `$FIXTURE_REPO`, `$FIXTURE_HOME`, `$FIXTURE_LOG`, `$CASE_DIR` | fixture and case directories (see `lib/fixture.sh`) |
| `fixture_snapshot <dir>` | sorted path+hash listing, for before/after diffs |
| `transcript_play <file>`, `transcript_log_path` | the replay adapter (`lib/transcript.sh`) |
| `harness_real_invoke <harness> <skill> <args>`, `harness_real_available` | the opt-in real adapter (`lib/harness_real.sh`) |
| `approval_grant`/`approval_withhold`/`approval_decision`/`approval_both_satisfied` | scripted QA/Technical Owner approvals (`lib/approvals.sh`) |
| `env_absence_run_scrubbed`, `assert_no_credential_leak` (complete), `assert_no_forbidden_process_name_observed` (best-effort sample, not a complete audit — see `lib/env_absence.sh`) | CI-clean verification (`lib/env_absence.sh`) |
| `assert_*` (see `lib/assertions.sh`) | the full assertion vocabulary; `case_fail <message>` underlies all of them |

See `cases/transcript/example-stop-state.case.sh` for the smallest complete
worked example (question asked, scripted answer, stop state, forbidden
mutation check). See `cases/structural/cross-harness-smoke.case.sh` for a
real-installation-backed example (no replay at all — install.sh is invoked
for real).

Adding one of the fixture categories the parent spec names for later
tickets — brownfield/greenfield setup fixtures, hostile fixtures (prompt
injection, malicious branch/test names, dependency hooks, artifact/cache
poisoning, privilege escalation, scrub failure), or failure fixtures
(Failure Owner × Repeatability combinations) — is the same three-function
shape: a new subdirectory under `cases/`, a `case_setup` that plants the
adversarial or edge-case content in `$FIXTURE_REPO`, a `case_run` that plays
a transcript or invokes the real adapter, and a `case_assert` that checks
the external outcome (the injection was not treated as an instruction, the
malicious name did not reach a privileged path, the scrub actually ran).
Most of the *parsing/validation* half of those categories belongs in Tier 1
instead — see the rule at the top of this document.

## Genuinely exercised vs simulated

- **Genuinely exercised, every run**: `install.sh`/`build.sh` (real scripts,
  real files, real byte-diffs) via `cases/structural/cross-harness-smoke`;
  the environment-scrubbing mechanism via `cases/ci-clean`; the approvals
  primitive via `cases/approvals`; the Tier 1 `node --test` mechanism via
  `selftest/`; and, once later tickets land core modules, the deterministic
  core itself.
- **Simulated by design, labeled `mode=SIMULATED` in its own log**: every
  `transcript_play` run. It stands in for driving a real LLM-backed skill
  through a real coding harness, which is slow and nondeterministic. A
  transcript never encodes a skill's prompt wording — only what a human
  driving the harness would see and do (questions, answers, commands,
  writes, stop state) — so it can never be satisfied by reading `SKILL.md`
  internals, but it also can never prove the real installed skill actually
  behaves this way. That proof is what the **real** adapter is for.
- **Real, but opt-in and never required**: `harness_real_invoke` shells out
  to an actual installed coding harness CLI (Claude Code today) against the
  fixture's own installed skills. It requires `DYNAMIC_QA_HARNESS=real` and
  a separate, explicit `DYNAMIC_QA_ALLOW_NETWORK=1` acknowledgment (network
  access and real model credentials are both required); a case that asks
  for it without both fails loudly rather than silently falling back to
  replay. No case in this ticket enables it by default, and no CI run
  should either, per the spec's "no LLM and no browser agent" requirement
  for ordinary runs.

A run's summary line always makes the split visible; a case is never free to
report a simulated pass as if it were a real one.

## `run.sh` internals worth knowing before editing it

- Tier 2 discovers cases with `find cases -name '*.case.sh' | sort`, fed
  through **process substitution**, not a `| while` pipe — a piped `while`
  runs in a subshell in bash and would silently lose the pass/fail counters
  `run_one_case` updates.
- Each case runs in its own `( ... )` subshell so `HOME`/`XDG_*`/`FIXTURE_*`
  never leak from one case into the next.
