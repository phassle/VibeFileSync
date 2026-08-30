// dynamic-qa/shared/scripts/canonical-digest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, contentDigest } from "./canonical-digest.mjs";

test("canonicalize sorts object keys but preserves array order", () => {
  const a = canonicalize({ b: 1, a: 2, c: [3, 1, 2] });
  assert.deepEqual(Object.keys(a), ["a", "b", "c"]);
  assert.deepEqual(a.c, [3, 1, 2]);
});

test("contentDigest is independent of object key order", () => {
  const d1 = contentDigest({ a: 1, b: { x: 1, y: 2 } });
  const d2 = contentDigest({ b: { y: 2, x: 1 }, a: 1 });
  assert.equal(d1, d2);
});

test("contentDigest changes when a value changes", () => {
  const d1 = contentDigest({ a: 1 });
  const d2 = contentDigest({ a: 2 });
  assert.notEqual(d1, d2);
});

test("contentDigest is sensitive to array order", () => {
  const d1 = contentDigest({ steps: ["given", "when", "then"] });
  const d2 = contentDigest({ steps: ["when", "given", "then"] });
  assert.notEqual(d1, d2);
});

test("contentDigest is a prefixed sha256 hex string", () => {
  const d = contentDigest({ a: 1 });
  assert.match(d, /^sha256:[0-9a-f]{64}$/);
});

test("a literal own '__proto__' key digests as ordinary data, without polluting the prototype", () => {
  // JSON.parse (unlike a `{ "__proto__": ... }` literal) creates a real own
  // enumerable data property named "__proto__", the same shape untrusted
  // Named Data Set field names could take.
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  assert.equal(Object.prototype.hasOwnProperty.call(hostile, "__proto__"), true);

  const canonical = canonicalize(hostile);

  // Global Object.prototype must be untouched.
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  // "__proto__" must survive as an ordinary own data key, not be consumed
  // as a prototype reassignment.
  assert.equal(Object.getPrototypeOf(canonical), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(canonical, "__proto__"), true);
  assert.deepEqual(Object.keys(canonical).sort(), ["__proto__", "a"]);
  const protoDescriptor = Object.getOwnPropertyDescriptor(canonical, "__proto__");
  assert.equal(protoDescriptor.value.polluted, true);
});

test("contentDigest distinguishes an object with a literal '__proto__' key from one without it", () => {
  const withProtoKey = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  const without = { a: 1 };
  assert.notEqual(contentDigest(withProtoKey), contentDigest(without));
});
