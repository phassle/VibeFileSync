# Research: safe execution for generated tests, agents, and CI

## Question

Which primary-source controls and documented failure modes should constrain
safe operation of `qa-setup` and `qa-generate`? This covers untrusted
application/browser/MCP content, generated code, dependency scripts,
isolation, egress, side effects, secrets, diagnostic output, CI identity,
forked pull requests, artifacts, and provider-native controls. Security
testing is out of scope; secure operation of the QA bundle is in scope.

## Executive finding

The bundle needs three deliberately separate trust zones:

1. **Authoring:** an agent reads Flow Definitions, repository content,
   browser state, and MCP output, then proposes a patch. Every source outside
   the operator-approved instructions is untrusted data. The agent gets only
   scoped read/write tools and no production authority.
2. **Verification:** generated tests and dependency hooks execute as
   untrusted code in a disposable, resource-limited sandbox. The sandbox gets
   only the declared non-production test targets and test data; outbound
   network is denied unless an explicit allowlist is required.
3. **Ordinary CI:** deterministic tests execute without an LLM or browser
   agent. An untrusted pull request gets no secrets and no write identity.
   Any later privileged action is a separate trusted workflow that never
   executes code or blindly consumes artifacts from the untrusted run.

GitHub's first-party Agentic Workflows preview independently uses the same
shape: agents have read-only tokens, declared and validated "safe outputs,"
secrets remain in isolated downstream jobs, and agent execution is
firewalled. This is useful architecture evidence, not a recommendation to
make that preview a dynamic-qa dependency
([About GitHub Agentic Workflows](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/about-github-agentic-workflows)).

Prompts, generated-code review, secret masking, browser origin filters, and
containers are useful layers, but none is sufficient as the security
boundary. Permissions, process/filesystem isolation, network policy, and
approval gates must enforce the boundary outside the model and test code.

## Primary-source findings

### 1. Browser, repository, and MCP content are hostile input to an agent

Indirect prompt injection is not a hypothetical edge case. OpenAI describes
the dangerous combination as untrusted external content plus an action such
as transmitting information, following a link, or invoking a tool; it also
notes that input-classifier or "AI firewall" approaches do not reliably catch
fully developed attacks
([Designing AI agents to resist prompt injection](https://openai.com/index/designing-agents-to-resist-prompt-injection/)).
The UK NCSC goes further: prompt injection may be inherent to current LLM
technology, so developers should not build critical controls on the
assumption that the model can always distinguish data from instructions
([Exercise caution when building off LLMs](https://www.ncsc.gov.uk/blog-post/exercise-caution-building-off-llms)).

The relevant boundary is wider than page text. Repository files, issue
bodies, test names and output, DOM/accessibility snapshots, API responses,
screenshots, downloaded files, and MCP tool results can all carry adversarial
instructions. Microsoft's Playwright MCP explicitly says it **is not a
security boundary**; its origin allow/block options do not cover redirects,
and its workspace file restriction is described as a convenience guardrail,
not secure isolation
([Playwright MCP](https://github.com/microsoft/playwright-mcp)).

MCP's own security guidance documents concrete failures relevant to this
bundle:

- a local MCP server is executable code with the client's privileges and can
  read files, exfiltrate data, or destroy host data unless sandboxed;
- OAuth metadata and redirects can produce SSRF into localhost, private
  ranges, or cloud metadata endpoints;
- broad scopes enlarge the impact of a stolen token and obscure the audit
  trail;
- token passthrough defeats audience and service boundaries; and
- consent must identify the exact client, scopes, redirect, and operation.

The prescribed controls include explicit command consent, restricted
filesystem/network/system access, HTTPS, private/link-local address blocking,
redirect validation, an egress proxy, progressive least-privilege scopes,
and separate audience-bound tokens
([MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices),
[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)).

**Implication for dynamic-qa:** agent instructions may describe policy, but
the runtime must independently enforce a fixed tool allowlist, path-scoped
filesystem access, network policy, and approval for consequential external
writes. `qa-setup` and `qa-generate` must treat observed app/repo/MCP content
as evidence, never as authority to expand scope, reveal data, add tools, run a
command, alter a Flow Definition, or contact another host.

### 2. Generated tests and dependency installation are arbitrary-code boundaries

Generated test code is executable code. So are common dependency hooks:

- npm runs dependency lifecycle scripts by default. `npm ci --ignore-scripts`
  suppresses package scripts, while current npm also supports a project-level
  `allowScripts` policy and `strict-allow-scripts`; explicitly invoked test
  scripts still run because they are the requested program
  ([npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/),
  [npm scripts](https://docs.npmjs.com/cli/using-npm/scripts/)).
- pip states that default installs involve running arbitrary distribution
  code and recommends hash-checking plus binary-only installs where applicable
  ([Secure installs](https://pip.pypa.io/en/stable/topics/secure-installs/)).
- Cargo compiles and executes package build scripts before building the
  package; a build script may perform any number of tasks
  ([Cargo build scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html)).

Lockfiles and hashes constrain *which* dependency is selected; they do not
make its code safe. Code review constrains what is accepted; it does not
protect the machine used for the first verification run. Installation,
build, migration, fixture, application startup, and generated-test commands
therefore belong in the same untrusted execution sandbox.

**Implication for dynamic-qa:** generation writes only a proposed patch in a
throwaway worktree. It must not auto-commit to a protected branch, change the
approved Flow Definition, add a dependency, or enable install hooks without
review. Verification begins from the approved lockfile, disables dependency
scripts where the existing stack permits, and records any unavoidable scripts
or new dependency as a review item. The sandbox remains mandatory either way.

### 3. Isolation must cover process, filesystem, credentials, and network

Disposable compute prevents persistence but does not by itself constrain the
current job. GitHub says standard hosted jobs use a new VM (except its
single-CPU container runner), while self-hosted runners lack the same clean
ephemeral guarantee and can be persistently compromised
([GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)).
GitHub recommends ephemeral self-hosted runners because one runner is assigned
one job, while also requiring operators to wipe the machine and export runner
logs themselves
([Self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)).

Containers add useful restrictions but are not an automatic boundary. Docker
documents that containers have outbound networking by default; the `none`
driver leaves only loopback, whereas the default bridge can reach external
services
([Networking overview](https://docs.docker.com/engine/network/),
[None network driver](https://docs.docker.com/engine/network/drivers/none/)).
Docker also documents rootless mode, its default seccomp allowlist, capability
dropping, and `no-new-privileges`; conversely, `--privileged` can permit a
container to take over the host. Access to the Docker daemon is itself highly
privileged because it can mount and alter the host filesystem
([Rootless mode](https://docs.docker.com/engine/security/rootless/),
[Seccomp](https://docs.docker.com/engine/security/seccomp/),
[docker container run](https://docs.docker.com/reference/cli/docker/container/run),
[Docker Engine security](https://docs.docker.com/engine/security/)).

**Provider-neutral execution profile:**

- fresh VM or one-job disposable runner; never a developer workstation;
- unprivileged user, no privilege escalation, conservative syscall profile,
  process/CPU/memory/file-size/time limits, and no host daemon/socket/device;
- repository/input mounted read-only where possible; writes limited to a
  fresh worktree plus declared output and temporary directories;
- no home-directory, SSH-agent, credential-store, cloud-metadata, sibling-job,
  production-config, or unrelated repository access;
- network denied by default. If the test needs a network, allow only exact
  non-production app/dependency origins through an enforcing proxy or network
  policy, re-check redirects and resolved addresses, and block loopback,
  private, link-local, metadata, and public Internet destinations except
  explicitly provisioned test services;
- fail closed if isolation or the target-environment identity cannot be
  proven; never fall back to the host or a broader network.

An application container and its real owned dependencies may share a private
test network. Third-party boundaries declared simulated in the Flow
Definition should terminate at local fakes. A boundary declared forbidden
must be blocked by policy, not merely omitted from test steps. A real
third-party sandbox, if explicitly approved as the outcome under test, needs
its own scoped test identity, idempotency/cleanup strategy, rate/concurrency
limit, and host allowlist. Production hostname/account/project identifiers
are positive deny conditions, but an exact test allowlist remains the main
control.

### 4. Secrets and diagnostics need data-flow control, not faith in masking

Any code running in a job can read credentials placed in its environment or
workspace. GitHub's compromised-runner reference explicitly notes that a
malicious process can read environment variables, on-disk generated scripts,
repository tokens, and reachable services; GitHub-hosted runners do not scan
downloaded dependencies for malicious code
([Compromised runners](https://docs.github.com/en/actions/concepts/security/compromised-runners)).

Masking is only a last line of defense. GitHub warns that secret redaction is
not guaranteed after transformations and only knows secrets used within the
current job; it recommends avoiding structured secret values
([Secrets](https://docs.github.com/en/actions/concepts/security/secrets),
[Secrets reference](https://docs.github.com/en/actions/reference/security/secrets)).
Agent tracing has the same issue: OpenAI's Agents SDK traces model and tool
inputs/outputs by default, labels them potentially sensitive, and exposes
controls to exclude that data or disable tracing
([Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)).

Browser and test evidence is especially rich:

- Playwright traces capture browser operations and network activity; its CI
  trace viewer exposes DOM snapshots and network requests
  ([Tracing](https://playwright.dev/docs/api/class-tracing),
  [Playwright best practices](https://playwright.dev/docs/best-practices)).
- Playwright's JUnit reporter adds output text as-is by default, so stdout and
  assertion messages can enter the XML report
  ([Reporters](https://playwright.dev/docs/test-reporters)).
- GitHub lists logs, core dumps, test results, screenshots, and binaries as
  ordinary workflow artifacts; anyone with repository read access can list
  repository artifacts through the API
  ([Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts),
  [Actions artifacts API](https://docs.github.com/en/rest/actions/artifacts)).

**Implication for dynamic-qa:** secrets are absent by default, not merely
masked. Named Flow Definition data refers to fixtures or secret handles, never
secret values. The authoring agent receives the minimum redacted context and
sensitive model/tool tracing is disabled. Test credentials, if unavoidable,
are non-production, short-lived, audience-bound, per-run, and available only
inside the step that needs them. The bundle must scrub and size-limit console
output, assertion messages, JUnit, DOM/HTML, HAR/network payloads, traces,
screenshots, videos, crash dumps, and agent transcripts before persistence.
Diagnostic capture defaults to failures only and excludes request/response
bodies and storage state unless the QA owner explicitly opts in.

Artifact upload is an allowlist of named scrubbed files, never a whole output
directory. GitHub's official upload action excludes hidden files by default
to avoid accidental sensitive uploads and supports per-artifact retention;
keep that default and set the shortest useful retention
([`actions/upload-artifact`](https://github.com/actions/upload-artifact)).
GitHub defaults workflow artifacts and logs to 90 days, configurable to 1–90
days for public repositories and 1–400 days for private repositories, so the
adapter must set an explicit shorter policy rather than inherit the default
([Artifact and log retention](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)).

### 5. Identity must be short-lived, audience-bound, and phase-specific

Provider-neutral rules:

- no ambient user credential, long-lived personal token, shared test account,
  or production identity;
- one identity per phase and target, with only required operations and data;
- short lifetime, audience/resource binding, revocation, and an attributable
  run identity in audit logs;
- read and write capabilities separated; external writes require explicit
  operator approval unless the Flow Definition names a pre-approved,
  reversible test-side effect;
- never forward one service's token through MCP to another service.

MCP requires resource indicators, audience validation, separate upstream
tokens, and forbids token passthrough
([MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)).
GitHub's equivalent is the per-job `GITHUB_TOKEN`, explicit `permissions`, and
OIDC exchange for short-lived cloud credentials. GitHub recommends granting
the token only the minimum access and notes that actions can access
`github.token` even when it is not explicitly passed
([Use `GITHUB_TOKEN`](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token),
[Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).
OIDC removes long-lived cloud secrets, but the cloud trust policy must constrain
which repository/ref/environment claims can receive a token
([OIDC in cloud providers](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers)).

## GitHub Actions adapter guidance

### Untrusted pull-request lane

Use `pull_request` for generated regression tests. For fork pull requests,
GitHub withholds Actions secrets and normally downgrades `GITHUB_TOKEN` to
read-only; repository settings can dangerously override both properties
([Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)).
The generated workflow should require approval for all external contributors
where policy permits, but approval is a compute-abuse gate, not a declaration
that their code is safe.

Minimum workflow shape:

- top-level `permissions: {}` or the smallest explicit set; a checkout job
  usually needs only `contents: read`;
- `actions/checkout` with `persist-credentials: false`, because checkout
  otherwise persists the token for later commands in the job
  ([`actions/checkout`](https://github.com/actions/checkout));
- no repository, organization, environment, cloud, package-publish, browser
  login, or third-party secrets;
- hosted fresh VM by default. Self-hosted only when the customer supplies a
  one-job disposable runner with no internal/metadata reachability and no
  cross-job state;
- test command inside the provider-neutral sandbox, with explicit timeout,
  concurrency, resource, and egress controls;
- sanitized JUnit/summary plus failure-only scrubbed diagnostics; explicit
  short artifact retention;
- cache keys scoped by trust level, platform, and lockfile. Never store
  secrets in caches and never execute a downloaded artifact as a privileged
  handoff. GitHub warns that fork workflows can read base-branch cache content
  and makes low-trust access read-only to reduce cache poisoning
  ([Dependency caching](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching)).

Never interpolate issue, pull-request, branch, commit, test, or application
content directly into an inline shell program. GitHub documents branch names,
PR titles/bodies, labels, and similar context fields as untrusted and shows
how expression substitution becomes shell injection; pass data through a
quoted environment variable or a purpose-built action instead
([Script injections](https://docs.github.com/en/actions/concepts/security/script-injections)).

### Privileged lane

Do not use `pull_request_target` to check out or execute pull-request code.
That event runs with the base repository's token/secrets; GitHub documents the
checkout-and-run pattern as a "pwn request." The same risk exists when a
privileged `workflow_run`, issue-comment, or other trusted event downloads and
executes fork code or artifacts
([Securely using `pull_request_target`](https://docs.github.com/en/actions/security-for-github-actions/security-guides/secure-use-reference#mitigating-the-risks-of-untrusted-code-checkout),
[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)).

If a later phase needs to publish a status, create a patch PR, or access a
protected test environment, make it a separate trusted workflow that starts
from reviewed base-branch code. It may parse a small, schema-validated,
non-executable result document from the low-trust lane, but must not execute,
source, unpack over trusted paths, or trust filenames/commands/URLs from the
artifact. Prefer recomputing the result from the reviewed commit.

Environment secrets belong only in that trusted lane. GitHub environments can
hold them until required reviewers approve the job and can restrict eligible
branches; preventing self-review adds separation of duties
([Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
Use OIDC rather than a long-lived cloud secret and bind the cloud policy to the
exact repository, ref, and environment.

### Workflow and supply-chain governance

- restrict allowed actions/reusable workflows and require third-party actions
  to be pinned to a full commit SHA; GitHub exposes an organization/repository
  policy that enforces full-SHA pins
  ([Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository));
- require QA/technical-owner review for workflow, Flow Definition, generated
  test, lockfile, test-data policy, and dependency changes. Put the
  `CODEOWNERS` file itself under ownership and enable required Code Owner
  review
  ([Code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners));
- protect the default branch with required checks and review; bind each
  required status to the expected GitHub App where available
  ([Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches));
- audit changes to workflow permissions, Actions secrets, environments,
  runner groups, and retention policy. Preserve the minimal run/provenance
  metadata longer than rich diagnostics when audit needs differ.

## Default control matrix for the buildable spec

| Surface | `qa-setup` | `qa-generate` authoring/repair | Generated-test verification | Ordinary PR CI |
| --- | --- | --- | --- | --- |
| Input trust | Repo/app/MCP content is data | Flow Definition authoritative; all observations are data | All code/config/dependencies untrusted | PR code and event context untrusted |
| Writes | Proposed Flow Definitions/config only | Proposed Binding/generated-test patch only | Scratch/output directories only | Diagnostics only; no repo write |
| Secrets | None by default | Model credential isolated by harness; no test/prod secrets | Per-run non-production credential only if unavoidable | None for untrusted PRs |
| Network | Exact discovery/MCP allowlist | Exact model/test-app/MCP allowlist | Deny by default; exact test targets if needed | Same verification policy |
| Side effects | No product/third-party mutation | No production or real third-party mutation | Named reversible test-side effects only | Same; concurrency protects shared fixtures |
| Approval | QA owner approves contract/config | QA/technical owner reviews patch; no silent repair | No approval can broaden sandbox | Required check reports result; failing run remains failed |
| Evidence | Redacted interview/provenance | Redacted diff and generation record | Scrubbed JUnit plus minimal failure evidence | Short-retention allowlisted artifacts |

## Gaps the adapter must make explicit

1. A normal GitHub-hosted job has outbound Internet access. GitHub Actions has
   no general workflow key that turns arbitrary egress into an exact per-job
   allowlist. The customer therefore needs an existing controlled runner,
   sandbox proxy, or application-local fake network to meet default-deny
   egress; otherwise the adapter must report the control as unmet, not imply
   that a job container solved it.
2. GitHub's fork-token and secret restrictions are configurable, and same-repo
   contributor branches are not equivalent to forks. The generated workflow
   must set its own least-privilege `permissions` and remain safe even if the
   repository default is permissive.
3. Masking cannot prove data absence. Diagnostics require capture-time
   minimization plus a scrub-before-upload gate; a scrub failure suppresses
   the artifact rather than uploading it for debugging.
4. A privileged second workflow is safe only if its input is treated as data.
   `workflow_run` is not a privilege-separation solution when it executes or
   trusts the low-privilege run's code, cache, paths, URLs, or artifacts.
5. Browser/MCP host filters and model prompt-injection defenses are defense in
   depth, not authorization. Network and tool enforcement remains outside the
   agent.

## Recommended decisions for the threat-model ticket

1. Define the three trust zones above as a non-negotiable architecture and
   forbid one job/session from combining untrusted code or content with a
   privileged identity.
2. Make safe execution a capability check during `qa-setup`. A flow stays
   inactive when its declared environment, boundaries, test data, egress, or
   diagnostic handling cannot meet policy; the skill never silently weakens
   the flow or falls back to production.
3. Require a machine-readable execution profile per generated suite: allowed
   paths, commands, environment identity, origins, side effects, credentials,
   resource limits, evidence classes, and retention. Provider adapters may
   strengthen but not weaken it.
4. Treat generation and repair as proposal-only. Approval covers generated
   test/dependency/workflow changes; only the QA owner may change expected
   outcomes, tolerances, mock boundaries, quarantine, or required-check
   policy.
5. Split evidence into a durable minimal provenance/result record and
   short-lived rich diagnostics. Default rich evidence to failure-only,
   scrubbed, least-readable, and explicitly retained for the minimum useful
   period.
6. For GitHub Actions, standardize the low-trust `pull_request` lane, explicit
   token permissions, non-persisted checkout credentials, hosted ephemeral
   runners, full-SHA actions, external-contributor approval, no secrets,
   sanitized short-lived artifacts, and a separately reviewed privileged lane
   when one is unavoidable.

## Primary sources

- [OpenAI: Designing AI agents to resist prompt injection](https://openai.com/index/designing-agents-to-resist-prompt-injection/)
- [UK NCSC: Exercise caution when building off LLMs](https://www.ncsc.gov.uk/blog-post/exercise-caution-building-off-llms)
- [Model Context Protocol: Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [Model Context Protocol: Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Microsoft: Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [OpenAI Agents SDK: Tracing](https://openai.github.io/openai-agents-python/tracing/)
- [Docker: Engine security](https://docs.docker.com/engine/security/)
- [Docker: Rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Docker: Seccomp profiles](https://docs.docker.com/engine/security/seccomp/)
- [Docker: Networking overview](https://docs.docker.com/engine/network/)
- [npm: `npm ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
- [pip: Secure installs](https://pip.pypa.io/en/stable/topics/secure-installs/)
- [Cargo: Build scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html)
- [GitHub Actions: Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub: About Agentic Workflows](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/about-github-agentic-workflows)
- [GitHub Actions: Script injections](https://docs.github.com/en/actions/concepts/security/script-injections)
- [GitHub Actions: Compromised runners](https://docs.github.com/en/actions/concepts/security/compromised-runners)
- [GitHub Actions: `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token)
- [GitHub Actions: Secrets](https://docs.github.com/en/actions/concepts/security/secrets)
- [GitHub Actions: Dependency caching](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching)
- [GitHub Actions: Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
- [GitHub Actions: Hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub Actions: Self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [GitHub Actions: Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub Actions: OIDC in cloud providers](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers)
- [GitHub: `actions/checkout`](https://github.com/actions/checkout)
- [GitHub: `actions/upload-artifact`](https://github.com/actions/upload-artifact)
- [Playwright: Tracing](https://playwright.dev/docs/api/class-tracing)
- [Playwright: Reporters](https://playwright.dev/docs/test-reporters)
