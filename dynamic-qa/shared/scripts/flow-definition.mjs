// dynamic-qa/shared/scripts/flow-definition.mjs
//
// Fail-closed validator for the Flow Definition v1 contract
// (dynamic-qa/shared/schemas/dynamic-qa-flow-v1.schema.json,
// DESIGN-dynamic-qa-spec.md §5.1). Flow Definitions are the source of truth
// for the whole bundle (run brief decision 5) — this module, plus
// restricted-yaml.mjs, IS the fail-closed parsing/validation ticket #143
// exists to build.
//
// Design for extension (read this before adding a v2 field or a sibling
// schema in #144/#145/#146):
//
//   - `validateFlowDefinition(data)` returns EVERY issue it finds as
//     { path, message } entries, in one array — it never throws and never
//     stops at the first problem. A rejection is always data (a non-empty
//     `errors` array on a `{ valid: false }` result), never a warning and
//     never a silent coercion.
//   - Field-shaped sub-checks that another schema also needs are their own
//     module and are imported here, not copy-pasted: id-rules.mjs (semantic
//     ID pattern), boundaries.mjs (Boundary Declaration shape — #145's
//     seam), data-set-refs.mjs (Named Data Set reference shape — #144's
//     seam). #144/#145 are expected to import those two modules directly
//     for their own file's validation, and to import
//     `SUPPORTED_SCHEMA`-style version constants and `assertKnownKeys`
//     from here if it is useful, rather than reimplementing the
//     unknown-key/unsupported-version fail-closed pattern.
//   - `parseFlowDefinitionFile(source, { filename })` is the one function
//     that combines restricted-YAML parsing with schema validation and the
//     filename===id invariant. Anything that needs "give me a validated
//     Flow Definition from a .yaml file on disk" should call this, not
//     reimplement the parse-then-validate sequence.

import { parseRestrictedYAML, YamlSyntaxError } from "./restricted-yaml.mjs";
import { isValidSemanticId } from "./id-rules.mjs";
import { validateBoundaries } from "./boundaries.mjs";
import { validateDataSetReferences } from "./data-set-refs.mjs";

export const SUPPORTED_SCHEMA = "dynamic-qa-flow-v1";

export const CRITICALITY_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
export const FLOW_STATES = Object.freeze(["draft", "deferred", "active", "retired"]);
export const STEP_KINDS = Object.freeze(["given", "when", "then"]);
export const TOLERANCE_KINDS = Object.freeze([
  "exact",
  "normalized-text",
  "numeric",
  "temporal",
  "unordered-set",
  "presentation",
  "custom",
]);
export const PRESENTATION_ASPECTS = Object.freeze(["layout", "style", "position"]);

const ROOT_KEYS = new Set([
  "schema",
  "id",
  "revision",
  "title",
  "intent",
  "criticality",
  "state",
  "origin",
  "test_level",
  "data_sets",
  "boundaries",
  "steps",
]);

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
    if (!allowed.has(key)) {
      issues.add([...path, key], `unknown key ${JSON.stringify(key)}`);
    }
  }
}

// --- Expected Outcome text: product language + scalar substitution only --

const SUBSTITUTION_TOKEN_RE = /\$\{([^}]*)\}/g;
const SCALAR_FIELD_RE = /^case\.[a-zA-Z_][a-zA-Z0-9_]*$/;
// Substrings that indicate a templating/expression engine or executable
// content beyond the one supported "${case.<field>}" scalar-substitution
// form. This is a deliberately narrow, literal denylist — not an attempt to
// judge whether prose is "really" product language, which stays a human
// review responsibility (see DESIGN-dynamic-qa-spec.md §5.1's "selectors,
// routes, commands... are invalid" — that is enforced by the qa-setup
// interview/reconciliation stages, not deterministically decidable from
// text alone).
const FORBIDDEN_TEMPLATE_MARKERS = ["{{", "<%", "`", "$(", "#{"];

function validateExpectedOutcomeText(text, path, issues) {
  if (!nonEmptyString(text)) {
    issues.add(path, "expect must be a non-empty string");
    return;
  }
  for (const marker of FORBIDDEN_TEMPLATE_MARKERS) {
    if (text.includes(marker)) {
      issues.add(
        path,
        `expect contains ${JSON.stringify(marker)} — only scalar "\${case.<field>}" substitution is supported, no expression language or executable content`,
      );
      return;
    }
  }
  // Every "${...}" occurrence (once forbidden markers are ruled out) must be
  // exactly a scalar case-field reference — never a nested expression, a
  // function call, or arithmetic.
  let match;
  SUBSTITUTION_TOKEN_RE.lastIndex = 0;
  while ((match = SUBSTITUTION_TOKEN_RE.exec(text)) !== null) {
    const inner = match[1];
    if (!SCALAR_FIELD_RE.test(inner)) {
      issues.add(
        path,
        `substitution token \${${inner}} is not a scalar "case.<field>" reference — no expression language is supported`,
      );
    }
  }
  // A lone, unmatched "${" (no closing "}") is also rejected rather than
  // silently left as literal text.
  const dollarBraceCount = (text.match(/\$\{/g) || []).length;
  const closedCount = (text.match(SUBSTITUTION_TOKEN_RE) || []).length;
  if (dollarBraceCount !== closedCount) {
    issues.add(path, `unterminated "\${" substitution token`);
  }
}

// --- Tolerance -------------------------------------------------------------

function validateTolerance(tolerance, path, issues) {
  if (!isPlainObject(tolerance)) {
    issues.add(path, "tolerance must be a mapping");
    return;
  }
  if (!TOLERANCE_KINDS.includes(tolerance.kind)) {
    issues.add(
      [...path, "kind"],
      `kind must be one of ${TOLERANCE_KINDS.join(" | ")} (got ${JSON.stringify(tolerance.kind)})`,
    );
    return;
  }

  const allowed = new Set(["kind"]);
  switch (tolerance.kind) {
    case "exact":
      break;
    case "normalized-text": {
      for (const flag of ["ignore_case", "ignore_whitespace", "trim"]) allowed.add(flag);
      for (const flag of ["ignore_case", "ignore_whitespace", "trim"]) {
        if (flag in tolerance && typeof tolerance[flag] !== "boolean") {
          issues.add([...path, flag], `${flag} must be a boolean`);
        }
      }
      break;
    }
    case "numeric": {
      allowed.add("abs_epsilon");
      allowed.add("rel_epsilon");
      const hasAbs = "abs_epsilon" in tolerance;
      const hasRel = "rel_epsilon" in tolerance;
      if (hasAbs === hasRel) {
        issues.add(path, "numeric tolerance requires exactly one of abs_epsilon or rel_epsilon");
      }
      for (const key of ["abs_epsilon", "rel_epsilon"]) {
        if (key in tolerance && !(typeof tolerance[key] === "number" && tolerance[key] > 0)) {
          issues.add([...path, key], `${key} must be a positive number`);
        }
      }
      break;
    }
    case "temporal": {
      allowed.add("epsilon_seconds");
      if (!("epsilon_seconds" in tolerance)) {
        issues.add(path, "temporal tolerance requires epsilon_seconds");
      } else if (!(typeof tolerance.epsilon_seconds === "number" && tolerance.epsilon_seconds > 0)) {
        issues.add([...path, "epsilon_seconds"], "epsilon_seconds must be a positive number");
      }
      break;
    }
    case "unordered-set":
      break;
    case "presentation": {
      allowed.add("aspects");
      if (!Array.isArray(tolerance.aspects) || tolerance.aspects.length === 0) {
        issues.add([...path, "aspects"], "presentation tolerance requires a non-empty aspects list");
      } else {
        const seen = new Set();
        for (const [i, aspect] of tolerance.aspects.entries()) {
          if (!PRESENTATION_ASPECTS.includes(aspect)) {
            issues.add(
              [...path, "aspects", i],
              `presentation tolerance may only ignore ${PRESENTATION_ASPECTS.join(" | ")} — content, values, behavior, accessibility, and counts must still fail when wrong (got ${JSON.stringify(aspect)})`,
            );
          }
          if (seen.has(aspect)) issues.add([...path, "aspects", i], `duplicate aspect ${JSON.stringify(aspect)}`);
          seen.add(aspect);
        }
      }
      break;
    }
    case "custom": {
      allowed.add("approved_by");
      allowed.add("reason");
      if (!nonEmptyString(tolerance.approved_by)) {
        issues.add(
          [...path, "approved_by"],
          "custom tolerance requires explicit QA Owner approval: approved_by must name who approved it",
        );
      }
      if (!nonEmptyString(tolerance.reason)) {
        issues.add([...path, "reason"], "custom tolerance requires a plain-language reason");
      }
      break;
    }
    default:
      break;
  }
  assertKnownKeys(tolerance, allowed, path, issues);
}

// --- Outcomes / steps --------------------------------------------------

function validateOutcome(outcome, path, issues, seenOutcomeIds) {
  if (!isPlainObject(outcome)) {
    issues.add(path, "an outcome must be a mapping");
    return;
  }
  assertKnownKeys(outcome, new Set(["id", "expect", "tolerance"]), path, issues);

  if (!isValidSemanticId(outcome.id)) {
    issues.add([...path, "id"], "id must be a stable semantic identifier");
  } else if (seenOutcomeIds.has(outcome.id)) {
    issues.add([...path, "id"], `duplicate Expected Outcome id ${JSON.stringify(outcome.id)} elsewhere in this flow`);
  } else {
    seenOutcomeIds.add(outcome.id);
  }

  validateExpectedOutcomeText(outcome.expect, [...path, "expect"], issues);

  if ("tolerance" in outcome) {
    validateTolerance(outcome.tolerance, [...path, "tolerance"], issues);
  }
}

function validateStep(step, path, issues, seenStepIds, seenOutcomeIds) {
  if (!isPlainObject(step)) {
    issues.add(path, "a step must be a mapping");
    return;
  }
  assertKnownKeys(step, new Set(["id", "kind", "intent", "outcomes"]), path, issues);

  if (!isValidSemanticId(step.id)) {
    issues.add([...path, "id"], "id must be a stable semantic identifier");
  } else if (seenStepIds.has(step.id)) {
    issues.add([...path, "id"], `duplicate step id ${JSON.stringify(step.id)} elsewhere in this flow`);
  } else {
    seenStepIds.add(step.id);
  }

  if (!STEP_KINDS.includes(step.kind)) {
    issues.add([...path, "kind"], `kind must be one of ${STEP_KINDS.join(" | ")} (got ${JSON.stringify(step.kind)})`);
  }
  if (!nonEmptyString(step.intent)) {
    issues.add([...path, "intent"], "intent must be a non-empty, tech-neutral description");
  }

  const hasOutcomes = "outcomes" in step;
  if (hasOutcomes) {
    if (!Array.isArray(step.outcomes) || step.outcomes.length === 0) {
      issues.add([...path, "outcomes"], "outcomes, when present, must be a non-empty list");
    } else {
      step.outcomes.forEach((outcome, i) => {
        validateOutcome(outcome, [...path, "outcomes", i], issues, seenOutcomeIds);
      });
    }
  } else if (step.kind === "then") {
    issues.add(
      [...path, "outcomes"],
      "a 'then' step must declare one or more Expected Outcome ids so evidence stays traceable",
    );
  }
}

// --- origin / test_level ------------------------------------------------

function validateOrigin(origin, path, issues) {
  if (!isPlainObject(origin)) {
    issues.add(path, "origin must be a mapping");
    return;
  }
  assertKnownKeys(origin, new Set(["tickets"]), path, issues);
  if (!Array.isArray(origin.tickets) || origin.tickets.length === 0) {
    issues.add([...path, "tickets"], "tickets must be a non-empty list of stable ticket URIs");
    return;
  }
  origin.tickets.forEach((ticket, i) => {
    if (!(typeof ticket === "string" && /^https?:\/\/\S+$/.test(ticket))) {
      issues.add([...path, "tickets", i], `each ticket must be a stable http(s) URI (got ${JSON.stringify(ticket)})`);
    }
  });
}

function validateTestLevel(testLevel, path, issues) {
  if (!isPlainObject(testLevel)) {
    issues.add(path, "test_level must be a mapping");
    return;
  }
  if (testLevel.selection === "inferred") {
    assertKnownKeys(testLevel, new Set(["selection"]), path, issues);
    return;
  }
  if (testLevel.selection === "override") {
    assertKnownKeys(testLevel, new Set(["selection", "value", "reason"]), path, issues);
    if (!nonEmptyString(testLevel.value)) {
      issues.add([...path, "value"], "an override test_level requires a non-empty value");
    }
    if (!nonEmptyString(testLevel.reason)) {
      issues.add([...path, "reason"], "an override test_level requires an approved, non-empty reason");
    }
    return;
  }
  issues.add(
    [...path, "selection"],
    `selection must be "inferred" or "override" (got ${JSON.stringify(testLevel.selection)})`,
  );
}

// --- top level -----------------------------------------------------------

/**
 * Validates an already-parsed Flow Definition JS value against the v1
 * contract. Returns { valid, errors }. `errors` is always an array of
 * { path, message } (empty when valid) — never a warning, and every issue
 * found is reported, not just the first.
 */
export function validateFlowDefinition(data, { expectedId } = {}) {
  const issues = new Issues();

  if (!isPlainObject(data)) {
    issues.add([], "a Flow Definition document must be a mapping");
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
      `id ${JSON.stringify(data.id)} does not match its filename ${JSON.stringify(expectedId)} — the filename must equal the immutable Flow ID`,
    );
  }

  if (!(Number.isInteger(data.revision) && data.revision >= 1)) {
    issues.add(["revision"], "revision must be a monotonically increasing integer starting at 1");
  }

  if (!nonEmptyString(data.title)) issues.add(["title"], "title must be a non-empty string");
  if (!nonEmptyString(data.intent)) issues.add(["intent"], "intent must be a non-empty string");

  if (!CRITICALITY_LEVELS.includes(data.criticality)) {
    issues.add(
      ["criticality"],
      `criticality must be one of ${CRITICALITY_LEVELS.join(" | ")} (got ${JSON.stringify(data.criticality)})`,
    );
  }
  if (!FLOW_STATES.includes(data.state)) {
    issues.add(["state"], `state must be one of ${FLOW_STATES.join(" | ")} (got ${JSON.stringify(data.state)})`);
  }

  validateOrigin(data.origin, ["origin"], issues);
  validateTestLevel(data.test_level, ["test_level"], issues);

  issues.addAll(validateDataSetReferences(data.data_sets, ["data_sets"]));
  issues.addAll(validateBoundaries(data.boundaries, ["boundaries"]));

  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    issues.add(["steps"], "steps must be a non-empty Given/When/Then-shaped list");
  } else {
    const seenStepIds = new Set();
    const seenOutcomeIds = new Set();
    data.steps.forEach((step, i) => {
      validateStep(step, ["steps", i], issues, seenStepIds, seenOutcomeIds);
    });
    if (data.steps.length > 0 && seenOutcomeIds.size === 0 && issues.list.length === 0) {
      issues.add(["steps"], "at least one step must declare an Expected Outcome");
    }
  }

  return { valid: issues.list.length === 0, errors: issues.list };
}

/**
 * Parses restricted-YAML `source`, then validates the result against the v1
 * contract. `filename`, when given, must be the flow file's basename
 * without extension (equal to the immutable Flow ID) — a mismatch is a
 * validation error, not a warning. Fail-closed YAML syntax problems
 * (aliases, anchors, custom tags, duplicate keys, tabs, flow collections,
 * block scalars, document markers) surface as a thrown YamlSyntaxError,
 * exactly as parseRestrictedYAML raises them, since parsing cannot proceed
 * past them at all.
 */
export function parseFlowDefinitionFile(source, { filename } = {}) {
  const data = parseRestrictedYAML(source, { filename });
  return validateFlowDefinition(data, { expectedId: filename });
}

export { YamlSyntaxError };
