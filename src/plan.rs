//! `vibesync plan <pair>`: a read-only Dry-run diff (ADR-0003). A full scan
//! of both trees is compared by size + mtime (the documented no-index /
//! no-FSEvents / no-rename-detection trade-off), then grouped by operation
//! and printed summary-first.
//!
//! The seam is deliberately split: [`compute`] and [`render`] are pure over
//! already-scanned trees, so mode semantics, machinery exclusion, and the
//! symlink→exFAT error row are testable without touching real volumes;
//! [`scan`] and [`run`] hold the filesystem and CLI edges.
//!
//! Everything here is strictly read-only — `plan` never writes to the
//! source or destination.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::config::{self, Mode};
use crate::error::AppError;
use crate::volume;

/// Where archived old versions would go. A Dry-run has no Run id yet (a Run
/// id is only minted when a run actually starts, per CONTEXT.md), so the
/// annotation uses a placeholder rather than inventing a timestamp.
const SAFETYNET_NOTE: &str = "→ _SafetyNet/<run-id>/";

/// A single scanned file (or symlink). Directories are traversed but never
/// themselves an [`Entry`] — the plan operates at file granularity.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub size: u64,
    pub mtime: SystemTime,
    pub is_symlink: bool,
}

/// One planned file operation, carrying what the human diff row shows. The
/// operation itself (copy/update/delete) is encoded by which [`Plan`] vector
/// the action lives in, so it isn't repeated as a field here.
#[derive(Debug, Clone, PartialEq)]
pub struct Action {
    pub rel_path: PathBuf,
    pub bytes: u64,
    /// Size of the destination version being replaced or archived, if any.
    pub old_bytes: Option<u64>,
    pub reason: String,
}

/// A per-file plan error — surfaced as an ERRORS row rather than crashing
/// the whole plan (e.g. a symlink bound for an exFAT destination).
#[derive(Debug, Clone, PartialEq)]
pub struct PlanError {
    pub rel_path: PathBuf,
    pub message: String,
}

/// The computed Dry-run diff for one Folder pair.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub copies: Vec<Action>,
    pub updates: Vec<Action>,
    pub deletes: Vec<Action>,
    pub errors: Vec<PlanError>,
    /// Total files examined across both trees (union of relative paths).
    pub scanned: usize,
    /// Files identical on both sides (same size and mtime).
    pub unchanged: usize,
    /// Rows removed by `--exclude`.
    pub excluded: usize,
    /// Files found under the source and destination before filtering. These
    /// counts are precondition inputs, not presentation rows.
    pub source_entries: usize,
    pub destination_entries: usize,
    /// Sibling dot-temps left by an interrupted run. They are never sync
    /// content, but read commands report them and a real run cleans them.
    pub strays: Vec<PathBuf>,
}

/// Is `name` sync machinery the scanner must never treat as content?
///
/// `_SafetyNet/` is the archive tree; `.*.vibesync-tmp-*` are in-flight
/// Publish temps. Neither is ever synced, and neither is ever planned for
/// deletion (invariant I5) — skipping them here is what makes that true on
/// both the source and destination side.
fn is_machinery(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name == "_SafetyNet"
        || (name.starts_with('.')
            && (name.contains(".vibesync-tmp-") || name.starts_with("._vibesync-run-")))
}

/// Recursively collects every file and symlink under `root`, keyed by path
/// relative to `root`, skipping machinery. `BTreeMap` keeps the output
/// deterministically sorted. Symlinks are recorded via `symlink_metadata`
/// (never followed), so a symlinked directory is one entry, not a subtree.
fn scan(root: &Path) -> io::Result<BTreeMap<PathBuf, Entry>> {
    let mut map = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if is_machinery(&entry.file_name()) {
                continue;
            }

            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            let file_type = meta.file_type();

            if file_type.is_dir() {
                stack.push(path);
                continue;
            }

            let rel = path
                .strip_prefix(root)
                .expect("read_dir path is under root")
                .to_path_buf();
            map.insert(
                rel,
                Entry {
                    size: meta.len(),
                    mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    is_symlink: file_type.is_symlink(),
                },
            );
        }
    }

    Ok(map)
}

/// Walks user content without retaining it.  This is the streaming seam for
/// `plan --json`; callers receive each source entry before the next one is
/// read, while the scanner keeps machinery invisible on both surfaces.
fn walk_entries(
    root: &Path,
    mut visit: impl FnMut(PathBuf, Entry) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|error| scan_error(root, error))?;
        for entry in entries {
            let entry = entry.map_err(|error| scan_error(root, error))?;
            if is_machinery(&entry.file_name()) {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| scan_error(root, error))?;
            let file_type = metadata.file_type();
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            let rel_path = path
                .strip_prefix(root)
                .expect("read_dir path is under root")
                .to_path_buf();
            visit(
                rel_path,
                Entry {
                    size: metadata.len(),
                    mtime: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    is_symlink: file_type.is_symlink(),
                },
            )?;
        }
    }
    Ok(())
}

/// Computes the Dry-run diff. Pure over the two scanned trees:
///
/// - source-only file → COPY;
/// - present on both, differing by type/size/mtime → UPDATE;
/// - present on both and identical → unchanged (counted, not listed);
/// - destination-only file → DELETE in Mirror, nothing in Update (Update
///   never plans a removal, per CONTEXT.md);
/// - a symlink whose destination can't store it (`!supports_symlinks`) →
///   an ERRORS row instead of a COPY/UPDATE.
///
/// `excludes` are exact relative-path strings (as the diff prints them,
/// ADR-0004); a matching candidate is dropped and counted in `excluded`.
pub fn compute(
    source: &BTreeMap<PathBuf, Entry>,
    dest: &BTreeMap<PathBuf, Entry>,
    mode: Mode,
    supports_symlinks: bool,
    excludes: &[String],
) -> Plan {
    // `scanned` is the count of files the plan actually reasons about, so
    // the closing totals reconcile. Every source file lands in exactly one
    // outcome (copy / update / unchanged / excluded / error). Destination-
    // only files are additional outcomes in Mirror (delete / excluded) but
    // are outside Update's consideration entirely, so they're only counted
    // in Mirror mode.
    let dest_only = || dest.keys().filter(|p| !source.contains_key(*p)).count();
    let mut plan = Plan {
        scanned: source.len() + if mode == Mode::Mirror { dest_only() } else { 0 },
        source_entries: source.len(),
        destination_entries: dest.len(),
        ..Plan::default()
    };
    let is_excluded = |rel: &Path| excludes.iter().any(|e| Path::new(e) == rel);

    for (rel, src) in source {
        if is_excluded(rel) {
            plan.excluded += 1;
            continue;
        }

        if src.is_symlink && !supports_symlinks {
            plan.errors.push(PlanError {
                rel_path: rel.clone(),
                message: "symlink not supported on exFAT destination".to_string(),
            });
            continue;
        }

        match dest.get(rel) {
            None => plan.copies.push(Action {
                rel_path: rel.clone(),
                bytes: src.size,
                old_bytes: None,
                reason: "new".to_string(),
            }),
            Some(dst) => {
                if let Some(reason) = change_reason(src, dst) {
                    plan.updates.push(Action {
                        rel_path: rel.clone(),
                        bytes: src.size,
                        old_bytes: Some(dst.size),
                        reason: reason.to_string(),
                    });
                } else {
                    plan.unchanged += 1;
                }
            }
        }
    }

    // Removals are Mirror-only. In Update nothing at the destination is
    // ever planned for removal, so the DELETE pass is skipped entirely.
    if mode == Mode::Mirror {
        for (rel, dst) in dest {
            if source.contains_key(rel) {
                continue;
            }
            if is_excluded(rel) {
                plan.excluded += 1;
                continue;
            }
            plan.deletes.push(Action {
                rel_path: rel.clone(),
                bytes: dst.size,
                old_bytes: Some(dst.size),
                reason: "not in source".to_string(),
            });
        }
    }

    plan
}

/// Why a file present on both sides needs an UPDATE, or `None` if it is
/// unchanged. Size is the cheap, decisive signal; mtime catches
/// same-size edits (with the documented cross-filesystem granularity risk).
fn change_reason(src: &Entry, dst: &Entry) -> Option<&'static str> {
    if src.is_symlink != dst.is_symlink {
        Some("type changed")
    } else if src.size != dst.size {
        Some("size differs")
    } else if src.mtime != dst.mtime {
        Some("modified")
    } else {
        None
    }
}

/// Renders the plan as the summary-first, operation-grouped human diff with
/// the fixed `N copy · N update · N delete · N error` header and all four
/// COPY/UPDATE/DELETE/ERRORS sections (ADR-0003). The header and sections
/// are the same in both modes — Update simply always reports `0 delete` and
/// an empty DELETE section, which is exactly its "never removes" guarantee
/// made visible; the mode word in the title distinguishes them.
pub fn render(plan: &Plan, pair_name: &str, mode: Mode) -> String {
    let mut out = String::new();

    out.push_str(&format!(
        "Dry-run for '{}' ({}): {} copy · {} update · {} delete · {} error\n\n",
        pair_name,
        mode,
        plan.copies.len(),
        plan.updates.len(),
        plan.deletes.len(),
        plan.errors.len(),
    ));

    let path_width = plan
        .copies
        .iter()
        .chain(&plan.updates)
        .chain(&plan.deletes)
        .map(|a| a.rel_path.display().to_string().len())
        .chain(
            plan.errors
                .iter()
                .map(|e| e.rel_path.display().to_string().len()),
        )
        .max()
        .unwrap_or(0)
        .clamp(8, 60);

    push_actions(&mut out, "COPY", &plan.copies, None, path_width);
    push_actions(
        &mut out,
        "UPDATE",
        &plan.updates,
        Some(SAFETYNET_NOTE),
        path_width,
    );
    push_actions(
        &mut out,
        "DELETE",
        &plan.deletes,
        Some(SAFETYNET_NOTE),
        path_width,
    );
    push_errors(&mut out, &plan.errors, path_width);
    push_strays(&mut out, &plan.strays);

    out.push_str(&format!(
        "Scanned {} · unchanged {} · excluded {}\n",
        plan.scanned, plan.unchanged, plan.excluded
    ));
    out
}

fn push_strays(out: &mut String, strays: &[PathBuf]) {
    out.push_str(&format!("Stray temps ({})\n", strays.len()));
    for stray in strays {
        out.push_str(&format!("  {}\n", stray.display()));
    }
    out.push('\n');
}

fn push_actions(out: &mut String, name: &str, rows: &[Action], note: Option<&str>, width: usize) {
    match note {
        Some(note) => out.push_str(&format!("{} ({}) {}\n", name, rows.len(), note)),
        None => out.push_str(&format!("{} ({})\n", name, rows.len())),
    }
    for row in rows {
        out.push_str(&format!(
            "  {:<width$}  {:>9}  {}\n",
            row.rel_path.display().to_string(),
            human_size(row.bytes),
            row.reason,
            width = width,
        ));
    }
    out.push('\n');
}

fn push_errors(out: &mut String, rows: &[PlanError], width: usize) {
    out.push_str(&format!("ERRORS ({})\n", rows.len()));
    for row in rows {
        out.push_str(&format!(
            "  {:<width$}  {}\n",
            row.rel_path.display().to_string(),
            row.message,
            width = width,
        ));
    }
    out.push('\n');
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    format!("{size:.1} {}", UNITS[unit])
}

/// Orchestrates a `plan` invocation: resolve the pair, scan both trees,
/// detect whether the destination can hold symlinks, compute the diff, and
/// print it. Read-only throughout.
///
/// A missing source aborts (exit 2): planning against a vanished/unmounted
/// source would render the whole destination as deletions, exactly the
/// blast radius we refuse to imply. A missing destination is fine — it just
/// reads as empty (a first sync), so everything plans as COPY.
pub fn run(config_path: &Path, pair_name: &str, excludes: &[String]) -> Result<i32, AppError> {
    let (pair, plan) = build(config_path, pair_name, excludes)?;
    print!("{}", render(&plan, pair_name, pair.mode));
    Ok(crate::error::EXIT_OK)
}

/// Emits the agent-facing Dry-run stream.  Each record is written and
/// flushed independently so consumers can process rows as soon as planning
/// has produced them; stdout contains NDJSON only (ADR-0003/0004).
///
/// A plan is deliberately not a Run: it gets an ephemeral `plan_id` rather
/// than a journal/SafetyNet Run id.
pub fn run_json(config_path: &Path, pair_name: &str, excludes: &[String]) -> Result<i32, AppError> {
    let cfg = config::load(config_path)?;
    let configured_pair = cfg
        .pairs
        .get(pair_name)
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))?;
    let (pair, notices) = crate::preconditions::resolve_pair(configured_pair)?;
    for notice in notices {
        eprintln!("{notice}");
    }
    if !pair.source.is_dir() {
        return Err(AppError::Precondition(format!(
            "{}: source directory not found (is the volume mounted?)",
            pair.source.display()
        )));
    }

    let plan_id = plan_id();
    let mut stdout = io::stdout().lock();

    emit(
        &mut stdout,
        json!({
            "schema": "vibefilesync.plan/v1",
            "type": "plan_start",
            "plan_id": plan_id,
            "pair": pair_name,
            "mode": pair.mode.to_string(),
            "dry_run": true,
        }),
    )?;

    let dest_exists = pair.destination.is_dir();
    let destination = if dest_exists {
        scan(&pair.destination).map_err(|error| scan_error(&pair.destination, error))?
    } else {
        BTreeMap::new()
    };
    let supports_symlinks = if dest_exists {
        match volume::filesystem_type(&pair.destination) {
            Ok(filesystem) => !filesystem.eq_ignore_ascii_case("exfat"),
            Err(_) => true,
        }
    } else {
        true
    };

    // Hold only the destination index and the source paths already seen.
    // Source actions are emitted by the walk itself rather than collected in
    // a Plan, so an agent can consume a large source tree incrementally.
    let mut source_paths = BTreeSet::new();
    let mut source_entries = 0_usize;
    let mut copies = 0_usize;
    let mut updates = 0_usize;
    let mut deletes = 0_usize;
    let mut errors = 0_usize;
    let mut unchanged = 0_usize;
    let mut excluded = 0_usize;
    walk_entries(&pair.source, |rel_path, source| {
        source_entries += 1;
        source_paths.insert(rel_path.clone());
        if excludes
            .iter()
            .any(|exclude| Path::new(exclude) == rel_path)
        {
            excluded += 1;
            return Ok(());
        }
        if source.is_symlink && !supports_symlinks {
            errors += 1;
            return emit(
                &mut stdout,
                json!({
                    "schema": "vibefilesync.plan/v1",
                    "type": "action",
                    "plan_id": plan_id,
                    "op": "error",
                    "path": path_text(&rel_path),
                    "reason": "symlink not supported on exFAT destination",
                }),
            );
        }
        match destination.get(&rel_path) {
            None => {
                copies += 1;
                emit(
                    &mut stdout,
                    json!({
                        "schema": "vibefilesync.plan/v1",
                        "type": "action",
                        "plan_id": plan_id,
                        "op": "copy",
                        "path": path_text(&rel_path),
                        "reason": "new",
                        "bytes": source.size,
                    }),
                )
            }
            Some(destination) => match change_reason(&source, destination) {
                Some(reason) => {
                    updates += 1;
                    emit(
                        &mut stdout,
                        json!({
                            "schema": "vibefilesync.plan/v1",
                            "type": "action",
                            "plan_id": plan_id,
                            "op": "update",
                            "path": path_text(&rel_path),
                            "reason": reason,
                            "bytes": source.size,
                            "old_bytes": destination.size,
                            "safety_net": format!("_SafetyNet/<run-id>/{}", path_text(&rel_path)),
                        }),
                    )
                }
                None => {
                    unchanged += 1;
                    Ok(())
                }
            },
        }
    })?;

    let mut destination_only = 0_usize;
    if pair.mode == Mode::Mirror {
        for (rel_path, destination) in &destination {
            if source_paths.contains(rel_path) {
                continue;
            }
            destination_only += 1;
            if excludes
                .iter()
                .any(|exclude| Path::new(exclude) == rel_path)
            {
                excluded += 1;
                continue;
            }
            deletes += 1;
            emit(
                &mut stdout,
                json!({
                    "schema": "vibefilesync.plan/v1",
                    "type": "action",
                    "plan_id": plan_id,
                    "op": "delete",
                    "path": path_text(rel_path),
                    "reason": "not in source",
                    "bytes": destination.size,
                    "old_bytes": destination.size,
                    "safety_net": format!("_SafetyNet/<run-id>/{}", path_text(rel_path)),
                }),
            )?;
        }
    }

    let strays =
        stray_temps(&pair.destination).map_err(|error| scan_error(&pair.destination, error))?;
    for stray in &strays {
        emit(
            &mut stdout,
            json!({
                "schema": "vibefilesync.plan/v1",
                "type": "action",
                "plan_id": plan_id,
                "op": "cleanup",
                "path": path_text(stray),
                "reason": "abandoned temp",
                "bytes": fs::metadata(pair.destination.join(stray)).map(|metadata| metadata.len()).unwrap_or(0),
            }),
        )?;
    }
    emit(
        &mut stdout,
        json!({
            "schema": "vibefilesync.plan/v1",
            "type": "summary",
            "plan_id": plan_id,
            "counts": {
                "copy": copies,
                "update": updates,
                "delete": deletes,
                "error": errors,
                "cleanup": strays.len(),
                "scanned": source_entries + destination_only,
                "unchanged": unchanged,
                "excluded": excluded,
            },
        }),
    )?;
    Ok(crate::error::EXIT_OK)
}

fn plan_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch");
    format!("plan-{}-{:09}", now.as_secs(), now.subsec_nanos())
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn emit(output: &mut impl Write, event: serde_json::Value) -> Result<(), AppError> {
    serde_json::to_writer(&mut *output, &event)
        .map_err(|error| AppError::Precondition(error.to_string()))?;
    output.write_all(b"\n").map_err(scan_error_for_stdout)?;
    output.flush().map_err(scan_error_for_stdout)
}

fn scan_error_for_stdout(error: io::Error) -> AppError {
    AppError::Precondition(format!("could not write JSON output: {error}"))
}

/// Builds a fresh plan for the CLI edges which need to render it and then
/// act on exactly the reviewed COPY rows. The scan remains owned by this
/// module; callers receive no filesystem internals.
pub(crate) fn build(
    config_path: &Path,
    pair_name: &str,
    excludes: &[String],
) -> Result<(config::Pair, Plan), AppError> {
    let cfg = config::load(config_path)?;
    let pair = cfg
        .pairs
        .get(pair_name)
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))?;
    let (pair, notices) = crate::preconditions::resolve_pair(pair)?;
    for notice in notices {
        eprintln!("{notice}");
    }

    if !pair.source.is_dir() {
        return Err(AppError::Precondition(format!(
            "{}: source directory not found (is the volume mounted?)",
            pair.source.display()
        )));
    }

    let source = scan(&pair.source).map_err(|e| scan_error(&pair.source, e))?;

    let dest_exists = pair.destination.is_dir();
    let dest = if dest_exists {
        scan(&pair.destination).map_err(|e| scan_error(&pair.destination, e))?
    } else {
        BTreeMap::new()
    };

    // exFAT can't store symlinks; a source symlink bound for it is a
    // per-file plan error. If the destination doesn't exist yet, or its
    // filesystem can't be determined, assume symlinks are fine rather than
    // manufacturing errors.
    let supports_symlinks = if dest_exists {
        match volume::filesystem_type(&pair.destination) {
            Ok(fs) => !fs.eq_ignore_ascii_case("exfat"),
            Err(_) => true,
        }
    } else {
        true
    };

    let mut plan = compute(&source, &dest, pair.mode, supports_symlinks, excludes);
    plan.strays = stray_temps(&pair.destination).map_err(|e| scan_error(&pair.destination, e))?;
    Ok((pair, plan))
}

/// Lists abandoned sibling Publish temps without treating them as sync
/// content. This is intentionally read-only so `plan` and `status` are safe
/// at any time; only a real run removes the returned paths.
pub(crate) fn stray_temps(root: &Path) -> io::Result<Vec<PathBuf>> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut strays = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.file_name() == "_SafetyNet" {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_dir() {
                stack.push(path);
            } else if is_stray_temp(&entry.file_name()) {
                strays.push(
                    path.strip_prefix(root)
                        .expect("entry is under root")
                        .to_path_buf(),
                );
            }
        }
    }
    strays.sort();
    Ok(strays)
}

fn is_stray_temp(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('.') && name.contains(".vibesync-tmp-")
}

fn scan_error(path: &Path, source: io::Error) -> AppError {
    AppError::Precondition(format!("{}: {}", path.display(), source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn file(size: u64, mtime_secs: u64) -> Entry {
        Entry {
            size,
            mtime: at(mtime_secs),
            is_symlink: false,
        }
    }

    fn link(size: u64) -> Entry {
        Entry {
            size,
            mtime: at(0),
            is_symlink: true,
        }
    }

    fn tree(entries: &[(&str, Entry)]) -> BTreeMap<PathBuf, Entry> {
        entries
            .iter()
            .map(|(p, e)| (PathBuf::from(p), e.clone()))
            .collect()
    }

    #[test]
    fn mirror_classifies_copy_update_delete_and_unchanged() {
        let source = tree(&[
            ("new.txt", file(10, 100)),
            ("same.txt", file(20, 200)),
            ("bigger.txt", file(40, 300)),
        ]);
        let dest = tree(&[
            ("same.txt", file(20, 200)),
            ("bigger.txt", file(30, 300)), // size differs -> update
            ("gone.txt", file(5, 50)),     // dest-only -> delete
        ]);

        let plan = compute(&source, &dest, Mode::Mirror, true, &[]);

        assert_eq!(plan.copies.len(), 1);
        assert_eq!(plan.copies[0].rel_path, PathBuf::from("new.txt"));
        assert_eq!(plan.updates.len(), 1);
        assert_eq!(plan.updates[0].rel_path, PathBuf::from("bigger.txt"));
        assert_eq!(plan.updates[0].reason, "size differs");
        assert_eq!(plan.deletes.len(), 1);
        assert_eq!(plan.deletes[0].rel_path, PathBuf::from("gone.txt"));
        assert_eq!(plan.unchanged, 1);
        assert!(plan.errors.is_empty());
    }

    #[test]
    fn same_size_different_mtime_is_an_update() {
        let source = tree(&[("edited.txt", file(20, 500))]);
        let dest = tree(&[("edited.txt", file(20, 200))]);

        let plan = compute(&source, &dest, Mode::Mirror, true, &[]);
        assert_eq!(plan.updates.len(), 1);
        assert_eq!(plan.updates[0].reason, "modified");
        assert_eq!(plan.unchanged, 0);
    }

    #[test]
    fn update_mode_never_plans_a_deletion() {
        let source = tree(&[("new.txt", file(10, 100))]);
        let dest = tree(&[("gone.txt", file(5, 50)), ("also-gone.txt", file(6, 60))]);

        let plan = compute(&source, &dest, Mode::Update, true, &[]);

        assert_eq!(plan.copies.len(), 1);
        assert!(
            plan.deletes.is_empty(),
            "Update must never plan a removal: {:?}",
            plan.deletes
        );
    }

    #[test]
    fn symlink_to_exfat_destination_is_an_error_row_not_a_copy() {
        let source = tree(&[("link", link(12)), ("regular.txt", file(10, 100))]);
        let dest = BTreeMap::new();

        let plan = compute(
            &source,
            &dest,
            Mode::Mirror,
            /* supports_symlinks */ false,
            &[],
        );

        assert_eq!(plan.errors.len(), 1);
        assert_eq!(plan.errors[0].rel_path, PathBuf::from("link"));
        assert!(plan.errors[0].message.contains("exFAT"));
        // The symlink is NOT planned as a copy; the regular file still is.
        assert_eq!(plan.copies.len(), 1);
        assert_eq!(plan.copies[0].rel_path, PathBuf::from("regular.txt"));
    }

    #[test]
    fn symlink_to_capable_destination_is_planned_normally() {
        let source = tree(&[("link", link(12))]);
        let dest = BTreeMap::new();

        let plan = compute(&source, &dest, Mode::Mirror, true, &[]);
        assert!(plan.errors.is_empty());
        assert_eq!(plan.copies.len(), 1);
    }

    #[test]
    fn exclude_drops_a_row_and_counts_it() {
        let source = tree(&[("keep.txt", file(10, 100)), ("skip.txt", file(10, 100))]);
        let dest = BTreeMap::new();

        let plan = compute(
            &source,
            &dest,
            Mode::Mirror,
            true,
            &["skip.txt".to_string()],
        );

        assert_eq!(plan.copies.len(), 1);
        assert_eq!(plan.copies[0].rel_path, PathBuf::from("keep.txt"));
        assert_eq!(plan.excluded, 1);
    }

    #[test]
    fn exclude_can_drop_a_deletion() {
        let source = BTreeMap::new();
        let dest = tree(&[("gone.txt", file(5, 50))]);

        let plan = compute(
            &source,
            &dest,
            Mode::Mirror,
            true,
            &["gone.txt".to_string()],
        );
        assert!(plan.deletes.is_empty());
        assert_eq!(plan.excluded, 1);
    }

    #[test]
    fn render_totals_and_safetynet_notes_for_mirror() {
        let source = tree(&[("new.txt", file(10, 100)), ("chg.txt", file(40, 300))]);
        let dest = tree(&[("chg.txt", file(30, 300)), ("gone.txt", file(5, 50))]);
        let plan = compute(&source, &dest, Mode::Mirror, true, &[]);

        let out = render(&plan, "photos", Mode::Mirror);

        assert!(out
            .starts_with("Dry-run for 'photos' (mirror): 1 copy · 1 update · 1 delete · 0 error"));
        assert!(out.contains("COPY (1)"));
        // SafetyNet note appears on the UPDATE and DELETE section headers.
        assert!(out.contains(&format!("UPDATE (1) {SAFETYNET_NOTE}")));
        assert!(out.contains(&format!("DELETE (1) {SAFETYNET_NOTE}")));
        assert!(out.contains("ERRORS (0)"));
        assert!(out.contains("Scanned 3 · unchanged 0 · excluded 0"));
    }

    #[test]
    fn render_shows_an_empty_delete_section_in_update_mode() {
        // ADR-0003's header is fixed at four parts and lists all four
        // sections; Update proves its "never removes" guarantee by always
        // reporting DELETE (0), not by hiding the section.
        let source = tree(&[("new.txt", file(10, 100))]);
        let dest = tree(&[("gone.txt", file(5, 50))]);
        let plan = compute(&source, &dest, Mode::Update, true, &[]);

        let out = render(&plan, "docs", Mode::Update);

        assert!(
            out.contains("0 delete"),
            "totals keep the fixed four parts: {out}"
        );
        assert!(
            out.contains("DELETE (0)"),
            "DELETE section still prints, empty: {out}"
        );
        assert!(
            !out.contains("gone.txt"),
            "no dest-only file is ever a delete row: {out}"
        );
        assert!(out.contains("COPY (1)"));
        // Update considers only the source side, so scanned excludes the
        // destination-only file and the totals still reconcile.
        assert!(
            out.contains("Scanned 1 · unchanged 0 · excluded 0"),
            "{out}"
        );
    }

    #[test]
    fn human_size_formats_bytes_and_scaled_units() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1024), "1.0 KB");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(1024 * 1024), "1.0 MB");
    }

    #[test]
    fn machinery_names_are_recognized() {
        assert!(is_machinery(OsStr::new("_SafetyNet")));
        assert!(is_machinery(OsStr::new(".photo.jpg.vibesync-tmp-abc123")));
        assert!(is_machinery(OsStr::new("._vibesync-run-20260716T120000Z")));
        assert!(!is_machinery(OsStr::new("_SafetyNetworkNotes")));
        assert!(!is_machinery(OsStr::new("vibesync-tmp-visible")));
        assert!(!is_machinery(OsStr::new("regular.txt")));
    }
}
