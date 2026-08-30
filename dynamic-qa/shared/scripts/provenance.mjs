// dynamic-qa/shared/scripts/provenance.mjs
//
// Fail-closed construction, validation, and deterministic ordering for the
// Provenance Manifest v1 contract (dynamic-qa/shared/schemas/
// dynamic-qa-provenance-v1.schema.json, DESIGN-dynamic-qa-spec.md §5.5,
// SPEC-135.md user story 54). The customer file `<repository>/qa/
// provenance.json` is strict, versioned, and — this module's whole reason
// to exist — deterministically ordered: re-running generation against the
// exact same inputs must produce byte-identical output, so a reviewer's
// diff shows only what actually changed.
//
// Determinism is guaranteed two ways, both enforced here rather than left
// to caller discipline:
//   1. Fixed key order. `buildBindingRecord` always emits its record's keys
//      in the same declared order (RECORD_KEY_ORDER below), regardless of
//      the order fields were supplied in, because JS objects preserve
//      insertion order for string keys and JSON.stringify follows that
//      order.
//   2. Fixed collection order. `canonicalizeProvenanceManifest` sorts every
//      order-insignificant collection — bindings by flowId, each binding's
//      dataSets by id, outputs by path, impactPaths lexicographically,
//      configPaths/lockfilePaths by path — before serialization.
//      `validateProvenanceManifest` then treats an out-of-order collection
//      as a fail-closed validation error, not silently re-sorted input, so
//      "deterministically ordered" is a checked invariant of the artifact
//      itself, not just a habit of this module's own writer.
//
// Digest reuse (run brief decision 5 / #143's landed note): every digest in
// a record is produced by canonical-digest.mjs's `contentDigest`, the same
// function #143 introduced for Flow Definition digests. No second digest
// scheme is invented here.
//
// Cross-revision monotonicity (`checkRevisionMonotonic`): #143 explicitly
// left "monotonic non-decrease across revisions" to "the provenance/drift-
// gate ticket (#146/#148)". This ticket (#146) claims it: a flow's revision
// may never regress against what provenance already recorded for that flow
// ID. `checkRevisionMonotonic` is exported so #148's drift gate reuses this
// exact check rather than reimplementing it — see DECISIONS.md for the
// full rationale.

import { contentDigest } from "./canonical-digest.mjs";

export const SUPPORTED_SCHEMA = "dynamic-qa-provenance-v1";

export const ENFORCEMENT_LANES = Object.freeze(["advisory", "required"]);
export const GENERATOR_IDENTITIES = Object.freeze(["generated", "adopted"]);

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
    if (!allowed.has(key)) issues.add([...path, key], `unknown key ${JSON.stringify(key)}`);
  }
}

// --- fixed key order for a binding record ---------------------------------

const RECORD_KEY_ORDER = [
  "flowId",
  "flowRevision",
  "flowDigest",
  "originTickets",
  "dataSets",
  "schemas",
  "testLevel",
  "sourceCommit",
  "generator",
  "framework",
  "harnessInputs",
  "outputs",
  "impactPaths",
  "enforcementLane",
  "executionProfile",
];

const MANIFEST_KEY_ORDER = ["schema", "generatedAt", "bindings"];

function orderKeys(obj, order) {
  const out = {};
  for (const key of order) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

function sortByKey(list, keyFn) {
  return [...list].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function isSortedByKey(list, keyFn) {
  for (let i = 1; i < list.length; i += 1) {
    if (keyFn(list[i - 1]) > keyFn(list[i])) return false;
  }
  return true;
}

// --- building one binding record -------------------------------------------

/**
 * Builds one Provenance Manifest binding record for a single generated or
 * adopted Binding, with a fixed, deterministic key order. Does not itself
 * write anything — `insertOrUpdateBindingRecord` merges this into a full
 * manifest, and `serializeProvenanceManifest` renders the final bytes.
 *
 * Digests are computed here (flowDigest, each data set's digest) by reusing
 * canonical-digest.mjs directly over the already-validated data models the
 * caller passes in — never over raw YAML text or formatting, and never via
 * a second hashing scheme.
 */
export function buildBindingRecord({
  flowData,
  dataSets = [],
  schemaDigests,
  sourceCommit,
  generator,
  framework,
  harnessInputs = { configPaths: [], lockfilePaths: [] },
  outputs = [],
  impactPaths = [],
  enforcementLane,
  executionProfile,
  testLevel,
}) {
  const record = {
    flowId: flowData.id,
    flowRevision: flowData.revision,
    flowDigest: contentDigest(flowData),
    originTickets: [...flowData.origin.tickets].sort(),
    dataSets: sortByKey(
      dataSets.map(({ id, data }) => ({ id, digest: contentDigest(data) })),
      (d) => d.id,
    ),
    schemas: { flow: schemaDigests.flow, data: schemaDigests.data },
    testLevel: testLevel ?? flowData.test_level,
    sourceCommit,
    generator,
    framework,
    harnessInputs: {
      configPaths: sortByKey(harnessInputs.configPaths ?? [], (p) => p.path),
      lockfilePaths: sortByKey(harnessInputs.lockfilePaths ?? [], (p) => p.path),
    },
    outputs: sortByKey(outputs, (o) => o.path),
    impactPaths: [...impactPaths].sort(),
    enforcementLane,
    executionProfile,
  };
  return orderKeys(record, RECORD_KEY_ORDER);
}

/**
 * Re-orders an already-built manifest (or a manifest assembled by hand, e.g.
 * in a test fixture) into the one canonical shape: fixed top-level and
 * record key order, every order-insignificant collection sorted. Used by
 * `serializeProvenanceManifest` before writing, and safe to call on any
 * manifest that already passed `validateProvenanceManifest`.
 */
export function canonicalizeProvenanceManifest(manifest) {
  const bindings = sortByKey(manifest.bindings ?? [], (b) => b.flowId).map((record) => {
    const ordered = orderKeys(record, RECORD_KEY_ORDER);
    ordered.originTickets = [...(ordered.originTickets ?? [])].sort();
    ordered.dataSets = sortByKey(ordered.dataSets ?? [], (d) => d.id);
    ordered.impactPaths = [...(ordered.impactPaths ?? [])].sort();
    if (ordered.harnessInputs) {
      ordered.harnessInputs = {
        configPaths: sortByKey(ordered.harnessInputs.configPaths ?? [], (p) => p.path),
        lockfilePaths: sortByKey(ordered.harnessInputs.lockfilePaths ?? [], (p) => p.path),
      };
    }
    ordered.outputs = sortByKey(ordered.outputs ?? [], (o) => o.path);
    return ordered;
  });
  return orderKeys({ ...manifest, bindings }, MANIFEST_KEY_ORDER);
}

/**
 * Inserts or replaces one flow's binding record in a manifest, keeping the
 * result sorted (idempotent: generating the same flow again replaces its
 * one record rather than appending a duplicate). `manifest` may be
 * `null`/`undefined` to start a fresh one. `generatedAt` must be caller-
 * supplied (an injected clock, per the bundle's own anti-flakiness/
 * determinism rule) — this module never calls `Date.now()` or `new Date()`
 * itself, so the same inputs always produce the same bytes.
 */
export function insertOrUpdateBindingRecord(manifest, record, { generatedAt }) {
  const base = manifest ?? { schema: SUPPORTED_SCHEMA, generatedAt, bindings: [] };
  const withoutExisting = (base.bindings ?? []).filter((b) => b.flowId !== record.flowId);
  return canonicalizeProvenanceManifest({
    schema: SUPPORTED_SCHEMA,
    generatedAt,
    bindings: [...withoutExisting, record],
  });
}

/**
 * Renders the final, deterministic bytes for `qa/provenance.json`: the
 * manifest is canonicalized first (fixed key order, every collection
 * sorted), then serialized with a stable 2-space indent and a trailing
 * newline. Two calls with the same logical content always produce identical
 * bytes, regardless of the order fields or records were assembled in.
 */
export function serializeProvenanceManifest(manifest) {
  return `${JSON.stringify(canonicalizeProvenanceManifest(manifest), null, 2)}\n`;
}

/**
 * `revision` monotonic non-decrease across revisions, claimed by #146 per
 * #143's note leaving it to "#146/#148". Returns `{ ok, existingRevision }`:
 * `ok` is true when no record for `flowId` exists yet, or when the existing
 * record's `flowRevision` is <= `newRevision`. #148's drift gate should call
 * this directly rather than reimplementing the lookup.
 */
export function checkRevisionMonotonic(manifest, flowId, newRevision) {
  const existing = (manifest?.bindings ?? []).find((b) => b.flowId === flowId);
  if (!existing) return { ok: true, existingRevision: null };
  return { ok: existing.flowRevision <= newRevision, existingRevision: existing.flowRevision };
}

// --- validation --------------------------------------------------------

function validateGenerator(generator, path, issues) {
  if (!isPlainObject(generator)) {
    issues.add(path, "generator must be a mapping");
    return;
  }
  assertKnownKeys(
    generator,
    new Set(["identity", "bundleVersion", "contentDigest", "harness", "adoptedFrom"]),
    path,
    issues,
  );
  if (!GENERATOR_IDENTITIES.includes(generator.identity)) {
    issues.add(
      [...path, "identity"],
      `identity must be one of ${GENERATOR_IDENTITIES.join(" | ")} (got ${JSON.stringify(generator.identity)})`,
    );
  }
  if (!nonEmptyString(generator.bundleVersion)) issues.add([...path, "bundleVersion"], "bundleVersion must be a non-empty string");
  if (!nonEmptyString(generator.contentDigest)) issues.add([...path, "contentDigest"], "contentDigest must be a non-empty string");
  if (generator.identity === "generated" && !nonEmptyString(generator.harness)) {
    issues.add([...path, "harness"], "a generated Binding must name the coding harness/model used for authoring");
  }
  if (generator.identity === "adopted" && !nonEmptyString(generator.adoptedFrom)) {
    issues.add([...path, "adoptedFrom"], "an adopted Binding must name the pre-existing test it was adopted from");
  }
}

function validateDigestPathList(list, path, issues, { requireDigest = true } = {}) {
  if (!Array.isArray(list)) {
    issues.add(path, "must be a list");
    return;
  }
  list.forEach((entry, i) => {
    const entryPath = [...path, i];
    if (!isPlainObject(entry)) {
      issues.add(entryPath, "each entry must be a mapping");
      return;
    }
    const allowed = requireDigest ? new Set(["path", "digest"]) : new Set(["path", "digest"]);
    assertKnownKeys(entry, allowed, entryPath, issues);
    if (!nonEmptyString(entry.path)) issues.add([...entryPath, "path"], "path must be a non-empty string");
    if (requireDigest && !nonEmptyString(entry.digest)) issues.add([...entryPath, "digest"], "digest must be a non-empty string");
  });
  if (!isSortedByKey(list, (e) => e && e.path)) {
    issues.add(path, "entries must be sorted lexicographically by path — provenance is deterministically ordered");
  }
}

function validateBindingRecord(record, path, issues) {
  if (!isPlainObject(record)) {
    issues.add(path, "a binding record must be a mapping");
    return;
  }
  assertKnownKeys(record, new Set(RECORD_KEY_ORDER), path, issues);

  if (!nonEmptyString(record.flowId)) issues.add([...path, "flowId"], "flowId must be a non-empty string");
  if (!(Number.isInteger(record.flowRevision) && record.flowRevision >= 1)) {
    issues.add([...path, "flowRevision"], "flowRevision must be a positive integer");
  }
  if (!nonEmptyString(record.flowDigest)) issues.add([...path, "flowDigest"], "flowDigest must be a non-empty string");

  if (!Array.isArray(record.originTickets) || record.originTickets.length === 0) {
    issues.add([...path, "originTickets"], "originTickets must be a non-empty list");
  } else if (!isSortedByKey(record.originTickets, (t) => t)) {
    issues.add([...path, "originTickets"], "originTickets must be sorted");
  }

  if (!Array.isArray(record.dataSets)) {
    issues.add([...path, "dataSets"], "dataSets must be a list");
  } else {
    record.dataSets.forEach((ds, i) => {
      const dsPath = [...path, "dataSets", i];
      if (!isPlainObject(ds)) {
        issues.add(dsPath, "each data set entry must be a mapping");
        return;
      }
      assertKnownKeys(ds, new Set(["id", "digest"]), dsPath, issues);
      if (!nonEmptyString(ds.id)) issues.add([...dsPath, "id"], "id must be a non-empty string");
      if (!nonEmptyString(ds.digest)) issues.add([...dsPath, "digest"], "digest must be a non-empty string");
    });
    if (!isSortedByKey(record.dataSets, (d) => d && d.id)) {
      issues.add([...path, "dataSets"], "dataSets must be sorted by id — provenance is deterministically ordered");
    }
  }

  if (!isPlainObject(record.schemas)) {
    issues.add([...path, "schemas"], "schemas must be a mapping");
  } else {
    assertKnownKeys(record.schemas, new Set(["flow", "data"]), [...path, "schemas"], issues);
    if (!nonEmptyString(record.schemas.flow)) issues.add([...path, "schemas", "flow"], "schemas.flow must be a non-empty digest");
    if (!nonEmptyString(record.schemas.data)) issues.add([...path, "schemas", "data"], "schemas.data must be a non-empty digest");
  }

  if (!isPlainObject(record.testLevel) || !nonEmptyString(record.testLevel.selection)) {
    issues.add([...path, "testLevel"], "testLevel must record the selected level and its selection rationale");
  }

  if (!nonEmptyString(record.sourceCommit) || !/^[0-9a-f]{40}$/.test(record.sourceCommit)) {
    issues.add([...path, "sourceCommit"], "sourceCommit must be a full 40-character commit SHA");
  }

  validateGenerator(record.generator, [...path, "generator"], issues);

  if (!isPlainObject(record.framework) || !nonEmptyString(record.framework.name) || !nonEmptyString(record.framework.version)) {
    issues.add([...path, "framework"], "framework must record at least name and version");
  }

  if (!isPlainObject(record.harnessInputs)) {
    issues.add([...path, "harnessInputs"], "harnessInputs must be a mapping");
  } else {
    assertKnownKeys(record.harnessInputs, new Set(["configPaths", "lockfilePaths"]), [...path, "harnessInputs"], issues);
    validateDigestPathList(record.harnessInputs.configPaths ?? [], [...path, "harnessInputs", "configPaths"], issues);
    validateDigestPathList(record.harnessInputs.lockfilePaths ?? [], [...path, "harnessInputs", "lockfilePaths"], issues);
  }

  validateDigestPathList(record.outputs ?? [], [...path, "outputs"], issues);
  if (!Array.isArray(record.outputs) || record.outputs.length === 0) {
    issues.add([...path, "outputs"], "outputs must be a non-empty list — a Binding with no output files proves nothing");
  }

  if (!Array.isArray(record.impactPaths)) {
    issues.add([...path, "impactPaths"], "impactPaths must be a list");
  } else if (!isSortedByKey(record.impactPaths, (p) => p)) {
    issues.add([...path, "impactPaths"], "impactPaths must be sorted — provenance is deterministically ordered");
  }

  if (!ENFORCEMENT_LANES.includes(record.enforcementLane)) {
    issues.add(
      [...path, "enforcementLane"],
      `enforcementLane must be one of ${ENFORCEMENT_LANES.join(" | ")} (got ${JSON.stringify(record.enforcementLane)})`,
    );
  }

  if (!isPlainObject(record.executionProfile) || !nonEmptyString(record.executionProfile.id)) {
    issues.add([...path, "executionProfile"], "executionProfile.id must reference a concrete Execution Profile by id");
  }
}

/**
 * Fail-closed validator for the whole Provenance Manifest v1 contract.
 * Follows flow-definition.mjs's pattern exactly: returns EVERY issue found
 * as `{ path, message }`, never throws, never stops at the first problem.
 * Deterministic ordering is validated here, not merely produced by this
 * module's own writer — an out-of-order collection is a hard error.
 */
export function validateProvenanceManifest(data) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Provenance Manifest document must be a mapping");
    return { valid: false, errors: issues.list };
  }

  assertKnownKeys(data, new Set(MANIFEST_KEY_ORDER), [], issues);

  if (data.schema !== SUPPORTED_SCHEMA) {
    issues.add(
      ["schema"],
      `unsupported schema version ${JSON.stringify(data.schema)} — this validator only accepts ${JSON.stringify(SUPPORTED_SCHEMA)}`,
    );
  }

  if (!nonEmptyString(data.generatedAt)) {
    issues.add(["generatedAt"], "generatedAt must be a non-empty timestamp string");
  }

  if (!Array.isArray(data.bindings)) {
    issues.add(["bindings"], "bindings must be a list");
  } else {
    data.bindings.forEach((record, i) => validateBindingRecord(record, ["bindings", i], issues));
    const flowIds = data.bindings.filter((b) => b && typeof b === "object").map((b) => b.flowId);
    if (new Set(flowIds).size !== flowIds.length) {
      issues.add(["bindings"], "each flowId may appear at most once — a Binding's provenance record is replaced, not duplicated");
    }
    if (!isSortedByKey(data.bindings, (b) => b && b.flowId)) {
      issues.add(["bindings"], "bindings must be sorted by flowId — provenance is deterministically ordered");
    }
  }

  return { valid: issues.list.length === 0, errors: issues.list };
}
