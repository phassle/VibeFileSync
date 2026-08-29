#!/usr/bin/env bash
# dynamic-qa install.sh
#
# Installs the built dynamic-qa bundle (qa-setup, qa-generate) into skill
# roots. This is the ONLY script in dynamic-qa/ that writes outside the repo,
# and it does so only when run explicitly — build.sh never calls this script,
# and this script is never called implicitly by anything else.
#
# Every destination is overridable, so an acceptance harness (ticket #142) can
# point every target at a temporary directory instead of a real home
# directory. Defaults match this machine's existing Dynamic-skill convention.
#
# Usage:
#   dynamic-qa/install.sh                      # install to the real default roots
#   dynamic-qa/install.sh --target DIR         # install everything under DIR instead
#   dynamic-qa/install.sh --agents-root DIR --codex-root DIR \
#                          --opencode-root DIR --claude-root DIR
#
# Env var overrides (same effect as the matching flag):
#   DYNAMIC_QA_AGENTS_ROOT, DYNAMIC_QA_CODEX_ROOT,
#   DYNAMIC_QA_OPENCODE_ROOT, DYNAMIC_QA_CLAUDE_ROOT, DYNAMIC_QA_TARGET
#
# Exit status is non-zero if the bundle has not been built and verified, or
# if any install step fails.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${DYNAMIC_QA_DIST:-"$HERE/dist"}"

TARGET="${DYNAMIC_QA_TARGET:-}"
AGENTS_ROOT="${DYNAMIC_QA_AGENTS_ROOT:-}"
CODEX_ROOT="${DYNAMIC_QA_CODEX_ROOT:-}"
OPENCODE_ROOT="${DYNAMIC_QA_OPENCODE_ROOT:-}"
CLAUDE_ROOT="${DYNAMIC_QA_CLAUDE_ROOT:-}"
SKIP_CLAUDE_SYMLINKS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --agents-root) AGENTS_ROOT="$2"; shift 2 ;;
    --codex-root) CODEX_ROOT="$2"; shift 2 ;;
    --opencode-root) OPENCODE_ROOT="$2"; shift 2 ;;
    --claude-root) CLAUDE_ROOT="$2"; shift 2 ;;
    --no-claude-symlinks) SKIP_CLAUDE_SYMLINKS=1; shift 1 ;;
    *)
      echo "install.sh: unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

fail() {
  echo "install.sh: FAIL: $*" >&2
  exit 1
}

if [ -n "$TARGET" ]; then
  AGENTS_ROOT="${AGENTS_ROOT:-$TARGET/.agents/skills}"
  CODEX_ROOT="${CODEX_ROOT:-$TARGET/.codex/skills}"
  OPENCODE_ROOT="${OPENCODE_ROOT:-$TARGET/.config/opencode/commands}"
  CLAUDE_ROOT="${CLAUDE_ROOT:-$TARGET/.claude/skills}"
fi

AGENTS_ROOT="${AGENTS_ROOT:-$HOME/.agents/skills}"
CODEX_ROOT="${CODEX_ROOT:-$HOME/.codex/skills}"
OPENCODE_ROOT="${OPENCODE_ROOT:-$HOME/.config/opencode/commands}"
CLAUDE_ROOT="${CLAUDE_ROOT:-$HOME/.claude/skills}"

SKILLS="qa-setup qa-generate"

# Always (re)build and verify first — install never ships an unverified tree.
"$HERE/build.sh"

[ -d "$DIST/shared/qa-setup" ] || fail "dist/shared/qa-setup missing after build"

echo "install.sh: installing shared build to $AGENTS_ROOT"
mkdir -p "$AGENTS_ROOT"
for skill in $SKILLS; do
  rm -rf "${AGENTS_ROOT:?}/$skill"
  cp -R "$DIST/shared/$skill" "$AGENTS_ROOT/$skill"
done

echo "install.sh: installing Codex build to $CODEX_ROOT"
mkdir -p "$CODEX_ROOT"
for skill in $SKILLS; do
  rm -rf "${CODEX_ROOT:?}/$skill"
  cp -R "$DIST/codex/$skill" "$CODEX_ROOT/$skill"
done

echo "install.sh: installing OpenCode command adapters to $OPENCODE_ROOT"
mkdir -p "$OPENCODE_ROOT"
for skill in $SKILLS; do
  cp "$DIST/opencode/commands/$skill.md" "$OPENCODE_ROOT/$skill.md"
done

if [ "$SKIP_CLAUDE_SYMLINKS" -eq 0 ]; then
  echo "install.sh: linking shared build into $CLAUDE_ROOT (matching existing dynamic-* skill convention)"
  mkdir -p "$CLAUDE_ROOT"
  for skill in $SKILLS; do
    ln -sfn "$AGENTS_ROOT/$skill" "$CLAUDE_ROOT/$skill"
  done
fi

echo "install.sh: OK"
