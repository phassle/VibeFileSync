// dynamic-qa/shared/scripts/inventory.mjs
//
// Orchestrates stage 2 ("Inventory facts read-only") of qa-setup: combines
// the test/framework/support scanners (inventory-tests.mjs) and the CI
// scanner (inventory-ci.mjs) into one Setup Inventory artifact, and
// validates the result against fact.mjs's schema before returning it.
//
// The Setup Inventory is EPHEMERAL (see dynamic-qa/DESIGN-dynamic-qa-spec.md
// "Setup Inventory | Ephemeral, sourced facts ... never policy"): it exists
// to be presented to the responsible QA Owner during the setup interview,
// never written to the repository as a persisted artifact. buildSetupInventory
// therefore only ever READS (via repo-walk.mjs's read-only primitives,
// transitively) and returns a plain in-memory object — it performs no
// filesystem write of any kind, which is exactly what stage 2 requires
// ("Discovery writes nothing").

import { scanTestFrameworks, scanExistingTests, scanTestSupportKeywords } from "./inventory-tests.mjs";
import { scanCiWorkflows } from "./inventory-ci.mjs";
import { validateInventory } from "./fact.mjs";

// buildSetupInventory(repoRoot, { now }) -> Setup Inventory object
//
// Throws if the assembled inventory fails validateInventory (fails closed —
// a malformed inventory is never handed back as if it were trustworthy).
export function buildSetupInventory(repoRoot, options = {}) {
  const now = options.now ?? new Date();
  const facts = [
    ...scanTestFrameworks(repoRoot),
    ...scanExistingTests(repoRoot),
    ...scanTestSupportKeywords(repoRoot),
    ...scanCiWorkflows(repoRoot),
  ];

  const inventory = {
    generatedAt: now.toISOString(),
    repoRoot,
    facts,
  };

  const { ok, errors } = validateInventory(inventory);
  if (!ok) {
    throw new Error(`buildSetupInventory produced an invalid Setup Inventory: ${errors.join("; ")}`);
  }
  return inventory;
}

// summarizeProvenance(inventory) -> { observed, reported, unknown } counts.
// A small convenience for qa-setup's orientation report ("N facts observed,
// M reported, K unknown") without re-implementing the count in SKILL.md
// prose or in a later ticket's caller.
export function summarizeProvenance(inventory) {
  const counts = { observed: 0, reported: 0, unknown: 0 };
  for (const fact of inventory.facts) {
    counts[fact.provenance] = (counts[fact.provenance] ?? 0) + 1;
  }
  return counts;
}
