// dynamic-qa/shared/scripts/failure-evidence.test.mjs
//
// Tier 1 coverage for the Failure Evidence Bundle contract (#159): schema
// fail-closed behaviour, structural rejection of prose/free-text evidence,
// run/commit binding, immutability detection, the full repair-eligibility
// fixture matrix (reusing #158's isRepairEligible), and the single-
// causal-hypothesis structural constraint.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SUPPORTED_SCHEMA,
  MAX_TEXT_FIELD_LENGTH,
  validateFailureEvidenceBundle,
  computeBundleDigest,
  checkBundleImmutability,
  explainRepairIneligibility,
  isBundleRepairEligible,
} from "./failure-evidence.mjs";
import { SUPPORTED_SCHEMA as DIAGNOSIS_SCHEMA, OWNERS, REPEATABILITY_VALUES } from "./diagnosis.mjs";

const SHA = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);
const DIGEST = `sha256:${"a".repeat(64)}`;

function baseDiagnosisRecord(overrides = {}) {
  return {
    schema: DIAGNOSIS_SCHEMA,
    diagnosisId: "diag-001",
    flowId: "checkout-happy-path",
    sourceCommit: SHA,
    generatedAt: "2026-08-30T00:00:00Z",
    owner: "binding",
    repeatability: "deterministic",
    repeatabilityBasis: "reproduction",
    failureClass: "binding-defect",
    status: "confirmed",
    bindingId: "checkout-happy-path-binding",
    causalChain: "Selector changed after a markup update; reproduced unchanged.",
    evidence: ["reproduced on pinned source commit"],
    counterEvidence: [],
    affectedIds: ["checkout-happy-path"],
    attempts: [{ attemptId: "a1", kind: "original", verdict: "failed", recordedAt: "2026-08-30T00:00:00Z" }],
    ...overrides,
  };
}

function baseBundleWithoutDigest(overrides = {}) {
  const diagnosisOverrides = overrides.diagnosisRecord ?? {};
  const rest = { ...overrides };
  delete rest.diagnosisRecord;
  return {
    schema: SUPPORTED_SCHEMA,
    bundleId: "bundle-001",
    repository: "phassle/VibeFileSync",
    sourceCommit: SHA,
    generatedAt: "2026-08-30T00:00:00Z",
    workflow: { provider: "github-actions", workflowFile: "dynamic-qa.yml", runId: "1234", runAttempt: "1" },
    flowId: "checkout-happy-path",
    bindingId: "checkout-happy-path-binding",
    profileId: "checkout-happy-path-profile",
    provenanceDigest: DIGEST,
    originalConclusion: "failed",
    diagnosisRecord: baseDiagnosisRecord(diagnosisOverrides),
    junitFacts: [{ suite: "checkout", name: "happy path", verdict: "failed", message: "assertion failed", durationMs: 120 }],
    expectedVsObserved: [{ expectedOutcomeId: "checkout-confirmation-shown", expected: "confirmation banner visible", observed: "banner absent" }],
    fixtureBoundaryEnforcement: { boundariesEnforced: ["payment provider stubbed"], fixtureIsolation: "fresh namespace per run" },
    environmentHealth: { checkedAt: "2026-08-30T00:00:00Z", capabilities: [{ name: "runtime.node-available", status: "met" }] },
    approvedDiagnostics: [{ label: "console capture", digest: DIGEST }],
    ...rest,
  };
}

function baseBundle(overrides = {}) {
  const withoutDigest = baseBundleWithoutDigest(overrides);
  return { ...withoutDigest, bundleDigest: computeBundleDigest(withoutDigest) };
}

// --- shape: valid bundle round-trips --------------------------------------

test("a well-formed bundle validates, is immutable, and (binding+deterministic+confirmed) is repair-eligible", () => {
  const bundle = baseBundle();
  const shapeCheck = validateFailureEvidenceBundle(bundle);
  assert.equal(shapeCheck.valid, true, JSON.stringify(shapeCheck.errors));
  assert.equal(checkBundleImmutability(bundle).valid, true);
  const result = isBundleRepairEligible(bundle);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
});

// --- fail-closed: unknown fields / unsupported version / malformed -------

test("rejects an unknown top-level field", () => {
  const bundle = baseBundle({ notAField: "x" });
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.message.includes('unknown key "notAField"')));
});

test("rejects an unsupported schema version", () => {
  const bundle = baseBundle({ schema: "dynamic-qa-failure-evidence-v2" });
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.message.includes("unsupported schema version")));
});

test("rejects a malformed bundle missing required fields", () => {
  const bundle = baseBundle();
  delete bundle.provenanceDigest;
  delete bundle.junitFacts;
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.path[0] === "provenanceDigest"));
  assert.ok(check.errors.some((e) => e.path[0] === "junitFacts"));
});

// --- prose / free-text can never be evidence ------------------------------

test("a bare string is not a valid bundle shape at all", () => {
  const check = validateFailureEvidenceBundle("the checkout test failed because the selector was stale, see logs...");
  assert.equal(check.valid, false);
  assert.ok(check.errors[0].message.includes("must be a mapping"));
});

test("an overlong free-text field is rejected as prose, never as evidence", () => {
  const proseDump = "x".repeat(MAX_TEXT_FIELD_LENGTH + 1);
  const bundle = baseBundle({ junitFacts: [{ suite: "checkout", name: "happy path", verdict: "failed", message: proseDump }] });
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.message.includes("prose logs cannot authorize a code change")));
});

// Assembled at runtime rather than written as a literal. The detector sees the
// same string either way, but a committed literal in this shape trips GitHub's
// push protection as a live Stripe key -- correctly, since it cannot tell a
// fixture from the real thing. Keep secret-shaped fixtures synthetic-at-runtime.
const STRIPE_SHAPED_FIXTURE = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");

test("a value that looks like an unscrubbed secret is rejected", () => {
  const bundle = baseBundle({
    expectedVsObserved: [
      { expectedOutcomeId: "checkout-confirmation-shown", expected: "confirmation banner visible", observed: `Bearer ${STRIPE_SHAPED_FIXTURE}` },
    ],
  });
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.message.includes("unscrubbed secret material")));
});

test("raw diagnostic content cannot be inlined — approvedDiagnostics requires a digest, not free content", () => {
  const bundle = baseBundle({ approvedDiagnostics: [{ label: "console capture", digest: "not-a-digest" }] });
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.message.includes('"sha256:<64-hex>" content digest')));
});

// --- must name a specific run tied to a source commit ---------------------

test("rejects a bundle whose sourceCommit is not a full 40-character SHA", () => {
  for (const badCommit of ["main", "c0ffee", ""]) {
    const bundle = baseBundle({ sourceCommit: badCommit });
    const check = validateFailureEvidenceBundle(bundle);
    assert.equal(check.valid, false, `expected rejection for sourceCommit=${JSON.stringify(badCommit)}`);
    assert.ok(check.errors.some((e) => e.path[0] === "sourceCommit"));
  }
});

test("rejects a bundle whose workflow reference is incomplete", () => {
  const bundle = baseBundle({ workflow: { provider: "github-actions", workflowFile: "dynamic-qa.yml", runAttempt: "1" } });
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.path.join(".") === "workflow.runId"));
});

test("rejects a bundle whose embedded diagnosis names a different commit/flow/binding — evidence cannot be recycled", () => {
  const commitMismatch = baseBundle({ diagnosisRecord: { sourceCommit: OTHER_SHA } });
  assert.equal(validateFailureEvidenceBundle(commitMismatch).valid, false);
  assert.ok(validateFailureEvidenceBundle(commitMismatch).errors.some((e) => e.message.includes("unrelated commit")));

  const flowMismatch = baseBundle({ diagnosisRecord: { flowId: "some-other-flow" } });
  assert.ok(validateFailureEvidenceBundle(flowMismatch).errors.some((e) => e.message.includes("unrelated flow")));

  const bindingMismatch = baseBundle({ diagnosisRecord: { bindingId: "some-other-binding" } });
  assert.ok(validateFailureEvidenceBundle(bindingMismatch).errors.some((e) => e.message.includes("unrelated Binding")));
});

// --- immutability ----------------------------------------------------------

test("detects a mutated bundle even after it was originally shape-valid", () => {
  const bundle = baseBundle();
  const mutated = { ...bundle, expectedVsObserved: [{ expectedOutcomeId: "checkout-confirmation-shown", expected: "confirmation banner visible", observed: "a much friendlier observed fact" }] };
  const check = checkBundleImmutability(mutated);
  assert.equal(check.valid, false);
  assert.ok(check.errors[0].message.includes("mutated after its digest was computed"));
});

test("a bundle missing bundleDigest fails immutability, not silently passes", () => {
  const bundle = baseBundle();
  delete bundle.bundleDigest;
  assert.equal(checkBundleImmutability(bundle).valid, false);
});

// --- one causal hypothesis -------------------------------------------------

test("rejects a bundle whose diagnosis carries more than one causal hypothesis (an array instead of one string)", () => {
  const bundle = baseBundle({ diagnosisRecord: { causalChain: ["theory one", "theory two"] } });
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.path.join(".") === "diagnosisRecord.causalChain"));
});

test("rejects a bundle that attaches a second hypothesis field beside the diagnosis", () => {
  const bundle = baseBundle({ alternativeHypotheses: ["theory two"] });
  const check = validateFailureEvidenceBundle(bundle);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.message.includes('unknown key "alternativeHypotheses"')));
});

// --- eligibility reuses #158 exactly; every category gets a named reason --

test("every Failure Owner x Repeatability combination (12) is covered, and only confirmed binding-defect is eligible", () => {
  const REPEATABILITY_BASIS_FOR = { deterministic: "reproduction", intermittent: "historical-evidence", unknown: "insufficient-evidence" };
  const CLASS_FOR = {
    product: { deterministic: "product-regression", intermittent: "product-regression", unknown: "product-regression" },
    binding: { deterministic: "binding-defect", intermittent: "test-flake", unknown: "unclassified-failure" },
    environment: { deterministic: "environment-failure", intermittent: "test-flake", unknown: "unclassified-failure" },
    unresolved: { deterministic: "unclassified-failure", intermittent: "unclassified-failure", unknown: "unclassified-failure" },
  };
  let count = 0;
  for (const owner of OWNERS) {
    for (const repeatability of REPEATABILITY_VALUES) {
      count += 1;
      const failureClass = CLASS_FOR[owner][repeatability];
      const overrides = {
        owner,
        repeatability,
        repeatabilityBasis: REPEATABILITY_BASIS_FOR[repeatability],
        failureClass,
        status: "confirmed",
      };
      if (owner === "binding") overrides.bindingId = "checkout-happy-path-binding";
      if (owner === "environment") overrides.failedCapability = "runtime.node-available";
      const bundleOverrides = owner === "binding" ? {} : { bindingId: undefined };
      const bundle = baseBundle({ diagnosisRecord: overrides, ...bundleOverrides });
      // baseBundle always sets bindingId at the top level; strip it out for
      // non-binding owners so there is nothing to (correctly) cross-check
      // against, matching a real non-binding bundle.
      if (owner !== "binding") delete bundle.bindingId;
      const result = isBundleRepairEligible(bundle);
      const expectEligible = owner === "binding" && repeatability === "deterministic";
      assert.equal(result.eligible, expectEligible, `owner=${owner} repeatability=${repeatability}`);
      if (!expectEligible) {
        assert.ok(typeof result.reason === "string" && result.reason.length > 0, `expected a named reason for owner=${owner} repeatability=${repeatability}`);
      }
    }
  }
  assert.equal(count, 12);
});

test("provisional and safety-blocked statuses are refused with a named reason even for an otherwise binding-defect diagnosis", () => {
  for (const status of ["provisional", "safety-blocked"]) {
    const reason = explainRepairIneligibility(baseDiagnosisRecord({ status }));
    assert.equal(typeof reason, "string");
    assert.ok(reason.includes(status === "provisional" ? "incomplete" : "Safety Blocker"));
  }
});

test("explainRepairIneligibility names product/environment/unresolved routing exactly, and returns null only when eligible", () => {
  assert.match(
    explainRepairIneligibility(baseDiagnosisRecord({ owner: "product", repeatability: "deterministic", failureClass: "product-regression" })),
    /Product Owner/,
  );
  assert.match(
    explainRepairIneligibility(
      baseDiagnosisRecord({ owner: "environment", repeatability: "deterministic", failureClass: "environment-failure", failedCapability: "runtime.node-available", bindingId: undefined }),
    ),
    /accountable environment owner/,
  );
  assert.match(
    explainRepairIneligibility(baseDiagnosisRecord({ owner: "unresolved", repeatability: "unknown", failureClass: "unclassified-failure", bindingId: undefined })),
    /unresolved/,
  );
  assert.equal(explainRepairIneligibility(baseDiagnosisRecord()), null);
});

test("a malformed diagnosis record is refused with a named reason, never silently treated as ineligible-without-explanation", () => {
  const reason = explainRepairIneligibility({ not: "a diagnosis record" });
  assert.ok(reason.includes("malformed"));
});
