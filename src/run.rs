//! Destination mutation: a sibling dot-temp passes durability and verification
//! before SafetyNet archives any old destination object and Publish renames the
//! verified temp into place (ADR-0001 and ADR-0008).

use std::collections::HashSet;
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::error::{AppError, EXIT_BLOCKED_PLAN, EXIT_OK};
use crate::event::{MetadataWarning, VerificationTier};
use crate::failure::{ActionFailure, FailureReason};
use crate::journal::{Counts, Journal, Operation, PairLock, RunStats};
use crate::plan::{self, Action};

const COPYFILE_ALL_WITHOUT_ACLS: u32 = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 18) | (1 << 19);
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
const XATTR_NOFOLLOW: libc::c_int = 0x0001;
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

    fn expected_degradations(&self, degradations: &[&str]) {
        if matches!(self, Self::Human) && !degradations.is_empty() {
            eprintln!(
                "vibesync: expected destination degradations: {}",
                degradations.join(", ")
            );
        }
    }

    fn blocked(&self, errors: usize) {
        if matches!(self, Self::Human) {
            eprintln!("vibesync: run blocked by {errors} plan error(s)");
        }
    }

    fn cancelled(&self) {
        match self {
            Self::Human => println!("Run cancelled; destination unchanged."),
            Self::Json => eprintln!("Run cancelled; destination unchanged."),
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
        pair_name: &str,
        pair: &crate::config::Pair,
        warnings: &[String],
        plan: &plan::Plan,
    ) -> Result<(), AppError> {
        let mut event = crate::event::run_start(
            crate::event::Context {
                schema: RUN_SCHEMA,
                run_id,
            },
            pair_name,
            &pair.source,
            &pair.destination,
            warnings,
            &crate::volume::expected_degradations(&pair.destination),
        );
        event["mode"] = serde_json::json!(pair.mode);
        let planned_actions = crate::event::planned_actions(plan);
        event["planned"] = planned_actions.len().into();
        event["planned_actions"] = planned_actions.into();
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
        self.json(serde_json::json!({"schema":"vibefilesync.run/v1","type":"progress","run_id":run_id,"op":operation,"path":action.rel_path.to_string_lossy(),"bytes":bytes.min(action.bytes),"total_bytes":action.bytes}))
    }

    fn action_done(
        &self,
        run_id: &str,
        operation: Operation,
        action: &Action,
        safety_net: Option<&Path>,
        warnings: &[MetadataWarning],
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
                matches!(operation, Operation::Copy | Operation::Update).then_some(
                    if full_verify {
                        VerificationTier::Full
                    } else {
                        VerificationTier::Standard
                    },
                ),
                true,
            )),
            Self::Human => {
                for warning in warnings {
                    eprintln!(
                        "vibesync: {} {} warning: {}",
                        operation.as_str().to_ascii_uppercase(),
                        action.rel_path.display(),
                        warning.detail()
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
        failure: &ActionFailure,
    ) -> Result<(), AppError> {
        match self {
            Self::Json => crate::ndjson::stdout(&crate::event::action_failed(
                crate::event::Context {
                    schema: RUN_SCHEMA,
                    run_id,
                },
                operation,
                action,
                failure.reason(),
            )),
            Self::Human => {
                eprintln!(
                    "vibesync: {} {} failed: {failure}",
                    operation.as_str().to_ascii_uppercase(),
                    action.rel_path.display()
                );
                if failure.reason() == FailureReason::DestinationFull {
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
    configured_pair(config_path, pair_name)?;
    let _pair_lock = PairLock::acquire(pair_name).map_err(lock_error)?;
    let (pair, initial_plan) = plan::build(config_path, pair_name, options.excludes)?;
    execute_reviewed_plan(config_path, pair_name, options, pair, initial_plan, true)
}

/// Executes the exact plan confirmed by another human surface. The ordinary
/// reconciliation scan still owns filesystem truth, but can only retain work
/// present in `initial_plan`; newly discovered work waits for the next run.
pub(crate) fn run_reviewed(
    config_path: &Path,
    pair_name: &str,
    options: RunOptions<'_>,
    reviewed_pair: crate::config::Pair,
    initial_plan: plan::Plan,
) -> Result<i32, AppError> {
    let configured = configured_pair(config_path, pair_name)?;
    let _pair_lock = PairLock::acquire(pair_name).map_err(lock_error)?;
    let (pair, notices) = crate::preconditions::resolve_pair(&configured)?;
    for notice in notices {
        eprintln!("{notice}");
    }
    if let Some(error) = stale_pair_error(&pair, &reviewed_pair) {
        return Err(error);
    }
    execute_reviewed_plan(config_path, pair_name, options, pair, initial_plan, false)
}

/// A plan is read-only, per ADR-0010's lifecycle: once Review has captured a
/// Folder pair's definition, no later redefinition of that pair (through the
/// TUI's own CRUD, another process, or a hand edit) may let the stale plan
/// reach a run. Pure comparison so it can be exercised without touching the
/// pair lock or the journal.
fn stale_pair_error(
    pair: &crate::config::Pair,
    reviewed_pair: &crate::config::Pair,
) -> Option<AppError> {
    if pair == reviewed_pair {
        None
    } else {
        Some(AppError::Precondition(
            "Folder pair changed during TUI review; reopen the TUI before running".to_string(),
        ))
    }
}

fn configured_pair(config_path: &Path, pair_name: &str) -> Result<crate::config::Pair, AppError> {
    let config = crate::config::load(config_path)?;
    config
        .pairs
        .get(pair_name)
        .cloned()
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))
}

fn execute_reviewed_plan(
    config_path: &Path,
    pair_name: &str,
    options: RunOptions<'_>,
    pair: crate::config::Pair,
    mut initial_plan: plan::Plan,
    render_plan: bool,
) -> Result<i32, AppError> {
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
    plan::drop_orphan_structural_deletions(&mut initial_plan);
    plan::report_unknown_excludes(&initial_plan);
    if render_plan {
        reporter.plan(&initial_plan, pair_name, pair.mode);
    }

    if !initial_plan.errors.is_empty() {
        reporter.blocked(initial_plan.errors.len());
        return Ok(EXIT_BLOCKED_PLAN);
    }
    let run_warnings = crate::preconditions::check_run(
        &pair,
        &initial_plan,
        allow_empty_source,
        ignore_space_check,
    )?;
    reporter.precondition_warnings(&run_warnings);
    let degradations = crate::volume::expected_degradations(&pair.destination);
    reporter.expected_degradations(&degradations);

    if !yes && !reporter.confirm()? {
        reporter.cancelled();
        return Ok(EXIT_OK);
    }

    let blocked_signals = crate::interrupt::block().map_err(|error| {
        AppError::Interrupted(format!("could not block interruption signals: {error}"))
    })?;
    let mut journal = Journal::create(pair_name, &pair.destination).map_err(io_error)?;
    journal
        .run_start(
            pair_name,
            &pair.source,
            &pair.destination,
            &initial_plan,
            &run_warnings,
            &degradations,
        )
        .map_err(io_error)?;
    reporter.run_start(
        journal.run_id(),
        pair_name,
        &pair,
        &run_warnings,
        &initial_plan,
    )?;
    install_interrupt_handler()?;
    blocked_signals.restore().map_err(|error| {
        AppError::Interrupted(format!("could not restore interruption signals: {error}"))
    })?;
    crate::interrupt::check().map_err(|error| AppError::Interrupted(error.to_string()))?;
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
    if let CleanupOutcome::Abort = cleanup_stray_temps(
        &pair.source,
        &pair.destination,
        &initial_plan.strays,
        &mut journal,
        &reporter,
        &mut stats,
    )? {
        journal.summary(&stats).map_err(journal_runtime_error)?;
        reporter.summary(journal.run_id(), &stats)?;
        return Ok(1);
    }
    let (pair, plan) = reconcile_plan(
        config_path,
        pair_name,
        excludes,
        &initial_plan,
        &mut journal,
        &reporter,
        &mut stats,
    )?;
    let mut completed_structural_deletes = std::collections::BTreeSet::new();
    let mut started_structural_deletes = std::collections::BTreeSet::new();
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
        crate::interrupt::check().map_err(|error| AppError::Interrupted(error.to_string()))?;
        let source = pair.source.join(&action.rel_path);
        let destination = pair.destination.join(&action.rel_path);
        let structural_delete = plan.deletes.iter().find(|deletion| {
            deletion.structural_conflict.is_some()
                && !completed_structural_deletes.contains(&deletion.rel_path)
                && deletion.structural_conflict.is_some_and(|conflict| {
                    conflict.has_dependent_copy(&deletion.rel_path, &action.rel_path)
                })
        });
        let temp_target = structural_delete
            .filter(|_| !destination.parent().is_some_and(Path::is_dir))
            .map(|deletion| pair.destination.join(&deletion.rel_path));
        let temp = temporary_path(
            temp_target.as_deref().unwrap_or(&destination),
            journal.run_id(),
        );
        if let Some(deletion) = structural_delete {
            if started_structural_deletes.insert(deletion.rel_path.clone()) {
                journal
                    .action_start(Operation::Delete, deletion, None, None)
                    .map_err(journal_runtime_error)?;
                reporter.action_start(journal.run_id(), Operation::Delete, deletion)?;
            }
        }
        journal
            .action_start(operation, action, Some(&source), Some(&temp))
            .map_err(journal_runtime_error)?;
        reporter.action_start(journal.run_id(), operation, action)?;
        let mut last_progress: Option<Instant> = None;
        let mut progress = |copied: u64| -> io::Result<()> {
            crate::interrupt::check()?;
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
        let options = CopyOptions {
            run_id: journal.run_id(),
            permanent_delete,
            full_verify,
            report_progress: reporter.is_json(),
            structural_delete,
        };
        let result = if plan.directory_copies.contains(&action.rel_path) {
            create_directory(&pair.destination, &source, &destination, action, options)
        } else {
            copy_file(
                &pair.destination,
                &source,
                &destination,
                &temp,
                action,
                options,
                &mut progress,
            )
        };
        match result {
            Ok(outcome) => {
                if let Some(deletion) = structural_delete {
                    journal
                        .action_done(
                            Operation::Delete,
                            deletion,
                            outcome.structural_safety_net.as_deref(),
                            &[],
                            None,
                        )
                        .map_err(journal_runtime_error)?;
                    stats.counts.done += 1;
                    stats.counts.deleted += 1;
                    stats.bytes += deletion.bytes;
                    reporter.action_done(
                        journal.run_id(),
                        Operation::Delete,
                        deletion,
                        outcome.structural_safety_net.as_deref(),
                        &[],
                        false,
                    )?;
                    completed_structural_deletes.insert(deletion.rel_path.clone());
                }
                journal
                    .action_done(
                        operation,
                        action,
                        outcome.safety_net.as_deref(),
                        &outcome.warnings,
                        Some(if full_verify {
                            VerificationTier::Full
                        } else {
                            VerificationTier::Standard
                        }),
                    )
                    .map_err(journal_runtime_error)?;
                #[cfg(all(feature = "fault-injection", debug_assertions))]
                journal.flush().map_err(journal_runtime_error)?;
                fault_at(
                    FaultTransition::ActionDoneWritten,
                    FaultContext {
                        relative_path: &action.rel_path,
                        source: Some(&source),
                        temp: Some(&temp),
                        destination: Some(&destination),
                        safety_net: outcome.safety_net.as_deref(),
                    },
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
            Err(failure) => {
                if failure.kind() == io::ErrorKind::Interrupted {
                    return Err(AppError::Interrupted(failure.to_string()));
                }
                stats.counts.failed += 1;
                journal
                    .action_failed(operation, action, failure.reason())
                    .map_err(journal_runtime_error)?;
                reporter.action_failed(journal.run_id(), operation, action, &failure)?;
                if failure.kind() != io::ErrorKind::InvalidData {
                    if let Some(deletion) = structural_delete {
                        fail_structural_delete(deletion, &mut journal, &reporter, &mut stats)?;
                    }
                    journal.summary(&stats).map_err(journal_runtime_error)?;
                    reporter.summary(journal.run_id(), &stats)?;
                    return Ok(1);
                }
            }
        }
    }
    for deletion in plan.deletes.iter().filter(|deletion| {
        started_structural_deletes.contains(&deletion.rel_path)
            && !completed_structural_deletes.contains(&deletion.rel_path)
    }) {
        fail_structural_delete(deletion, &mut journal, &reporter, &mut stats)?;
    }
    for action in plan
        .deletes
        .iter()
        .filter(|deletion| !delete_precedes_copy(deletion, &plan.copies))
    {
        crate::interrupt::check().map_err(|error| AppError::Interrupted(error.to_string()))?;
        execute_delete_action(
            &pair,
            action,
            &mut journal,
            permanent_delete,
            plan.directory_deletes.contains(&action.rel_path),
            &reporter,
            &mut stats,
        )?;
    }

    crate::interrupt::check().map_err(|error| AppError::Interrupted(error.to_string()))?;
    journal.summary(&stats).map_err(journal_runtime_error)?;
    reporter.summary(journal.run_id(), &stats)?;
    if stats.counts.failed == 0 {
        Ok(EXIT_OK)
    } else {
        Ok(1)
    }
}

/// Whether the run may proceed to reconciliation after cleanup, or must
/// abort because a stray temp could not be removed.
enum CleanupOutcome {
    Continue,
    Abort,
}

/// Removes abandoned publish temps left by an interrupted prior run before
/// the reconciliation scan runs, since a stray temp would otherwise shadow
/// the fresh scan's view of the destination.
fn cleanup_stray_temps(
    source: &Path,
    destination: &Path,
    strays: &[PathBuf],
    journal: &mut Journal,
    reporter: &RunReporter,
    stats: &mut RunStats,
) -> Result<CleanupOutcome, AppError> {
    for stray in strays {
        crate::interrupt::check().map_err(|error| AppError::Interrupted(error.to_string()))?;
        let action = Action {
            rel_path: stray.clone(),
            bytes: fs::metadata(destination.join(stray))
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            source_mtime: None,
            old_bytes: None,
            reason: "abandoned temp".to_string(),
            structural_conflict: None,
        };
        journal
            .action_start(Operation::Cleanup, &action, None, None)
            .map_err(journal_runtime_error)?;
        reporter.action_start(journal.run_id(), Operation::Cleanup, &action)?;
        match fs::remove_file(destination.join(stray)) {
            Ok(()) => {
                journal
                    .action_done(Operation::Cleanup, &action, None, &[], None)
                    .map_err(journal_runtime_error)?;
                stats.counts.done += 1;
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
                let failure = ActionFailure::from(error);
                stats.counts.failed += 1;
                journal
                    .action_failed(Operation::Cleanup, &action, failure.reason())
                    .map_err(journal_runtime_error)?;
                reporter.action_failed(journal.run_id(), Operation::Cleanup, &action, &failure)?;
                return Ok(CleanupOutcome::Abort);
            }
        }
    }
    fault_at(
        FaultTransition::CleanupComplete,
        FaultContext {
            relative_path: Path::new(""),
            source: Some(source),
            temp: None,
            destination: Some(destination),
            safety_net: None,
        },
    )
    .map_err(journal_runtime_error)?;
    Ok(CleanupOutcome::Continue)
}

/// Rebuilds the plan from a fresh scan (cleanup changed the destination, so
/// the reviewed plan's scan is stale), then narrows the fresh scan back down
/// to what was reviewed: ADR-0007's "reviewed plan never broadens" rule.
/// Reports what the fresh scan no longer agrees with (`missing_reviewed_actions`)
/// and what it newly found (`discovered_after_review`) so both are visible to
/// the user and to agents reading the run summary event, instead of silent.
fn reconcile_plan(
    config_path: &Path,
    pair_name: &str,
    excludes: &[String],
    initial_plan: &plan::Plan,
    journal: &mut Journal,
    reporter: &RunReporter,
    stats: &mut RunStats,
) -> Result<(crate::config::Pair, plan::Plan), AppError> {
    let (pair, mut plan) = plan::build(config_path, pair_name, excludes)?;
    stats.discovered_after_review = discovered_after_review(initial_plan, &plan);
    let missing = missing_reviewed_actions(initial_plan, &plan);
    for (operation, action) in &missing {
        journal
            .action_start(*operation, action, None, None)
            .map_err(journal_runtime_error)?;
        reporter.action_start(journal.run_id(), *operation, action)?;
        let failure = ActionFailure::new(
            FailureReason::ReconciliationChanged,
            io::Error::other("changed during reconciliation; rerun required"),
        );
        journal
            .action_failed(*operation, action, failure.reason())
            .map_err(journal_runtime_error)?;
        reporter.action_failed(journal.run_id(), *operation, action, &failure)?;
        stats.counts.failed += 1;
    }
    for error in &plan.errors {
        if !reviewed_path(initial_plan, &error.rel_path) {
            stats.counts.failed += 1;
        }
        eprintln!(
            "vibesync: {} appeared after review; rerun required",
            error.rel_path.display()
        );
    }
    retain_reviewed_actions(&mut plan, initial_plan);
    plan::drop_orphan_structural_deletions(&mut plan);
    Ok((pair, plan))
}

fn install_interrupt_handler() -> Result<(), AppError> {
    crate::interrupt::install().map_err(|error| {
        AppError::Interrupted(format!("could not install signal handler: {error}"))
    })
}

fn fail_structural_delete(
    deletion: &Action,
    journal: &mut Journal,
    reporter: &RunReporter,
    stats: &mut RunStats,
) -> Result<(), AppError> {
    stats.counts.failed += 1;
    let failure = ActionFailure::new(
        FailureReason::DependencyFailed,
        io::Error::new(
            io::ErrorKind::InvalidData,
            "dependent copies did not pass the publish gate",
        ),
    );
    journal
        .action_failed(Operation::Delete, deletion, FailureReason::DependencyFailed)
        .map_err(journal_runtime_error)?;
    reporter.action_failed(journal.run_id(), Operation::Delete, deletion, &failure)
}

/// Indexes actions by whole value for the reconciliation comparisons below,
/// which each ask the same question — "did the review cover this exact
/// action?" — once per action. `Action`'s `Hash` is field-wise and agrees
/// with its `PartialEq` (`plan.rs`), so membership here answers exactly what
/// a `Vec::contains` scan answered, without the per-action linear scan.
fn action_index(actions: &[Action]) -> HashSet<&Action> {
    actions.iter().collect()
}

/// A reconciliation scan is authoritative about the destination, but it must
/// not broaden a reviewed run when source or destination content changes
/// between the review and the cleanup. Newly discovered work waits for the
/// next `plan`/`run` invocation.
fn retain_reviewed_actions(fresh: &mut plan::Plan, reviewed: &plan::Plan) {
    let reviewed_copies = action_index(&reviewed.copies);
    let reviewed_updates = action_index(&reviewed.updates);
    let reviewed_deletes = action_index(&reviewed.deletes);
    fresh
        .copies
        .retain(|action| reviewed_copies.contains(action));
    fresh
        .updates
        .retain(|action| reviewed_updates.contains(action));
    fresh
        .deletes
        .retain(|action| reviewed_deletes.contains(action));
    fresh
        .directory_copies
        .retain(|path| reviewed.directory_copies.contains(path));
    fresh
        .directory_deletes
        .retain(|path| reviewed.directory_deletes.contains(path));
}

fn delete_precedes_copy(deletion: &Action, copies: &[Action]) -> bool {
    copies.iter().any(|copy| {
        copy.rel_path.starts_with(&deletion.rel_path)
            || deletion.rel_path.starts_with(&copy.rel_path)
    })
}

fn execute_delete_action(
    pair: &crate::config::Pair,
    action: &Action,
    journal: &mut Journal,
    permanent_delete: bool,
    allow_empty_directory: bool,
    reporter: &RunReporter,
    stats: &mut RunStats,
) -> Result<(), AppError> {
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
        allow_empty_directory,
    ) {
        Ok(safety_net) => {
            if let Some(archive) = safety_net.as_deref() {
                fault_at(
                    FaultTransition::Archived,
                    FaultContext {
                        relative_path: &action.rel_path,
                        source: None,
                        temp: None,
                        destination: Some(&destination),
                        safety_net: Some(archive),
                    },
                )
                .map_err(journal_runtime_error)?;
            }
            journal
                .action_done(Operation::Delete, action, safety_net.as_deref(), &[], None)
                .map_err(journal_runtime_error)?;
            #[cfg(all(feature = "fault-injection", debug_assertions))]
            journal.flush().map_err(journal_runtime_error)?;
            fault_at(
                FaultTransition::ActionDoneWritten,
                FaultContext {
                    relative_path: &action.rel_path,
                    source: None,
                    temp: None,
                    destination: Some(&destination),
                    safety_net: safety_net.as_deref(),
                },
            )
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
            let failure = ActionFailure::from(error);
            stats.counts.failed += 1;
            journal
                .action_failed(Operation::Delete, action, failure.reason())
                .map_err(journal_runtime_error)?;
            reporter.action_failed(journal.run_id(), Operation::Delete, action, &failure)?;
        }
    }
    Ok(())
}

fn missing_reviewed_actions<'a>(
    reviewed: &'a plan::Plan,
    fresh: &plan::Plan,
) -> Vec<(Operation, &'a Action)> {
    let fresh_copies = action_index(&fresh.copies);
    let fresh_updates = action_index(&fresh.updates);
    let fresh_deletes = action_index(&fresh.deletes);
    reviewed
        .copies
        .iter()
        .filter(|action| !fresh_copies.contains(*action))
        .map(|action| (Operation::Copy, action))
        .chain(
            reviewed
                .updates
                .iter()
                .filter(|action| !fresh_updates.contains(*action))
                .map(|action| (Operation::Update, action)),
        )
        .chain(
            reviewed
                .deletes
                .iter()
                .filter(|action| !fresh_deletes.contains(*action))
                .map(|action| (Operation::Delete, action)),
        )
        .collect()
}

/// Counts fresh-scan actions absent from the reviewed plan: work that
/// appeared in the source after the human (or another surface) reviewed the
/// plan, e.g. a file copied into the source mid-review. Only ordinary sync
/// actions count; stray-temp cleanup runs before this reconciliation scan
/// and is not part of what a reviewer saw.
fn discovered_after_review(reviewed: &plan::Plan, fresh: &plan::Plan) -> usize {
    let appeared = |fresh_actions: &[Action], reviewed_actions: &[Action]| {
        let reviewed_actions = action_index(reviewed_actions);
        fresh_actions
            .iter()
            .filter(|action| !reviewed_actions.contains(*action))
            .count()
    };
    appeared(&fresh.copies, &reviewed.copies)
        + appeared(&fresh.updates, &reviewed.updates)
        + appeared(&fresh.deletes, &reviewed.deletes)
}

fn copy_file(
    destination_root: &Path,
    source: &Path,
    destination: &Path,
    temp: &Path,
    action: &Action,
    options: CopyOptions<'_>,
    progress: &mut impl FnMut(u64) -> io::Result<()>,
) -> Result<ActionOutcome, ActionFailure> {
    let CopyOptions {
        run_id,
        permanent_delete,
        full_verify,
        report_progress,
        structural_delete,
    } = options;
    let planned_source_mtime = match action.source_mtime {
        Some(mtime) => mtime,
        None => fs::symlink_metadata(source)?.modified()?,
    };
    let parent = destination
        .parent()
        .expect("relative COPY path always has a parent");
    fs::create_dir_all(temp.parent().expect("temp has a parent"))?;
    let result: Result<ActionOutcome, ActionFailure> = (|| {
        #[cfg(all(feature = "fault-injection", debug_assertions))]
        File::create(temp)?;
        let context = || FaultContext {
            relative_path: &action.rel_path,
            source: Some(source),
            temp: Some(temp),
            destination: Some(destination),
            safety_net: None,
        };
        fault_at(FaultTransition::TempCreated, context())?;
        if fs::symlink_metadata(source)?.file_type().is_symlink() {
            #[cfg(all(feature = "fault-injection", debug_assertions))]
            fs::remove_file(temp)?;
            copyfile_all_but_acls(source, temp)?;
        } else if report_progress
            && action.bytes >= PROGRESS_THRESHOLD
            && fs::symlink_metadata(source)?.is_file()
        {
            copyfile_all_but_acls_with_progress(source, temp, action.bytes, progress)?;
        } else {
            copyfile_all_but_acls(source, temp)?;
        }
        crate::interrupt::check()?;
        fault_at(FaultTransition::CopyComplete, context())?;
        #[cfg(all(feature = "fault-injection", debug_assertions))]
        if std::env::var_os("VIBESYNC_TEST_ENOSPC_PATH")
            .is_some_and(|path| Path::new(&path) == action.rel_path)
        {
            return Err(ActionFailure::from(io::Error::from_raw_os_error(
                libc::ENOSPC,
            )));
        }
        if fs::symlink_metadata(temp)?.file_type().is_symlink() {
            sync_directory(temp.parent().expect("temp has a parent"))?;
        } else {
            fully_sync(temp)?;
        }
        // Narrow issue-22 process-seam injection. ADR-0009's generic
        // EXEC_AT transition harness is owned by the later harness slice.
        #[cfg(all(feature = "fault-injection", debug_assertions))]
        if std::env::var_os("VIBESYNC_TEST_WARNING_PATH")
            .is_some_and(|path| Path::new(&path) == action.rel_path)
        {
            let epoch = [libc::timeval {
                tv_sec: 0,
                tv_usec: 0,
            }; 2];
            let path = c_path(temp)?;
            if unsafe { libc::utimes(path.as_ptr(), epoch.as_ptr()) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
        }
        let verification = verify_temp(source, temp, action.bytes, full_verify)?;
        if verification.has_data_mismatch() {
            revalidate_source(source, planned_source_mtime, action.bytes)?;
            return Err(verification.data_mismatch_error());
        }
        fault_at(FaultTransition::VerifyComplete, context())?;
        crate::interrupt::check()?;
        revalidate_source(source, planned_source_mtime, action.bytes)?;
        fault_at(FaultTransition::SourceRevalidated, context())?;
        let warnings = verification.warnings;
        let (safety_net, structural_safety_net) = if let Some(deletion) = structural_delete {
            let blocker = destination_root.join(&deletion.rel_path);
            (
                None,
                remove_file(
                    destination_root,
                    &blocker,
                    &deletion.rel_path,
                    run_id,
                    permanent_delete,
                    deletion.structural_conflict
                        == Some(plan::StructuralConflict::DestinationDirectory),
                )?,
            )
        } else {
            (
                remove_file(
                    destination_root,
                    destination,
                    &action.rel_path,
                    run_id,
                    permanent_delete,
                    false,
                )?,
                None,
            )
        };
        fs::create_dir_all(parent)?;
        if let Some(archive) = safety_net.as_deref().or(structural_safety_net.as_deref()) {
            fault_at(
                FaultTransition::Archived,
                FaultContext {
                    safety_net: Some(archive),
                    ..context()
                },
            )?;
        }
        fs::rename(temp, destination)?;
        sync_directory(parent)?;
        fault_at(FaultTransition::PublishComplete, context())?;
        Ok(ActionOutcome {
            safety_net,
            structural_safety_net,
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
    structural_delete: Option<&'a Action>,
}

#[derive(Clone, Copy)]
#[cfg_attr(
    not(all(feature = "fault-injection", debug_assertions)),
    allow(dead_code)
)]
struct FaultContext<'a> {
    relative_path: &'a Path,
    source: Option<&'a Path>,
    temp: Option<&'a Path>,
    destination: Option<&'a Path>,
    safety_net: Option<&'a Path>,
}

#[derive(Clone, Copy)]
enum FaultTransition {
    CleanupComplete,
    TempCreated,
    CopyComplete,
    VerifyComplete,
    SourceRevalidated,
    Archived,
    PublishComplete,
    ActionDoneWritten,
}

#[cfg(all(feature = "fault-injection", debug_assertions))]
impl FaultTransition {
    fn as_str(self) -> &'static str {
        match self {
            Self::CleanupComplete => "cleanup_complete",
            Self::TempCreated => "temp_created",
            Self::CopyComplete => "copy_complete",
            Self::VerifyComplete => "verify_complete",
            Self::SourceRevalidated => "source_revalidated",
            Self::Archived => "archived",
            Self::PublishComplete => "publish_complete",
            Self::ActionDoneWritten => "action_done_written",
        }
    }
}

#[cfg(all(feature = "fault-injection", debug_assertions))]
fn fault_at(transition: FaultTransition, context: FaultContext<'_>) -> io::Result<()> {
    let transition = transition.as_str();
    if std::env::var("VIBESYNC_TEST_CRASH_AT").ok().as_deref() == Some(transition) {
        std::process::abort();
    }
    if let Some(specification) = std::env::var_os("VIBESYNC_TEST_EXEC_AT") {
        let specification = specification.to_string_lossy();
        let Some((requested, command)) = specification.split_once(':') else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "VIBESYNC_TEST_EXEC_AT must be <transition>:<command>",
            ));
        };
        if requested == transition {
            let mut process = std::process::Command::new("/bin/sh");
            process
                .arg("-c")
                .arg(command)
                .env("VIBESYNC_TEST_TRANSITION", transition)
                .env("VIBESYNC_TEST_RELATIVE_PATH", context.relative_path);
            for (name, value) in [
                ("VIBESYNC_TEST_SOURCE", context.source),
                ("VIBESYNC_TEST_TEMP", context.temp),
                ("VIBESYNC_TEST_DESTINATION", context.destination),
                ("VIBESYNC_TEST_SAFETY_NET", context.safety_net),
            ] {
                if let Some(value) = value {
                    process.env(name, value);
                }
            }
            let status = process.status()?;
            if !status.success() {
                return Err(io::Error::other(format!(
                    "fault-injection command exited with {status}"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(not(all(feature = "fault-injection", debug_assertions)))]
fn fault_at(_: FaultTransition, _: FaultContext<'_>) -> io::Result<()> {
    Ok(())
}

struct ActionOutcome {
    safety_net: Option<PathBuf>,
    structural_safety_net: Option<PathBuf>,
    warnings: Vec<MetadataWarning>,
}

fn create_directory(
    destination_root: &Path,
    source: &Path,
    destination: &Path,
    _action: &Action,
    options: CopyOptions<'_>,
) -> Result<ActionOutcome, ActionFailure> {
    if !fs::symlink_metadata(source)?.file_type().is_dir() {
        return Err(ActionFailure::new(
            FailureReason::SourceChanged,
            io::Error::new(io::ErrorKind::InvalidData, "source directory changed"),
        ));
    }
    let structural_safety_net = if let Some(deletion) = options.structural_delete {
        remove_file(
            destination_root,
            &destination_root.join(&deletion.rel_path),
            &deletion.rel_path,
            options.run_id,
            options.permanent_delete,
            deletion.structural_conflict == Some(plan::StructuralConflict::DestinationDirectory),
        )?
    } else {
        None
    };
    fs::create_dir_all(destination)?;
    sync_directory(destination.parent().expect("directory has a parent"))?;
    Ok(ActionOutcome {
        safety_net: None,
        structural_safety_net,
        warnings: Vec::new(),
    })
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
    allow_empty_directory: bool,
) -> io::Result<Option<PathBuf>> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if allow_empty_directory && !metadata.file_type().is_dir() => {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "destination object changed after review",
            ))
        }
        Ok(metadata) if metadata.file_type().is_dir() && !allow_empty_directory => {
            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "destination path is a directory",
            ))
        }
        Ok(metadata)
            if metadata.file_type().is_dir()
                && !allow_empty_directory
                && fs::read_dir(destination)?.next().transpose()?.is_some() =>
        {
            Err(io::Error::new(
                io::ErrorKind::DirectoryNotEmpty,
                "destination directory changed after review",
            ))
        }
        Ok(metadata) if metadata.file_type().is_dir() && permanent_delete => {
            if allow_empty_directory {
                fs::remove_dir_all(destination).map(|()| None)
            } else {
                fs::remove_dir(destination).map(|()| None)
            }
        }
        Ok(_) if permanent_delete => fs::remove_file(destination).map(|()| None),
        Ok(_) => archive_by_rename(destination_root, destination, relative_path, run_id).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn reviewed_path(plan: &plan::Plan, path: &Path) -> bool {
    plan.copies
        .iter()
        .chain(&plan.updates)
        .chain(&plan.deletes)
        .any(|action| action.rel_path == path)
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
    #[cfg(all(feature = "fault-injection", debug_assertions))]
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
struct TempVerification {
    warnings: Vec<MetadataWarning>,
    size_mismatch: bool,
    content_mismatch: bool,
}

impl TempVerification {
    fn has_data_mismatch(&self) -> bool {
        self.size_mismatch || self.content_mismatch
    }

    fn data_mismatch_error(&self) -> ActionFailure {
        let detail = if self.size_mismatch {
            "verify mismatch: size differs"
        } else {
            "verify mismatch: content differs"
        };
        ActionFailure::new(
            FailureReason::VerifyMismatch,
            io::Error::new(io::ErrorKind::InvalidData, detail),
        )
    }
}

fn verify_temp(
    source: &Path,
    temp: &Path,
    planned_size: u64,
    full_verify: bool,
) -> io::Result<TempVerification> {
    let source_after = fs::symlink_metadata(source)?;
    let copied = fs::symlink_metadata(temp)?;
    let source_is_symlink = source_after.file_type().is_symlink();
    let size_mismatch =
        copied.len() != planned_size || copied.file_type().is_symlink() != source_is_symlink;
    let content_mismatch = if source_is_symlink {
        fs::read_link(source)? != fs::read_link(temp)?
    } else {
        full_verify && !files_equal(source, temp)?
    };
    let source_mtime = source_after.modified()?;
    let temp_mtime = copied.modified()?;
    let mut warnings = Vec::new();
    let delta = source_mtime.duration_since(temp_mtime).unwrap_or_else(|_| {
        temp_mtime
            .duration_since(source_mtime)
            .expect("opposite order works")
    });
    let filesystem_path = if source_is_symlink {
        temp.parent().expect("temp has a parent")
    } else {
        temp
    };
    let timestamp_granularity = crate::volume::timestamp_granularity(filesystem_path)?;
    if delta > timestamp_granularity {
        warnings.push(MetadataWarning::mismatch("modified time differs"));
    }
    // macOS preserves extended attributes on exFAT through AppleDouble
    // sidecars. Compare the file-facing name set on every filesystem; the
    // scanner keeps the backing `._*` machinery out of sync content.
    if xattr_names(source)? != xattr_names(temp)? {
        warnings.push(MetadataWarning::mismatch("xattr names differ"));
    }
    Ok(TempVerification {
        warnings,
        size_mismatch,
        content_mismatch,
    })
}

fn revalidate_source(
    source: &Path,
    planned_source_mtime: std::time::SystemTime,
    planned_size: u64,
) -> Result<(), ActionFailure> {
    let source_final = fs::symlink_metadata(source)?;
    if source_final.len() != planned_size || source_final.modified()? != planned_source_mtime {
        return Err(ActionFailure::new(
            FailureReason::SourceChanged,
            io::Error::new(io::ErrorKind::InvalidData, "source changed during copy"),
        ));
    }
    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> io::Result<bool> {
    Ok(file_hash(left)? == file_hash(right)?)
}

fn file_hash(path: &Path) -> io::Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hasher.finalize().into());
        }
        hasher.update(&buffer[..read]);
    }
}

fn xattr_names(path: &Path) -> io::Result<Vec<Vec<u8>>> {
    let path = c_path(path)?;
    let length = unsafe { listxattr(path.as_ptr(), std::ptr::null_mut(), 0, XATTR_NOFOLLOW) };
    if length < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut raw = vec![0_u8; length as usize];
    if length > 0 {
        let actual = unsafe {
            listxattr(
                path.as_ptr(),
                raw.as_mut_ptr().cast(),
                raw.len(),
                XATTR_NOFOLLOW,
            )
        };
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
    use crate::plan::StructuralConflict;

    /// `Journal::create` resolves its storage root from `$HOME`
    /// (`src/journal.rs::pair_directory`), which is not otherwise injectable.
    /// Serializes the mutation across this module's tests so none observes
    /// another's `$HOME` mid-run, and restores the prior value afterward.
    struct HomeEnvGuard {
        previous: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl HomeEnvGuard {
        fn set(home: &Path) -> Self {
            static HOME_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let lock = HOME_ENV_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let previous = std::env::var_os("HOME");
            std::env::set_var("HOME", home);
            Self {
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for HomeEnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    fn with_isolated_home_env<T>(home: &Path, run: impl FnOnce() -> T) -> T {
        let _guard = HomeEnvGuard::set(home);
        run()
    }

    fn sample_pair(destination: &Path) -> crate::config::Pair {
        crate::config::Pair {
            source: PathBuf::from("/source"),
            source_volume_uuid: "SOURCE-UUID".to_string(),
            source_volume_name: None,
            source_volume_relative_path: None,
            destination: destination.to_path_buf(),
            destination_volume_uuid: "DEST-UUID".to_string(),
            destination_volume_name: None,
            destination_volume_relative_path: None,
            mode: crate::config::Mode::Mirror,
        }
    }

    #[test]
    fn stale_pair_error_refuses_only_a_plan_reviewed_against_a_different_definition() {
        let reviewed = sample_pair(Path::new("/first-destination"));
        let redefined = sample_pair(Path::new("/second-destination"));

        assert!(
            matches!(
                stale_pair_error(&redefined, &reviewed),
                Some(AppError::Precondition(message)) if message == "Folder pair changed during TUI review; reopen the TUI before running"
            ),
            "{:?}",
            stale_pair_error(&redefined, &reviewed)
        );
        assert!(stale_pair_error(&reviewed, &reviewed).is_none());
    }

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
                source_mtime: None,
                old_bytes: None,
                reason: "new".to_string(),
                structural_conflict: None,
            }],
            ..plan::Plan::default()
        };
        let mut fresh = plan::Plan {
            copies: vec![
                reviewed.copies[0].clone(),
                Action {
                    rel_path: PathBuf::from("arrived-later.txt"),
                    bytes: 2,
                    source_mtime: None,
                    old_bytes: None,
                    reason: "new".to_string(),
                    structural_conflict: None,
                },
            ],
            ..plan::Plan::default()
        };

        retain_reviewed_actions(&mut fresh, &reviewed);

        assert_eq!(fresh.copies, reviewed.copies);
    }

    #[test]
    fn discovered_after_review_counts_only_actions_absent_from_the_reviewed_plan() {
        let reviewed = plan::Plan {
            copies: vec![Action {
                rel_path: PathBuf::from("reviewed.txt"),
                bytes: 1,
                source_mtime: None,
                old_bytes: None,
                reason: "new".to_string(),
                structural_conflict: None,
            }],
            ..plan::Plan::default()
        };
        let fresh = plan::Plan {
            copies: vec![
                reviewed.copies[0].clone(),
                Action {
                    rel_path: PathBuf::from("arrived-during-review.txt"),
                    bytes: 2,
                    source_mtime: None,
                    old_bytes: None,
                    reason: "new".to_string(),
                    structural_conflict: None,
                },
            ],
            ..plan::Plan::default()
        };

        assert_eq!(discovered_after_review(&reviewed, &fresh), 1);
        assert_eq!(discovered_after_review(&reviewed, &reviewed), 0);
    }

    #[test]
    fn changed_reviewed_action_is_reported_as_missing() {
        let reviewed = plan::Plan {
            copies: vec![Action {
                rel_path: PathBuf::from("photo.txt"),
                bytes: 1,
                source_mtime: Some(std::time::SystemTime::UNIX_EPOCH),
                old_bytes: None,
                reason: "new".to_string(),
                structural_conflict: None,
            }],
            ..plan::Plan::default()
        };
        let fresh = plan::Plan {
            copies: vec![Action {
                rel_path: PathBuf::from("photo.txt"),
                bytes: 1,
                source_mtime: Some(
                    std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1),
                ),
                old_bytes: None,
                reason: "new".to_string(),
                structural_conflict: None,
            }],
            ..plan::Plan::default()
        };

        let missing = missing_reviewed_actions(&reviewed, &fresh);

        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].0.as_str(), "copy");
        assert_eq!(missing[0].1.rel_path, PathBuf::from("photo.txt"));
    }

    #[test]
    fn directory_replacement_is_identified_by_reviewed_actions_not_reason_text() {
        let deletion = Action {
            rel_path: PathBuf::from("report.txt"),
            bytes: 0,
            source_mtime: None,
            old_bytes: Some(0),
            reason: "presentation text may change".to_string(),
            structural_conflict: Some(StructuralConflict::DestinationDirectory),
        };
        let copy = Action {
            rel_path: PathBuf::from("report.txt"),
            bytes: 10,
            source_mtime: None,
            old_bytes: None,
            reason: "new".to_string(),
            structural_conflict: None,
        };

        assert_eq!(
            deletion.structural_conflict,
            Some(StructuralConflict::DestinationDirectory)
        );
        assert!(copy.structural_conflict.is_none());
        let mut plan = plan::Plan {
            copies: vec![copy],
            deletes: vec![deletion],
            ..plan::Plan::default()
        };
        assert_eq!(plan::drop_orphan_structural_deletions(&mut plan), 0);
        plan.copies.clear();
        assert_eq!(plan::drop_orphan_structural_deletions(&mut plan), 1);
        assert!(plan.deletes.is_empty());
    }

    #[test]
    fn destination_file_replacement_requires_an_included_descendant_copy() {
        let deletion = Action {
            rel_path: PathBuf::from("docs"),
            bytes: 8,
            source_mtime: None,
            old_bytes: Some(8),
            reason: "presentation text may change".to_string(),
            structural_conflict: Some(StructuralConflict::DestinationFile),
        };
        let copy = Action {
            rel_path: PathBuf::from("docs/new.txt"),
            bytes: 10,
            source_mtime: None,
            old_bytes: None,
            reason: "new".to_string(),
            structural_conflict: None,
        };
        let mut plan = plan::Plan {
            copies: vec![copy],
            deletes: vec![deletion],
            ..plan::Plan::default()
        };

        assert_eq!(plan::drop_orphan_structural_deletions(&mut plan), 0);
        plan.copies.clear();
        assert_eq!(plan::drop_orphan_structural_deletions(&mut plan), 1);
        assert!(plan.deletes.is_empty());
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
            source_mtime: None,
            old_bytes: None,
            reason: "new".to_string(),
            structural_conflict: None,
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
                structural_delete: None,
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
            source_mtime: None,
            old_bytes: Some(11),
            reason: "size differs".to_string(),
            structural_conflict: None,
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
                structural_delete: None,
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

    #[test]
    fn cleanup_stray_temps_removes_stray_file_and_records_journal_entry() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let stray = PathBuf::from("stray.vibesync-tmp");
        fs::write(destination_dir.path().join(&stray), "leftover").unwrap();
        let home = tempfile::tempdir().unwrap();

        with_isolated_home_env(home.path(), || {
            let mut journal =
                Journal::create("cleanup-success-pair", destination_dir.path()).unwrap();
            let reporter = RunReporter::new(false);
            let mut stats = RunStats::default();

            let outcome = cleanup_stray_temps(
                source_dir.path(),
                destination_dir.path(),
                std::slice::from_ref(&stray),
                &mut journal,
                &reporter,
                &mut stats,
            )
            .unwrap();

            assert!(matches!(outcome, CleanupOutcome::Continue));
            assert!(!destination_dir.path().join(&stray).exists());
            assert_eq!(stats.counts.done, 1);
            assert_eq!(stats.counts.failed, 0);
        });
    }

    #[test]
    fn cleanup_stray_temps_aborts_and_leaves_the_stray_when_removal_fails() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        // `fs::remove_file` rejects a directory, forcing a deterministic
        // removal failure without the fault-injection feature.
        let stray = PathBuf::from("stray-dir.vibesync-tmp");
        fs::create_dir(destination_dir.path().join(&stray)).unwrap();
        let home = tempfile::tempdir().unwrap();

        with_isolated_home_env(home.path(), || {
            let mut journal =
                Journal::create("cleanup-failure-pair", destination_dir.path()).unwrap();
            let reporter = RunReporter::new(false);
            let mut stats = RunStats::default();

            let outcome = cleanup_stray_temps(
                source_dir.path(),
                destination_dir.path(),
                std::slice::from_ref(&stray),
                &mut journal,
                &reporter,
                &mut stats,
            )
            .unwrap();

            assert!(matches!(outcome, CleanupOutcome::Abort));
            assert_eq!(stats.counts.failed, 1);
            assert!(
                destination_dir.path().join(&stray).exists(),
                "a failed removal must leave the stray in place"
            );
        });
    }

    #[test]
    fn reconcile_plan_retains_reviewed_actions_and_reports_discovered_after_review() {
        let config_dir = tempfile::tempdir().unwrap();
        let config_path = config_dir.path().join("config.toml");
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        fs::write(source_dir.path().join("reviewed.txt"), "a").unwrap();
        crate::pair::add(
            &config_path,
            "reconcile-pair",
            source_dir.path(),
            destination_dir.path(),
            crate::config::Mode::Mirror,
            false,
        )
        .unwrap();
        let (_, initial_plan) = plan::build(&config_path, "reconcile-pair", &[]).unwrap();
        // Appears after the plan above was reviewed; reconcile must report it
        // as discovered and must not fold it into the reconciled plan.
        fs::write(source_dir.path().join("arrived-after-review.txt"), "b").unwrap();
        let home = tempfile::tempdir().unwrap();

        with_isolated_home_env(home.path(), || {
            let mut journal = Journal::create("reconcile-pair", destination_dir.path()).unwrap();
            let reporter = RunReporter::new(false);
            let mut stats = RunStats::default();

            let (_, plan) = reconcile_plan(
                &config_path,
                "reconcile-pair",
                &[],
                &initial_plan,
                &mut journal,
                &reporter,
                &mut stats,
            )
            .unwrap();

            assert_eq!(plan.copies, initial_plan.copies);
            assert_eq!(stats.discovered_after_review, 1);
        });
    }
}
