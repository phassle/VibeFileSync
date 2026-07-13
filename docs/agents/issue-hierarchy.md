# Issue hierarchy: Idea > Epic > Feature > Issue

This repo tracks work as a four-level hierarchy of GitHub issues. All content is written in English regardless of the language a discussion happened in.

| Level | Label | Created by | Purpose |
|---|---|---|---|
| **Idea** | `type: idea` | Filed by hand (form: `.github/ISSUE_TEMPLATE/idea.yml`) or by `/wayfinder` | A loose, unscoped concept — a problem space or opportunity, not yet a plan |
| **Epic** | `type: epic` | Filed by hand (form: `epic.yml`), optional | Groups several related Features when the scope is too large for one spec |
| **Feature** | `type: feature` | Always produced by `/to-spec` | A spec/PRD for one piece of buildable work |
| **Issue** | `type: issue` | Always produced by `/to-tickets` | A tracer-bullet ticket, sized to one agent session |

**Epic is optional** — a Feature may sit directly under an Idea (or with no parent at all) when the work doesn't need a grouping layer. Feature and Issue are never optional in name only: `to-spec` always yields exactly one Feature, `to-tickets` always yields one or more Issues.

## How levels link

GitHub's native **sub-issues** relationship represents parent/child, top to bottom (Idea → Epic → Feature → Issue). This repo's owner account is a personal (User) account, not an Organization, so GitHub's native custom **Issue Types** field is unavailable here (`issueTypes` on the repo returns null — verified via the GraphQL API on 2026-07-13) — the `type: *` labels above are the substitute for that field. If this repo ever moves under an Organization, prefer migrating to native Issue Types and dropping the labels.

Blocking *within* a level (e.g. one Issue gated on another) still uses native issue dependencies — see `issue-tracker-github.md`'s Wayfinding operations section — sub-issues encode the hierarchy, dependencies encode ordering.

## Where `/wayfinder` fits

A `/wayfinder` map can be chartered directly from an Idea when the route to a Feature isn't clear yet — the map's tickets (`wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task`) are decision-tickets that resolve *before* a Feature is spec'd, not a substitute for the Feature/Issue levels. Once a wayfinder map's frontier is clear, hand off to `/to-spec` to produce the Feature(s).

## Templates

`.github/ISSUE_TEMPLATE/{idea,epic,feature,issue}.yml` — GitHub issue forms for each level, plus `config.yml`. `feature.yml` and `issue.yml` mirror the body templates already embedded in the `to-spec` and `to-tickets` skills, so a hand-filed issue and an agent-generated one look the same.
