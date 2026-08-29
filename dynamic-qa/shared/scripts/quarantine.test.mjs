import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_SCHEMA,
  DEFAULT_QUARANTINE_DAYS,
  QUARANTINE_EFFECTIVE_LANE,
  quarantineSharesNoKeyWithLifecycleAxisDeltas,
  validateQuarantineRecord,
  createQuarantineRecord,
  defaultExpiry,
  isQuarantineActive,
  quarantineReportStatus,
  describeQuarantineForReporting,
  excludeQuarantinedFromQualifyingRuns,
  summarizeQualifyingRunsExcludingQuarantine,
  contributesToCoverage,
} from "./quarantine.mjs";
import {
  applyFlowStateChange,
  applyBindingFreshnessReport,
  applyEnforcementPromotion,
  createLifecycleRecord,
} from "./lifecycle-state.mjs";

const BOTH_APPROVALS = Object.freeze({
  qaOwnerGate: { present: true, identifier: "qa-owner@example.com" },
  technicalOwnerGate: { present: true, identifier: "tech-owner@example.com" },
});

function baseInput(overrides = {}) {
  return {
    quarantineId: "q-1",
    flowId: "flow-checkout",
    bindingId: "binding-checkout-api",
    diagnosisId: "diag-1",
    originatingFailureRef: "feb-1",
    owner: "binding",
    failureClass: "binding-defect",
    trackedIssue: "https://example.com/issues/42",
    acceptedRisk: "Known intermittent 3rd-party sandbox latency; tracked for a permanent fix.",
    approvals: BOTH_APPROVALS,
    startAt: "2026-08-01T00:00:00.000Z",
    accountableOwner: "qa-owner@example.com",
    evidence: ["https://ci.example.com/run/123", "https://example.com/issues/42#comment-1"],
    ...overrides,
  };
}

// --- Both approvals required -----------------------------------------------

test("createQuarantineRecord throws without qaOwnerGate approval", () => {
  assert.throws(() =>
    createQuarantineRecord(
      baseInput({ approvals: { qaOwnerGate: { present: false, identifier: "" }, technicalOwnerGate: BOTH_APPROVALS.technicalOwnerGate } }),
    ),
  );
});

test("createQuarantineRecord throws without technicalOwnerGate approval", () => {
  assert.throws(() =>
    createQuarantineRecord(baseInput({ approvals: { qaOwnerGate: BOTH_APPROVALS.qaOwnerGate, technicalOwnerGate: { present: false, identifier: "" } } })),
  );
});

test("createQuarantineRecord throws when approvals collapse into one combined field", () => {
  assert.throws(() => createQuarantineRecord(baseInput({ approvals: { approved: true } })));
});

test("createQuarantineRecord succeeds with both approvals explicitly granted", () => {
  const record = createQuarantineRecord(baseInput());
  assert.equal(record.approvals.qaOwnerGate.present, true);
  assert.equal(record.approvals.technicalOwnerGate.present, true);
});

// --- Tracked issue required -------------------------------------------------

test("validateQuarantineRecord rejects a missing trackedIssue", () => {
  const record = createQuarantineRecord(baseInput());
  const stripped = { ...record };
  delete stripped.trackedIssue;
  const result = validateQuarantineRecord(stripped);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path.includes("trackedIssue")));
});

test("validateQuarantineRecord rejects a non-URI trackedIssue", () => {
  const result = validateQuarantineRecord(createQuarantineRecordUnsafe(baseInput({ trackedIssue: "issue-42" })));
  assert.equal(result.valid, false);
});

function createQuarantineRecordUnsafe(input) {
  // Build the plain object the same way createQuarantineRecord does,
  // without its own validation gate, so we can feed a deliberately invalid
  // record straight into validateQuarantineRecord.
  return {
    schema: SUPPORTED_SCHEMA,
    ...input,
    expiresAt: input.expiresAt ?? defaultExpiry(input.startAt),
    effectiveLane: QUARANTINE_EFFECTIVE_LANE,
  };
}

// --- Immutable evidence ------------------------------------------------------

test("a Quarantine Record's evidence array is frozen", () => {
  const record = createQuarantineRecord(baseInput());
  assert.throws(() => record.evidence.push("new-item"), TypeError);
});

test("a Quarantine Record's evidence entries cannot be reassigned", () => {
  const record = createQuarantineRecord(baseInput());
  assert.throws(() => {
    "use strict";
    record.evidence[0] = "tampered";
  }, TypeError);
});

test("the whole Quarantine Record is frozen", () => {
  const record = createQuarantineRecord(baseInput());
  assert.throws(() => {
    "use strict";
    record.acceptedRisk = "tampered";
  }, TypeError);
});

test("validateQuarantineRecord rejects empty evidence", () => {
  const result = validateQuarantineRecord(createQuarantineRecordUnsafe(baseInput({ evidence: [] })));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path.join(".") === "evidence" || e.path.includes("evidence")));
});

// --- Default seven-day expiry ------------------------------------------------

test("DEFAULT_QUARANTINE_DAYS is 7", () => {
  assert.equal(DEFAULT_QUARANTINE_DAYS, 7);
});

test("createQuarantineRecord defaults expiresAt to startAt + 7 days when omitted", () => {
  const record = createQuarantineRecord(baseInput());
  const diffMs = Date.parse(record.expiresAt) - Date.parse(record.startAt);
  assert.equal(diffMs, 7 * 24 * 60 * 60 * 1000);
});

test("an explicit expiresAt overrides the seven-day default", () => {
  const record = createQuarantineRecord(baseInput({ expiresAt: "2026-08-03T00:00:00.000Z" }));
  assert.equal(record.expiresAt, "2026-08-03T00:00:00.000Z");
});

// --- Expired quarantine fails closed -----------------------------------------

test("isQuarantineActive reports inactive/expired once now is at expiresAt", () => {
  const record = createQuarantineRecord(baseInput());
  const atExpiry = new Date(Date.parse(record.expiresAt));
  const decision = isQuarantineActive(record, atExpiry);
  assert.equal(decision.active, false);
  assert.equal(decision.reason, "expired");
});

test("isQuarantineActive is active just before expiresAt", () => {
  const record = createQuarantineRecord(baseInput());
  const justBefore = new Date(Date.parse(record.expiresAt) - 1000);
  const decision = isQuarantineActive(record, justBefore);
  assert.equal(decision.active, true);
});

test("an expired quarantine's reportStatus passes testPassed through unmodified (grants no exception)", () => {
  const record = createQuarantineRecord(baseInput());
  const wellAfterExpiry = new Date(Date.parse(record.expiresAt) + 1000);
  const status = quarantineReportStatus({ testPassed: false, quarantine: record, now: wellAfterExpiry });
  assert.equal(status.status, "protected-fail");
  assert.equal(status.countsAsPass, false); // because testPassed was false, not because of quarantine
  assert.equal(status.countsAsCoverage, true);
});

// --- Malformed quarantine fails closed (not permissive) ----------------------

test("a malformed record (missing required field) is inactive, never permissive", () => {
  const record = createQuarantineRecord(baseInput());
  const malformed = { ...record };
  delete malformed.acceptedRisk;
  const decision = isQuarantineActive(malformed);
  assert.equal(decision.active, false);
  assert.equal(decision.reason, "malformed");
});

test("a malformed record with a wrong effectiveLane is inactive", () => {
  const record = createQuarantineRecord(baseInput());
  const tampered = { ...record, effectiveLane: "required" };
  const decision = isQuarantineActive(tampered);
  assert.equal(decision.active, false);
  assert.equal(decision.reason, "malformed");
});

test("isQuarantineActive on null/undefined/garbage input is inactive, never throws", () => {
  assert.equal(isQuarantineActive(null).active, false);
  assert.equal(isQuarantineActive(undefined).active, false);
  assert.equal(isQuarantineActive("not-a-record").active, false);
  assert.equal(isQuarantineActive(42).active, false);
});

// --- Never counts as pass, coverage, or Qualifying Run (each tested) --------

test("PASS: an actively quarantined Binding never reports as passing, even when the test passed", () => {
  const record = createQuarantineRecord(baseInput());
  const duringQuarantine = new Date(Date.parse(record.startAt) + 1000);
  const status = quarantineReportStatus({ testPassed: true, quarantine: record, now: duringQuarantine });
  assert.equal(status.status, "missing-protection");
  assert.equal(status.countsAsPass, false);
});

test("COVERAGE: an actively quarantined Binding never contributes to coverage", () => {
  const record = createQuarantineRecord(baseInput());
  const duringQuarantine = new Date(Date.parse(record.startAt) + 1000);
  assert.equal(contributesToCoverage("binding-checkout-api", [record], duringQuarantine), false);
});

test("COVERAGE: an unrelated Binding still contributes to coverage", () => {
  const record = createQuarantineRecord(baseInput());
  const duringQuarantine = new Date(Date.parse(record.startAt) + 1000);
  assert.equal(contributesToCoverage("binding-other", [record], duringQuarantine), true);
});

test("QUALIFYING RUN: a run for an actively quarantined Binding is excluded before counting", () => {
  const record = createQuarantineRecord(baseInput());
  const duringQuarantine = new Date(Date.parse(record.startAt) + 1000);
  const runs = [
    { sourceCommit: "a".repeat(40), bindingId: "binding-checkout-api", outcome: "clean-pass", comparable: true },
    { sourceCommit: "b".repeat(40), bindingId: "binding-other", outcome: "clean-pass", comparable: true },
  ];
  const summary = summarizeQualifyingRunsExcludingQuarantine(runs, [record], duringQuarantine);
  assert.equal(summary.qualifyingCount, 1); // only binding-other's run counts
  const filtered = excludeQuarantinedFromQualifyingRuns(runs, [record], duringQuarantine);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].bindingId, "binding-other");
});

test("QUALIFYING RUN: once expired, the same Binding's runs count again", () => {
  const record = createQuarantineRecord(baseInput());
  const afterExpiry = new Date(Date.parse(record.expiresAt) + 1000);
  const runs = [{ sourceCommit: "a".repeat(40), bindingId: "binding-checkout-api", outcome: "clean-pass", comparable: true }];
  const summary = summarizeQualifyingRunsExcludingQuarantine(runs, [record], afterExpiry);
  assert.equal(summary.qualifyingCount, 1);
});

// --- Visibility: "missing protection", never silent -------------------------

test("describeQuarantineForReporting names an active quarantine as missingProtection", () => {
  const record = createQuarantineRecord(baseInput());
  const duringQuarantine = new Date(Date.parse(record.startAt) + 1000);
  const row = describeQuarantineForReporting(record, duringQuarantine);
  assert.equal(row.missingProtection, true);
  assert.equal(row.active, true);
  assert.equal(row.trackedIssue, "https://example.com/issues/42");
});

test("describeQuarantineForReporting still names the record for a malformed input, never disappears silently", () => {
  const record = createQuarantineRecord(baseInput());
  const malformed = { ...record };
  delete malformed.acceptedRisk;
  const row = describeQuarantineForReporting(malformed);
  assert.equal(row.missingProtection, false);
  assert.equal(row.reason, "malformed");
  assert.equal(row.bindingId, "binding-checkout-api"); // still identifies WHICH binding, not silent
});

// --- Quarantine cannot write any lifecycle axis ------------------------------

test("a Quarantine Record's own keys share none with any lifecycle axis delta", () => {
  assert.equal(quarantineSharesNoKeyWithLifecycleAxisDeltas(), true);
});

test("a Quarantine Record is refused by applyFlowStateChange (foreign keys)", () => {
  const record = createQuarantineRecord(baseInput());
  const result = applyFlowStateChange(createLifecycleRecord(), record);
  assert.equal(result.ok, false);
});

test("a Quarantine Record is refused by applyBindingFreshnessReport (foreign keys)", () => {
  const record = createQuarantineRecord(baseInput());
  const result = applyBindingFreshnessReport(createLifecycleRecord(), record);
  assert.equal(result.ok, false);
});

test("a Quarantine Record is refused by applyEnforcementPromotion (foreign keys)", () => {
  const record = createQuarantineRecord(baseInput());
  const result = applyEnforcementPromotion(createLifecycleRecord(), record);
  assert.equal(result.ok, false);
});

test("this module exports no mutator for flowState, bindingFreshness, or enforcementState", async () => {
  const mod = await import("./quarantine.mjs");
  const exportNames = Object.keys(mod);
  for (const forbidden of ["applyFlowStateChange", "applyBindingFreshnessReport", "applyEnforcementPromotion", "decideFlowStateTransition", "decidePromotion"]) {
    assert.ok(!exportNames.includes(forbidden), `quarantine.mjs must not export ${forbidden}`);
  }
});

// --- Nothing creates a quarantine automatically ------------------------------

test("createQuarantineRecord never defaults approvals — omitting them throws", () => {
  const input = baseInput();
  delete input.approvals;
  assert.throws(() => createQuarantineRecord(input));
});

test("createQuarantineRecord never defaults approvals from a partial object", () => {
  assert.throws(() => createQuarantineRecord(baseInput({ approvals: {} })));
});

test("diagnosis.mjs exports no quarantine-creating function", async () => {
  const diagnosis = await import("./diagnosis.mjs");
  const names = Object.keys(diagnosis).map((n) => n.toLowerCase());
  assert.ok(!names.some((n) => n.includes("quarantine")), "diagnosis.mjs must not create quarantine automatically");
});

test("lifecycle-state.mjs exports no quarantine-creating function", async () => {
  const lifecycle = await import("./lifecycle-state.mjs");
  const names = Object.keys(lifecycle).map((n) => n.toLowerCase());
  assert.ok(!names.some((n) => n.includes("quarantine")), "lifecycle-state.mjs must not create or apply quarantine — it is #161's overlay");
});

// --- Approvals reuse authority.mjs's own gate shape --------------------------

test("validateQuarantineRecord rejects a lone qaOwnerGate with technicalOwnerGate missing entirely", () => {
  const result = validateQuarantineRecord(createQuarantineRecordUnsafe(baseInput({ approvals: { qaOwnerGate: BOTH_APPROVALS.qaOwnerGate } })));
  assert.equal(result.valid, false);
});

test("a record's Failure Owner and Failure Class enums are validated against diagnosis.mjs's own values", () => {
  const result = validateQuarantineRecord(createQuarantineRecordUnsafe(baseInput({ owner: "not-a-real-owner" })));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path.includes("owner")));
});
