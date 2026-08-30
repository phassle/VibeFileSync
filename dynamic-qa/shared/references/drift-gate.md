# The deterministic drift gate (#148)

Shared reference for the drift gate that runs before test execution. Built
into both skills by `dynamic-qa/build.sh` from this single source
(`dynamic-qa/shared/references/`) — see `dynamic-qa/DECISIONS.md`.

The mechanical part is entirely deterministic-core modules under
`shared/scripts/`: `drift-gate.mjs` (the freshness decision — pure
comparison, no filesystem access) and `drift-gate-cli.mjs` (the standalone
CI entry point that reads the repository and calls it), both covered by
`node:test`. This document describes what the gate checks and why, so a
skill's own prose can stay short and point here instead of re-deriving the
rules inline.

## Run it

```
node dynamic-qa/shared/scripts/drift-gate-cli.mjs [repository-root]
```

This is THE standalone command a customer's ordinary CI job runs before
test execution. It calls no model, no browser agent, and makes no network
request — it only reads files already in the repository (`qa/
provenance.json`, `qa/flows/*.yaml`, `qa/data/*.yaml`, `qa/schemas/*.json`,
`qa/execution-profiles/*.yaml`, plus each Binding's own recorded harness
config/lockfile and output paths) and compares digests. Exit `0` means every
active Binding is current and no retired flow still carries a provenance
record; exit `1` prints an exact reason per stale or missing Binding.

## What counts as drift

- **Missing or stale provenance for an active Binding is drift.** No
  Provenance Manifest record for an active Flow ID fails immediately
  (`MISSING_PROVENANCE`).
- **A recorded input or output that no longer matches reality is drift.**
  The Flow Definition, each recorded Named Data Set, the two schema
  contracts, each recorded harness config/lockfile path, and each recorded
  output path are all recompared by digest against what provenance
  recorded.
- **A hand-edited Binding is drift, but reported as edited, not rejected.**
  When only a recorded *output* file's digest changed, the gate reports
  `OUTPUT_EDITED` with the edited path(s) named — never `OUTPUT_MISSING` or
  a generic mismatch, and the gate never deletes or silently regenerates
  the file. Ownership of hand-editing customer-owned tests is real;
  traceability is not lost — drift blocks until an explicit adoption or
  repair proposal verifies the edit and updates provenance.
- **An unrelated product-code change is never drift.** The gate only ever
  recomputes digests for the exact closure of paths a Binding's own
  provenance record names. A file that is not a recorded input or output is
  never read by the gate at all, so it structurally cannot appear as a
  mismatch — this is not a filter applied after the fact, there is no code
  path that looks at any other file.
- **A new bundle release alone is never drift.** `generator.bundleVersion`
  is never read or compared. Only an unsupported or explicitly incompatible
  schema, generator, or adapter contract mandates regeneration — modeled as
  a digest mismatch on the recorded schema contracts, or (when a caller
  supplies an `isFrameworkSupported` predicate) an unsupported framework/
  adapter identity.
- **Retired-flow cleanup is flagged, not silently ignored.** A Provenance
  Manifest record for a flow whose Flow State is `retired` is reported as
  `RETIRED_FLOW_PROVENANCE` — cleanup is owed, not performed automatically.

## Reuse, not reinvention

Revision monotonicity reuses `provenance.mjs`'s `checkRevisionMonotonic`
(#146). The manifest's own shape/ordering reuses `validateProvenanceManifest`
(#146). Every digest reuses `canonical-digest.mjs`'s `contentDigest` (#143).
No second digest scheme or second provenance validator exists.
