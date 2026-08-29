// dynamic-qa/shared/scripts/quarantine.mjs
//
// The Quarantine Record contract (#161, shared/schemas/dynamic-qa-quarantine-v1.schema.json,
// DESIGN-dynamic-qa-spec.md §5.6 and §12, SPEC-135.md user stories 82-83):
//
//   "Quarantine is a separate, expiring policy overlay. It leaves base Flow
//   State, Freshness, and Enforcement State visible, routes the Binding to a
//   named advisory lane, and blocks qualification. A skipped test, retry,
//   fixme, deleted CI enrollment, or expected-failure marker is not
//   quarantine."
//
// THIS IS AN OVERLAY, NOT A FOURTH LIFECYCLE AXIS (#157)
// --------------------------------------------------------------------------
// lifecycle-state.mjs owns Flow State, Binding Freshness, and Enforcement
// State, each with exactly one mutator that rejects any delta carrying a
// foreign key. This module never imports those mutators and never
// constructs a delta for them — a Quarantine Record's own shape (below)
// shares NO key names with FLOW_STATE_DELTA_KEYS, FRESHNESS_DELTA_KEYS, or
// ENFORCEMENT_DELTA_KEYS, so even a caller who deliberately tried to feed a
// Quarantine Record into applyFlowStateChange / applyBindingFreshnessReport
// / applyEnforcementPromotion would be refused at the door on foreign keys
// alone, before any transition logic ran (see quarantine.test.mjs, which
// proves exactly this for all three). This module exports no apply*/mutate*
// function of its own for any of the three axes — there is nothing here
// that COULD write them.
//
// STRUCTURAL, NOT ADVISORY, EXCLUSION FROM PASS / COVERAGE / QUALIFICATION
// --------------------------------------------------------------------------
// `quarantineReportStatus` and `excludeQuarantinedFromQualifyingRuns` do not
// ask a caller to remember to check quarantine before counting something —
// they are the only entry points this module offers for "did this pass",
// "does this count as coverage", and "does this count toward a Qualifying
// Run", and each one hard-codes `false` for all three whenever quarantine is
// active, regardless of what the underlying test outcome or run record says.
// A caller cannot construct an active-quarantine case that reports true for
// any of the three: the `false` values are literals in the source, not the
// result of evaluating the passed-in outcome.
//
// FAIL CLOSED ON EXPIRY AND MALFORMED SHAPE
// --------------------------------------------------------------------------
// `isQuarantineActive` treats "expired" and "malformed" as two of the ways a
// quarantine record can be INACTIVE — never as a third, more permissive
// state. There is no code path in this module that reads a record failing
// `validateQuarantineRecord`, or a record whose `expiresAt` has passed, as
// still granting the advisory exception. Both collapse to the same
// `active: false` outcome a caller must treat exactly like "no quarantine
// exists at all" — the Binding falls back to its own real Flow State /
// Binding Freshness / Enforcement State, unprotected by any exception.
//
// NO AUTOMATIC QUARANTINE
// --------------------------------------------------------------------------
// `createQuarantineRecord` is the only constructor this module exports, and
// it throws unless `approvals` already carries BOTH gates with
// `present: true` and a named `identifier` (reusing authority.mjs's own
// gate shape and validator — never a bespoke boolean pair). There is no
// code path anywhere in this bundle — not in diagnosis.mjs, not in
// lifecycle-state.mjs, not here — that derives a Quarantine Record from a
// Diagnosis Record, a failed run, or an expiry timer without that explicit
// approvals input already present. Quarantine is always a human decision;
// this module can only ever record one, never manufacture one.

import { validateAuthorityRecord } from "./authority.mjs";
import { OWNERS, FAILURE_CLASSES } from "./diagnosis.mjs";
import { isQualifyingRun, summarizeQualifyingRuns } from "./lifecycle-state.mjs";

export const SUPPORTED_SCHEMA = "dynamic-qa-quarantine-v1";

export const DEFAULT_QUARANTINE_DAYS = 7;

// Quarantine only ever requests the advisory lane — DESIGN-dynamic-qa-spec.md
// §5.6's "requested effective advisory lane". There is deliberately no other
// legal value; `effectiveLane` is validated as a const, not an enum of two.
export const QUARANTINE_EFFECTIVE_LANE = "advisory";

const URI_RE = /^https?:\/\/\S+$/;

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

const QUARANTINE_KEYS = new Set([
  "schema",
  "quarantineId",
  "flowId",
  "bindingId",
  "diagnosisId",
  "originatingFailureRef",
  "owner",
  "failureClass",
  "trackedIssue",
  "acceptedRisk",
  "approvals",
  "startAt",
  "expiresAt",
  "accountableOwner",
  "effectiveLane",
  "evidence",
]);

// The exact set of keys any of lifecycle-state.mjs's three axis deltas will
// ever accept (kept in sync by inspection, not by importing a mutable
// internal — the point is that QUARANTINE_KEYS shares none of them, so a
// Quarantine Record can never even be misread as one of those deltas).
const LIFECYCLE_AXIS_DELTA_KEYS = new Set(["to", "context", "freshness", "qualifyingRunSummary", "approval"]);

/**
 * Structural self-check: true only if no key a Quarantine Record can ever
 * carry also appears in a lifecycle axis delta shape. Exercised by
 * quarantine.test.mjs so a future edit to either key set trips a test
 * rather than silently opening a write path.
 */
export function quarantineSharesNoKeyWithLifecycleAxisDeltas() {
  for (const key of QUARANTINE_KEYS) {
    if (LIFECYCLE_AXIS_DELTA_KEYS.has(key)) return false;
  }
  return true;
}

function validateApprovals(approvals, path, issues) {
  if (!isPlainObject(approvals)) {
    issues.add(path, "approvals must be a mapping");
    return;
  }
  const result = validateAuthorityRecord(approvals);
  if (!result.ok) {
    for (const message of result.errors) issues.add(path, message);
    return;
  }
  // validateAuthorityRecord allows a gate to be present:false (a legitimate
  // in-progress Setup Review Packet state). A Quarantine Record's own
  // approvals must already be BOTH granted — an unapproved or half-approved
  // gate here is exactly the "malformed" shape this validator must reject,
  // not a record waiting on the second signature.
  for (const key of ["qaOwnerGate", "technicalOwnerGate"]) {
    const gate = approvals[key];
    if (!gate || gate.present !== true || !nonEmptyString(gate.identifier)) {
      issues.add([...path, key], `${key} must be present:true with a named identifier — quarantine requires BOTH approvals to already be granted`);
    }
  }
}

function validateEvidence(evidence, path, issues) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    issues.add(path, "evidence must be a non-empty list");
    return;
  }
  evidence.forEach((item, i) => {
    if (!nonEmptyString(item)) issues.add([...path, i], "each evidence entry must be a non-empty string");
  });
}

/**
 * Validates an already-parsed Quarantine Record JS value against the v1
 * contract, plus the business rules a plain schema cannot express:
 *
 *   - expiresAt must be a parseable timestamp strictly after startAt.
 *   - approvals must carry BOTH qaOwnerGate and technicalOwnerGate already
 *     present:true with a named identifier (reuses authority.mjs's own
 *     validator, then tightens it — see validateApprovals above).
 *   - effectiveLane must be exactly "advisory".
 *   - owner / failureClass reuse diagnosis.mjs's own enums verbatim.
 *
 * Returns { valid, errors }; never throws for an ordinary shape violation —
 * a caller loading an on-disk record always gets a structured result it can
 * use to fail closed, never an exception it might accidentally swallow.
 */
export function validateQuarantineRecord(data) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Quarantine Record must be a mapping");
    return { valid: false, errors: issues.list };
  }

  assertKnownKeys(data, QUARANTINE_KEYS, [], issues);

  if (data.schema !== SUPPORTED_SCHEMA) {
    issues.add(["schema"], `unsupported schema version ${JSON.stringify(data.schema)} — this validator only accepts ${JSON.stringify(SUPPORTED_SCHEMA)}`);
  }
  if (!nonEmptyString(data.quarantineId)) issues.add(["quarantineId"], "quarantineId must be a non-empty string");
  if (!nonEmptyString(data.flowId)) issues.add(["flowId"], "flowId must be a non-empty string");
  if (!nonEmptyString(data.bindingId)) issues.add(["bindingId"], "bindingId must be a non-empty string — quarantine is scoped to a named Binding");
  if (!nonEmptyString(data.diagnosisId)) issues.add(["diagnosisId"], "diagnosisId must be a non-empty string — quarantine attaches to a diagnosed failure");
  if (!nonEmptyString(data.originatingFailureRef)) issues.add(["originatingFailureRef"], "originatingFailureRef must be a non-empty string");

  if (!OWNERS.includes(data.owner)) issues.add(["owner"], `owner must be one of ${OWNERS.join(", ")}`);
  if (!FAILURE_CLASSES.includes(data.failureClass)) issues.add(["failureClass"], `failureClass must be one of ${FAILURE_CLASSES.join(", ")}`);

  if (!(typeof data.trackedIssue === "string" && URI_RE.test(data.trackedIssue))) {
    issues.add(["trackedIssue"], `trackedIssue must be a stable http(s) URI (got ${JSON.stringify(data.trackedIssue)}) — quarantine is never untracked`);
  }
  if (!nonEmptyString(data.acceptedRisk)) issues.add(["acceptedRisk"], "acceptedRisk must be a non-empty string");

  validateApprovals(data.approvals, ["approvals"], issues);

  const startValid = nonEmptyString(data.startAt) && !Number.isNaN(Date.parse(data.startAt));
  if (!startValid) issues.add(["startAt"], "startAt must be a parseable ISO-8601 timestamp");
  const expiresValid = nonEmptyString(data.expiresAt) && !Number.isNaN(Date.parse(data.expiresAt));
  if (!expiresValid) {
    issues.add(["expiresAt"], "expiresAt must be a parseable ISO-8601 timestamp — an absent or unparseable expiresAt is malformed, never 'no expiry'");
  } else if (startValid && Date.parse(data.expiresAt) <= Date.parse(data.startAt)) {
    issues.add(["expiresAt"], "expiresAt must be strictly after startAt");
  }

  if (!nonEmptyString(data.accountableOwner)) issues.add(["accountableOwner"], "accountableOwner must be a non-empty string");

  if (data.effectiveLane !== QUARANTINE_EFFECTIVE_LANE) {
    issues.add(["effectiveLane"], `effectiveLane must be exactly ${JSON.stringify(QUARANTINE_EFFECTIVE_LANE)} (got ${JSON.stringify(data.effectiveLane)})`);
  }

  validateEvidence(data.evidence, ["evidence"], issues);

  return { valid: issues.list.length === 0, errors: issues.list };
}

/**
 * Builds a new, immutable Quarantine Record. This is the ONLY constructor
 * this module exports, and it is deliberately strict rather than helpful:
 *
 *   - `input.approvals` must already satisfy validateApprovals (both gates
 *     present:true with a named identifier) — there is no default, no
 *     "pending" state, and no way to call this function and get back a
 *     record with an unapproved gate. Quarantine is always an explicit
 *     human decision; this function can only transcribe one that has
 *     already been made, never manufacture consent.
 *   - `input.startAt` defaults to "now" (ISO string) when omitted.
 *   - `input.expiresAt` defaults to `input.startAt` + DEFAULT_QUARANTINE_DAYS
 *     (7) days when omitted — the spec's default seven-day expiry. A caller
 *     may pass a shorter or longer explicit expiresAt; there is no upper
 *     bound enforced here (that is a policy question for review, not this
 *     module).
 *   - `input.effectiveLane` is never read — the record always gets
 *     QUARANTINE_EFFECTIVE_LANE ("advisory"), because there is no other
 *     lane quarantine may ever request.
 *   - The returned record, its `evidence` array, and its `approvals` object
 *     are all frozen. No function in this module edits an existing record's
 *     evidence or approvals — evidence is immutable from the moment of
 *     creation.
 *
 * Throws (fails closed) if the assembled record does not pass
 * validateQuarantineRecord — a malformed record is never returned, not even
 * transiently.
 */
export function createQuarantineRecord(input) {
  const raw = isPlainObject(input) ? input : {};
  const startAt = nonEmptyString(raw.startAt) ? raw.startAt : new Date().toISOString();
  const expiresAt = nonEmptyString(raw.expiresAt) ? raw.expiresAt : defaultExpiry(startAt);

  const record = {
    schema: SUPPORTED_SCHEMA,
    quarantineId: raw.quarantineId,
    flowId: raw.flowId,
    bindingId: raw.bindingId,
    diagnosisId: raw.diagnosisId,
    originatingFailureRef: raw.originatingFailureRef,
    owner: raw.owner,
    failureClass: raw.failureClass,
    trackedIssue: raw.trackedIssue,
    acceptedRisk: raw.acceptedRisk,
    approvals: isPlainObject(raw.approvals) ? Object.freeze({ ...raw.approvals }) : raw.approvals,
    startAt,
    expiresAt,
    accountableOwner: raw.accountableOwner,
    effectiveLane: QUARANTINE_EFFECTIVE_LANE,
    evidence: Array.isArray(raw.evidence) ? Object.freeze([...raw.evidence]) : raw.evidence,
  };

  const check = validateQuarantineRecord(record);
  if (!check.valid) {
    throw new Error(`createQuarantineRecord: refused to create a malformed Quarantine Record — ${check.errors.map((e) => e.message).join("; ")}`);
  }

  return Object.freeze(record);
}

/**
 * The default expiry for a Quarantine Record started at `startAt`:
 * `startAt` + DEFAULT_QUARANTINE_DAYS (7) days, as an ISO-8601 string.
 * Throws on an unparseable `startAt` rather than silently returning an
 * invalid timestamp.
 */
export function defaultExpiry(startAt) {
  const parsed = Date.parse(startAt);
  if (Number.isNaN(parsed)) {
    throw new Error(`defaultExpiry: startAt is not a parseable timestamp (got ${JSON.stringify(startAt)})`);
  }
  return new Date(parsed + DEFAULT_QUARANTINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Decides whether a Quarantine Record is currently ACTIVE — i.e. whether its
 * advisory exception currently applies. Fails closed on both ways a record
 * can be inactive, and does not distinguish them in severity: either one
 * means "treat this Binding as if no quarantine existed":
 *
 *   - malformed: `record` fails validateQuarantineRecord. This includes a
 *     record missing either approval gate, an unparseable timestamp, or a
 *     non-"advisory" effectiveLane.
 *   - expired: `record` is well-formed but `now` is at or after
 *     `record.expiresAt`.
 *
 * Returns `{ active, reason, errors }`. `reason` is one of
 * "malformed" | "expired" | null (null only when active:true).
 */
export function isQuarantineActive(record, now = new Date()) {
  const check = validateQuarantineRecord(record);
  if (!check.valid) {
    return { active: false, reason: "malformed", errors: check.errors };
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const expiresMs = Date.parse(record.expiresAt);
  if (Number.isNaN(nowMs) || nowMs >= expiresMs) {
    return { active: false, reason: "expired", errors: [] };
  }
  return { active: true, reason: null, errors: [] };
}

/**
 * The single entry point for "does this quarantine change what a caller may
 * report for one Binding". Returns a status string plus three booleans that
 * are literal `false` whenever quarantine is active — not a computation
 * over `testPassed`, so no caller-supplied outcome can ever flip them true
 * while quarantine holds:
 *
 *   { status: "missing-protection", countsAsPass: false,
 *     countsAsCoverage: false, countsAsQualifying: false, reason, quarantine }
 *
 * When quarantine is NOT active (absent, expired, or malformed), this
 * function passes `testPassed` straight through unmodified — quarantine
 * that has lapsed or was never valid grants no exception at all, so the
 * Binding is reported exactly as if it had never been quarantined.
 */
export function quarantineReportStatus({ testPassed, quarantine, now = new Date() } = {}) {
  const decision = isQuarantineActive(quarantine, now);
  if (decision.active) {
    return {
      status: "missing-protection",
      countsAsPass: false,
      countsAsCoverage: false,
      countsAsQualifying: false,
      reason: `bindingId ${JSON.stringify(quarantine.bindingId)} is under active quarantine until ${quarantine.expiresAt} (tracked at ${quarantine.trackedIssue}) — quarantine never counts as pass, coverage, or a Qualifying Run`,
      quarantine,
    };
  }
  return {
    status: testPassed === true ? "protected-pass" : "protected-fail",
    countsAsPass: testPassed === true,
    countsAsCoverage: true,
    countsAsQualifying: true,
    reason: decision.reason === "expired" ? "quarantine has expired and grants no exception — reported as an ordinary Binding" : null,
    quarantine: null,
  };
}

/**
 * A visible portfolio/reporting row for one Binding under a (possibly
 * inactive) quarantine. Never silent: a malformed or expired record still
 * produces a row naming exactly why the Binding is unprotected, rather than
 * disappearing from a report or being folded into a generic "OK" line.
 */
export function describeQuarantineForReporting(quarantine, now = new Date()) {
  const decision = isQuarantineActive(quarantine, now);
  const base = isPlainObject(quarantine) ? quarantine : {};
  return {
    flowId: base.flowId ?? null,
    bindingId: base.bindingId ?? null,
    quarantineId: base.quarantineId ?? null,
    active: decision.active,
    reason: decision.reason,
    trackedIssue: base.trackedIssue ?? null,
    accountableOwner: base.accountableOwner ?? null,
    expiresAt: base.expiresAt ?? null,
    missingProtection: decision.active === true,
  };
}

/**
 * Reuses #157's Qualifying Run model (isQualifyingRun / summarizeQualifyingRuns
 * from lifecycle-state.mjs) UNCHANGED, and proves a quarantined flow cannot
 * qualify by filtering candidate runs BEFORE they ever reach that model: a
 * run belonging to a bindingId (or flowId, when a run carries one) named by
 * an actively-quarantined record is dropped here, so lifecycle-state.mjs's
 * own qualifying-run logic never even sees it — there is no field on a run
 * record ("quarantined: false") that could be forged to get back in, because
 * the exclusion happens by identity lookup against the quarantine list, not
 * by trusting anything the run record itself claims.
 */
export function excludeQuarantinedFromQualifyingRuns(runs, quarantines, now = new Date()) {
  const list = Array.isArray(runs) ? runs : [];
  const activeQuarantines = (Array.isArray(quarantines) ? quarantines : []).filter((q) => isQuarantineActive(q, now).active);
  const quarantinedBindingIds = new Set(activeQuarantines.map((q) => q.bindingId));
  const quarantinedFlowIds = new Set(activeQuarantines.map((q) => q.flowId));
  return list.filter((run) => {
    if (!isPlainObject(run)) return true; // let isQualifyingRun reject the shape itself
    if (typeof run.bindingId === "string" && quarantinedBindingIds.has(run.bindingId)) return false;
    if (typeof run.flowId === "string" && quarantinedFlowIds.has(run.flowId)) return false;
    return true;
  });
}

/**
 * Convenience wrapper: `summarizeQualifyingRuns` (#157, unmodified) applied
 * to the quarantine-filtered run list. `qualifyingCount` here can never
 * include a run belonging to an actively-quarantined Binding or Flow.
 */
export function summarizeQualifyingRunsExcludingQuarantine(runs, quarantines, now = new Date()) {
  return summarizeQualifyingRuns(excludeQuarantinedFromQualifyingRuns(runs, quarantines, now));
}

/**
 * Whether a named Binding currently contributes to coverage counting.
 * Returns `false` whenever an active quarantine names `bindingId` —
 * literally, not by re-deriving pass/fail — so a quarantined Binding always
 * reports as missing coverage rather than passing coverage through from
 * whatever the underlying test last did.
 */
export function contributesToCoverage(bindingId, quarantines, now = new Date()) {
  const list = Array.isArray(quarantines) ? quarantines : [];
  const activelyQuarantined = list.some((q) => isPlainObject(q) && q.bindingId === bindingId && isQuarantineActive(q, now).active);
  return !activelyQuarantined;
}

// Re-exported only for callers/tests that want to confirm this module never
// imports a mutator for any lifecycle axis — isQualifyingRun itself has no
// notion of quarantine at all, by design (#157's note: "Quarantine is
// #161's").
export { isQualifyingRun };
