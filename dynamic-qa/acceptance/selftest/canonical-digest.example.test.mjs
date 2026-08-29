// dynamic-qa/acceptance/selftest/canonical-digest.example.test.mjs
//
// Uses only node:test and node:assert — the same zero-dependency pattern
// every future dynamic-qa/shared/scripts/*.test.mjs is expected to follow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, contentDigest } from "./canonical-digest.example.mjs";

test("canonicalize sorts object keys but preserves array order", () => {
  const a = canonicalize({ b: 1, a: 2, c: [3, 1, 2] });
  assert.deepEqual(Object.keys(a), ["a", "b", "c"]);
  assert.deepEqual(a.c, [3, 1, 2]);
});

test("contentDigest is independent of key order", () => {
  const d1 = contentDigest({ a: 1, b: 2 });
  const d2 = contentDigest({ b: 2, a: 1 });
  assert.equal(d1, d2);
});

test("contentDigest changes when content changes", () => {
  const d1 = contentDigest({ a: 1 });
  const d2 = contentDigest({ a: 2 });
  assert.notEqual(d1, d2);
});

test("contentDigest is sensitive to array order (arrays are ordered data)", () => {
  const d1 = contentDigest({ a: [1, 2] });
  const d2 = contentDigest({ a: [2, 1] });
  assert.notEqual(d1, d2);
});
