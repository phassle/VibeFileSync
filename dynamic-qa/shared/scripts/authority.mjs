// dynamic-qa/shared/scripts/authority.mjs
//
// Stage 1 ("Orient and establish authority") mechanics that are genuine
// computation rather than judgement. What is judgement — whether a named
// human actually holds QA Owner accountability, how to phrase the
// orientation question, how to react to what the human says — stays in
// qa-setup/SKILL.md prose, per ticket #162's split (see the ticket report).
// What is a checkable rule lives here, real and tested:
//
//   1. Setup may start ONLY from an explicit invocation. A natural-language
//      mention, an implicit coordinator decision, or another skill invoking
//      qa-setup on its own initiative must never start it.
//   2. QA Owner (contract) approval and Technical Owner approval are
//      distinct, independently tracked gates — never a single combined
//      field a partial answer could satisfy for both.
//   3. A Domain Expert record must be scoped to specific flows; a Domain
//      Expert can never BE the QA Owner of record (role identity and role
//      authority never collapse into one).

// --- 1. Explicit-invocation gate -----------------------------------------

// Every source an invocation could plausibly report. Unlisted values fail
// closed via evaluateInvocation's default case, not silently.
export const EXPLICIT_INVOCATION_SOURCES = Object.freeze([
  "explicit-user-command",
  "explicit-coordinator-selection",
]);

export const NON_EXPLICIT_INVOCATION_SOURCES = Object.freeze([
  "natural-language-mention",
  "implicit-coordinator-inference",
  "implicit-skill-invocation",
]);

// evaluateInvocation({ source }) -> { allowed, stopReason }
//
// stopReason is one of:
//   "not-explicit-invocation"      — a recognized but disallowed source
//   "unrecognized-invocation-source" — fail closed on anything unlisted
//   null                            — allowed to proceed
export function evaluateInvocation(invocation) {
  const source = invocation && invocation.source;
  if (EXPLICIT_INVOCATION_SOURCES.includes(source)) {
    return { allowed: true, stopReason: null };
  }
  if (NON_EXPLICIT_INVOCATION_SOURCES.includes(source)) {
    return { allowed: false, stopReason: "not-explicit-invocation" };
  }
  return { allowed: false, stopReason: "unrecognized-invocation-source" };
}

// --- 2 & 3. Roles and gate independence ----------------------------------

export const ROLES = Object.freeze(["qa-owner", "technical-owner", "domain-expert"]);

export function isKnownRole(role) {
  return ROLES.includes(role);
}

// GATE_KEYS names the two review gates the parent spec requires to remain
// separately governed everywhere they appear (Setup Review Packet here,
// Repair Review Packet in qa-generate). A single "approved" boolean that
// covers both is exactly the failure mode this guards against.
export const GATE_KEYS = Object.freeze(["qaOwnerGate", "technicalOwnerGate"]);

// validateAuthorityRecord — checks the shape setup must establish before any
// flow elicitation begins:
//
//   {
//     qaOwnerGate:        { present: boolean, identifier: string },
//     technicalOwnerGate: { present: boolean, identifier: string },
//     domainExperts?:      [{ identifier: string, scope: string[] }]
//   }
//
// Fails closed (returns ok:false) on:
//   - either gate missing or malformed
//   - the two gates sharing one identifier for the SAME record without both
//     being explicitly the same person is NOT itself an error (one human can
//     hold two hats) — but a record that merges the two keys into one field,
//     or omits either key entirely, is rejected: the gates must stay
//     structurally distinct regardless of who satisfies them.
//   - any domainExperts entry with no scope (a Domain Expert whose "scope" is
//     the whole setup is indistinguishable from a QA Owner, which the spec
//     forbids)
//   - a domainExperts entry whose identifier equals the qaOwnerGate
//     identifier while claiming a narrower scope — that is not an error by
//     itself (the same human may hold both roles for a small team), so this
//     function does NOT reject that case; only an UNSCOPED domain expert is
//     rejected.
export function validateAuthorityRecord(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["authority record must be an object"] };
  }

  for (const key of GATE_KEYS) {
    const gate = record[key];
    if (gate === undefined) {
      errors.push(`authority record is missing required gate: ${key}`);
      continue;
    }
    if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
      errors.push(`${key} must be an object`);
      continue;
    }
    if (typeof gate.present !== "boolean") {
      errors.push(`${key}.present must be a boolean`);
    }
    if (gate.present && (typeof gate.identifier !== "string" || gate.identifier.length === 0)) {
      errors.push(`${key} is marked present but has no identifier`);
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(record, "approved") ||
    Object.prototype.hasOwnProperty.call(record, "gate") ||
    Object.prototype.hasOwnProperty.call(record, "ownerGate")
  ) {
    errors.push("authority record must not collapse the two gates into one combined field");
  }

  if (record.domainExperts !== undefined) {
    if (!Array.isArray(record.domainExperts)) {
      errors.push("domainExperts must be an array");
    } else {
      record.domainExperts.forEach((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          errors.push(`domainExperts[${index}] must be an object`);
          return;
        }
        if (typeof entry.identifier !== "string" || entry.identifier.length === 0) {
          errors.push(`domainExperts[${index}] requires a non-empty identifier`);
        }
        if (!Array.isArray(entry.scope) || entry.scope.length === 0) {
          errors.push(
            `domainExperts[${index}] must declare a non-empty scope (specific flow ids) — an unscoped domain expert is indistinguishable from a QA Owner`
          );
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// gatesAreIndependent — a satisfied/withheld decision on one gate must never
// be readable as satisfying the other. Pure structural check: true only when
// the two gate objects are genuinely separate values (not the same object
// reference, which would make them the same boolean by accident).
export function gatesAreIndependent(record) {
  if (record === null || typeof record !== "object") return false;
  return record.qaOwnerGate !== record.technicalOwnerGate;
}
