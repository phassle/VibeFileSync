// dynamic-qa/shared/scripts/resolve-data-sets.mjs
//
// Cross-file resolution of a Flow Definition's `data_sets` references to
// actual Named Data Set files on disk. Ticket #143 deliberately left this
// unchecked: data-set-refs.mjs (imported here) only validates that each
// reference is a well-formed, unique semantic ID — the *shape* of the
// reference, not whether the file exists or is itself valid. A dangling
// reference must fail closed, so this module is the layer that actually
// opens `qa/data/<data-set-id>.yaml`, parses and validates it against the
// Named Data Set v1 contract (named-data-set.mjs), and reports a missing or
// invalid file as an error tied to the exact flow path that referenced it.
//
// EXTENSION SEAM for #145/#146: this is intentionally a small, generic
// "resolve these referenced IDs against a directory of <id>.yaml files,
// using this file-level validator" step, kept separate from
// validateFlowDefinition itself so it can be reused wherever a later ticket
// needs the same resolve-and-validate sequence — e.g. #146's provenance/
// drift gate, which also needs a data set's own digest by ID. Do not fork
// this logic; import `resolveFlowDataSets` (or, for a lower-level building
// block, `resolveDataSetFile`) instead.

import { readFileSync } from "node:fs";
import path from "node:path";
import { validateDataSetReferences } from "./data-set-refs.mjs";
import { parseNamedDataSetFile } from "./named-data-set.mjs";

/**
 * Resolves one Named Data Set ID against `dataSetsDir`, reading
 * `<dataSetsDir>/<id>.yaml`, parsing it as restricted YAML, and validating it
 * against the Named Data Set v1 contract. Returns
 * `{ found, valid, filePath, data, errors }`:
 *   - `found: false` means the file does not exist — a dangling reference.
 *     `errors` names the exact missing path.
 *   - `found: true, valid: false` means the file exists but fails Named Data
 *     Set validation. `errors` are that file's own validation issues.
 *   - `found: true, valid: true` carries the parsed `data`.
 * Never throws for a missing file or a schema violation (both are reported
 * as data); a malformed-YAML syntax error from parseNamedDataSetFile (e.g.
 * an alias or duplicate key) is allowed to propagate as a thrown
 * YamlSyntaxError, exactly as it does for a Flow Definition file, since
 * parsing cannot proceed past it at all.
 */
export function resolveDataSetFile(id, { dataSetsDir }) {
  const filePath = path.join(dataSetsDir, `${id}.yaml`);
  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        found: false,
        valid: false,
        filePath,
        data: null,
        errors: [{ path: [], message: `Named Data Set file not found: ${filePath}` }],
      };
    }
    throw err;
  }

  const result = parseNamedDataSetFile(source, { filename: id });
  return { found: true, valid: result.valid, filePath, data: result.valid ? result : null, errors: result.errors };
}

/**
 * Resolves every `data_sets` entry on an already-parsed Flow Definition
 * value against `dataSetsDir`. Returns `{ valid, errors }` in the same
 * `{ path, message }` shape as validateFlowDefinition, with `path` rooted at
 * `["data_sets", <index>]` so a dangling or invalid reference is traceable
 * back to the exact flow field that named it.
 *
 * This re-applies `validateDataSetReferences` (the reference-shape check)
 * rather than assuming the caller already ran it, so this function is safe
 * to call standalone — it does not fork that check, it reuses it.
 */
export function resolveFlowDataSets(flowData, { dataSetsDir }) {
  const shapeIssues = validateDataSetReferences(flowData && flowData.data_sets, ["data_sets"]);
  const issues = [...shapeIssues];

  if (!Array.isArray(flowData?.data_sets)) {
    return { valid: false, errors: issues };
  }

  flowData.data_sets.forEach((id, index) => {
    const refPath = ["data_sets", index];
    // Only attempt to resolve well-formed, non-duplicate IDs; a shape
    // problem on this entry was already reported above and resolving a
    // malformed ID against the filesystem would just be noise.
    if (shapeIssues.some((issue) => issue.path.length === 2 && issue.path[1] === index)) return;

    const resolved = resolveDataSetFile(id, { dataSetsDir });
    if (!resolved.found) {
      issues.push({
        path: refPath,
        message: `dangling data_sets reference ${JSON.stringify(id)}: ${resolved.errors[0].message}`,
      });
      return;
    }
    if (!resolved.valid) {
      for (const issue of resolved.errors) {
        issues.push({
          path: refPath,
          message: `data_sets reference ${JSON.stringify(id)} resolves to an invalid Named Data Set (${resolved.filePath}): ${issue.message}`,
        });
      }
    }
  });

  return { valid: issues.length === 0, errors: issues };
}
