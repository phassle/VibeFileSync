// dynamic-qa/shared/scripts/browser-conventions.mjs
//
// Ticket #149: "Establish browser Binding conventions" (DESIGN-dynamic-qa-spec.md
// §10's anti-flakiness reference contract, SPEC-135 user stories 33-36). A
// generated browser Binding must survive a harmless refactor. That means
// selector choice is not free-form model judgment — it is a checked,
// deterministic gate, same as #146's forbidden-pattern scan for fixed
// sleeps/stubs/skips. This module is that gate for browser selectors:
//
//   - `detectHookConvention` — find the customer's own deliberate stable
//     test-hook attribute (`data-cy`, `data-testid`, `data-qa`, ...) from
//     their existing source, so generation *reuses* it rather than
//     silently imposing a different one. A repository that already has a
//     convention gets that convention back, verbatim attribute name and
//     all — never a rename to whatever this bundle happens to prefer.
//   - `validateSelector` — classify one candidate selector. Five forbidden
//     classes are rejected outright, each with its own named error, exactly
//     mirroring forbidden-patterns.mjs's per-family detectors so a Tier 1
//     test can prove each is caught on its own: generated IDs, hashed
//     (build-tool) classes, transient framework attributes, DOM-position
//     selectors, and XPath. Stable role/accessible-name contracts
//     (`getByRole`, `[role=]`, `[aria-label]`, ...) are always accepted:
//     they are a product contract with the user, not an implementation
//     detail, so they survive the same refactors a stable hook does.
//   - `proposeHook` — the *only* place a new dedicated test hook is ever
//     proposed, and only for a critical or ambiguous interaction point that
//     has no stable selector already. Every other point is left alone:
//     the product is not polluted with a blanket test attribute on every
//     element. When a convention was detected, the proposal follows it;
//     `data-testid` is used only as the fallback when no equivalent
//     convention exists, never forced over one that does.
//
// Fixed sleeps are already forbidden by forbidden-patterns.mjs
// (`detectFixedSleep`); this module does not re-implement that. It only
// adds the selector/hook half of the browser Binding conventions story.

const KNOWN_HOOK_ATTRIBUTES = Object.freeze([
  "data-testid",
  "data-test-id",
  "data-test",
  "data-cy",
  "data-qa",
  "data-qa-id",
  "data-e2e",
  "data-automation-id",
  "data-hook",
]);

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countAttributeOccurrences(sourceText, attribute) {
  // Matches the attribute as an HTML/JSX/template attribute assignment:
  // `data-cy="..."`, `data-cy='...'`, or `data-cy={...}`. Deliberately does
  // not match the bare substring anywhere (e.g. inside a comment or an
  // unrelated identifier) — only a real attribute-assignment use counts as
  // evidence of a deliberate convention.
  const re = new RegExp(`\\b${escapeForRegExp(attribute)}\\s*=\\s*(?:["'{])`, "g");
  const matches = sourceText.match(re);
  return matches ? matches.length : 0;
}

/**
 * Detects the customer's own deliberate stable test-hook attribute
 * convention from their existing source files.
 *
 * `files`: `[{ path, content }]` — any existing source (components,
 * templates, existing browser tests) worth scanning for hook usage.
 *
 * Returns `{ detected: true, attribute, occurrences, candidates }` when
 * exactly one known hook attribute has the strictly highest non-zero
 * occurrence count across the corpus — `candidates` lists every attribute
 * with at least one occurrence, sorted by descending occurrences.
 *
 * Returns `{ detected: false, ambiguous: false, candidates: [] }` when no
 * known hook attribute appears anywhere.
 *
 * Returns `{ detected: false, ambiguous: true, candidates }` when two or
 * more attributes tie for the highest non-zero count — genuinely
 * ambiguous, so generation must not silently pick one; a Setup Review
 * Packet question, not a guess.
 *
 * Never throws; an empty or missing `files` list is simply "no convention
 * detected".
 */
export function detectHookConvention(files) {
  const totals = new Map(KNOWN_HOOK_ATTRIBUTES.map((attribute) => [attribute, 0]));
  for (const file of files ?? []) {
    const content = typeof file?.content === "string" ? file.content : "";
    for (const attribute of KNOWN_HOOK_ATTRIBUTES) {
      totals.set(attribute, totals.get(attribute) + countAttributeOccurrences(content, attribute));
    }
  }

  const candidates = [...totals.entries()]
    .filter(([, occurrences]) => occurrences > 0)
    .map(([attribute, occurrences]) => ({ attribute, occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences || a.attribute.localeCompare(b.attribute));

  if (candidates.length === 0) {
    return { detected: false, ambiguous: false, candidates: [] };
  }

  const topCount = candidates[0].occurrences;
  const tiedAtTop = candidates.filter((c) => c.occurrences === topCount);
  if (tiedAtTop.length > 1) {
    return { detected: false, ambiguous: true, candidates };
  }

  return { detected: true, attribute: candidates[0].attribute, occurrences: topCount, candidates };
}

// --- Forbidden selector classes -------------------------------------------
//
// Checked in this fixed order so overlapping matches resolve to the most
// specific applicable class deterministically (e.g. an XPath expression
// that also happens to contain digits is reported as `xpath`, never
// mis-filed as `dom-position`).

const FORBIDDEN_SELECTOR_CLASSES = [
  {
    code: "xpath-selector",
    message: "XPath selectors are forbidden — they encode DOM structure, not a stable contract",
    re: /^\s*(?:xpath\s*=|\/\/|\/html\b)|::\w+::/i,
  },
  {
    code: "dom-position-selector",
    message: "DOM-position selectors are forbidden — sibling order is not a stable contract",
    re: /:nth-(?:child|of-type|last-child|last-of-type)\s*\(|\.eq\s*\(\s*\d+\s*\)|\.nth\s*\(\s*\d+\s*\)|:(?:first|last)-child\b/i,
  },
  {
    code: "generated-id-selector",
    message: "generated/runtime-assigned element IDs are forbidden — they are not stable across a rebuild",
    re: /#(?:ember\d+|react-[\w-]*-\d+|mui-\d+|:r[0-9a-z]+:)\b|\bid\s*=\s*["'](?:ember\d+|react-[\w-]*-\d+|mui-\d+|:r[0-9a-z]+:)["']/i,
  },
  {
    code: "hashed-class-selector",
    message: "hashed/build-tool class names are forbidden — a harmless refactor or rebuild changes the hash",
    re: /\.(?:sc-[a-zA-Z0-9]{5,}|css-[a-z0-9]{5,}|[\w-]+_[a-f0-9]{5,}|[a-zA-Z][\w-]*-[a-f0-9]{8,})\b/i,
  },
  {
    code: "transient-attribute-selector",
    message: "transient framework-internal attributes are forbidden — they are implementation detail, not a stable contract",
    re: /\[\s*(?:data-v-[0-9a-f]{6,}|ng-reflect-[\w-]+|data-reactid|data-emotion|style)\b/i,
  },
];

const ROLE_ACCESSIBILITY_PATTERNS = [
  /\bgetByRole\s*\(/,
  /\bgetByLabel\s*\(/,
  /\bgetByAltText\s*\(/,
  /\[\s*role\s*=/i,
  /\brole\s*=\s*["']/,
  /\[\s*aria-label/i,
  /\[\s*aria-labelledby/i,
];

function isStableHookSelector(selector, hookAttribute) {
  const attributesToCheck = hookAttribute ? [hookAttribute] : KNOWN_HOOK_ATTRIBUTES;
  return attributesToCheck.some((attribute) => {
    const escaped = escapeForRegExp(attribute);
    return new RegExp(`\\[\\s*${escaped}\\s*=|\\bgetByTestId\\s*\\(|\\b${escaped}\\s*=\\s*["'{]`, "i").test(selector);
  });
}

/**
 * Classifies one candidate browser selector.
 *
 * `options.hookAttribute`, when supplied (typically the `attribute` from
 * `detectHookConvention`'s result), is checked in addition to the built-in
 * known hook attribute names when deciding whether a selector uses the
 * repository's stable hook convention.
 *
 * Returns `{ ok: false, error: { code, message } }` for any of the five
 * forbidden classes, using exactly these `code`s: `"generated-id-selector"`,
 * `"hashed-class-selector"`, `"transient-attribute-selector"`,
 * `"dom-position-selector"`, `"xpath-selector"`.
 *
 * Returns `{ ok: true, kind }` otherwise, where `kind` is
 * `"role-or-accessibility"` for a stable role/accessible-name contract,
 * `"stable-hook"` for a selector targeting a known or detected hook
 * attribute, or `"unclassified"` for anything else this module does not
 * forbid but also does not specifically recognize as a stable convention.
 *
 * Never throws; a non-string selector is reported as `ok: false` with
 * `error.code === "invalid-selector"`.
 */
export function validateSelector(selector, options = {}) {
  if (typeof selector !== "string" || selector.trim().length === 0) {
    return { ok: false, error: { code: "invalid-selector", message: "selector must be a non-empty string" } };
  }

  for (const { code, message, re } of FORBIDDEN_SELECTOR_CLASSES) {
    if (re.test(selector)) {
      return { ok: false, error: { code, message } };
    }
  }

  if (ROLE_ACCESSIBILITY_PATTERNS.some((re) => re.test(selector))) {
    return { ok: true, kind: "role-or-accessibility" };
  }

  if (isStableHookSelector(selector, options.hookAttribute)) {
    return { ok: true, kind: "stable-hook" };
  }

  return { ok: true, kind: "unclassified" };
}

/**
 * Decides whether to propose a new dedicated test hook for one interaction
 * point, and if so, which attribute to propose.
 *
 * `point`: `{ id, description, critical, ambiguous, hasStableSelector }`.
 * `id` is required and non-empty; the rest default to `false` when absent.
 *
 * `conventionResult`, when supplied, is a `detectHookConvention` result.
 * When it names a detected convention, that attribute is proposed; a
 * repository with a working convention never gets a competing
 * `data-testid` forced onto it. Absent a detected convention, the fallback
 * is `"data-testid"`.
 *
 * A hook is proposed **only** when the point has no stable selector
 * already and is `critical` or `ambiguous` — never blanket-applied to every
 * interaction point, per the anti-flakiness reference contract's "missing
 * hooks are tracked product changes, not manufactured wholesale".
 *
 * Returns `{ proposed: true, attribute, reason }` or
 * `{ proposed: false, reason }`. Never throws.
 */
export function proposeHook(point, conventionResult) {
  if (!point || typeof point.id !== "string" || point.id.trim().length === 0) {
    return { proposed: false, reason: "invalid-interaction-point: id is required" };
  }

  if (point.hasStableSelector) {
    return { proposed: false, reason: `interaction point ${JSON.stringify(point.id)} already has a stable selector — no hook needed` };
  }

  if (!point.critical && !point.ambiguous) {
    return {
      proposed: false,
      reason: `interaction point ${JSON.stringify(point.id)} is neither critical nor ambiguous — a dedicated hook is proposed only for critical or ambiguous points, never blanket-applied`,
    };
  }

  const attribute = conventionResult?.detected ? conventionResult.attribute : "data-testid";
  const why = point.critical ? "critical" : "ambiguous";
  const provenance = conventionResult?.detected
    ? `following the repository's existing ${JSON.stringify(attribute)} convention`
    : `no existing hook convention was detected, so ${JSON.stringify(attribute)} is the fallback`;

  return {
    proposed: true,
    attribute,
    reason: `interaction point ${JSON.stringify(point.id)} is ${why}${point.description ? ` (${point.description})` : ""}; ${provenance}`,
  };
}
