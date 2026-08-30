// dynamic-qa/shared/scripts/boundaries.mjs
//
// Structural validation for a Flow Definition's inline `boundaries` field
// (DESIGN-dynamic-qa-spec.md §5.1: "boundaries, each with stable ID, system,
// real | simulated | forbidden treatment, tech-neutral behavior, and
// side-effect policy").
//
// This module checks *shape* only — a well-formed, stable-ID,
// one-of-three-treatments declaration, plus two optional fields (`role`,
// `volatile`) and an optional `isolation` block whose *presence* this module
// validates but whose *requirement* is policy, not shape:
//
//   - `role`: "owned" | "dependency" (default "dependency" when absent).
//     Which single boundary is the owned service/outcome under test is a
//     reviewed, human-authored decision, never inferred from `system` or
//     `behavior` text — see boundary-policy.mjs for why.
//   - `volatile`: boolean (default false when absent). Marks a boundary as
//     inherently non-deterministic or third-party (time, randomness,
//     payments, an external service, unverified behaviour) — again a
//     reviewed field, not a keyword guess against free text.
//   - `isolation`: `{ namespace, cleanup }`, both non-empty strings — the
//     per-run namespace and cleanup-capability statement for a boundary with
//     real side effects.
//
// #145 (boundary-policy.mjs) owns the actual policy: that the owned outcome
// must stay real, that a volatile boundary can never be real, that a
// forbidden boundary's declaration must be honourable, that undeclared reach
// fails closed, and that real side effects require isolation. Import
// `validateBoundaryDeclaration` / `validateBoundaries` from here and layer
// policy on top — do not fork this shape check.

import { isValidSemanticId } from "./id-rules.mjs";

export const BOUNDARY_TREATMENTS = Object.freeze(["real", "simulated", "forbidden"]);
export const BOUNDARY_ROLES = Object.freeze(["owned", "dependency"]);

const ALLOWED_KEYS = new Set([
  "id",
  "system",
  "treatment",
  "behavior",
  "side_effects",
  "role",
  "volatile",
  "isolation",
]);

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

  if ("role" in boundary && !BOUNDARY_ROLES.includes(boundary.role)) {
    fail(`role must be one of ${BOUNDARY_ROLES.join(" | ")} (got ${JSON.stringify(boundary.role)})`, [
      ...path,
      "role",
    ]);
  }

  if ("volatile" in boundary && typeof boundary.volatile !== "boolean") {
    fail("volatile must be a boolean", [...path, "volatile"]);
  }

  if ("isolation" in boundary) {
    const isolation = boundary.isolation;
    const isolationPath = [...path, "isolation"];
    if (isolation === null || typeof isolation !== "object" || Array.isArray(isolation)) {
      fail("isolation must be a mapping with namespace and cleanup", isolationPath);
    } else {
      for (const key of Object.keys(isolation)) {
        if (key !== "namespace" && key !== "cleanup") {
          fail(`unknown key ${JSON.stringify(key)}`, [...isolationPath, key]);
        }
      }
      if (typeof isolation.namespace !== "string" || isolation.namespace.trim() === "") {
        fail("isolation.namespace must describe the per-run namespace", [...isolationPath, "namespace"]);
      }
      if (typeof isolation.cleanup !== "string" || isolation.cleanup.trim() === "") {
        fail("isolation.cleanup must describe the cleanup capability", [...isolationPath, "cleanup"]);
      }
    }
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
