#!/usr/bin/env bash
# dynamic-qa build.sh
#
# Builds the qa-setup / qa-generate skill bundle from this directory's build
# source into dist/dynamic-qa/, in shared (Agent Skills), Codex, and OpenCode
# forms, then verifies the packaging invariants ticket #135/#141 require:
#
#   - shared schema/reference copies are byte-identical across both skills
#   - neither skill's shipped files reach into a sibling skill directory
#   - both SKILL.md files carry the explicit-invocation contract
#   - both Codex overlays carry allow_implicit_invocation: false
#   - the bundle is versioned and content-addressed (BUNDLE_MANIFEST.json)
#
# This script writes ONLY inside dist/dynamic-qa/ (below this directory). It
# never touches ~/.agents, ~/.codex, ~/.claude, or ~/.config/opencode — that is
# install.sh's job, run separately and only when explicitly asked.
#
# Usage:
#   dynamic-qa/build.sh              # build + verify (default)
#   dynamic-qa/build.sh --verify-only  # verify an existing dist/ without rebuilding
#
# Exit status is non-zero on any packaging or verification failure.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${DYNAMIC_QA_DIST:-"$HERE/dist"}"
SKILLS="qa-setup qa-generate"
VERIFY_ONLY=0

# --- DYNAMIC_QA_DIST validation -----------------------------------------
#
# build_shared() below does `rm -rf "$DIST"` before writing the build. An
# override that names any writable directory would make that an arbitrary
# `rm -rf` of whatever the caller (or a hostile env) pointed it at. Resolve
# DIST to its real path and fail closed unless it is $HERE itself or a
# descendant of $HERE — the only trees this script is allowed to delete.
validate_dist_is_descendant_of_here() {
  local candidate="$DIST" resolved parent

  # DIST may not exist yet on a first build; resolve as far up the path as
  # already exists, then re-append the not-yet-created tail, so a fresh
  # "$HERE/dist" (or a fresh "$HERE/dist/deeper") still validates without
  # requiring a prior mkdir.
  local tail=""
  while [ ! -d "$candidate" ]; do
    case "$candidate" in
      */*)
        tail="/$(basename "$candidate")$tail"
        candidate="$(dirname "$candidate")"
        ;;
      *)
        # No more path separators to strip — nothing on this path exists.
        candidate="."
        tail="/$DIST$tail"
        break
        ;;
    esac
  done

  resolved="$(cd "$candidate" && pwd)$tail"

  case "$resolved" in
    "$HERE"|"$HERE"/*)
      ;;
    *)
      fail "DYNAMIC_QA_DIST ($DIST) resolves to $resolved, which is not $HERE itself or a descendant of it — refusing to build, because build.sh rm -rf's this directory. Point DYNAMIC_QA_DIST at a path under $HERE, or unset it to use the default."
      ;;
  esac
}

for arg in "$@"; do
  case "$arg" in
    --verify-only) VERIFY_ONLY=1 ;;
    *)
      echo "build.sh: unknown argument: $arg" >&2
      exit 64
      ;;
  esac
done

fail() {
  echo "build.sh: FAIL: $*" >&2
  exit 1
}

sha256_of_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "neither shasum nor sha256sum is available on PATH"
  fi
}

sha256_of_string() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  else
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  fi
}

read_bundle_version() {
  local f="$HERE/BUNDLE_VERSION"
  [ -f "$f" ] || fail "missing $f"
  tr -d '[:space:]' < "$f"
}

# --- build -------------------------------------------------------------

build_shared() {
  local version="$1"
  rm -rf "$DIST"
  mkdir -p "$DIST/shared" "$DIST/codex" "$DIST/opencode/commands"

  for skill in $SKILLS; do
    local src="$HERE/$skill"
    local out="$DIST/shared/$skill"
    [ -d "$src" ] || fail "missing skill source directory: $src"
    mkdir -p "$out"
    # Copy the skill's own authored tree (SKILL.md, references/, scripts/, assets/).
    (cd "$src" && find . -type f) | while IFS= read -r rel; do
      mkdir -p "$out/$(dirname "$rel")"
      cp "$src/$rel" "$out/$rel"
    done

    # Stamp the single BUNDLE_VERSION source into the shipped SKILL.md.
    if [ -f "$out/SKILL.md" ]; then
      sed -i.bak "s/{{BUNDLE_VERSION}}/$version/" "$out/SKILL.md"
      rm -f "$out/SKILL.md.bak"
    fi

    # Populate the shared schema/reference/script copies from one build source.
    mkdir -p "$out/assets/schemas" "$out/references/shared" "$out/scripts"
    if [ -d "$HERE/shared/schemas" ]; then
      cp -R "$HERE/shared/schemas/." "$out/assets/schemas/"
    fi
    if [ -d "$HERE/shared/references" ]; then
      cp -R "$HERE/shared/references/." "$out/references/shared/"
    fi
    if [ -d "$HERE/shared/scripts" ]; then
      # Deterministic-core modules only: leave fixtures/tests out of the
      # shipped skill tree (they exist for dynamic-qa's own acceptance
      # harness, not for a customer's installed skill).
      (cd "$HERE/shared/scripts" && find . -type f -name '*.mjs' ! -name '*.test.mjs') \
        | while IFS= read -r rel; do
            mkdir -p "$out/scripts/$(dirname "$rel")"
            cp "$HERE/shared/scripts/$rel" "$out/scripts/$rel"
          done
    fi
  done
}

build_codex() {
  for skill in $SKILLS; do
    local shared="$DIST/shared/$skill"
    local out="$DIST/codex/$skill"
    local overlay="$HERE/codex/$skill/agents/openai.yaml"
    [ -f "$overlay" ] || fail "missing Codex overlay: $overlay"
    rm -rf "$out"
    cp -R "$shared" "$out"
    mkdir -p "$out/agents"
    cp "$overlay" "$out/agents/openai.yaml"
  done
}

build_opencode() {
  for skill in $SKILLS; do
    local adapter="$HERE/opencode/commands/$skill.md"
    [ -f "$adapter" ] || fail "missing OpenCode command adapter: $adapter"
    cp "$adapter" "$DIST/opencode/commands/$skill.md"
  done
}

# --- verify --------------------------------------------------------------

verify_shared_copies_identical() {
  # Packaging FAILS when the emitted schema/reference copies differ, per
  # skill. This is the release gate that turns "generated from one build
  # source" from an assertion into a checked invariant.
  local a="$DIST/shared/qa-setup"
  local b="$DIST/shared/qa-generate"
  diff -rq "$a/assets/schemas" "$b/assets/schemas" \
    || fail "qa-setup and qa-generate assets/schemas differ — packaging must produce byte-identical copies from dynamic-qa/shared/schemas/"
  diff -rq "$a/references/shared" "$b/references/shared" \
    || fail "qa-setup and qa-generate references/shared differ — packaging must produce byte-identical copies from dynamic-qa/shared/references/"
  diff -rq "$a/scripts" "$b/scripts" \
    || fail "qa-setup and qa-generate scripts differ — packaging must produce byte-identical copies from dynamic-qa/shared/scripts/"
}

verify_no_sibling_reach_through() {
  # No installed skill's shipped files may path into its sibling's directory.
  # A literal "../<sibling>" (or "..\<sibling>") token is always disqualifying
  # — the skill must be installable with no sibling present at all.
  for skill in $SKILLS; do
    local other
    if [ "$skill" = "qa-setup" ]; then other="qa-generate"; else other="qa-setup"; fi
    local dir="$DIST/shared/$skill"
    if grep -RIl -e "\.\./$other" -e "\.\.\\\\$other" "$dir" >/dev/null 2>&1; then
      fail "$skill reaches into sibling directory ../$other — remove the reference"
    fi
  done
}

verify_explicit_invocation_contract() {
  for skill in $SKILLS; do
    local sm="$DIST/shared/$skill/SKILL.md"
    grep -q "^disable-model-invocation: true" "$sm" \
      || fail "$skill/SKILL.md is missing disable-model-invocation: true"
    local yaml="$DIST/codex/$skill/agents/openai.yaml"
    grep -q "allow_implicit_invocation: false" "$yaml" \
      || fail "$skill Codex overlay is missing allow_implicit_invocation: false"
  done
}

verify_no_unstamped_placeholders() {
  for skill in $SKILLS; do
    local sm="$DIST/shared/$skill/SKILL.md"
    grep -q '{{BUNDLE_VERSION}}' "$sm" \
      && fail "$skill/SKILL.md still contains an unstamped {{BUNDLE_VERSION}} placeholder"
  done
  return 0
}

verify_installable_alone() {
  # Nothing under a shipped skill's own tree may be a symlink or hardlink
  # escaping the tree, and the tree must be a plain, complete, self-contained
  # directory (no reliance on a sibling directory existing at install time).
  for skill in $SKILLS; do
    local dir="$DIST/shared/$skill"
    [ -f "$dir/SKILL.md" ] || fail "$skill: dist output has no SKILL.md — not installable alone"
    find "$dir" -type l | grep -q . \
      && fail "$skill: dist output contains a symlink — not installable alone as a plain copy"
  done
  return 0
}

write_manifest() {
  local version="$1"
  local manifest="$DIST/BUNDLE_MANIFEST.json"
  local digest_input=""
  local rel f h
  # Canonical digest: sorted relative-path list across every emitted build —
  # dist/shared, dist/codex, and dist/opencode alike — each file hashed,
  # digests concatenated in path order, then hashed again. Excludes
  # timestamps and machine-local paths, same shape as capabilities.json's
  # per-harness ladder fingerprint. BUNDLE_MANIFEST.json itself is the only
  # exclusion (it does not exist yet at this point, but is excluded by name
  # regardless, so a later re-verify over an already-manifested dist/ hashes
  # the same input): every other emitted artifact — including the Codex
  # overlays and OpenCode command adapters BUNDLE_MANIFEST.json declares as
  # separate builds — is part of the canonical digest, so two bundles that
  # differ only in adapter content are never assigned the same digest.
  local filelist
  filelist="$(cd "$DIST" && find . -type f ! -name 'BUNDLE_MANIFEST.json' | sort)"
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    f="$DIST/$rel"
    h="$(sha256_of_file "$f")"
    digest_input="$digest_input$rel:$h;"
  done <<EOF
$filelist
EOF
  local digest
  digest="$(sha256_of_string "$digest_input")"

  {
    echo "{"
    echo "  \"bundle\": \"dynamic-qa\","
    echo "  \"version\": \"$version\","
    echo "  \"contentDigest\": \"sha256:$digest\","
    echo "  \"skills\": [\"qa-setup\", \"qa-generate\"],"
    echo "  \"builds\": [\"shared\", \"codex\", \"opencode\"]"
    echo "}"
  } > "$manifest"

  echo "build.sh: wrote $manifest (version=$version, contentDigest=sha256:$digest)"
}

main() {
  local version
  validate_dist_is_descendant_of_here
  version="$(read_bundle_version)"

  if [ "$VERIFY_ONLY" -eq 0 ]; then
    build_shared "$version"
    build_codex
    build_opencode
    write_manifest "$version"
  fi

  [ -d "$DIST/shared/qa-setup" ] || fail "dist/shared/qa-setup missing — run build.sh without --verify-only first"

  verify_shared_copies_identical
  verify_no_sibling_reach_through
  verify_explicit_invocation_contract
  verify_no_unstamped_placeholders
  verify_installable_alone

  echo "build.sh: OK — dist/dynamic-qa is built and verified"
}

main "$@"
