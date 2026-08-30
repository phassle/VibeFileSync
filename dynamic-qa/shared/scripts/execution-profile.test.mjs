// dynamic-qa/shared/scripts/execution-profile.test.mjs
//
// Tier 1 tests for the Execution Profile v1 validator and honourability
// check (ticket #150). One case per fail-closed rule: schema validity,
// each activation-relevant field, network-none default, exact-allowlist
// acceptance vs. permissive/wildcard/metadata/internal rejection, and
// boundary honourability against boundary-policy.mjs's
// `resolveBoundaryTreatment` (#145's hand-off).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateExecutionProfile,
  checkExecutionProfileHonoursBoundaries,
  classifyOriginRisk,
  isExactOrigin,
  SUPPORTED_SCHEMA,
} from "./execution-profile.mjs";

function baseProfile(overrides = {}) {
  return {
    schema: SUPPORTED_SCHEMA,
    id: "pilot-safe-profile",
    revision: 1,
    owners: { qaOwner: "Per", technicalOwner: "Alex" },
    allowedPhases: ["candidate-verification", "pr"],
    allowedTestLevels: ["cli"],
    environments: {
      runnerClass: "github-hosted-macos",
      disposable: true,
      disposabilityEvidence: "fresh VM per job, destroyed after",
      sandbox: "vm",
    },
    paths: { allowedRead: ["/repo"], allowedWrite: ["/repo/tmp"] },
    commands: { allowed: ["cargo test --test cli"] },
    resources: { maxProcesses: 4, maxCpuSeconds: 60, maxMemoryMb: 512, maxFileSizeMb: 10, maxWallTimeSeconds: 120 },
    identities: {
      approvedNonProduction: ["ci-bot"],
      denyProduction: ["prod-service-account"],
      denyMetadata: ["169.254.169.254"],
    },
    network: { mode: "none" },
    effects: {
      allowedBoundaryIds: ["filesystem-state"],
      reversibleSideEffects: true,
      namespace: "run-${case.id}",
      cleanup: "rm -rf the per-run temp tree",
    },
    credentials: {},
    diagnostics: {
      classes: [],
      captureConditions: ["failure-only"],
      scrubber: "redact-secrets",
      maxSizeMb: 5,
      audience: "qa-owner",
      retentionDays: 7,
    },
    evidence: {
      adapter: "github-actions",
      capabilities: [{ capability: "environments.disposable", category: "environments" }],
    },
    ...overrides,
  };
}

function assertValid(profile, message) {
  const result = validateExecutionProfile(profile, { expectedId: profile.id });
  assert.equal(result.valid, true, `${message}: ${JSON.stringify(result.errors)}`);
}

function assertInvalid(profile, message) {
  const result = validateExecutionProfile(profile, { expectedId: profile.id });
  assert.equal(result.valid, false, message);
  assert.ok(result.errors.length > 0, `${message}: expected at least one error`);
  return result.errors;
}

// --- happy path ----------------------------------------------------------

test("a complete, well-formed profile validates", () => {
  assertValid(baseProfile(), "baseline fixture should be valid");
});

// --- schema / id / revision ------------------------------------------------

test("an unsupported schema version fails closed", () => {
  assertInvalid(baseProfile({ schema: "dynamic-qa-execution-profile-v2" }), "unsupported schema must be rejected");
});

test("an unknown root key fails closed", () => {
  assertInvalid(baseProfile({ extraField: "nope" }), "unknown root key must be rejected");
});

test("filename/id mismatch is rejected", () => {
  const profile = baseProfile();
  const result = validateExecutionProfile(profile, { expectedId: "some-other-id" });
  assert.equal(result.valid, false);
});

test("revision must be a positive integer", () => {
  assertInvalid(baseProfile({ revision: 0 }), "revision 0 must be rejected");
  assertInvalid(baseProfile({ revision: 1.5 }), "non-integer revision must be rejected");
});

// --- owners / phases / test levels ----------------------------------------

test("owners requires both qaOwner and technicalOwner", () => {
  assertInvalid(baseProfile({ owners: { qaOwner: "Per" } }), "missing technicalOwner must be rejected");
});

test("allowedPhases must be non-empty and from the enum", () => {
  assertInvalid(baseProfile({ allowedPhases: [] }), "empty allowedPhases must be rejected");
  assertInvalid(baseProfile({ allowedPhases: ["staging"] }), "unknown phase must be rejected");
});

test("allowedTestLevels must be from the enum", () => {
  assertInvalid(baseProfile({ allowedTestLevels: ["gui"] }), "unknown test level must be rejected");
});

// --- environments ----------------------------------------------------------

test("environments.disposable must be exactly true", () => {
  assertInvalid(baseProfile({ environments: { ...baseProfile().environments, disposable: false } }), "non-disposable environment must be rejected");
});

test("environments requires disposabilityEvidence and sandbox", () => {
  const env = { runnerClass: "x", disposable: true };
  assertInvalid(baseProfile({ environments: env }), "missing disposabilityEvidence/sandbox must be rejected");
});

// --- paths / commands -----------------------------------------------------

test("paths.allowedRead and allowedWrite are required keys (may be empty arrays)", () => {
  assertValid(baseProfile({ paths: { allowedRead: [], allowedWrite: [] } }), "empty read/write paths are a valid (maximally restrictive) declaration");
  assertInvalid(baseProfile({ paths: { allowedRead: [] } }), "missing allowedWrite key must be rejected");
});

test("commands.allowed must be a list of non-empty strings", () => {
  assertInvalid(baseProfile({ commands: { allowed: [""] } }), "empty command string must be rejected");
});

// --- resources ---------------------------------------------------------

test("every resource limit must be a positive number", () => {
  for (const field of ["maxProcesses", "maxCpuSeconds", "maxMemoryMb", "maxFileSizeMb", "maxWallTimeSeconds"]) {
    const resources = { ...baseProfile().resources, [field]: 0 };
    assertInvalid(baseProfile({ resources }), `${field} of 0 must be rejected`);
  }
});

// --- identities ----------------------------------------------------------

test("denyProduction and denyMetadata must each be non-empty (positive-deny is required)", () => {
  assertInvalid(baseProfile({ identities: { ...baseProfile().identities, denyProduction: [] } }), "empty denyProduction must be rejected");
  assertInvalid(baseProfile({ identities: { ...baseProfile().identities, denyMetadata: [] } }), "empty denyMetadata must be rejected");
});

test("an identifier cannot be both approved and denied", () => {
  assertInvalid(
    baseProfile({
      identities: {
        approvedNonProduction: ["shared-id"],
        denyProduction: ["shared-id"],
        denyMetadata: ["169.254.169.254"],
      },
    }),
    "an id in both approved and deny lists must be rejected",
  );
});

// --- network: defaults to none, exact-allowlist rules -----------------

test("network.mode defaults-shape none requires no other fields", () => {
  assertValid(baseProfile({ network: { mode: "none" } }), "mode none with no other fields is valid");
  assertInvalid(baseProfile({ network: { mode: "none", allowlist: [] } }), "mode none with a stray allowlist key must be rejected");
});

test("network.mode must be one of none | exact-allowlist", () => {
  assertInvalid(baseProfile({ network: { mode: "permissive" } }), "an unknown network mode must be rejected");
});

function exactAllowlistNetwork(overrides = {}) {
  return {
    mode: "exact-allowlist",
    allowlist: [{ origin: "https://api.example-staging.test", service: "example-api" }],
    dnsRecheck: true,
    redirectRecheck: true,
    denyMetadataRange: true,
    denyInternalRange: true,
    denyPublicRange: true,
    externallyEnforced: true,
    enforcementMechanism: "egress proxy allowlisting api.example-staging.test only",
    ...overrides,
  };
}

test("a complete exact allowlist is accepted", () => {
  assertValid(baseProfile({ network: exactAllowlistNetwork() }), "a fully-specified exact-allowlist network must validate");
});

test("exact-allowlist missing any supporting field is rejected, not silently treated as none", () => {
  for (const field of ["dnsRecheck", "redirectRecheck", "denyMetadataRange", "denyInternalRange", "denyPublicRange", "externallyEnforced"]) {
    const network = exactAllowlistNetwork({ [field]: false });
    assertInvalid(baseProfile({ network }), `exact-allowlist with ${field}: false must be rejected`);
  }
  const { enforcementMechanism, ...withoutMechanism } = exactAllowlistNetwork();
  assertInvalid(baseProfile({ network: withoutMechanism }), "exact-allowlist without enforcementMechanism must be rejected");
});

test("a wildcard/permissive allowlist entry is rejected", () => {
  const network = exactAllowlistNetwork({ allowlist: [{ origin: "https://*.example.test", service: "anything" }] });
  assertInvalid(baseProfile({ network }), "wildcard origin must be rejected");

  const cidrNetwork = exactAllowlistNetwork({ allowlist: [{ origin: "https://10.0.0.0/8", service: "anything" }] });
  assertInvalid(baseProfile({ network: cidrNetwork }), "CIDR-style origin must be rejected");
});

test("metadata, internal, and public-catch-all allowlist targets are denied", () => {
  const metadataNetwork = exactAllowlistNetwork({ allowlist: [{ origin: "https://169.254.169.254", service: "metadata" }] });
  assertInvalid(baseProfile({ network: metadataNetwork }), "metadata target must be rejected");

  const internalNetwork = exactAllowlistNetwork({ allowlist: [{ origin: "https://10.0.0.5", service: "internal-service" }] });
  assertInvalid(baseProfile({ network: internalNetwork }), "internal/private target must be rejected");

  const localNetwork = exactAllowlistNetwork({ allowlist: [{ origin: "https://localhost", service: "loopback" }] });
  assertInvalid(baseProfile({ network: localNetwork }), "loopback target must be rejected");

  const publicNetwork = exactAllowlistNetwork({ allowlist: [{ origin: "https://0.0.0.0", service: "catch-all" }] });
  assertInvalid(baseProfile({ network: publicNetwork }), "0.0.0.0 catch-all target must be rejected");
});

test("classifyOriginRisk / isExactOrigin classify each case correctly", () => {
  assert.equal(classifyOriginRisk("https://api.example-staging.test"), "exact");
  assert.equal(classifyOriginRisk("https://*.example.test"), "wildcard");
  assert.equal(classifyOriginRisk("https://169.254.169.254"), "metadata");
  assert.equal(classifyOriginRisk("https://metadata.google.internal"), "metadata");
  assert.equal(classifyOriginRisk("https://10.1.2.3"), "internal");
  assert.equal(classifyOriginRisk("https://192.168.1.1"), "internal");
  assert.equal(classifyOriginRisk("not-a-url"), "malformed");
  assert.equal(isExactOrigin("https://api.example-staging.test"), true);
  assert.equal(isExactOrigin("https://*.example.test"), false);
});

test("classifyOriginRisk normalizes before classifying — closes the network-deny bypass", () => {
  // Embedded userinfo must not smuggle a private host past the regex: the
  // raw host capture used to swallow "evil.test@10.0.0.5" as one opaque
  // string, which matched none of the deny checks and fell through to
  // "exact". A well-formed origin never carries userinfo, so this is
  // rejected outright rather than silently stripped and reclassified.
  assert.equal(classifyOriginRisk("https://evil.test@10.0.0.5"), "malformed");
  assert.notEqual(classifyOriginRisk("https://evil.test@10.0.0.5"), "exact");

  // A trailing FQDN root dot used to dodge both the METADATA_HOSTS set
  // membership check and the ".internal" suffix check.
  assert.equal(classifyOriginRisk("https://metadata.google.internal."), "metadata");
  assert.equal(classifyOriginRisk("https://foo.internal."), "internal");

  // Mixed-case host must still match the (lowercase) deny lists.
  assert.equal(classifyOriginRisk("https://METADATA.GOOGLE.INTERNAL"), "metadata");

  // IPv6 loopback and the AWS IMDSv2 IPv6 metadata address, bracketed and
  // with an explicit port.
  assert.equal(classifyOriginRisk("https://[::1]"), "internal");
  assert.equal(classifyOriginRisk("https://[::1]:8443"), "internal");
  assert.equal(classifyOriginRisk("https://[fd00:ec2::254]"), "metadata");

  // Port variant of a plain private IPv4 host.
  assert.equal(classifyOriginRisk("https://10.0.0.5:8443"), "internal");

  // A path, query, or fragment suffix is not a clean single origin —
  // reject rather than guess at the intended host.
  assert.equal(classifyOriginRisk("https://example.test/foo"), "malformed");
  assert.equal(classifyOriginRisk("https://example.test?x=1"), "malformed");
  assert.equal(classifyOriginRisk("https://example.test#frag"), "malformed");

  // A malformed origin must never default to "exact".
  for (const bad of [
    "https://evil.test@10.0.0.5",
    "https://example.test/foo",
    "ftp://example.test",
    "https://",
  ]) {
    assert.notEqual(classifyOriginRisk(bad), "exact", `${bad} must not classify as exact`);
  }
});

// --- effects -------------------------------------------------------------

test("reversibleSideEffects true requires namespace and cleanup", () => {
  assertInvalid(
    baseProfile({ effects: { allowedBoundaryIds: ["x"], reversibleSideEffects: true } }),
    "missing namespace/cleanup with reversibleSideEffects true must be rejected",
  );
});

test("reversibleSideEffects false does not require namespace/cleanup", () => {
  assertValid(
    baseProfile({ effects: { allowedBoundaryIds: [], reversibleSideEffects: false } }),
    "reversibleSideEffects false with no isolation fields is valid",
  );
});

// --- credentials ---------------------------------------------------------

test("credentials may be an empty object when no credential is required", () => {
  assertValid(baseProfile({ credentials: {} }), "empty credentials object is valid");
});

test("declaring a credential handle requires the rest of the credential fields", () => {
  assertInvalid(baseProfile({ credentials: { handle: "staging-token" } }), "handle without audience/scopes/etc must be rejected");
});

test("a complete credential declaration validates", () => {
  assertValid(
    baseProfile({
      credentials: {
        handle: "staging-token",
        audience: "staging-api",
        scopes: ["read:cases"],
        lifetimeSeconds: 300,
        injectionPhase: "candidate-verification",
        revocation: "revoked at end of job by the provider adapter",
      },
    }),
    "a complete credential declaration must validate",
  );
});

// --- diagnostics ---------------------------------------------------------

test("diagnostics requires a scrubber even when classes is empty", () => {
  assertInvalid(
    baseProfile({ diagnostics: { classes: [], captureConditions: [], scrubber: "", maxSizeMb: 0, audience: "qa", retentionDays: 0 } }),
    "empty scrubber must be rejected even with no diagnostic classes",
  );
});

// --- evidence --------------------------------------------------------------

test("evidence.capabilities must be non-empty", () => {
  assertInvalid(baseProfile({ evidence: { adapter: "github-actions", capabilities: [] } }), "empty capability list must be rejected");
});

test("duplicate capability names in evidence are rejected", () => {
  assertInvalid(
    baseProfile({
      evidence: {
        adapter: "github-actions",
        capabilities: [
          { capability: "network.egress-externally-enforced", category: "network" },
          { capability: "network.egress-externally-enforced", category: "network" },
        ],
      },
    }),
    "duplicate capability name must be rejected",
  );
});

// --- honourability against Boundary Declarations (#145 hand-off) --------

test("honourability: a profile permitting an undeclared boundary is unhonourable", () => {
  const profile = baseProfile({ effects: { allowedBoundaryIds: ["undeclared-boundary"], reversibleSideEffects: false } });
  const flowBoundaries = [{ id: "some-other-boundary", system: "x", treatment: "simulated", behavior: "x", side_effects: "none" }];
  const result = checkExecutionProfileHonoursBoundaries(profile, flowBoundaries);
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /undeclared-boundary/);
});

test("honourability: a profile permitting a boundary the flow explicitly forbids is unhonourable", () => {
  const profile = baseProfile({ effects: { allowedBoundaryIds: ["payments"], reversibleSideEffects: false } });
  const flowBoundaries = [{ id: "payments", system: "payments provider", treatment: "forbidden", behavior: "x", side_effects: "none" }];
  const result = checkExecutionProfileHonoursBoundaries(profile, flowBoundaries);
  assert.equal(result.valid, false);
});

test("honourability: a profile permitting exactly the flow's real/simulated boundaries is honourable", () => {
  const profile = baseProfile({ effects: { allowedBoundaryIds: ["owned-service"], reversibleSideEffects: false } });
  const flowBoundaries = [{ id: "owned-service", system: "the product", treatment: "real", behavior: "x", side_effects: "none", role: "owned" }];
  const result = checkExecutionProfileHonoursBoundaries(profile, flowBoundaries);
  assert.equal(result.valid, true);
});

test("honourability: a real boundary with side effects requires the profile to include it AND declare isolation", () => {
  const flowBoundaries = [
    { id: "owned-service", system: "the product", treatment: "real", behavior: "x", side_effects: "writes rows", role: "owned", isolation: { namespace: "run-1", cleanup: "drop rows" } },
  ];

  const missingFromAllowlist = baseProfile({ effects: { allowedBoundaryIds: [], reversibleSideEffects: false } });
  const missingResult = checkExecutionProfileHonoursBoundaries(missingFromAllowlist, flowBoundaries);
  assert.equal(missingResult.valid, false);

  const noProfileIsolation = baseProfile({ effects: { allowedBoundaryIds: ["owned-service"], reversibleSideEffects: false } });
  const noIsolationResult = checkExecutionProfileHonoursBoundaries(noProfileIsolation, flowBoundaries);
  assert.equal(noIsolationResult.valid, false);

  const honoured = baseProfile({
    effects: { allowedBoundaryIds: ["owned-service"], reversibleSideEffects: true, namespace: "run-${case.id}", cleanup: "drop rows" },
  });
  const honouredResult = checkExecutionProfileHonoursBoundaries(honoured, flowBoundaries);
  assert.equal(honouredResult.valid, true);
});
