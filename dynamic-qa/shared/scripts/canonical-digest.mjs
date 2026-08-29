// dynamic-qa/shared/scripts/canonical-digest.mjs
//
// Canonicalization and content digests over a validated JS data model — the
// real, bundle-wide version of the pattern worked out in
// dynamic-qa/acceptance/selftest/canonical-digest.example.mjs (that file
// stays an illustrative harness self-check; this is the real deterministic-
// core module it prefigured — see PLACEHOLDER.md's note on the seam).
//
// The contract this exists to satisfy (DESIGN-dynamic-qa-spec.md §5.1 and
// SPEC-135.md): "Digests are computed over the canonical validated data
// model, not over formatting." Concretely: two Flow Definition files that
// differ only in comments, blank lines, key order, indentation, or quote
// style parse to the same JS value and therefore produce the same digest;
// any change to a semantically meaningful value changes it.
//
// Used for more than Flow Definitions — the same canonicalize/contentDigest
// pair is the intended shape for Named Data Set, Execution Profile, and
// provenance digests in later tickets, so it lives as its own module rather
// than inside flow-definition.mjs.

import { createHash } from "node:crypto";

/**
 * Deterministic, stable-key-order representation of a JSON-compatible
 * value. Object keys are sorted recursively; array element order is
 * preserved (array order is meaningful data, e.g. Given/When/Then step
 * order; object key order is purely a YAML-authoring artifact and is not).
 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    const out = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * sha256 over the canonical JSON text of `value`, prefixed "sha256:" to
 * match dist/BUNDLE_MANIFEST.json's digest format (see dynamic-qa/build.sh).
 */
export function contentDigest(value) {
  const text = JSON.stringify(canonicalize(value));
  const hex = createHash("sha256").update(text).digest("hex");
  return `sha256:${hex}`;
}
