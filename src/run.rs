//! Destination mutation: a sibling dot-temp passes durability and verification
//! before SafetyNet archives any old destination object and Publish renames the
//! verified temp into place (ADR-0001 and ADR-0008).

use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use crate::error::{AppError, EXIT_BLOCKED_PLAN, EXIT_OK};
use crate::journal::{Counts, Journal, Operation, PairLock, RunStats};
use crate::plan::{self, Action};

const COPYFILE_ALL_WITHOUT_ACLS: u32 = (1 << 1) | (1 << 2) | (1 << 3);
const F_FULLFSYNC: libc::c_int = 51;

extern "C" {
    fn copyfile(
        from: *const libc::c_char,
        to: *const libc::c_char,
        state: *mut libc::c_void,
        flags: u32,
    ) -> libc::c_int;
    fn listxattr(
        path: *const libc::c_char,
        list: *mut libc::c_char,
        size: usize,
        options: libc::c_int,
    ) -> isize;
}

struct RunOptions<'a> {
    yes: bool,
    permanent_delete: bool,
    allow_empty_source: bool,
    ignore_space_check: bool,
    excludes: &'a [String],
}

enum RunOutput {
    Human,
    Json,
}

pub fn run(
    config_path: &Path,
    pair_name: &str,
    yes: bool,
    permanent_delete: bool,
    allow_empty_source: bool,
    ignore_space_check: bool,
    excludes: &[String],
) -> Result<i32, AppError> {
    run_impl(
        config_path,
        pair_name,
        RunOptions {
            yes,
            permanent_delete,
            allow_empty_source,
            ignore_space_check,
            excludes,
        },
        RunOutput::Human,
    )
}

/// Executes the same durable run protocol as [`run`], but writes only the
/// versioned NDJSON agent stream to stdout (ADR-0004).
pub fn run_json(
    config_path: &Path,
    pair_name: &str,
    yes: bool,
    permanent_delete: bool,
    allow_empty_source: bool,
    ignore_space_check: bool,
    excludes: &[String],
) -> Result<i32, AppError> {
    run_impl(
        config_path,
        pair_name,
        RunOptions {
            yes,
            permanent_delete,
            allow_empty_source,
            ignore_space_check,
            excludes,
        },
        RunOutput::Json,
    )
}

fn run_impl(
    config_path: &Path,
    pair_name: &str,
    options: RunOptions<'_>,
    output: RunOutput,
) -> Result<i32, AppError> {
    let json_output = matches!(output, RunOutput::Json);
    let config = crate::config::load(config_path)?;
    if !config.pairs.contains_key(pair_name) {
        return Err(AppError::Usage(format!("pair '{pair_name}' not found")));
    }
    let _pair_lock = PairLock::acquire(pair_name).map_err(lock_error)?;
    let (pair, initial_plan) = plan::build(config_path, pair_name, options.excludes)?;
    if !json_output {
        print!("{}", plan::render(&initial_plan, pair_name, pair.mode));
    }

    let run_warnings = crate::preconditions::check_run(
        &pair,
        &initial_plan,
        options.allow_empty_source,
        options.ignore_space_check,
    )?;
    for warning in &run_warnings {
        eprintln!("{warning}");
    }

    if !initial_plan.errors.is_empty() {
        eprintln!(
            "vibesync: run blocked by {} plan error(s)",
            initial_plan.errors.len()
        );
        return Ok(EXIT_BLOCKED_PLAN);
    }

    if !options.yes && !confirm(json_output)? {
        if json_output {
            eprintln!("Run cancelled; destination unchanged.");
        } else {
            println!("Run cancelled; destination unchanged.");
        }
        return Ok(EXIT_OK);
    }

    let mut journal = Journal::create(pair_name, &pair.destination).map_err(io_error)?;
    journal
        .run_start(pair_name, &initial_plan, &run_warnings)
        .map_err(io_error)?;
    let mut stream = json_output.then(JsonRunStream::new);
    if let Some(stream) = stream.as_mut() {
        stream.run_start(journal.run_id(), pair_name, &initial_plan, &run_warnings)?;
    }
    let mut stats = RunStats {
        counts: Counts {
            planned: initial_plan.copies.len()
                + initial_plan.updates.len()
                + initial_plan.deletes.len()
                + initial_plan.strays.len(),
            ..Counts::default()
        },
        ..RunStats::default()
    };
    for stray in &initial_plan.strays {
        let action = Action {
            rel_path: stray.clone(),
            bytes: fs::metadata(pair.destination.join(stray))
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            old_bytes: None,
            reason: "abandoned temp".to_string(),
        };
        journal
            .action_start(Operation::Cleanup, &action, None, None)
            .map_err(journal_runtime_error)?;
        if let Some(stream) = stream.as_mut() {
            stream.action_start(journal.run_id(), Operation::Cleanup, &action)?;
        }
        match fs::remove_file(pair.destination.join(stray)) {
            Ok(()) => {
                journal
                    .action_done(Operation::Cleanup, &action, None, &[])
                    .map_err(journal_runtime_error)?;
                if let Some(stream) = stream.as_mut() {
                    stream.action_done(journal.run_id(), Operation::Cleanup, &action, None, &[])?;
                }
                stats.counts.done += 1;
                if !json_output {
                    println!("Cleaned stray temp: {}", stray.display());
                }
            }
            Err(error) => {
                stats.counts.failed += 1;
                journal
                    .action_failed(Operation::Cleanup, &action, &error.to_string())
                    .map_err(journal_runtime_error)?;
                if let Some(stream) = stream.as_mut() {
                    stream.action_failed(
                        journal.run_id(),
                        Operation::Cleanup,
                        &action,
                        &error.to_string(),
                    )?;
                }
                eprintln!("vibesync: cleanup {} failed: {error}", stray.display());
                journal.summary(&stats).map_err(journal_runtime_error)?;
                if let Some(stream) = stream.as_mut() {
                    stream.summary(journal.run_id(), &stats)?;
                }
                return Ok(1);
            }
        }
    }
    // Cleanup changes the destination, so the action set below must come from
    // a new scan rather than from the scan that discovered the abandoned temp.
    let (pair, mut plan) = plan::build(config_path, pair_name, options.excludes)?;
    if !plan.errors.is_empty() {
        eprintln!(
            "vibesync: run blocked by {} plan error(s)",
            plan.errors.len()
        );
        stats.counts.failed += plan.errors.len();
        journal.summary(&stats).map_err(journal_runtime_error)?;
        if let Some(stream) = stream.as_mut() {
            stream.summary(journal.run_id(), &stats)?;
        }
        return Ok(EXIT_BLOCKED_PLAN);
    }
    for (operation, action) in missing_reviewed_actions(&initial_plan, &plan) {
        let source = match operation {
            Operation::Copy | Operation::Update => Some(pair.source.join(&action.rel_path)),
            Operation::Delete | Operation::Cleanup => None,
        };
        journal
            .action_start(operation, action, source.as_deref(), None)
            .map_err(journal_runtime_error)?;
        if let Some(stream) = stream.as_mut() {
            stream.action_start(journal.run_id(), operation, action)?;
        }
        journal
            .action_failed(
                operation,
                action,
                "changed during reconciliation; rerun required",
            )
            .map_err(journal_runtime_error)?;
        if let Some(stream) = stream.as_mut() {
            stream.action_failed(
                journal.run_id(),
                operation,
                action,
                "changed during reconciliation; rerun required",
            )?;
        }
        stats.counts.failed += 1;
        eprintln!(
            "vibesync: {} {} changed during reconciliation; rerun required",
            operation.as_str().to_ascii_uppercase(),
            action.rel_path.display()
        );
    }
    retain_reviewed_actions(&mut plan, &initial_plan);
    for (operation, action) in plan
        .copies
        .iter()
        .map(|action| (Operation::Copy, action))
        .chain(
            plan.updates
                .iter()
                .map(|action| (Operation::Update, action)),
        )
    {
        let source = pair.source.join(&action.rel_path);
        let destination = pair.destination.join(&action.rel_path);
        let temp = temporary_path(&destination, journal.run_id());
        journal
            .action_start(operation, action, Some(&source), Some(&temp))
            .map_err(journal_runtime_error)?;
        if let Some(stream) = stream.as_mut() {
            stream.action_start(journal.run_id(), operation, action)?;
        }
        match copy_file(
            &pair.destination,
            &source,
            &destination,
            &temp,
            action,
            journal.run_id(),
            options.permanent_delete,
        ) {
            Ok(outcome) => {
                journal
                    .action_done(
                        operation,
                        action,
                        outcome.safety_net.as_deref(),
                        &outcome.warnings,
                    )
                    .map_err(journal_runtime_error)?;
                if let Some(stream) = stream.as_mut() {
                    stream.action_done(
                        journal.run_id(),
                        operation,
                        action,
                        outcome.safety_net.as_deref(),
                        &outcome.warnings,
                    )?;
                }
                stats.counts.done += 1;
                stats.bytes += action.bytes;
                stats.warnings += outcome.warnings.len();
                match operation {
                    Operation::Copy => stats.counts.copied += 1,
                    Operation::Update => stats.counts.updated += 1,
                    Operation::Delete | Operation::Cleanup => {
                        unreachable!("deletes and cleanup use their own execution loops")
                    }
                }
            }
            Err(error) => {
                stats.counts.failed += 1;
                journal
                    .action_failed(operation, action, &error.to_string())
                    .map_err(journal_runtime_error)?;
                if let Some(stream) = stream.as_mut() {
                    stream.action_failed(
                        journal.run_id(),
                        operation,
                        action,
                        &error.to_string(),
                    )?;
                }
                eprintln!(
                    "vibesync: {} {} failed: {error}",
                    operation.as_str().to_ascii_uppercase(),
                    action.rel_path.display()
                );
                if error.raw_os_error() == Some(libc::ENOSPC) {
                    eprintln!("vibesync: destination full; stopped after committed files and discarded the in-progress temp");
                }
                journal.summary(&stats).map_err(journal_runtime_error)?;
                if let Some(stream) = stream.as_mut() {
                    stream.summary(journal.run_id(), &stats)?;
                }
                return Ok(1);
            }
        }
    }
    for action in &plan.deletes {
        let destination = pair.destination.join(&action.rel_path);
        journal
            .action_start(Operation::Delete, action, None, None)
            .map_err(journal_runtime_error)?;
        if let Some(stream) = stream.as_mut() {
            stream.action_start(journal.run_id(), Operation::Delete, action)?;
        }
        match remove_file(
            &pair.destination,
            &destination,
            &action.rel_path,
            journal.run_id(),
            options.permanent_delete,
        ) {
            Ok(safety_net) => {
                journal
                    .action_done(Operation::Delete, action, safety_net.as_deref(), &[])
                    .map_err(journal_runtime_error)?;
                if let Some(stream) = stream.as_mut() {
                    stream.action_done(
                        journal.run_id(),
                        Operation::Delete,
                        action,
                        safety_net.as_deref(),
                        &[],
                    )?;
                }
                stats.counts.done += 1;
                stats.counts.deleted += 1;
                stats.bytes += action.bytes;
            }
            Err(error) => {
                stats.counts.failed += 1;
                journal
                    .action_failed(Operation::Delete, action, &error.to_string())
                    .map_err(journal_runtime_error)?;
                if let Some(stream) = stream.as_mut() {
                    stream.action_failed(
                        journal.run_id(),
                        Operation::Delete,
                        action,
                        &error.to_string(),
                    )?;
                }
                eprintln!(
                    "vibesync: DELETE {} failed: {error}",
                    action.rel_path.display()
                );
            }
        }
    }

    journal.summary(&stats).map_err(journal_runtime_error)?;
    if let Some(stream) = stream.as_mut() {
        stream.summary(journal.run_id(), &stats)?;
    }
    if stats.counts.failed == 0 {
        Ok(EXIT_OK)
    } else {
        Ok(1)
    }
}

/// A reconciliation scan is authoritative about the destination, but it must
/// not broaden a reviewed run when source or destination content changes
/// between the review and the cleanup. Newly discovered work waits for the
/// next `plan`/`run` invocation.
fn retain_reviewed_actions(fresh: &mut plan::Plan, reviewed: &plan::Plan) {
    fresh
        .copies
        .retain(|action| reviewed.copies.contains(action));
    fresh
        .updates
        .retain(|action| reviewed.updates.contains(action));
    fresh
        .deletes
        .retain(|action| reviewed.deletes.contains(action));
}

fn missing_reviewed_actions<'a>(
    reviewed: &'a plan::Plan,
    fresh: &plan::Plan,
) -> Vec<(Operation, &'a Action)> {
    reviewed
        .copies
        .iter()
        .filter(|action| !fresh.copies.contains(*action))
        .map(|action| (Operation::Copy, action))
        .chain(
            reviewed
                .updates
                .iter()
                .filter(|action| !fresh.updates.contains(*action))
                .map(|action| (Operation::Update, action)),
        )
        .chain(
            reviewed
                .deletes
                .iter()
                .filter(|action| !fresh.deletes.contains(*action))
                .map(|action| (Operation::Delete, action)),
        )
        .collect()
}

fn confirm(json_output: bool) -> Result<bool, AppError> {
    if json_output {
        eprint!("Proceed with COPY actions? [y/N] ");
        io::stderr().flush().map_err(io_error)?;
    } else {
        print!("Proceed with COPY actions? [y/N] ");
        io::stdout().flush().map_err(io_error)?;
    }
    let mut response = String::new();
    io::stdin().read_line(&mut response).map_err(io_error)?;
    Ok(matches!(
        response.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

fn copy_file(
    destination_root: &Path,
    source: &Path,
    destination: &Path,
    temp: &Path,
    action: &Action,
    run_id: &str,
    permanent_delete: bool,
) -> io::Result<ActionOutcome> {
    let source_before = fs::metadata(source)?;
    let parent = destination
        .parent()
        .expect("relative COPY path always has a parent");
    fs::create_dir_all(parent)?;
    let result = (|| {
        copyfile_all_but_acls(source, temp)?;
        crash_at("copy_complete");
        #[cfg(feature = "fault-injection")]
        if std::env::var_os("VIBESYNC_TEST_ENOSPC_PATH")
            .is_some_and(|path| Path::new(&path) == action.rel_path)
        {
            return Err(io::Error::from_raw_os_error(libc::ENOSPC));
        }
        fully_sync(temp)?;
        let warnings = verify(source, &source_before, temp, action.bytes)?;
        let safety_net = remove_file(
            destination_root,
            destination,
            &action.rel_path,
            run_id,
            permanent_delete,
        )?;
        fs::rename(temp, destination)?;
        sync_directory(parent)?;
        for warning in &warnings {
            eprintln!(
                "vibesync: COPY {} warning: {warning}",
                action.rel_path.display()
            );
        }
        Ok(ActionOutcome {
            safety_net,
            warnings,
        })
    })();

    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

#[cfg(feature = "fault-injection")]
fn crash_at(transition: &str) {
    if std::env::var("VIBESYNC_TEST_CRASH_AT").ok().as_deref() == Some(transition) {
        std::process::abort();
    }
}

#[cfg(not(feature = "fault-injection"))]
fn crash_at(_: &str) {}

struct ActionOutcome {
    safety_net: Option<PathBuf>,
    warnings: Vec<String>,
}

/// The live agent stream is intentionally separate from the durable Journal:
/// the Journal stays the forensic record, while this writer is a pure stdout
/// transport for a caller that is already watching the process.  `copyfile`
/// exposes no byte-progress callback, so this implementation deliberately
/// emits no synthetic `progress` rows; claiming progress after a completed
/// copy would violate the contract.
struct JsonRunStream;

impl JsonRunStream {
    fn new() -> Self {
        Self
    }

    fn run_start(
        &mut self,
        run_id: &str,
        pair_name: &str,
        plan: &plan::Plan,
        warnings: &[String],
    ) -> Result<(), AppError> {
        let mut actions = Vec::new();
        actions.extend(
            plan.copies
                .iter()
                .map(|action| planned_action("copy", action)),
        );
        actions.extend(
            plan.updates
                .iter()
                .map(|action| planned_action("update", action)),
        );
        actions.extend(
            plan.deletes
                .iter()
                .map(|action| planned_action("delete", action)),
        );
        actions.extend(
            plan.strays
                .iter()
                .map(|path| planned_action("cleanup", &cleanup_action(path))),
        );
        self.emit(json!({
            "schema": "vibefilesync.run/v1",
            "type": "run_start",
            "run_id": run_id,
            "pair": pair_name,
            "planned_actions": actions,
            "warnings": warnings,
        }))
    }

    fn action_start(
        &mut self,
        run_id: &str,
        operation: Operation,
        action: &Action,
    ) -> Result<(), AppError> {
        self.emit(json!({
            "schema": "vibefilesync.run/v1",
            "type": "action_start",
            "run_id": run_id,
            "op": operation.as_str(),
            "path": path_text(&action.rel_path),
            "bytes": action.bytes,
        }))
    }

    fn action_done(
        &mut self,
        run_id: &str,
        operation: Operation,
        action: &Action,
        safety_net: Option<&Path>,
        warnings: &[String],
    ) -> Result<(), AppError> {
        self.emit(json!({
            "schema": "vibefilesync.run/v1",
            "type": "action_done",
            "run_id": run_id,
            "op": operation.as_str(),
            "path": path_text(&action.rel_path),
            "result": "done",
            "bytes": action.bytes,
            "verified": if matches!(operation, Operation::Copy | Operation::Update) { json!("standard") } else { serde_json::Value::Null },
            "safety_net": safety_net.map(path_text),
            "warnings": warnings,
        }))
    }

    fn action_failed(
        &mut self,
        run_id: &str,
        operation: Operation,
        action: &Action,
        reason: &str,
    ) -> Result<(), AppError> {
        self.emit(json!({
            "schema": "vibefilesync.run/v1",
            "type": "action_failed",
            "run_id": run_id,
            "op": operation.as_str(),
            "path": path_text(&action.rel_path),
            "result": "failed",
            "bytes": action.bytes,
            "reason": reason,
            "warnings": [],
        }))
    }

    fn summary(&mut self, run_id: &str, stats: &RunStats) -> Result<(), AppError> {
        self.emit(json!({
            "schema": "vibefilesync.run/v1",
            "type": "summary",
            "run_id": run_id,
            "result": if stats.counts.failed == 0 { "success" } else { "partial" },
            "counts": stats.counts,
            "bytes": stats.bytes,
            "warnings": stats.warnings,
        }))
    }

    fn emit(&mut self, event: serde_json::Value) -> Result<(), AppError> {
        let mut stdout = io::stdout().lock();
        serde_json::to_writer(&mut stdout, &event).map_err(|error| {
            AppError::Interrupted(format!("could not write JSON output: {error}"))
        })?;
        stdout
            .write_all(b"\n")
            .and_then(|()| stdout.flush())
            .map_err(|error| AppError::Interrupted(format!("could not write JSON output: {error}")))
    }
}

fn planned_action(operation: &str, action: &Action) -> serde_json::Value {
    json!({
        "op": operation,
        "path": path_text(&action.rel_path),
        "bytes": action.bytes,
    })
}

fn cleanup_action(path: &Path) -> Action {
    Action {
        rel_path: path.to_path_buf(),
        bytes: 0,
        old_bytes: None,
        reason: "abandoned temp".to_string(),
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Removes a final destination object only after the copy gate has passed,
/// either by SafetyNet rename or by the deliberate per-run bypass. A missing
/// path is harmless: a concurrent removal cannot be made safer by failing a
/// verified Publish.
fn remove_file(
    destination_root: &Path,
    destination: &Path,
    relative_path: &Path,
    run_id: &str,
    permanent_delete: bool,
) -> io::Result<Option<PathBuf>> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_dir() => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination path is a directory",
        )),
        Ok(_) if permanent_delete => fs::remove_file(destination).map(|()| None),
        Ok(_) => archive_by_rename(destination_root, destination, relative_path, run_id).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Makes the old version visible in SafetyNet with its relative path kept
/// intact. It is a same-volume rename rooted at the destination, never a
/// copy, so the prior version remains independently restorable with Finder
/// or `cp` alone.
fn archive_by_rename(
    destination_root: &Path,
    destination: &Path,
    relative_path: &Path,
    run_id: &str,
) -> io::Result<PathBuf> {
    let archive = destination_root
        .join("_SafetyNet")
        .join(run_id)
        .join(relative_path);
    let archive_parent = archive
        .parent()
        .expect("archive relative path has a parent");
    fs::create_dir_all(archive_parent)?;
    fs::rename(destination, &archive)?;
    sync_directory(archive_parent)?;
    if let Some(destination_parent) = destination.parent() {
        sync_directory(destination_parent)?;
    }
    Ok(archive)
}

/// Deletes only direct, real Run folders below this pair's visible
/// `_SafetyNet/` root. No run path is pruned automatically.
pub fn prune(config_path: &Path, pair_name: &str) -> Result<i32, AppError> {
    let config = crate::config::load(config_path)?;
    let pair = config
        .pairs
        .get(pair_name)
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))?;
    let _pair_lock = PairLock::acquire(pair_name).map_err(lock_error)?;
    let safety_net = pair.destination.join("_SafetyNet");
    let entries = match fs::read_dir(&safety_net) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(EXIT_OK),
        Err(error) => return Err(io_error(error)),
    };
    for entry in entries {
        let entry = entry.map_err(io_error)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if metadata.file_type().is_dir() && crate::journal::is_run_id(&entry.file_name()) {
            fs::remove_dir_all(entry.path()).map_err(io_error)?;
        }
    }
    Ok(EXIT_OK)
}

fn temporary_path(destination: &Path, run_id: &str) -> PathBuf {
    let parent = destination.parent().expect("destination has parent");
    let name = destination
        .file_name()
        .expect("destination has name")
        .to_string_lossy();
    let mut suffix = 1;
    loop {
        let id = if suffix == 1 {
            run_id.to_owned()
        } else {
            format!("{run_id}-{suffix}")
        };
        let candidate = parent.join(format!(".{name}.vibesync-tmp-{id}"));
        if !candidate.exists() {
            return candidate;
        }
        suffix += 1;
    }
}

fn copyfile_all_but_acls(source: &Path, destination: &Path) -> io::Result<()> {
    let source = c_path(source)?;
    let destination = c_path(destination)?;
    let result = unsafe {
        copyfile(
            source.as_ptr(),
            destination.as_ptr(),
            std::ptr::null_mut(),
            COPYFILE_ALL_WITHOUT_ACLS,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn fully_sync(path: &Path) -> io::Result<()> {
    let file = File::open(path)?;
    file.sync_all()?;
    let result = unsafe { libc::fcntl(file.as_raw_fd(), F_FULLFSYNC) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

/// Data disagreement rejects the temp; metadata disagreement is reported as
/// a warning after Publish so a deterministic metadata quirk never prevents
/// the verified file contents from landing (ADR-0008).
fn verify(
    source: &Path,
    source_before: &fs::Metadata,
    temp: &Path,
    planned_size: u64,
) -> io::Result<Vec<String>> {
    let source_after = fs::metadata(source)?;
    if source_after.len() != source_before.len()
        || source_after.modified()? != source_before.modified()?
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "source changed during copy",
        ));
    }
    let copied = fs::metadata(temp)?;
    if copied.len() != planned_size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "verify mismatch: size differs",
        ));
    }
    let source_mtime = source_after.modified()?;
    let temp_mtime = copied.modified()?;
    let mut warnings = Vec::new();
    let delta = source_mtime.duration_since(temp_mtime).unwrap_or_else(|_| {
        temp_mtime
            .duration_since(source_mtime)
            .expect("opposite order works")
    });
    let destination_type = crate::volume::filesystem_type(temp).unwrap_or_default();
    let timestamp_granularity = if destination_type.eq_ignore_ascii_case("exfat") {
        Duration::from_secs(2)
    } else {
        Duration::from_secs(1)
    };
    if delta > timestamp_granularity {
        warnings.push("modified time differs".to_string());
    }
    // exFAT does not preserve POSIX extended attributes. They are an
    // expected degradation, so they are outside this standard-tier spot
    // check; capable filesystems must preserve the complete name set.
    let expected_xattrs = if destination_type.eq_ignore_ascii_case("exfat") {
        Vec::new()
    } else {
        xattr_names(source)?
    };
    if expected_xattrs != xattr_names(temp)? {
        warnings.push("xattr names differ".to_string());
    }
    Ok(warnings)
}

fn xattr_names(path: &Path) -> io::Result<Vec<Vec<u8>>> {
    let path = c_path(path)?;
    let length = unsafe { listxattr(path.as_ptr(), std::ptr::null_mut(), 0, 0) };
    if length < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut raw = vec![0_u8; length as usize];
    if length > 0 {
        let actual = unsafe { listxattr(path.as_ptr(), raw.as_mut_ptr().cast(), raw.len(), 0) };
        if actual < 0 {
            return Err(io::Error::last_os_error());
        }
        raw.truncate(actual as usize);
    }
    let mut names: Vec<_> = raw
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(Vec::from)
        .collect();
    names.sort_unstable();
    names.dedup();
    Ok(names)
}

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

fn io_error(error: io::Error) -> AppError {
    AppError::Precondition(error.to_string())
}

fn journal_runtime_error(error: io::Error) -> AppError {
    AppError::Interrupted(format!(
        "Journal write failed after the run started: {error}"
    ))
}

fn lock_error(error: io::Error) -> AppError {
    if error.kind() == io::ErrorKind::WouldBlock {
        AppError::Precondition("run already in progress".to_string())
    } else {
        io_error(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_suffixes_are_sibling_dot_files() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("photo.jpg");
        assert_eq!(
            temporary_path(&destination, "20260716T120000Z"),
            dir.path().join(".photo.jpg.vibesync-tmp-20260716T120000Z")
        );
    }

    #[test]
    fn reconciliation_scan_cannot_expand_reviewed_actions() {
        let reviewed = plan::Plan {
            copies: vec![Action {
                rel_path: PathBuf::from("reviewed.txt"),
                bytes: 1,
                old_bytes: None,
                reason: "new".to_string(),
            }],
            ..plan::Plan::default()
        };
        let mut fresh = plan::Plan {
            copies: vec![
                reviewed.copies[0].clone(),
                Action {
                    rel_path: PathBuf::from("arrived-later.txt"),
                    bytes: 2,
                    old_bytes: None,
                    reason: "new".to_string(),
                },
            ],
            ..plan::Plan::default()
        };

        retain_reviewed_actions(&mut fresh, &reviewed);

        assert_eq!(fresh.copies, reviewed.copies);
    }

    #[test]
    fn changed_reviewed_action_is_reported_as_missing() {
        let reviewed = plan::Plan {
            copies: vec![Action {
                rel_path: PathBuf::from("photo.txt"),
                bytes: 1,
                old_bytes: None,
                reason: "new".to_string(),
            }],
            ..plan::Plan::default()
        };
        let fresh = plan::Plan {
            copies: vec![Action {
                rel_path: PathBuf::from("photo.txt"),
                bytes: 2,
                old_bytes: None,
                reason: "new".to_string(),
            }],
            ..plan::Plan::default()
        };

        let missing = missing_reviewed_actions(&reviewed, &fresh);

        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].0.as_str(), "copy");
        assert_eq!(missing[0].1.rel_path, PathBuf::from("photo.txt"));
    }

    #[test]
    fn size_gate_failure_removes_temp_and_never_publishes() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("photo.jpg");
        let destination = destination_dir.path().join("photo.jpg");
        fs::write(&source, "complete file").unwrap();
        let action = Action {
            rel_path: PathBuf::from("photo.jpg"),
            bytes: 1, // independent planned expectation forces gate failure
            old_bytes: None,
            reason: "new".to_string(),
        };
        let temp = temporary_path(&destination, "20260716T120000Z");

        let result = copy_file(
            destination_dir.path(),
            &source,
            &destination,
            &temp,
            &action,
            "20260716T120000Z",
            false,
        );

        assert!(result.is_err());
        assert!(!destination.exists(), "an unverified file must not publish");
        assert!(
            fs::read_dir(destination_dir.path())
                .unwrap()
                .next()
                .is_none(),
            "failed copy leaves no temp behind"
        );
    }

    #[test]
    fn gate_failure_on_replacement_leaves_old_file_outside_safetynet() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("report.txt");
        let destination = destination_dir.path().join("report.txt");
        fs::write(&source, "new version").unwrap();
        fs::write(&destination, "old version").unwrap();
        let action = Action {
            rel_path: PathBuf::from("report.txt"),
            bytes: 1,
            old_bytes: None,
            reason: "size differs".to_string(),
        };
        let temp = temporary_path(&destination, "20260716T120000Z");

        let result = copy_file(
            destination_dir.path(),
            &source,
            &destination,
            &temp,
            &action,
            "20260716T120000Z",
            false,
        );

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "old version");
        assert!(
            !destination_dir.path().join("_SafetyNet").exists(),
            "archive is strictly after the verification gate"
        );
    }
}
