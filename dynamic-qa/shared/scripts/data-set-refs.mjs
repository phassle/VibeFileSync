// dynamic-qa/shared/scripts/data-set-refs.mjs
//
// Structural validation for a Flow Definition's `data_sets` field: a list of
// Named Data Set IDs the flow references (DESIGN-dynamic-qa-spec.md §5.1
// "referenced data_sets").
//
// EXTENSION SEAM for #144 (the Named Data Set contract): this module only
// checks that each reference is a well-formed, unique semantic ID — the
// *shape* of the reference. It deliberately does NOT open, parse, or
// validate any `qa/data/<data-set-id>.yaml` file, and does not check that a
// referenced data set actually exists. #144 is expected to import
// `validateDataSetReferences` from here to keep the reference-shape check
// identical everywhere, then add its own module (e.g. named-data-set.mjs)
// that opens the referenced file, validates its own schema, and cross-checks
// existence — layered on top of this shape check, not forking it.

import { isValidSemanticId } from "./id-rules.mjs";

/**
 * Validates a flow's `data_sets` array. Returns an array of
 * { path, message } issues (empty when valid).
 */
export function validateDataSetReferences(dataSets, path) {
  const issues = [];
  const fail = (message, subpath = path) => issues.push({ path: subpath, message });

  if (!Array.isArray(dataSets)) {
    fail("data_sets must be a list of Named Data Set IDs");
    return issues;
  }

  const seen = new Set();
  dataSets.forEach((id, index) => {
    const itemPath = [...path, index];
    if (!isValidSemanticId(id)) {
      fail(`each data_sets entry must be a semantic Named Data Set id (got ${JSON.stringify(id)})`, itemPath);
      return;
    }
    if (seen.has(id)) {
      fail(`duplicate data_sets reference ${JSON.stringify(id)}`, itemPath);
    }
    seen.add(id);
  });

  return issues;
}
