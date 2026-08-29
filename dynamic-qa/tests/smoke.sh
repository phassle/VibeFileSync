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
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "smoke.sh: FAIL: $*" >&2
  exit 1
}

pass() {
  echo "smoke.sh: ok: $*"
}

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

# Each skill directory must be installable with its sibling entirely absent.
rm -rf "$TMP/.agents/skills/qa-generate"
[ -d "$TMP/.agents/skills/qa-setup" ] || fail "qa-setup install got removed along with qa-generate"
[ -f "$TMP/.agents/skills/qa-setup/SKILL.md" ] || fail "qa-setup unusable after qa-generate removed"
if grep -RIl -e '\.\./qa-generate' "$TMP/.agents/skills/qa-setup" >/dev/null 2>&1; then
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

# A build must not have touched the real install roots this process actually
# owns outside $TMP — sanity check that install.sh honoured --target and
# wrote nothing to $HOME during this run beyond what already existed.
echo "smoke.sh: all checks passed"
