# dynamic-qa/acceptance/cases/structural/cross-harness-smoke.case.sh
#
# Acceptance criterion: "A cross-harness structural smoke test verifies both
# skill packages are discoverable, explicitly invokable, self-contained,
# version-consistent, and side-effect free."
#
# This case invokes the REAL dynamic-qa/install.sh (which itself always
# rebuilds and verifies via build.sh first) against the fixture's own
# HOME/XDG tree, then inspects the real installed files — never internals,
# never a shortcut around install.sh's own gates.

case_describe="both skill packages are discoverable, explicitly invokable, self-contained, version-consistent, and side-effect free"

_SKILLS="qa-setup qa-generate"

_skill_md_version() {
  # Extracts metadata.version from a built SKILL.md's frontmatter.
  grep '  version:' "$1" | head -1 | sed -E 's/.*version: *"?([^"[:space:]]*)"?.*/\1/'
}

case_setup() {
  : # nothing to populate in the fixture repo itself; this case exercises
    # the install, not a customer repository.
}

case_run() {
  BEFORE_SNAPSHOT="$FIXTURE_LOG/before.snapshot"
  fixture_snapshot "$FIXTURE_HOME" > "$BEFORE_SNAPSHOT"

  INSTALL_LOG="$FIXTURE_LOG/install.log"
  if ! "$DYNAMIC_QA_ROOT/install.sh" --target "$FIXTURE_HOME" > "$INSTALL_LOG" 2>&1; then
    cat "$INSTALL_LOG" >&2
    case_fail "install.sh --target failed against the fixture; see $INSTALL_LOG"
  fi
}

case_assert() {
  local skill

  # Discoverable: every supported harness's real install location has the
  # real skill.
  for skill in $_SKILLS; do
    assert_file_exists "$FIXTURE_HOME/.agents/skills/$skill/SKILL.md" \
      "$skill missing from shared (Agent Skills) install"
    assert_file_exists "$FIXTURE_HOME/.codex/skills/$skill/SKILL.md" \
      "$skill missing from Codex install"
    assert_file_exists "$FIXTURE_HOME/.config/opencode/commands/$skill.md" \
      "$skill missing OpenCode command adapter"
    [ -L "$FIXTURE_HOME/.claude/skills/$skill" ] \
      || case_fail "$skill missing Claude Code symlink"
  done

  # Explicitly invokable: the portable and Codex-specific no-implicit-
  # invocation contracts are both present on the installed copies.
  for skill in $_SKILLS; do
    assert_contains "$FIXTURE_HOME/.agents/skills/$skill/SKILL.md" \
      "disable-model-invocation: true" \
      "$skill installed SKILL.md missing disable-model-invocation: true"
    assert_contains "$FIXTURE_HOME/.codex/skills/$skill/agents/openai.yaml" \
      "allow_implicit_invocation: false" \
      "$skill installed Codex overlay missing allow_implicit_invocation: false"
  done

  # Self-contained: each skill survives its sibling's install being removed
  # entirely, and never references a path into that sibling.
  rm -rf "$FIXTURE_HOME/.agents/skills/qa-generate"
  assert_file_exists "$FIXTURE_HOME/.agents/skills/qa-setup/SKILL.md" \
    "qa-setup became unusable after qa-generate's install was removed"
  if grep -RIl -e '\.\./qa-generate' "$FIXTURE_HOME/.agents/skills/qa-setup" >/dev/null 2>&1; then
    case_fail "qa-setup still references a path into the now-absent qa-generate install"
  fi

  # Version-consistent: shared and Codex builds agree with BUNDLE_VERSION.
  local bundle_version
  bundle_version="$(tr -d '[:space:]' < "$DYNAMIC_QA_ROOT/BUNDLE_VERSION")"
  local shared_version codex_version
  shared_version="$(_skill_md_version "$FIXTURE_HOME/.agents/skills/qa-setup/SKILL.md")"
  codex_version="$(_skill_md_version "$FIXTURE_HOME/.codex/skills/qa-setup/SKILL.md")"
  assert_eq "qa-setup shared build version matches BUNDLE_VERSION" "$bundle_version" "$shared_version"
  assert_eq "qa-setup Codex build version matches BUNDLE_VERSION" "$bundle_version" "$codex_version"

  # Side-effect free: install.sh only ever writes under FIXTURE_HOME, never
  # under FIXTURE_REPO (the stand-in customer repository) — nothing about
  # installing or discovering the bundle touches the repository it will
  # later operate on.
  local repo_snapshot
  repo_snapshot="$(fixture_snapshot "$FIXTURE_REPO")"
  [ -z "$repo_snapshot" ] || case_fail "install.sh wrote into the fixture repository, which it must never touch: $repo_snapshot"
}
