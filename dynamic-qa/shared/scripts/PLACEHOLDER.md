# Placeholder — deterministic core not yet built

This directory is the single build source for the bundle's **deterministic
core**: plain JavaScript (ESM), Node.js built-in modules only, no third-party
dependencies, no build step. It holds anything that is pure computation rather
than agent behavior — schema validation, canonicalization and content digests,
the drift gate, quarantine expiry, diagnostics scrubbing, evidence-bundle
parsing, threshold evaluation, and capability-gate checks. Ordinary PR and
nightly regression runs call this code directly and never an LLM or a browser
agent, so it must run with no model, no network, and no third-party package
present.

Writing that content is later tickets' job (build-scope items 2, 4, 5, 6 in the
parent spec). This placeholder exists only so `build.sh` has real, non-empty
content to copy into each skill's `scripts/` directory once that copy step is
wired up, and so the acceptance harness's fast deterministic tier
(`dynamic-qa/acceptance/README.md`) has a real target directory to run
`node --test` against. Delete this file the moment the first real core module
lands here.

Convention for what lands here (see `dynamic-qa/acceptance/README.md` "Tier 1"):

- One `<name>.mjs` implementation module per concern, exporting plain
  functions.
- One `<name>.test.mjs` alongside it, written with the built-in `node:test`
  and `node:assert` modules — no test-framework dependency.
- Where strict YAML parsing is needed, hand-write a restricted-subset parser
  here that rejects aliases, custom tags, duplicate keys, and executable
  expressions, rather than adding a YAML library dependency. Same for JSON
  Schema validation: hand-written checks against this bundle's own schemas
  (`../schemas/`), not an added validator dependency. An empty supply chain is
  a security requirement for this bundle, not a style preference.

`dynamic-qa/build.sh` does not yet copy this directory into either skill's
installed tree — extend `build_shared`'s existing `shared/schemas` /
`shared/references` copy-and-byte-diff pattern to include `shared/scripts` the
same way, in whichever ticket lands the first real module here.
