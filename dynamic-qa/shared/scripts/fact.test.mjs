// dynamic-qa/shared/scripts/fact.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFact, validateFact, validateInventory, isValidProvenance, isKnownCategory } from "./fact.mjs";

test("isValidProvenance accepts only observed, reported, unknown", () => {
  assert.equal(isValidProvenance("observed"), true);
  assert.equal(isValidProvenance("reported"), true);
  assert.equal(isValidProvenance("unknown"), true);
  assert.equal(isValidProvenance("confirmed"), false);
  assert.equal(isValidProvenance(""), false);
  assert.equal(isValidProvenance(undefined), false);
});

test("isKnownCategory rejects a category stage 2 was never told to inventory", () => {
  assert.equal(isKnownCategory("test-framework"), true);
  assert.equal(isKnownCategory("ci-runner"), true);
  assert.equal(isKnownCategory("random-made-up-category"), false);
});

test("makeFact builds a well-formed fact", () => {
  const fact = makeFact({
    id: "test-framework:jest",
    category: "test-framework",
    description: "jest found in package.json devDependencies",
    provenance: "observed",
    evidence: "package.json",
  });
  assert.equal(fact.id, "test-framework:jest");
  assert.equal(fact.provenance, "observed");
  assert.equal(fact.evidence, "package.json");
});

test("makeFact fails closed on an unknown category", () => {
  assert.throws(() => makeFact({ id: "x", category: "nonsense", provenance: "observed" }));
});

test("makeFact fails closed on an invalid provenance value", () => {
  assert.throws(() => makeFact({ id: "x", category: "test-framework", provenance: "confident" }));
});

test("makeFact never accepts a secretValue field, on any category", () => {
  assert.throws(() =>
    makeFact({ id: "x", category: "test-framework", provenance: "observed", secretValue: "sk-should-never-appear" })
  );
});

test("makeFact rejects a secret-name fact that also carries a value", () => {
  assert.throws(() =>
    makeFact({ id: "secret:API_KEY", category: "secret-name", provenance: "observed", secretName: "API_KEY", value: "leaked" })
  );
});

test("makeFact requires a non-empty secretName for a secret-name fact", () => {
  assert.throws(() => makeFact({ id: "secret:x", category: "secret-name", provenance: "observed" }));
});

test("makeFact returns a frozen (immutable) fact", () => {
  const fact = makeFact({ id: "x", category: "test-framework", provenance: "unknown" });
  assert.throws(() => {
    fact.provenance = "observed";
  });
});

test("validateFact reports every problem, not just the first", () => {
  const { ok, errors } = validateFact({ category: "nonsense", provenance: "confident" });
  assert.equal(ok, false);
  assert.ok(errors.length >= 3, `expected several errors, got ${errors.length}: ${errors.join("; ")}`);
});

test("validateFact rejects a secretValue field even when everything else is valid", () => {
  const { ok, errors } = validateFact({
    id: "x",
    category: "test-framework",
    provenance: "observed",
    secretValue: "should-never-be-here",
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("secretValue")));
});

test("validateInventory accepts a well-formed Setup Inventory", () => {
  const inventory = {
    generatedAt: "2026-08-29T00:00:00Z",
    repoRoot: "/repo",
    facts: [makeFact({ id: "a", category: "test-framework", provenance: "observed" })],
  };
  const { ok, errors } = validateInventory(inventory);
  assert.equal(ok, true, errors.join("; "));
});

test("validateInventory fails closed on an unknown top-level field", () => {
  const { ok, errors } = validateInventory({
    generatedAt: "2026-08-29T00:00:00Z",
    repoRoot: "/repo",
    facts: [],
    extraField: "not allowed",
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("extraField")));
});

test("validateInventory rejects duplicate fact ids", () => {
  const fact = makeFact({ id: "dup", category: "test-framework", provenance: "observed" });
  const { ok, errors } = validateInventory({
    generatedAt: "2026-08-29T00:00:00Z",
    repoRoot: "/repo",
    facts: [fact, fact],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("duplicate fact id")));
});

test("validateInventory rejects a fact carrying a secret value anywhere in the tree", () => {
  const { ok, errors } = validateInventory({
    generatedAt: "2026-08-29T00:00:00Z",
    repoRoot: "/repo",
    facts: [{ id: "secret:API_KEY", category: "secret-name", provenance: "observed", secretName: "API_KEY", value: "sk-leak" }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("secret-name fact may record a secret's name only")));
});

// --- ticket #163: posture-specific evidence extension ----------------------

test("makeFact defaults a brownfield-observation fact to unconfirmed", () => {
  const fact = makeFact({ id: "obs:1", category: "brownfield-observation", provenance: "observed" });
  assert.equal(fact.intentStatus, "unconfirmed");
  assert.equal(fact.confirmedBy, undefined);
});

test("makeFact rejects intentStatus/confirmedBy/confirmedByRole on any non-brownfield-observation category", () => {
  assert.throws(() =>
    makeFact({ id: "x", category: "test-framework", provenance: "observed", intentStatus: "confirmed-intended" })
  );
  assert.throws(() =>
    makeFact({ id: "x", category: "greenfield-source", provenance: "reported", confirmedBy: "per" })
  );
});

test("makeFact rejects an unconfirmed brownfield-observation fact that already carries a confirming identity", () => {
  assert.throws(() =>
    makeFact({
      id: "obs:1",
      category: "brownfield-observation",
      provenance: "observed",
      intentStatus: "unconfirmed",
      confirmedBy: "per",
      confirmedByRole: "qa-owner",
    })
  );
});

test("makeFact requires a confirming identity once intentStatus leaves unconfirmed", () => {
  assert.throws(() =>
    makeFact({
      id: "obs:1",
      category: "brownfield-observation",
      provenance: "observed",
      intentStatus: "confirmed-intended",
    })
  );
});

test("makeFact rejects a Domain Expert as the confirming role", () => {
  assert.throws(() =>
    makeFact({
      id: "obs:1",
      category: "brownfield-observation",
      provenance: "observed",
      intentStatus: "confirmed-intended",
      confirmedBy: "dana",
      confirmedByRole: "domain-expert",
    })
  );
});

test("makeFact accepts a properly confirmed brownfield-observation fact", () => {
  const fact = makeFact({
    id: "obs:1",
    category: "brownfield-observation",
    provenance: "observed",
    intentStatus: "confirmed-intended",
    confirmedBy: "per",
    confirmedByRole: "qa-owner",
  });
  assert.equal(fact.intentStatus, "confirmed-intended");
  assert.equal(fact.confirmedBy, "per");
  assert.equal(fact.confirmedByRole, "qa-owner");
});

test("validateFact rejects a brownfield-observation fact with an invalid intentStatus", () => {
  const { ok, errors } = validateFact({
    id: "obs:1",
    category: "brownfield-observation",
    provenance: "observed",
    intentStatus: "assumed",
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("intentStatus")));
});

test("validateFact rejects a confirmed brownfield-observation fact missing confirmedByRole", () => {
  const { ok, errors } = validateFact({
    id: "obs:1",
    category: "brownfield-observation",
    provenance: "observed",
    intentStatus: "confirmed-intended",
    confirmedBy: "per",
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("confirmedByRole")));
});

test("validateInventory accepts a greenfield-source fact with unknown provenance and no evidence", () => {
  const inventory = {
    generatedAt: "2026-08-29T00:00:00Z",
    repoRoot: "/repo",
    facts: [makeFact({ id: "gf:1", category: "greenfield-source", provenance: "unknown", description: "no approved source yet" })],
  };
  const { ok, errors } = validateInventory(inventory);
  assert.equal(ok, true, errors.join("; "));
});
