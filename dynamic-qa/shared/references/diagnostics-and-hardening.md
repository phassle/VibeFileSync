# Low-trust workflow hardening and diagnostics scrubbing (#155)

Completes #153's GitHub Actions adapter with the two properties
DESIGN-dynamic-qa-spec.md §11 requires beyond the advisory lane's own
hardening: **action/reusable-workflow allowlisting** (on top of #153's SHA
pinning) and **rich diagnostics that are off by default, failure-only,
scrubbed, size-bounded, narrowly visible, short-retained, and fail-safe on
scrub failure**.

## Modules

- `shared/scripts/secret-detection.mjs` (extended, not duplicated) — added
  `redactSecretsInText(text)` and `textStillContainsSecretShapedValue(text)`:
  free-text (global, non-anchored) variants of the exact same patterns
  `detectSecretValue` already judges a single scalar against. This is the
  one detector in the bundle; diagnostics scrubbing reuses it rather than
  inventing a second one.
- `shared/scripts/diagnostics-scrub.mjs` (new) — the scrub/suppress gate.
  `prepareDiagnosticForUpload(kind, diagnostic, opts)` is the single entry
  point; `buildDiagnosticsManifest(diagnostics, opts)` produces an exact,
  never-globbed artifact list plus a withheld list with reasons.
- `shared/scripts/workflow-hardening.mjs` (new) — completes #153's
  `checkWorkflowHardening` with `checkActionAndReusableWorkflowAllowlist`
  (pin + allowlist, both actions and reusable-workflow calls) and
  `checkPrivilegedLaneRefusesLowTrustBridge` (the pwn-request bridge shape:
  a privileged job on `pull_request_target`/`workflow_run`, or downloading a
  raw artifact with no visible Result Envelope validation reference).
  `assertPrivilegedJobRefusesArtifact` is a thin wrapper composing
  trust-zones.mjs's `checkPrivilegedLaneArtifact` (#151) — the sole gate,
  never re-implemented.

No edit was made to `github-actions-workflow.mjs` — `workflow-hardening.mjs`
imports only its already-exported `CHECKOUT_ACTION_SHA` /
`SETUP_NODE_ACTION_SHA` constants.

## Diagnostics: the two retention/visibility buckets

The five diagnostic kinds this ticket names split into exactly two buckets,
matching the spec's two named retention windows:

| Bucket | Kinds | Default | Failure-only | Retention |
| --- | --- | --- | --- | --- |
| **Rich** | log, dom, trace, screenshot | off | yes, when enabled | 7 days |
| **Bundle** | junit | always produced | n/a | 30 days |

Every kind is also size-bounded (`DEFAULT_SIZE_BOUNDS_BYTES`, a caller may
tighten, never loosen) and, for the rich bucket, narrowly visible: an
`audience` must be one of `ALLOWED_DIAGNOSTIC_AUDIENCES`
(`repository-maintainers`, `triage-owners`) — never `public` or absent.

## Redact vs. suppress — which failures do which, and why

**Redacts** (content still uploads, with the secret-shaped substring
replaced):
- A detected secret pattern inside log/DOM/trace/JUnit text —
  `redactSecretsInText` replaces it in place. This is the normal, expected
  path; almost every diagnostic that ever contains a stray token takes this
  path and uploads clean.

**Suppresses** (nothing uploads at all; the result is
`{ upload: false, reason, message: "diagnostic withheld" }`):
- `diagnostics.rich-disabled-by-default` / `diagnostics.rich-not-failure` —
  policy says this diagnostic should not exist yet.
- `diagnostics.audience-not-narrow` — no safe (narrow) audience to show it
  to.
- `diagnostics.scrub-verification-failed` — **the fail-safe gate.** After
  redaction, `textStillContainsSecretShapedValue` re-scans the output; if it
  still finds a secret-shaped substring, that is a scrub the module cannot
  trust, not a "mostly clean" result. There is no partial-credit path: a
  scrub that cannot be verified clean is treated identically to a scrub that
  never ran.
- `diagnostics.binary-scrub-unverified` — screenshots have no text
  representation this deterministic core can inspect (no image parser
  exists, and none will be added — that would be a dependency the run
  brief's zero-dependency rule forbids). Absent an explicit
  `verifiedRedacted: true` from an external, already-verified redaction
  pass, a screenshot is suppressed outright. This is why suppression, not
  redaction, is screenshots' only possible outcome from this module.
- `diagnostics.size-bound-exceeded` — an oversized artifact is suppressed,
  never silently truncated: a truncation could cut a redaction placeholder
  in half and misrepresent what was actually scrubbed.
- `diagnostics.missing-content` / `diagnostics.unknown-kind` /
  `diagnostics.missing-artifact-path` / `diagnostics.wildcard-artifact-path`
  — structural input problems, always suppressed, never silently accepted.

## Why "scrub failure suppresses upload" is structural, not a convention

`prepareDiagnosticForUpload` is the **only** function in this module that
can produce an `{ upload: true, artifact }` shape, and every one of its text
paths reaches that shape only after both `redactSecretsInText` AND
`textStillContainsSecretShapedValue` have run, in that order, with the
second one returning `false`. There is no branch that skips the re-scan, and
no other exported function hands back diagnostic content at all — a caller
cannot reach for raw/redacted bytes through a side door. The one
dependency-injection seam (`opts.verify`, defaulting to
`textStillContainsSecretShapedValue`) exists solely so this ticket's own
tests can force the "verification cannot trust this scrub" branch
deterministically, without needing a contrived regex gap; production
callers never override it.

## Action/reusable-workflow pinning and allowlisting

`checkActionAndReusableWorkflowAllowlist(yamlText, allowlist)` scans every
`uses:` reference (an action step and a reusable-workflow call share the
identical YAML shape, so one scanner covers both) and names, individually:
`action.not-pinned` (no full 40-hex commit SHA), `action.not-allowlisted`
(pinned, but the owner/repo identity was never approved), and
`action.sha-mismatch` (an approved identity re-pinned to an unapproved SHA —
a changed pin needs a fresh approval, not silent acceptance).
`DEFAULT_ALLOWLISTED_ACTIONS` currently names exactly the two actions #153
already uses (`actions/checkout`, `actions/setup-node`); a caller extends it
explicitly for its own approved additions rather than this module inventing
a broader default.

## Privileged lane vs. low-trust lane

`checkPrivilegedLaneRefusesLowTrustBridge(yamlText)` detects the classic
"pwn request" bridge shape in a whole workflow file: a privileged job
(secrets/OIDC/protected-environment/write-permission present) declared
alongside a `pull_request_target`/`workflow_run` trigger, or a privileged
job that downloads an artifact with no visible reference to Result Envelope
validation. `assertPrivilegedJobRefusesArtifact(isPrivilegedJob, artifact)`
is the structured-data form for a caller that already has an artifact
descriptor rather than YAML text — it composes trust-zones.mjs's
`checkPrivilegedLaneArtifact` directly.

The advisory PR lane itself (#153's `renderAdvisoryPullRequestLane`) is
proven, by this ticket's own test, to carry none of the six privileged
identities an unreviewed PR job must never receive (secret, OIDC, protected
environment, write permission, ambient/self-hosted runner, privileged
cache) — reusing `checkWorkflowHardening`, never re-scanning by hand.

## Seams for #156 and #170

- No required-lane or quarantine-lane renderer exists yet (still #153's
  scope, unbuilt) for `checkPrivilegedLaneRefusesLowTrustBridge` to be wired
  against in a real generated workflow beyond this ticket's own fixtures.
- No caller yet wires `prepareDiagnosticForUpload` /
  `buildDiagnosticsManifest` into a real generated workflow step, into
  `qa-generate/SKILL.md`'s step sequence, or into the Failure Evidence
  Bundle schema (§5.6) — this ticket built the gate, not its invocation
  site. A later ticket owns: (a) generating the actual `on: failure()`
  workflow step that collects raw diagnostics and calls this module before
  `actions/upload-artifact`, and (b) recording `retentionDays` on the
  rendered `actions/upload-artifact` step's `retention-days` input (this
  module returns the number; nothing renders it into YAML yet).
- `checkActionAndReusableWorkflowAllowlist`'s default allowlist only names
  #153's two actions — any later provider-adapter work (required/quarantine
  lanes, a second provider) adding a new action must extend the allowlist
  explicitly, not assume this default grows on its own.
- Diagnostics scrubbing is only proven against text this module was handed
  directly (caller-supplied `{ text }` / `{ bytes, verifiedRedacted }`) —
  no ticket yet wires a real Playwright trace/DOM/screenshot capture
  pipeline into that shape; that extraction step is a real integration a
  later ticket owns.

## `qa-generate/SKILL.md` wiring — not done in this edit

Per the run brief, this ticket does not edit `qa-generate/SKILL.md`. A later
coordinated edit should add a placeholder pointer to step 5 (the same step
that already notes the GitHub Actions adapter hand-off), reading:

> Diagnostics collection and scrubbing on failure (rich DOM/trace/screenshot
> capture, `shared/references/diagnostics-and-hardening.md`'s
> `prepareDiagnosticForUpload`/`buildDiagnosticsManifest` gate, #155) is not
> yet wired into this step sequence — a later coordinated follow-up owns
> generating the actual collect-then-scrub-then-upload workflow step.
