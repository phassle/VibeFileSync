// dynamic-qa/shared/scripts/adapter-contract.mjs
//
// Ticket #156: the provider-neutral CI adapter contract
// (DESIGN-dynamic-qa-spec.md §9, SPEC-135.md User Stories 99-100), extracted
// from the working GitHub Actions adapter (#153/#154/#155) rather than
// designed ahead of it — portability is proven, not assumed. This module
// defines WHAT any CI provider adapter must expose and prove; it never says
// HOW a specific provider renders its configuration. It imports no
// provider-specific module and calls no provider-specific function — every
// check here operates only on the neutral `adapter` object shape documented
// below and on caller-supplied `fixtures` (the same caller-supplied-evidence
// pattern capability-gate.mjs and trust-zones.mjs already use), so this
// module is exactly as reusable against a second, third, or fixture adapter
// as it is against GitHub Actions (`github-actions-adapter.mjs`'s exported
// `adapter` object) or the fixture provider (`fixture-adapter.mjs`).
//
// The neutral adapter object shape (every provider implements all of it):
//
//   identity            : string
//   detect(existingWorkflowFilenames)               -> { provider, existingWorkflows, hasDynamicQaWorkflow, defaultWorkflowPath }
//   deriveCapabilityEvidence(input)                  -> environment-evidence (the 8 Capability Gate categories: paths, commands, environments, network, identities, effects, resources, evidence)
//   planLane({ lane, trigger, profile, environmentEvidence, workflowConfig, workflowPath }) -> { rendered, state, config?, path?, blockers? }
//   supportedTriggers   : string[] (subset of KNOWN_TRIGGERS)
//   deferredTriggers    : string[]
//   supportedLanes      : string[] (subset of KNOWN_LANES)
//   deferredLanes       : string[]
//   emitReporting(junitXmlText)                      -> { summary, annotations }
//   emitFailureBundle(diagnostics, opts)              -> { artifacts, withheld }  (diagnostics-scrub.mjs's manifest shape)
//   resolveRunReference(env)                          -> { repository, sourceCommit, workflow }
//   checkGeneratedConfigEnforcesProfile(profile, config, opts) -> { valid, errors }
//
// The seven contract points (DESIGN-dynamic-qa-spec.md §9, numbered
// identically here — the ticket's own prose names "reporting" and
// "failure-bundle emission" as two obligations of the same point 5):
//   1. detect             — read-only inventory of existing provider config.
//   2. capabilityEvidence — shape what the provider concretely proves into
//                           the Capability Gate's environment-evidence shape,
//                           honestly (never a rubber stamp reporting "met"
//                           regardless of input).
//   3. laneRendering      — render advisory/required/quarantine lanes
//                           WITHOUT changing policy; never renders while a
//                           Capability Gate blocker is open (no default-open
//                           path).
//   4. triggers           — declare which of the four Provider-native CI
//                           triggers are supported vs. deferred.
//   5. reporting          — publish JUnit-derived annotations/summary AND
//                           emit a strict, scrubbed, exact-path failure
//                           bundle.
//   6. runReference       — normalize the provider's own run environment
//                           into Result Envelope identity fields, purely.
//   7. profileEnforcement — validate that rendered configuration text
//                           actually enforces the Execution Profile — the
//                           sole security-enforcement gate every obligation
//                           check below routes through.
//
// Portability must not weaken security (the ticket's central constraint):
// every obligation checker below is fail-closed. None of them returns
// `valid: true` merely because the adapter didn't crash, or because a
// fixture/capability the check needed was simply absent — an adapter (or a
// caller) that cannot even be probed for an obligation FAILS conformance for
// that obligation; there is no code path here that treats "untestable" as
// "presumed fine". Every obligation check requires the adapter to have
// ACTUALLY rejected a deliberately-broken fixture it was handed.

function isFn(value) {
  return typeof value === "function";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const KNOWN_TRIGGERS = Object.freeze(["pull_request", "schedule", "workflow_dispatch", "merge_group"]);
export const KNOWN_LANES = Object.freeze(["advisory", "required", "quarantine"]);

// --- the seven contract points, as data -------------------------------------

export const CONTRACT_POINTS = Object.freeze([
  { id: 1, key: "detect", name: "discovery", requiredMethods: ["detect"], requiredArrays: [] },
  { id: 2, key: "capabilityEvidence", name: "capability evidence", requiredMethods: ["deriveCapabilityEvidence"], requiredArrays: [] },
  { id: 3, key: "laneRendering", name: "lane rendering", requiredMethods: ["planLane"], requiredArrays: ["supportedLanes"] },
  { id: 4, key: "triggers", name: "triggers", requiredMethods: [], requiredArrays: ["supportedTriggers"] },
  { id: 5, key: "reporting", name: "reporting and failure-bundle emission", requiredMethods: ["emitReporting", "emitFailureBundle"], requiredArrays: [] },
  { id: 6, key: "runReference", name: "provider-run resolution", requiredMethods: ["resolveRunReference"], requiredArrays: [] },
  { id: 7, key: "profileEnforcement", name: "Execution Profile validation", requiredMethods: ["checkGeneratedConfigEnforcesProfile"], requiredArrays: [] },
]);

export const SECURITY_OBLIGATIONS = Object.freeze([
  { id: "exact-egress", name: "exact egress" },
  { id: "minimal-permissions", name: "minimal permissions" },
  { id: "immutable-pins", name: "immutable pins" },
  { id: "no-persisted-credential", name: "no persisted credential" },
  { id: "privileged-low-trust-separation", name: "privileged/low-trust separation" },
  { id: "diagnostics-scrubbing", name: "diagnostics scrubbing" },
]);

function pointError(point, message) {
  return { point: point.id, key: point.key, message: `contract point ${point.id} (${point.name}): ${message}` };
}

function obligationError(id, message) {
  const found = SECURITY_OBLIGATIONS.find((o) => o.id === id);
  return { obligation: id, name: found?.name ?? id, message: `security obligation ${JSON.stringify(id)}: ${message}` };
}

function safeCall(fn, ...args) {
  try {
    return { ok: true, value: fn(...args) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Structural conformance: every contract point's required method(s)/array(s)
 * exist on `adapter` with the right JS type. Returns one named error per
 * unmet requirement — never a single generic "adapter is invalid" flag — so
 * a fixture adapter missing point N is always identifiable as point N,
 * never a different point or a bare boolean.
 */
export function checkAdapterShape(adapter) {
  const errors = [];
  const a = isPlainObject(adapter) ? adapter : {};
  for (const point of CONTRACT_POINTS) {
    for (const method of point.requiredMethods) {
      if (!isFn(a[method])) errors.push(pointError(point, `missing required method ${JSON.stringify(method)}`));
    }
    for (const arrayProp of point.requiredArrays) {
      if (!Array.isArray(a[arrayProp])) errors.push(pointError(point, `missing required array property ${JSON.stringify(arrayProp)}`));
    }
  }
  return { valid: errors.length === 0, errors };
}

// --- point 1: discovery is read-only and named ------------------------------

export function checkDiscoveryPoint(adapter, fixtures = {}) {
  const point = CONTRACT_POINTS[0];
  if (!isFn(adapter?.detect)) return { valid: false, errors: [pointError(point, 'missing required method "detect"')] };

  const filenames = fixtures.existingWorkflowFilenames ?? [];
  const first = safeCall(adapter.detect, filenames);
  const second = safeCall(adapter.detect, filenames);
  if (!first.ok || !second.ok) {
    return { valid: false, errors: [pointError(point, `detect() threw for a read-only inventory input: ${(first.error ?? second.error)?.message}`)] };
  }
  if (JSON.stringify(first.value) !== JSON.stringify(second.value)) {
    return {
      valid: false,
      errors: [pointError(point, "detect() is not a pure function of its input — calling it twice with the same evidence produced different results, inconsistent with a read-only inventory")],
    };
  }
  if (!isPlainObject(first.value) || typeof first.value.provider !== "string" || first.value.provider.trim() === "") {
    return { valid: false, errors: [pointError(point, "detect() must report a non-empty provider identity")] };
  }
  if (!Array.isArray(first.value.existingWorkflows)) {
    return { valid: false, errors: [pointError(point, "detect() must report existingWorkflows as an array")] };
  }
  return { valid: true, errors: [] };
}

// --- point 2: capability evidence is honest, not a rubber stamp -------------

export function checkCapabilityEvidencePoint(adapter, fixtures = {}) {
  const point = CONTRACT_POINTS[1];
  if (!isFn(adapter?.deriveCapabilityEvidence)) {
    return { valid: false, errors: [pointError(point, 'missing required method "deriveCapabilityEvidence"')] };
  }
  const spec = fixtures.capabilityEvidence;
  if (!isPlainObject(spec)) {
    return { valid: false, errors: [pointError(point, "fixtures.capabilityEvidence is required to probe this point — an adapter that cannot be probed fails conformance, it is not skipped")] };
  }

  const metCall = safeCall(adapter.deriveCapabilityEvidence, spec.metInput);
  if (!metCall.ok) return { valid: false, errors: [pointError(point, `deriveCapabilityEvidence threw on a fully-met input: ${metCall.error.message}`)] };

  const REQUIRED_KEYS = ["paths", "commands", "environments", "network", "identities", "effects", "resources", "evidence"];
  const missingKeys = REQUIRED_KEYS.filter((k) => !(k in (metCall.value ?? {})));
  if (missingKeys.length > 0) {
    return { valid: false, errors: [pointError(point, `derived capability evidence is missing the Capability Gate categories: ${missingKeys.join(", ")}`)] };
  }

  if (spec.unmetInput !== undefined && spec.unmetCapability) {
    const unmetCall = safeCall(adapter.deriveCapabilityEvidence, spec.unmetInput);
    if (!unmetCall.ok) return { valid: false, errors: [pointError(point, `deriveCapabilityEvidence threw on an unmet-capability input: ${unmetCall.error.message}`)] };
    const reported = (Array.isArray(unmetCall.value?.evidence) ? unmetCall.value.evidence : []).find((e) => e?.capability === spec.unmetCapability);
    if (reported?.status === "met") {
      return {
        valid: false,
        errors: [pointError(point, `deriveCapabilityEvidence reports capability ${JSON.stringify(spec.unmetCapability)} as "met" even for an input that does not actually provide it — this is a rubber stamp, not real evidence`)],
      };
    }
  }

  return { valid: true, errors: [] };
}

// --- point 3: lane rendering never bypasses the Capability Gate ------------

export function checkLaneRenderingPoint(adapter, fixtures = {}) {
  const point = CONTRACT_POINTS[2];
  const missing = [];
  if (!isFn(adapter?.planLane)) missing.push('missing required method "planLane"');
  if (!Array.isArray(adapter?.supportedLanes)) missing.push('missing required array property "supportedLanes"');
  if (missing.length > 0) return { valid: false, errors: missing.map((m) => pointError(point, m)) };

  const errors = [];
  for (const l of adapter.supportedLanes) {
    if (!KNOWN_LANES.includes(l)) errors.push(pointError(point, `declares unknown supported lane ${JSON.stringify(l)} — must be one of ${KNOWN_LANES.join(", ")}`));
  }
  const deferredLanes = Array.isArray(adapter.deferredLanes) ? adapter.deferredLanes : [];
  for (const l of deferredLanes) {
    if (adapter.supportedLanes.includes(l)) errors.push(pointError(point, `lane ${JSON.stringify(l)} is listed as both supported and deferred`));
  }

  const { lane, trigger } = fixtures.primaryLaneTrigger ?? { lane: "advisory", trigger: "pull_request" };
  const profile = fixtures.profile;
  const workflowConfig = fixtures.workflowConfig;

  if (fixtures.blockedEnvironmentEvidence !== undefined) {
    const blockedCall = safeCall(adapter.planLane, { lane, trigger, profile, environmentEvidence: fixtures.blockedEnvironmentEvidence, workflowConfig });
    if (!blockedCall.ok) {
      errors.push(pointError(point, `planLane threw instead of deferring on blocked evidence: ${blockedCall.error.message}`));
    } else {
      const blocked = blockedCall.value;
      if (blocked?.rendered !== false || blocked?.state !== "deferred" || !Array.isArray(blocked?.blockers) || blocked.blockers.length === 0) {
        errors.push(pointError(point, "planLane rendered (or omitted named blockers) while the Capability Gate had an open blocker — there is no default-open path allowed here"));
      }
    }
  }

  if (fixtures.metEnvironmentEvidence !== undefined) {
    const okCall = safeCall(adapter.planLane, { lane, trigger, profile, environmentEvidence: fixtures.metEnvironmentEvidence, workflowConfig });
    if (!okCall.ok) {
      errors.push(pointError(point, `planLane threw on a fully-evidenced profile: ${okCall.error.message}`));
    } else {
      const ok = okCall.value;
      if (ok?.rendered !== true || ok?.state !== "activatable" || typeof ok?.config !== "string" || ok.config.trim() === "") {
        errors.push(pointError(point, "planLane did not render a non-empty configuration once every capability was evidenced"));
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- point 4: triggers are declared from the known vocabulary --------------

export function checkTriggerPoint(adapter) {
  const point = CONTRACT_POINTS[3];
  if (!Array.isArray(adapter?.supportedTriggers)) {
    return { valid: false, errors: [pointError(point, 'missing required array property "supportedTriggers"')] };
  }
  const errors = [];
  const deferred = Array.isArray(adapter.deferredTriggers) ? adapter.deferredTriggers : [];
  for (const t of adapter.supportedTriggers) {
    if (!KNOWN_TRIGGERS.includes(t)) errors.push(pointError(point, `declares unknown supported trigger ${JSON.stringify(t)} — must be one of ${KNOWN_TRIGGERS.join(", ")}`));
  }
  for (const t of deferred) {
    if (adapter.supportedTriggers.includes(t)) errors.push(pointError(point, `trigger ${JSON.stringify(t)} is listed as both supported and deferred`));
  }
  if (adapter.supportedTriggers.length === 0) errors.push(pointError(point, "declares no supported triggers at all"));
  return { valid: errors.length === 0, errors };
}

// --- point 5: reporting and the strict failure bundle -----------------------

export function checkReportingPoint(adapter, fixtures = {}) {
  const point = CONTRACT_POINTS[4];
  const missing = [];
  if (!isFn(adapter?.emitReporting)) missing.push('missing required method "emitReporting"');
  if (!isFn(adapter?.emitFailureBundle)) missing.push('missing required method "emitFailureBundle"');
  if (missing.length > 0) return { valid: false, errors: missing.map((m) => pointError(point, m)) };

  const errors = [];

  if (fixtures.junitXmlText !== undefined) {
    const reportCall = safeCall(adapter.emitReporting, fixtures.junitXmlText);
    if (!reportCall.ok) {
      errors.push(pointError(point, `emitReporting threw: ${reportCall.error.message}`));
    } else if (!isPlainObject(reportCall.value?.summary) || !Array.isArray(reportCall.value?.annotations)) {
      errors.push(pointError(point, "emitReporting must return a { summary, annotations } shape derived from JUnit"));
    }
  }

  if (fixtures.cleanDiagnostics !== undefined) {
    const cleanCall = safeCall(adapter.emitFailureBundle, fixtures.cleanDiagnostics, fixtures.failureBundleOpts);
    if (!cleanCall.ok) {
      errors.push(pointError(point, `emitFailureBundle threw on clean diagnostics: ${cleanCall.error.message}`));
    } else if (!Array.isArray(cleanCall.value?.artifacts) || !Array.isArray(cleanCall.value?.withheld)) {
      errors.push(pointError(point, "emitFailureBundle must return a { artifacts, withheld } manifest"));
    } else if (cleanCall.value.artifacts.some((a) => typeof a.path !== "string" || a.path.includes("*"))) {
      errors.push(pointError(point, "emitFailureBundle's artifact list must be exact paths, never a wildcard/glob"));
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- point 6: run-reference resolution is pure ------------------------------

export function checkRunReferencePoint(adapter, fixtures = {}) {
  const point = CONTRACT_POINTS[5];
  if (!isFn(adapter?.resolveRunReference)) return { valid: false, errors: [pointError(point, 'missing required method "resolveRunReference"')] };

  const env = fixtures.runEnvironment ?? {};
  const first = safeCall(adapter.resolveRunReference, env);
  const second = safeCall(adapter.resolveRunReference, env);
  if (!first.ok || !second.ok) {
    return { valid: false, errors: [pointError(point, `resolveRunReference threw: ${(first.error ?? second.error).message}`)] };
  }
  if (JSON.stringify(first.value) !== JSON.stringify(second.value)) {
    return { valid: false, errors: [pointError(point, "resolveRunReference is not a pure function of its input environment")] };
  }
  const emptyCall = safeCall(adapter.resolveRunReference, {});
  if (!emptyCall.ok) {
    return { valid: false, errors: [pointError(point, "resolveRunReference must not throw for an empty/incomplete environment — it must be usable without a real provider run present")] };
  }
  return { valid: true, errors: [] };
}

// --- point 7: profile enforcement is real, not decorative -------------------

export function checkProfileEnforcementPoint(adapter, fixtures = {}) {
  const point = CONTRACT_POINTS[6];
  if (!isFn(adapter?.checkGeneratedConfigEnforcesProfile)) {
    return { valid: false, errors: [pointError(point, 'missing required method "checkGeneratedConfigEnforcesProfile"')] };
  }

  const errors = [];
  if (fixtures.conformingConfig !== undefined) {
    const okCall = safeCall(adapter.checkGeneratedConfigEnforcesProfile, fixtures.profile, fixtures.conformingConfig, fixtures.conformingConfigOptions);
    if (!okCall.ok || okCall.value?.valid !== true) {
      errors.push(pointError(point, `checkGeneratedConfigEnforcesProfile rejected a genuinely conforming configuration: ${JSON.stringify(okCall.value?.errors ?? okCall.error?.message)}`));
    }
  }
  if (fixtures.nonConformingConfig !== undefined) {
    const badCall = safeCall(adapter.checkGeneratedConfigEnforcesProfile, fixtures.profile, fixtures.nonConformingConfig, fixtures.nonConformingConfigOptions);
    if (!badCall.ok) {
      errors.push(pointError(point, `checkGeneratedConfigEnforcesProfile threw instead of reporting a violation: ${badCall.error.message}`));
    } else if (badCall.value?.valid !== false || !Array.isArray(badCall.value?.errors) || badCall.value.errors.length === 0) {
      errors.push(pointError(point, "checkGeneratedConfigEnforcesProfile did not detect a deliberately mutated, non-conforming configuration — enforcement must be real, never decorative"));
    }
  }
  return { valid: errors.length === 0, errors };
}

export const POINT_CHECKS = Object.freeze([
  checkDiscoveryPoint,
  checkCapabilityEvidencePoint,
  checkLaneRenderingPoint,
  checkTriggerPoint,
  checkReportingPoint,
  checkRunReferencePoint,
  checkProfileEnforcementPoint,
]);

// --- security obligations: fail-closed, never degrade -----------------------
//
// "A provider that cannot meet an obligation yields a Safety Blocker and
// deferral — never a silent reduction" (the ticket, verbatim). Every
// obligation checker below follows exactly one shape: probe the adapter
// with a deliberately violating fixture, and require the adapter to have
// REJECTED it. An adapter (or a fixtures bag) that cannot even be probed for
// an obligation is treated as FAILING that obligation, never as "not
// applicable" or "presumed fine" — there is no path here that returns
// `valid: true` for an untestable adapter.

export function checkExactEgressObligation(adapter, fixtures = {}) {
  const spec = fixtures.obligations?.exactEgress;
  if (!isFn(adapter?.planLane) || !isPlainObject(spec) || spec.violatingEnvironmentEvidence === undefined) {
    return { valid: false, errors: [obligationError("exact-egress", "adapter or fixtures cannot be probed for exact egress — an adapter unable to prove this obligation fails conformance, it is not skipped")] };
  }
  const { lane, trigger } = fixtures.primaryLaneTrigger ?? { lane: "advisory", trigger: "pull_request" };
  const call = safeCall(adapter.planLane, { lane, trigger, profile: fixtures.profile, environmentEvidence: spec.violatingEnvironmentEvidence, workflowConfig: fixtures.workflowConfig });
  if (!call.ok) return { valid: false, errors: [obligationError("exact-egress", `planLane threw instead of refusing an egress-violating environment: ${call.error.message}`)] };
  if (call.value?.rendered !== false) {
    return {
      valid: false,
      errors: [obligationError("exact-egress", "the adapter rendered a lane against an environment that does not prove exact/isolated egress — this must produce a Safety Blocker and deferral, never a silent render")],
    };
  }
  return { valid: true, errors: [] };
}

function checkConfigObligation(id, adapter, fixtures, brokenConfigKey) {
  if (!isFn(adapter?.checkGeneratedConfigEnforcesProfile)) {
    return { valid: false, errors: [obligationError(id, "adapter has no checkGeneratedConfigEnforcesProfile method — cannot be probed, so it fails this obligation")] };
  }
  const broken = fixtures.obligations?.brokenConfigs?.[brokenConfigKey];
  if (broken === undefined) {
    return { valid: false, errors: [obligationError(id, "fixtures supply no deliberately-violating configuration for this obligation — an untestable obligation fails, it is not skipped")] };
  }
  const call = safeCall(adapter.checkGeneratedConfigEnforcesProfile, fixtures.profile, broken.config, broken.options);
  if (!call.ok) return { valid: false, errors: [obligationError(id, `checkGeneratedConfigEnforcesProfile threw instead of rejecting the violation: ${call.error.message}`)] };
  if (call.value?.valid !== false || !Array.isArray(call.value?.errors) || call.value.errors.length === 0) {
    return { valid: false, errors: [obligationError(id, "the adapter accepted a configuration that violates this obligation — enforcement must fail closed, never degrade to acceptance")] };
  }
  return { valid: true, errors: [] };
}

export function checkMinimalPermissionsObligation(adapter, fixtures = {}) {
  return checkConfigObligation("minimal-permissions", adapter, fixtures, "minimalPermissions");
}
export function checkImmutablePinsObligation(adapter, fixtures = {}) {
  return checkConfigObligation("immutable-pins", adapter, fixtures, "immutablePins");
}
export function checkNoPersistedCredentialObligation(adapter, fixtures = {}) {
  return checkConfigObligation("no-persisted-credential", adapter, fixtures, "noPersistedCredential");
}
export function checkPrivilegedLowTrustSeparationObligation(adapter, fixtures = {}) {
  return checkConfigObligation("privileged-low-trust-separation", adapter, fixtures, "privilegedLowTrustSeparation");
}

/**
 * Reuses diagnostics-scrub.mjs's own documented test seam (`opts.verify`,
 * "production callers never override it") rather than depending on
 * secret-detection.mjs's exact regex coverage: forcing `verify` to report
 * "still contains a secret-shaped value" simulates a scrub-verification
 * failure deterministically, and a conforming `emitFailureBundle` must
 * withhold every diagnostic it was handed (never partially, never "mostly
 * clean") because it composes the fail-safe gate rather than bypassing it.
 * An adapter whose `emitFailureBundle` does not forward `opts` (or
 * otherwise bypasses the scrub) will instead upload despite the forced
 * failure — exactly the "silent reduction" this obligation exists to catch.
 */
export function checkDiagnosticsScrubbingObligation(adapter, fixtures = {}) {
  const spec = fixtures.obligations?.diagnosticsScrubbing;
  if (!isFn(adapter?.emitFailureBundle) || !isPlainObject(spec) || spec.diagnostics === undefined) {
    return { valid: false, errors: [obligationError("diagnostics-scrubbing", "adapter or fixtures cannot be probed for diagnostics scrubbing — an adapter unable to prove this obligation fails conformance, it is not skipped")] };
  }
  const forcedFailureOpts = { ...(fixtures.failureBundleOpts ?? {}), verify: () => true };
  const call = safeCall(adapter.emitFailureBundle, spec.diagnostics, forcedFailureOpts);
  if (!call.ok) return { valid: false, errors: [obligationError("diagnostics-scrubbing", `emitFailureBundle threw: ${call.error.message}`)] };
  const artifacts = Array.isArray(call.value?.artifacts) ? call.value.artifacts : null;
  if (artifacts === null) {
    return { valid: false, errors: [obligationError("diagnostics-scrubbing", "emitFailureBundle did not return an { artifacts, withheld } manifest")] };
  }
  if (artifacts.length > 0) {
    return {
      valid: false,
      errors: [
        obligationError(
          "diagnostics-scrubbing",
          `emitFailureBundle uploaded ${artifacts.length} artifact(s) even though scrub verification was forced to report failure for every one — a conforming adapter must compose the fail-safe gate (redact-then-reverify), never bypass it`,
        ),
      ],
    };
  }
  return { valid: true, errors: [] };
}

export const OBLIGATION_CHECKS = Object.freeze([
  checkExactEgressObligation,
  checkMinimalPermissionsObligation,
  checkImmutablePinsObligation,
  checkNoPersistedCredentialObligation,
  checkPrivilegedLowTrustSeparationObligation,
  checkDiagnosticsScrubbingObligation,
]);
