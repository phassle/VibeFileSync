// dynamic-qa/shared/scripts/failure-evidence.mjs
//
// The Failure Evidence Bundle contract (#159, shared/schemas/
// dynamic-qa-failure-evidence-v1.schema.json, DESIGN-dynamic-qa-spec.md §5.6
// and §7's Repair workflow step 1, SPEC-135.md user stories 76-78). This is
// the ONLY thing that can authorize `qa-generate repair`: a strict,
// structured, immutable, run/commit-bound artifact — never a scraped prose
// log, never a free-text description of "what went wrong".
//
// Four rules this module exists to make structural, not merely documented:
//
//   1. STRICT AND STRUCTURED, NEVER PROSE. Every fact the bundle carries is
//      an enum, a digest, a bounded-length string, or a nested object with a
//      closed key set (assertKnownKeys, same fail-closed pattern as every
//      other validator in this bundle). There is no `rawLog`, `logExcerpt`,
//      `notes`, or any other unbounded free-text field defined anywhere in
//      this schema. The few fields that do carry short human-readable text
//      (junit failure messages, expected-vs-observed facts, fixture/
//      boundary notes) are capped at MAX_TEXT_FIELD_LENGTH characters and
//      scrubbed with secret-detection.mjs's detectSecretValue. A caller who
//      tries to smuggle a full console dump into one of those fields is
//      rejected for exceeding the bound, with the exact reason named below
//      — "unstructured input cannot reach repair" is therefore not a
//      convention this module asks callers to honour, it is a shape no
//      caller can construct in the first place. A bundle that is itself
//      just a bare string or an object missing the required structure is
//      rejected outright by validateFailureEvidenceBundle's very first
//      check (isPlainObject / assertKnownKeys / required-field checks).
//
//   2. IMMUTABLE. bundleDigest is a canonical content digest
//      (canonical-digest.mjs's contentDigest, the same technique
//      flow-definition.mjs and provenance.mjs already use) computed over
//      every OTHER field. checkBundleImmutability recomputes it and detects
//      any edit — including an edit that tries to "improve" the evidence to
//      justify a conclusion the original run never supported.
//
//   3. NAMES A SPECIFIC RUN, TIED TO A SOURCE COMMIT. repository/
//      sourceCommit/workflow mirror result-envelope.mjs's identity fields
//      exactly (same regexes, same shape — resolveRunReference in
//      github-actions-adapter.mjs already produces this shape from a real
//      GitHub Actions run). The embedded Diagnosis Record's own
//      sourceCommit/flowId/bindingId must agree with the bundle's — a
//      bundle cannot be recycled to authorize repair of an unrelated
//      failure by swapping its top-level identity while keeping an old
//      diagnosis, or vice versa.
//
//   4. ONLY A CONFIRMED BINDING-OWNED FAILURE IS ELIGIBLE. The bundle
//      embeds one already-produced Diagnosis Record (diagnosis.mjs, #158),
//      validated with that module's own validateDiagnosisRecord, and
//      isBundleRepairEligible below composes #158's isRepairEligible
//      exactly rather than re-deriving eligibility. Every other axis
//      combination (product, environment, unresolved, provisional,
//      safety-blocked, and even confirmed binding+intermittent Test-Flake)
//      is refused with a named reason from explainRepairIneligibility.
//
// ONE CAUSAL HYPOTHESIS: the Diagnosis Record's causalChain field is a
// single non-empty STRING (diagnosis.mjs), never an array — so a bundle
// structurally cannot carry more than one causal hypothesis inside its
// embedded diagnosis, and this module's assertKnownKeys rejects any
// additional top-level field (e.g. an "alternativeHypotheses" list) that
// would try to attach a second one beside it. What this module does NOT
// own: actually PURSUING only one hypothesis during a repair attempt (the
// "no second causal theory, no repair loop" rule from DESIGN-dynamic-qa-
// spec.md §7 step 6) is #160's repair-execution logic, not a bundle-shape
// property — #160 owns that.
//
// Follows diagnosis.mjs / result-envelope.mjs's established pattern: an
// Issues collector reporting every violation rather than stopping at the
// first, hand-written checks instead of a JSON Schema validator dependency,
// and functions that never throw for an ordinary shape violation.

import { contentDigest } from "./canonical-digest.mjs";
import { detectSecretValue } from "./secret-detection.mjs";
import { validateDiagnosisRecord, isRepairEligible } from "./diagnosis.mjs";

export const SUPPORTED_SCHEMA = "dynamic-qa-failure-evidence-v1";

// Structural bound on every free-text-ish field. Deliberately short: this is
// a bundle of FACTS about a failure, never a place to paste a log. A field
// that needs more than this to say what happened is not a fact, it is
// prose, and prose cannot authorize a code change.
export const MAX_TEXT_FIELD_LENGTH = 500;
export const MAX_JUNIT_FACTS = 50;
export const MAX_EXPECTED_VS_OBSERVED = 50;
export const MAX_APPROVED_DIAGNOSTICS = 20;
export const MAX_BOUNDARIES_ENFORCED = 50;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const JUNIT_VERDICTS = new Set(["failed", "error", "skipped"]);
const CAPABILITY_STATUSES = new Set(["met", "unmet", "unknown"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function pathStr(path) {
  if (!path || path.length === 0) return "$";
  let out = "$";
  for (const segment of path) out += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  return out;
}

class Issues {
  constructor() {
    this.list = [];
  }
  add(path, message) {
    this.list.push({ path, message: `${message} (at ${pathStr(path)})` });
  }
}

function assertKnownKeys(obj, allowed, path, issues) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) issues.add([...path, key], `unknown key ${JSON.stringify(key)}`);
  }
}

/**
 * Checks a candidate bounded-text value: must be a string, non-empty,
 * within MAX_TEXT_FIELD_LENGTH, and must not look like a secret
 * (secret-detection.mjs's detectSecretValue). This is the single function
 * every free-text field in the bundle runs through — the concrete place
 * "prose cannot authorize repair" and "evidence must be scrubbed" are both
 * enforced.
 */
function checkBoundedText(value, path, issues, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    issues.add(path, "must be a non-empty string");
    return;
  }
  if (value.length > MAX_TEXT_FIELD_LENGTH) {
    issues.add(
      path,
      `exceeds the ${MAX_TEXT_FIELD_LENGTH}-character bounded-evidence length (got ${value.length}) — ` +
        "prose logs cannot authorize a code change; only bounded, structured facts qualify as repair evidence",
    );
    return;
  }
  const secretReason = detectSecretValue(value);
  if (secretReason) {
    issues.add(path, `looks like unscrubbed secret material — ${secretReason}`);
  }
}

function validateWorkflowReference(workflow, path, issues) {
  if (!isPlainObject(workflow)) {
    issues.add(path, "workflow must be a mapping");
    return;
  }
  assertKnownKeys(workflow, new Set(["provider", "workflowFile", "runId", "runAttempt", "url"]), path, issues);
  if (workflow.provider !== "github-actions") {
    issues.add([...path, "provider"], 'provider must be a named, tested adapter identity — only "github-actions" exists today');
  }
  if (!nonEmptyString(workflow.workflowFile)) issues.add([...path, "workflowFile"], "workflowFile must be a non-empty string");
  if (!nonEmptyString(workflow.runId)) issues.add([...path, "runId"], "runId must name the exact run this evidence came from");
  if (!nonEmptyString(workflow.runAttempt)) issues.add([...path, "runAttempt"], "runAttempt must be a non-empty string");
  if ("url" in workflow && typeof workflow.url !== "string") issues.add([...path, "url"], "url must be a string when present");
}

function validateJunitFacts(facts, path, issues) {
  if (!Array.isArray(facts) || facts.length === 0) {
    issues.add(path, "junitFacts must be a non-empty list — normalized facts from the actual failing run, never omitted");
    return;
  }
  if (facts.length > MAX_JUNIT_FACTS) {
    issues.add(path, `junitFacts must not exceed ${MAX_JUNIT_FACTS} entries (got ${facts.length}) — a bundle summarizes, it is never a full report`);
  }
  facts.forEach((entry, i) => {
    const entryPath = [...path, i];
    if (!isPlainObject(entry)) {
      issues.add(entryPath, "each junit fact must be a mapping");
      return;
    }
    assertKnownKeys(entry, new Set(["suite", "name", "verdict", "message", "durationMs"]), entryPath, issues);
    if (!nonEmptyString(entry.suite)) issues.add([...entryPath, "suite"], "suite must be a non-empty string");
    if (!nonEmptyString(entry.name)) issues.add([...entryPath, "name"], "name must be a non-empty string");
    if (!JUNIT_VERDICTS.has(entry.verdict)) issues.add([...entryPath, "verdict"], `verdict must be one of ${[...JUNIT_VERDICTS].join(", ")}`);
    if ("message" in entry) checkBoundedText(entry.message, [...entryPath, "message"], issues);
    if ("durationMs" in entry && !(Number.isFinite(entry.durationMs) && entry.durationMs >= 0)) {
      issues.add([...entryPath, "durationMs"], "durationMs must be a non-negative number when present");
    }
  });
}

function validateExpectedVsObserved(entries, path, issues) {
  if (!Array.isArray(entries) || entries.length === 0) {
    issues.add(path, "expectedVsObserved must be a non-empty list — the safe expected-versus-observed facts the design requires");
    return;
  }
  if (entries.length > MAX_EXPECTED_VS_OBSERVED) {
    issues.add(path, `expectedVsObserved must not exceed ${MAX_EXPECTED_VS_OBSERVED} entries (got ${entries.length})`);
  }
  entries.forEach((entry, i) => {
    const entryPath = [...path, i];
    if (!isPlainObject(entry)) {
      issues.add(entryPath, "each expectedVsObserved entry must be a mapping");
      return;
    }
    assertKnownKeys(entry, new Set(["expectedOutcomeId", "expected", "observed"]), entryPath, issues);
    if (!nonEmptyString(entry.expectedOutcomeId)) issues.add([...entryPath, "expectedOutcomeId"], "expectedOutcomeId must be a non-empty string");
    checkBoundedText(entry.expected, [...entryPath, "expected"], issues);
    checkBoundedText(entry.observed, [...entryPath, "observed"], issues);
  });
}

function validateFixtureBoundaryEnforcement(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.add(path, "fixtureBoundaryEnforcement must be a mapping");
    return;
  }
  assertKnownKeys(value, new Set(["boundariesEnforced", "fixtureIsolation"]), path, issues);
  if (!Array.isArray(value.boundariesEnforced)) {
    issues.add([...path, "boundariesEnforced"], "boundariesEnforced must be a list of strings");
  } else {
    if (value.boundariesEnforced.length > MAX_BOUNDARIES_ENFORCED) {
      issues.add([...path, "boundariesEnforced"], `must not exceed ${MAX_BOUNDARIES_ENFORCED} entries`);
    }
    value.boundariesEnforced.forEach((entry, i) => checkBoundedText(entry, [...path, "boundariesEnforced", i], issues));
  }
  checkBoundedText(value.fixtureIsolation, [...path, "fixtureIsolation"], issues);
}

function validateEnvironmentHealth(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.add(path, "environmentHealth must be a mapping");
    return;
  }
  assertKnownKeys(value, new Set(["checkedAt", "capabilities"]), path, issues);
  if (!nonEmptyString(value.checkedAt) || Number.isNaN(Date.parse(value.checkedAt))) {
    issues.add([...path, "checkedAt"], "checkedAt must be a parseable ISO-8601 timestamp");
  }
  if (!Array.isArray(value.capabilities)) {
    issues.add([...path, "capabilities"], "capabilities must be a list");
    return;
  }
  value.capabilities.forEach((entry, i) => {
    const entryPath = [...path, "capabilities", i];
    if (!isPlainObject(entry)) {
      issues.add(entryPath, "each capability entry must be a mapping");
      return;
    }
    assertKnownKeys(entry, new Set(["name", "status"]), entryPath, issues);
    if (!nonEmptyString(entry.name)) issues.add([...entryPath, "name"], "name must be a non-empty string");
    if (!CAPABILITY_STATUSES.has(entry.status)) issues.add([...entryPath, "status"], `status must be one of ${[...CAPABILITY_STATUSES].join(", ")}`);
  });
}

function validateApprovedDiagnostics(entries, path, issues) {
  if (!Array.isArray(entries)) {
    issues.add(path, "approvedDiagnostics must be a list — digest-addressed pointers only, never raw diagnostic content");
    return;
  }
  if (entries.length > MAX_APPROVED_DIAGNOSTICS) {
    issues.add(path, `approvedDiagnostics must not exceed ${MAX_APPROVED_DIAGNOSTICS} entries (got ${entries.length})`);
  }
  entries.forEach((entry, i) => {
    const entryPath = [...path, i];
    if (!isPlainObject(entry)) {
      issues.add(entryPath, "each approved-diagnostic entry must be a mapping");
      return;
    }
    assertKnownKeys(entry, new Set(["label", "digest"]), entryPath, issues);
    checkBoundedText(entry.label, [...entryPath, "label"], issues);
    if (!SHA256_DIGEST_RE.test(entry.digest ?? "")) {
      issues.add([...entryPath, "digest"], 'digest must be a "sha256:<64-hex>" content digest, never inline content');
    }
  });
}

const BUNDLE_KEYS = new Set([
  "schema",
  "bundleId",
  "repository",
  "sourceCommit",
  "generatedAt",
  "workflow",
  "flowId",
  "bindingId",
  "profileId",
  "provenanceDigest",
  "originalConclusion",
  "diagnosisRecord",
  "junitFacts",
  "expectedVsObserved",
  "fixtureBoundaryEnforcement",
  "environmentHealth",
  "approvedDiagnostics",
  "bundleDigest",
]);

/**
 * Validates an already-parsed Failure Evidence Bundle JS value against the
 * v1 contract. Returns { valid, errors }; never throws for an ordinary
 * shape violation. Composes diagnosis.mjs's validateDiagnosisRecord for the
 * embedded diagnosisRecord rather than re-implementing it, and cross-checks
 * that the bundle's own run/commit/flow/binding identity agrees with the
 * diagnosis it carries — a bundle cannot be recycled across an unrelated
 * failure by mixing an old diagnosis with new top-level identity, or vice
 * versa. Does NOT check bundleDigest against a recomputation — see
 * checkBundleImmutability, kept separate so shape and immutability can be
 * asserted independently (a shape-valid bundle can still be rejected purely
 * for having been mutated after the fact).
 */
export function validateFailureEvidenceBundle(data) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Failure Evidence Bundle must be a mapping — a bare string or free-text log is not a valid bundle shape");
    return { valid: false, errors: issues.list };
  }

  assertKnownKeys(data, BUNDLE_KEYS, [], issues);

  if (data.schema !== SUPPORTED_SCHEMA) {
    issues.add(["schema"], `unsupported schema version ${JSON.stringify(data.schema)} — this validator only accepts ${JSON.stringify(SUPPORTED_SCHEMA)}`);
  }
  if (!nonEmptyString(data.bundleId)) issues.add(["bundleId"], "bundleId must be a non-empty string");
  if (!REPOSITORY_RE.test(data.repository ?? "")) issues.add(["repository"], 'repository must be an exact "owner/name" string');
  if (!FULL_SHA_RE.test(data.sourceCommit ?? "")) {
    issues.add(["sourceCommit"], "sourceCommit must be a full 40-character commit SHA, never a branch name or short SHA — evidence must be tied to a real source commit");
  }
  if (!nonEmptyString(data.generatedAt) || Number.isNaN(Date.parse(data.generatedAt))) {
    issues.add(["generatedAt"], "generatedAt must be a parseable ISO-8601 timestamp");
  }
  validateWorkflowReference(data.workflow, ["workflow"], issues);
  if (!nonEmptyString(data.flowId)) issues.add(["flowId"], "flowId must be a non-empty string");
  if ("bindingId" in data && !nonEmptyString(data.bindingId)) issues.add(["bindingId"], "bindingId must be a non-empty string when present");
  if (!nonEmptyString(data.profileId)) issues.add(["profileId"], "profileId must be a non-empty string — the Execution Profile the run used");
  if (!SHA256_DIGEST_RE.test(data.provenanceDigest ?? "")) {
    issues.add(["provenanceDigest"], 'provenanceDigest must be a "sha256:<64-hex>" content digest tying the bundle to a provenance entry');
  }
  if (data.originalConclusion !== "failed") {
    issues.add(["originalConclusion"], 'originalConclusion must be exactly "failed" — a Failure Evidence Bundle only ever documents a failed run');
  }

  const diagnosisPath = ["diagnosisRecord"];
  if (!isPlainObject(data.diagnosisRecord)) {
    issues.add(diagnosisPath, "diagnosisRecord must be a single Diagnosis Record mapping — never omitted, never a list (a bundle carries exactly one causal hypothesis)");
  } else {
    const diagnosisCheck = validateDiagnosisRecord(data.diagnosisRecord);
    for (const e of diagnosisCheck.errors) issues.list.push({ path: [...diagnosisPath, ...e.path], message: e.message });
    if (diagnosisCheck.valid) {
      const d = data.diagnosisRecord;
      if (nonEmptyString(data.sourceCommit) && d.sourceCommit !== data.sourceCommit) {
        issues.add(
          [...diagnosisPath, "sourceCommit"],
          `diagnosisRecord.sourceCommit (${JSON.stringify(d.sourceCommit)}) must match the bundle's own sourceCommit (${JSON.stringify(data.sourceCommit)}) — evidence cannot be recycled across an unrelated commit`,
        );
      }
      if (nonEmptyString(data.flowId) && d.flowId !== data.flowId) {
        issues.add(
          [...diagnosisPath, "flowId"],
          `diagnosisRecord.flowId (${JSON.stringify(d.flowId)}) must match the bundle's own flowId (${JSON.stringify(data.flowId)}) — evidence cannot be recycled across an unrelated flow`,
        );
      }
      if (nonEmptyString(data.bindingId) && nonEmptyString(d.bindingId) && d.bindingId !== data.bindingId) {
        issues.add(
          [...diagnosisPath, "bindingId"],
          `diagnosisRecord.bindingId (${JSON.stringify(d.bindingId)}) must match the bundle's own bindingId (${JSON.stringify(data.bindingId)}) — evidence cannot be recycled across an unrelated Binding`,
        );
      }
    }
  }

  validateJunitFacts(data.junitFacts, ["junitFacts"], issues);
  validateExpectedVsObserved(data.expectedVsObserved, ["expectedVsObserved"], issues);
  validateFixtureBoundaryEnforcement(data.fixtureBoundaryEnforcement, ["fixtureBoundaryEnforcement"], issues);
  validateEnvironmentHealth(data.environmentHealth, ["environmentHealth"], issues);
  validateApprovedDiagnostics(data.approvedDiagnostics, ["approvedDiagnostics"], issues);

  if (!SHA256_DIGEST_RE.test(data.bundleDigest ?? "")) {
    issues.add(["bundleDigest"], 'bundleDigest must be a "sha256:<64-hex>" content digest over every other field — required for immutability detection');
  }

  return { valid: issues.list.length === 0, errors: issues.list };
}

/**
 * Computes what bundleDigest SHOULD be for a given bundle: contentDigest
 * (canonical-digest.mjs) over every field except bundleDigest itself.
 * Exposed so a bundle producer can compute it once at creation time.
 */
export function computeBundleDigest(bundle) {
  const { bundleDigest: _omit, ...rest } = bundle ?? {};
  return contentDigest(rest);
}

/**
 * THE immutability check. Recomputes bundleDigest from every field except
 * bundleDigest itself and compares it against the stored value. Any
 * disagreement — including a single-character edit anywhere in the bundle,
 * such as an "improved" expected/observed fact meant to justify a
 * conclusion the original run never supported — is reported as a mutated
 * bundle, never silently accepted. Never throws.
 */
export function checkBundleImmutability(bundle) {
  if (!isPlainObject(bundle) || !nonEmptyString(bundle.bundleDigest)) {
    return { valid: false, errors: [{ path: ["bundleDigest"], message: "bundleDigest is required to check immutability (at $.bundleDigest)" }] };
  }
  const expected = computeBundleDigest(bundle);
  if (expected !== bundle.bundleDigest) {
    return {
      valid: false,
      errors: [
        {
          path: ["bundleDigest"],
          message:
            `bundle has been mutated after its digest was computed (recomputed ${expected}, stored ${bundle.bundleDigest}) — ` +
            "evidence must be immutable; regenerate a new bundle from the run rather than editing this one (at $.bundleDigest)",
        },
      ],
    };
  }
  return { valid: true, errors: [] };
}

// Human-readable, per-category refusal reasons. Mirrors diagnosis.mjs's
// derivation table (owner x repeatability) plus status, so every one of the
// documented ineligible categories — product, environment, unresolved,
// provisional, safety-blocked, and confirmed-binding-but-intermittent
// (Test-Flake) — gets its own named reason rather than a single generic
// "not eligible" message.
export function explainRepairIneligibility(diagnosisRecord) {
  const shapeCheck = validateDiagnosisRecord(diagnosisRecord);
  if (!shapeCheck.valid) {
    return "diagnosisRecord is malformed — a malformed Diagnosis Record can never authorize repair";
  }
  const d = diagnosisRecord;
  if (d.status === "safety-blocked") {
    return "diagnosis status is safety-blocked — routes to the Technical Owner as a Safety Blocker, never to repair";
  }
  if (d.status === "provisional") {
    return "diagnosis status is provisional — the diagnosis is incomplete and must be confirmed before repair can be considered";
  }
  if (d.owner === "product") {
    return "Failure Owner is product — this is a Product Regression and routes to the Product Owner, never to a Binding repair";
  }
  if (d.owner === "environment") {
    return `Failure Owner is environment (failedCapability: ${JSON.stringify(d.failedCapability)}) — routes to the accountable environment owner, never to repair`;
  }
  if (d.owner === "unresolved") {
    return "Failure Owner is unresolved — diagnosis is incomplete; ask for exact safe evidence, never repair on an unresolved owner";
  }
  if (d.failureClass === "test-flake") {
    return "Failure Class is test-flake (binding-owned but intermittent) — eligible only for optional Binding stabilization, never general repair";
  }
  if (d.failureClass === "unclassified-failure") {
    return "Failure Class is unclassified-failure — the diagnosis did not reach a confirmed binding-defect conclusion, never repair";
  }
  if (d.owner === "binding" && d.status === "confirmed" && d.failureClass === "binding-defect") {
    return null;
  }
  return "diagnosis does not meet the confirmed + binding-owned + binding-defect combination required for repair";
}

/**
 * THE single function `qa-generate repair` should call to decide whether a
 * bundle may proceed into the repair workflow. Composes, in order:
 *
 *   1. validateFailureEvidenceBundle(bundle) — full shape/structure.
 *   2. checkBundleImmutability(bundle) — digest recomputation.
 *   3. isRepairEligible(bundle.diagnosisRecord) — #158's own eligibility
 *      gate, reused exactly, never re-derived.
 *
 * Returns { eligible, reason, errors }. `reason` is populated by
 * explainRepairIneligibility whenever eligible is false and the bundle was
 * at least shape-valid enough to reach that check; `errors` carries the
 * full structural violation list from steps 1-2 when the bundle itself
 * doesn't even validate. Never throws.
 */
export function isBundleRepairEligible(bundle) {
  const shapeCheck = validateFailureEvidenceBundle(bundle);
  if (!shapeCheck.valid) {
    return { eligible: false, reason: "bundle failed structural validation", errors: shapeCheck.errors };
  }
  const immutabilityCheck = checkBundleImmutability(bundle);
  if (!immutabilityCheck.valid) {
    return { eligible: false, reason: "bundle failed immutability verification", errors: immutabilityCheck.errors };
  }
  const eligible = isRepairEligible(bundle.diagnosisRecord);
  return {
    eligible,
    reason: eligible ? null : explainRepairIneligibility(bundle.diagnosisRecord),
    errors: [],
  };
}
