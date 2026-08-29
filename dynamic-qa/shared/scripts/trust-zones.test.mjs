// dynamic-qa/shared/scripts/trust-zones.test.mjs
//
// Tier 1 tests for the four Trust Zones, zone-transition legality, the hard
// security invariant, and privilege/artifact-flow rules (ticket #151).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TRUST_ZONES,
  UNTRUSTED_CONTENT_SOURCES,
  checkZoneTransition,
  checkHardSecurityInvariant,
  checkAuthoringAuthority,
  checkVerificationCompute,
  checkPrivilegedLaneArtifact,
} from "./trust-zones.mjs";

const PINNED_SHA = "a".repeat(40);

// --- zone transitions -------------------------------------------------------

test("checkZoneTransition: the three forward pipeline steps are legal", () => {
  assert.equal(checkZoneTransition("contract-authoring", "candidate-verification").legal, true);
  assert.equal(checkZoneTransition("candidate-verification", "low-trust-ci").legal, true);
  assert.equal(checkZoneTransition("low-trust-ci", "privileged-publication").legal, true);
});

test("checkZoneTransition: every illegal pair is rejected with a distinct name", () => {
  const seen = new Set();
  for (const from of TRUST_ZONES) {
    for (const to of TRUST_ZONES) {
      const result = checkZoneTransition(from, to);
      const isLegalPipelineStep =
        (from === "contract-authoring" && to === "candidate-verification") ||
        (from === "candidate-verification" && to === "low-trust-ci") ||
        (from === "low-trust-ci" && to === "privileged-publication");
      if (isLegalPipelineStep) continue;

      assert.equal(result.legal, false, `expected ${from} -> ${to} to be illegal`);
      assert.equal(typeof result.error, "string");
      assert.match(result.error, /^trust-zone\.illegal-transition\./);
      assert.ok(!seen.has(result.error), `error name not unique for ${from} -> ${to}: ${result.error}`);
      seen.add(result.error);
    }
  }
  // 16 ordered pairs total, 3 legal, 13 illegal.
  assert.equal(seen.size, 13);
});

test("checkZoneTransition: authoring cannot skip straight to privileged publication", () => {
  const result = checkZoneTransition("contract-authoring", "privileged-publication");
  assert.equal(result.legal, false);
  assert.match(result.error, /^trust-zone\.illegal-transition\.skip:/);
});

test("checkZoneTransition: candidate verification cannot skip low-trust CI", () => {
  const result = checkZoneTransition("candidate-verification", "privileged-publication");
  assert.equal(result.legal, false);
  assert.match(result.error, /^trust-zone\.illegal-transition\.skip:/);
});

test("checkZoneTransition: privileged publication cannot flow backward", () => {
  const result = checkZoneTransition("privileged-publication", "low-trust-ci");
  assert.equal(result.legal, false);
  assert.match(result.error, /^trust-zone\.illegal-transition\.backward:/);
});

test("checkZoneTransition: a zone cannot transition into itself", () => {
  const result = checkZoneTransition("low-trust-ci", "low-trust-ci");
  assert.equal(result.legal, false);
  assert.match(result.error, /^trust-zone\.illegal-transition\.self-loop:/);
});

test("checkZoneTransition: an unknown zone name is rejected", () => {
  const result = checkZoneTransition("contract-authoring", "hosted-agentic-saas");
  assert.equal(result.legal, false);
  assert.match(result.error, /^trust-zone\.illegal-transition\.unknown-zone:/);
});

// --- the hard security invariant -------------------------------------------

test("checkHardSecurityInvariant: untrusted content + privileged identity is rejected", () => {
  const result = checkHardSecurityInvariant({
    contentSource: "repository",
    credentials: { scopes: ["write:contents"] },
    paths: { allowedRead: ["qa/"], allowedWrite: [] },
    network: { mode: "none" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-invariant.untrusted-content-with-privileged-identity"));
});

test("checkHardSecurityInvariant: untrusted content + broad filesystem access is rejected", () => {
  const result = checkHardSecurityInvariant({
    contentSource: "artifact",
    credentials: { scopes: ["read-only"] },
    paths: { allowedRead: ["/"], allowedWrite: [] },
    network: { mode: "none" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-invariant.untrusted-content-with-broad-filesystem"));
});

test("checkHardSecurityInvariant: untrusted content + unrestricted network reach is rejected", () => {
  const result = checkHardSecurityInvariant({
    contentSource: "model",
    credentials: { scopes: ["read-only"] },
    paths: { allowedRead: ["qa/"], allowedWrite: [] },
    network: { mode: "exact-allowlist", allowlist: [{ origin: "https://example.test", service: "x" }], externallyEnforced: false },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-invariant.untrusted-content-with-unrestricted-network"));
});

test("checkHardSecurityInvariant: reports every violated combination at once, not just the first", () => {
  const result = checkHardSecurityInvariant({
    contentSource: "dependency",
    credentials: { scopes: ["publish:release"] },
    paths: { allowedRead: ["~"], allowedWrite: [] },
    network: { mode: "exact-allowlist", allowlist: [{ origin: "https://10.0.0.5", service: "x" }], externallyEnforced: true },
  });
  assert.equal(result.valid, false);
  const names = result.errors.map((e) => e.error).sort();
  assert.deepEqual(names, [
    "trust-invariant.untrusted-content-with-broad-filesystem",
    "trust-invariant.untrusted-content-with-privileged-identity",
    "trust-invariant.untrusted-content-with-unrestricted-network",
  ]);
});

test("checkHardSecurityInvariant: a scoped, unprivileged, network-isolated untrusted config passes", () => {
  const result = checkHardSecurityInvariant({
    contentSource: "issue",
    credentials: { scopes: ["read-only"] },
    paths: { allowedRead: ["qa/"], allowedWrite: [] },
    network: { mode: "none" },
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("checkHardSecurityInvariant: reviewed-base-branch content is not restricted by this invariant", () => {
  const result = checkHardSecurityInvariant({
    contentSource: "reviewed-base-branch",
    credentials: { scopes: ["write:contents"] },
    paths: { allowedRead: ["/"], allowedWrite: ["/"] },
    network: { mode: "exact-allowlist", allowlist: [{ origin: "https://example.test", service: "x" }], externallyEnforced: false },
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("checkHardSecurityInvariant: an exact, externally enforced allowlist classifies as restricted, not unrestricted", () => {
  const result = checkHardSecurityInvariant({
    contentSource: "repository",
    credentials: { scopes: ["read-only"] },
    paths: { allowedRead: ["qa/"], allowedWrite: [] },
    network: {
      mode: "exact-allowlist",
      allowlist: [{ origin: "https://example.test", service: "x" }],
      externallyEnforced: true,
    },
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("UNTRUSTED_CONTENT_SOURCES names every source SPEC-135 User Story 84 lists", () => {
  assert.deepEqual(
    [...UNTRUSTED_CONTENT_SOURCES].sort(),
    ["action", "application", "artifact", "branch", "cache", "dependency", "issue", "mcp", "model", "repository", "test"].sort(),
  );
});

// --- authoring cannot write with publication authority ---------------------

test("checkAuthoringAuthority: contract-authoring with a privileged scope is rejected", () => {
  const result = checkAuthoringAuthority("contract-authoring", { credentials: { scopes: ["push:main"] } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-zone.authoring-privileged-identity-forbidden"));
});

test("checkAuthoringAuthority: contract-authoring with only read-only scopes passes", () => {
  const result = checkAuthoringAuthority("contract-authoring", { credentials: { scopes: ["read-only"] } });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("checkAuthoringAuthority: a non-authoring zone is unaffected by this specific rule", () => {
  const result = checkAuthoringAuthority("privileged-publication", { credentials: { scopes: ["push:main"] } });
  assert.deepEqual(result, { valid: true, errors: [] });
});

// --- verification requires disposable unprivileged compute + pinned commit -

test("checkVerificationCompute: missing disposable compute is rejected", () => {
  const result = checkVerificationCompute({ environment: { unprivilegedUser: true }, sourceCommit: PINNED_SHA });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-zone.verification-requires-disposable-compute"));
});

test("checkVerificationCompute: missing unprivileged compute is rejected", () => {
  const result = checkVerificationCompute({ environment: { disposable: true }, sourceCommit: PINNED_SHA });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-zone.verification-requires-unprivileged-compute"));
});

test("checkVerificationCompute: a missing or non-pinned source commit is rejected", () => {
  const missing = checkVerificationCompute({ environment: { disposable: true, unprivilegedUser: true } });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.error === "trust-zone.verification-requires-pinned-commit"));

  const branchName = checkVerificationCompute({
    environment: { disposable: true, unprivilegedUser: true },
    sourceCommit: "main",
  });
  assert.equal(branchName.valid, false);
  assert.ok(branchName.errors.some((e) => e.error === "trust-zone.verification-requires-pinned-commit"));

  const shortSha = checkVerificationCompute({
    environment: { disposable: true, unprivilegedUser: true },
    sourceCommit: "abc1234",
  });
  assert.equal(shortSha.valid, false);
  assert.ok(shortSha.errors.some((e) => e.error === "trust-zone.verification-requires-pinned-commit"));
});

test("checkVerificationCompute: reports all three violations at once", () => {
  const result = checkVerificationCompute({});
  assert.equal(result.errors.length, 3);
});

test("checkVerificationCompute: disposable, unprivileged compute pinned to a full SHA passes", () => {
  const result = checkVerificationCompute({
    environment: { disposable: true, unprivilegedUser: true },
    sourceCommit: PINNED_SHA,
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

// --- privileged lanes never execute low-trust code or artifacts -----------

test("checkPrivilegedLaneArtifact: a privileged lane refuses low-trust code", () => {
  const result = checkPrivilegedLaneArtifact("privileged-publication", { kind: "code" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-zone.privileged-lane-refuses-code"));
});

test("checkPrivilegedLaneArtifact: a privileged lane refuses a low-trust cache/path/command/url artifact", () => {
  for (const kind of ["cache", "path", "command", "url"]) {
    const result = checkPrivilegedLaneArtifact("privileged-publication", { kind });
    assert.equal(result.valid, false, `expected kind ${kind} to be refused`);
    assert.ok(result.errors.some((e) => e.error === "trust-zone.privileged-lane-refuses-artifact"));
  }
});

test("checkPrivilegedLaneArtifact: a privileged lane refuses an artifact with no declared kind", () => {
  const result = checkPrivilegedLaneArtifact("privileged-publication", {});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.error === "trust-zone.privileged-lane-refuses-artifact"));
});

test("checkPrivilegedLaneArtifact: a privileged lane accepts a Result Envelope or a recompute", () => {
  assert.deepEqual(checkPrivilegedLaneArtifact("privileged-publication", { kind: "result-envelope" }), {
    valid: true,
    errors: [],
  });
  assert.deepEqual(checkPrivilegedLaneArtifact("privileged-publication", { kind: "recompute" }), {
    valid: true,
    errors: [],
  });
});

test("checkPrivilegedLaneArtifact: a non-privileged zone is unconstrained by this rule", () => {
  const result = checkPrivilegedLaneArtifact("low-trust-ci", { kind: "code" });
  assert.deepEqual(result, { valid: true, errors: [] });
});
