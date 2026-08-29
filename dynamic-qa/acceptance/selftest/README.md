# Harness self-check — not the deterministic core

`canonical-digest.example.mjs` / `canonical-digest.example.test.mjs` are a
worked example that ships with the acceptance harness itself, proving the
Tier 1 mechanism (`node --test`, built-in `node:test` and `node:assert`,
zero dependencies) genuinely runs and genuinely fails when it should.

This is deliberately **not** placed under `dynamic-qa/shared/scripts/` — that
directory is the real target for the future deterministic core (schema
validation, the drift gate, quarantine expiry, capability-gate checks, and so
on; see `dynamic-qa/shared/scripts/PLACEHOLDER.md`), and keeping this example
physically separate means no later ticket can mistake it for real core
content, or have to delete or rename it to land the first real module.

`run.sh` runs this directory (`run_tier1_selftest`) separately from the real
Tier 1 run (`run_tier1`, which runs `node --test dynamic-qa/shared/scripts`).
Delete this directory only if a future maintainer decides the harness no
longer needs its own proof that Tier 1 works — it is not part of any
ticket's acceptance criteria and is not required reading for anyone adding a
fixture case.
