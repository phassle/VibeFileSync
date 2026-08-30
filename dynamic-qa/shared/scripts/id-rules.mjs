// dynamic-qa/shared/scripts/id-rules.mjs
//
// Shared identifier rules for the deterministic core. Flow, step, outcome,
// boundary, and (later) Named Data Set / Execution Profile IDs are all
// semantic, kebab-case, human-authored names — never derived from an issue
// number, never reused, never renamed once assigned (per DESIGN-dynamic-qa-spec.md
// §5.1 and the run brief). This module exists so every schema-shaped module
// (flow-definition.mjs today; the Named Data Set / Execution Profile
// validators #144/#145 add later) checks IDs the same way instead of each
// inventing its own regex.

// Maximum length of a semantic id (finding #2, closed). #170 confirmed
// SEMANTIC_ID_RE previously had no length cap at all: a 300-character
// lowercase branch name was accepted and would reach a filename
// (`${id}.yaml`, see setup-review-packet.mjs / resolve-data-sets.mjs /
// preflight.mjs / drift-gate-cli.mjs) unbounded. The character set was
// already safe (no path separators, no traversal sequences), so this is not
// a directory-escape risk — it is an unbounded-length, fully
// attacker-controlled string reaching a filesystem path.
//
// 100 was chosen, not an arbitrary round number picked for its own sake:
// common filesystems (ext4, APFS, NTFS) cap a single path component at 255
// bytes. This id is always used as `${id}.yaml` or `${id}.json` — a 5-byte
// suffix at most in this bundle today — so 100 leaves well over 100 bytes
// of headroom for that suffix plus any future prefix/suffix a caller adds
// (a revision marker, a nested directory segment, a `-review` suffix, etc.)
// without ever approaching the real filesystem limit, while still being
// generously long enough for a genuinely human-authored, readable kebab-case
// name (no legitimate Flow/Boundary/Outcome/Data-Set id in this bundle's own
// fixtures exceeds a small fraction of it).
export const MAX_SEMANTIC_ID_LENGTH = 100;

// Lowercase letters/digits, hyphen-separated words, no leading/trailing or
// doubled hyphens, no leading digit, at most MAX_SEMANTIC_ID_LENGTH
// characters (the leading lookahead bounds total length before the shape is
// matched). Deliberately excludes underscores and uppercase so an ID can
// double as a filename on any filesystem.
export const SEMANTIC_ID_RE = new RegExp(`^(?=.{1,${MAX_SEMANTIC_ID_LENGTH}}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$`);

export function isValidSemanticId(value) {
  return typeof value === "string" && SEMANTIC_ID_RE.test(value);
}

export function assertValidSemanticId(value, label) {
  if (!isValidSemanticId(value)) {
    throw new Error(
      `${label} must be a semantic kebab-case identifier matching ${SEMANTIC_ID_RE} (got ${JSON.stringify(value)})`,
    );
  }
}
