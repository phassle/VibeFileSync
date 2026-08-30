// dynamic-qa/shared/scripts/diagnosis.mjs
//
// The Diagnosis Record contract (#158, shared/schemas/dynamic-qa-diagnosis-v1.schema.json,
// DESIGN-dynamic-qa-spec.md §5.6 and §12, qa-generate/SKILL.md's repair-mode
// step 3). Diagnoses every failure on two GENUINELY INDEPENDENT axes:
//
//   - Failure Owner:  product | binding | environment | unresolved
//   - Repeatability:  deterministic | intermittent | unknown
//
// Failure Class is DERIVED from the pair (deriveFailureClass below) — it is
// never assigned directly, and this module is the only place the derivation
// table lives. Neither axis is ever computed from the other: owner is about
// who is accountable for the behaviour; repeatability is about whether the
// failure reproduces. A vague "environment" owner or a bare retry pass must
// never smuggle a repeatability or ownership conclusion in through the back
// door — see assertOriginalAttemptStaysFailed and the repeatabilityBasis
// check in validateDiagnosisRecord for the two concrete guards.
//
// Follows result-envelope.mjs's established pattern: an Issues collector
// that reports every violation rather than stopping at the first, hand-written
// checks instead of a JSON Schema validator dependency, and a pure, throwing
// core (deriveFailureClass) kept separate from the tolerant shape validator.

export const SUPPORTED_SCHEMA = "dynamic-qa-diagnosis-v1";

export const OWNERS = Object.freeze(["product", "binding", "environment", "unresolved"]);
export const REPEATABILITY_VALUES = Object.freeze(["deterministic", "intermittent", "unknown"]);
export const REPEATABILITY_BASES = Object.freeze([
  "retry-pass",
  "reproduction",
  "hypothesis-probe",
  "historical-evidence",
  "external-report",
  "insufficient-evidence",
]);
export const FAILURE_CLASSES = Object.freeze([
  "product-regression",
  "binding-defect",
  "environment-failure",
  "test-flake",
  "unclassified-failure",
]);
export const STATUSES = Object.freeze(["confirmed", "provisional", "safety-blocked"]);
export const ATTEMPT_KINDS = Object.freeze(["original", "retry", "repair-verification", "quarantine-check"]);
export const ATTEMPT_VERDICTS = Object.freeze(["failed", "passed"]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// The full 4 x 3 derivation table, per DESIGN-dynamic-qa-spec.md §12's
// Failure Class policy table, expanded to every one of the 12 Owner x
// Repeatability combinations (the design table collapses several rows —
// "Product / any", "Binding or Environment / intermittent" — this table
// spells all twelve out explicitly so there is exactly one place either
// axis' full cross product is enumerated):
//
//   product     / any            -> product-regression   (owner alone decides; repeatability is irrelevant)
//   binding     / deterministic   -> binding-defect
//   binding     / intermittent    -> test-flake
//   binding     / unknown         -> unclassified-failure
//   environment / deterministic   -> environment-failure
//   environment / intermittent    -> test-flake
//   environment / unknown         -> unclassified-failure
//   unresolved  / any             -> unclassified-failure
const FAILURE_CLASS_TABLE = Object.freeze({
  product: Object.freeze({ deterministic: "product-regression", intermittent: "product-regression", unknown: "product-regression" }),
  binding: Object.freeze({ deterministic: "binding-defect", intermittent: "test-flake", unknown: "unclassified-failure" }),
  environment: Object.freeze({ deterministic: "environment-failure", intermittent: "test-flake", unknown: "unclassified-failure" }),
  unresolved: Object.freeze({ deterministic: "unclassified-failure", intermittent: "unclassified-failure", unknown: "unclassified-failure" }),
});

/**
 * Derives Failure Class from Failure Owner x Repeatability. Pure and total
 * over the 12 valid combinations; throws (fails closed) for any owner or
 * repeatability value outside the two enums, rather than guessing a class.
 */
export function deriveFailureClass(owner, repeatability) {
  if (!OWNERS.includes(owner)) {
    throw new Error(`deriveFailureClass: unknown Failure Owner ${JSON.stringify(owner)} (expected one of ${OWNERS.join(", ")})`);
  }
  if (!REPEATABILITY_VALUES.includes(repeatability)) {
    throw new Error(
      `deriveFailureClass: unknown Repeatability ${JSON.stringify(repeatability)} (expected one of ${REPEATABILITY_VALUES.join(", ")})`,
    );
  }
  return FAILURE_CLASS_TABLE[owner][repeatability];
}

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

const DIAGNOSIS_KEYS = new Set([
  "schema",
  "diagnosisId",
  "flowId",
  "bindingId",
  "failedCapability",
  "productDefectRef",
  "sourceCommit",
  "generatedAt",
  "owner",
  "repeatability",
  "repeatabilityBasis",
  "failureClass",
  "status",
  "causalChain",
  "evidence",
  "counterEvidence",
  "affectedIds",
  "nextAction",
  "attempts",
]);

const ATTEMPT_KEYS = new Set(["attemptId", "kind", "verdict", "recordedAt", "note"]);

function validateStringArray(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.add(path, "must be a list of strings");
    return;
  }
  value.forEach((item, i) => {
    if (!nonEmptyString(item)) issues.add([...path, i], "must be a non-empty string");
  });
}

/**
 * Validates a single attempt entry. Returns { valid, errors }; never throws
 * for an ordinary shape violation.
 */
export function validateAttempt(attempt, path = []) {
  const issues = new Issues();
  if (!isPlainObject(attempt)) {
    issues.add(path, "an attempt must be a mapping");
    return { valid: false, errors: issues.list };
  }
  assertKnownKeys(attempt, ATTEMPT_KEYS, path, issues);
  if (!nonEmptyString(attempt.attemptId)) issues.add([...path, "attemptId"], "attemptId must be a non-empty string");
  if (!ATTEMPT_KINDS.includes(attempt.kind)) {
    issues.add([...path, "kind"], `kind must be one of ${ATTEMPT_KINDS.join(", ")}`);
  }
  if (!ATTEMPT_VERDICTS.includes(attempt.verdict)) {
    issues.add([...path, "verdict"], `verdict must be one of ${ATTEMPT_VERDICTS.join(", ")}`);
  }
  if (!nonEmptyString(attempt.recordedAt) || Number.isNaN(Date.parse(attempt.recordedAt))) {
    issues.add([...path, "recordedAt"], "recordedAt must be a parseable ISO-8601 timestamp");
  }
  if ("note" in attempt && typeof attempt.note !== "string") issues.add([...path, "note"], "note must be a string when present");
  // The single most important property this module enforces: an "original"
  // attempt is, by definition, the run that failed. A record claiming an
  // original attempt with any other verdict is not describing history
  // truthfully.
  if (attempt.kind === "original" && attempt.verdict !== "failed") {
    issues.add([...path, "verdict"], 'an attempt of kind "original" must be recorded with verdict "failed"');
  }
  return { valid: issues.list.length === 0, errors: issues.list };
}

function validateAttempts(attempts, path, issues) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    issues.add(path, "attempts must be a non-empty list");
    return;
  }
  const seenIds = new Set();
  let originalCount = 0;
  attempts.forEach((attempt, i) => {
    const entryPath = [...path, i];
    const check = validateAttempt(attempt, entryPath);
    for (const e of check.errors) issues.list.push(e);
    if (isPlainObject(attempt)) {
      if (attempt.kind === "original") originalCount += 1;
      if (nonEmptyString(attempt.attemptId)) {
        if (seenIds.has(attempt.attemptId)) issues.add([...entryPath, "attemptId"], `duplicate attemptId ${JSON.stringify(attempt.attemptId)}`);
        seenIds.add(attempt.attemptId);
      }
    }
  });
  if (originalCount !== 1) {
    issues.add(path, `attempts must contain exactly one entry of kind "original" (found ${originalCount})`);
  }
}

/**
 * Validates an already-parsed Diagnosis Record JS value against the v1
 * contract, plus the business rules this format cannot express on its own:
 *
 *   - failureClass must equal deriveFailureClass(owner, repeatability) —
 *     Failure Class is derived, never independently assigned.
 *   - a "retry-pass" repeatabilityBasis can never justify "intermittent" —
 *     a single passing retry proves nothing about flake. (It also cannot
 *     justify "deterministic": a pass disproves nothing about the original
 *     failure either. Only "unknown" is compatible with "retry-pass".)
 *   - owner "binding" requires a named bindingId.
 *   - owner "environment" requires a named failedCapability — the exact
 *     capability that failed, never a vague "infra flaked".
 *   - attempts must contain exactly one "original" entry, and it must carry
 *     verdict "failed" (validateAttempt, composed via validateAttempts).
 *
 * Returns { valid, errors }; never throws for an ordinary shape violation.
 */
export function validateDiagnosisRecord(data) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Diagnosis Record must be a mapping");
    return { valid: false, errors: issues.list };
  }

  assertKnownKeys(data, DIAGNOSIS_KEYS, [], issues);

  if (data.schema !== SUPPORTED_SCHEMA) {
    issues.add(["schema"], `unsupported schema version ${JSON.stringify(data.schema)} — this validator only accepts ${JSON.stringify(SUPPORTED_SCHEMA)}`);
  }
  if (!nonEmptyString(data.diagnosisId)) issues.add(["diagnosisId"], "diagnosisId must be a non-empty string");
  if (!nonEmptyString(data.flowId)) issues.add(["flowId"], "flowId must be a non-empty string");
  if (!FULL_SHA_RE.test(data.sourceCommit ?? "")) {
    issues.add(["sourceCommit"], "sourceCommit must be a full 40-character commit SHA, never a branch name or short SHA");
  }
  if (!nonEmptyString(data.generatedAt) || Number.isNaN(Date.parse(data.generatedAt))) {
    issues.add(["generatedAt"], "generatedAt must be a parseable ISO-8601 timestamp");
  }

  const ownerValid = OWNERS.includes(data.owner);
  if (!ownerValid) issues.add(["owner"], `owner must be one of ${OWNERS.join(", ")}`);

  const repeatabilityValid = REPEATABILITY_VALUES.includes(data.repeatability);
  if (!repeatabilityValid) issues.add(["repeatability"], `repeatability must be one of ${REPEATABILITY_VALUES.join(", ")}`);

  if (!REPEATABILITY_BASES.includes(data.repeatabilityBasis)) {
    issues.add(["repeatabilityBasis"], `repeatabilityBasis must be one of ${REPEATABILITY_BASES.join(", ")}`);
  } else if (data.repeatabilityBasis === "retry-pass" && data.repeatability !== "unknown") {
    issues.add(
      ["repeatability"],
      'a "retry-pass" repeatabilityBasis can only ever justify repeatability "unknown" — a retry pass is not evidence of flake (nor of determinism)',
    );
  }

  if (!STATUSES.includes(data.status)) issues.add(["status"], `status must be one of ${STATUSES.join(", ")}`);

  if (ownerValid && repeatabilityValid) {
    const expectedClass = deriveFailureClass(data.owner, data.repeatability);
    if (data.failureClass !== expectedClass) {
      issues.add(
        ["failureClass"],
        `failureClass must be the DERIVED value ${JSON.stringify(expectedClass)} for owner ${JSON.stringify(data.owner)} + repeatability ${JSON.stringify(data.repeatability)} (got ${JSON.stringify(data.failureClass)}) — Failure Class is never assigned directly`,
      );
    }
  } else if (!FAILURE_CLASSES.includes(data.failureClass)) {
    issues.add(["failureClass"], `failureClass must be one of ${FAILURE_CLASSES.join(", ")}`);
  }

  if (data.owner === "binding" && !nonEmptyString(data.bindingId)) {
    issues.add(["bindingId"], 'owner "binding" requires a named bindingId');
  }
  if (data.owner === "environment" && !nonEmptyString(data.failedCapability)) {
    issues.add(["failedCapability"], 'owner "environment" requires the exact failedCapability that failed — never a vague "infra flaked"');
  }

  if (!nonEmptyString(data.causalChain)) issues.add(["causalChain"], "causalChain must be a non-empty string");
  validateStringArray(data.evidence, ["evidence"], issues);
  validateStringArray(data.counterEvidence, ["counterEvidence"], issues);
  validateStringArray(data.affectedIds, ["affectedIds"], issues);
  if ("nextAction" in data && !nonEmptyString(data.nextAction)) issues.add(["nextAction"], "nextAction must be a non-empty string when present");

  validateAttempts(data.attempts, ["attempts"], issues);

  return { valid: issues.list.length === 0, errors: issues.list };
}

/**
 * Repair-eligibility gate (#158 owns eligibility; #159/#160 own repair
 * itself). Ineligible is the DEFAULT: any malformed record, or any record
 * that is not simultaneously status "confirmed", owner "binding", and
 * failureClass "binding-defect" (i.e. also deterministic — see the
 * derivation table), is ineligible. This mirrors DESIGN-dynamic-qa-spec.md
 * §12's policy table, where "Repair Proposal" is the named action only for
 * the Binding / deterministic row; the Binding / intermittent (Test Flake)
 * row's "optional Binding stabilization" is a distinct, narrower action
 * that #159/#160 may build separately — it is not general repair
 * eligibility and is deliberately NOT granted here.
 *
 * Never throws. A record that fails validateDiagnosisRecord is ineligible
 * regardless of what its individual fields happen to say.
 */
export function isRepairEligible(record) {
  if (!isPlainObject(record)) return false;
  const shapeCheck = validateDiagnosisRecord(record);
  if (!shapeCheck.valid) return false;
  return record.status === "confirmed" && record.owner === "binding" && record.failureClass === "binding-defect";
}

/**
 * Returns the single attempt of kind "original" from an attempts list, or
 * undefined if none exists (callers should treat that as a malformed list —
 * validateDiagnosisRecord already requires exactly one).
 */
export function originalAttempt(attempts) {
  return Array.isArray(attempts) ? attempts.find((a) => isPlainObject(a) && a.kind === "original") : undefined;
}

/**
 * Append-only builder for an attempts list. Never mutates an existing
 * entry: every prior entry is (re-)frozen and copied verbatim, and the new
 * entry is validated and frozen before being appended. Refuses to add a
 * second "original" attempt (kind "original" may only ever be recorded
 * once — it is the historical record of the run that failed) and refuses
 * an "original" attempt whose verdict is not "failed". Throws on an invalid
 * attempt or a duplicate original rather than silently accepting one,
 * because this is the one function in the module that can change what an
 * attempts list contains, and it must fail closed.
 */
export function appendAttempt(attempts, newAttempt) {
  if (!Array.isArray(attempts)) throw new TypeError("appendAttempt: attempts must be an array");
  const check = validateAttempt(newAttempt);
  if (!check.valid) {
    throw new Error(`appendAttempt: invalid attempt — ${check.errors.map((e) => e.message).join("; ")}`);
  }
  if (newAttempt.kind === "original" && originalAttempt(attempts)) {
    throw new Error('appendAttempt: an "original" attempt already exists in this list and can never be replaced or duplicated');
  }
  const frozenPrior = attempts.map((a) => Object.freeze({ ...a }));
  return Object.freeze([...frozenPrior, Object.freeze({ ...newAttempt })]);
}

/**
 * Asserts that the "original" attempt is unchanged between two attempts
 * lists (e.g. before/after a retry, a diagnosis pass, a repair-verification
 * attempt, or a quarantine check). Throws with a specific field-level
 * message on any drift, including a changed verdict — "a failed attempt
 * stays failed" is enforced here as a comparison, not merely as a
 * convention appendAttempt happens to follow.
 */
export function assertOriginalAttemptStaysFailed(beforeAttempts, afterAttempts) {
  const before = originalAttempt(beforeAttempts);
  const after = originalAttempt(afterAttempts);
  if (!before || !after) {
    throw new Error("assertOriginalAttemptStaysFailed: both attempts lists must contain an original attempt");
  }
  if (after.verdict !== "failed") {
    throw new Error(
      `assertOriginalAttemptStaysFailed: the original attempt's verdict changed to ${JSON.stringify(after.verdict)} — a failed attempt stays failed after retry, diagnosis, repair verification, or quarantine`,
    );
  }
  for (const key of Object.keys(before)) {
    if (before[key] !== after[key]) {
      throw new Error(
        `assertOriginalAttemptStaysFailed: original attempt field ${JSON.stringify(key)} changed from ${JSON.stringify(before[key])} to ${JSON.stringify(after[key])}`,
      );
    }
  }
}
