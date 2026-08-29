// dynamic-qa/shared/scripts/level-inference.test.mjs
//
// Ticket #147 coverage: elimination of unsafe/incomplete/unobservable
// candidates before cost is considered; cheapest-complete selection across
// several flow shapes; proof that no universal API-vs-CLI ranking exists (a
// case where each wins on cost alone); override requires explicit review
// and is never inferred; a malformed candidate list fails closed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { selectTestLevel } from "./level-inference.mjs";

function candidate(id, overrides = {}) {
  return {
    id,
    safe: true,
    provesAllOutcomes: true,
    observable: true,
    cost: { reuse: 0, runtime: 0, fixtureComplexity: 0, boundaryFidelity: 0, maintenance: 0 },
    ...overrides,
  };
}

function withCost(id, cost, overrides = {}) {
  return candidate(id, { cost, ...overrides });
}

test("eliminates an unsafe candidate before cost is considered, even if cheapest", () => {
  const result = selectTestLevel([
    withCost("api", { reuse: 0, runtime: 0, fixtureComplexity: 0, boundaryFidelity: 0, maintenance: 0 }, { safe: false }),
    withCost("browser", { reuse: 9, runtime: 9, fixtureComplexity: 9, boundaryFidelity: 9, maintenance: 9 }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.selection, "inferred");
  assert.equal(result.levelId, "browser");
  assert.equal(result.eliminated.length, 1);
  assert.equal(result.eliminated[0].id, "api");
  assert.equal(result.eliminated[0].code, "unsafe");
});

test("eliminates an incomplete candidate (does not prove every outcome)", () => {
  const result = selectTestLevel([
    candidate("cli", { provesAllOutcomes: false }),
    candidate("api"),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.levelId, "api");
  assert.deepEqual(result.eliminated, [
    { id: "cli", code: "incomplete", message: 'level "cli" eliminated: incomplete (cannot prove every declared Expected Outcome)' },
  ]);
});

test("eliminates an unobservable candidate", () => {
  const result = selectTestLevel([
    candidate("api", { observable: false }),
    candidate("browser"),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.levelId, "browser");
  assert.equal(result.eliminated[0].code, "unobservable");
});

test("fails closed when every candidate is eliminated", () => {
  const result = selectTestLevel([
    candidate("api", { safe: false }),
    candidate("cli", { provesAllOutcomes: false }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-surviving-candidate");
  assert.equal(result.eliminated.length, 2);
});

test("selects the cheapest surviving candidate among several flow shapes", () => {
  const result = selectTestLevel([
    withCost("api", { reuse: 1, runtime: 1, fixtureComplexity: 1, boundaryFidelity: 1, maintenance: 1 }),
    withCost("cli", { reuse: 2, runtime: 2, fixtureComplexity: 2, boundaryFidelity: 2, maintenance: 2 }),
    withCost("browser", { reuse: 5, runtime: 5, fixtureComplexity: 5, boundaryFidelity: 5, maintenance: 5 }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.selection, "inferred");
  assert.equal(result.levelId, "api");
  assert.deepEqual(
    result.ranked.map((r) => r.id),
    ["api", "cli", "browser"],
  );
});

test("no universal API-vs-CLI ranking: API wins when it is cheaper", () => {
  const result = selectTestLevel([
    withCost("api", { reuse: 0, runtime: 1, fixtureComplexity: 0, boundaryFidelity: 0, maintenance: 0 }),
    withCost("cli", { reuse: 3, runtime: 1, fixtureComplexity: 2, boundaryFidelity: 0, maintenance: 1 }),
  ]);
  assert.equal(result.levelId, "api");
});

test("no universal API-vs-CLI ranking: CLI wins on the very next flow when it is cheaper there", () => {
  // Same two level ids, opposite cost shape: here the API surface needs a
  // whole new mock server (high reuse/fixture cost) while the CLI reuses an
  // existing harness untouched. The winner flips purely on the numbers.
  const result = selectTestLevel([
    withCost("api", { reuse: 8, runtime: 1, fixtureComplexity: 6, boundaryFidelity: 1, maintenance: 2 }),
    withCost("cli", { reuse: 0, runtime: 1, fixtureComplexity: 0, boundaryFidelity: 0, maintenance: 0 }),
  ]);
  assert.equal(result.levelId, "cli");
});

test("ties break deterministically by ascending id, never by input order alone", () => {
  const sameCost = { reuse: 1, runtime: 1, fixtureComplexity: 1, boundaryFidelity: 1, maintenance: 1 };
  const result = selectTestLevel([withCost("zeta", sameCost), withCost("alpha", sameCost)]);
  assert.equal(result.levelId, "alpha");
});

test("a reviewed override selects a named surviving candidate over cost ranking", () => {
  const result = selectTestLevel(
    [
      withCost("api", { reuse: 0, runtime: 0, fixtureComplexity: 0, boundaryFidelity: 0, maintenance: 0 }),
      withCost("browser", { reuse: 9, runtime: 9, fixtureComplexity: 9, boundaryFidelity: 9, maintenance: 9 }),
    ],
    { override: { levelId: "browser", reviewed: true, reason: "checkout is the required end-to-end evidence per QA Owner review" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.selection, "override");
  assert.equal(result.levelId, "browser");
  assert.match(result.reason, /required end-to-end evidence/);
});

test("an override is rejected when not reviewed — never inferred", () => {
  const result = selectTestLevel([candidate("api"), candidate("browser")], {
    override: { levelId: "browser", reviewed: false, reason: "because it seems safer" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "override-not-reviewed");
});

test("an override without reviewed at all is rejected, not defaulted to false-and-continue", () => {
  const result = selectTestLevel([candidate("api"), candidate("browser")], {
    override: { levelId: "browser", reason: "some reason" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "override-not-reviewed");
});

test("a reviewed override requires a non-empty reason", () => {
  const result = selectTestLevel([candidate("api"), candidate("browser")], {
    override: { levelId: "browser", reviewed: true, reason: "" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "override-missing-reason");
});

test("a reviewed override cannot name an eliminated (unsafe) candidate", () => {
  const result = selectTestLevel(
    [candidate("api", { safe: false }), candidate("cli")],
    { override: { levelId: "api", reviewed: true, reason: "trust me" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "override-candidate-ineligible");
  assert.match(result.errors[0].message, /eliminated \(unsafe\)/);
});

test("a reviewed override cannot name a level absent from the candidate list", () => {
  const result = selectTestLevel([candidate("api")], {
    override: { levelId: "browser", reviewed: true, reason: "trust me" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "override-candidate-ineligible");
  assert.match(result.errors[0].message, /not among the candidates/);
});

test("fails closed on an empty candidate list", () => {
  const result = selectTestLevel([]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-candidates");
});

test("fails closed on a malformed candidate (missing cost field)", () => {
  const result = selectTestLevel([{ id: "api", safe: true, provesAllOutcomes: true, observable: true, cost: { reuse: 0 } }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed-candidates");
});

test("fails closed on duplicate candidate ids", () => {
  const result = selectTestLevel([candidate("api"), candidate("api")]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate-candidate-id");
});
