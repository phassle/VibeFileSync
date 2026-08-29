// dynamic-qa/shared/scripts/drift-gate.mjs
//
// The deterministic drift gate (ticket #148, DESIGN-dynamic-qa-spec.md
// §5.5/§8 "The deterministic drift gate runs before tests ... `current` is
// mandatory for active Bindings. Product-code changes run impacted tests
// but do not alone create drift.", SPEC-135.md user stories 55-57). This
// module IS that gate: given one active Binding's Provenance Manifest
// record and a small set of freshly recomputed digests, it decides whether
// the Binding is `current` or `stale`, with an exact machine-checkable
// reason for every way it can be stale. It calls no model and no browser
// agent — it is pure comparison over already-computed digests, runnable in
// ordinary customer CI with nothing more than `node`.
//
// Reuse, not reinvention (run brief decision 5 / #146's landed note):
//   - Every digest compared here comes from canonical-digest.mjs's
//     `contentDigest`, the same function #143 introduced and #146 already
//     uses for Provenance Manifest records. This module never hashes
//     anything itself.
//   - Revision monotonicity is `provenance.mjs`'s `checkRevisionMonotonic`,
//     owned by #146 and exported for this exact reuse. Not reimplemented.
//   - The Provenance Manifest's own shape/ordering is `provenance.mjs`'s
//     `validateProvenanceManifest`. Not reimplemented.
//
// Why "unrelated product changes are not drift" holds STRUCTURALLY, not by
// convention: `evaluateBindingDrift` only ever compares digests for the
// exact closure of paths a Binding's own provenance record already names —
// its Flow Definition, its recorded Named Data Sets (by id), the two schema
// contracts it was validated against, its recorded harness config/lockfile
// paths, its recorded output files, and its named Execution Profile. An
// arbitrary product source file that is not one of those recorded inputs is
// never fed into this function at all, by any caller following this
// module's contract — there is no "scan everything and see what changed"
// code path here to get wrong. Impact paths (DESIGN-dynamic-qa-spec.md: "a
// conservative trigger hint, never proof") are a separate, later concern —
// which tests to *run* for a product-code change — not an input to drift.
//
// Why "a new bundle release alone is not drift" also holds structurally:
// `record.generator.bundleVersion` is never read or compared by this
// module. The only generator-identity fact this gate checks is whether the
// record's own shape is valid (via provenance.mjs, already fail-closed on
// an unsupported `generator.identity`) — a bundle version bump with no
// other change to a Binding's recorded inputs produces zero mismatches
// here, by construction.
//
// "Incompatible schema/generator/adapter contract mandates regeneration":
// modeled as a digest mismatch on `record.schemas.flow` / `record.schemas.
// data` (the customer's installed `qa/schemas/*.json` contract files,
// recomputed the same way #146 recorded them) — a real content change to
// the schema contract moves the digest; a cosmetic reformat of the JSON
// file does not, because `contentDigest` canonicalizes object key order.
// An optional `isFrameworkSupported` predicate lets a caller layer an
// adapter-contract compatibility check on top (see below); this ticket does
// not invent a concrete adapter registry — that is #149/#150 territory.
//
// "Direct edits to customer-owned tests are permitted but detected":
// modeled as its own reason code, `OUTPUT_EDITED`, kept distinct from a
// generic `OUTPUT_MISMATCH`. Both make the Binding stale (drift blocks
// until an explicit adoption or repair proposal verifies the edit and
// updates provenance — DESIGN-dynamic-qa-spec.md §5.5), but the *report*
// says "edited", never "rejected" or "overwritten" — this gate never
// deletes or silently regenerates anything, it only reports.

import { checkRevisionMonotonic } from "./provenance.mjs";

export const FRESHNESS_STATES = Object.freeze(["absent", "current", "stale"]);

export const DRIFT_REASON_CODES = Object.freeze([
  "MISSING_PROVENANCE",
  "REVISION_REGRESSION",
  "FLOW_DIGEST_MISMATCH",
  "DATA_SET_UNRESOLVED",
  "DATA_SET_MISMATCH",
  "SCHEMA_CONTRACT_CHANGED",
  "HARNESS_CONFIG_CHANGED",
  "LOCKFILE_CHANGED",
  "EXECUTION_PROFILE_CHANGED",
  "OUTPUT_MISSING",
  "OUTPUT_EDITED",
  "ADAPTER_CONTRACT_UNSUPPORTED",
]);

function findRecord(manifest, flowId) {
  return (manifest?.bindings ?? []).find((b) => b.flowId === flowId) ?? null;
}

function digestFor(list, key, value) {
  const entry = (list ?? []).find((e) => e && e[key] === value);
  return entry ? entry.digest : undefined;
}

/**
 * Compares one active Binding's Provenance Manifest record against a fresh
 * recomputation of exactly the inputs that record names, and decides
 * `absent` | `current` | `stale`.
 *
 * All digest inputs below MUST be recomputed only for the paths/ids the
 * record itself names (see the module header's "structurally" note) —
 * never for the whole repository:
 *
 *   - `flowDigest`: `contentDigest` of the current, parsed Flow Definition.
 *   - `dataSetDigests`: `[{ id, digest }]`, one entry per id in
 *     `record.dataSets`, `contentDigest` of each currently-resolved Named
 *     Data Set.
 *   - `schemaDigests`: `{ flow, data }`, `contentDigest` of the customer's
 *     currently-installed `qa/schemas/dynamic-qa-flow-v1.schema.json` and
 *     `dynamic-qa-data-v1.schema.json` (parsed JSON).
 *   - `harnessInputDigests`: `{ configPaths: [{path,digest}], lockfilePaths:
 *     [{path,digest}] }`, one entry per path the record names,
 *     `contentDigest` of each file's current text.
 *   - `outputDigests`: `[{ path, digest }]`, one entry per
 *     `record.outputs` path, `contentDigest` of each file's current text.
 *   - `executionProfileDigest`: `contentDigest` of the current, parsed
 *     Execution Profile the record's `executionProfile.id` names, or
 *     `undefined` when no Execution Profile artifact is available yet
 *     (this ticket does not require #150's artifact to exist to run — an
 *     absent input simply skips that one check, it never manufactures a
 *     mismatch out of nothing).
 *
 * `isFrameworkSupported`, when supplied, is called with `record.framework`
 * and must return `true`/`false`; a `false` result is reported as
 * `ADAPTER_CONTRACT_UNSUPPORTED`. Omit it to skip adapter-contract
 * compatibility checking entirely (no concrete adapter registry exists yet
 * in this bundle).
 *
 * Never throws. Returns:
 *   `{ flowId, freshness, edited, editedOutputs, reasons }` where `reasons`
 *   is always an array of `{ code, message }`, empty when `freshness` is
 *   `"current"`.
 */
export function evaluateBindingDrift({
  flowId,
  flowRevision,
  manifest,
  flowDigest,
  dataSetDigests = [],
  schemaDigests = {},
  harnessInputDigests = { configPaths: [], lockfilePaths: [] },
  outputDigests = [],
  executionProfileDigest,
  isFrameworkSupported,
} = {}) {
  const record = findRecord(manifest, flowId);

  if (!record) {
    return {
      flowId,
      freshness: "absent",
      edited: false,
      editedOutputs: [],
      reasons: [
        {
          code: "MISSING_PROVENANCE",
          message: `no current Provenance Manifest record for active Binding ${JSON.stringify(
            flowId,
          )} — an active Binding requires current provenance`,
        },
      ],
    };
  }

  const reasons = [];

  if (typeof flowRevision === "number") {
    const monotonic = checkRevisionMonotonic(manifest, flowId, flowRevision);
    if (!monotonic.ok) {
      reasons.push({
        code: "REVISION_REGRESSION",
        message: `flow revision ${flowRevision} regresses recorded revision ${monotonic.existingRevision} — revision must never regress`,
      });
    }
  }

  if (flowDigest !== undefined && record.flowDigest !== flowDigest) {
    reasons.push({
      code: "FLOW_DIGEST_MISMATCH",
      message: `Flow Definition changed since generation: recorded ${record.flowDigest}, current ${flowDigest}`,
    });
  }

  for (const recorded of record.dataSets ?? []) {
    const current = digestFor(dataSetDigests, "id", recorded.id);
    if (current === undefined) {
      reasons.push({
        code: "DATA_SET_UNRESOLVED",
        message: `recorded Named Data Set ${JSON.stringify(recorded.id)} could not be resolved for comparison`,
      });
    } else if (current !== recorded.digest) {
      reasons.push({
        code: "DATA_SET_MISMATCH",
        message: `Named Data Set ${JSON.stringify(recorded.id)} changed since generation: recorded ${recorded.digest}, current ${current}`,
      });
    }
  }

  if (schemaDigests.flow !== undefined && record.schemas?.flow !== schemaDigests.flow) {
    reasons.push({
      code: "SCHEMA_CONTRACT_CHANGED",
      message: `Flow Definition schema contract changed: recorded ${record.schemas?.flow}, current ${schemaDigests.flow} — an unsupported or incompatible schema mandates regeneration`,
    });
  }
  if (schemaDigests.data !== undefined && record.schemas?.data !== schemaDigests.data) {
    reasons.push({
      code: "SCHEMA_CONTRACT_CHANGED",
      message: `Named Data Set schema contract changed: recorded ${record.schemas?.data}, current ${schemaDigests.data} — an unsupported or incompatible schema mandates regeneration`,
    });
  }

  for (const recorded of record.harnessInputs?.configPaths ?? []) {
    const current = digestFor(harnessInputDigests.configPaths, "path", recorded.path);
    if (current === undefined || current !== recorded.digest) {
      reasons.push({
        code: "HARNESS_CONFIG_CHANGED",
        message: `harness config ${JSON.stringify(recorded.path)} changed since generation`,
      });
    }
  }
  for (const recorded of record.harnessInputs?.lockfilePaths ?? []) {
    const current = digestFor(harnessInputDigests.lockfilePaths, "path", recorded.path);
    if (current === undefined || current !== recorded.digest) {
      reasons.push({
        code: "LOCKFILE_CHANGED",
        message: `lockfile ${JSON.stringify(recorded.path)} changed since generation`,
      });
    }
  }

  if (executionProfileDigest !== undefined && record.executionProfile?.digest !== undefined) {
    if (record.executionProfile.digest !== executionProfileDigest) {
      reasons.push({
        code: "EXECUTION_PROFILE_CHANGED",
        message: `Execution Profile ${JSON.stringify(record.executionProfile.id)} changed since generation`,
      });
    }
  }

  if (typeof isFrameworkSupported === "function" && !isFrameworkSupported(record.framework)) {
    reasons.push({
      code: "ADAPTER_CONTRACT_UNSUPPORTED",
      message: `framework/adapter ${JSON.stringify(record.framework)} is not a supported contract — regeneration required`,
    });
  }

  const editedOutputs = [];
  for (const recorded of record.outputs ?? []) {
    const current = digestFor(outputDigests, "path", recorded.path);
    if (current === undefined) {
      reasons.push({
        code: "OUTPUT_MISSING",
        message: `recorded output ${JSON.stringify(recorded.path)} is missing`,
      });
    } else if (current !== recorded.digest) {
      editedOutputs.push(recorded.path);
    }
  }
  const edited = editedOutputs.length > 0;
  if (edited) {
    reasons.push({
      code: "OUTPUT_EDITED",
      message: `output(s) hand-edited since generation: ${editedOutputs.join(
        ", ",
      )} — edit detected and reported, not silently accepted or overwritten; drift blocks until an explicit adoption or repair proposal verifies the edit and updates provenance`,
    });
  }

  return {
    flowId,
    freshness: reasons.length === 0 ? "current" : "stale",
    edited,
    editedOutputs,
    reasons,
  };
}

/**
 * Evaluates every active Binding at once and separately flags retired
 * flows that still carry a provenance record (DESIGN-dynamic-qa-spec.md
 * §8: the drift gate validates "... retired-flow cleanup"). `bindings` is
 * an array of the per-flow input objects `evaluateBindingDrift` accepts
 * (each already carrying its own `flowId`, `flowRevision`, digests, etc.);
 * `manifest` is shared across all of them. `retiredFlowIds` is the set of
 * Flow IDs whose Flow State is `retired`.
 *
 * Returns `{ ok, results, retiredCleanup }`: `ok` is true only when every
 * active Binding is `current` and no retired flow still has a record.
 */
export function evaluatePortfolioDrift({ manifest, bindings = [], retiredFlowIds = [] }) {
  const results = bindings.map((b) => evaluateBindingDrift({ manifest, ...b }));

  const retiredCleanup = (manifest?.bindings ?? [])
    .filter((r) => retiredFlowIds.includes(r.flowId))
    .map((r) => ({
      flowId: r.flowId,
      code: "RETIRED_FLOW_PROVENANCE",
      message: `retired flow ${JSON.stringify(
        r.flowId,
      )} still has a Provenance Manifest record — remove it as part of retirement cleanup`,
    }));

  const ok = results.every((r) => r.freshness === "current") && retiredCleanup.length === 0;

  return { ok, results, retiredCleanup };
}
