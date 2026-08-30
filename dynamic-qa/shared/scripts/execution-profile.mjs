// dynamic-qa/shared/scripts/execution-profile.mjs
//
// Fail-closed validator for the Execution Profile v1 contract
// (dynamic-qa/shared/schemas/dynamic-qa-execution-profile-v1.schema.json,
// DESIGN-dynamic-qa-spec.md §5.3, SPEC-135.md user stories 40-41). Ticket
// #150. A Flow's Execution Profile is what makes its run enforceable —
// paths, commands, environments, network, identities, effects, resources,
// and evidence — and #146 left this artifact entirely to this ticket:
// `preflight.mjs` only checks that generation names a profile by ID, never
// that the profile itself is well-formed or that its declared policy is
// actually enforced anywhere. This module is the "well-formed" half;
// capability-gate.mjs (same ticket) is the "actually enforced against the
// real environment" half.
//
// Follows flow-definition.mjs's established pattern exactly: an Issues
// collector that never throws (a hostile/malformed restricted-YAML parse is
// the one exception, exactly as elsewhere), every issue reported rather than
// stopping at the first, unknown keys and unsupported schema versions fail
// closed.
//
// Two invariants this module enforces that are NOT simply "does the shape
// match the schema", because they are the actual security requirements
// SPEC-135's Implementation Decisions state as non-negotiable and which a
// JSON Schema shape check alone cannot express:
//
//   1. Network defaults to none. When network.mode is "exact-allowlist",
//      EVERY supporting field (dnsRecheck, redirectRecheck,
//      denyMetadataRange, denyInternalRange, denyPublicRange,
//      externallyEnforced, enforcementMechanism, a non-empty allowlist)
//      must be present and true/non-empty — "exact-allowlist" with any of
//      those missing is refused outright, never silently treated as
//      "none" and never silently accepted as "good enough". Every
//      allowlist origin must be *exact*: an exact https origin, naming one
//      host, with no wildcard character, no bare TLD, no CIDR range — and
//      never a metadata, private/internal, or catch-all-public address.
//      "isExactOrigin"/"classifyOriginRisk" below are exported so
//      capability-gate.mjs's environment-evidence check can reuse the same
//      classification rather than reinventing it.
//   2. Positive-deny identities are required, not optional: denyProduction
//      and denyMetadata must each name at least one identifier, and no
//      identifier may appear in both an approved list and a deny list —
//      approval never silently overrides a deny.
//
// Honourability against a Flow's Boundary Declarations
// (`checkExecutionProfileHonoursBoundaries`) is exported from here too,
// reusing boundary-policy.mjs's `resolveBoundaryTreatment` directly per
// #145's explicit hand-off note ("Execution Profile checks (#150) ... should
// call it rather than reimplement the lookup").

import { isValidSemanticId } from "./id-rules.mjs";
import { resolveBoundaryTreatment } from "./boundary-policy.mjs";

export const SUPPORTED_SCHEMA = "dynamic-qa-execution-profile-v1";

export const EXECUTION_PHASES = Object.freeze(["candidate-verification", "pr", "nightly", "manual"]);
export const TEST_LEVELS = Object.freeze(["api", "cli", "browser"]);
export const NETWORK_MODES = Object.freeze(["none", "exact-allowlist"]);
export const CAPABILITY_CATEGORIES = Object.freeze([
  "paths",
  "commands",
  "environments",
  "network",
  "identities",
  "effects",
  "resources",
  "evidence",
]);
export const CAPTURE_CONDITIONS = Object.freeze(["failure-only", "always", "never"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function pathStr(path) {
  if (!path || path.length === 0) return "$";
  let out = "$";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return out;
}

class Issues {
  constructor() {
    this.list = [];
  }
  add(path, message) {
    this.list.push({ path, message: `${message} (at ${pathStr(path)})` });
  }
  addAll(issues) {
    for (const issue of issues) this.add(issue.path, issue.message);
  }
}

function assertKnownKeys(obj, allowed, path, issues) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) issues.add([...path, key], `unknown key ${JSON.stringify(key)}`);
  }
}

function stringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim() !== "");
}

const ROOT_KEYS = new Set([
  "schema",
  "id",
  "revision",
  "owners",
  "allowedPhases",
  "allowedTestLevels",
  "environments",
  "paths",
  "commands",
  "resources",
  "identities",
  "network",
  "effects",
  "credentials",
  "diagnostics",
  "evidence",
]);

// --- exact-origin classification, reused by capability-gate.mjs -----------

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.azure.com",
  "100.100.100.200", // Alibaba Cloud metadata endpoint
  "fd00:ec2::254", // AWS IMDSv2 IPv6
]);

function isPrivateOrInternalHost(host) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // link-local incl. metadata range
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  return false;
}

/**
 * Normalizes an allowlist origin's host for classification. Strips
 * userinfo, lowercases, strips IPv6 brackets, strips a single trailing
 * root dot. Returns `null` (never a guessed host) whenever the origin
 * does not parse as a clean, single https origin with no path/query/
 * fragment and no embedded userinfo — fail closed rather than fall
 * through to a permissive classification.
 */
function normalizeOriginHost(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Embedded credentials (`https://user:pass@host`) are not part of a
  // well-formed origin and are a classic host-confusion bypass vector —
  // reject rather than silently discard the userinfo and continue.
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.search !== "" || url.hash !== "") return null;
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // IPv6 literal
  if (host.endsWith(".") && host !== ".") host = host.slice(0, -1); // trailing FQDN root dot
  if (host === "") return null;
  return host;
}

/**
 * Classifies one allowlist origin string. Returns one of:
 *   "exact"      — a single exact https host, no wildcard, not metadata/
 *                  internal/private/public-catch-all.
 *   "wildcard"   — contains a wildcard character or CIDR-style range: never
 *                  an exact egress target.
 *   "metadata"   — a cloud/instance metadata address.
 *   "internal"   — a private/internal/loopback/link-local address.
 *   "malformed"  — not a well-formed single https origin at all.
 * Exported so capability-gate.mjs's environment-evidence check reuses this
 * exact classification rather than a second regex.
 */
export function classifyOriginRisk(origin) {
  if (typeof origin !== "string" || origin.trim() === "") return "malformed";
  if (origin.includes("*")) return "wildcard";
  const host = normalizeOriginHost(origin);
  if (host === null) return "malformed";
  if (host === "0.0.0.0") return "wildcard";
  if (METADATA_HOSTS.has(host)) return "metadata";
  if (/^169\.254\.169\.254$/.test(host)) return "metadata";
  if (isPrivateOrInternalHost(host)) return "internal";
  return "exact";
}

export function isExactOrigin(origin) {
  return classifyOriginRisk(origin) === "exact";
}

// --- sub-validators ---------------------------------------------------

function validateOwners(owners, path, issues) {
  if (!isPlainObject(owners)) {
    issues.add(path, "owners must be a mapping");
    return;
  }
  assertKnownKeys(owners, new Set(["qaOwner", "technicalOwner"]), path, issues);
  if (!nonEmptyString(owners.qaOwner)) issues.add([...path, "qaOwner"], "qaOwner must be a non-empty string");
  if (!nonEmptyString(owners.technicalOwner)) {
    issues.add([...path, "technicalOwner"], "technicalOwner must be a non-empty string");
  }
}

function validateEnumArray(value, allowed, path, issues, { label = "entry" } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.add(path, "must be a non-empty list");
    return;
  }
  const seen = new Set();
  value.forEach((entry, i) => {
    if (!allowed.includes(entry)) {
      issues.add([...path, i], `${label} must be one of ${allowed.join(" | ")} (got ${JSON.stringify(entry)})`);
    }
    if (seen.has(entry)) issues.add([...path, i], `duplicate ${label} ${JSON.stringify(entry)}`);
    seen.add(entry);
  });
}

function validateEnvironments(environments, path, issues) {
  if (!isPlainObject(environments)) {
    issues.add(path, "environments must be a mapping");
    return;
  }
  assertKnownKeys(
    environments,
    new Set(["runnerClass", "disposable", "disposabilityEvidence", "sandbox", "osLimits", "containerLimits"]),
    path,
    issues,
  );
  if (!nonEmptyString(environments.runnerClass)) issues.add([...path, "runnerClass"], "runnerClass must be a non-empty string");
  if (environments.disposable !== true) {
    issues.add(
      [...path, "disposable"],
      "disposable must be exactly true — generated code is verified on disposable, unprivileged compute, never a persistent or shared runner",
    );
  }
  if (!nonEmptyString(environments.disposabilityEvidence)) {
    issues.add([...path, "disposabilityEvidence"], "disposabilityEvidence must describe how disposability is evidenced");
  }
  if (!nonEmptyString(environments.sandbox)) issues.add([...path, "sandbox"], "sandbox must be a non-empty string");
}

function validatePaths(paths, path, issues) {
  if (!isPlainObject(paths)) {
    issues.add(path, "paths must be a mapping");
    return;
  }
  assertKnownKeys(paths, new Set(["allowedRead", "allowedWrite"]), path, issues);
  if (!Array.isArray(paths.allowedRead) || !paths.allowedRead.every((p) => typeof p === "string" && p.trim() !== "")) {
    issues.add([...path, "allowedRead"], "allowedRead must be a list of non-empty path strings (may be empty)");
  }
  if (!Array.isArray(paths.allowedWrite) || !paths.allowedWrite.every((p) => typeof p === "string" && p.trim() !== "")) {
    issues.add([...path, "allowedWrite"], "allowedWrite must be a list of non-empty path strings (may be empty)");
  }
}

function validateCommands(commands, path, issues) {
  if (!isPlainObject(commands)) {
    issues.add(path, "commands must be a mapping");
    return;
  }
  assertKnownKeys(commands, new Set(["allowed"]), path, issues);
  if (!Array.isArray(commands.allowed) || !commands.allowed.every((c) => typeof c === "string" && c.trim() !== "")) {
    issues.add([...path, "allowed"], "allowed must be a list of non-empty command strings (may be empty)");
  }
}

function validateResources(resources, path, issues) {
  if (!isPlainObject(resources)) {
    issues.add(path, "resources must be a mapping");
    return;
  }
  const fields = ["maxProcesses", "maxCpuSeconds", "maxMemoryMb", "maxFileSizeMb", "maxWallTimeSeconds"];
  assertKnownKeys(resources, new Set(fields), path, issues);
  for (const field of fields) {
    if (!isPositiveNumber(resources[field])) {
      issues.add([...path, field], `${field} must be a positive number`);
    }
  }
  if (Number.isFinite(resources.maxProcesses) && !Number.isInteger(resources.maxProcesses)) {
    issues.add([...path, "maxProcesses"], "maxProcesses must be an integer");
  }
}

function validateIdentities(identities, path, issues) {
  if (!isPlainObject(identities)) {
    issues.add(path, "identities must be a mapping");
    return;
  }
  assertKnownKeys(identities, new Set(["approvedNonProduction", "denyProduction", "denyMetadata"]), path, issues);

  const approved = Array.isArray(identities.approvedNonProduction) ? identities.approvedNonProduction : null;
  if (!approved || !approved.every((v) => typeof v === "string" && v.trim() !== "")) {
    issues.add([...path, "approvedNonProduction"], "approvedNonProduction must be a list of non-empty identifier strings (may be empty)");
  }

  if (!stringArray(identities.denyProduction) || identities.denyProduction.length === 0) {
    issues.add(
      [...path, "denyProduction"],
      "denyProduction must name at least one production identifier explicitly denied — positive-deny is required, not optional",
    );
  }
  if (!stringArray(identities.denyMetadata) || identities.denyMetadata.length === 0) {
    issues.add(
      [...path, "denyMetadata"],
      "denyMetadata must name at least one metadata identifier explicitly denied — positive-deny is required, not optional",
    );
  }

  if (approved && stringArray(identities.denyProduction) && stringArray(identities.denyMetadata)) {
    const denySet = new Set([...identities.denyProduction, ...identities.denyMetadata]);
    approved.forEach((id, i) => {
      if (denySet.has(id)) {
        issues.add(
          [...path, "approvedNonProduction", i],
          `identifier ${JSON.stringify(id)} is both approved and explicitly denied — approval can never silently override a positive deny`,
        );
      }
    });
  }
}

function validateNetwork(network, path, issues) {
  if (!isPlainObject(network)) {
    issues.add(path, "network must be a mapping");
    return;
  }
  if (!NETWORK_MODES.includes(network.mode)) {
    issues.add([...path, "mode"], `mode must be one of ${NETWORK_MODES.join(" | ")} (got ${JSON.stringify(network.mode)}) — network defaults to none`);
    return;
  }

  if (network.mode === "none") {
    assertKnownKeys(network, new Set(["mode"]), path, issues);
    return;
  }

  // mode === "exact-allowlist": every supporting field is required, and
  // must actually hold, never merely be present.
  assertKnownKeys(
    network,
    new Set([
      "mode",
      "allowlist",
      "dnsRecheck",
      "redirectRecheck",
      "denyMetadataRange",
      "denyInternalRange",
      "denyPublicRange",
      "externallyEnforced",
      "enforcementMechanism",
    ]),
    path,
    issues,
  );

  if (!Array.isArray(network.allowlist) || network.allowlist.length === 0) {
    issues.add([...path, "allowlist"], "exact-allowlist mode requires a non-empty allowlist");
  } else {
    network.allowlist.forEach((entry, i) => {
      const entryPath = [...path, "allowlist", i];
      if (!isPlainObject(entry)) {
        issues.add(entryPath, "each allowlist entry must be a mapping");
        return;
      }
      assertKnownKeys(entry, new Set(["origin", "service"]), entryPath, issues);
      if (!nonEmptyString(entry.service)) issues.add([...entryPath, "service"], "service must be a non-empty string");
      const risk = classifyOriginRisk(entry.origin);
      if (risk !== "exact") {
        const reason = {
          malformed: "must be a well-formed single https://<host> origin with no path or wildcard",
          wildcard: "contains a wildcard character or a CIDR-style range — a permissive/wildcard allowlist entry is not an exact allowlist",
          metadata: "is a cloud/instance metadata address — metadata targets are always denied",
          internal: "is a private/internal/loopback/link-local address — internal targets are always denied",
        }[risk];
        issues.add([...entryPath, "origin"], `origin ${JSON.stringify(entry.origin)} ${reason}`);
      }
    });
  }

  for (const field of ["dnsRecheck", "redirectRecheck", "denyMetadataRange", "denyInternalRange", "denyPublicRange", "externallyEnforced"]) {
    if (network[field] !== true) {
      issues.add(
        [...path, field],
        `${field} must be exactly true when network.mode is "exact-allowlist" — a permissive hosted runner without this does not satisfy exact egress`,
      );
    }
  }
  if (!nonEmptyString(network.enforcementMechanism)) {
    issues.add([...path, "enforcementMechanism"], "enforcementMechanism must name how egress is externally enforced (a network policy, egress proxy, or firewall)");
  }
}

function validateEffects(effects, path, issues) {
  if (!isPlainObject(effects)) {
    issues.add(path, "effects must be a mapping");
    return;
  }
  assertKnownKeys(
    effects,
    new Set(["allowedBoundaryIds", "reversibleSideEffects", "namespace", "cleanup", "rate", "concurrency"]),
    path,
    issues,
  );
  if (!Array.isArray(effects.allowedBoundaryIds) || !effects.allowedBoundaryIds.every((v) => typeof v === "string" && v.trim() !== "")) {
    issues.add([...path, "allowedBoundaryIds"], "allowedBoundaryIds must be a list of non-empty boundary id strings (may be empty)");
  }
  if (typeof effects.reversibleSideEffects !== "boolean") {
    issues.add([...path, "reversibleSideEffects"], "reversibleSideEffects must be a boolean");
  } else if (effects.reversibleSideEffects === true) {
    if (!nonEmptyString(effects.namespace)) issues.add([...path, "namespace"], "namespace is required when reversibleSideEffects is true");
    if (!nonEmptyString(effects.cleanup)) issues.add([...path, "cleanup"], "cleanup is required when reversibleSideEffects is true");
  }
  if ("concurrency" in effects && !(Number.isInteger(effects.concurrency) && effects.concurrency >= 1)) {
    issues.add([...path, "concurrency"], "concurrency must be a positive integer");
  }
}

function validateCredentials(credentials, path, issues) {
  if (!isPlainObject(credentials)) {
    issues.add(path, "credentials must be a mapping (may be empty when no credential is required)");
    return;
  }
  const allowed = new Set(["handle", "audience", "scopes", "lifetimeSeconds", "injectionPhase", "revocation"]);
  assertKnownKeys(credentials, allowed, path, issues);
  if (!("handle" in credentials)) return; // no credential required by this profile

  if (!nonEmptyString(credentials.handle)) issues.add([...path, "handle"], "handle must be a non-empty string (a named handle, never a secret value)");
  if (!nonEmptyString(credentials.audience)) issues.add([...path, "audience"], "audience is required when a credential handle is declared");
  if (!Array.isArray(credentials.scopes) || credentials.scopes.length === 0 || !credentials.scopes.every((s) => typeof s === "string" && s.trim() !== "")) {
    issues.add([...path, "scopes"], "scopes must be a non-empty list of non-empty strings when a credential handle is declared");
  }
  if (!isPositiveNumber(credentials.lifetimeSeconds)) issues.add([...path, "lifetimeSeconds"], "lifetimeSeconds must be a positive number");
  if (!EXECUTION_PHASES.includes(credentials.injectionPhase)) {
    issues.add([...path, "injectionPhase"], `injectionPhase must be one of ${EXECUTION_PHASES.join(" | ")}`);
  }
  if (!nonEmptyString(credentials.revocation)) issues.add([...path, "revocation"], "revocation must describe how the credential is revoked");
}

function validateDiagnostics(diagnostics, path, issues) {
  if (!isPlainObject(diagnostics)) {
    issues.add(path, "diagnostics must be a mapping");
    return;
  }
  assertKnownKeys(
    diagnostics,
    new Set(["classes", "captureConditions", "scrubber", "maxSizeMb", "audience", "retentionDays"]),
    path,
    issues,
  );
  if (!Array.isArray(diagnostics.classes) || !diagnostics.classes.every((c) => typeof c === "string" && c.trim() !== "")) {
    issues.add([...path, "classes"], "classes must be a list of non-empty strings (may be empty)");
  }
  if (!Array.isArray(diagnostics.captureConditions)) {
    issues.add([...path, "captureConditions"], "captureConditions must be a list");
  } else {
    diagnostics.captureConditions.forEach((c, i) => {
      if (!CAPTURE_CONDITIONS.includes(c)) {
        issues.add([...path, "captureConditions", i], `captureConditions entries must be one of ${CAPTURE_CONDITIONS.join(" | ")}`);
      }
    });
  }
  if (!nonEmptyString(diagnostics.scrubber)) {
    issues.add([...path, "scrubber"], "scrubber must name the scrubber applied before upload, even when classes is empty");
  }
  if (typeof diagnostics.maxSizeMb !== "number" || diagnostics.maxSizeMb < 0) {
    issues.add([...path, "maxSizeMb"], "maxSizeMb must be a non-negative number");
  }
  if (!nonEmptyString(diagnostics.audience)) issues.add([...path, "audience"], "audience must be a non-empty string");
  if (!(Number.isInteger(diagnostics.retentionDays) && diagnostics.retentionDays >= 0)) {
    issues.add([...path, "retentionDays"], "retentionDays must be a non-negative integer");
  }
}

function validateEvidence(evidence, path, issues) {
  if (!isPlainObject(evidence)) {
    issues.add(path, "evidence must be a mapping");
    return;
  }
  assertKnownKeys(evidence, new Set(["adapter", "capabilities"]), path, issues);
  if (!nonEmptyString(evidence.adapter)) issues.add([...path, "adapter"], "adapter must name the provider adapter identity");
  if (!Array.isArray(evidence.capabilities) || evidence.capabilities.length === 0) {
    issues.add([...path, "capabilities"], "capabilities must be a non-empty list — an Execution Profile with no required capability names nothing for the Capability Gate to check");
    return;
  }
  const seen = new Set();
  evidence.capabilities.forEach((entry, i) => {
    const entryPath = [...path, "capabilities", i];
    if (!isPlainObject(entry)) {
      issues.add(entryPath, "each capability entry must be a mapping");
      return;
    }
    assertKnownKeys(entry, new Set(["capability", "category", "detail"]), entryPath, issues);
    if (!nonEmptyString(entry.capability)) {
      issues.add([...entryPath, "capability"], "capability must be a non-empty, exact, stable name");
    } else if (seen.has(entry.capability)) {
      issues.add([...entryPath, "capability"], `duplicate capability name ${JSON.stringify(entry.capability)}`);
    } else {
      seen.add(entry.capability);
    }
    if (!CAPABILITY_CATEGORIES.includes(entry.category)) {
      issues.add([...entryPath, "category"], `category must be one of ${CAPABILITY_CATEGORIES.join(" | ")}`);
    }
  });
}

// --- top level -----------------------------------------------------------

/**
 * Validates an already-parsed Execution Profile JS value against the v1
 * contract. Returns { valid, errors }, following flow-definition.mjs's
 * pattern exactly: every issue is reported, never just the first; never
 * throws for an ordinary shape/policy violation.
 */
export function validateExecutionProfile(data, { expectedId } = {}) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "an Execution Profile document must be a mapping");
    return { valid: false, errors: issues.list };
  }

  assertKnownKeys(data, ROOT_KEYS, [], issues);

  if (data.schema !== SUPPORTED_SCHEMA) {
    issues.add(
      ["schema"],
      `unsupported schema version ${JSON.stringify(data.schema)} — this validator only accepts ${JSON.stringify(SUPPORTED_SCHEMA)}`,
    );
  }

  if (!isValidSemanticId(data.id)) {
    issues.add(["id"], "id must be an immutable semantic identifier, never derived from an issue number");
  } else if (expectedId !== undefined && data.id !== expectedId) {
    issues.add(
      ["id"],
      `id ${JSON.stringify(data.id)} does not match its filename ${JSON.stringify(expectedId)} — the filename must equal the immutable Execution Profile ID`,
    );
  }

  if (!(Number.isInteger(data.revision) && data.revision >= 1)) {
    issues.add(["revision"], "revision must be a monotonically increasing integer starting at 1");
  }

  validateOwners(data.owners, ["owners"], issues);
  validateEnumArray(data.allowedPhases, EXECUTION_PHASES, ["allowedPhases"], issues, { label: "phase" });
  validateEnumArray(data.allowedTestLevels, TEST_LEVELS, ["allowedTestLevels"], issues, { label: "test level" });
  validateEnvironments(data.environments, ["environments"], issues);
  validatePaths(data.paths, ["paths"], issues);
  validateCommands(data.commands, ["commands"], issues);
  validateResources(data.resources, ["resources"], issues);
  validateIdentities(data.identities, ["identities"], issues);
  validateNetwork(data.network, ["network"], issues);
  validateEffects(data.effects, ["effects"], issues);
  validateCredentials(data.credentials, ["credentials"], issues);
  validateDiagnostics(data.diagnostics, ["diagnostics"], issues);
  validateEvidence(data.evidence, ["evidence"], issues);

  return { valid: issues.list.length === 0, errors: issues.list };
}

/**
 * Honourability check (owned by #150 per #145's explicit hand-off): can this
 * Flow's Boundary Declarations actually be realised against this concrete
 * Execution Profile?
 *
 *   - Every boundary id the profile's `effects.allowedBoundaryIds` permits
 *     must resolve to something other than "forbidden" against the flow's
 *     own declared boundaries (via `resolveBoundaryTreatment`, reused
 *     directly, never reimplemented). An undeclared boundary resolves
 *     "forbidden" by construction; a profile that would permit it anyway is
 *     unhonourable — it claims a capability the flow's own contract does
 *     not grant.
 *   - Every flow boundary declared `real` with non-"none" side effects
 *     (i.e. boundary-policy.mjs's isolation-required case) must be included
 *     in the profile's allowed boundary ids, and the profile must itself
 *     declare `effects.namespace`/`effects.cleanup` — a profile that omits
 *     the isolation a real-side-effect boundary requires cannot honour it
 *     either.
 *
 * Returns { valid, errors } in the same { path, message } shape as every
 * other validator here. Assumes `flowBoundaries` already passed
 * boundary-policy.mjs's shape+policy validation and `profile` already passed
 * `validateExecutionProfile` — this function does not re-check either.
 */
export function checkExecutionProfileHonoursBoundaries(profile, flowBoundaries) {
  const issues = new Issues();
  const allowedIds = Array.isArray(profile?.effects?.allowedBoundaryIds) ? profile.effects.allowedBoundaryIds : [];

  allowedIds.forEach((boundaryId, i) => {
    const treatment = resolveBoundaryTreatment(boundaryId, flowBoundaries);
    if (treatment === "forbidden") {
      issues.add(
        ["effects", "allowedBoundaryIds", i],
        `Execution Profile permits boundary ${JSON.stringify(boundaryId)}, but the flow does not declare it (or forbids it) — an undeclared boundary resolves "forbidden", and a profile that would permit it anyway cannot be honoured`,
      );
    }
  });

  const allowedSet = new Set(allowedIds);
  if (Array.isArray(flowBoundaries)) {
    flowBoundaries.forEach((boundary, i) => {
      if (!boundary || typeof boundary !== "object") return;
      if (boundary.treatment !== "real") return;
      const sideEffects = typeof boundary.side_effects === "string" ? boundary.side_effects.trim().toLowerCase() : "";
      if (sideEffects === "none" || sideEffects === "") return; // no isolation required
      if (!allowedSet.has(boundary.id)) {
        issues.add(
          ["boundaries", i, "id"],
          `flow boundary ${JSON.stringify(boundary.id)} has real side effects requiring isolation, but the Execution Profile's effects.allowedBoundaryIds does not include it — this boundary cannot be honoured by this profile`,
        );
        return;
      }
      if (!nonEmptyString(profile?.effects?.namespace) || !nonEmptyString(profile?.effects?.cleanup)) {
        issues.add(
          ["effects"],
          `flow boundary ${JSON.stringify(boundary.id)} requires namespace isolation and cleanup, but the Execution Profile does not declare effects.namespace/effects.cleanup — this boundary cannot be honoured by this profile`,
        );
      }
    });
  }

  return { valid: issues.list.length === 0, errors: issues.list };
}
