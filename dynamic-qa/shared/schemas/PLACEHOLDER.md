# Placeholder — schemas not yet built

This directory is the single build source for the v1 JSON Schemas listed in the
spec (`dynamic-qa-flow-v1.schema.json`, `dynamic-qa-data-v1.schema.json`,
`dynamic-qa-execution-profile-v1.schema.json`, `dynamic-qa-baseline-plan-v1.schema.json`,
`dynamic-qa-provenance-v1.schema.json`, `dynamic-qa-quarantine-v1.schema.json`,
`dynamic-qa-failure-evidence-v1.schema.json`, `dynamic-qa-diagnosis-v1.schema.json`,
`dynamic-qa-result-envelope-v1.schema.json`).

Writing those schemas is a later ticket's job (build-scope item 2: "v1 schemas,
canonicalization, deterministic validators, and customer-repo scaffolding"). This
placeholder exists only so `build.sh` has real, non-empty content to copy into
each skill's `assets/schemas/` directory and byte-diff against each other,
proving the copy-and-verify mechanism works before real schema content exists.
Delete this file the moment the first real schema lands here.
