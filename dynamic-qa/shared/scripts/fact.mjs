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

export const PROVENANCE = Object.freeze(["observed", "reported", "unknown"]);

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
]);

export function isValidProvenance(provenance) {
  return PROVENANCE.includes(provenance);
}

export function isKnownCategory(category) {
  return CATEGORIES.includes(category);
}

// makeFact — construct one immutable fact. Throws (fails closed) rather than
// returning a partially-valid object, on:
//   - an unknown category
//   - a provenance outside PROVENANCE
//   - a "secret-name" category fact carrying `value` or `secretValue`
//   - any fact carrying `secretValue` at all (there is no legitimate use)
export function makeFact(input = {}) {
  const { id, category, description, provenance, evidence, value, secretName } = input;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("fact.id must be a non-empty string");
  }
  if (!isKnownCategory(category)) {
    throw new Error(`fact.category is not a known Setup Inventory category: ${String(category)}`);
  }
  if (!isValidProvenance(provenance)) {
    throw new Error(`fact.provenance must be observed, reported, or unknown, got: ${String(provenance)}`);
  }
  if (Object.prototype.hasOwnProperty.call(input, "secretValue")) {
    throw new Error("fact must never carry a secretValue field — secrets are inspected by name only");
  }
  if (category === "secret-name" && value !== undefined) {
    throw new Error("a secret-name fact may record a secret's name only, never its value");
  }

  const fact = { id, category, provenance };
  if (description !== undefined) fact.description = description;
  if (evidence !== undefined) fact.evidence = evidence;
  if (category === "secret-name") {
    if (typeof secretName !== "string" || secretName.length === 0) {
      throw new Error("a secret-name fact requires a non-empty secretName");
    }
    fact.secretName = secretName;
  } else if (value !== undefined) {
    fact.value = value;
  }
  return Object.freeze(fact);
}

// validateFact — non-throwing check for a fact object that arrived from
// somewhere other than makeFact (e.g. parsed from a persisted artifact).
// Returns { ok, errors }. Never mutates its input.
export function validateFact(fact) {
  const errors = [];
  if (fact === null || typeof fact !== "object" || Array.isArray(fact)) {
    return { ok: false, errors: ["fact must be an object"] };
  }
  if (typeof fact.id !== "string" || fact.id.length === 0) {
    errors.push("fact.id must be a non-empty string");
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
