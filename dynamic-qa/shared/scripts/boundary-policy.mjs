// dynamic-qa/shared/scripts/boundary-policy.mjs
//
// Policy layer on top of boundaries.mjs's shape validation (ticket #145,
// DESIGN-dynamic-qa-spec.md §5.1, SPEC-135 user stories 27-30). boundaries.mjs
// checks that each Boundary Declaration is well-formed; this module checks
// that the *set* of declarations is honest and honourable:
//
//   1. Exactly one boundary is the owned service/outcome under test
//      (`role: "owned"`), and it must stay `real` — a fake cannot prove
//      itself. Which boundary owns the outcome is a reviewed, human-authored
//      field, never a guess inferred from `system`/`behavior` text: matching
//      free text against keywords like "database" or "payment" is exactly
//      the kind of silent heuristic the run brief and #143 both reject for
//      product-language judgement calls, and it would let a rename of
//      `system` text silently flip which boundary is "the" outcome.
//   2. A `volatile` boundary (time, randomness, a third party, payments, or
//      any behaviour not yet verified — SPEC-135 story 29) can never be
//      declared `real`, so tests stay deterministic and side-effect free.
//      `volatile` is likewise a reviewed field, not a keyword match.
//   3. A `forbidden` boundary must be honourable: it may claim no side
//      effects. A "forbidden" declaration that also states real side
//      effects cannot be honoured and is refused outright, never silently
//      downgraded to `simulated`.
//   4. Undeclared external reach fails closed: resolveBoundaryTreatment
//      returns "forbidden" for any ID not present in the declared list —
//      never "real", never a silent pass-through.
//   5. A boundary with real side effects must declare per-run namespace
//      isolation and cleanup capability, so test order and interrupted
//      cleanup cannot corrupt later runs (SPEC-135 story 30).
//
// Every violation names the offending boundary ID and is a hard error, never
// a warning — consistent with flow-definition.mjs's Issues pattern, which
// this module's issues are shaped to compose with (each entry is
// { path, message }; callers merge them with `Issues#addAll` the same way
// flow-definition.mjs merges validateBoundaries' output).

import { BOUNDARY_TREATMENTS, validateBoundaries } from "./boundaries.mjs";

/**
 * Validates the cross-cutting policy over a flow's whole `boundaries` array.
 * Assumes each declaration's *shape* is already valid (callers should run
 * validateBoundaries first and stop on shape errors before calling this —
 * policy checks over a malformed declaration are not meaningful). Returns an
 * array of { path, message } issues, empty when the declarations are policy-
 * compliant. Never throws; collects every violation rather than stopping at
 * the first.
 */
export function validateBoundaryPolicy(boundaries, path) {
  const issues = [];
  const fail = (message, subpath = path) => issues.push({ path: subpath, message });

  if (!Array.isArray(boundaries)) {
    fail("boundaries must be a list");
    return issues;
  }

  // --- rule 1: exactly one owned outcome, and it must stay real ----------

  const owned = [];
  boundaries.forEach((boundary, index) => {
    if (boundary && typeof boundary === "object" && boundary.role === "owned") {
      owned.push({ boundary, index });
    }
  });

  if (owned.length === 0) {
    fail(
      "no boundary declares role: owned — a flow must explicitly name which single boundary is the owned service or outcome under test; this is never inferred from system/behavior text",
    );
  } else if (owned.length > 1) {
    for (const { boundary, index } of owned) {
      fail(
        `boundary ${JSON.stringify(boundary.id)} declares role: owned, but so does another boundary — exactly one owned outcome is permitted per flow`,
        [...path, index, "role"],
      );
    }
  } else {
    const { boundary, index } = owned[0];
    if (boundary.treatment !== "real") {
      fail(
        `boundary ${JSON.stringify(boundary.id)} is the owned outcome under test (role: owned) and cannot be declared ${JSON.stringify(boundary.treatment)} — a fake cannot prove itself, so the owned outcome must stay real at the cheapest safe layer`,
        [...path, index, "treatment"],
      );
    }
  }

  // --- rule 2: a volatile boundary can never be real ----------------------

  boundaries.forEach((boundary, index) => {
    if (!boundary || typeof boundary !== "object") return;
    if (boundary.volatile === true && boundary.treatment === "real") {
      fail(
        `boundary ${JSON.stringify(boundary.id)} is volatile (a third party, payments, time, randomness, or unverified behaviour) and cannot be declared real — declare it simulated or forbidden so tests stay deterministic and side-effect free`,
        [...path, index, "treatment"],
      );
    }
  });

  // --- rule 3: a forbidden boundary must be honourable --------------------

  boundaries.forEach((boundary, index) => {
    if (!boundary || typeof boundary !== "object") return;
    if (boundary.treatment !== "forbidden") return;
    const sideEffects = typeof boundary.side_effects === "string" ? boundary.side_effects.trim().toLowerCase() : "";
    if (sideEffects !== "none" && sideEffects !== "") {
      fail(
        `boundary ${JSON.stringify(boundary.id)} is declared forbidden but its side_effects state ${JSON.stringify(boundary.side_effects)} — a forbidden boundary must have no side effects; this declaration cannot be honoured and is refused rather than silently downgraded to simulated`,
        [...path, index, "side_effects"],
      );
    }
  });

  // --- rule 5: real side effects require namespace isolation + cleanup ---

  boundaries.forEach((boundary, index) => {
    if (!boundary || typeof boundary !== "object") return;
    if (boundary.treatment !== "real") return;
    const sideEffects = typeof boundary.side_effects === "string" ? boundary.side_effects.trim().toLowerCase() : "";
    if (sideEffects === "none" || sideEffects === "") return;

    const isolation = boundary.isolation;
    const hasNamespace =
      isolation && typeof isolation === "object" && typeof isolation.namespace === "string" && isolation.namespace.trim() !== "";
    const hasCleanup =
      isolation && typeof isolation === "object" && typeof isolation.cleanup === "string" && isolation.cleanup.trim() !== "";

    if (!hasNamespace || !hasCleanup) {
      fail(
        `boundary ${JSON.stringify(boundary.id)} has real side effects but does not declare isolation.namespace and isolation.cleanup — per-run namespace isolation with cleanup capability is required so test order and interrupted cleanup cannot corrupt later runs`,
        [...path, index, "isolation"],
      );
    }
  });

  return issues;
}

/**
 * Resolves the treatment for a boundary ID against a flow's declared
 * boundaries. Undeclared external reach fails closed: an ID not found in
 * `boundaries` resolves to `"forbidden"`, never `"real"` and never a silent
 * pass-through default. This is the one function anything that needs to ask
 * "is touching this boundary allowed?" (Binding generation, an Execution
 * Profile check, a later drift gate) should call, rather than reimplementing
 * a lookup-with-fallback of its own.
 */
export function resolveBoundaryTreatment(boundaryId, boundaries) {
  if (!Array.isArray(boundaries)) return "forbidden";
  const found = boundaries.find((b) => b && typeof b === "object" && b.id === boundaryId);
  if (!found || !BOUNDARY_TREATMENTS.includes(found.treatment)) return "forbidden";
  return found.treatment;
}

/**
 * Convenience: shape (validateBoundaries) then policy (validateBoundaryPolicy),
 * in that order, matching the "shape errors first" assumption above. Returns
 * the concatenation of both issue lists — shape issues, then policy issues.
 * Most callers that already run validateBoundaries as part of a larger Flow
 * Definition validation should call validateBoundaryPolicy directly instead
 * of this, to avoid double-reporting shape issues; this export exists for
 * standalone use (e.g. this module's own tests, or a future CLI check that
 * takes just a boundaries array with no surrounding Flow Definition).
 */
export function validateBoundariesFull(boundaries, path) {
  const shapeIssues = validateBoundaries(boundaries, path);
  if (shapeIssues.length > 0) return shapeIssues;
  return validateBoundaryPolicy(boundaries, path);
}
