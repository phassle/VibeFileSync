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
use std::ffi::{OsStr, OsString};
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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

/// Equality is whole-value and field-wise; `Eq` and `Hash` derive from the
/// same fields, so they agree with the `PartialEq` this type has always had.
/// Reconciliation depends on that agreement: it indexes whole `Action`
/// values — not paths — to decide what a review covered (`run.rs`), so
/// hashing must separate exactly the values equality separates.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Action {
    pub rel_path: PathBuf,
    pub bytes: u64,
    pub source_mtime: Option<SystemTime>,
    pub old_bytes: Option<u64>,
    pub reason: String,
    pub structural_conflict: Option<StructuralConflict>,
}

fn destination_directory_replacement(path: &Path) -> Action {
    Action {
        rel_path: path.to_path_buf(),
        bytes: 0,
        source_mtime: None,
        old_bytes: Some(0),
        reason: "replaced by source file".into(),
        structural_conflict: Some(StructuralConflict::DestinationDirectory),
    }
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
    Unchanged(PathBuf),
}

/// The computed Dry-run diff for one Folder pair.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    pub copies: Vec<Action>,
    pub updates: Vec<Action>,
    pub deletes: Vec<Action>,
    pub errors: Vec<PlanError>,
    /// Total files examined across both trees (union of relative paths).
    pub scanned: usize,
    /// Files identical on both sides (same size and mtime).
    pub unchanged: usize,
    /// The relative paths counted in `unchanged`, in source-scan order.
    /// Presentation-only (Review's `u` key, ADR-0010 §2): the reviewed
    /// action subset never derives from this list, only from
    /// `copies`/`updates`/`deletes`/`errors`.
    pub unchanged_paths: Vec<PathBuf>,
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
// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
fn scan(root: &Path, skip_apple_double: bool) -> io::Result<BTreeMap<PathBuf, Entry>> {
    let mut entries = BTreeMap::new();
    walk(root, skip_apple_double, |path, entry| {
        entries.insert(path.to_path_buf(), entry.clone());
        Ok(())
    })?;
    Ok(entries)
}

// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
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

// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
fn walk(
    root: &Path,
    skip_apple_double: bool,
    mut visit: impl FnMut(&Path, &Entry) -> io::Result<()>,
) -> io::Result<usize> {
    fn recurse(
        root: &Path,
        directory: &Path,
        skip_apple_double: bool,
        visit: &mut impl FnMut(&Path, &Entry) -> io::Result<()>,
        count: &mut usize,
    ) -> io::Result<()> {
        for_each_sorted_entry(directory, |entry| {
            if is_machinery(&entry.file_name())
                || (skip_apple_double && is_apple_double(&entry.path(), &entry.file_name()))
            {
                return Ok(());
            }
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            let file_type = meta.file_type();
            if file_type.is_dir() {
                recurse(root, &path, skip_apple_double, visit, count)?;
            } else {
                #[cfg(all(feature = "fault-injection", debug_assertions))]
                if let Ok(delay) = std::env::var("VIBESYNC_TEST_PLAN_SCAN_DELAY_MS") {
                    std::thread::sleep(Duration::from_millis(delay.parse().unwrap_or(0)));
                }
                let rel = path
                    .strip_prefix(root)
                    .expect("read_dir path is under root");
                visit(
                    rel,
                    &Entry {
                        size: meta.len(),
                        mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        is_symlink: file_type.is_symlink(),
                    },
                )?;
                *count += 1;
            }
            Ok(())
        })
    }

    let mut count = 0;
    recurse(root, root, skip_apple_double, &mut visit, &mut count)?;
    Ok(count)
}

/// Reads a directory once, sorts its entries by name, and returns them. This
/// replaces [`for_each_sorted_entry`]'s re-read-per-entry scan for the single
/// [`traverse`] pass: the emitted order is identical (a depth-first walk with
/// name-sorted children is the same as component-lexicographic order), but a
/// directory is read exactly once.
fn sorted_entries(directory: &Path) -> io::Result<Vec<fs::DirEntry>> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(directory)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

/// Recursively visits every file and symlink under `root`, in the same order
/// as [`scan`]/[`walk`], but collecting and sorting each directory's entries
/// exactly once. Returns the number of files visited (both trees' entry
/// counts flow from this). The visit closure sees the path relative to `root`.
fn walk_files_sorted(
    root: &Path,
    skip_apple_double: bool,
    mut visit: impl FnMut(&Path, &Entry) -> io::Result<()>,
) -> io::Result<usize> {
    fn recurse(
        root: &Path,
        directory: &Path,
        skip_apple_double: bool,
        visit: &mut impl FnMut(&Path, &Entry) -> io::Result<()>,
        count: &mut usize,
    ) -> io::Result<()> {
        for entry in sorted_entries(directory)? {
            let name = entry.file_name();
            if is_machinery(&name) || (skip_apple_double && is_apple_double(&entry.path(), &name)) {
                continue;
            }
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            let file_type = meta.file_type();
            if file_type.is_dir() {
                recurse(root, &path, skip_apple_double, visit, count)?;
            } else {
                #[cfg(all(feature = "fault-injection", debug_assertions))]
                if let Ok(delay) = std::env::var("VIBESYNC_TEST_PLAN_SCAN_DELAY_MS") {
                    std::thread::sleep(Duration::from_millis(delay.parse().unwrap_or(0)));
                }
                let rel = path
                    .strip_prefix(root)
                    .expect("read_dir path is under root");
                visit(
                    rel,
                    &Entry {
                        size: meta.len(),
                        mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        is_symlink: file_type.is_symlink(),
                    },
                )?;
                *count += 1;
            }
        }
        Ok(())
    }

    let mut count = 0;
    recurse(root, root, skip_apple_double, &mut visit, &mut count)?;
    Ok(count)
}

// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
fn for_each_sorted_entry(
    directory: &Path,
    mut visit: impl FnMut(fs::DirEntry) -> io::Result<()>,
) -> io::Result<()> {
    let mut previous: Option<OsString> = None;
    loop {
        let mut next: Option<fs::DirEntry> = None;
        for candidate in fs::read_dir(directory)? {
            let candidate = candidate?;
            let name = candidate.file_name();
            if previous.as_ref().is_some_and(|previous| name <= *previous)
                || next.as_ref().is_some_and(|next| name >= next.file_name())
            {
                continue;
            }
            next = Some(candidate);
        }
        let Some(next) = next else { break };
        previous = Some(next.file_name());
        visit(next)?;
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
/// ADR-0004); a matching unfiltered action/error row is dropped and counted
/// in `excluded`.
// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
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

/// The one structural-dependency rule: a structural delete is justified only
/// while at least one of `copies` is the dependent Publish it exists to
/// unblock. A delete with no `structural_conflict` is unconditionally
/// satisfied. Published on the Plan interface so both Run reconciliation
/// ([`drop_orphan_structural_deletions`]) and TUI review consult this single
/// decision over the planned-action type instead of restating it.
pub(crate) fn structural_dependency_satisfied(deletion: &Action, copies: &[Action]) -> bool {
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
            None => SourceClassification::Unchanged(rel.to_path_buf()),
        },
    }
}

// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
fn actionable_path(classification: &SourceClassification) -> Option<&Path> {
    match classification {
        SourceClassification::Action(_, action) => Some(&action.rel_path),
        SourceClassification::Error(error) => Some(&error.rel_path),
        SourceClassification::Excluded | SourceClassification::Unchanged(_) => None,
    }
}

// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
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

// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
fn record_classification(plan: &mut Plan, classification: SourceClassification) {
    plan.scanned += 1;
    match classification {
        SourceClassification::Action(PlanOperation::Copy, action) => plan.copies.push(action),
        SourceClassification::Action(PlanOperation::Update, action) => plan.updates.push(action),
        SourceClassification::Action(_, _) => unreachable!("source rows are copy/update only"),
        SourceClassification::Error(error) => plan.errors.push(error),
        SourceClassification::Excluded => plan.excluded += 1,
        SourceClassification::Unchanged(path) => {
            plan.unchanged += 1;
            plan.unchanged_paths.push(path);
        }
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

/// Emits the versioned Dry-run contract from the same fresh [`Plan`] used by
/// human review and Run, so every surface names the exact same action set.
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
    let mut sink = StreamingSink::new(&plan_id);
    traverse(
        &header_pair.source,
        &header_pair.destination,
        header_pair.mode,
        setup.supports_symlinks,
        setup.mtime_tolerance,
        setup.skip_apple_double,
        &mut sink,
    )?;
    let stats = sink.stats;
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

fn is_directory(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_dir()),
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

fn walk_leaf_directories(
    root: &Path,
    mut visit: impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<()> {
    fn recurse(
        root: &Path,
        directory: &Path,
        visit: &mut impl FnMut(&Path) -> io::Result<()>,
    ) -> io::Result<bool> {
        let mut has_content = false;
        for entry in sorted_entries(directory)? {
            if is_machinery(&entry.file_name()) {
                continue;
            }
            has_content = true;
            let path = entry.path();
            if fs::symlink_metadata(&path)?.file_type().is_dir() {
                recurse(root, &path, visit)?;
            }
        }
        if directory != root && !has_content {
            visit(
                directory
                    .strip_prefix(root)
                    .expect("walked directory is under root"),
            )?;
        }
        Ok(has_content)
    }

    recurse(root, root, &mut visit)?;
    Ok(())
}

fn walk_destination_directory_deletes(
    source_root: &Path,
    destination_root: &Path,
    mut visit: impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<()> {
    fn recurse(
        source_root: &Path,
        destination_root: &Path,
        directory: &Path,
        visit: &mut impl FnMut(&Path) -> io::Result<()>,
    ) -> io::Result<()> {
        for entry in sorted_entries(directory)? {
            if is_machinery(&entry.file_name()) {
                continue;
            }
            let path = entry.path();
            if !fs::symlink_metadata(&path)?.file_type().is_dir() {
                continue;
            }
            let relative = path
                .strip_prefix(destination_root)
                .expect("walked directory is under destination");
            match fs::symlink_metadata(source_root.join(relative)) {
                Ok(metadata) if metadata.file_type().is_dir() => {
                    recurse(source_root, destination_root, &path, visit)?;
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                    ) =>
                {
                    if contains_machinery(&path) {
                        recurse(source_root, destination_root, &path, visit)?;
                    } else {
                        visit(relative)?;
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    recurse(source_root, destination_root, destination_root, &mut visit)
}

fn has_collapsed_destination_ancestor(
    source_root: &Path,
    destination_root: &Path,
    path: &Path,
) -> io::Result<bool> {
    let mut ancestor = path.parent();
    while let Some(relative) = ancestor {
        let destination = destination_root.join(relative);
        match fs::symlink_metadata(source_root.join(relative)) {
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                if destination.is_dir() && !contains_machinery(&destination) {
                    return Ok(true);
                }
            }
            Err(error) => return Err(error),
        }
        ancestor = relative.parent();
    }
    Ok(false)
}

fn has_file_ancestor(root: &Path, path: &Path) -> io::Result<bool> {
    let mut ancestor = path.parent();
    while let Some(relative) = ancestor {
        match fs::symlink_metadata(root.join(relative)) {
            Ok(metadata) if !metadata.file_type().is_dir() => return Ok(true),
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => return Err(error),
        }
        ancestor = relative.parent();
    }
    Ok(false)
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

/// The single authority for every planned row. One [`traverse`] pass over a
/// Folder pair decides each row — including the three formerly-duplicated
/// structural decisions (new directory, destination-only directory,
/// structural replacement) — and hands it to a sink in contract order. The
/// [`BufferingSink`] assembles today's [`Plan`]; the [`StreamingSink`] writes
/// the NDJSON stream. Structural conflict is decided here and carried on the
/// yielded row, so neither adapter post-corrects an assembled plan.
///
/// Each method names a distinct planned outcome rather than a bare
/// copy/update/delete, so the two adapters can reproduce their historically
/// different `scanned` arithmetic without either surface changing its bytes.
trait PlanSink {
    fn copy(&mut self, action: &Action) -> Result<(), AppError>;
    fn update(&mut self, action: &Action) -> Result<(), AppError>;
    fn error(&mut self, error: &PlanError) -> Result<(), AppError>;
    fn unchanged(&mut self, path: &Path) -> Result<(), AppError>;
    /// A destination directory replaced by a source file. Emitted right after
    /// the source file's [`copy`](PlanSink::copy)/[`update`](PlanSink::update)
    /// row, carrying the [`StructuralConflict::DestinationDirectory`] tag.
    fn destination_directory_replacement(&mut self, action: &Action) -> Result<(), AppError>;
    /// A new, empty source-only directory.
    fn new_directory(&mut self, action: &Action) -> Result<(), AppError>;
    /// A destination-only directory (Mirror only).
    fn directory_delete(&mut self, action: &Action) -> Result<(), AppError>;
    /// A destination-only file (Mirror only).
    fn file_delete(&mut self, action: &Action) -> Result<(), AppError>;
    /// A destination file replaced by a source directory, carrying the
    /// [`StructuralConflict::DestinationFile`] tag.
    fn destination_file_replacement(&mut self, action: &Action) -> Result<(), AppError>;
    /// A destination entry skipped because a collapsed or file ancestor
    /// already accounts for it (Mirror only). Carries no row; only the
    /// closing `scanned` total observes it.
    fn skipped_destination_entry(&mut self);
    /// An abandoned Publish temp the run would clean up.
    fn cleanup(&mut self, action: &Action) -> Result<(), AppError>;
    fn source_entries(&mut self, count: usize);
    fn destination_entries(&mut self, count: usize);
}

/// Walks the Folder pair once, deciding every planned row inline and yielding
/// it to `sink` in the same order the NDJSON contract fixes. This is derived
/// from the streaming surface: a single pass, structural conflicts resolved as
/// rows are decided, memory held constant (ADR-0003 §2). Orphan-dropping is
/// deliberately *not* here — it stays a post-review operation on an assembled
/// plan ([`drop_orphan_structural_deletions`]).
fn traverse(
    source_root: &Path,
    destination_root: &Path,
    mode: Mode,
    supports_symlinks: bool,
    mtime_tolerance: Duration,
    skip_apple_double: bool,
    sink: &mut impl PlanSink,
) -> Result<(), AppError> {
    // Source pass: every source file is classified once, and a destination
    // directory it must replace is resolved inline as a paired delete row.
    let source_entries = walk_files_sorted(source_root, false, |path, entry| {
        let destination_path = destination_root.join(path);
        let replaces_directory =
            is_directory(&destination_path)? && !contains_machinery(&destination_path);
        let old = entry_at(&destination_path)?;
        let classification = classify_source_entry(
            path,
            entry,
            old.as_ref(),
            supports_symlinks,
            mtime_tolerance,
        );
        match classification {
            SourceClassification::Action(op, action) => {
                match op {
                    PlanOperation::Copy => sink.copy(&action).map_err(io::Error::other)?,
                    PlanOperation::Update => sink.update(&action).map_err(io::Error::other)?,
                    _ => unreachable!("source rows are copy/update only"),
                }
                if replaces_directory {
                    let replacement = destination_directory_replacement(path);
                    sink.destination_directory_replacement(&replacement)
                        .map_err(io::Error::other)?;
                }
            }
            SourceClassification::Error(error) => sink.error(&error).map_err(io::Error::other)?,
            SourceClassification::Unchanged(path) => {
                sink.unchanged(&path).map_err(io::Error::other)?
            }
            SourceClassification::Excluded => unreachable!("traversal applies no exclusions"),
        }
        Ok(())
    })
    .map_err(|error| scan_error(source_root, error))?;
    sink.source_entries(source_entries);

    // A source directory with no file descendants would otherwise leave no
    // row; emit it as a new-directory copy so an empty tree is reproduced.
    walk_leaf_directories(source_root, |path| {
        if fs::symlink_metadata(destination_root.join(path))
            .is_ok_and(|metadata| metadata.file_type().is_dir())
        {
            return Ok(());
        }
        let action = Action {
            rel_path: path.to_path_buf(),
            bytes: 0,
            source_mtime: None,
            old_bytes: None,
            reason: "new directory".into(),
            structural_conflict: None,
        };
        sink.new_directory(&action).map_err(io::Error::other)
    })
    .map_err(|error| scan_error(source_root, error))?;

    if destination_root.is_dir() {
        if mode == Mode::Mirror {
            walk_destination_directory_deletes(source_root, destination_root, |path| {
                let action = Action {
                    rel_path: path.to_path_buf(),
                    bytes: 0,
                    source_mtime: None,
                    old_bytes: Some(0),
                    reason: "directory not in source".into(),
                    structural_conflict: None,
                };
                sink.directory_delete(&action).map_err(io::Error::other)
            })
            .map_err(|error| scan_error(destination_root, error))?;
        }
        let destination_entries =
            walk_files_sorted(destination_root, skip_apple_double, |path, entry| {
                let collapsed = mode == Mode::Mirror
                    && has_collapsed_destination_ancestor(source_root, destination_root, path)?;
                if collapsed || has_file_ancestor(source_root, path)? {
                    if mode == Mode::Mirror {
                        sink.skipped_destination_entry();
                    }
                    return Ok(());
                }
                let source = fs::symlink_metadata(source_root.join(path));
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
                        ) && mode == Mode::Mirror =>
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
                let action = Action {
                    rel_path: path.to_path_buf(),
                    bytes: entry.size,
                    source_mtime: None,
                    old_bytes: Some(entry.size),
                    reason: reason.into(),
                    structural_conflict,
                };
                match structural_conflict {
                    Some(_) => sink
                        .destination_file_replacement(&action)
                        .map_err(io::Error::other),
                    None => sink.file_delete(&action).map_err(io::Error::other),
                }
            })
            .map_err(|error| scan_error(destination_root, error))?;
        sink.destination_entries(destination_entries);
    }

    walk_stray_temps(destination_root, |path| {
        let bytes = fs::symlink_metadata(destination_root.join(path))?.len();
        let action = Action {
            rel_path: path.to_path_buf(),
            bytes,
            source_mtime: None,
            old_bytes: None,
            reason: "abandoned temp".into(),
            structural_conflict: None,
        };
        sink.cleanup(&action).map_err(io::Error::other)
    })
    .map_err(|error| scan_error(destination_root, error))?;
    Ok(())
}

/// Assembles today's [`Plan`] from the single [`traverse`] pass. Exclusions
/// live only here (the public plan the streaming surface serves has none), so
/// the buffering sink is the one that drops a matched row and counts it. The
/// closing vectors are name-sorted for the human diff; the structural conflict
/// each row already carries is never rewritten.
struct BufferingSink<'a> {
    plan: Plan,
    mode: Mode,
    excludes: &'a [String],
    actionable: BTreeSet<PathBuf>,
}

impl<'a> BufferingSink<'a> {
    fn new(mode: Mode, excludes: &'a [String]) -> Self {
        BufferingSink {
            plan: Plan::default(),
            mode,
            excludes,
            actionable: BTreeSet::new(),
        }
    }

    fn is_excluded(&self, path: &Path) -> bool {
        self.excludes
            .iter()
            .any(|excluded| Path::new(excluded) == path)
    }

    fn finish(mut self) -> Plan {
        self.plan
            .copies
            .sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
        self.plan
            .updates
            .sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
        self.plan
            .deletes
            .sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
        self.plan.strays.sort();
        self.plan.unknown_excludes = self
            .excludes
            .iter()
            .filter(|excluded| !self.actionable.contains(Path::new(excluded)))
            .cloned()
            .collect();
        self.plan
    }
}

impl PlanSink for BufferingSink<'_> {
    fn copy(&mut self, action: &Action) -> Result<(), AppError> {
        self.plan.scanned += 1;
        self.actionable.insert(action.rel_path.clone());
        if self.is_excluded(&action.rel_path) {
            self.plan.excluded += 1;
        } else {
            self.plan.copies.push(action.clone());
        }
        Ok(())
    }

    fn update(&mut self, action: &Action) -> Result<(), AppError> {
        self.plan.scanned += 1;
        self.actionable.insert(action.rel_path.clone());
        if self.is_excluded(&action.rel_path) {
            self.plan.excluded += 1;
        } else {
            self.plan.updates.push(action.clone());
        }
        Ok(())
    }

    fn error(&mut self, error: &PlanError) -> Result<(), AppError> {
        self.plan.scanned += 1;
        self.actionable.insert(error.rel_path.clone());
        if self.is_excluded(&error.rel_path) {
            self.plan.excluded += 1;
        } else {
            self.plan.errors.push(error.clone());
        }
        Ok(())
    }

    fn unchanged(&mut self, path: &Path) -> Result<(), AppError> {
        self.plan.scanned += 1;
        self.plan.unchanged += 1;
        self.plan.unchanged_paths.push(path.to_path_buf());
        Ok(())
    }

    fn destination_directory_replacement(&mut self, action: &Action) -> Result<(), AppError> {
        // A destination-only directory delete is a Mirror-only outcome, so
        // only Mirror counts it toward `scanned` (Update reproduces the
        // replacement row without ever scanning a destination directory).
        if self.mode == Mode::Mirror {
            self.plan.scanned += 1;
        }
        self.plan.directory_deletes.insert(action.rel_path.clone());
        if self.is_excluded(&action.rel_path) {
            self.plan.excluded += 1;
        } else {
            self.plan.deletes.push(action.clone());
        }
        Ok(())
    }

    fn new_directory(&mut self, action: &Action) -> Result<(), AppError> {
        if self.is_excluded(&action.rel_path) {
            self.plan.excluded += 1;
            return Ok(());
        }
        self.plan.scanned += 1;
        self.plan.copies.push(action.clone());
        self.plan.directory_copies.insert(action.rel_path.clone());
        Ok(())
    }

    fn directory_delete(&mut self, action: &Action) -> Result<(), AppError> {
        if self.is_excluded(&action.rel_path) {
            self.plan.excluded += 1;
            return Ok(());
        }
        self.plan.scanned += 1;
        self.plan.deletes.push(action.clone());
        self.plan.directory_deletes.insert(action.rel_path.clone());
        Ok(())
    }

    fn file_delete(&mut self, action: &Action) -> Result<(), AppError> {
        self.plan.scanned += 1;
        self.actionable.insert(action.rel_path.clone());
        if self.is_excluded(&action.rel_path) {
            self.plan.excluded += 1;
        } else {
            self.plan.deletes.push(action.clone());
        }
        Ok(())
    }

    fn destination_file_replacement(&mut self, action: &Action) -> Result<(), AppError> {
        self.plan.scanned += 1;
        self.actionable.insert(action.rel_path.clone());
        if self.is_excluded(&action.rel_path) {
            self.plan.excluded += 1;
        } else {
            self.plan.deletes.push(action.clone());
        }
        Ok(())
    }

    fn skipped_destination_entry(&mut self) {
        self.plan.scanned += 1;
    }

    fn cleanup(&mut self, action: &Action) -> Result<(), AppError> {
        self.plan.strays.push(action.rel_path.clone());
        Ok(())
    }

    fn source_entries(&mut self, count: usize) {
        self.plan.source_entries = count;
    }

    fn destination_entries(&mut self, count: usize) {
        self.plan.destination_entries = count;
    }
}

/// Writes the NDJSON action stream row-by-row from the single [`traverse`]
/// pass, holding memory constant. It reproduces the streaming surface's stats
/// arithmetic exactly, so the closing summary matches the golden captures.
struct StreamingSink<'a> {
    plan_id: &'a str,
    stats: StreamStats,
}

impl<'a> StreamingSink<'a> {
    fn new(plan_id: &'a str) -> Self {
        StreamingSink {
            plan_id,
            stats: StreamStats::default(),
        }
    }

    fn emit_action(&self, op: PlanOperation, action: &Action) -> Result<(), AppError> {
        crate::ndjson::stdout(&plan_action_row(self.plan_id, op, action))
    }
}

impl PlanSink for StreamingSink<'_> {
    fn copy(&mut self, action: &Action) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.copies += 1;
        self.emit_action(PlanOperation::Copy, action)
    }

    fn update(&mut self, action: &Action) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.updates += 1;
        self.emit_action(PlanOperation::Update, action)
    }

    fn error(&mut self, error: &PlanError) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.errors += 1;
        crate::ndjson::stdout(&serde_json::json!({
            "schema": "vibefilesync.plan/v1", "type": "action", "plan_id": self.plan_id,
            "op": PlanOperation::Error, "path": error.rel_path.to_string_lossy(),
            "reason": error.message
        }))
    }

    fn unchanged(&mut self, _path: &Path) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.unchanged += 1;
        Ok(())
    }

    fn destination_directory_replacement(&mut self, action: &Action) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.deletes += 1;
        self.emit_action(PlanOperation::Delete, action)
    }

    fn new_directory(&mut self, action: &Action) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.copies += 1;
        self.emit_action(PlanOperation::Copy, action)
    }

    fn directory_delete(&mut self, action: &Action) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.deletes += 1;
        self.emit_action(PlanOperation::Delete, action)
    }

    fn file_delete(&mut self, action: &Action) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.deletes += 1;
        self.emit_action(PlanOperation::Delete, action)
    }

    fn destination_file_replacement(&mut self, action: &Action) -> Result<(), AppError> {
        self.stats.scanned += 1;
        self.stats.deletes += 1;
        self.emit_action(PlanOperation::Delete, action)
    }

    fn skipped_destination_entry(&mut self) {
        self.stats.scanned += 1;
    }

    fn cleanup(&mut self, action: &Action) -> Result<(), AppError> {
        self.stats.cleanup += 1;
        self.emit_action(PlanOperation::Cleanup, action)
    }

    fn source_entries(&mut self, _count: usize) {}
    fn destination_entries(&mut self, _count: usize) {}
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
    let mut sink = BufferingSink::new(pair.mode, excludes);
    traverse(
        &pair.source,
        &pair.destination,
        pair.mode,
        setup.supports_symlinks,
        setup.mtime_tolerance,
        setup.skip_apple_double,
        &mut sink,
    )?;
    Ok((pair, sink.finish()))
}

// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
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
        plan.scanned += 1;
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
            plan.scanned += 1;
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

// Superseded by the single `traverse` pass (issue #70). Kept in place,
// unused, until removal in issue #71 proves the equivalence stands.
#[allow(dead_code)]
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
            structural.push(destination_directory_replacement(&copy.rel_path));
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

    /// A sink that records the ordered sequence of decisions `traverse` yields,
    /// so a test can assert the complete row sequence for a scenario — the
    /// single traversal is the sole authority, and its output order is what the
    /// two production adapters both consume.
    #[derive(Default)]
    struct RecordingSink {
        rows: Vec<String>,
    }

    impl RecordingSink {
        fn note(&mut self, kind: &str, action: &Action) {
            let conflict = match action.structural_conflict {
                Some(StructuralConflict::DestinationFile) => " [file]",
                Some(StructuralConflict::DestinationDirectory) => " [dir]",
                None => "",
            };
            self.rows.push(format!(
                "{kind} {} ({}){conflict}",
                action.rel_path.display(),
                action.reason
            ));
        }
    }

    impl PlanSink for RecordingSink {
        fn copy(&mut self, action: &Action) -> Result<(), AppError> {
            self.note("copy", action);
            Ok(())
        }
        fn update(&mut self, action: &Action) -> Result<(), AppError> {
            self.note("update", action);
            Ok(())
        }
        fn error(&mut self, error: &PlanError) -> Result<(), AppError> {
            self.rows
                .push(format!("error {}", error.rel_path.display()));
            Ok(())
        }
        fn unchanged(&mut self, path: &Path) -> Result<(), AppError> {
            self.rows.push(format!("unchanged {}", path.display()));
            Ok(())
        }
        fn destination_directory_replacement(&mut self, action: &Action) -> Result<(), AppError> {
            self.note("delete", action);
            Ok(())
        }
        fn new_directory(&mut self, action: &Action) -> Result<(), AppError> {
            self.note("copy", action);
            Ok(())
        }
        fn directory_delete(&mut self, action: &Action) -> Result<(), AppError> {
            self.note("delete", action);
            Ok(())
        }
        fn file_delete(&mut self, action: &Action) -> Result<(), AppError> {
            self.note("delete", action);
            Ok(())
        }
        fn destination_file_replacement(&mut self, action: &Action) -> Result<(), AppError> {
            self.note("delete", action);
            Ok(())
        }
        fn skipped_destination_entry(&mut self) {
            self.rows.push("skip".into());
        }
        fn cleanup(&mut self, action: &Action) -> Result<(), AppError> {
            self.note("cleanup", action);
            Ok(())
        }
        fn source_entries(&mut self, _count: usize) {}
        fn destination_entries(&mut self, _count: usize) {}
    }

    fn record(source: &Path, destination: &Path, mode: Mode) -> Vec<String> {
        let mut sink = RecordingSink::default();
        traverse(
            source,
            destination,
            mode,
            true,
            Duration::ZERO,
            false,
            &mut sink,
        )
        .expect("traversal over temp trees");
        sink.rows
    }

    #[test]
    fn traversal_yields_a_new_empty_directory_as_one_copy_row() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        fs::create_dir(source.path().join("empty")).unwrap();

        assert_eq!(
            record(source.path(), destination.path(), Mode::Mirror),
            ["copy empty (new directory)"]
        );
    }

    #[test]
    fn traversal_yields_a_removed_directory_as_one_delete_row_in_mirror() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        fs::create_dir(destination.path().join("gone")).unwrap();
        fs::write(destination.path().join("gone/inner.txt"), "x").unwrap();

        // The directory collapses its content into a single delete; the file
        // beneath it is skipped, not planned as its own removal.
        assert_eq!(
            record(source.path(), destination.path(), Mode::Mirror),
            ["delete gone (directory not in source)", "skip"]
        );
        // Update never plans a removal, so the same tree yields nothing.
        assert!(record(source.path(), destination.path(), Mode::Update).is_empty());
    }

    #[test]
    fn traversal_tags_structural_replacements_on_the_yielded_row() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        // A source file where the destination holds a directory, and a source
        // directory where the destination holds a file.
        fs::write(source.path().join("node"), "file now").unwrap();
        fs::create_dir_all(destination.path().join("node/sub")).unwrap();
        fs::write(destination.path().join("node/sub/old.txt"), "old").unwrap();
        fs::create_dir(source.path().join("tree")).unwrap();
        fs::write(source.path().join("tree/inner.txt"), "inner").unwrap();
        fs::write(destination.path().join("tree"), "was a file").unwrap();

        assert_eq!(
            record(source.path(), destination.path(), Mode::Mirror),
            [
                "copy node (new)",
                "delete node (replaced by source file) [dir]",
                "copy tree/inner.txt (new)",
                "skip",
                "delete tree (replaced by source directory) [file]",
            ]
        );
    }
}
