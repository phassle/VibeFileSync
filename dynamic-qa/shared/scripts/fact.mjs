// dynamic-qa/shared/scripts/fact.mjs
//
// The provenance model for a single Setup Inventory fact (ticket #162, spec
// #135 stage 2 "Inventory facts read-only"). Every fact the inventory
// scanner produces carries exactly one of three provenance values so
// uncertainty never collapses into a confident-looking default:
//
//   observed — read directly from a repository file the scanner opened.
//   reported — not directly observed, but backed by a named piece of
//              evidence the scanner found (a report, a summary artifact) that
//              itself was observed.
//   unknown  — the scanner could not determine this and says so, rather than
//              guessing or defaulting to a plausible-looking value.
//
// A "secret" fact (category "secret-name") may record a secret's NAME only.
// It may never carry a `value` or `secretValue` field — see makeFact and
// validateFact below, both of which reject one on sight. This is a hostile-
// input-shaped invariant (an attacker-influenced workflow file must never be
// able to make a "fact" smuggle a real credential into inventory output), so
// it is enforced here in the deterministic core rather than left as an
// authoring convention in SKILL.md prose.
//
// Ticket #163 (qa-setup stage 3, "posture-specific evidence") extends this
// same Fact shape with two more categories rather than forking a parallel
// evidence system — see `posture.mjs`, which is the only module that
// constructs or transitions these two categories:
//
//   brownfield-observation — a fact about what the application currently
//     does. It carries one MORE dimension no other category has: intentStatus
//     ("unconfirmed" | "confirmed-intended" | "confirmed-not-intended", see
//     INTENT_STATUSES below). This is the concrete data-shape answer to the
//     spec's "brownfield observations are evidence, not intended behaviour":
//     an observation starts — and stays — "unconfirmed" until an accountable
//     human (never a Domain Expert, see posture.mjs's confirmIntent) explicitly
//     says whether it is intended. Only "confirmed-intended" may ever become a
//     Flow contract's Expected Outcome later.
//   greenfield-source — a fact recording that a not-yet-built flow's evidence
//     came from an approved ticket or example (posture.mjs validates the
//     approval; this module only stores the resulting fact). Provenance is
//     "reported" when at least one valid approved source backs it, "unknown"
//     when none exists — greenfield setup never invents a "value" for a flow
//     it cannot observe.

export const PROVENANCE = Object.freeze(["observed", "reported", "unknown"]);

// The intent-confirmation dimension, exclusive to "brownfield-observation"
// facts (see the module comment above and posture.mjs). Every other category
// must never carry these fields — makeFact/validateFact reject that combination
// on sight, the same fail-closed posture as the secret-value checks above.
export const INTENT_STATUSES = Object.freeze([
  "unconfirmed",
  "confirmed-intended",
  "confirmed-not-intended",
]);

// The only two identities allowed to move a brownfield observation off
// "unconfirmed" (see posture.mjs's confirmIntent). A Domain Expert may
// clarify what an observed behaviour means, but can never be the confirming
// identity — that would let flow-specific input quietly stand in for QA
// ownership, which the parent spec forbids.
export const CONFIRMING_ROLES = Object.freeze(["qa-owner", "technical-owner"]);

export function isValidIntentStatus(status) {
  return INTENT_STATUSES.includes(status);
}

// The category vocabulary stage 2 of the spec names explicitly. Unknown
// categories fail closed in validateFact/validateInventory: a category is
// either one setup stage 2 was told to inventory, or the fact is rejected,
// never silently accepted.
export const CATEGORIES = Object.freeze([
  // existing tests and the outcomes they already prove
  "existing-test",
  "existing-test-outcome",
  // frameworks, fixtures, mocks, clocks, cleanup, reporting
  "test-framework",
  "fixture",
  "mock",
  "clock",
  "cleanup",
  "reporting",
  // CI triggers, runners, services, environments, merge queues, checks, artifacts
  "ci-provider",
  "ci-trigger",
  "ci-runner",
  "ci-service",
  "ci-environment",
  "ci-merge-queue",
  "ci-check",
  "ci-artifact",
  // secret NAMES only — see the module comment above
  "secret-name",
  // posture-specific evidence (ticket #163) — see the module comment above
  "brownfield-observation",
  "greenfield-source",
]);

export function isValidProvenance(provenance) {
  return PROVENANCE.includes(provenance);
}

export function isKnownCategory(category) {
  return CATEGORIES.includes(category);
}

// The invariants below are the single source of truth for what a Fact may
// legally look like. `collectFactRuleViolations` runs every rule against a
// fact-shaped object and returns every violation, in a fixed order, without
// throwing — `makeFact` and `validateFact` are two thin entry points over
// this one rule set, differing only in what they do with the result
// (respectively: throw on the first violation, or report all of them):
//   - an unknown category
//   - a provenance outside PROVENANCE
//   - a "secret-name" category fact carrying `value` or `secretValue`
//   - any fact carrying `secretValue` at all (there is no legitimate use)
//   - a non-"brownfield-observation" fact carrying intentStatus/confirmedBy/
//     confirmedByRole (the intent-confirmation dimension is exclusive to
//     that one category — see the module comment above)
//   - a "brownfield-observation" fact whose intentStatus is outside
//     INTENT_STATUSES, or whose confirmedBy/confirmedByRole is present
//     without the other, or whose confirmedByRole names a Domain Expert
//     (only "qa-owner"/"technical-owner" may confirm intent), or whose
//     intentStatus is "confirmed-intended"/"confirmed-not-intended" without
//     a confirming identity
// Adding a new invariant means adding one rule here — never editing
// makeFact/validateFact separately, which is exactly the duplication this
// shared rule set replaces.
function collectFactRuleViolations(fact) {
  const errors = [];
  if (typeof fact.id !== "string" || fact.id.length === 0) {
    errors.push("fact.id must be a non-empty string");
  } else if (fact.id !== fact.id.trim()) {
    errors.push("fact.id must not have leading or trailing whitespace");
  }
  if (!isKnownCategory(fact.category)) {
    errors.push(`fact.category is not a known Setup Inventory category: ${String(fact.category)}`);
  }
  if (!isValidProvenance(fact.provenance)) {
    errors.push(`fact.provenance must be observed, reported, or unknown, got: ${String(fact.provenance)}`);
  }
  if (Object.prototype.hasOwnProperty.call(fact, "secretValue")) {
    errors.push("fact must never carry a secretValue field — secrets are inspected by name only");
  }
  if (fact.category === "secret-name") {
    if (Object.prototype.hasOwnProperty.call(fact, "value")) {
      errors.push("a secret-name fact may record a secret's name only, never its value");
    }
    if (typeof fact.secretName !== "string" || fact.secretName.length === 0) {
      errors.push("a secret-name fact requires a non-empty secretName");
    }
  }

  const carriesIntentFields =
    Object.prototype.hasOwnProperty.call(fact, "intentStatus") ||
    Object.prototype.hasOwnProperty.call(fact, "confirmedBy") ||
    Object.prototype.hasOwnProperty.call(fact, "confirmedByRole");
  if (fact.category !== "brownfield-observation" && carriesIntentFields) {
    errors.push("only a brownfield-observation fact may carry intentStatus/confirmedBy/confirmedByRole");
  }
  if (fact.category === "brownfield-observation") {
    if (!isValidIntentStatus(fact.intentStatus)) {
      errors.push(
        `brownfield-observation fact.intentStatus must be one of ${INTENT_STATUSES.join(", ")}, got: ${String(fact.intentStatus)}`
      );
    } else if (fact.intentStatus === "unconfirmed") {
      if (
        Object.prototype.hasOwnProperty.call(fact, "confirmedBy") ||
        Object.prototype.hasOwnProperty.call(fact, "confirmedByRole")
      ) {
        errors.push("an unconfirmed brownfield-observation fact must not carry confirmedBy/confirmedByRole");
      }
    } else {
      if (typeof fact.confirmedBy !== "string" || fact.confirmedBy.length === 0) {
        errors.push(`a ${fact.intentStatus} brownfield-observation fact requires a non-empty confirmedBy identity`);
      }
      if (!CONFIRMING_ROLES.includes(fact.confirmedByRole)) {
        errors.push(
          `confirmedByRole must be one of ${CONFIRMING_ROLES.join(", ")}, got: ${String(fact.confirmedByRole)} — a Domain Expert may clarify but never confirms intent`
        );
      }
    }
  }

  return errors;
}

// Assembles the exact fact-shaped candidate `collectFactRuleViolations`
// should judge, from makeFact's raw constructor input. This is the one place
// that applies makeFact's convenience default (an unspecified
// brownfield-observation intentStatus resolves to "unconfirmed" rather than
// being rejected as missing) — a persisted fact validated via validateFact
// gets no such default, on purpose: silently defaulting a value read back
// from a stored artifact would mask a real gap. Every field is copied onto
// the candidate exactly when the caller supplied it (never defaulted
// otherwise), including fields that are invalid for the fact's category,
// specifically so collectFactRuleViolations can see and reject them exactly
// as it would for a hand-built fact carrying the same mistake.
function buildFactCandidate(input) {
  const { id, category, description, provenance, evidence, value, secretName, intentStatus, confirmedBy, confirmedByRole } =
    input;
  const candidate = { id, category, provenance };
  if (description !== undefined) candidate.description = description;
  if (evidence !== undefined) candidate.evidence = evidence;
  if (Object.prototype.hasOwnProperty.call(input, "secretValue")) {
    candidate.secretValue = input.secretValue;
  }

  const resolvedIntentStatus =
    category === "brownfield-observation" && intentStatus === undefined ? "unconfirmed" : intentStatus;
  if (resolvedIntentStatus !== undefined) candidate.intentStatus = resolvedIntentStatus;
  if (confirmedBy !== undefined) candidate.confirmedBy = confirmedBy;
  if (confirmedByRole !== undefined) candidate.confirmedByRole = confirmedByRole;

  if (category === "secret-name") {
    candidate.secretName = secretName;
  }
  if (value !== undefined) candidate.value = value;

  return candidate;
}

// makeFact — construct one immutable fact. Throws (fails closed) with the
// first rule violation `collectFactRuleViolations` finds, rather than
// returning a partially-valid object. See that function's own comment for
// the full invariant list.
export function makeFact(input = {}) {
  const candidate = buildFactCandidate(input);
  const errors = collectFactRuleViolations(candidate);
  if (errors.length > 0) {
    throw new Error(errors[0]);
  }
  return Object.freeze(candidate);
}

// validateFact — non-throwing check for a fact object that arrived from
// somewhere other than makeFact (e.g. parsed from a persisted artifact).
// Returns { ok, errors }, collecting every violation from the same rule set
// makeFact uses. Never mutates its input.
export function validateFact(fact) {
  if (fact === null || typeof fact !== "object" || Array.isArray(fact)) {
    return { ok: false, errors: ["fact must be an object"] };
  }
  const errors = collectFactRuleViolations(fact);
  return { ok: errors.length === 0, errors };
}

// validateInventory — validate a whole Setup Inventory artifact shape:
//   { generatedAt: string, repoRoot: string, facts: Fact[] }
// Fails closed on an unknown top-level key, a missing required field, or any
// invalid fact — the same "reject rather than warn" posture the parent spec
// requires everywhere else in the bundle.
const INVENTORY_KEYS = Object.freeze(["generatedAt", "repoRoot", "facts"]);

export function validateInventory(inventory) {
  const errors = [];
  if (inventory === null || typeof inventory !== "object" || Array.isArray(inventory)) {
    return { ok: false, errors: ["Setup Inventory must be an object"] };
  }
  for (const key of Object.keys(inventory)) {
    if (!INVENTORY_KEYS.includes(key)) {
      errors.push(`Setup Inventory has an unknown field: ${key}`);
    }
  }
  if (typeof inventory.generatedAt !== "string" || inventory.generatedAt.length === 0) {
    errors.push("Setup Inventory.generatedAt must be a non-empty string");
  }
  if (typeof inventory.repoRoot !== "string" || inventory.repoRoot.length === 0) {
    errors.push("Setup Inventory.repoRoot must be a non-empty string");
  }
  if (!Array.isArray(inventory.facts)) {
    errors.push("Setup Inventory.facts must be an array");
  } else {
    const seenIds = new Set();
    inventory.facts.forEach((fact, index) => {
      const { ok, errors: factErrors } = validateFact(fact);
      if (!ok) {
        for (const e of factErrors) errors.push(`facts[${index}]: ${e}`);
      } else if (seenIds.has(fact.id)) {
        errors.push(`facts[${index}]: duplicate fact id: ${fact.id}`);
      } else {
        seenIds.add(fact.id);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}
