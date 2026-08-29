# dynamic-qa build decisions

This file is the decision record for `dynamic-qa`'s own packaging and distribution
choices. `dynamic-qa` is a separate bounded context from VibeFileSync: this file,
not a VibeFileSync ADR under `docs/adr/`, is where those decisions live, and its
vocabulary must never enter VibeFileSync's `CONTEXT.md`.

## 1. Build source location: top-level `dynamic-qa/` in this repository

**Decision.** The build source tree for the `qa-setup` / `qa-generate` bundle lives
at top-level `dynamic-qa/` in the VibeFileSync repository. Installed output is
produced by `dynamic-qa/build.sh` and lands outside the repository (default
`~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/commands/`, and
optionally `~/.claude/skills/`), never inside it.

**Alternatives considered and rejected:**

- **Authoring the two skills directly inside a skills directory**
  (`~/.agents/skills/dynamic-qa/qa-setup`, etc.), with no repository build source at
  all. Rejected: it leaves the bundle unreviewable through the repository's normal
  PR flow, untested by any CI, and with no single canonical copy to diff the
  Codex/shared/OpenCode builds against — exactly the packaging guarantee this
  ticket exists to build. This was the pre-existing state (`dynamic-qa/SPEC.md` and
  `README.md` only, no `SKILL.md`) and is explicitly what the bundle is moving away
  from.

- **`tools/dynamic-qa-build/`** (nested under a generic repository tooling
  directory). This was the shape sketched during packaging research (see
  `skills-packaging.md` in the run notes) and was seriously considered. Rejected in
  favour of top-level visibility: `dynamic-qa` is a separate bounded context with
  its own domain vocabulary, its own release cadence, and its own acceptance
  harness — nesting it under `tools/` would present it as internal build
  infrastructure *for* VibeFileSync rather than as a distinct system that happens
  to be developed in this repository. A top-level directory makes that boundary
  obvious to anyone browsing the repository tree, matches how `dynamic-qa/` was
  already reserved at top level for the spec and README before this ticket, and
  keeps the directory name itself as the one piece of vocabulary that's allowed to
  leak into the host repo (a location, not a glossary term).

**Consequence.** `tests/docs_references.rs` (VibeFileSync's own doc-reference
checker) does not currently discover `dynamic-qa/` — it only governs root guides,
`docs/`, `.sandcastle/`, and `*-vibesync`-suffixed skills. Markdown under
`dynamic-qa/` is therefore free of that check's symbol-reference notation
requirement; this is a deliberate consequence of keeping dynamic-qa's own
documentation self-contained, not an oversight. If a later ticket wants that
enforcement extended to `dynamic-qa/`, it should say so explicitly rather than
assuming it already applies.

## 2. Bundle versioning and content-addressing: new machinery, not reused

**Decision.** `dynamic-qa/BUNDLE_VERSION` holds one semver string, and
`dynamic-qa/build.sh` computes an immutable content digest over the built `shared`
tree (sorted relative paths, each file hashed, digests concatenated and hashed
again — same shape as `capabilities.json`'s per-harness ladder fingerprint:
canonicalize first, exclude timestamps and machine paths, then hash). Both are
written to `dist/dynamic-qa/BUNDLE_MANIFEST.json` and stamped into each shipped
`SKILL.md`'s `metadata.version` field at build time.

**Why not reuse an existing scheme.** Neither existing first-party convention on
this machine is sufficient by itself: `dynamic-implement`/`dynamic-skills-setup`/
`dynamic-skills-calibrate` carry only a bare `metadata.version` semver with no
digest and no build step; `skills-lock.json` only tracks externally vendored
(`mattpocock/skills`) content by hash, not first-party bundles. This ticket
introduces the first per-bundle immutable content digest and byte-identical
packaging check for the Dynamic skill family; it is new machinery, and later
`dynamic-qa` tickets should extend it rather than invent a second scheme.

## 3. Two skills only, no third `qa-heal` skill

Restated from the parent spec for anyone reading this file in isolation: exactly
`qa-setup` and `qa-generate` are built. Repair is an explicit mode of
`qa-generate` (`qa-generate repair --evidence ...`); no `qa-heal` directory exists
anywhere in this build source, and none should be added.
