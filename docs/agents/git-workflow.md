# Git workflow: gitflow

This repo uses gitflow. Agents and humans alike follow it.

## Branches

- **`main`** — releases only. Never commit or push directly after the gitflow adoption commit; it advances via release/hotfix merges from `develop`.
- **`develop`** — the integration branch. All day-to-day work lands here via feature branches.
- **`feature/<kebab-name>`** — branched off `develop`, one per coherent change (code, docs, ADRs). Merge back to `develop` with `--no-ff` (or a PR), then delete the branch.
- **`release/*` / `hotfix/*`** — standard gitflow, used once there is something to release.

## Conventions

- ADRs and other docs follow the same flow: feature branch → `develop`.
- Links to repo files from the issue tracker (ADRs in resolution comments, etc.) point at `blob/develop/…`, not `blob/main/…` — `develop` always has the newest docs; `main` lags until release.
- Wayfinder **prototype branches** (`prototype/<name>`) and **research branches** (`research/<name>`) are exempt: they are throwaway primary sources kept out of the flow entirely — never merged, linked from their tickets.
- Branch names in kebab-case; commit messages in English.
