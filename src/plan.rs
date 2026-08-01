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
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::{self, Mode};
use crate::error::AppError;
use crate::volume;

/// Where archived old versions would go. A Dry-run has no Run id yet (a Run
/// id is only minted when a run actually starts, per CONTEXT.md), so the
/// annotation uses a placeholder rather than inventing a timestamp.
pub(crate) const SAFETYNET_NOTE: &str = "→ _SafetyNet/<run-id>/";

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
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StructuralConflict {
    DestinationFile,
    DestinationDirectory,
}

impl StructuralConflict {
    pub(crate) fn has_dependent_copy(self, deletion: &Path, copy: &Path) -> bool {
        match self {
            Self::DestinationDirectory => copy == deletion,
            Self::DestinationFile => copy.starts_with(deletion),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Action {
    pub rel_path: PathBuf,
    pub bytes: u64,
    pub source_mtime: Option<SystemTime>,
    pub old_bytes: Option<u64>,
    pub reason: String,
    pub structural_conflict: Option<StructuralConflict>,
}

/// A per-file plan error — surfaced as an ERRORS row rather than crashing
/// the whole plan (e.g. a symlink bound for an exFAT destination).
#[derive(Debug, Clone, PartialEq)]
pub struct PlanError {
    pub rel_path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum PlanOperation {
    Copy,
    Update,
    Delete,
    Cleanup,
    Error,
}

#[derive(Debug)]
enum SourceClassification {
    Action(PlanOperation, Action),
    Error(PlanError),
    Excluded,
    Unchanged,
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
    /// Requested exclusions that did not name an action row in this plan.
    /// They remain non-fatal so a script can safely reuse a filtered list,
    /// but are reported to make a typo or a stale plan visible.
    pub unknown_excludes: Vec<String>,
    /// Files found under the source and destination before filtering. These
    /// counts are precondition inputs, not presentation rows.
    pub source_entries: usize,
    pub destination_entries: usize,
    /// Sibling dot-temps left by an interrupted run. They are never sync
    /// content, but read commands report them and a real run cleans them.
    pub strays: Vec<PathBuf>,
    pub directory_copies: BTreeSet<PathBuf>,
    pub directory_deletes: BTreeSet<PathBuf>,
}

/// Is `name` sync machinery the scanner must never treat as content?
///
/// `_SafetyNet/` is the archive tree; `.*.vibesync-tmp-*` are in-flight
/// Publish temps. Neither is ever synced, and neither is ever planned for
/// deletion (invariant I5). AppleDouble files require content-aware handling
/// because `._notes` can also be a legitimate user filename.
fn is_machinery(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name == "_SafetyNet"
        || (name.starts_with('.')
            && (name.contains(".vibesync-tmp-") || name.starts_with("._vibesync-run-")))
}

fn is_apple_double(path: &Path, name: &OsStr) -> bool {
    if !name.to_string_lossy().starts_with("._") {
        return false;
    }
    let mut magic = [0_u8; 4];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
        && magic == [0x00, 0x05, 0x16, 0x07]
}

/// Recursively collects every file and symlink under `root`, keyed by path
/// relative to `root`, skipping machinery. `BTreeMap` keeps the output
/// deterministically sorted. Symlinks are recorded via `symlink_metadata`
/// (never followed), so a symlinked directory is one entry, not a subtree.
fn scan(root: &Path, skip_apple_double: bool) -> io::Result<BTreeMap<PathBuf, Entry>> {
    let mut entries = BTreeMap::new();
    walk(root, skip_apple_double, |path, entry| {
        entries.insert(path.to_path_buf(), entry.clone());
        Ok(())
    })?;
    Ok(entries)
}

fn scan_directories(root: &Path) -> io::Result<BTreeSet<PathBuf>> {
    let mut directories = BTreeSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let mut entries: Vec<_> = fs::read_dir(&directory)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries.into_iter().rev() {
            if is_machinery(&entry.file_name()) {
                continue;
            }
            let path = entry.path();
            if fs::symlink_metadata(&path)?.file_type().is_dir() {
                directories.insert(
                    path.strip_prefix(root)
                        .expect("read_dir path is under root")
                        .to_path_buf(),
                );
                stack.push(path);
            }
        }
    }
    Ok(directories)
}

fn walk(
    root: &Path,
    skip_apple_double: bool,
    mut visit: impl FnMut(&Path, &Entry) -> io::Result<()>,
) -> io::Result<usize> {
    enum Pending {
        Directory(PathBuf),
        File(PathBuf, Entry),
    }

    let mut count = 0;
    let mut stack = vec![Pending::Directory(root.to_path_buf())];

    while let Some(pending) = stack.pop() {
        match pending {
            Pending::File(path, scanned) => {
                let rel = path
                    .strip_prefix(root)
                    .expect("read_dir path is under root");
                visit(rel, &scanned)?;
                count += 1;
            }
            Pending::Directory(dir) => {
                let mut entries: Vec<_> = fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
                entries.sort_by_key(|entry| entry.file_name());
                for entry in entries.into_iter().rev() {
                    if is_machinery(&entry.file_name())
                        || (skip_apple_double && is_apple_double(&entry.path(), &entry.file_name()))
                    {
                        continue;
                    }
                    let path = entry.path();
                    let meta = fs::symlink_metadata(&path)?;
                    let file_type = meta.file_type();
                    if file_type.is_dir() {
                        stack.push(Pending::Directory(path));
                    } else {
                        stack.push(Pending::File(
                            path,
                            Entry {
                                size: meta.len(),
                                mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                                is_symlink: file_type.is_symlink(),
                            },
                        ));
                    }
                }
            }
        }
    }

    Ok(count)
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
/// ADR-0004); a matching unfiltered action/error row is dropped and counted
/// in `excluded`.
pub fn compute(
    source: &BTreeMap<PathBuf, Entry>,
    dest: &BTreeMap<PathBuf, Entry>,
    mode: Mode,
    supports_symlinks: bool,
    mtime_tolerance: Duration,
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
        scanned: if mode == Mode::Mirror { dest_only() } else { 0 },
        source_entries: source.len(),
        destination_entries: dest.len(),
        ..Plan::default()
    };
    let mut actionable_paths = BTreeSet::new();
    for (rel, src) in source {
        let classification =
            classify_source_entry(rel, src, dest.get(rel), supports_symlinks, mtime_tolerance);
        if let Some(path) = actionable_path(&classification) {
            actionable_paths.insert(path.to_path_buf());
        }
        record_classification(&mut plan, apply_excludes(classification, excludes));
    }

    // Removals are Mirror-only. In Update nothing at the destination is
    // ever planned for removal, so the DELETE pass is skipped entirely.
    if mode == Mode::Mirror {
        for (rel, dst) in dest {
            if source.contains_key(rel) {
                continue;
            }
            actionable_paths.insert(rel.clone());
            if excludes.iter().any(|excluded| Path::new(excluded) == rel) {
                plan.excluded += 1;
                continue;
            }
            plan.deletes.push(Action {
                rel_path: rel.clone(),
                bytes: dst.size,
                source_mtime: None,
                old_bytes: Some(dst.size),
                reason: "not in source".to_string(),
                structural_conflict: None,
            });
        }
    }

    plan.unknown_excludes = excludes
        .iter()
        .filter(|excluded| !actionable_paths.contains(Path::new(excluded)))
        .cloned()
        .collect();

    plan
}

/// Reports exclusions which did not match an exact action path. Keep this on
/// stderr so NDJSON stdout remains a machine-readable event stream.
pub(crate) fn report_unknown_excludes(plan: &Plan) {
    for excluded in &plan.unknown_excludes {
        eprintln!("vibesync: exclude path not found in plan: {excluded}");
    }
}

fn structural_dependency_satisfied(deletion: &Action, copies: &[Action]) -> bool {
    match deletion.structural_conflict {
        Some(conflict) => copies
            .iter()
            .any(|copy| conflict.has_dependent_copy(&deletion.rel_path, &copy.rel_path)),
        None => true,
    }
}

/// A structural delete exists only to unblock a reviewed Publish. If review
/// filtering or reconciliation removes every dependent COPY, the delete must
/// disappear too so destination content is never archived on its own.
pub(crate) fn drop_orphan_structural_deletions(plan: &mut Plan) -> usize {
    let before = plan.deletes.len();
    plan.deletes
        .retain(|deletion| structural_dependency_satisfied(deletion, &plan.copies));
    let removed = before - plan.deletes.len();
    plan.excluded += removed;
    removed
}

/// Classifies and records one source entry for both buffered human plans and
/// incremental JSON plans. Returning the row lets the streaming caller emit
/// immediately without reimplementing the classification decision tree.
fn classify_source_entry(
    rel: &Path,
    source: &Entry,
    destination: Option<&Entry>,
    supports_symlinks: bool,
    mtime_tolerance: Duration,
) -> SourceClassification {
    if source.is_symlink && !supports_symlinks {
        let error = PlanError {
            rel_path: rel.to_path_buf(),
            message: "symlink not supported on exFAT destination".to_string(),
        };
        return SourceClassification::Error(error);
    }
    match destination {
        None => SourceClassification::Action(
            PlanOperation::Copy,
            Action {
                rel_path: rel.to_path_buf(),
                bytes: source.size,
                source_mtime: Some(source.mtime),
                old_bytes: None,
                reason: "new".to_string(),
                structural_conflict: None,
            },
        ),
        Some(old) => match change_reason(source, old, mtime_tolerance) {
            Some(reason) => SourceClassification::Action(
                PlanOperation::Update,
                Action {
                    rel_path: rel.to_path_buf(),
                    bytes: source.size,
                    source_mtime: Some(source.mtime),
                    old_bytes: Some(old.size),
                    reason: reason.to_string(),
                    structural_conflict: None,
                },
            ),
            None => SourceClassification::Unchanged,
        },
    }
}

fn actionable_path(classification: &SourceClassification) -> Option<&Path> {
    match classification {
        SourceClassification::Action(_, action) => Some(&action.rel_path),
        SourceClassification::Error(error) => Some(&error.rel_path),
        SourceClassification::Excluded | SourceClassification::Unchanged => None,
    }
}

fn apply_excludes(
    classification: SourceClassification,
    excludes: &[String],
) -> SourceClassification {
    let excluded = actionable_path(&classification).is_some_and(|path| {
        excludes
            .iter()
            .any(|candidate| Path::new(candidate) == path)
    });
    if excluded {
        SourceClassification::Excluded
    } else {
        classification
    }
}

fn record_classification(plan: &mut Plan, classification: SourceClassification) {
    plan.scanned += 1;
    match classification {
        SourceClassification::Action(PlanOperation::Copy, action) => plan.copies.push(action),
        SourceClassification::Action(PlanOperation::Update, action) => plan.updates.push(action),
        SourceClassification::Action(_, _) => unreachable!("source rows are copy/update only"),
        SourceClassification::Error(error) => plan.errors.push(error),
        SourceClassification::Excluded => plan.excluded += 1,
        SourceClassification::Unchanged => plan.unchanged += 1,
    }
}

/// Why a file present on both sides needs an UPDATE, or `None` if it is
/// unchanged. Size is the cheap, decisive signal; mtime catches
/// same-size edits (with the documented cross-filesystem granularity risk).
fn change_reason(src: &Entry, dst: &Entry, mtime_tolerance: Duration) -> Option<&'static str> {
    if src.is_symlink != dst.is_symlink {
        Some("type changed")
    } else if src.size != dst.size {
        Some("size differs")
    } else if src
        .mtime
        .duration_since(dst.mtime)
        .unwrap_or_else(|_| dst.mtime.duration_since(src.mtime).unwrap_or_default())
        > mtime_tolerance
    {
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

pub(crate) fn human_size(bytes: u64) -> String {
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
pub fn run(config_path: &Path, pair_name: &str) -> Result<i32, AppError> {
    let (pair, plan) = build(config_path, pair_name, &[])?;
    print!("{}", render(&plan, pair_name, pair.mode));
    Ok(crate::error::EXIT_OK)
}

/// Streams the versioned Dry-run contract as one flushed JSON object per
/// line. Rows are emitted individually and never assembled into a JSON
/// document, keeping the public wire format incremental and constant-space.
pub fn run_json(config_path: &Path, pair_name: &str) -> Result<i32, AppError> {
    let setup = prepare(config_path, pair_name)?;
    for notice in &setup.notices {
        eprintln!("{notice}");
    }
    let header_pair = setup.pair;
    let plan_id = plan_id();
    emit(serde_json::json!({
        "schema": "vibefilesync.plan/v1", "type": "plan_start", "plan_id": plan_id,
        "pair": pair_name, "mode": header_pair.mode, "dry_run": true
    }))?;
    let mut stats = StreamStats::default();
    walk(&header_pair.source, false, |path, entry| {
        stats.scanned += 1;
        let destination_path = header_pair.destination.join(path);
        let replaces_empty_directory = is_empty_directory(&destination_path)?;
        let old = entry_at(&destination_path)?;
        let classification = classify_source_entry(
            path,
            entry,
            old.as_ref(),
            setup.supports_symlinks,
            setup.mtime_tolerance,
        );
        let row = match classification {
            SourceClassification::Action(op, action) => {
                if replaces_empty_directory {
                    let replacement = Action {
                        rel_path: path.to_path_buf(),
                        bytes: 0,
                        source_mtime: None,
                        old_bytes: Some(0),
                        reason: "replaced by source file".into(),
                        structural_conflict: Some(StructuralConflict::DestinationDirectory),
                    };
                    crate::ndjson::stdout(&plan_action_row(
                        &plan_id,
                        PlanOperation::Delete,
                        &replacement,
                    ))
                    .map_err(io::Error::other)?;
                    stats.deletes += 1;
                }
                stats.increment(op);
                plan_action_row(&plan_id, op, &action)
            }
            SourceClassification::Error(error) => {
                stats.errors += 1;
                serde_json::json!({"schema":"vibefilesync.plan/v1","type":"action","plan_id":plan_id,"op":PlanOperation::Error,"path":error.rel_path.to_string_lossy(),"reason":error.message})
            }
            SourceClassification::Unchanged => {
                stats.unchanged += 1;
                return Ok(());
            }
            SourceClassification::Excluded => unreachable!("public Plan has no exclusions"),
        };
        crate::ndjson::stdout(&row).map_err(io::Error::other)
    })
    .map_err(|e| scan_error(&header_pair.source, e))?;
    let source_directories = scan_directories(&header_pair.source)
        .map_err(|error| scan_error(&header_pair.source, error))?;
    let destination_directories = if header_pair.destination.is_dir() {
        scan_directories(&header_pair.destination)
            .map_err(|error| scan_error(&header_pair.destination, error))?
    } else {
        BTreeSet::new()
    };
    for path in source_directories.difference(&destination_directories) {
        let source_directory = header_pair.source.join(path);
        if fs::read_dir(&source_directory)
            .map_err(|error| scan_error(&source_directory, error))?
            .next()
            .transpose()
            .map_err(|error| scan_error(&source_directory, error))?
            .is_some()
        {
            continue;
        }
        let action = Action {
            rel_path: path.clone(),
            bytes: 0,
            source_mtime: None,
            old_bytes: None,
            reason: "new directory".into(),
            structural_conflict: None,
        };
        emit(plan_action_row(&plan_id, PlanOperation::Copy, &action))?;
        stats.copies += 1;
        stats.scanned += 1;
    }
    if header_pair.destination.is_dir() {
        if header_pair.mode == Mode::Mirror {
            for path in destination_directories.difference(&source_directories) {
                let destination_directory = header_pair.destination.join(path);
                if fs::read_dir(&destination_directory)
                    .map_err(|error| scan_error(&destination_directory, error))?
                    .next()
                    .transpose()
                    .map_err(|error| scan_error(&destination_directory, error))?
                    .is_some()
                {
                    continue;
                }
                let action = Action {
                    rel_path: path.clone(),
                    bytes: 0,
                    source_mtime: None,
                    old_bytes: Some(0),
                    reason: "directory not in source".into(),
                    structural_conflict: None,
                };
                emit(plan_action_row(&plan_id, PlanOperation::Delete, &action))?;
                stats.deletes += 1;
                stats.scanned += 1;
            }
        }
        walk(
            &header_pair.destination,
            setup.skip_apple_double,
            |path, entry| {
                let source = fs::symlink_metadata(header_pair.source.join(path));
                let (reason, structural_conflict) = match source {
                    Ok(metadata) if metadata.file_type().is_dir() => (
                        "replaced by source directory",
                        Some(StructuralConflict::DestinationFile),
                    ),
                    Ok(_) => return Ok(()),
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                        ) && header_pair.mode == Mode::Mirror =>
                    {
                        ("not in source", None)
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                        ) =>
                    {
                        return Ok(())
                    }
                    Err(error) => return Err(error),
                };
                stats.scanned += 1;
                let action = Action {
                    rel_path: path.to_path_buf(),
                    bytes: entry.size,
                    source_mtime: None,
                    old_bytes: Some(entry.size),
                    reason: reason.into(),
                    structural_conflict,
                };
                crate::ndjson::stdout(&plan_action_row(&plan_id, PlanOperation::Delete, &action))
                    .map_err(io::Error::other)?;
                stats.deletes += 1;
                Ok(())
            },
        )
        .map_err(|error| scan_error(&header_pair.destination, error))?;
    }
    walk_stray_temps(&header_pair.destination, |path| {
        let bytes = fs::symlink_metadata(header_pair.destination.join(path))?.len();
        let action = Action {
            rel_path: path.to_path_buf(),
            bytes,
            source_mtime: None,
            old_bytes: None,
            reason: "abandoned temp".into(),
            structural_conflict: None,
        };
        crate::ndjson::stdout(&plan_action_row(&plan_id, PlanOperation::Cleanup, &action))
            .map_err(io::Error::other)?;
        stats.cleanup += 1;
        Ok(())
    })
    .map_err(|error| scan_error(&header_pair.destination, error))?;
    emit(serde_json::json!({
        "schema": "vibefilesync.plan/v1", "type": "summary", "plan_id": plan_id,
        "counts": {
            "copy": stats.copies, "update": stats.updates, "delete": stats.deletes,
            "error": stats.errors, "cleanup": stats.cleanup, "scanned": stats.scanned,
            "unchanged": stats.unchanged, "excluded": stats.excluded
        }
    }))?;
    Ok(crate::error::EXIT_OK)
}

fn entry_at(path: &Path) -> io::Result<Option<Entry>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(None),
        Ok(metadata) => Ok(Some(Entry {
            size: metadata.len(),
            mtime: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            is_symlink: metadata.file_type().is_symlink(),
        })),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn is_empty_directory(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            Ok(fs::read_dir(path)?.next().transpose()?.is_none())
        }
        Ok(_) => Ok(false),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

#[derive(Default)]
struct StreamStats {
    copies: usize,
    updates: usize,
    deletes: usize,
    errors: usize,
    cleanup: usize,
    scanned: usize,
    unchanged: usize,
    excluded: usize,
}

impl StreamStats {
    fn increment(&mut self, operation: PlanOperation) {
        match operation {
            PlanOperation::Copy => self.copies += 1,
            PlanOperation::Update => self.updates += 1,
            _ => unreachable!("source actions are copy/update only"),
        }
    }
}

fn plan_action_row(plan_id: &str, op: PlanOperation, action: &Action) -> serde_json::Value {
    let mut row = serde_json::json!({"schema":"vibefilesync.plan/v1","type":"action","plan_id":plan_id,"op":op,"path":action.rel_path.to_string_lossy(),"reason":action.reason,"bytes":action.bytes});
    if let Some(bytes) = action.old_bytes {
        row["old_bytes"] = bytes.into();
    }
    if matches!(op, PlanOperation::Update | PlanOperation::Delete) {
        row["safety_net"] = format!("_SafetyNet/<run-id>/{}", action.rel_path.display()).into();
    }
    row
}

fn emit(value: serde_json::Value) -> Result<(), AppError> {
    crate::ndjson::stdout(&value)
}

fn plan_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch");
    format!("plan-{}-{:09}", now.as_secs(), now.subsec_nanos())
}

struct PlanSetup {
    pair: config::Pair,
    supports_symlinks: bool,
    mtime_tolerance: Duration,
    skip_apple_double: bool,
    notices: Vec<String>,
}

fn prepare(config_path: &Path, pair_name: &str) -> Result<PlanSetup, AppError> {
    let cfg = config::load(config_path)?;
    let configured = cfg
        .pairs
        .get(pair_name)
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))?;
    let (pair, notices) = crate::preconditions::resolve_pair(configured)?;
    if !pair.source.is_dir() {
        return Err(AppError::Precondition(format!(
            "{}: source directory not found (is the volume mounted?)",
            pair.source.display()
        )));
    }
    let destination_type = if pair.destination.is_dir() {
        Some(
            volume::filesystem_type(&pair.destination)
                .map_err(|error| scan_error(&pair.destination, error))?,
        )
    } else {
        None
    };
    let is_exfat = destination_type
        .as_deref()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("exfat"));
    let supports_symlinks = !is_exfat;
    let mtime_tolerance = destination_type
        .as_deref()
        .map(volume::timestamp_granularity_for)
        .transpose()
        .map_err(|error| scan_error(&pair.destination, error))?
        .unwrap_or(Duration::ZERO);
    Ok(PlanSetup {
        pair,
        supports_symlinks,
        mtime_tolerance,
        skip_apple_double: is_exfat,
        notices,
    })
}

/// Builds a fresh plan for the CLI edges which need to render it and then
/// act on exactly the reviewed COPY rows. The scan remains owned by this
/// module; callers receive no filesystem internals.
pub(crate) fn build(
    config_path: &Path,
    pair_name: &str,
    excludes: &[String],
) -> Result<(config::Pair, Plan), AppError> {
    let setup = prepare(config_path, pair_name)?;
    for notice in setup.notices {
        eprintln!("{notice}");
    }
    let pair = setup.pair;
    let source = scan(&pair.source, false).map_err(|error| scan_error(&pair.source, error))?;
    let destination = if pair.destination.is_dir() {
        scan(&pair.destination, setup.skip_apple_double)
            .map_err(|error| scan_error(&pair.destination, error))?
    } else {
        BTreeMap::new()
    };
    let source_directories =
        scan_directories(&pair.source).map_err(|error| scan_error(&pair.source, error))?;
    let destination_directories = if pair.destination.is_dir() {
        scan_directories(&pair.destination).map_err(|error| scan_error(&pair.destination, error))?
    } else {
        BTreeSet::new()
    };
    let mut plan = compute(
        &source,
        &destination,
        pair.mode,
        setup.supports_symlinks,
        setup.mtime_tolerance,
        excludes,
    );
    add_directory_actions(
        &mut plan,
        &source,
        &source_directories,
        &destination_directories,
        &pair.destination,
        pair.mode,
        excludes,
    );
    add_structural_replacements(
        &mut plan,
        &source,
        &destination,
        &pair.destination,
        pair.mode,
        excludes,
    )
    .map_err(|error| scan_error(&pair.destination, error))?;
    plan.strays =
        stray_temps(&pair.destination).map_err(|error| scan_error(&pair.destination, error))?;
    apply_stray_excludes(&mut plan, excludes);
    Ok((pair, plan))
}

fn add_directory_actions(
    plan: &mut Plan,
    source_entries: &BTreeMap<PathBuf, Entry>,
    source: &BTreeSet<PathBuf>,
    destination: &BTreeSet<PathBuf>,
    destination_root: &Path,
    mode: Mode,
    excludes: &[String],
) {
    for path in source.difference(destination) {
        if source_entries.keys().any(|entry| entry.starts_with(path))
            || source
                .iter()
                .any(|directory| directory != path && directory.starts_with(path))
        {
            continue;
        }
        if excludes.iter().any(|excluded| Path::new(excluded) == path) {
            plan.excluded += 1;
            continue;
        }
        plan.copies.push(Action {
            rel_path: path.clone(),
            bytes: 0,
            source_mtime: None,
            old_bytes: None,
            reason: "new directory".into(),
            structural_conflict: None,
        });
        plan.directory_copies.insert(path.clone());
    }
    if mode == Mode::Mirror {
        for path in destination.difference(source) {
            if destination
                .difference(source)
                .any(|ancestor| ancestor != path && path.starts_with(ancestor))
                || contains_machinery(&destination_root.join(path))
            {
                continue;
            }
            if excludes.iter().any(|excluded| Path::new(excluded) == path) {
                plan.excluded += 1;
                continue;
            }
            plan.deletes
                .retain(|action| !action.rel_path.starts_with(path));
            plan.deletes.push(Action {
                rel_path: path.clone(),
                bytes: 0,
                source_mtime: None,
                old_bytes: Some(0),
                reason: "directory not in source".into(),
                structural_conflict: None,
            });
            plan.directory_deletes.insert(path.clone());
        }
    }
    plan.copies
        .sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    plan.deletes
        .sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
}

fn contains_machinery(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        if is_machinery(&entry.file_name()) {
            return true;
        }
        if entry.path().is_dir() && contains_machinery(&entry.path()) {
            return true;
        }
    }
    false
}

fn add_structural_replacements(
    plan: &mut Plan,
    source: &BTreeMap<PathBuf, Entry>,
    destination: &BTreeMap<PathBuf, Entry>,
    destination_root: &Path,
    mode: Mode,
    excludes: &[String],
) -> io::Result<()> {
    let mut structural = Vec::new();

    // A destination file blocks creation of a source directory. Mirror
    // already classifies it as destination-only, so tag that existing row;
    // Update needs a new replacement row even though unrelated content stays.
    for (path, entry) in destination {
        if source
            .keys()
            .any(|source_path| source_path != path && source_path.starts_with(path))
            || plan
                .directory_copies
                .iter()
                .any(|source_path| source_path.starts_with(path))
        {
            if mode == Mode::Mirror {
                if let Some(existing) = plan
                    .deletes
                    .iter_mut()
                    .find(|action| action.rel_path == *path)
                {
                    existing.reason = "replaced by source directory".into();
                    existing.structural_conflict = Some(StructuralConflict::DestinationFile);
                }
            } else {
                structural.push(Action {
                    rel_path: path.clone(),
                    bytes: entry.size,
                    source_mtime: None,
                    old_bytes: Some(entry.size),
                    reason: "replaced by source directory".into(),
                    structural_conflict: Some(StructuralConflict::DestinationFile),
                });
                plan.scanned += 1;
            }
        }
    }

    // A reviewed destination directory at a source-file path is archived as
    // one object after the dependent file passes its gate. An excluded
    // descendant keeps the directory outside the structural replacement.
    for copy in &plan.copies {
        if plan.directory_copies.contains(&copy.rel_path)
            || !fs::symlink_metadata(destination_root.join(&copy.rel_path))
                .is_ok_and(|metadata| metadata.file_type().is_dir())
            || excludes
                .iter()
                .any(|excluded| Path::new(excluded).starts_with(&copy.rel_path))
            || contains_machinery(&destination_root.join(&copy.rel_path))
        {
            continue;
        }
        if let Some(existing) = plan
            .deletes
            .iter_mut()
            .find(|action| action.rel_path == copy.rel_path)
        {
            existing.reason = "replaced by source file".into();
            existing.structural_conflict = Some(StructuralConflict::DestinationDirectory);
        } else {
            structural.push(Action {
                rel_path: copy.rel_path.clone(),
                bytes: 0,
                source_mtime: None,
                old_bytes: Some(0),
                reason: "replaced by source file".into(),
                structural_conflict: Some(StructuralConflict::DestinationDirectory),
            });
        }
        plan.directory_deletes.insert(copy.rel_path.clone());
    }

    for action in structural {
        plan.unknown_excludes
            .retain(|excluded| Path::new(excluded) != action.rel_path);
        if excludes
            .iter()
            .any(|excluded| Path::new(excluded) == action.rel_path)
        {
            plan.excluded += 1;
        } else if !plan
            .deletes
            .iter()
            .any(|existing| existing.rel_path == action.rel_path)
        {
            plan.deletes.push(action);
        }
    }
    plan.deletes
        .sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Ok(())
}

fn apply_stray_excludes(plan: &mut Plan, excludes: &[String]) {
    let known_strays: BTreeSet<_> = plan.strays.iter().cloned().collect();
    plan.unknown_excludes
        .retain(|excluded| !known_strays.contains(Path::new(excluded)));
    let before = plan.strays.len();
    plan.strays
        .retain(|path| !excludes.iter().any(|excluded| Path::new(excluded) == path));
    plan.excluded += before - plan.strays.len();
}

/// Lists abandoned sibling Publish temps without treating them as sync
/// content. This is intentionally read-only so `plan` and `status` are safe
/// at any time; only a real run removes the returned paths.
pub(crate) fn stray_temps(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut strays = Vec::new();
    walk_stray_temps(root, |path| {
        strays.push(path.to_path_buf());
        Ok(())
    })?;
    strays.sort();
    Ok(strays)
}

fn walk_stray_temps(
    root: &Path,
    mut visit: impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<usize> {
    enum Pending {
        Directory(PathBuf),
        Stray(PathBuf),
    }

    if !root.is_dir() {
        return Ok(0);
    }
    let mut count = 0;
    let mut stack = vec![Pending::Directory(root.to_path_buf())];
    while let Some(pending) = stack.pop() {
        match pending {
            Pending::Stray(path) => {
                visit(path.strip_prefix(root).expect("entry is under root"))?;
                count += 1;
            }
            Pending::Directory(dir) => {
                let mut entries: Vec<_> = fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
                entries.sort_by_key(|entry| entry.file_name());
                for entry in entries.into_iter().rev() {
                    if entry.file_name() == "_SafetyNet" {
                        continue;
                    }
                    let path = entry.path();
                    let metadata = fs::symlink_metadata(&path)?;
                    if metadata.file_type().is_dir() {
                        stack.push(Pending::Directory(path));
                    } else if is_stray_temp(&entry.file_name()) {
                        stack.push(Pending::Stray(path));
                    }
                }
            }
        }
    }
    Ok(count)
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

        let plan = compute(&source, &dest, Mode::Mirror, true, Duration::ZERO, &[]);

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

        let plan = compute(&source, &dest, Mode::Mirror, true, Duration::ZERO, &[]);
        assert_eq!(plan.updates.len(), 1);
        assert_eq!(plan.updates[0].reason, "modified");
        assert_eq!(plan.unchanged, 0);
    }

    #[test]
    fn timestamp_granularity_does_not_replan_a_published_file() {
        let source = BTreeMap::from([(PathBuf::from("photo.jpg"), file(4, 11))]);
        let destination = BTreeMap::from([(PathBuf::from("photo.jpg"), file(4, 10))]);

        let plan = compute(
            &source,
            &destination,
            Mode::Mirror,
            false,
            Duration::from_secs(2),
            &[],
        );

        assert!(plan.updates.is_empty());
        assert_eq!(plan.unchanged, 1);
    }

    #[test]
    fn update_mode_never_plans_a_deletion() {
        let source = tree(&[("new.txt", file(10, 100))]);
        let dest = tree(&[("gone.txt", file(5, 50)), ("also-gone.txt", file(6, 60))]);

        let plan = compute(&source, &dest, Mode::Update, true, Duration::ZERO, &[]);

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
            Duration::ZERO,
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

        let plan = compute(&source, &dest, Mode::Mirror, true, Duration::ZERO, &[]);
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
            Duration::ZERO,
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
            Duration::ZERO,
            &["gone.txt".to_string()],
        );
        assert!(plan.deletes.is_empty());
        assert_eq!(plan.excluded, 1);
    }

    #[test]
    fn render_totals_and_safetynet_notes_for_mirror() {
        let source = tree(&[("new.txt", file(10, 100)), ("chg.txt", file(40, 300))]);
        let dest = tree(&[("chg.txt", file(30, 300)), ("gone.txt", file(5, 50))]);
        let plan = compute(&source, &dest, Mode::Mirror, true, Duration::ZERO, &[]);

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
        let plan = compute(&source, &dest, Mode::Update, true, Duration::ZERO, &[]);

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
        assert!(!is_machinery(OsStr::new("._notes")));
        assert!(!is_machinery(OsStr::new("_SafetyNetworkNotes")));
        assert!(!is_machinery(OsStr::new("vibesync-tmp-visible")));
        assert!(!is_machinery(OsStr::new("regular.txt")));
    }

    #[test]
    fn apple_double_filter_is_content_and_destination_context_sensitive() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("._photo.jpg"),
            [0x00, 0x05, 0x16, 0x07, 0x01],
        )
        .unwrap();
        fs::write(root.path().join("._notes"), b"legitimate user content").unwrap();

        let mut source_paths = Vec::new();
        walk(root.path(), false, |path, _| {
            source_paths.push(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        source_paths.sort();
        assert_eq!(
            source_paths,
            [PathBuf::from("._notes"), PathBuf::from("._photo.jpg")]
        );

        let mut exfat_destination_paths = Vec::new();
        walk(root.path(), true, |path, _| {
            exfat_destination_paths.push(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(exfat_destination_paths, [PathBuf::from("._notes")]);
    }
}
