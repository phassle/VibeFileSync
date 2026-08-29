// dynamic-qa/shared/scripts/secret-detection.test.mjs
//
// Tier 1 coverage for the free-text scrubbing additions this ticket (#155)
// made to secret-detection.mjs: `redactSecretsInText` and
// `textStillContainsSecretShapedValue`. `detectSecretValue` itself (the
// single-scalar detector) was landed and is exercised by #144's
// named-data-set.test.mjs; this file covers only the new text-blob variants.

import { test } from "node:test";
import assert from "node:assert/strict";

import { redactSecretsInText, textStillContainsSecretShapedValue } from "./secret-detection.mjs";

test("redactSecretsInText: redacts a private key block embedded in a larger log", () => {
  const log = "starting up\n-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----\nshutdown";
  const { text, redactionCount } = redactSecretsInText(log);
  assert.equal(redactionCount, 1);
  assert.ok(!text.includes("BEGIN RSA PRIVATE KEY"));
  assert.ok(text.includes("[REDACTED]"));
});

test("redactSecretsInText: redacts a GitHub token inside a DOM attribute string", () => {
  const dom = `<div data-token="ghp_abcdefghijklmnopqrstuvwx0123"></div>`;
  const { text, redactionCount } = redactSecretsInText(dom);
  assert.equal(redactionCount, 1);
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwx0123"));
});

test("redactSecretsInText: redacts a Bearer token inside a trace event line", () => {
  const trace = `{"type":"request","headers":{"authorization":"Bearer eyJabc.def123token"}}`;
  const { text, redactionCount } = redactSecretsInText(trace);
  assert.ok(redactionCount >= 1);
  assert.ok(!text.includes("Bearer eyJabc.def123token"));
});

test("redactSecretsInText: redacts a credentialed connection string inside JUnit system-out", () => {
  const junit = `<system-out>connect to postgres://svc:s3cr3tPassw0rd@db.internal:5432/app failed</system-out>`;
  const { text, redactionCount } = redactSecretsInText(junit);
  assert.ok(redactionCount >= 1);
  assert.ok(!text.includes("svc:s3cr3tPassw0rd@"));
});

test("redactSecretsInText: leaves ordinary prose untouched", () => {
  const log = "test run completed: 12 passed, 0 failed, duration 4.2s";
  const { text, redactionCount } = redactSecretsInText(log);
  assert.equal(redactionCount, 0);
  assert.equal(text, log);
});

test("redactSecretsInText: is idempotent — re-running it against its own output finds nothing new", () => {
  const log = "token=ghp_abcdefghijklmnopqrstuvwx0123 and more text";
  const first = redactSecretsInText(log);
  const second = redactSecretsInText(first.text);
  assert.equal(second.redactionCount, 0);
});

test("textStillContainsSecretShapedValue: true on raw, unredacted secret-bearing text", () => {
  assert.equal(textStillContainsSecretShapedValue("token=ghp_abcdefghijklmnopqrstuvwx0123"), true);
});

test("textStillContainsSecretShapedValue: false after redaction", () => {
  const { text } = redactSecretsInText("token=ghp_abcdefghijklmnopqrstuvwx0123");
  assert.equal(textStillContainsSecretShapedValue(text), false);
});

test("textStillContainsSecretShapedValue: false on ordinary prose", () => {
  assert.equal(textStillContainsSecretShapedValue("all tests passed"), false);
});

test("textStillContainsSecretShapedValue: repeated calls do not leak global-regex lastIndex state", () => {
  // Regression guard: module-level `g`-flag regexes carry `lastIndex` state
  // across calls if not reset. Calling twice in a row on the same
  // secret-bearing text must return true both times.
  const text = "Bearer abcdefghijklmnop";
  assert.equal(textStillContainsSecretShapedValue(text), true);
  assert.equal(textStillContainsSecretShapedValue(text), true);
});
