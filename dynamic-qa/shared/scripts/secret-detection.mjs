// dynamic-qa/shared/scripts/secret-detection.mjs
//
// Deterministic "does this string value look like a secret?" detector for
// the Named Data Set contract (dynamic-qa-data-v1.schema.json,
// DESIGN-dynamic-qa-spec.md §5.2). The hard rule it exists to serve: a
// Named Data Set may reference an approved secret *handle* by name, but must
// never carry a secret *value* — repository-owned QA data must be safe to
// review and clone (SPEC-135.md user story 26).
//
// This module deliberately separates two very different kinds of rule:
//
//   EXACT (structural, no false-positive risk worth naming): a private-key
//   PEM header, a known vendor token prefix (AWS, GitHub, Slack, Stripe), an
//   HTTP Authorization "Bearer " prefix, and a URI with embedded
//   "user:pass@" credentials all have an unambiguous, documented shape. A
//   match on one of these is treated as certain.
//
//   HEURISTIC (named honestly as such, never presented as certain):
//     - the three-segment, dot-separated base64url shape used by JWTs is
//       extremely characteristic of a token, but an arbitrary opaque string
//       could coincidentally match it.
//     - generic high-entropy-opaque-string detection (long, no whitespace,
//       high Shannon entropy) is a genuine heuristic: it can false-positive
//       on a legitimately non-secret opaque identifier (a UUID, a hash used
//       as fixture data, etc.), and it can miss a low-entropy secret (a
//       predictable password). It exists as a backstop, not a proof, and
//       the fail-closed choice here is deliberate: given the security
//       invariant that repository-owned QA data must be safe to clone, a
//       false-positive rejection (an author has to rename/represent a field
//       differently) is the acceptable failure mode, never a false-negative
//       leak.
//
// This module only judges individual scalar string values. It does not know
// about field names, YAML structure, or the Named Data Set schema — that
// layering (which fields exist, which names are reserved for URLs/selectors/
// commands/adapter config) lives in named-data-set.mjs, which imports this.

const PRIVATE_KEY_HEADER_RE = /-----BEGIN\s+[A-Z0-9 ]*PRIVATE KEY-----/;

// Known vendor token prefixes. Exact: these prefixes are documented,
// published token formats, not a guess.
const VENDOR_TOKEN_PATTERNS = [
  { re: /^AKIA[0-9A-Z]{16}$/, label: "an AWS access key ID" },
  { re: /^ASIA[0-9A-Z]{16}$/, label: "an AWS temporary access key ID" },
  { re: /^gh[pousr]_[A-Za-z0-9]{20,}$/, label: "a GitHub token" },
  { re: /^github_pat_[A-Za-z0-9_]{20,}$/, label: "a GitHub fine-grained personal access token" },
  { re: /^xox[baprs]-[A-Za-z0-9-]{10,}$/, label: "a Slack token" },
  { re: /^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}$/, label: "a Stripe API key" },
  { re: /^AIza[0-9A-Za-z_-]{35}$/, label: "a Google API key" },
];

// scheme://user:pass@host — a connection string or URL with embedded
// credentials. Exact: the presence of "user:pass@" between the scheme and
// host is unambiguous syntax, not a guess about the string's purpose.
const CREDENTIALED_URI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/;

// HTTP Authorization header shape. Exact prefix match.
const BEARER_RE = /^Bearer\s+\S+$/i;

// JWT shape: header.payload.signature, each segment base64url. HEURISTIC —
// see header comment. Segments are required to be reasonably long so a
// short three-dot string (unlikely in practice) does not trip it.
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

// High-entropy opaque string. HEURISTIC — see header comment.
const HIGH_ENTROPY_MIN_LENGTH = 20;
const HIGH_ENTROPY_BITS_PER_CHAR = 3.5;
const OPAQUE_CANDIDATE_RE = /^[A-Za-z0-9+/_.=-]+$/; // no whitespace, no punctuation prose would use

function shannonEntropyBitsPerChar(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Judges one scalar string value. Returns null when nothing about it looks
 * like a secret, or a short human-readable reason string when it does.
 * Never throws; the caller decides how to surface the rejection.
 */
export function detectSecretValue(value) {
  if (typeof value !== "string" || value.length === 0) return null;

  if (PRIVATE_KEY_HEADER_RE.test(value)) {
    return "value contains a private-key header (exact match — private key material is always a secret value)";
  }

  for (const { re, label } of VENDOR_TOKEN_PATTERNS) {
    if (re.test(value.trim())) {
      return `value matches the published shape of ${label} (exact match)`;
    }
  }

  if (CREDENTIALED_URI_RE.test(value.trim())) {
    return "value is a URI with embedded \"user:pass@\" credentials (exact match — this is a connection string carrying a secret, not case data)";
  }

  if (BEARER_RE.test(value.trim())) {
    return 'value has the "Bearer <token>" HTTP Authorization shape (exact match)';
  }

  if (JWT_SHAPE_RE.test(value.trim())) {
    return "value has the three-segment dot-separated base64url shape of a JWT (heuristic: this shape is highly characteristic of a token but not cryptographically confirmed)";
  }

  const trimmed = value.trim();
  if (
    trimmed.length >= HIGH_ENTROPY_MIN_LENGTH &&
    OPAQUE_CANDIDATE_RE.test(trimmed) &&
    shannonEntropyBitsPerChar(trimmed) >= HIGH_ENTROPY_BITS_PER_CHAR
  ) {
    return (
      "value is a long, high-entropy opaque string, a common shape for an API key/token/password " +
      "(heuristic: may false-positive on a legitimately non-secret opaque identifier such as a UUID or " +
      "content hash — if this value is genuinely not a secret, prefer a shorter or more structured " +
      "representation, or move it out of the Named Data Set)"
    );
  }

  return null;
}
