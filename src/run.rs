//! Destination mutation: a sibling dot-temp passes durability and verification
//! before SafetyNet archives any old destination object and Publish renames the
//! verified temp into place (ADR-0001 and ADR-0008).

use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::error::{AppError, EXIT_BLOCKED_PLAN, EXIT_OK};
use crate::journal::{Counts, Journal, Operation, PairLock, RunStats};
use crate::plan::{self, Action};

const COPYFILE_ALL_WITHOUT_ACLS: u32 = (1 << 1) | (1 << 2) | (1 << 3);
const F_FULLFSYNC: libc::c_int = 51;
const PROGRESS_THRESHOLD: u64 = 8 * 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const RUN_SCHEMA: &str = "vibefilesync.run/v1";
const COPYFILE_STATE_STATUS_CB: u32 = 6;
const COPYFILE_STATE_STATUS_CTX: u32 = 7;
const COPYFILE_STATE_COPIED: u32 = 8;
const COPYFILE_STATE_BSIZE: u32 = 13;
const COPYFILE_COPY_DATA: libc::c_int = 4;
const COPYFILE_ERR: libc::c_int = 3;
const COPYFILE_PROGRESS: libc::c_int = 4;
const COPYFILE_CONTINUE: libc::c_int = 0;
const COPYFILE_QUIT: libc::c_int = 2;

type CopyfileState = *mut libc::c_void;
type CopyfileCallback = unsafe extern "C" fn(
    libc::c_int,
    libc::c_int,
    CopyfileState,
    *const libc::c_char,
    *const libc::c_char,
    *mut libc::c_void,
) -> libc::c_int;

extern "C" {
    fn copyfile(
        from: *const libc::c_char,
        to: *const libc::c_char,
        state: CopyfileState,
        flags: u32,
    ) -> libc::c_int;
    fn copyfile_state_alloc() -> CopyfileState;
    fn copyfile_state_free(state: CopyfileState) -> libc::c_int;
    fn copyfile_state_get(
        state: CopyfileState,
        flag: u32,
        destination: *mut libc::c_void,
    ) -> libc::c_int;
    fn copyfile_state_set(
        state: CopyfileState,
        flag: u32,
        source: *const libc::c_void,
    ) -> libc::c_int;
    fn listxattr(
        path: *const libc::c_char,
        list: *mut libc::c_char,
        size: usize,
        options: libc::c_int,
    ) -> isize;
}

pub struct RunOptions<'a> {
    pub yes: bool,
    pub permanent_delete: bool,
    pub allow_empty_source: bool,
    pub ignore_space_check: bool,
    pub json_output: bool,
    pub full_verify: bool,
    pub excludes: &'a [String],
}

enum RunReporter {
    Human,
    Json,
}

impl RunReporter {
    fn new(json: bool) -> Self {
        if json {
            Self::Json
        } else {
            Self::Human
        }
    }

    fn is_json(&self) -> bool {
        matches!(self, Self::Json)
    }

    fn plan(&self, plan: &plan::Plan, pair: &str, mode: crate::config::Mode) {
        if matches!(self, Self::Human) {
            print!("{}", plan::render(plan, pair, mode));
        }
    }

    fn precondition_warnings(&self, warnings: &[String]) {
        if matches!(self, Self::Human) {
            for warning in warnings {
                eprintln!("{warning}");
            }
        }
    }

    fn blocked(&self, errors: usize) {
        if matches!(self, Self::Human) {
            eprintln!("vibesync: run blocked by {errors} plan error(s)");
        }
    }

    fn cancelled(&self) {
        if matches!(self, Self::Human) {
            println!("Run cancelled; destination unchanged.");
        }
    }

    fn confirm(&self) -> Result<bool, AppError> {
        match self {
            Self::Json => {
                eprint!("Proceed with COPY actions? [y/N] ");
                io::stderr().flush().map_err(io_error)?;
            }
            Self::Human => {
                print!("Proceed with COPY actions? [y/N] ");
                io::stdout().flush().map_err(io_error)?;
            }
        }
        let mut response = String::new();
        io::stdin().read_line(&mut response).map_err(io_error)?;
        Ok(matches!(
            response.trim().to_ascii_lowercase().as_str(),
            "y" | "yes"
        ))
    }

    fn run_start(
        &self,
        run_id: &str,
        pair: &str,
        mode: crate::config::Mode,
        destination: &Path,
        warnings: &[String],
        planned: usize,
    ) -> Result<(), AppError> {
        let mut event = crate::event::run_start(
            crate::event::Context {
                schema: RUN_SCHEMA,
                run_id,
            },
            pair,
            warnings,
            &crate::volume::expected_degradations(destination),
        );
        event["mode"] = serde_json::json!(mode);
        event["planned"] = planned.into();
        self.json(event)
    }

    fn action_start(
        &self,
        run_id: &str,
        operation: Operation,
        action: &Action,
    ) -> Result<(), AppError> {
        self.json(crate::event::action_start(
            crate::event::Context {
                schema: RUN_SCHEMA,
                run_id,
            },
            operation,
            action,
        ))?;
        if action.bytes >= PROGRESS_THRESHOLD
            && matches!(operation, Operation::Copy | Operation::Update)
        {
            self.progress(run_id, operation, action, 0)?;
        }
        Ok(())
    }

    fn progress(
        &self,
        run_id: &str,
        operation: Operation,
        action: &Action,
        bytes: u64,
    ) -> Result<(), AppError> {
        self.json(serde_json::json!({"schema":"vibefilesync.run/v1","type":"progress","run_id":run_id,"op":operation,"path":action.rel_path.to_string_lossy(),"bytes":bytes,"total_bytes":action.bytes}))
    }

    fn action_done(
        &self,
        run_id: &str,
        operation: Operation,
        action: &Action,
        safety_net: Option<&Path>,
        warnings: &[String],
        full_verify: bool,
    ) -> Result<(), AppError> {
        match self {
            Self::Json => crate::ndjson::stdout(&crate::event::action_done(
                crate::event::Context {
                    schema: RUN_SCHEMA,
                    run_id,
                },
                operation,
                action,
                safety_net,
                warnings,
                matches!(operation, Operation::Copy | Operation::Update)
                    .then_some(if full_verify { "full" } else { "standard" }),
                false,
            )),
            Self::Human => {
                for warning in warnings {
                    eprintln!(
                        "vibesync: {} {} warning: {warning}",
                        operation.as_str().to_ascii_uppercase(),
                        action.rel_path.display()
                    );
                }
                Ok(())
            }
        }
    }

    fn action_failed(
        &self,
        run_id: &str,
        operation: Operation,
        action: &Action,
        error: &io::Error,
    ) -> Result<(), AppError> {
        match self {
            Self::Json => crate::ndjson::stdout(&crate::event::action_failed(
                crate::event::Context {
                    schema: RUN_SCHEMA,
                    run_id,
                },
                operation,
                action,
                &error.to_string(),
            )),
            Self::Human => {
                eprintln!(
                    "vibesync: {} {} failed: {error}",
                    operation.as_str().to_ascii_uppercase(),
                    action.rel_path.display()
                );
                if error.raw_os_error() == Some(libc::ENOSPC) {
                    eprintln!("vibesync: destination full; stopped after committed files and discarded the in-progress temp");
                }
                Ok(())
            }
        }
    }

    fn cleaned(&self, path: &Path) {
        if matches!(self, Self::Human) {
            println!("Cleaned stray temp: {}", path.display());
        }
    }

    fn summary(&self, run_id: &str, stats: &RunStats) -> Result<(), AppError> {
        self.json(crate::event::summary(
            crate::event::Context {
                schema: RUN_SCHEMA,
                run_id,
            },
            stats,
        ))
    }

    fn json(&self, value: serde_json::Value) -> Result<(), AppError> {
        if matches!(self, Self::Json) {
            crate::ndjson::stdout(&value)?;
        }
        Ok(())
    }
}

pub fn run(config_path: &Path, pair_name: &str, options: RunOptions<'_>) -> Result<i32, AppError> {
    let RunOptions {
        yes,
        permanent_delete,
        allow_empty_source,
        ignore_space_check,
        json_output,
        full_verify,
        excludes,
    } = options;
    let reporter = RunReporter::new(json_output);
    let config = crate::config::load(config_path)?;
    if !config.pairs.contains_key(pair_name) {
        return Err(AppError::Usage(format!("pair '{pair_name}' not found")));
    }
    let _pair_lock = PairLock::acquire(pair_name).map_err(lock_error)?;
    let (pair, plan) = plan::build(config_path, pair_name, excludes)?;
    reporter.plan(&plan, pair_name, pair.mode);

    let run_warnings =
        crate::preconditions::check_run(&pair, &plan, allow_empty_source, ignore_space_check)?;
    reporter.precondition_warnings(&run_warnings);

    if !plan.errors.is_empty() {
        reporter.blocked(plan.errors.len());
        return Ok(EXIT_BLOCKED_PLAN);
    }

    if !yes && !reporter.confirm()? {
        reporter.cancelled();
        return Ok(EXIT_OK);
    }

    let mut journal = Journal::create(pair_name, &pair.destination).map_err(io_error)?;
    let degradations = crate::volume::expected_degradations(&pair.destination);
    journal
        .run_start(pair_name, &plan, &run_warnings, &degradations)
        .map_err(io_error)?;
    reporter.run_start(
        journal.run_id(),
        pair_name,
        pair.mode,
        &pair.destination,
        &run_warnings,
        plan.copies.len() + plan.updates.len() + plan.deletes.len(),
    )?;
    let mut stats = RunStats {
        counts: Counts {
            planned: plan.copies.len() + plan.updates.len() + plan.deletes.len(),
            ..Counts::default()
        },
        ..RunStats::default()
    };
    for stray in &plan.strays {
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
        reporter.action_start(journal.run_id(), Operation::Cleanup, &action)?;
        match fs::remove_file(pair.destination.join(stray)) {
            Ok(()) => {
                journal
                    .action_done(Operation::Cleanup, &action, None, &[], None)
                    .map_err(journal_runtime_error)?;
                reporter.action_done(
                    journal.run_id(),
                    Operation::Cleanup,
                    &action,
                    None,
                    &[],
                    false,
                )?;
                reporter.cleaned(stray);
            }
            Err(error) => {
                stats.counts.failed += 1;
                journal
                    .action_failed(Operation::Cleanup, &action, &error.to_string())
                    .map_err(journal_runtime_error)?;
                reporter.action_failed(journal.run_id(), Operation::Cleanup, &action, &error)?;
                journal.summary(&stats).map_err(journal_runtime_error)?;
                reporter.summary(journal.run_id(), &stats)?;
                return Ok(1);
            }
        }
    }
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
        reporter.action_start(journal.run_id(), operation, action)?;
        let mut last_progress: Option<Instant> = None;
        let mut progress = |copied: u64| -> io::Result<()> {
            let interval_elapsed = match last_progress {
                Some(last) => last.elapsed() >= PROGRESS_INTERVAL,
                None => true,
            };
            if copied == action.bytes || interval_elapsed {
                reporter
                    .progress(journal.run_id(), operation, action, copied)
                    .map_err(io::Error::other)?;
                last_progress = Some(Instant::now());
            }
            Ok(())
        };
        match copy_file(
            &pair.destination,
            &source,
            &destination,
            &temp,
            action,
            CopyOptions {
                run_id: journal.run_id(),
                permanent_delete,
                full_verify,
                report_progress: reporter.is_json(),
            },
            &mut progress,
        ) {
            Ok(outcome) => {
                journal
                    .action_done(
                        operation,
                        action,
                        outcome.safety_net.as_deref(),
                        &outcome.warnings,
                        Some(if full_verify { "full" } else { "standard" }),
                    )
                    .map_err(journal_runtime_error)?;
                stats.counts.done += 1;
                stats.bytes += action.bytes;
                stats.warnings += outcome.warnings.len();
                reporter.action_done(
                    journal.run_id(),
                    operation,
                    action,
                    outcome.safety_net.as_deref(),
                    &outcome.warnings,
                    full_verify,
                )?;
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
                reporter.action_failed(journal.run_id(), operation, action, &error)?;
                if error.kind() != io::ErrorKind::InvalidData {
                    journal.summary(&stats).map_err(journal_runtime_error)?;
                    reporter.summary(journal.run_id(), &stats)?;
                    return Ok(1);
                }
            }
        }
    }
    for action in &plan.deletes {
        let destination = pair.destination.join(&action.rel_path);
        journal
            .action_start(Operation::Delete, action, None, None)
            .map_err(journal_runtime_error)?;
        reporter.action_start(journal.run_id(), Operation::Delete, action)?;
        match remove_file(
            &pair.destination,
            &destination,
            &action.rel_path,
            journal.run_id(),
            permanent_delete,
        ) {
            Ok(safety_net) => {
                journal
                    .action_done(Operation::Delete, action, safety_net.as_deref(), &[], None)
                    .map_err(journal_runtime_error)?;
                stats.counts.done += 1;
                stats.counts.deleted += 1;
                stats.bytes += action.bytes;
                reporter.action_done(
                    journal.run_id(),
                    Operation::Delete,
                    action,
                    safety_net.as_deref(),
                    &[],
                    false,
                )?;
            }
            Err(error) => {
                stats.counts.failed += 1;
                journal
                    .action_failed(Operation::Delete, action, &error.to_string())
                    .map_err(journal_runtime_error)?;
                reporter.action_failed(journal.run_id(), Operation::Delete, action, &error)?;
            }
        }
    }

    journal.summary(&stats).map_err(journal_runtime_error)?;
    reporter.summary(journal.run_id(), &stats)?;
    if stats.counts.failed == 0 {
        Ok(EXIT_OK)
    } else {
        Ok(1)
    }
}

fn copy_file(
    destination_root: &Path,
    source: &Path,
    destination: &Path,
    temp: &Path,
    action: &Action,
    options: CopyOptions<'_>,
    progress: &mut impl FnMut(u64) -> io::Result<()>,
) -> io::Result<ActionOutcome> {
    let CopyOptions {
        run_id,
        permanent_delete,
        full_verify,
        report_progress,
    } = options;
    let source_before = fs::metadata(source)?;
    let parent = destination
        .parent()
        .expect("relative COPY path always has a parent");
    fs::create_dir_all(parent)?;
    let result = (|| {
        if report_progress
            && action.bytes >= PROGRESS_THRESHOLD
            && fs::symlink_metadata(source)?.is_file()
        {
            copyfile_all_but_acls_with_progress(source, temp, action.bytes, progress)?;
        } else {
            copyfile_all_but_acls(source, temp)?;
        }
        crash_at("copy_complete");
        #[cfg(feature = "fault-injection")]
        if std::env::var_os("VIBESYNC_TEST_ENOSPC_PATH")
            .is_some_and(|path| Path::new(&path) == action.rel_path)
        {
            return Err(io::Error::from_raw_os_error(libc::ENOSPC));
        }
        fully_sync(temp)?;
        // Narrow issue-22 process-seam injection. ADR-0009's generic
        // EXEC_AT transition harness is owned by the later harness slice.
        #[cfg(feature = "fault-injection")]
        if std::env::var_os("VIBESYNC_TEST_WARNING_PATH")
            .is_some_and(|path| Path::new(&path) == action.rel_path)
        {
            let epoch = [libc::timeval {
                tv_sec: 0,
                tv_usec: 0,
            }; 2];
            let path = c_path(temp)?;
            if unsafe { libc::utimes(path.as_ptr(), epoch.as_ptr()) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let warnings = verify(source, &source_before, temp, action.bytes, full_verify)?;
        let safety_net = remove_file(
            destination_root,
            destination,
            &action.rel_path,
            run_id,
            permanent_delete,
        )?;
        fs::rename(temp, destination)?;
        sync_directory(parent)?;
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

struct CopyOptions<'a> {
    run_id: &'a str,
    permanent_delete: bool,
    full_verify: bool,
    report_progress: bool,
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
    copyfile_with_flags(source, destination, COPYFILE_ALL_WITHOUT_ACLS)
}

fn copyfile_with_flags(source: &Path, destination: &Path, flags: u32) -> io::Result<()> {
    let source = c_path(source)?;
    let destination = c_path(destination)?;
    let result = unsafe {
        copyfile(
            source.as_ptr(),
            destination.as_ptr(),
            std::ptr::null_mut(),
            flags,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn copyfile_all_but_acls_with_progress<F>(
    source: &Path,
    destination: &Path,
    total: u64,
    progress: &mut F,
) -> io::Result<()>
where
    F: FnMut(u64) -> io::Result<()>,
{
    let source = c_path(source)?;
    let destination = c_path(destination)?;
    let state = unsafe { copyfile_state_alloc() };
    if state.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut context = CopyProgressContext {
        progress,
        error: None,
        copied: 0,
    };
    let block_size: u32 = 256 * 1024;
    let block_size_result = unsafe {
        copyfile_state_set(
            state,
            COPYFILE_STATE_BSIZE,
            (&block_size as *const u32).cast(),
        )
    };
    let callback_result = unsafe {
        copyfile_state_set(
            state,
            COPYFILE_STATE_STATUS_CB,
            copyfile_progress_callback::<F> as CopyfileCallback as *const libc::c_void,
        )
    };
    let context_result = unsafe {
        copyfile_state_set(
            state,
            COPYFILE_STATE_STATUS_CTX,
            (&mut context as *mut CopyProgressContext<'_, F>).cast(),
        )
    };
    if block_size_result != 0 || callback_result != 0 || context_result != 0 {
        let error = io::Error::last_os_error();
        unsafe { copyfile_state_free(state) };
        return Err(error);
    }
    let result = unsafe {
        copyfile(
            source.as_ptr(),
            destination.as_ptr(),
            state,
            COPYFILE_ALL_WITHOUT_ACLS,
        )
    };
    let copy_error = (result != 0).then(io::Error::last_os_error);
    unsafe { copyfile_state_free(state) };
    if let Some(error) = context.error {
        return Err(error);
    }
    if let Some(error) = copy_error {
        return Err(error);
    }
    if context.copied < total {
        (context.progress)(total)?;
    }
    Ok(())
}

struct CopyProgressContext<'a, F> {
    progress: &'a mut F,
    error: Option<io::Error>,
    copied: u64,
}

unsafe extern "C" fn copyfile_progress_callback<F>(
    what: libc::c_int,
    stage: libc::c_int,
    state: CopyfileState,
    _source: *const libc::c_char,
    _destination: *const libc::c_char,
    raw_context: *mut libc::c_void,
) -> libc::c_int
where
    F: FnMut(u64) -> io::Result<()>,
{
    if what != COPYFILE_COPY_DATA {
        return COPYFILE_CONTINUE;
    }
    let context = &mut *raw_context.cast::<CopyProgressContext<'_, F>>();
    if stage == COPYFILE_ERR {
        context.error = Some(io::Error::last_os_error());
        return COPYFILE_QUIT;
    }
    if stage != COPYFILE_PROGRESS {
        return COPYFILE_CONTINUE;
    }
    let mut copied: libc::off_t = 0;
    if copyfile_state_get(
        state,
        COPYFILE_STATE_COPIED,
        (&mut copied as *mut libc::off_t).cast(),
    ) != 0
    {
        context.error = Some(io::Error::last_os_error());
        return COPYFILE_QUIT;
    }
    context.copied = copied.max(0) as u64;
    if let Err(error) = (context.progress)(context.copied) {
        context.error = Some(error);
        return COPYFILE_QUIT;
    }
    // Makes elapsed-time throttling deterministic at the process seam while
    // still exercising copyfile(3)'s real per-write callback.
    #[cfg(feature = "fault-injection")]
    if let Ok(delay) = std::env::var("VIBESYNC_TEST_COPY_CHUNK_DELAY_MS") {
        std::thread::sleep(Duration::from_millis(delay.parse().unwrap_or(0)));
    }
    COPYFILE_CONTINUE
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
    full_verify: bool,
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
    if full_verify && !files_equal(source, temp)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "verify mismatch: content differs",
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

fn files_equal(left: &Path, right: &Path) -> io::Result<bool> {
    let mut left = File::open(left)?;
    let mut right = File::open(right)?;
    let mut a = [0_u8; 64 * 1024];
    let mut b = [0_u8; 64 * 1024];
    loop {
        let an = left.read(&mut a)?;
        let bn = right.read(&mut b)?;
        if an != bn || a[..an] != b[..bn] {
            return Ok(false);
        }
        if an == 0 {
            return Ok(true);
        }
    }
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
            CopyOptions {
                run_id: "20260716T120000Z",
                permanent_delete: false,
                full_verify: false,
                report_progress: false,
            },
            &mut |_| Ok(()),
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
            old_bytes: Some(11),
            reason: "size differs".to_string(),
        };
        let temp = temporary_path(&destination, "20260716T120000Z");

        let result = copy_file(
            destination_dir.path(),
            &source,
            &destination,
            &temp,
            &action,
            CopyOptions {
                run_id: "20260716T120000Z",
                permanent_delete: false,
                full_verify: false,
                report_progress: false,
            },
            &mut |_| Ok(()),
        );

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "old version");
        assert!(
            !destination_dir.path().join("_SafetyNet").exists(),
            "archive is strictly after the verification gate"
        );
    }

    #[test]
    fn copyfile_data_error_quits_and_preserves_errno() {
        let mut progress: fn(u64) -> io::Result<()> = |_| Ok(());
        let mut context = CopyProgressContext {
            progress: &mut progress,
            error: None,
            copied: 0,
        };
        unsafe { *libc::__error() = libc::ENOSPC };

        let response = unsafe {
            copyfile_progress_callback::<fn(u64) -> io::Result<()>>(
                COPYFILE_COPY_DATA,
                COPYFILE_ERR,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                (&mut context as *mut CopyProgressContext<'_, _>).cast(),
            )
        };

        assert_eq!(response, COPYFILE_QUIT);
        assert_eq!(context.error.unwrap().raw_os_error(), Some(libc::ENOSPC));
    }
}
