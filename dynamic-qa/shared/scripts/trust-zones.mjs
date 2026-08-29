// dynamic-qa/shared/scripts/trust-zones.mjs
//
// Trust Zones and the hard security invariant (ticket #151,
// DESIGN-dynamic-qa-spec.md §11 "Safe execution", SPEC-135.md User Stories
// 58, 84-90, and the Implementation Decisions on Trust Zones). #150 built
// the Execution Profile contract, the Capability Gate, and the sole
// activation entry point (`activationDecision`) that decides whether a
// *single* Flow may run. This module builds the layer #150 explicitly left
// open: which of four isolated Trust Zones a given run happens in, which
// zone-to-zone transitions are legal, and the checkable property that
// attacker-controlled content or executable code never combines with
// privileged identity, broad filesystem access, or unrestricted network
// reach — regardless of which zone it happens in.
//
// This module does not re-validate an Execution Profile (execution-profile.mjs
// already does that) or re-run the Capability Gate (capability-gate.mjs
// already does that). It answers a different, additional question: *is
// this zone assignment itself legal*, independent of whether the profile
// bound to it is well-formed. A caller wires both: validate/gate the
// profile as #150 already does, and separately run this module's checks
// against the zone the run is assigned to and the content/identity/
// filesystem/network shape of that assignment.
//
// The four Trust Zones (DESIGN-dynamic-qa-spec.md §11), in the one legal
// direction evidence and artifacts may flow between them:
//
//   1. contract-authoring        — fresh worktree, proposals only, no
//                                   production/publish identity.
//   2. candidate-verification    — generated code is arbitrary code; runs
//                                   on a disposable, unprivileged runner,
//                                   pinned to the source commit under test.
//   3. low-trust-ci               — no model/agent, no write identity/OIDC/
//                                   ambient secret; ordinary PR/nightly runs.
//   4. privileged-publication     — separately reviewed base-branch code and
//                                   protected identity; accepts only a
//                                   validated Result Envelope or an
//                                   independent recompute, never low-trust
//                                   code or artifacts.
//
// Legal transitions are exactly the forward, adjacent steps of that
// pipeline: authoring -> verification -> low-trust-ci -> privileged
// publication. Every other ordered pair — skipping a stage forward,
// moving backward, or staying in place — is illegal, and
// `checkZoneTransition` names it explicitly rather than returning a single
// generic "illegal" flag, so a caller (and a test) can assert on the exact
// rejected transition.
//
// Caller-supplied evidence, following #150's established pattern
// (environment evidence for the Capability Gate is entirely caller-supplied
// — no ticket yet derives it from a real sandbox or CI adapter): this
// module does not discover a run's content source, credential scopes, path
// allowlist, network shape, or compute disposability from anywhere real.
// A caller (a future provider adapter or verification harness) supplies
// them as plain data. This module only says what to reject, not how the
// evidence was gathered.

import { classifyOriginRisk } from "./execution-profile.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function namedIssue(error, message) {
  return { error, message };
}

// --- the four Trust Zones and the one legal pipeline direction ------------

export const TRUST_ZONES = Object.freeze([
  "contract-authoring",
  "candidate-verification",
  "low-trust-ci",
  "privileged-publication",
]);

const LEGAL_TRANSITIONS = new Set([
  "contract-authoring->candidate-verification",
  "candidate-verification->low-trust-ci",
  "low-trust-ci->privileged-publication",
]);

/**
 * Checks whether moving evidence/artifacts/authority from Trust Zone `from`
 * to Trust Zone `to` is legal. The only legal transitions are the three
 * forward, adjacent steps of the fixed pipeline
 * (`TRUST_ZONES.join(" -> ")`). Every other pair — an unknown zone name, a
 * self-loop, a backward move, or skipping a stage forward (most notably
 * `contract-authoring -> privileged-publication`, which would let untrusted
 * evidence inherit write authority directly) — is illegal and named
 * explicitly: `error` embeds the exact `from`/`to` pair and a `category`
 * (`unknown-zone` | `self-loop` | `backward` | `skip`) so a caller or test
 * can assert on precisely which illegal transition was rejected, never a
 * single generic flag.
 *
 * Returns `{ legal, error, message }`. `error` is `null` only when
 * `legal` is `true`.
 */
export function checkZoneTransition(from, to) {
  if (!TRUST_ZONES.includes(from) || !TRUST_ZONES.includes(to)) {
    return {
      legal: false,
      error: `trust-zone.illegal-transition.unknown-zone:${JSON.stringify(from)}->${JSON.stringify(to)}`,
      message: `transition references an unknown trust zone (from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}); known zones are ${TRUST_ZONES.join(", ")}`,
    };
  }

  const key = `${from}->${to}`;
  if (LEGAL_TRANSITIONS.has(key)) {
    return { legal: true, error: null, message: null };
  }

  const fromIndex = TRUST_ZONES.indexOf(from);
  const toIndex = TRUST_ZONES.indexOf(to);
  let category;
  if (from === to) category = "self-loop";
  else if (toIndex < fromIndex) category = "backward";
  else category = "skip";

  return {
    legal: false,
    error: `trust-zone.illegal-transition.${category}:${key}`,
    message: `illegal (${category}) trust-zone transition from ${JSON.stringify(from)} to ${JSON.stringify(to)} — the only legal path is ${TRUST_ZONES.join(" -> ")}`,
  };
}

// --- the hard security invariant -------------------------------------------
//
// "Attacker-controlled content or executable code never combines with
// privileged identity, broad filesystem access, or unrestricted network
// reach" (SPEC-135 Implementation Decisions, User Story 84). Encoded here
// as three independent, named, checkable comparisons — never a doc
// paragraph a reviewer has to remember to re-derive.

/**
 * Every content source SPEC-135 User Story 84 names as untrusted data:
 * "Repository, application, issue, branch, test, MCP, dependency, action,
 * cache, artifact, and model output are untrusted data." Listed here so
 * the classification is an explicit, checkable table rather than an
 * inferred guess.
 */
export const UNTRUSTED_CONTENT_SOURCES = Object.freeze([
  "repository",
  "application",
  "issue",
  "branch",
  "test",
  "mcp",
  "dependency",
  "action",
  "cache",
  "artifact",
  "model",
]);

/**
 * The only content source this module treats as trusted: separately
 * reviewed code on the base branch (DESIGN-dynamic-qa-spec.md §11, zone 4:
 * "separate reviewed base-branch code"). Fail-closed: any `contentSource`
 * not exactly this string — including one absent from
 * `UNTRUSTED_CONTENT_SOURCES` altogether — classifies as untrusted, never
 * as trusted by omission.
 */
const TRUSTED_CONTENT_SOURCES = Object.freeze(["reviewed-base-branch"]);

function classifyContentTrust(contentSource) {
  return TRUSTED_CONTENT_SOURCES.includes(contentSource) ? "trusted" : "untrusted";
}

// A credential scope naming write/publish/deploy/admin authority makes the
// identity holding it "privileged" for this invariant's purposes, regardless
// of production/non-production status (#150's identities model already
// requires production identity to be denied everywhere; this invariant is
// about write/publish authority a *non-production* identity can still
// carry, e.g. a service account permitted to push to the base branch).
const PRIVILEGED_SCOPE_PATTERN = /\b(write|push|publish|deploy|admin|protected-branch)\b/i;

function classifyIdentityPrivilege(credentials) {
  const scopes = Array.isArray(credentials?.scopes) ? credentials.scopes : [];
  const privileged = scopes.some((scope) => typeof scope === "string" && PRIVILEGED_SCOPE_PATTERN.test(scope));
  return privileged ? "privileged" : "unprivileged";
}

// A path of "/", "~", "$HOME" (with or without a trailing slash), or
// containing a wildcard character grants reach far broader than a scoped
// allowlist entry — "broad" for this invariant's purposes even though
// execution-profile.mjs's own schema check only requires paths to be
// non-empty strings (it does not itself classify breadth).
const BROAD_PATH_PATTERN = /^(\/|~|\$HOME)\/?$/;

function isBroadPath(candidate) {
  return typeof candidate === "string" && (BROAD_PATH_PATTERN.test(candidate) || candidate.includes("*"));
}

function classifyFilesystemScope(paths) {
  const all = [...(Array.isArray(paths?.allowedRead) ? paths.allowedRead : []), ...(Array.isArray(paths?.allowedWrite) ? paths.allowedWrite : [])];
  return all.some(isBroadPath) ? "broad" : "scoped";
}

// Reuses execution-profile.mjs's own `classifyOriginRisk` rather than a
// second regex (per that module's export note). A network reach is only
// ever "restricted" when every allowlist origin classifies "exact" *and*
// the environment reports `externallyEnforced: true` — mirroring
// capability-gate.mjs's "a permissive hosted runner does not satisfy exact
// egress" rule at the zone-assignment level, before any profile/environment
// pairing is even gated.
function classifyNetworkReach(network) {
  if (!isPlainObject(network) || network.mode === undefined || network.mode === "none") return "none";
  if (network.mode === "exact-allowlist") {
    const allowlist = Array.isArray(network.allowlist) ? network.allowlist : [];
    const allExact = allowlist.length > 0 && allowlist.every((entry) => classifyOriginRisk(entry?.origin) === "exact");
    if (network.externallyEnforced === true && allExact) return "restricted";
  }
  return "unrestricted";
}

/**
 * Checks the hard security invariant against one concrete configuration:
 * `contentSource` (one of `UNTRUSTED_CONTENT_SOURCES`, `"reviewed-base-branch"`,
 * or any other string — anything but the latter classifies untrusted),
 * `credentials` (an Execution Profile-shaped `{ scopes }`), `paths` (an
 * Execution Profile-shaped `{ allowedRead, allowedWrite }`), and `network`
 * (an Execution Profile-shaped `{ mode, allowlist, externallyEnforced }`).
 *
 * Untrusted content combined with a privileged identity, broad filesystem
 * access, or unrestricted network reach is rejected — each combination
 * checked independently (never `else if`), so a configuration violating
 * more than one at once is reported for all of them, not just the first.
 * Trusted content (`"reviewed-base-branch"`) is never restricted by this
 * check; the invariant is specifically about *untrusted* content.
 *
 * Returns `{ valid, errors }`; each error is `{ error, message }` with a
 * stable, exact `error` name: `trust-invariant.untrusted-content-with-privileged-identity`,
 * `trust-invariant.untrusted-content-with-broad-filesystem`, or
 * `trust-invariant.untrusted-content-with-unrestricted-network`.
 */
export function checkHardSecurityInvariant({ contentSource, credentials, paths, network } = {}) {
  const issues = [];
  const contentTrust = classifyContentTrust(contentSource);

  if (contentTrust === "untrusted") {
    if (classifyIdentityPrivilege(credentials) === "privileged") {
      issues.push(
        namedIssue(
          "trust-invariant.untrusted-content-with-privileged-identity",
          `content source ${JSON.stringify(contentSource)} is untrusted data and cannot combine with a privileged (write/publish/deploy/admin) identity`,
        ),
      );
    }
    if (classifyFilesystemScope(paths) === "broad") {
      issues.push(
        namedIssue(
          "trust-invariant.untrusted-content-with-broad-filesystem",
          `content source ${JSON.stringify(contentSource)} is untrusted data and cannot combine with broad filesystem access`,
        ),
      );
    }
    if (classifyNetworkReach(network) === "unrestricted") {
      issues.push(
        namedIssue(
          "trust-invariant.untrusted-content-with-unrestricted-network",
          `content source ${JSON.stringify(contentSource)} is untrusted data and cannot combine with unrestricted network reach`,
        ),
      );
    }
  }

  return { valid: issues.length === 0, errors: issues };
}

// --- zone-specific rules beyond the generic invariant ----------------------

/**
 * "Authoring is isolated from privileged publication, so untrusted
 * evidence cannot inherit write authority" (SPEC-135 User Story 85):
 * checked directly, not only implied by `checkZoneTransition` refusing
 * `contract-authoring -> privileged-publication`. The `contract-authoring`
 * zone itself must never hold a privileged (write/publish) identity,
 * regardless of whether any transition is attempted — a config combining
 * `zone: "contract-authoring"` with privileged credential scopes is
 * rejected outright.
 *
 * Returns `{ valid, errors }`; the one possible error is
 * `trust-zone.authoring-privileged-identity-forbidden`. A zone other than
 * `contract-authoring` is unaffected by this specific rule (it may still
 * fail `checkHardSecurityInvariant` on its own terms).
 */
export function checkAuthoringAuthority(zone, { credentials } = {}) {
  const issues = [];
  if (zone === "contract-authoring" && classifyIdentityPrivilege(credentials) === "privileged") {
    issues.push(
      namedIssue(
        "trust-zone.authoring-privileged-identity-forbidden",
        "the contract-authoring zone must never hold a privileged (write/publish) identity — untrusted evidence produced there cannot inherit write authority",
      ),
    );
  }
  return { valid: issues.length === 0, errors: issues };
}

/**
 * "Generated code is verified on disposable, unprivileged compute ...
 * against the pinned source commit under test" (ticket #151, SPEC-135 User
 * Story 58 and 86). Checks the `candidate-verification` zone's own two
 * non-negotiable requirements, independent of and in addition to
 * execution-profile.mjs's `environments.disposable` schema rule (that rule
 * says a *profile* must declare disposability; this checks that the
 * concrete compute evidence for *this run* actually reports both
 * disposability and an unprivileged user, and that the run is pinned to an
 * exact source commit).
 *
 * `environment` is caller-supplied evidence (mirrors #150's pattern):
 * `{ disposable: boolean, unprivilegedUser: boolean }`. `sourceCommit` must
 * be a full 40-character commit SHA — the same format
 * `provenance.mjs`'s `validateProvenanceManifest` requires of
 * `sourceCommit`, so a verified candidate is always evidence-backed against
 * an exact, traceable commit rather than a branch name or short SHA.
 *
 * Returns `{ valid, errors }` with up to three named errors:
 * `trust-zone.verification-requires-disposable-compute`,
 * `trust-zone.verification-requires-unprivileged-compute`,
 * `trust-zone.verification-requires-pinned-commit`.
 */
export function checkVerificationCompute({ environment, sourceCommit } = {}) {
  const issues = [];
  const env = isPlainObject(environment) ? environment : {};

  if (env.disposable !== true) {
    issues.push(
      namedIssue(
        "trust-zone.verification-requires-disposable-compute",
        "candidate verification must run on disposable compute (environment.disposable !== true) — a fresh VM or one-job disposable runner, never a persistent or shared one",
      ),
    );
  }
  if (env.unprivilegedUser !== true) {
    issues.push(
      namedIssue(
        "trust-zone.verification-requires-unprivileged-compute",
        "candidate verification must run as an unprivileged user (environment.unprivilegedUser !== true) — arbitrary generated code must not reach a privileged account",
      ),
    );
  }
  if (typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    issues.push(
      namedIssue(
        "trust-zone.verification-requires-pinned-commit",
        "candidate verification must be pinned to a full 40-character source commit SHA so the proposed code being verified is evidence-backed, not a moving branch or short ref",
      ),
    );
  }

  return { valid: issues.length === 0, errors: issues };
}

// --- privileged lane: never an execution bridge ----------------------------

/**
 * Artifact kinds the `privileged-publication` zone may ever accept. Per
 * DESIGN-dynamic-qa-spec.md §11 zone 4: "never execute low-trust code/
 * artifacts/caches/paths/commands/URLs; accept only a Result Envelope or
 * recompute." Every other kind — including the generic "artifact" bucket
 * spanning caches, paths, commands, and URLs the spec names explicitly —
 * is refused.
 */
const PRIVILEGED_LANE_ACCEPTED_KINDS = new Set(["result-envelope", "recompute"]);

/**
 * "Privileged lanes never execute low-trust code or artifacts, so a
 * validated result cannot become an execution bridge" (SPEC-135 User Story
 * 90). Only constrains `zone === "privileged-publication"`; every other
 * zone returns valid unconditionally (this rule is specific to the one
 * zone that must never become an execution bridge).
 *
 * `artifact` is `{ kind }`, where `kind` is one of `"code"`, `"cache"`,
 * `"path"`, `"command"`, `"url"`, `"result-envelope"`, or `"recompute"` (or
 * any other string — fail-closed, an unrecognized kind is refused, never
 * accepted by default). `kind: "code"` gets its own distinctly named
 * error, since executing generated code directly in the privileged lane is
 * the single most direct route to an execution bridge; every other
 * non-accepted kind gets the general artifact-refusal error.
 *
 * Returns `{ valid, errors }` with at most one of
 * `trust-zone.privileged-lane-refuses-code` or
 * `trust-zone.privileged-lane-refuses-artifact`.
 */
export function checkPrivilegedLaneArtifact(zone, artifact) {
  if (zone !== "privileged-publication") {
    return { valid: true, errors: [] };
  }

  const kind = isPlainObject(artifact) ? artifact.kind : undefined;

  if (kind === "code") {
    return {
      valid: false,
      errors: [
        namedIssue(
          "trust-zone.privileged-lane-refuses-code",
          "the privileged-publication zone never executes low-trust generated code — it accepts only a validated Result Envelope or an independent recompute",
        ),
      ],
    };
  }

  if (!PRIVILEGED_LANE_ACCEPTED_KINDS.has(kind)) {
    return {
      valid: false,
      errors: [
        namedIssue(
          "trust-zone.privileged-lane-refuses-artifact",
          `the privileged-publication zone refuses artifact kind ${JSON.stringify(kind ?? null)} — it accepts only "result-envelope" or "recompute", never a low-trust code, cache, path, command, or URL artifact`,
        ),
      ],
    };
  }

  return { valid: true, errors: [] };
}
