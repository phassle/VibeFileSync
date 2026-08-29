// dynamic-qa/shared/scripts/boundaries.mjs
//
// Structural validation for a Flow Definition's inline `boundaries` field
// (DESIGN-dynamic-qa-spec.md §5.1: "boundaries, each with stable ID, system,
// real | simulated | forbidden treatment, tech-neutral behavior, and
// side-effect policy").
//
// EXTENSION SEAM for #145 (Boundary Declarations): this module only checks
// *shape* — a well-formed, stable-ID, one-of-three-treatments declaration.
// It deliberately does NOT enforce the deeper policy #145 owns: that the
// flow's own owned outcome can never be declared `simulated`, that
// undeclared external reach fails closed rather than defaulting to `real`,
// or that a flow whose declarations cannot be honoured against an Execution
// Profile is refused. #145 is expected to import `validateBoundaryDeclaration`
// / `validateBoundaries` from here and layer its cross-cutting policy checks
// on top (e.g. by calling this module first, then walking the returned
// boundaries alongside the flow's steps/outcomes and the Execution Profile),
// rather than re-implementing or forking the shape check.

import { isValidSemanticId } from "./id-rules.mjs";

export const BOUNDARY_TREATMENTS = Object.freeze(["real", "simulated", "forbidden"]);

const ALLOWED_KEYS = new Set(["id", "system", "treatment", "behavior", "side_effects"]);

/**
 * Validates one boundary declaration's shape. Returns an array of
 * { path, message } issues (empty when valid). Never throws — callers
 * collect issues from every boundary before deciding whether the flow is
 * valid, so a fixture with three problems reports all three.
 */
export function validateBoundaryDeclaration(boundary, path) {
  const issues = [];
  const fail = (message, subpath = path) => issues.push({ path: subpath, message });

  if (boundary === null || typeof boundary !== "object" || Array.isArray(boundary)) {
    fail("a boundary declaration must be a mapping");
    return issues;
  }

  for (const key of Object.keys(boundary)) {
    if (!ALLOWED_KEYS.has(key)) {
      fail(`unknown key ${JSON.stringify(key)}`, [...path, key]);
    }
  }

  if (!isValidSemanticId(boundary.id)) {
    fail("id must be a stable semantic identifier", [...path, "id"]);
  }
  if (typeof boundary.system !== "string" || boundary.system.trim() === "") {
    fail("system must be a non-empty, tech-neutral description of the crossed dependency", [
      ...path,
      "system",
    ]);
  }
  if (!BOUNDARY_TREATMENTS.includes(boundary.treatment)) {
    fail(
      `treatment must be exactly one of ${BOUNDARY_TREATMENTS.join(" | ")} (got ${JSON.stringify(boundary.treatment)})`,
      [...path, "treatment"],
    );
  }
  if (typeof boundary.behavior !== "string" || boundary.behavior.trim() === "") {
    fail("behavior must be a non-empty, tech-neutral description", [...path, "behavior"]);
  }
  if (typeof boundary.side_effects !== "string" || boundary.side_effects.trim() === "") {
    fail("side_effects must state the side-effect policy (use \"none\" when there are none)", [
      ...path,
      "side_effects",
    ]);
  }

  return issues;
}

/**
 * Validates a flow's whole `boundaries` array: each declaration's shape,
 * stable-ID uniqueness within the flow. Does not check cross-references
 * from steps (that if a step touches a boundary, the boundary is declared)
 * — #145 owns that policy layer.
 */
export function validateBoundaries(boundaries, path) {
  const issues = [];
  const fail = (message, subpath = path) => issues.push({ path: subpath, message });

  if (!Array.isArray(boundaries)) {
    fail("boundaries must be a list");
    return issues;
  }
  if (boundaries.length === 0) {
    fail("boundaries must declare at least one entry — undeclared reach is forbidden by default, so every flow must say so explicitly");
  }

  const seenIds = new Set();
  boundaries.forEach((boundary, index) => {
    const itemPath = [...path, index];
    issues.push(...validateBoundaryDeclaration(boundary, itemPath));
    if (boundary && typeof boundary === "object" && typeof boundary.id === "string") {
      if (seenIds.has(boundary.id)) {
        fail(`duplicate boundary id ${JSON.stringify(boundary.id)}`, [...itemPath, "id"]);
      }
      seenIds.add(boundary.id);
    }
  });

  return issues;
}
