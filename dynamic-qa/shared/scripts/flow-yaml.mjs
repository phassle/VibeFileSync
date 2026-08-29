// dynamic-qa/shared/scripts/flow-yaml.mjs
//
// Renders a validated Flow Definition JS value back into the restricted
// YAML subset restricted-yaml.mjs parses (ticket #143). This exists for
// ticket #164 stage 5's "exact YAML Flow Review" (SPEC-135.md story 37): the
// QA Owner reviews the literal source-of-truth contract they are about to
// approve, so the interview's assembled result must be rendered as text, not
// just held as a JS object.
//
// This is deliberately NOT a general-purpose YAML writer. It only emits the
// restricted subset restricted-yaml.mjs accepts (block mappings/sequences,
// always-quoted scalar strings, bare numbers/booleans/null, "[]"/"{}" for
// empty collections — no block scalars, no flow collections, no anchors) so
// that round-tripping through parseRestrictedYAML + validateFlowDefinition
// is guaranteed to succeed and to reproduce the same canonical digest
// (canonical-digest.mjs sorts keys recursively, so key order here is chosen
// for human readability, matching the schema's documented field order, and
// has no effect on the digest).

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function pad(n) {
  return " ".repeat(n);
}

function renderQuotedString(value) {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function renderScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return renderQuotedString(value);
  throw new Error(`flow-yaml: cannot render a scalar of type ${typeof value}`);
}

function definedEntries(obj) {
  return Object.entries(obj).filter(([, v]) => v !== undefined);
}

function renderMappingLines(obj, indent) {
  const lines = [];
  for (const [key, value] of definedEntries(obj)) {
    if (isScalar(value)) {
      lines.push(`${pad(indent)}${key}: ${renderScalar(value)}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad(indent)}${key}: []`);
      } else {
        lines.push(`${pad(indent)}${key}:`);
        lines.push(...renderSequenceLines(value, indent + 2));
      }
    } else if (isPlainObject(value)) {
      if (definedEntries(value).length === 0) {
        lines.push(`${pad(indent)}${key}: {}`);
      } else {
        lines.push(`${pad(indent)}${key}:`);
        lines.push(...renderMappingLines(value, indent + 2));
      }
    } else {
      throw new Error(`flow-yaml: cannot render value for key "${key}"`);
    }
  }
  return lines;
}

function renderSequenceLines(arr, indent) {
  const lines = [];
  for (const item of arr) {
    if (isScalar(item)) {
      lines.push(`${pad(indent)}- ${renderScalar(item)}`);
      continue;
    }
    if (Array.isArray(item)) {
      throw new Error("flow-yaml: a sequence item that is itself a sequence is not supported");
    }
    if (isPlainObject(item)) {
      const entries = definedEntries(item);
      if (entries.length === 0) {
        lines.push(`${pad(indent)}- {}`);
        continue;
      }
      const bodyLines = renderMappingLines(item, indent + 2);
      const [firstLine, ...restLines] = bodyLines;
      // firstLine currently reads `${pad(indent + 2)}key: value` — replace
      // the leading indent + 2 spaces with "- " (2 characters) so the
      // remaining content lines up at itemIndent = indent + 2, matching
      // restricted-yaml.mjs's parseSequence's "- key: value" mapping-item
      // rule exactly.
      lines.push(`${pad(indent)}- ${firstLine.slice(indent + 2)}`);
      lines.push(...restLines);
      continue;
    }
    throw new Error("flow-yaml: cannot render sequence item");
  }
  return lines;
}

/**
 * Renders `flow` (a plain JS object already shaped like a Flow Definition —
 * typically the output of flow-assembly.mjs's assembleFlowDefinition) as
 * restricted-YAML text. Does not validate `flow` itself; callers should
 * validate before rendering (or use flow-assembly.mjs's assembleAndRender,
 * which does both and proves the round trip).
 */
export function renderFlowDefinitionYAML(flow) {
  if (!isPlainObject(flow)) {
    throw new Error("renderFlowDefinitionYAML requires a plain object");
  }
  return `${renderMappingLines(flow, 0).join("\n")}\n`;
}
