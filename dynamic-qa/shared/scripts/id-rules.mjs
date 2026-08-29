// dynamic-qa/shared/scripts/id-rules.mjs
//
// Shared identifier rules for the deterministic core. Flow, step, outcome,
// boundary, and (later) Named Data Set / Execution Profile IDs are all
// semantic, kebab-case, human-authored names — never derived from an issue
// number, never reused, never renamed once assigned (per DESIGN-dynamic-qa-spec.md
// §5.1 and the run brief). This module exists so every schema-shaped module
// (flow-definition.mjs today; the Named Data Set / Execution Profile
// validators #144/#145 add later) checks IDs the same way instead of each
// inventing its own regex.

// Lowercase letters/digits, hyphen-separated words, no leading/trailing or
// doubled hyphens, no leading digit. Deliberately excludes underscores and
// uppercase so an ID can double as a filename on any filesystem.
export const SEMANTIC_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isValidSemanticId(value) {
  return typeof value === "string" && SEMANTIC_ID_RE.test(value);
}

export function assertValidSemanticId(value, label) {
  if (!isValidSemanticId(value)) {
    throw new Error(
      `${label} must be a semantic kebab-case identifier matching ${SEMANTIC_ID_RE} (got ${JSON.stringify(value)})`,
    );
  }
}
