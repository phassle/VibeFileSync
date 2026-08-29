#!/usr/bin/env bash
# dynamic-qa/acceptance/lib/fixture.sh
#
# Disposable fixture repository: created, driven, and destroyed per test case.
# Structurally isolates every case from the real world, the same way
# tests/cli.rs::Fixture isolates VibeFileSync's own integration tests:
#
#   - HOME and every XDG_* variable point INSIDE the fixture's own tempdir,
#     never at the real developer home directory.
#   - The fixture's own PATH is prefixed with network-deny shims for the
#     handful of commands that could reach a real host (curl, wget, git,
#     ssh, nc) — invoking any of them is a hard test failure, not a
#     convention someone has to remember.
#   - Nothing is mounted from, or written to, any volume outside the
#     fixture's own tempdir.
#
# Sourced by dynamic-qa/acceptance/run.sh; not meant to be run directly.

set -euo pipefail

# fixture_create — allocate a fresh disposable fixture and export the
# environment every subsequent helper and case body reads.
#
# Exports:
#   FIXTURE_ROOT   the fixture's own tempdir (everything lives under here)
#   FIXTURE_REPO   a git-free plain directory standing in for "the customer
#                  repository" a fixture case populates
#   FIXTURE_HOME   HOME for the duration of the case
#   FIXTURE_LOG    directory for command logs / captured stdout+stderr
#   HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME
#   PATH           prefixed with the fixture's network-deny shim directory
fixture_create() {
  FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dynamic-qa-fixture.XXXXXX")"
  FIXTURE_REPO="$FIXTURE_ROOT/repo"
  FIXTURE_HOME="$FIXTURE_ROOT/home"
  FIXTURE_LOG="$FIXTURE_ROOT/log"
  mkdir -p "$FIXTURE_REPO" "$FIXTURE_HOME" "$FIXTURE_LOG"

  # A real developer HOME must never be touched. Every dotfile root a
  # supported harness or the dynamic-skills-setup profile could read or
  # write is redirected inside FIXTURE_HOME.
  export HOME="$FIXTURE_HOME"
  export XDG_CONFIG_HOME="$FIXTURE_HOME/.config"
  export XDG_DATA_HOME="$FIXTURE_HOME/.local/share"
  export XDG_CACHE_HOME="$FIXTURE_HOME/.cache"
  export XDG_STATE_HOME="$FIXTURE_HOME/.local/state"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"

  _fixture_install_network_shims

  export FIXTURE_ROOT FIXTURE_REPO FIXTURE_HOME FIXTURE_LOG
}

# _fixture_install_network_shims — put fake, always-failing binaries ahead of
# the real ones on PATH for anything that could reach a real network host or
# a real third party. A fixture case that (directly or via a skill it
# invokes) tries to shell out to one of these fails immediately with a clear
# message, instead of silently succeeding against the real Internet.
_fixture_install_network_shims() {
  local shims="$FIXTURE_ROOT/shims"
  mkdir -p "$shims"
  local cmd
  for cmd in curl wget ssh scp nc ncat telnet; do
    cat > "$shims/$cmd" <<EOF
#!/usr/bin/env bash
echo "dynamic-qa acceptance fixture: '$cmd' is blocked inside a fixture (no public Internet, no third party, structurally enforced)" >&2
echo "args: \$*" >&2
exit 97
EOF
    chmod +x "$shims/$cmd"
  done

  # git is legitimate for local, file:// or fixture-local operations (a case
  # may want a real repo tree), but any remote-looking invocation is denied.
  cat > "$shims/git" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    http://*|https://*|git@*|ssh://*|*.com*|*.io*|*.net*|*.org*)
      echo "dynamic-qa acceptance fixture: git invocation looks remote ('$a') — blocked inside a fixture" >&2
      exit 97
      ;;
  esac
done
exec /usr/bin/env -u DYNAMIC_QA_GIT_SHIM_ACTIVE git "$@"
EOF
  chmod +x "$shims/git"

  export PATH="$shims:$PATH"
}

# fixture_snapshot <dir> — a stable, sorted listing of relative paths plus a
# content hash per file, one line per file. Used to prove "nothing was
# written" (no-argument side-effect-free contracts) or to scope a
# forbidden-mutation assertion to exactly the paths that changed.
fixture_snapshot() {
  local dir="$1"
  [ -d "$dir" ] || { return 0; }
  ( cd "$dir" && find . -type f | sort | while IFS= read -r f; do
      if command -v shasum >/dev/null 2>&1; then
        printf '%s %s\n' "$f" "$(shasum -a 256 "$f" | awk '{print $1}')"
      else
        printf '%s %s\n' "$f" "$(sha256sum "$f" | awk '{print $1}')"
      fi
    done )
}

# fixture_teardown — destroy the fixture. Always called, even on failure
# (run.sh traps this), so a fixture never outlives its case.
fixture_teardown() {
  [ -n "${FIXTURE_ROOT:-}" ] || return 0
  rm -rf "$FIXTURE_ROOT"
}
