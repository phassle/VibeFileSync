# Untrusted-content proof: hostile fixtures (#170)

The adversarial ticket. Nothing here is a new defence — every mechanism
attacked below already landed under #150, #151, #153, #154, #155, #159.
This ticket's job was to attack them with hostile fixtures and prove, per
SPEC-135 User Stories 84-92 and the Testing Decisions paragraph, that
content cannot authorize capability — and to report honestly if any attack
succeeded or a defence was weaker than claimed.

## Where the tests live

- **Tier 1** (all of it — every attack in this ticket is pure computation):
  `shared/scripts/hostile-fixtures.test.mjs`, one section per SPEC-135
  hostile-fixture category, each attack fixture paired with an assertion on
  a NAMED error/reason string, never merely "it failed."
- **Tier 2**: `acceptance/cases/hostile/repo-injection-leaves-tree-unchanged.case.sh`
  — proves that a fixture repository saturated with prompt-injection payloads
  (in a Flow Definition, a README, an issue-shaped file, and an MCP-tool-
  result-shaped file) produces zero real side effects when the deterministic
  core reads it, and that env-absence (no model/browser-agent process or
  credential) holds throughout — building directly on `cases/ci-clean/`'s
  mechanism, per the ticket's explicit instruction.

## Category -> fixture -> named error map

| Category | Fixture | Named error/reason |
|---|---|---|
| Repository prompt injection | Flow `expect` text with `$(...)` shell substitution; a Flow field carrying a custom YAML tag (`!!python/object/apply:os.system`) | `expect contains "$(" ... no expression language or executable content`; `YamlSyntaxError` "custom/explicit YAML tags" |
| Application prompt injection | `contentSource: "application"` + privileged scopes + broad path | `trust-invariant.untrusted-content-with-privileged-identity`, `trust-invariant.untrusted-content-with-broad-filesystem` |
| MCP prompt injection | `contentSource: "mcp"` + privileged scopes; content source omitted entirely | `trust-invariant.untrusted-content-with-privileged-identity` (both cases — omission never reads as trusted) |
| Malicious branch/test names | Path-traversal/shell-metacharacter Flow id; JUnit `testcase name` with an injection payload; JUnit `<!ENTITY>`/processing-instruction | `isValidSemanticId` false + Flow `id` schema error; `parseJUnitXML` returns the name as inert literal text; `parseJUnitXML` throws "refuses XML containing an `<!ENTITY>` declaration" |
| Dependency hooks | Named Data Set field named `exec` holding a postinstall-shaped payload; a dependency's hook code trying to skip straight to the privileged lane | `field name "exec" is reserved for a command`; `trust-zone.illegal-transition.skip:contract-authoring->privileged-publication`; `trust-zone.privileged-lane-refuses-code` |
| Artifact/cache poisoning | `kind: "cache"/"path"/"command"/"url"` offered to the privileged lane; a `workflow_run`-triggered privileged job downloading a raw artifact; an unpinned/unallowlisted `uses:` reference | `trust-zone.privileged-lane-refuses-artifact`; `privileged-lane.low-trust-trigger-with-privileged-identity` + `privileged-lane.downloads-artifact-without-envelope-validation`; `action.not-pinned` + `action.not-allowlisted` |
| Secret patterns | A Named Data Set field value shaped like a live Stripe key (assembled at runtime, never a literal in source); the same value embedded in free-text diagnostics | `validateNamedDataSet` secret-value rejection; `redactSecretsInText` + `textStillContainsSecretShapedValue` returns `false` after redaction |
| Redirects/DNS changes | An environment reporting an exact allowlist match but `dnsRecheck: false` / `redirectRecheck: false` | `network.dns-recheck-enforced`, `network.redirect-recheck-enforced` |
| Metadata/internal reach | Allowlist origin `169.254.169.254` / `metadata.google.internal` / `10.0.0.5` / `192.168.1.1` | `classifyOriginRisk` -> `"metadata"`/`"internal"`; capability gate's `network.allowlist-entries-exact` |
| Privilege escalation | A `pull_request`/`workflow_dispatch` lane claiming the same privileged shape a `schedule`/`merge_group` lane is allowed; the `contract-authoring` zone holding a privileged credential; every illegal zone transition (all 22 of the 25 ordered pairs, enumerated) | `trust-invariant.untrusted-content-with-privileged-identity` via `checkLaneTrustInvariant`; `trust-zone.authoring-privileged-identity-forbidden`; `trust-zone.illegal-transition.{skip\|backward\|self-loop\|unknown-zone}` |
| Diagnostic scrub failure | A log carrying both a prompt-injection instruction and a secret-shaped value, with `verify` forced to report "still dirty"; an unverified screenshot; rich diagnostics attempted with `richDiagnosticsEnabled` omitted | `diagnostics.scrub-verification-failed`; `diagnostics.binary-scrub-unverified`; `diagnostics.rich-disabled-by-default` |

## Model/credential-absence proof

`acceptance/cases/ci-clean/subprocess-env-scrub.case.sh` (landed by #142)
already proves the exact property SPEC-135 names: "the harness verifies
that ordinary CI runs with all model and browser-agent processes and
credentials absent," via `env_absence_run_scrubbed` / `assert_no_credential_leak`
(a complete, deterministic proof) / `assert_no_forbidden_process_name_observed`
(a best-effort sampled observation, not a complete execution audit — see
`acceptance/lib/env_absence.sh` and DECISIONS.md §35). This ticket's
`acceptance/cases/hostile/repo-injection-leaves-tree-unchanged.case.sh`
builds on that exact mechanism against a fixture repository loaded with
hostile content, so the property is proven under adversarial content too,
not only in the clean case.

## The two flagged soft spots — verdict

### 1. `portfolio-reconciliation.mjs`'s `findDataSetIssues` silently skips when `resolveDataSet` is omitted

**Confirmed as coded** (`hostile-fixtures.test.mjs`, "SOFT SPOT" section):
calling `reconcilePortfolio(flows, {})` with a flow referencing a
nonexistent Named Data Set produces zero `unresolved-data-set-reference`
issues; the identical flow with a resolver supplied IS caught. The
function's own doc comment says this is deliberate ("omitting resolveDataSet
skips this check rather than guessing").

**Is it exploitable today? No — because nothing wires a real resolver in
yet.** Every current caller of `reconcilePortfolio`
(`ci-design.mjs`, `setup-review-packet.mjs`, `safe-execution-design.mjs`)
consumes `evaluatePortfolioApproval`'s *output*; none of them is the place
that calls `reconcilePortfolio` itself with a real, repository-backed
`resolveDataSet` — that wiring does not exist in this bundle yet (it is a
seam for whichever ticket builds the real qa-setup stage 6 driver). So
there is currently no live path where an attacker-controlled Flow file
reaches this code with the check silently disabled and consequences that
matter. **This is a real, currently-latent design risk, not a live
exploit.** Recommendation for whoever builds that wiring: make
`resolveDataSet` required (throw when absent, mirroring `reconcilePortfolio`'s
own fail-closed pattern for a missing `flows` array) rather than optional,
so a future caller cannot reproduce today's silent skip by simply forgetting
the option.

### 2. `safe-execution-design.mjs`'s trust-zone `context.zone` is optional; omitting it skips zone-transition and authoring-authority checks

**Confirmed as coded, and confirmed as a real gap distinct from what
`checkHardSecurityInvariant` covers.** `checkHardSecurityInvariant` always
runs regardless of zone and independently catches *untrusted content* paired
with a privileged identity/broad filesystem/unrestricted network. But
`checkAuthoringAuthority` (the `contract-authoring`-zone-must-never-hold-a-
privileged-identity rule) is a **categorical** rule that does not itself
look at content trust — it exists precisely because untrusted evidence
produced in that zone must never inherit write authority, independent of
what the content source happens to be. The soft-spot test constructs the
precise case that isolates this: `contentSource: "reviewed-base-branch"`
(deliberately *trusted*, so the always-on invariant stays silent) plus
privileged credential scopes plus **no `context.zone` at all**. The result:
zero `trust-zone`-category blockers. `checkVerificationCompute` (disposable/
unprivileged/pinned-commit for candidate verification) and
`checkPrivilegedLaneArtifact` (the privileged lane's code/artifact refusal)
are similarly zone-gated and skip the same way.

**Is it exploitable today? No, for the same reason as soft spot 1 — and
this is worth being precise about why.** Per #151's own landing note, "no
caller wires any of this into the qa-setup/qa-generate stages yet";
`context` is entirely caller-supplied evidence with no real adapter or
sandbox deriving it. `designExecutionProfile` (the one production call site)
is itself only called from `designSafeExecutionForApprovedFlows`, which is
in turn not yet wired to any real zone-classifying caller — so there is no
current code path where attacker-influenced content reaches this function
with `zone` dropped and a privileged credential attached for real
consequence. **Latent, not live** — but more serious in *kind* than soft
spot 1, because when a real caller (a future provider adapter, or
`qa-generate`'s repair/verification driver) is built, it is easy to imagine
it omitting `zone` on an early code path and silently losing three of
trust-zones.mjs's four checks with no error at all. Recommendation: make
`context.zone` required in `designExecutionProfile`/`checkTrustZoneForExecution`
(throw or produce a named blocker on absence) rather than treating an
unset zone as "this run isn't being zone-classified yet, so skip" — mirroring
how `checkHardSecurityInvariant` treats an unrecognized `contentSource` as
untrusted rather than unconstrained.

## Other findings from attacking these defences

- **`id-rules.mjs`'s `SEMANTIC_ID_RE` has no maximum length.** An
  attacker-controlled branch name made entirely of lowercase letters (e.g.
  300 `a` characters) passes `isValidSemanticId`. This does not let an
  attacker escape the character set (no path traversal, no shell
  metacharacter survives), so it does not by itself alter command
  construction or artifact paths — but an unbounded-length identifier fully
  within attacker control does reach filenames (`qa/flows/<id>.yaml`, etc.)
  with no length cap. Reported here as a minor, real gap (not one of the
  two flagged soft spots) rather than folded silently into "malicious names
  are rejected." A follow-up should add a maximum length to `SEMANTIC_ID_RE`
  or `isValidSemanticId`.
- No attack in this ticket's fixture set succeeded outright. Every category
  SPEC-135's Testing Decisions paragraph names was reproducible against the
  real, already-landed deterministic core and was refused with a named
  error, with the two caveats above (both explicitly pre-existing seams the
  landing notes already flagged, not new discoveries, but now proven with
  a concrete adversarial reproduction rather than left as a documented
  assumption).
