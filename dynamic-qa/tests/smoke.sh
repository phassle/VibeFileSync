#!/usr/bin/env bash
# dynamic-qa/tests/smoke.sh
#
# Ticket #141's own packaging smoke check. This is NOT the full acceptance
# harness — ticket #142 owns that (cross-harness discoverability, explicit
# invocation drills, side-effect-free proof by actually invoking each skill
# through every supported harness, install-to-temp-dir verification, etc.).
# This script only proves the structural, static invariants #141 is
# responsible for, using a throwaway install target so it never touches a
# real home directory.
#
# Seam for #142: call dynamic-qa/install.sh with --target <temp-dir> (as this
# script does) to get a real installed tree to drive further checks against,
# and call dynamic-qa/build.sh --verify-only to re-check packaging invariants
# without rebuilding. Both scripts exit non-zero on any failure and print
# which check failed, so a harness can shell out to them directly instead of
# re-implementing the checks.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dynamic-qa-smoke.XXXXXX")"

fail() {
  echo "smoke.sh: FAIL: $*" >&2
  exit 1
}

pass() {
  echo "smoke.sh: ok: $*"
}

# real_home_skills_snapshot — a stable, sorted listing of relative paths plus
# a content hash per file, across the real skill install roots this process
# could plausibly touch by accident (~/.agents/skills, ~/.codex/skills,
# ~/.claude/skills, ~/.config/opencode/commands) — the same directories
# install.sh writes into when no --target is given. A missing directory
# contributes nothing (not an error), so a developer machine that has never
# installed a given harness's skills still gets a meaningful, comparable
# snapshot.
real_home_skills_snapshot() {
  local root
  for root in "$HOME/.agents/skills" "$HOME/.codex/skills" "$HOME/.claude/skills" "$HOME/.config/opencode/commands"; do
    [ -d "$root" ] || continue
    ( cd "$root" && find . \( -type f -o -type l \) | sort | while IFS= read -r f; do
        if [ -L "$f" ]; then
          printf '%s symlink -> %s\n' "$root/$f" "$(readlink "$f")"
        elif command -v shasum >/dev/null 2>&1; then
          printf '%s %s\n' "$root/$f" "$(shasum -a 256 "$f" | awk '{print $1}')"
        else
          printf '%s %s\n' "$root/$f" "$(sha256sum "$f" | awk '{print $1}')"
        fi
      done )
  done
}

# on_exit — the real-$HOME-unchanged comparison, run unconditionally as an
# EXIT trap rather than as one more check in the linear body below. fail()
# exits immediately on the FIRST failing check, so if it lived inline after
# every other check (as it used to), a run where installation touched a real
# home directory AND some earlier assertion failed first would exit on that
# earlier failure and never even reach the comparison — the real-home
# regression would go unreported. Running it in the trap means it always
# runs, on every exit path, and its own preserves the *original* failure's
# exit status when it finds no difference, while still failing the run (and
# saying so) if it finds one, even on top of an already-failing run.
on_exit() {
  local original_status=$?
  local status="$original_status"

  local real_home_after
  real_home_after="$(real_home_skills_snapshot)"
  if [ "$REAL_HOME_BEFORE" != "$real_home_after" ]; then
    echo "smoke.sh: FAIL: build.sh/install.sh wrote to the real \$HOME's skill directories (~/.agents/skills, ~/.codex/skills, ~/.claude/skills, ~/.config/opencode/commands), which this run must never touch — before/after snapshots differ" >&2
    status=1
  elif [ "$original_status" -eq 0 ]; then
    pass "real \$HOME's skill directories are unchanged by this run"
    echo "smoke.sh: all checks passed"
  fi

  rm -rf "$TMP"
  exit "$status"
}

REAL_HOME_BEFORE="$(real_home_skills_snapshot)"
trap on_exit EXIT

echo "smoke.sh: building and verifying packaging"
"$HERE/build.sh"
pass "build.sh completed with all packaging checks passing"

echo "smoke.sh: installing to a throwaway target: $TMP"
"$HERE/install.sh" --target "$TMP"
pass "install.sh completed against a temporary target, not a real home directory"

for skill in qa-setup qa-generate; do
  [ -f "$TMP/.agents/skills/$skill/SKILL.md" ] || fail "$skill missing from shared install"
  [ -f "$TMP/.codex/skills/$skill/SKILL.md" ] || fail "$skill missing from Codex install"
  [ -f "$TMP/.codex/skills/$skill/agents/openai.yaml" ] || fail "$skill missing Codex openai.yaml overlay"
  [ -f "$TMP/.config/opencode/commands/$skill.md" ] || fail "$skill missing OpenCode command adapter"
  [ -L "$TMP/.claude/skills/$skill" ] || fail "$skill missing Claude Code symlink"
done
pass "both skills discoverable in shared, Codex, and OpenCode installs, each installed alone side by side"

# Every skill-local path a SKILL.md names must exist inside that installed skill.
#
# Packaging already proves the shared copies are byte-identical, but that says
# nothing about whether the paths the document tells an agent to load actually
# resolve after installation. They did not: the SKILL.md bodies carried 37
# references to build-source paths (dynamic-qa/shared/..., shared/...) that
# exist only in this repository, so a standalone installed skill could not load
# its own deterministic core -- the exact self-containment property this bundle
# claims. Byte-identity is not path-resolution; check both.
for skill in qa-setup qa-generate; do
  root="$TMP/.agents/skills/$skill"
  sm="$root/SKILL.md"
  # Backtick-quoted references/..., scripts/... and assets/... paths.
  refs=$(grep -oE '`(references|scripts|assets)/[A-Za-z0-9._/-]+`' "$sm" | tr -d '`' | sort -u)
  for ref in $refs; do
    [ -e "$root/$ref" ] || fail "$skill/SKILL.md names '$ref', which does not exist in the installed skill"
  done
  # No build-source path may survive into an installed skill.
  if grep -qE '`(dynamic-qa/)?shared/(scripts|references|schemas)/' "$sm"; then
    fail "$skill/SKILL.md still names a build-source path that does not exist after installation"
  fi
done
pass "every skill-local path named in each installed SKILL.md resolves inside that skill"

# Each skill directory must be installable with its sibling entirely absent.
rm -rf "$TMP/.agents/skills/qa-generate"
[ -d "$TMP/.agents/skills/qa-setup" ] || fail "qa-setup install got removed along with qa-generate"
[ -f "$TMP/.agents/skills/qa-setup/SKILL.md" ] || fail "qa-setup unusable after qa-generate removed"
if grep -rIl -e '\.\./qa-generate' "$TMP/.agents/skills/qa-setup" >/dev/null 2>&1; then
  fail "qa-setup still references a path into the now-absent qa-generate"
fi
pass "qa-setup remains installable and self-contained with qa-generate absent"

# Explicit-invocation contract, on the surviving install.
grep -q '^disable-model-invocation: true' "$TMP/.agents/skills/qa-setup/SKILL.md" \
  || fail "qa-setup/SKILL.md missing disable-model-invocation: true"
grep -q 'allow_implicit_invocation: false' "$TMP/.codex/skills/qa-setup/agents/openai.yaml" \
  || fail "qa-setup Codex overlay missing allow_implicit_invocation: false"
grep -q 'allow_implicit_invocation: false' "$TMP/.codex/skills/qa-generate/agents/openai.yaml" \
  || fail "qa-generate Codex overlay missing allow_implicit_invocation: false"
pass "explicit-invocation contract present in shared and Codex builds"

# No-argument side-effect-free contract is documented on both skills.
for skill in qa-setup qa-generate; do
  sm="$HERE/$skill/SKILL.md"
  grep -qi 'side-effect free' "$sm" || fail "$skill/SKILL.md does not document the no-argument side-effect-free contract"
done
pass "no-argument side-effect-free contract documented on both skills"

# Versioning / content-addressing.
manifest="$HERE/dist/BUNDLE_MANIFEST.json"
[ -f "$manifest" ] || fail "missing $manifest"
grep -q '"version"' "$manifest" || fail "$manifest missing version"
grep -q '"contentDigest": "sha256:' "$manifest" || fail "$manifest missing a sha256 contentDigest"
pass "bundle release is versioned and content-addressed via BUNDLE_MANIFEST.json"

# A nested file named BUNDLE_MANIFEST.json (at any depth other than the dist
# root) is a real emitted artifact and must move contentDigest when its
# content changes. The digest computation must exclude ONLY the root
# dist/BUNDLE_MANIFEST.json by path, never any file that merely shares that
# bare name deeper in the tree — a bare-name exclusion would let such a file
# change without moving contentDigest, defeating the point of a
# content-addressed manifest. Proven here against a disposable full copy of
# the dynamic-qa source tree, so the real dist/ this script already built is
# never disturbed.
TMP_DIGEST="$(mktemp -d "${TMPDIR:-/tmp}/dynamic-qa-digest-test.XXXXXX")"
cp -R "$HERE/." "$TMP_DIGEST/"
rm -rf "$TMP_DIGEST/dist"
mkdir -p "$TMP_DIGEST/qa-setup/nested-artifact-dir"
echo '{"nested":"v1"}' > "$TMP_DIGEST/qa-setup/nested-artifact-dir/BUNDLE_MANIFEST.json"
"$TMP_DIGEST/build.sh" >/dev/null
nested_out="$TMP_DIGEST/dist/shared/qa-setup/nested-artifact-dir/BUNDLE_MANIFEST.json"
[ -f "$nested_out" ] || fail "nested BUNDLE_MANIFEST.json fixture did not make it into dist/ — test setup is broken"
digest_v1="$(grep -o '"contentDigest": "sha256:[^"]*"' "$TMP_DIGEST/dist/BUNDLE_MANIFEST.json")"
echo '{"nested":"v2-changed"}' > "$TMP_DIGEST/qa-setup/nested-artifact-dir/BUNDLE_MANIFEST.json"
"$TMP_DIGEST/build.sh" >/dev/null
digest_v2="$(grep -o '"contentDigest": "sha256:[^"]*"' "$TMP_DIGEST/dist/BUNDLE_MANIFEST.json")"
[ "$digest_v1" != "$digest_v2" ] \
  || fail "changing a nested (non-root) BUNDLE_MANIFEST.json-named file did not change contentDigest — the digest exclusion is matching by bare name instead of by root path"
rm -rf "$TMP_DIGEST"
pass "a nested file named BUNDLE_MANIFEST.json affects contentDigest; only the dist root manifest is excluded"

# The real-$HOME-unchanged comparison (and the final "all checks passed"
# line) runs unconditionally in the on_exit EXIT trap above, not here — see
# its comment for why.
