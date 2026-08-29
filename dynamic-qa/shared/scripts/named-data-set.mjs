// dynamic-qa/shared/scripts/named-data-set.mjs
//
// Fail-closed validator for the Named Data Set v1 contract
// (dynamic-qa/shared/schemas/dynamic-qa-data-v1.schema.json,
// DESIGN-dynamic-qa-spec.md §5.2, SPEC-135.md user stories 25-26). Named
// Data Sets hold the cases a Flow runs against, kept separate from Flow
// intent so cases stay reusable across flows and environments.
//
// This module follows flow-definition.mjs's validation pattern exactly
// (ticket #143's Issues-collecting shape): `validateNamedDataSet(data)`
// returns EVERY issue found as `{ path, message }` entries in one array — it
// never throws for a schema violation and never stops at the first problem.
// `parseNamedDataSetFile(source, { filename })` combines restricted-YAML
// parsing with schema validation and the filename===id invariant, mirroring
// `parseFlowDefinitionFile`. Fail-closed YAML syntax problems (aliases,
// anchors, custom tags, duplicate keys, block scalars, flow collections,
// tabs) are inherited unchanged from restricted-yaml.mjs — this module adds
// no YAML-level rule of its own, only schema-level ones.
//
// The hard rule this module exists to enforce: no secret *values*. A field
// may name an approved secret *handle* (`{ secret_handle: "<name>" }`)
// without the value ever appearing in the repository. Secret values,
// selectors, URLs, commands, and adapter configuration are refused with an
// exact reason naming the offending path — those belong to the Binding or
// the Execution Profile, not to QA-owned data.
//
//   - Structural prohibitions (a field literally named for a URL, selector,
//     command, or adapter setting; a scalar value shaped like a URI) are
//     EXACT: a fixed denylist and an unambiguous "scheme://" syntax check,
//     not a guess about intent.
//   - Secret-value detection is layered on secret-detection.mjs, which is
//     explicit in its own header comment about which of its rules are exact
//     and which are necessarily heuristic. This module does not re-decide
//     that split; it just applies the detector to every scalar field value
//     and every secret_handle name (a handle should be a name, never itself
//     shaped like the secret it stands in for).
//
// EXTENSION SEAM: this module deliberately does not check whether a data set
// is actually referenced by any Flow, or resolve a Flow's `data_sets`
// references to files on disk — that cross-file concern is
// resolve-data-sets.mjs, layered on top of this module and
// data-set-refs.mjs, so #145/#146 can reuse the same resolution step rather
// than reimplementing "read qa/data/<id>.yaml, parse it, validate it".

import { parseRestrictedYAML, YamlSyntaxError } from "./restricted-yaml.mjs";
import { isValidSemanticId } from "./id-rules.mjs";
import { detectSecretValue } from "./secret-detection.mjs";

export const SUPPORTED_SCHEMA = "dynamic-qa-data-v1";

const ROOT_KEYS = new Set(["schema", "id", "revision", "cases"]);
const CASE_KEYS = new Set(["id", "fields"]);

const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Reserved field names: a Named Data Set carries reusable, environment-
// neutral case data only. A field with one of these names is, by
// definition, out of place here — it belongs to the Binding (selectors,
// commands) or the Execution Profile (URLs/endpoints, adapter
// configuration). This is a fixed, exact denylist, not a heuristic guess:
// any name on it is rejected regardless of the value it holds.
const RESERVED_FIELD_CATEGORIES = [
  {
    category: "a selector",
    names: new Set(["selector", "selectors", "css_selector", "xpath", "locator", "query_selector"]),
  },
  {
    category: "a URL",
    names: new Set(["url", "urls", "uri", "endpoint", "endpoints", "route", "routes", "base_url"]),
  },
  {
    category: "a command",
    names: new Set(["command", "commands", "cmd", "shell", "exec", "script"]),
  },
  {
    category: "adapter configuration",
    names: new Set(["adapter", "adapter_config", "config", "settings", "provider_config", "profile"]),
  },
];

// scheme://... — an unambiguous URI syntax check, not a heuristic. Matches
// http(s), but also ftp/ssh/postgres/mongodb/etc. — any URI-shaped value is
// out of place in a Named Data Set regardless of scheme.
const URL_SHAPE_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function pathStr(path) {
  if (!path || path.length === 0) return "$";
  let out = "$";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return out;
}

// Local Issues-collecting helper, matching flow-definition.mjs's pattern
// (that class is not exported there either — data-set-refs.mjs and
// boundaries.mjs follow the same convention of a small local collector
// rather than a shared import, so this module does too).
class Issues {
  constructor() {
    this.list = [];
  }
  add(path, message) {
    this.list.push({ path, message: `${message} (at ${pathStr(path)})` });
  }
  addAll(issues) {
    for (const issue of issues) this.add(issue.path, issue.message);
  }
}

function assertKnownKeys(obj, allowed, path, issues) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      issues.add([...path, key], `unknown key ${JSON.stringify(key)}`);
    }
  }
}

function reservedFieldCategory(fieldName) {
  for (const { category, names } of RESERVED_FIELD_CATEGORIES) {
    if (names.has(fieldName)) return category;
  }
  return null;
}

function validateFieldValue(fieldName, value, path, issues) {
  const reserved = reservedFieldCategory(fieldName);
  if (reserved) {
    issues.add(
      path,
      `field name ${JSON.stringify(fieldName)} is reserved for ${reserved}, which belongs to the Binding or Execution Profile, not a Named Data Set`,
    );
    return;
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return; // non-secret, non-structural scalar — always allowed
  }

  if (typeof value === "string") {
    const secretReason = detectSecretValue(value);
    if (secretReason) {
      issues.add(path, `secret value forbidden: ${secretReason}`);
      return;
    }
    if (URL_SHAPE_RE.test(value.trim())) {
      issues.add(
        path,
        `URL value forbidden (exact match on "scheme://" syntax) — URLs belong to the Binding or Execution Profile, not a Named Data Set`,
      );
    }
    return;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "secret_handle") {
      issues.add(
        path,
        `a field value must be a non-secret scalar or a { secret_handle } reference, not an arbitrary mapping (got keys ${JSON.stringify(keys)}) — adapter configuration does not belong in a Named Data Set`,
      );
      return;
    }
    const handle = value.secret_handle;
    if (!nonEmptyString(handle)) {
      issues.add([...path, "secret_handle"], "secret_handle must be a non-empty string naming an approved secret handle");
      return;
    }
    const handleSecretReason = detectSecretValue(handle);
    if (handleSecretReason) {
      issues.add(
        [...path, "secret_handle"],
        `secret_handle must name a handle, never contain the secret value itself: ${handleSecretReason}`,
      );
    }
    return;
  }

  issues.add(
    path,
    `a field value must be a non-secret scalar or a { secret_handle } reference (got ${Array.isArray(value) ? "an array" : typeof value})`,
  );
}

function validateFields(fields, path, issues) {
  if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
    issues.add(path, "fields must be a non-empty mapping of field name to value");
    return;
  }
  for (const [fieldName, value] of Object.entries(fields)) {
    const fieldPath = [...path, fieldName];
    if (!FIELD_NAME_RE.test(fieldName)) {
      issues.add(
        fieldPath,
        `field name ${JSON.stringify(fieldName)} must match ${FIELD_NAME_RE} so it can be used as "\${case.${fieldName}}"`,
      );
      continue;
    }
    validateFieldValue(fieldName, value, fieldPath, issues);
  }
}

function validateCase(caseData, path, issues, seenCaseIds) {
  if (!isPlainObject(caseData)) {
    issues.add(path, "a case must be a mapping");
    return;
  }
  assertKnownKeys(caseData, CASE_KEYS, path, issues);

  if (!isValidSemanticId(caseData.id)) {
    issues.add([...path, "id"], "id must be a stable semantic identifier");
  } else if (seenCaseIds.has(caseData.id)) {
    issues.add([...path, "id"], `duplicate case id ${JSON.stringify(caseData.id)} elsewhere in this data set`);
  } else {
    seenCaseIds.add(caseData.id);
  }

  validateFields(caseData.fields, [...path, "fields"], issues);
}

/**
 * Validates an already-parsed Named Data Set JS value against the v1
 * contract. Returns { valid, errors }. `errors` is always an array of
 * { path, message } (empty when valid) — every issue found is reported, not
 * just the first, and a rejection is always data, never a warning.
 */
export function validateNamedDataSet(data, { expectedId } = {}) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Named Data Set document must be a mapping");
    return { valid: false, errors: issues.list };
  }

  assertKnownKeys(data, ROOT_KEYS, [], issues);

  if (data.schema !== SUPPORTED_SCHEMA) {
    issues.add(
      ["schema"],
      `unsupported schema version ${JSON.stringify(data.schema)} — this validator only accepts ${JSON.stringify(SUPPORTED_SCHEMA)}`,
    );
  }

  if (!isValidSemanticId(data.id)) {
    issues.add(["id"], "id must be an immutable semantic identifier, never derived from an issue number");
  } else if (expectedId !== undefined && data.id !== expectedId) {
    issues.add(
      ["id"],
      `id ${JSON.stringify(data.id)} does not match its filename ${JSON.stringify(expectedId)} — the filename must equal the immutable data-set ID`,
    );
  }

  if (!(Number.isInteger(data.revision) && data.revision >= 1)) {
    issues.add(["revision"], "revision must be a monotonically increasing integer starting at 1");
  }

  if (!Array.isArray(data.cases) || data.cases.length === 0) {
    issues.add(["cases"], "cases must be a non-empty list of named cases");
  } else {
    const seenCaseIds = new Set();
    data.cases.forEach((caseData, i) => {
      validateCase(caseData, ["cases", i], issues, seenCaseIds);
    });
  }

  return { valid: issues.list.length === 0, errors: issues.list };
}

/**
 * Parses restricted-YAML `source`, then validates the result against the v1
 * contract. `filename`, when given, must be the data-set file's basename
 * without extension (equal to the immutable data-set ID) — a mismatch is a
 * validation error, not a warning. Fail-closed YAML syntax problems surface
 * as a thrown YamlSyntaxError, exactly as parseRestrictedYAML raises them.
 */
export function parseNamedDataSetFile(source, { filename } = {}) {
  const data = parseRestrictedYAML(source, { filename });
  return validateNamedDataSet(data, { expectedId: filename });
}

export { YamlSyntaxError };
