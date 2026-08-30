// dynamic-qa/shared/scripts/execution-profile-yaml.mjs
//
// The YAML authoring/rendering surface for `qa/execution-profiles/<id>.yaml`
// that #150 explicitly left unbuilt ("No YAML authoring/rendering surface
// exists for `qa/execution-profiles/<id>.yaml`" — DECISIONS.md §15). Ticket
// #166.
//
// This is deliberately a thin pair of functions, not a new renderer or
// parser: it calls flow-yaml.mjs's `renderRestrictedYAMLDocument` (the same
// generic renderer #164 built for Flow Definitions — nothing here is
// specific to Flow Definitions, so #166 reuses it directly rather than
// duplicating renderMappingLines/renderSequenceLines a second time) and
// restricted-yaml.mjs's `parseRestrictedYAML` (the same fail-closed parser
// every other schema in this bundle uses) plus execution-profile.mjs's own
// `validateExecutionProfile`. There is exactly one restricted-YAML rendering
// code path in the whole bundle and exactly one restricted-YAML parsing
// code path; this module adds neither.

import { renderRestrictedYAMLDocument } from "./flow-yaml.mjs";
import { parseRestrictedYAML } from "./restricted-yaml.mjs";
import { validateExecutionProfile } from "./execution-profile.mjs";

/**
 * Renders `profile` (a plain JS object already shaped like an Execution
 * Profile) as restricted-YAML text, byte-for-byte via the same renderer
 * `flow-yaml.mjs` uses for Flow Definitions. Does not validate `profile`
 * itself — callers should validate before rendering, or use
 * `renderValidatedExecutionProfileYAML` below, which does both.
 */
export function renderExecutionProfileYAML(profile) {
  return renderRestrictedYAMLDocument(profile);
}

/**
 * Renders `profile` only once it has been checked against the v1 contract
 * (`validateExecutionProfile`), so a caller can never write an invalid
 * Execution Profile to disk. Returns `{ valid, errors, yaml }`; `yaml` is
 * `null` when `valid` is `false` — an invalid profile is never rendered to
 * text that could be mistaken for an authored artifact.
 */
export function renderValidatedExecutionProfileYAML(profile, { expectedId } = {}) {
  const { valid, errors } = validateExecutionProfile(profile, { expectedId });
  return { valid, errors, yaml: valid ? renderExecutionProfileYAML(profile) : null };
}

/**
 * Parses and validates Execution Profile YAML text read from
 * `qa/execution-profiles/<id>.yaml` — the read-side counterpart to
 * `renderExecutionProfileYAML`. `parseRestrictedYAML` throws
 * `YamlSyntaxError` for hostile/malformed input (aliases, custom tags,
 * duplicate keys, executable expressions, tab indentation, ...), exactly as
 * every other schema in this bundle: a malformed Execution Profile document
 * is a parse-time failure, never a validation warning. Once parsed, the
 * plain JS value is checked with `validateExecutionProfile`.
 *
 * Returns `{ valid, errors, data }`. `filename` is optional context passed
 * through to the parser's error messages; `expectedId` is passed through to
 * `validateExecutionProfile` so a profile's declared `id` is checked against
 * its filename, mirroring flow-definition.mjs's `expectedId` convention.
 */
export function parseExecutionProfileYAML(source, { filename, expectedId } = {}) {
  const data = parseRestrictedYAML(source, { filename });
  const { valid, errors } = validateExecutionProfile(data, { expectedId });
  return { valid, errors, data };
}
