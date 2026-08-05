# Research: `ci-regression-integration`

## Question

What are the proven patterns for running a generated regression suite in a
customer's CI (GitHub Actions first, but harness-agnostic): triggering (every
PR, merge queue, nightly), environment provisioning (ephemeral envs,
containers, seeded data), quarantining flaky tests, reporting failures back to
an AI agent for triage, and keeping suite runtime acceptable? Include how
greenfield (no CI yet) vs brownfield (existing CI) setups differ. Part of #95.

## Primary-source findings

### Triggering: PR, merge queue, and nightly are three different jobs, not one

GitHub Actions' [events-that-trigger-workflows
docs](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)
define four distinct triggers relevant here, and they are not interchangeable:

* **`pull_request`** fires on `opened`/`synchronize`/`reopened` by default and
  is the natural home for a fast, PR-blocking slice of the suite. It does
  **not** fire while the PR has a merge conflict, and its filters
  (`branches`/`branches-ignore`, `paths`/`paths-ignore`) combine with **AND**
  semantics when both are set.
* **`merge_group`** fires when a PR is added to a merge queue and is a
  *separate* event stream from `pull_request`/`push`. GitHub is explicit that
  this is not optional wiring: "If your repository uses GitHub Actions to
  perform required checks on pull requests in your repository, you need to
  update the workflows to include the `merge_group` event as an additional
  trigger. Otherwise, status checks will not be triggered when you add a pull
  request to a merge queue" ([Merge group webhook event and GitHub Actions
  workflow
  trigger](https://github.blog/changelog/2022-08-18-merge-group-webhook-event-and-github-actions-workflow-trigger/),
  [events-that-trigger-workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)).
  The merge queue builds a temporary combined-changes branch
  (`gh-readonly-queue/<base>/pr-<n>-<sha>`) and the `merge_group` webhook's
  `checks_requested` action tells any consumer, including Actions, which
  `head_sha` needs status reported before the merge queue will proceed
  ([Managing a merge
  queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
  A merge queue can also run checks through **any** CI provider, not just
  Actions, provided that provider consumes the same webhook/commit-status
  contract (same source).
* **`schedule`** uses five-field POSIX cron (`minute hour day month
  day-of-week`, e.g. `"30 5 * * 1-5"`) and is the correct place for the full,
  slow suite run nightly rather than on every push. Scheduled workflows have a
  practical floor — GitHub enforces a minimum interval and can delay runs
  under load — and in public repositories a schedule is auto-disabled after 60
  days of repository inactivity, both documented caveats to account for when a
  customer's repo goes quiet
  ([events-that-trigger-workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)).
* **`workflow_dispatch`** is the manual/on-demand escape hatch (UI, API, or
  `gh workflow run`), useful for an agent or a human to force a full suite run
  outside the normal cadence, with typed `inputs` (max 25 top-level
  properties) (same source).

**Required-check wrinkle that affects triggering choice:** GitHub only lets a
repo admin mark a check as *required* in branch protection if that check has
already reported a run on the protected branch. Actions workflows that fire
only on `pull_request` never produce a status on the base branch itself, so
they can be invisible in the required-checks picker until a `push`-triggered
run (or, in practice, a `merge_group`-triggered run) has reported once
([Troubleshooting required status
checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks),
[About protected
branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
This is a common brownfield gotcha when adding a new generated-suite job and
expecting to mark it required immediately.

### Environment provisioning: service containers for dependencies, ephemeral envs for full-stack previews

For seeded, reproducible dependencies (databases, caches, message brokers),
GitHub Actions' native primitive is `jobs.<job_id>.services`: Docker
containers attached to the job's network so steps can reach them by the
service label as hostname, with `ports` mapping container ports to the runner
host. Service containers require a Linux runner (GitHub-hosted: Ubuntu; or a
Linux self-hosted runner with Docker installed) ([About service
containers](https://docs.github.com/en/enterprise-server@2.22/actions/using-containerized-services/about-service-containers),
[Communicating with Docker service
containers](https://docs.github.com/actions/tutorials/communicating-with-docker-service-containers)).
This is the right level for "spin up Postgres/Redis with seed data and run
the suite against it" — the seeding itself is then a normal setup step
(migration + fixture load) before the test job runs, not something GitHub
Actions provides directly.

For full ephemeral *application* environments (a live preview per PR rather
than just a dependency container), the pattern documented by ephemeral-environment
vendors (a first-party engineering source for the technique, called out here
as vendor-specific rather than a GitHub Actions primitive) is two paired
workflows: one triggered on PR open/synchronize that provisions/updates a
disposable environment and posts its URL back to the PR, and a second
triggered on PR close that tears it down ([CI/CD: Ephemeral environments using
GitHub
Actions](https://developer.humanitec.com/guides/developers/ci-cd/ephemeral-environments/)).
GitHub's own [Environments
concept](https://docs.github.com/en/actions/deployment/targeting-different-environments)
(protection rules, environment URLs surfaced on the PR) is the first-party
scaffolding this pattern hangs off of, but the create/destroy lifecycle itself
is application-specific, not a built-in Actions feature — treat vendor guides
here as a pattern reference, not a spec.

### Quarantining flaky tests: retries classify, annotations quarantine

Playwright's [retries
docs](https://github.com/microsoft/playwright/blob/main/docs/src/test-retries-js.md)
define three outcomes per test: **passed** (first try), **flaky** (failed then
passed on retry), **failed** (failed on every retry). `retries` is set
globally (`defineConfig({ retries: 3 })`), per file/describe block
(`test.describe.configure({ retries: 2 })`), or via `--retries=3` on the CLI;
`testInfo.retry` (0 on the first attempt) is available in tests, hooks, and
fixtures to branch behavior on retry (e.g. clear server state before retrying).
Playwright's own guidance is explicit that retries are a stability buffer, not
a fix: "Use retries on CI to prevent intermittent infrastructure noise from
breaking your pipeline, while you fix the underlying cause" — a test marked
flaky is a signal to investigate, not a status to accept long-term (same
source).

Retries answer "should this run's result count as green"; they don't answer
"should this known-bad test run at all." For that, Playwright's [test
annotations](https://playwright.dev/docs/test-annotations) give two distinct
primitives worth distinguishing for a quarantine policy:

* `test.fixme()` — the test is not run at all (use for a test that is slow,
  crashes, or is otherwise unsafe to execute right now).
* `test.skip()` — the test is not run, used for "not applicable in this
  configuration" rather than "known broken."
* `test.fail()` — the test *is* run, and Playwright asserts it fails; useful
  for a documented-broken test you still want executed as a regression check
  on the failure itself.

Playwright's docs explicitly recommend commenting *why* an annotation is
applied. There is no first-party "quarantine bucket that still runs
non-blockingly and reports separately" reporter built into Playwright itself
— that is a process built on top of `fixme`/`fail` plus a tracked
ticket/label per quarantined test, or a separate CI job that runs quarantined
tests with `continue-on-error: true` so the workflow overall still succeeds
while the flaky results remain visible.

### Reporting failures back to an agent: JUnit XML + Actions annotations + Checks API, in order of directness

Three composable, primary-source-documented layers exist for surfacing a
failure in a form an agent can consume without scraping human-oriented log
text:

1. **Structured per-test output.** Playwright's [JUnit
   reporter](https://playwright.dev/docs/test-reporters) (`--reporter=junit`,
   or `reporter: [['junit', { outputFile: 'results.xml' }]]` in config, or the
   `PLAYWRIGHT_JUNIT_OUTPUT_NAME` env var) produces standard JUnit XML: one
   record per test with pass/fail/skipped status and failure message/stack.
   This is the harness-agnostic contract — pytest, Jest, and most CI-aware
   harnesses can emit the same JUnit XML shape, so an agent-facing parser only
   has to understand one format across harnesses. Upload it as a workflow
   [artifact](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
   (`actions/upload-artifact@v4`) so it's addressable by the triaging agent via
   the Actions API after the run, independent of log retention.
2. **Inline annotations during the run.** GitHub Actions workflow commands
   (`::error::`, `::warning::`) and the more powerful **problem matcher**
   mechanism let a step's raw stdout get turned into first-class GitHub
   annotations: "A problem matcher is a JSON document that contains one or
   more regular expressions that match your tool's output," registered with
   `::add-matcher::path-to-matcher.json`
   ([actions/toolkit problem-matchers
   doc](https://github.com/actions/toolkit/blob/main/docs/problem-matchers.md)).
   This is the mechanism that puts a failing assertion's file/line directly on
   the PR diff, which is useful context for an agent doing point-fix triage
   even before it opens the JUnit XML.
3. **A run-level, markdown summary.** `GITHUB_STEP_SUMMARY` is a per-step file
   path; content written to it (Markdown, `>> $GITHUB_STEP_SUMMARY`) is
   rendered on the run summary page, with per-step isolation and a 1 MiB
   per-step cap ([Workflow commands for GitHub
   Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)).
   Writing a compact "N passed / M failed / K flaky, see artifact for detail"
   summary here gives a cheap, agent-fetchable top-level signal
   (`gh run view --log` or the Actions API) without needing to download and
   parse the full JUnit XML for the common case.
4. **The Checks API, for a genuinely custom UI.** If richer structured
   feedback than annotations/step-summaries is wanted (e.g. a dedicated
   "AI-Regression-Suite" check with its own annotations and a custom
   `output.text` body), GitHub's [Checks
   API](https://docs.github.com/rest/guides/getting-started-with-the-checks-api)
   lets a GitHub App create a check run with structured `annotations`
   (`path`, `start_line`/`end_line`, `annotation_level`,
   `message`)([REST API endpoints for check
   runs](https://docs.github.com/en/enterprise-server@3.12/rest/checks/runs)).
   This requires `checks:write` permission and is meaningfully more setup than
   options 1–3 (a GitHub App/token with that scope, versus just steps in the
   existing workflow), so it is the escalation path once JUnit + annotations +
   summary prove insufficient, not the default.

For an agent that needs to *act* on failures (open a fix PR, re-run a shard),
the JUnit XML artifact is the most reliable single source: it is structured,
harness-portable, and durable via `actions/upload-artifact`, whereas
annotations and step summaries are read-oriented UI surfaces primarily meant
for humans on the PR.

### Keeping runtime acceptable: shard the suite, don't just add workers

Playwright's own [CI
docs](https://playwright.dev/docs/ci) recommend `workers: 1` (or
`process.env.CI ? 1 : undefined`) inside a single CI job "to prioritize
stability and reproducibility," and explicitly say that **wider parallelism
should come from sharding across CI jobs, not from more workers inside one
job**. The sharding mechanism is `--shard=x/y`
([Sharding](https://playwright.dev/docs/test-sharding)): pass
`--shard=1/4`, `--shard=2/4`, etc. on `y` separate job invocations. Without
`fullyParallel: true`, sharding partitions at the *file* level, so uneven file
sizes cause imbalanced shards; with `fullyParallel: true`, individual tests
are distributed instead, giving more even shards (same source). GitHub
Actions' native fan-out for this is
[`strategy.matrix`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)
— e.g. `matrix: { shard: [1, 2, 3, 4] }` combined with `--shard=${{
matrix.shard }}/4` — capped at 256 generated jobs per matrix and controllable
via `max-parallel` if the runner pool is limited. To get one combined report
back from N shard jobs, configure `reporter: process.env.CI ? 'blob' :
'html'` per shard, then run `npx playwright merge-reports --reporter html
./all-blob-reports` in a final job after downloading each shard's blob
artifact (same source, [Sharding](https://playwright.dev/docs/test-sharding)).

Playwright explicitly advises **against** caching browser binaries in CI:
"Caching browser binaries is not recommended, since the amount of time it
takes to restore the cache is comparable to the time it takes to download the
binaries" ([CI docs](https://playwright.dev/docs/ci)) — cache dependency
installs (`npm ci` cache) instead, not the browser download step.

For selective/impacted runs rather than always running the full suite,
`on.<push|pull_request>.paths`/`paths-ignore` filters
([events-that-trigger-workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows))
are the first-party mechanism to skip the whole workflow when the change
can't affect the covered surface (e.g. a docs-only PR). True test-impact
analysis (mapping a diff to the specific subset of generated tests it could
affect) has no first-party GitHub Actions primitive; it is an
application-level responsibility for the suite generator itself, out of scope
for this ticket's CI-wiring question and worth a separate research item if
pursued.

### Greenfield vs brownfield: the difference is which invariant you're protecting

| | Greenfield (no CI yet) | Brownfield (existing CI) |
| --- | --- | --- |
| **What's being protected** | Nothing yet — there is no existing merge gate to break. | Existing required checks and branch-protection rules that the team already depends on. |
| **Rollout shape** | Introduce CI and the generated suite together, as one onboarding step. The suite's PR-triggered job can be `required` from day one since there is no prior expectation to preserve. | Add the suite as a **new**, separate job/workflow alongside existing ones. Do not touch existing required-check names or existing workflow files' triggers unless necessary. |
| **Triggering** | Wire `pull_request` (fast subset) and `schedule` (full suite, nightly) immediately; add `merge_group` only if/when a merge queue is adopted. | Same trigger set, but if the repo already uses a merge queue, the new workflow **must** add `merge_group` as a trigger from the start, or it silently never gates the queue ([Merge group webhook event](https://github.com/blog/changelog/2022-08-18-merge-group-webhook-event-and-github-actions-workflow-trigger/) — see caveat above). |
| **Required-check status** | Mark the suite's check required as soon as it has one green run on the base branch — no migration risk. | Land the job as **non-required/non-blocking** first (visible on PRs, not gating merges) for a burn-in period so its own flakiness doesn't immediately break an established team's merge flow; promote to required only after the false-positive rate is acceptable. This mirrors the general GitHub guidance that a check must have already reported on the protected branch before it can even be selected as required ([Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)). |
| **Environment provisioning** | Design service containers / ephemeral envs from scratch to match the generated suite's needs — no legacy constraints. | Reuse whatever the existing CI already provisions (existing service containers, existing seed-data scripts, existing preview-env tooling) rather than stand up a second, divergent environment story; inventory the existing workflow files first. |
| **Reporting** | Any of JUnit XML + annotations + step summary can be adopted wholesale as the agent-facing contract. | Check whether an existing check-run/annotation convention (or a Checks-API-backed app) is already in place and conform to it, rather than introducing a second, competing failure-reporting channel. |

## Recommendation

1. **Two-tier triggering, from day one, on every rollout.** A fast job on
   `pull_request` (the generated suite's PR-safe subset) plus a `schedule`
   job that runs the full suite nightly. Add `merge_group` as an additional
   trigger the moment a merge queue exists or is adopted — this is a common,
   easy-to-miss gap per GitHub's own migration note, not an edge case.
2. **Use `services` + seed scripts for data dependencies; treat full
   ephemeral app previews as an optional, later addition**, not a prerequisite
   for shipping the suite. Most generated-regression-suite runs only need a
   database/cache with seeded fixtures, which `jobs.<job_id>.services` covers
   natively; reserve a full preview-environment-per-PR pattern for suites that
   specifically need to exercise a live deployed app.
3. **Quarantine with `test.fixme()`/`test.fail()` plus a tracked issue per
   quarantined test, backed by `retries` for transient infra noise** —
   don't conflate the two. Retries paper over infrastructure jitter; a test
   that is *known* broken should be explicitly annotated and tracked, not left
   to eat a retry budget silently.
4. **Standardize the agent-facing failure contract on JUnit XML artifact +
   Actions annotations + a compact step summary**, in that order of
   reliability for an automated triage agent. Reserve the Checks API for a
   dedicated custom UI only if that JUnit+annotations+summary stack proves
   insufficient — it costs a GitHub App/token with `checks:write` that the
   simpler stack doesn't need.
5. **Shard, don't over-parallelize a single job.** Use `strategy.matrix` +
   Playwright `--shard=x/y` (with `fullyParallel: true` for balance) for the
   PR-fast subset once it's large enough to matter, and merge blob reports
   in a final job so the agent/human still sees one report, not N.
6. **Greenfield: ship CI and the suite together, required from the start.
   Brownfield: land as a new, non-required job first, add `merge_group` if a
   queue exists, and promote to required only after a burn-in period** — this
   is the single highest-leverage difference between the two rollouts, since
   the brownfield failure mode (breaking an established team's merge gate
   with a fresh, still-flaky generated suite) is the one most likely to get
   the whole effort reverted by an annoyed customer.
