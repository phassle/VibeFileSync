// dynamic-qa/shared/scripts/restricted-yaml.mjs
//
// A hand-written parser for a deliberately restricted subset of YAML.
//
// Why not a YAML library: decision 5 in the run brief and DESIGN-dynamic-qa-spec.md
// §5.1 both require the deterministic core to add no dependency and to fail
// closed on the exact hazards a general-purpose YAML parser would happily
// accept (aliases, anchors, custom tags, executable-looking tags). Writing a
// parser that only understands a safe subset *is* the fail-closed contract,
// not a workaround for it.
//
// Supported subset:
//   - block mappings ("key: value", or "key:" followed by an indented block)
//   - block sequences ("- value", or "- key: value" starting a mapping item)
//   - plain, single-quoted, and double-quoted scalar strings (one line only)
//   - integers, floats, "true"/"false", "null"/"~"
//   - "#" comments (outside quotes)
//
// Deliberately unsupported, and rejected with a precise, actionable message
// naming the offending line and path, never silently coerced or warned about:
//   - anchors ("&name") and aliases ("*name")
//   - custom/explicit tags ("!Tag", "!!python/object:...", etc.)
//   - duplicate keys within one mapping
//   - flow-style collections ("{...}", "[...]") — except the two empty
//     literals "[]" and "{}", which block style has no way to spell and
//     which carry none of flow style's aliasing/nesting risk
//   - block scalars ("|", ">") and their chomping variants
//   - document markers ("---", "...") and "%" directives
//   - tab characters used for indentation
//
// This module is intentionally generic (it does not know anything about
// Flow Definitions). flow-definition.mjs layers schema-specific fail-closed
// rules (unknown keys, unsupported schema versions, executable-expression
// syntax inside string values) on top of the plain JS value this returns.

export class YamlSyntaxError extends Error {
  constructor(message, { line, path } = {}) {
    const location = line !== undefined ? ` (line ${line})` : "";
    const at = path && path.length ? ` at ${formatPath(path)}` : "";
    super(`${message}${at}${location}`);
    this.name = "YamlSyntaxError";
    this.line = line;
    this.path = path ?? [];
  }
}

// Defines `key` on `obj` (which must be a null-prototype object) as an
// ordinary own enumerable data property, regardless of the key's name.
// Paired with `Object.create(null)` targets so a parsed key literally named
// "__proto__" is never mistaken for a prototype reassignment.
function defineDataProperty(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export function formatPath(path) {
  if (!path || path.length === 0) return "$";
  let out = "$";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return out;
}

const RESERVED_SCALARS = new Map([
  ["true", true],
  ["false", false],
  ["null", null],
  ["~", null],
]);

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+([eE][+-]?\d+)?$/;

// A YAML node-start indicator that this restricted subset always rejects:
// anchor, alias, or a tag. Matched only against a value's own first
// character (never inside a quoted string), so "Hello!" as prose text is
// untouched.
const FORBIDDEN_INDICATOR_RE = /^([&*!])(\S*)/;

function stripCommentOutsideQuotes(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inDouble) {
      if (ch === "\\") {
        i++; // skip escaped char
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          i++; // escaped quote inside single-quoted string
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function splitLines(source) {
  const rawLines = source.split(/\r\n|\r|\n/);
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const raw = rawLines[i];
    if (/\t/.test(raw.match(/^[ \t]*/)[0])) {
      throw new YamlSyntaxError(
        "tab characters are not allowed for indentation in the restricted YAML subset",
        { line: lineNo },
      );
    }
    const trimmedForMarker = raw.trim();
    if (trimmedForMarker === "---" || trimmedForMarker === "...") {
      throw new YamlSyntaxError(
        "document markers ('---' / '...') are not supported in the restricted YAML subset",
        { line: lineNo },
      );
    }
    if (/^%/.test(trimmedForMarker)) {
      throw new YamlSyntaxError(
        "'%' directives are not supported in the restricted YAML subset",
        { line: lineNo },
      );
    }
    const withoutComment = stripCommentOutsideQuotes(raw);
    const content = withoutComment.replace(/\s+$/, "");
    if (content.trim() === "") continue; // blank or comment-only line
    const indentMatch = content.match(/^ */)[0];
    lines.push({ lineNo, indent: indentMatch.length, text: content.slice(indentMatch.length) });
  }
  return lines;
}

function assertNoForbiddenIndicator(value, lineNo, path) {
  const trimmed = value.trim();
  if (trimmed === "") return;
  if (trimmed[0] === '"' || trimmed[0] === "'") return; // quoted, exempt
  const m = trimmed.match(FORBIDDEN_INDICATOR_RE);
  if (!m) return;
  const [, indicator] = m;
  if (indicator === "&") {
    throw new YamlSyntaxError(
      "YAML anchors ('&name') are not supported in the restricted YAML subset",
      { line: lineNo, path },
    );
  }
  if (indicator === "*") {
    throw new YamlSyntaxError(
      "YAML aliases ('*name') are not supported in the restricted YAML subset",
      { line: lineNo, path },
    );
  }
  if (indicator === "!") {
    throw new YamlSyntaxError(
      "custom/explicit YAML tags ('!Tag', '!!type:...') are not supported in the restricted YAML subset",
      { line: lineNo, path },
    );
  }
}

function rejectFlowCollections(value, lineNo, path) {
  const trimmed = value.trim();
  if (trimmed === "") return;
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    throw new YamlSyntaxError(
      "flow-style collections ('{...}' / '[...]') are not supported in the restricted YAML subset",
      { line: lineNo, path },
    );
  }
}

function rejectBlockScalarIndicator(value, lineNo, path) {
  const trimmed = value.trim();
  if (/^[|>][+-]?\d*$/.test(trimmed)) {
    throw new YamlSyntaxError(
      "block scalars ('|' / '>') are not supported in the restricted YAML subset; use a single-line quoted string",
      { line: lineNo, path },
    );
  }
}

function parseDoubleQuoted(text, lineNo, path) {
  if (text[0] !== '"') return undefined;
  let out = "";
  let i = 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0" };
      if (next === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new YamlSyntaxError("invalid \\u escape in double-quoted string", { line: lineNo, path });
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
      if (!(next in map)) {
        throw new YamlSyntaxError(`unsupported escape sequence '\\${next}' in double-quoted string`, {
          line: lineNo,
          path,
        });
      }
      out += map[next];
      i++;
      continue;
    }
    if (ch === '"') {
      const rest = text.slice(i + 1).trim();
      if (rest !== "") {
        throw new YamlSyntaxError("unexpected content after closing '\"'", { line: lineNo, path });
      }
      return out;
    }
    out += ch;
  }
  throw new YamlSyntaxError("unterminated double-quoted string", { line: lineNo, path });
}

function parseSingleQuoted(text, lineNo, path) {
  if (text[0] !== "'") return undefined;
  let out = "";
  let i = 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      const rest = text.slice(i + 1).trim();
      if (rest !== "") {
        throw new YamlSyntaxError("unexpected content after closing \"'\"", { line: lineNo, path });
      }
      return out;
    }
    out += ch;
  }
  throw new YamlSyntaxError("unterminated single-quoted string", { line: lineNo, path });
}

function parseScalar(rawText, lineNo, path) {
  const text = rawText.trim();
  // The two empty-collection literals are allowed as a narrow, unambiguous
  // exception to "no flow-style collections": block style has no way to
  // spell an empty list/map, and "[]"/"{}" carry none of the aliasing,
  // tagging, or nested-structure risk the flow-style rejection exists for.
  if (text === "[]") return [];
  if (text === "{}") return {};
  rejectFlowCollections(text, lineNo, path);
  rejectBlockScalarIndicator(text, lineNo, path);
  assertNoForbiddenIndicator(text, lineNo, path);
  const dq = parseDoubleQuoted(text, lineNo, path);
  if (dq !== undefined) return dq;
  const sq = parseSingleQuoted(text, lineNo, path);
  if (sq !== undefined) return sq;
  if (text === "") return null;
  if (RESERVED_SCALARS.has(text)) return RESERVED_SCALARS.get(text);
  if (INT_RE.test(text)) return parseInt(text, 10);
  if (FLOAT_RE.test(text)) return parseFloat(text);
  return text;
}

// Splits "key: value" (or "key:") into { key, rest }. Only the first
// unquoted ": " (or a trailing bare ":") is treated as the separator.
function splitKeyValue(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (ch === "\\") i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === ":" && (i === text.length - 1 || text[i + 1] === " ")) {
      return { key: text.slice(0, i), rest: text.slice(i + 1).replace(/^ /, "") };
    }
  }
  return null;
}

function parseKeyScalar(rawKey, lineNo, path) {
  const key = parseScalar(rawKey, lineNo, path);
  if (typeof key !== "string") {
    throw new YamlSyntaxError("mapping keys must be plain strings in the restricted YAML subset", {
      line: lineNo,
      path,
    });
  }
  return key;
}

// Consumes zero or more lines at exactly `indent`, forming either a mapping
// (object) or a sequence (array), or returns { consumed: 0 } if the next
// line is not at `indent` (caller then treats the value as absent/null).
function parseBlock(lines, startIdx, indent, path) {
  if (startIdx >= lines.length) return { value: null, next: startIdx };
  const first = lines[startIdx];
  if (first.indent < indent) return { value: null, next: startIdx };
  if (first.indent > indent) {
    throw new YamlSyntaxError("unexpected indentation", { line: first.lineNo, path });
  }

  if (first.text.startsWith("- ") || first.text === "-") {
    return parseSequence(lines, startIdx, indent, path);
  }
  return parseMapping(lines, startIdx, indent, path);
}

function parseSequence(lines, startIdx, indent, path) {
  const arr = [];
  let idx = startIdx;
  while (idx < lines.length && lines[idx].indent === indent && (lines[idx].text.startsWith("- ") || lines[idx].text === "-")) {
    const line = lines[idx];
    const itemPath = [...path, arr.length];
    const remainder = line.text === "-" ? "" : line.text.slice(2);
    const itemIndent = indent + 2;

    if (remainder.trim() === "") {
      // "- " with nothing inline: the item is a nested block at itemIndent.
      idx++;
      const result = parseBlock(lines, idx, itemIndent, itemPath);
      arr.push(result.value);
      idx = result.next;
      continue;
    }

    const kv = splitKeyValue(remainder);
    if (kv) {
      // "- key: value" starts a mapping; subsequent deeper-indented lines at
      // itemIndent continue the same mapping.
      const syntheticLines = [{ lineNo: line.lineNo, indent: itemIndent, text: remainder }];
      idx++;
      while (idx < lines.length && lines[idx].indent >= itemIndent) {
        syntheticLines.push(lines[idx]);
        idx++;
      }
      const result = parseMapping(syntheticLines, 0, itemIndent, itemPath);
      arr.push(result.value);
      continue;
    }

    // Plain inline scalar item.
    arr.push(parseScalar(remainder, line.lineNo, itemPath));
    idx++;
  }
  return { value: arr, next: idx };
}

function parseMapping(lines, startIdx, indent, path) {
  // `key` below comes straight from the YAML text (parseKeyScalar), which is
  // attacker-influenceable (this parser reads Flow Definitions, Named Data
  // Sets, and other customer-owned-but-untrusted documents). Assigning a
  // literal key named "__proto__" onto a normal object via `obj[key] = ...`
  // would invoke the inherited Object.prototype accessor and repoint obj's
  // own prototype instead of storing the key as data (prototype pollution),
  // and the key would then silently vanish from Object.keys(obj) — defeating
  // this parser's own fail-closed "unknown key" and duplicate-key checks
  // upstream. `defineDataProperty` below uses Object.defineProperty, which
  // always defines an own data property directly and never invokes an
  // inherited setter, so every key — "__proto__" included — round-trips as
  // ordinary data. (Kept as a plain `{}` rather than a null-prototype
  // object so parsed values keep the shape existing consumers expect.)
  const obj = {};
  const seenKeys = new Set();
  let idx = startIdx;
  while (idx < lines.length && lines[idx].indent === indent) {
    const line = lines[idx];
    if (line.text.startsWith("- ") || line.text === "-") break; // end of this mapping
    const kv = splitKeyValue(line.text);
    if (!kv) {
      throw new YamlSyntaxError(`expected "key: value" or "key:", found: ${JSON.stringify(line.text)}`, {
        line: line.lineNo,
        path,
      });
    }
    const key = parseKeyScalar(kv.key, line.lineNo, path);
    if (seenKeys.has(key)) {
      throw new YamlSyntaxError(`duplicate key ${JSON.stringify(key)}`, { line: line.lineNo, path });
    }
    seenKeys.add(key);
    const valuePath = [...path, key];

    if (kv.rest.trim() === "") {
      idx++;
      const nested = parseBlock(lines, idx, indent + 2, valuePath);
      defineDataProperty(obj, key, nested.value);
      idx = nested.next;
      continue;
    }

    defineDataProperty(obj, key, parseScalar(kv.rest, line.lineNo, valuePath));
    idx++;
  }
  return { value: obj, next: idx };
}

/**
 * Parses `source` under the restricted YAML subset described above.
 * Throws YamlSyntaxError, naming the offending line and structural path, on
 * anything outside the subset. Never returns a partially-parsed value on
 * error and never silently coerces or warns.
 */
export function parseRestrictedYAML(source, { filename } = {}) {
  if (typeof source !== "string") {
    throw new TypeError("parseRestrictedYAML: source must be a string");
  }
  try {
    const lines = splitLines(source);
    if (lines.length === 0) return null;
    const result = parseBlock(lines, 0, lines[0].indent, []);
    if (result.next < lines.length) {
      const stray = lines[result.next];
      throw new YamlSyntaxError("unexpected indentation at document root", { line: stray.lineNo, path: [] });
    }
    return result.value;
  } catch (err) {
    if (err instanceof YamlSyntaxError && filename && err.filename === undefined) {
      err.filename = filename;
      err.message = `${filename}: ${err.message}`;
    }
    throw err;
  }
}
