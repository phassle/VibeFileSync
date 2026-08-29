# Placeholder — shared references not yet built

This directory is the single build source for content shared between `qa-setup`
and `qa-generate` (for example the versioned anti-flakiness reference and the
provider-adapter contract described in the spec). Writing that content is later
tickets' job. This placeholder exists only so `build.sh` has real, non-empty
content to copy into each skill's `references/shared/` directory and byte-diff
against each other, proving the copy-and-verify mechanism works before real
reference content exists. Delete this file the moment the first real shared
reference lands here.
