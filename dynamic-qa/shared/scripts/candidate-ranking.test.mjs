// dynamic-qa/shared/scripts/candidate-ranking.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeCandidateFlow,
  scoreCandidateFlow,
  rankCandidateFlows,
  evaluatePortfolioSize,
  PORTFOLIO_GUIDANCE,
  isValidTicketUri,
} from "./candidate-ranking.mjs";

const TICKET = "https://github.com/phassle/VibeFileSync/issues/18";

function candidate(overrides = {}) {
  return makeCandidateFlow({
    id: "update-preserves-safetynet",
    title: "Update preserves prior version",
    originatingTickets: [TICKET],
    impact: "high",
    frequency: "high",
    changeExposure: "medium",
    escapeCount: 1,
    cheaperCoverageExists: false,
    ...overrides,
  });
}

// --- makeCandidateFlow: fail-closed shape --------------------------------

test("makeCandidateFlow accepts a well-formed candidate", () => {
  const c = candidate();
  assert.equal(c.id, "update-preserves-safetynet");
  assert.deepEqual(c.originatingTickets, [TICKET]);
});

test("makeCandidateFlow rejects an empty originating-ticket list", () => {
  assert.throws(() => candidate({ originatingTickets: [] }), /originating ticket link/);
});

test("makeCandidateFlow rejects a missing originating-ticket list", () => {
  assert.throws(() => candidate({ originatingTickets: undefined }), /originating ticket link/);
});

test("makeCandidateFlow rejects a malformed ticket reference", () => {
  assert.throws(() => candidate({ originatingTickets: ["not-a-url"] }), /invalid originating ticket/);
});

test("makeCandidateFlow rejects an invalid id", () => {
  assert.throws(() => candidate({ id: "Not Kebab Case" }), /semantic kebab-case/);
});

test("makeCandidateFlow rejects an empty title", () => {
  assert.throws(() => candidate({ title: "" }), /non-empty title/);
});

for (const factor of ["impact", "frequency", "changeExposure"]) {
  test(`makeCandidateFlow rejects an invalid ${factor}`, () => {
    assert.throws(() => candidate({ [factor]: "extreme" }), new RegExp(factor));
  });
}

test("makeCandidateFlow rejects a negative escapeCount", () => {
  assert.throws(() => candidate({ escapeCount: -1 }), /escapeCount/);
});

test("makeCandidateFlow rejects a non-integer escapeCount", () => {
  assert.throws(() => candidate({ escapeCount: 1.5 }), /escapeCount/);
});

test("makeCandidateFlow rejects a non-boolean cheaperCoverageExists", () => {
  assert.throws(() => candidate({ cheaperCoverageExists: "yes" }), /cheaperCoverageExists/);
});

test("isValidTicketUri accepts http(s) and rejects anything else", () => {
  assert.equal(isValidTicketUri(TICKET), true);
  assert.equal(isValidTicketUri("ftp://example.com/1"), false);
  assert.equal(isValidTicketUri(""), false);
  assert.equal(isValidTicketUri(undefined), false);
});

// --- scoreCandidateFlow: five factors, each explicit ----------------------

test("scoreCandidateFlow exposes every one of the five ranking factors individually", () => {
  const scores = scoreCandidateFlow(candidate());
  for (const key of ["impact", "frequency", "changeExposure", "escapeHistory", "cheaperCoverageExists", "total"]) {
    assert.equal(typeof scores[key], "number", `expected numeric score for ${key}`);
  }
});

test("scoring is deterministic for a fixed input", () => {
  const c = candidate();
  const first = scoreCandidateFlow(c);
  const second = scoreCandidateFlow(c);
  assert.deepEqual(first, second);
});

test("raising impact raises the total score, all else equal", () => {
  const low = scoreCandidateFlow(candidate({ impact: "low" }));
  const high = scoreCandidateFlow(candidate({ impact: "critical" }));
  assert.ok(high.total > low.total);
});

test("raising frequency raises the total score, all else equal", () => {
  const low = scoreCandidateFlow(candidate({ frequency: "low" }));
  const high = scoreCandidateFlow(candidate({ frequency: "critical" }));
  assert.ok(high.total > low.total);
});

test("raising changeExposure raises the total score, all else equal", () => {
  const low = scoreCandidateFlow(candidate({ changeExposure: "low" }));
  const high = scoreCandidateFlow(candidate({ changeExposure: "critical" }));
  assert.ok(high.total > low.total);
});

test("a longer escape history raises the total score, all else equal", () => {
  const none = scoreCandidateFlow(candidate({ escapeCount: 0 }));
  const many = scoreCandidateFlow(candidate({ escapeCount: 5 }));
  assert.ok(many.total > none.total);
});

test("cheaper coverage already existing lowers the total score, all else equal", () => {
  const withoutCoverage = scoreCandidateFlow(candidate({ cheaperCoverageExists: false }));
  const withCoverage = scoreCandidateFlow(candidate({ cheaperCoverageExists: true }));
  assert.ok(withCoverage.total < withoutCoverage.total);
});

// --- rankCandidateFlows: deterministic, explainable, never additive -------

test("rankCandidateFlows orders by total score, highest first", () => {
  const low = candidate({ id: "low-risk-flow", impact: "low", frequency: "low", changeExposure: "low", escapeCount: 0 });
  const high = candidate({ id: "high-risk-flow", impact: "critical", frequency: "critical", changeExposure: "critical", escapeCount: 5 });
  const ranked = rankCandidateFlows([low, high]);
  assert.equal(ranked[0].candidate.id, "high-risk-flow");
  assert.equal(ranked[1].candidate.id, "low-risk-flow");
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
});

test("rankCandidateFlows is deterministic regardless of input order", () => {
  const a = candidate({ id: "flow-a" });
  const b = candidate({ id: "flow-b", escapeCount: 3 });
  const forward = rankCandidateFlows([a, b]).map((r) => r.candidate.id);
  const backward = rankCandidateFlows([b, a]).map((r) => r.candidate.id);
  assert.deepEqual(forward, backward);
});

test("rankCandidateFlows breaks ties by ascending id", () => {
  const z = candidate({ id: "z-flow" });
  const a = candidate({ id: "a-flow" });
  const ranked = rankCandidateFlows([z, a]);
  assert.deepEqual(ranked.map((r) => r.candidate.id), ["a-flow", "z-flow"]);
});

test("rankCandidateFlows exposes factorScores per candidate, not just a combined total", () => {
  const ranked = rankCandidateFlows([candidate()]);
  assert.ok(ranked[0].factorScores);
  assert.equal(typeof ranked[0].factorScores.impact, "number");
});

test("rankCandidateFlows never returns more entries than it was given (no padding)", () => {
  const ranked = rankCandidateFlows([candidate({ id: "only-one-flow" })]);
  assert.equal(ranked.length, 1);
});

test("rankCandidateFlows rejects a non-array input", () => {
  assert.throws(() => rankCandidateFlows("not-an-array"), /array of Candidate Flows/);
});

// --- evaluatePortfolioSize: guidance, not a hard cap ----------------------

test("PORTFOLIO_GUIDANCE is the documented 5-10 band", () => {
  assert.equal(PORTFOLIO_GUIDANCE.min, 5);
  assert.equal(PORTFOLIO_GUIDANCE.max, 10);
});

test("fewer than five flows is always allowed, with no override needed", () => {
  for (let n = 0; n <= 4; n++) {
    const result = evaluatePortfolioSize(n);
    assert.equal(result.allowed, true, `expected ${n} flows to be allowed`);
    assert.equal(result.requiresOverride, false);
    assert.equal(result.band, "below-guidance");
  }
});

test("a portfolio of three flows is accepted without any override or padding", () => {
  const result = evaluatePortfolioSize(3);
  assert.equal(result.allowed, true);
  assert.equal(result.withinGuidance, false);
  assert.equal(result.band, "below-guidance");
  assert.deepEqual(result.errors, []);
});

test("five to ten flows is within guidance, no override needed", () => {
  for (let n = 5; n <= 10; n++) {
    const result = evaluatePortfolioSize(n);
    assert.equal(result.allowed, true, `expected ${n} flows to be allowed`);
    assert.equal(result.withinGuidance, true);
    assert.equal(result.requiresOverride, false);
  }
});

test("more than ten flows without an override is refused, not silently truncated", () => {
  const result = evaluatePortfolioSize(11);
  assert.equal(result.requiresOverride, true);
  assert.equal(result.allowed, false);
  assert.ok(result.errors.length > 0);
});

test("more than ten flows with a valid reviewed override is allowed", () => {
  const result = evaluatePortfolioSize(12, {
    approvedBy: "per",
    approvedByRole: "qa-owner",
    reason: "this repository genuinely has twelve critical flows",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.requiresOverride, true);
});

test("an override naming a Domain Expert is rejected", () => {
  const result = evaluatePortfolioSize(12, {
    approvedBy: "dana",
    approvedByRole: "domain-expert",
    reason: "dana said it was fine",
  });
  assert.equal(result.allowed, false);
});

test("an override missing a reason is rejected", () => {
  const result = evaluatePortfolioSize(12, { approvedBy: "per", approvedByRole: "qa-owner" });
  assert.equal(result.allowed, false);
  assert.ok(result.errors.some((e) => /reason/.test(e)));
});

test("evaluatePortfolioSize rejects a negative or non-integer count", () => {
  assert.throws(() => evaluatePortfolioSize(-1));
  assert.throws(() => evaluatePortfolioSize(2.5));
});
