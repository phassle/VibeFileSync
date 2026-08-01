//! Retained per-run Journal (`vibefilesync.journal/v1`) per ADR-0007.
//!
//! The Journal is append-only forensic evidence. It never participates in
//! planning or decides what a later run copies.

use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, EXIT_OK};
use crate::plan::{Action, Plan};

const SCHEMA: &str = "vibefilesync.journal/v1";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Copy,
    Update,
    Delete,
    Cleanup,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Operation::Copy => "copy",
            Operation::Update => "update",
            Operation::Delete => "delete",
            Operation::Cleanup => "cleanup",
        }
    }
}

pub struct Journal {
    file: File,
    run_id: String,
}

impl Journal {
    pub fn create(pair_name: &str, destination_root: &Path) -> io::Result<Self> {
        let directory = pair_directory(pair_name);
        fs::create_dir_all(&directory)?;
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_secs();
        let base = utc_basic(seconds);
        let mut suffix = 1_u32;
        loop {
            let run_id = if suffix == 1 {
                base.clone()
            } else {
                format!("{base}-{suffix}")
            };
            if destination_root.join("_SafetyNet").join(&run_id).exists() {
                suffix = next_suffix(suffix)?;
                continue;
            }
            let path = directory.join(format!("{run_id}.ndjson"));
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(file) => return Ok(Self { file, run_id }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    suffix = next_suffix(suffix)?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn run_start(
        &mut self,
        pair_name: &str,
        plan: &Plan,
        run_warnings: &[String],
        degradations: &[&str],
    ) -> io::Result<()> {
        let actions = crate::event::planned_actions(plan);
        let mut event = crate::event::run_start(
            crate::event::Context {
                schema: SCHEMA,
                run_id: &self.run_id,
            },
            pair_name,
            run_warnings,
            degradations,
        );
        event["planned_actions"] = actions.into();
        self.append(event, true)
    }

    pub fn action_start(
        &mut self,
        operation: Operation,
        action: &Action,
        source: Option<&Path>,
        temp: Option<&Path>,
    ) -> io::Result<()> {
        let source_identity = source.map(fs::metadata).transpose()?.map(|metadata| {
            let modified_ns = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos().to_string());
            json!({ "size": metadata.len(), "modified_ns": modified_ns })
        });
        let context = crate::event::Context {
            schema: SCHEMA,
            run_id: &self.run_id,
        };
        let mut event = crate::event::action_start(context, operation, action);
        event["temp_path"] = temp.map_or(Value::Null, |path| json!(path_text(path)));
        event["source_identity"] = source_identity.unwrap_or(Value::Null);
        self.append(event, false)
    }

    pub fn action_done(
        &mut self,
        operation: Operation,
        action: &Action,
        safety_net: Option<&Path>,
        warnings: &[String],
        verified: Option<&str>,
    ) -> io::Result<()> {
        self.append(
            crate::event::action_done(
                crate::event::Context {
                    schema: SCHEMA,
                    run_id: &self.run_id,
                },
                operation,
                action,
                safety_net,
                warnings,
                verified,
                true,
            ),
            false,
        )
    }

    pub fn action_failed(
        &mut self,
        operation: Operation,
        action: &Action,
        reason: &str,
    ) -> io::Result<()> {
        self.append(
            crate::event::action_failed(
                crate::event::Context {
                    schema: SCHEMA,
                    run_id: &self.run_id,
                },
                operation,
                action,
                reason,
            ),
            false,
        )
    }

    pub fn summary(&mut self, stats: &RunStats) -> io::Result<()> {
        self.append(
            crate::event::summary(
                crate::event::Context {
                    schema: SCHEMA,
                    run_id: &self.run_id,
                },
                stats,
            ),
            true,
        )
    }

    fn append(&mut self, value: Value, sync: bool) -> io::Result<()> {
        serde_json::to_writer(&mut self.file, &value)?;
        self.file.write_all(b"\n")?;
        if sync {
            self.file.sync_all()?;
        }
        Ok(())
    }

    #[cfg(all(feature = "fault-injection", debug_assertions))]
    pub fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// Exclusive advisory lock held for the lifetime of its file descriptor.
/// The reusable `.lock` inode may remain, but process death always releases
/// the lock itself.
pub struct PairLock {
    _file: File,
}

impl PairLock {
    pub fn acquire(pair_name: &str) -> io::Result<Self> {
        let directory = pair_directory(pair_name);
        fs::create_dir_all(&directory)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(".lock"))?;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            return Ok(Self { _file: file });
        }
        let error = io::Error::last_os_error();
        let code = error.raw_os_error();
        if code == Some(libc::EWOULDBLOCK) || code == Some(libc::EAGAIN) {
            Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "run already in progress",
            ))
        } else {
            Err(error)
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Counts {
    pub planned: usize,
    pub done: usize,
    pub failed: usize,
    pub copied: usize,
    pub updated: usize,
    pub deleted: usize,
}

#[derive(Debug, Default)]
pub struct RunStats {
    pub counts: Counts,
    pub bytes: u64,
    pub warnings: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunRecord {
    pub run_id: String,
    pub result: String,
    pub counts: Counts,
    pub bytes: u64,
    pub warnings: usize,
}

pub fn pair_directory(pair_name: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Library/Application Support/VibeFileSync/runs")
        .join(pair_name)
}

pub fn status(config_path: &Path, pair_name: &str) -> Result<i32, AppError> {
    let pair = configured_pair(config_path, pair_name)?;
    match latest_record(pair_name).map_err(journal_error)? {
        Some(record) => {
            println!("Latest run for '{pair_name}': {}", record.run_id);
            println!("Started: {}", local_time(&record.run_id));
            println!("Result: {}", record.result);
            println!(
                "Actions: {} done · {} failed · {} planned",
                record.counts.done, record.counts.failed, record.counts.planned
            );
            println!("Bytes: {} · warnings: {}", record.bytes, record.warnings);
        }
        None => println!("No runs recorded for '{pair_name}'."),
    }
    let strays = crate::plan::stray_temps(&pair.destination).map_err(journal_error)?;
    println!("Stray temps ({})", strays.len());
    for stray in strays {
        println!("  {}", stray.display());
    }
    Ok(EXIT_OK)
}

pub fn history_human(config_path: &Path, pair_name: &str) -> Result<i32, AppError> {
    configured_pair(config_path, pair_name)?;
    let records = records(pair_name).map_err(journal_error)?;
    if records.is_empty() {
        println!("No runs recorded for '{pair_name}'.");
        return Ok(EXIT_OK);
    }
    println!(
        "{:<24} {:<24} {:<12} {:<14} {:<8} {:<12} Warnings",
        "Run id", "Local time", "Result", "Done/Planned", "Failed", "Bytes"
    );
    for record in records {
        println!(
            "{:<24} {:<24} {:<12} {:>4}/{:<9} {:>8} {:>12} {}",
            record.run_id,
            local_time(&record.run_id),
            record.result,
            record.counts.done,
            record.counts.planned,
            record.counts.failed,
            record.bytes,
            record.warnings
        );
    }
    Ok(EXIT_OK)
}

pub fn history_json(config_path: &Path, pair_name: &str) -> Result<i32, AppError> {
    configured_pair(config_path, pair_name)?;
    let records = records(pair_name).map_err(journal_error)?;
    let payload = json!({
        "schema": "vibefilesync.history/v1",
        "pair": pair_name,
        "runs": records,
    });
    println!("{payload}");
    Ok(EXIT_OK)
}

fn latest_record(pair_name: &str) -> io::Result<Option<RunRecord>> {
    Ok(records(pair_name)?.into_iter().next())
}

fn records(pair_name: &str) -> io::Result<Vec<RunRecord>> {
    let directory = pair_directory(pair_name);
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut journals = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("ndjson") {
            continue;
        }
        let Some(run_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_run_id(std::ffi::OsStr::new(run_id)) {
            continue;
        }
        journals.push((run_id.to_string(), path));
    }
    journals.sort_unstable_by(|left, right| {
        let (left_time, left_suffix) = run_order_key(&left.0);
        let (right_time, right_suffix) = run_order_key(&right.0);
        right_time
            .cmp(left_time)
            .then_with(|| right_suffix.cmp(&left_suffix))
    });
    journals
        .into_iter()
        .map(|(run_id, path)| read_record(&path, run_id))
        .collect()
}

fn read_record(path: &Path, run_id: String) -> io::Result<RunRecord> {
    let contents = fs::read_to_string(path)?;
    let lines: Vec<_> = contents
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let mut record = RunRecord {
        run_id,
        result: "interrupted".to_string(),
        counts: Counts::default(),
        bytes: 0,
        warnings: 0,
    };
    for (index, line) in lines.iter().enumerate() {
        let event: Value = match serde_json::from_str(line) {
            Ok(event) => event,
            Err(_) if index + 1 == lines.len() => break,
            Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        };
        match event.get("type").and_then(Value::as_str) {
            Some("run_start") => {
                record.counts.planned = event
                    .get("planned_actions")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
            }
            Some("action_done") => {
                record.counts.done += 1;
                record.bytes += event.get("bytes").and_then(Value::as_u64).unwrap_or(0);
                record.warnings += event
                    .get("warnings")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                match event.get("op").and_then(Value::as_str) {
                    Some("copy") => record.counts.copied += 1,
                    Some("update") => record.counts.updated += 1,
                    Some("delete") => record.counts.deleted += 1,
                    _ => {}
                }
            }
            Some("action_failed") => record.counts.failed += 1,
            Some("summary") => apply_summary(&mut record, &event),
            _ => {}
        }
    }
    Ok(record)
}

fn apply_summary(record: &mut RunRecord, event: &Value) {
    record.result = event
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("partial")
        .to_string();
    if let Some(counts) = event.get("counts") {
        record.counts.planned = json_usize(counts, "planned");
        record.counts.done = json_usize(counts, "done");
        record.counts.failed = json_usize(counts, "failed");
        record.counts.copied = json_usize(counts, "copied");
        record.counts.updated = json_usize(counts, "updated");
        record.counts.deleted = json_usize(counts, "deleted");
    }
    record.bytes = event.get("bytes").and_then(Value::as_u64).unwrap_or(0);
    record.warnings = json_usize(event, "warnings");
}

fn json_usize(value: &Value, field: &str) -> usize {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0)
}

fn configured_pair(config_path: &Path, pair_name: &str) -> Result<crate::config::Pair, AppError> {
    let config = crate::config::load(config_path)?;
    config
        .pairs
        .get(pair_name)
        .cloned()
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))
}

fn journal_error(error: io::Error) -> AppError {
    AppError::Precondition(format!("could not read Journal: {error}"))
}

pub fn is_run_id(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let (timestamp, suffix) = match name.split_once('-') {
        Some((timestamp, suffix)) => (timestamp, Some(suffix)),
        None => (name, None),
    };
    let timestamp_is_valid = timestamp.len() == 16
        && timestamp.as_bytes()[8] == b'T'
        && timestamp.as_bytes()[15] == b'Z'
        && timestamp
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 15) || byte.is_ascii_digit());
    timestamp_is_valid
        && suffix.is_none_or(|suffix| suffix.parse::<u32>().is_ok_and(|value| value >= 2))
}

fn next_suffix(suffix: u32) -> io::Result<u32> {
    suffix.checked_add(1).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "run id suffix space exhausted",
        )
    })
}

fn utc_basic(seconds: u64) -> String {
    let timestamp = seconds as libc::time_t;
    let mut value: libc::tm = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::gmtime_r(&timestamp, &mut value) };
    assert!(!result.is_null(), "system clock must convert to UTC");
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        value.tm_year + 1900,
        value.tm_mon + 1,
        value.tm_mday,
        value.tm_hour,
        value.tm_min,
        value.tm_sec
    )
}

fn run_order_key(run_id: &str) -> (&str, u32) {
    match run_id.split_once('-') {
        Some((timestamp, suffix)) => (timestamp, suffix.parse().unwrap_or(1)),
        None => (run_id, 1),
    }
}

fn local_time(run_id: &str) -> String {
    let Some(timestamp) = run_id.get(..16) else {
        return run_id.to_string();
    };
    let Ok(timestamp) = CString::new(timestamp) else {
        return run_id.to_string();
    };
    let format = c"%Y%m%dT%H%M%SZ";
    let mut utc: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::strptime(timestamp.as_ptr(), format.as_ptr(), &mut utc) }.is_null() {
        return run_id.to_string();
    }
    let seconds = unsafe { libc::timegm(&mut utc) };
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&seconds, &mut local) }.is_null() {
        return run_id.to_string();
    }
    let mut rendered = [0_i8; 64];
    let length = unsafe {
        libc::strftime(
            rendered.as_mut_ptr(),
            rendered.len(),
            c"%Y-%m-%d %H:%M:%S %Z".as_ptr(),
            &local,
        )
    };
    if length == 0 {
        run_id.to_string()
    } else {
        unsafe { CStr::from_ptr(rendered.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
