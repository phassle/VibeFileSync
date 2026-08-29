// dynamic-qa/acceptance/selftest/canonical-digest.example.mjs
//
// A worked example of the deterministic-core pattern later tickets follow
// under dynamic-qa/shared/scripts/ (see PLACEHOLDER.md there): plain ESM,
// Node built-in modules only, no dependencies. This module itself is not
// part of the bundle — see selftest/README.md.

import { createHash } from "node:crypto";

// canonicalize — deterministic, stable-key-order representation of a JSON
// value. Object keys are sorted recursively; array element order is
// preserved (order is meaningful for arrays, not for object keys).
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

// contentDigest — sha256 over the canonical JSON text, prefixed the same
// way BUNDLE_MANIFEST.json's digest is (see dynamic-qa/build.sh).
export function contentDigest(value) {
  const text = JSON.stringify(canonicalize(value));
  const hex = createHash("sha256").update(text).digest("hex");
  return `sha256:${hex}`;
}
