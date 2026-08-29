// dynamic-qa/shared/scripts/capability-gate.mjs
//
// The Capability Gate (ticket #150, DESIGN-dynamic-qa-spec.md §5.3,
// SPEC-135.md user stories 40-41): checks a validated Execution Profile
// (execution-profile.mjs) against actual environment evidence — what the
// real runner/sandbox/adapter reports it can and does enforce — across
// exactly the eight categories the ticket names: paths, commands,
// environments, network, identities, effects, resources, and evidence.
//
// The one invariant every other design choice here serves: a missing or
// mismatched capability produces a named Safety Blocker, and activation is
// refused. It can NEVER degrade to a skip. Concretely:
//
//   - `runCapabilityGate` always calls all eight `check*` functions,
//     unconditionally, in a fixed order — there is no early return once a
//     mismatch is found in category A, and no code path that omits a
//     category because a piece of environment evidence happened to be
//     absent (absence is itself checked and, when the profile requires
//     that category, produces a blocker rather than being treated as
//     "not applicable").
//   - Every blocker names the exact missing/mismatched capability (a
//     `capability` string plus `category`), never a generic
//     "gate failed" message. `evidence.mjs`'s capability list is the
//     clearest case: each declared capability either matches an environment
//     entry reporting `status: "met"`, or produces a blocker naming that
//     exact `capability` string.
//   - `activationDecision` is the only function callers should use to
//     decide whether a Flow may activate. It returns `{ activate: false,
//     state: "deferred", blockers }` whenever `blockers` is non-empty, and
//     never defaults `activate` to `true` — a caller cannot "forget" to
//     check for blockers and accidentally activate, because there is no
//     path through this function that returns `activate: true` alongside a
//     non-empty blocker list.
//
// Network is the one category with an extra hard rule beyond "environment
// matches profile": `network.mode === "exact-allowlist"` additionally
// requires `environment.network.externallyEnforced === true`. A permissive
// hosted runner that only relies on the test process's own good behaviour
// (no egress proxy, no network policy, no firewall) reports
// `externallyEnforced: false` (or omits the field) and is refused — "a
// permissive hosted runner does not satisfy exact egress" is not a
// judgement call this module makes, it is a fixed comparison against one
// required boolean (SPEC-135 story 88 / Implementation Decisions).

import { classifyOriginRisk } from "./execution-profile.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setEquals(a, b) {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

function blocker(category, capability, message) {
  return { category, capability, message };
}

// --- paths -----------------------------------------------------------------

function checkPaths(profile, environment) {
  const blockers = [];
  const env = isPlainObject(environment?.paths) ? environment.paths : {};
  const wantRead = profile.paths?.allowedRead ?? [];
  const wantWrite = profile.paths?.allowedWrite ?? [];
  if (!setEquals(env.enforcedRead, wantRead)) {
    blockers.push(
      blocker(
        "paths",
        "paths.read-allowlist-enforced",
        `the environment does not enforce exactly the profile's allowed read paths (profile: ${JSON.stringify(wantRead)}, environment enforces: ${JSON.stringify(env.enforcedRead ?? null)})`,
      ),
    );
  }
  if (!setEquals(env.enforcedWrite, wantWrite)) {
    blockers.push(
      blocker(
        "paths",
        "paths.write-allowlist-enforced",
        `the environment does not enforce exactly the profile's allowed write paths (profile: ${JSON.stringify(wantWrite)}, environment enforces: ${JSON.stringify(env.enforcedWrite ?? null)})`,
      ),
    );
  }
  return blockers;
}

// --- commands ----------------------------------------------------------

function checkCommands(profile, environment) {
  const env = isPlainObject(environment?.commands) ? environment.commands : {};
  const want = profile.commands?.allowed ?? [];
  if (!setEquals(env.enforced, want)) {
    return [
      blocker(
        "commands",
        "commands.allowlist-enforced",
        `the environment does not enforce exactly the profile's allowed command list (profile: ${JSON.stringify(want)}, environment enforces: ${JSON.stringify(env.enforced ?? null)})`,
      ),
    ];
  }
  return [];
}

// --- environments (runner / sandbox / disposability) ------------------

function checkEnvironments(profile, environment) {
  const blockers = [];
  const want = profile.environments ?? {};
  const env = isPlainObject(environment?.environments) ? environment.environments : {};
  if (env.runnerClass !== want.runnerClass) {
    blockers.push(
      blocker(
        "environments",
        "environments.runner-class-matches",
        `the environment reports runner class ${JSON.stringify(env.runnerClass ?? null)}, not the profile's required ${JSON.stringify(want.runnerClass)}`,
      ),
    );
  }
  if (env.disposable !== true) {
    blockers.push(
      blocker("environments", "environments.disposable", "the environment does not report a disposable runner (disposable !== true)"),
    );
  }
  if (env.sandbox !== want.sandbox) {
    blockers.push(
      blocker(
        "environments",
        "environments.sandbox-matches",
        `the environment reports sandbox ${JSON.stringify(env.sandbox ?? null)}, not the profile's required ${JSON.stringify(want.sandbox)}`,
      ),
    );
  }
  return blockers;
}

// --- resources -----------------------------------------------------------

const RESOURCE_FIELDS = ["maxProcesses", "maxCpuSeconds", "maxMemoryMb", "maxFileSizeMb", "maxWallTimeSeconds"];

function checkResources(profile, environment) {
  const blockers = [];
  const want = profile.resources ?? {};
  const env = isPlainObject(environment?.resources) ? environment.resources : {};
  for (const field of RESOURCE_FIELDS) {
    const enforced = env[field];
    const limit = want[field];
    if (typeof enforced !== "number" || !(enforced <= limit)) {
      blockers.push(
        blocker(
          "resources",
          `resources.${field}-enforced`,
          `the environment does not enforce ${field} at or below the profile's limit (profile: ${JSON.stringify(limit)}, environment enforces: ${JSON.stringify(enforced ?? null)})`,
        ),
      );
    }
  }
  return blockers;
}

// --- identities ----------------------------------------------------------

function checkIdentities(profile, environment) {
  const blockers = [];
  const approved = new Set(profile.identities?.approvedNonProduction ?? []);
  const denied = new Set([...(profile.identities?.denyProduction ?? []), ...(profile.identities?.denyMetadata ?? [])]);
  const active = Array.isArray(environment?.identities?.active) ? environment.identities.active : null;

  if (active === null) {
    blockers.push(blocker("identities", "identities.active-reported", "the environment did not report which identities are active for this run"));
    return blockers;
  }

  active.forEach((id) => {
    if (denied.has(id)) {
      blockers.push(blocker("identities", "identities.no-denied-identity-active", `identity ${JSON.stringify(id)} is active but is explicitly denied by the profile (production or metadata identity)`));
    } else if (!approved.has(id)) {
      blockers.push(blocker("identities", "identities.only-approved-identity-active", `identity ${JSON.stringify(id)} is active but is not in the profile's approvedNonProduction list`));
    }
  });

  return blockers;
}

// --- network -------------------------------------------------------------

function checkNetwork(profile, environment) {
  const blockers = [];
  const want = profile.network ?? { mode: "none" };
  const env = isPlainObject(environment?.network) ? environment.network : {};

  if (want.mode === "none") {
    if (env.mode !== "none") {
      blockers.push(
        blocker(
          "network",
          "network.egress-isolated",
          `the profile requires network.mode "none" but the environment reports mode ${JSON.stringify(env.mode ?? null)} — network defaults to none and must actually be isolated`,
        ),
      );
    }
    return blockers;
  }

  // want.mode === "exact-allowlist"
  if (env.mode !== "exact-allowlist") {
    blockers.push(
      blocker(
        "network",
        "network.exact-allowlist-enforced",
        `the profile requires network.mode "exact-allowlist" but the environment reports mode ${JSON.stringify(env.mode ?? null)}`,
      ),
    );
  }

  const wantAllowlist = (want.allowlist ?? []).map((e) => `${e.origin}|${e.service}`).sort();
  const envAllowlist = Array.isArray(env.enforcedAllowlist)
    ? env.enforcedAllowlist.map((e) => `${e.origin}|${e.service}`).sort()
    : null;
  if (envAllowlist === null || JSON.stringify(envAllowlist) !== JSON.stringify(wantAllowlist)) {
    blockers.push(
      blocker(
        "network",
        "network.exact-allowlist-matches",
        `the environment's enforced allowlist does not exactly match the profile's declared allowlist (profile: ${JSON.stringify(wantAllowlist)}, environment: ${JSON.stringify(envAllowlist)})`,
      ),
    );
  }
  // Belt-and-braces: even if the environment claims to enforce it, an
  // allowlist entry that classifies as anything but "exact" is never
  // accepted as satisfying exact egress (a wildcard/metadata/internal
  // target reported by a misconfigured or hostile adapter is still denied).
  for (const entry of want.allowlist ?? []) {
    if (classifyOriginRisk(entry.origin) !== "exact") {
      blockers.push(
        blocker(
          "network",
          "network.allowlist-entries-exact",
          `allowlist origin ${JSON.stringify(entry.origin)} is not an exact, non-metadata, non-internal https origin`,
        ),
      );
    }
  }

  const requiredTrueFields = [
    ["dnsRecheck", "network.dns-recheck-enforced"],
    ["redirectRecheck", "network.redirect-recheck-enforced"],
    ["denyMetadataRange", "network.metadata-range-denied"],
    ["denyInternalRange", "network.internal-range-denied"],
    ["denyPublicRange", "network.public-range-denied"],
  ];
  for (const [field, capability] of requiredTrueFields) {
    if (env[field] !== true) {
      blockers.push(blocker("network", capability, `the environment does not report ${field}: true`));
    }
  }

  // The security invariant this whole module exists to enforce: a
  // permissive hosted runner is not evidence of safety. externallyEnforced
  // must be reported true by a mechanism outside the test process itself.
  if (env.externallyEnforced !== true) {
    blockers.push(
      blocker(
        "network",
        "network.egress-externally-enforced",
        "the environment does not report externally enforced egress (a network policy, egress proxy, or firewall outside the test process) — a permissive hosted runner's own good behaviour does not satisfy exact egress; the flow must stay deferred rather than run unsafely",
      ),
    );
  }

  return blockers;
}

// --- effects (boundary allowlist + isolation + rate/concurrency) --------

function checkEffects(profile, environment) {
  const blockers = [];
  const want = profile.effects ?? {};
  const env = isPlainObject(environment?.effects) ? environment.effects : {};

  if (!setEquals(env.enforcedBoundaryIds, want.allowedBoundaryIds ?? [])) {
    blockers.push(
      blocker(
        "effects",
        "effects.boundary-allowlist-enforced",
        `the environment does not enforce exactly the profile's allowed boundary ids (profile: ${JSON.stringify(want.allowedBoundaryIds ?? [])}, environment enforces: ${JSON.stringify(env.enforcedBoundaryIds ?? null)})`,
      ),
    );
  }

  if (want.reversibleSideEffects === true) {
    if (env.namespaceIsolation !== true) {
      blockers.push(blocker("effects", "effects.namespace-isolation-enforced", "the environment does not report namespace isolation, but the profile requires it for reversible side effects"));
    }
    if (env.cleanupCapability !== true) {
      blockers.push(blocker("effects", "effects.cleanup-capability-enforced", "the environment does not report cleanup capability, but the profile requires it for reversible side effects"));
    }
  }

  if (Number.isInteger(want.concurrency)) {
    if (typeof env.enforcedConcurrency !== "number" || !(env.enforcedConcurrency <= want.concurrency)) {
      blockers.push(
        blocker(
          "effects",
          "effects.concurrency-enforced",
          `the environment does not enforce concurrency at or below the profile's limit (profile: ${want.concurrency}, environment enforces: ${JSON.stringify(env.enforcedConcurrency ?? null)})`,
        ),
      );
    }
  }

  return blockers;
}

// --- evidence (provider adapter capability evidence) --------------------

function checkEvidence(profile, environment) {
  const blockers = [];
  const required = profile.evidence?.capabilities ?? [];
  const reported = Array.isArray(environment?.evidence) ? environment.evidence : [];
  const reportedByName = new Map(reported.filter((e) => e && typeof e === "object").map((e) => [e.capability, e.status]));

  for (const entry of required) {
    const status = reportedByName.get(entry.capability);
    if (status !== "met") {
      blockers.push(
        blocker(
          "evidence",
          entry.capability,
          `required capability ${JSON.stringify(entry.capability)} (category ${JSON.stringify(entry.category)}) is ${status === undefined ? "missing from the environment's reported evidence" : `reported as ${JSON.stringify(status)}, not "met"`}`,
        ),
      );
    }
  }

  return blockers;
}

/**
 * Runs the full Capability Gate: `profile` (already
 * `validateExecutionProfile`-valid) against `environment`, an evidence
 * object describing what the actual runner/sandbox/adapter enforces right
 * now. Always runs all eight category checks, in a fixed order, and
 * concatenates every blocker found — never stops at the first, and never
 * omits a category. Returns `{ passed, blockers }`; `passed` is `true` only
 * when `blockers` is empty.
 */
export function runCapabilityGate(profile, environment) {
  const blockers = [
    ...checkPaths(profile, environment),
    ...checkCommands(profile, environment),
    ...checkEnvironments(profile, environment),
    ...checkNetwork(profile, environment),
    ...checkIdentities(profile, environment),
    ...checkEffects(profile, environment),
    ...checkResources(profile, environment),
    ...checkEvidence(profile, environment),
  ];
  return { passed: blockers.length === 0, blockers };
}

/**
 * The one function callers should use to decide whether a Flow may
 * activate. Composes `runCapabilityGate`'s result (or accepts one already
 * computed) with any additional Safety Blockers a caller has separately
 * derived (e.g. execution-profile.mjs's `checkExecutionProfileHonoursBoundaries`
 * issues, converted to blockers by the caller). Never returns
 * `activate: true` when `blockers` is non-empty — there is no default-open
 * path here. A flow with open Safety Blockers stays `state: "deferred"`,
 * never silently skipped and never allowed to run.
 */
export function activationDecision(gateResult, extraBlockers = []) {
  const blockers = [...(gateResult?.blockers ?? []), ...extraBlockers];
  if (blockers.length > 0) {
    return { activate: false, state: "deferred", blockers };
  }
  return { activate: true, state: "activatable", blockers: [] };
}
