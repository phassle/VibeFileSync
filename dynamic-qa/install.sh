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

# CLI_* hold ONLY what was explicitly passed as a flag on the command line —
# never an environment-variable default — so precedence between an explicit
# --target and an inherited DYNAMIC_QA_*_ROOT environment variable can be
# decided correctly below instead of the two being indistinguishable once
# merged into one variable.
TARGET_CLI=""
AGENTS_ROOT_CLI=""
CODEX_ROOT_CLI=""
OPENCODE_ROOT_CLI=""
CLAUDE_ROOT_CLI=""
SKIP_CLAUDE_SYMLINKS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET_CLI="$2"; shift 2 ;;
    --agents-root) AGENTS_ROOT_CLI="$2"; shift 2 ;;
    --codex-root) CODEX_ROOT_CLI="$2"; shift 2 ;;
    --opencode-root) OPENCODE_ROOT_CLI="$2"; shift 2 ;;
    --claude-root) CLAUDE_ROOT_CLI="$2"; shift 2 ;;
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

# Precedence, highest first:
#   1. an explicit --agents-root/--codex-root/--opencode-root/--claude-root
#      flag on the command line, per root.
#   2. an explicit --target flag on the command line (applies to whichever
#      roots did not get their own explicit flag above). This deliberately
#      outranks a DYNAMIC_QA_*_ROOT environment variable: tests/smoke.sh (and
#      any other caller) passes --target expecting install.sh to write ONLY
#      under that target, and an inherited env var must never silently
#      redirect part of the install outside it.
#   3. the matching DYNAMIC_QA_<ROLE>_ROOT environment variable.
#   4. the DYNAMIC_QA_TARGET environment variable, same per-root fill-in as
#      an explicit --target, for whichever roots are still unset.
#   5. the real default under $HOME.
if [ -n "$TARGET_CLI" ]; then
  AGENTS_ROOT="${AGENTS_ROOT_CLI:-$TARGET_CLI/.agents/skills}"
  CODEX_ROOT="${CODEX_ROOT_CLI:-$TARGET_CLI/.codex/skills}"
  OPENCODE_ROOT="${OPENCODE_ROOT_CLI:-$TARGET_CLI/.config/opencode/commands}"
  CLAUDE_ROOT="${CLAUDE_ROOT_CLI:-$TARGET_CLI/.claude/skills}"
else
  AGENTS_ROOT="${AGENTS_ROOT_CLI:-${DYNAMIC_QA_AGENTS_ROOT:-}}"
  CODEX_ROOT="${CODEX_ROOT_CLI:-${DYNAMIC_QA_CODEX_ROOT:-}}"
  OPENCODE_ROOT="${OPENCODE_ROOT_CLI:-${DYNAMIC_QA_OPENCODE_ROOT:-}}"
  CLAUDE_ROOT="${CLAUDE_ROOT_CLI:-${DYNAMIC_QA_CLAUDE_ROOT:-}}"

  TARGET_ENV="${DYNAMIC_QA_TARGET:-}"
  if [ -n "$TARGET_ENV" ]; then
    AGENTS_ROOT="${AGENTS_ROOT:-$TARGET_ENV/.agents/skills}"
    CODEX_ROOT="${CODEX_ROOT:-$TARGET_ENV/.codex/skills}"
    OPENCODE_ROOT="${OPENCODE_ROOT:-$TARGET_ENV/.config/opencode/commands}"
    CLAUDE_ROOT="${CLAUDE_ROOT:-$TARGET_ENV/.claude/skills}"
  fi
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
