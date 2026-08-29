// dynamic-qa/shared/scripts/repo-walk.mjs
//
// A strictly read-only repository walker for Setup Inventory scanning
// (stage 2, ticket #162). This module imports ONLY the read side of
// node:fs (directory listing, file stat, file read, existence check) — it
// never imports any mutating (write/create/delete/rename/permission-change)
// function, so "discovery never writes" is a property of what this file can
// even reach, not merely a runtime check. Callers scanning a repository
// (real or fixture) should build their facts from these primitives rather
// than touching node:fs directly, so the read-only boundary has exactly one
// place to audit. (See repo-walk.test.mjs for the automated check that this
// file's own source never names one of those mutating functions.)

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Directories never worth descending into: version control internals,
// dependency trees, and build output. Skipping them also keeps a scan over
// a real repository fast.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".venv",
  "__pycache__",
]);

// walkFiles(root) -> string[] of paths relative to root, using '/'
// separators regardless of platform, sorted for deterministic output.
export function walkFiles(root) {
  const out = [];
  const stack = ["."];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: report nothing for it rather than crash the scan
    }
    for (const entry of entries) {
      const entryRel = rel === "." ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(entryRel);
      } else if (entry.isFile()) {
        out.push(entryRel);
      }
      // symlinks are deliberately neither followed nor reported: a scan must
      // never be tricked into reading outside the repository root.
    }
  }
  return out.sort();
}

// readTextFile(root, relPath) -> string | null. Returns null (never throws)
// when the file is absent or unreadable, so a scanner can probe optimistically.
export function readTextFile(root, relPath) {
  const abs = path.join(root, relPath);
  try {
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// fileExists(root, relPath) -> boolean, read-only probe.
export function fileExists(root, relPath) {
  return existsSync(path.join(root, relPath));
}

// statOf(root, relPath) -> fs.Stats | null
export function statOf(root, relPath) {
  try {
    return statSync(path.join(root, relPath));
  } catch {
    return null;
  }
}
