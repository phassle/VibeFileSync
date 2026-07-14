## Agent skills

### Issue tracker

Issues live in GitHub Issues (github.com/phassle/VibeFileSync), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Git workflow

This repo uses **gitflow**. Never commit directly to `develop` or `main`:

- **Always create a feature branch**: `feature/<kebab-name>` off `develop`, one per coherent change — code, docs, and ADRs alike.
- Merge back to `develop` via PR (or `--no-ff` merge), then delete the branch. PRs target `develop` (the default branch), never `main`.
- `main` is releases only; it advances via release/hotfix merges from `develop`.

Details and exemptions (throwaway `prototype/*` and `research/*` branches): `docs/agents/git-workflow.md`.
