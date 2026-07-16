//! Destination mutation: a sibling dot-temp passes durability and verification
//! before SafetyNet archives any old destination object and Publish renames the
//! verified temp into place (ADR-0001 and ADR-0008).

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::{AppError, EXIT_BLOCKED_PLAN, EXIT_OK};
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

pub fn run(
    config_path: &Path,
    pair_name: &str,
    yes: bool,
    permanent_delete: bool,
    excludes: &[String],
) -> Result<i32, AppError> {
    let (pair, plan) = plan::build(config_path, pair_name, excludes)?;
    print!("{}", plan::render(&plan, pair_name, pair.mode));

    if !plan.errors.is_empty() {
        eprintln!(
            "vibesync: run blocked by {} plan error(s)",
            plan.errors.len()
        );
        return Ok(EXIT_BLOCKED_PLAN);
    }

    if !yes && !confirm()? {
        println!("Run cancelled; destination unchanged.");
        return Ok(EXIT_OK);
    }

    let (run_id, run_lock) = allocate_run_id(&pair.destination).map_err(io_error)?;
    let mut failed = 0;
    for (operation, action) in plan
        .copies
        .iter()
        .map(|action| ("COPY", action))
        .chain(plan.updates.iter().map(|action| ("UPDATE", action)))
    {
        let source = pair.source.join(&action.rel_path);
        let destination = pair.destination.join(&action.rel_path);
        if let Err(error) = copy_file(
            &pair.destination,
            &source,
            &destination,
            action,
            &run_id,
            permanent_delete,
        ) {
            failed += 1;
            eprintln!(
                "vibesync: {} {} failed: {error}",
                operation,
                action.rel_path.display()
            );
        }
    }
    for action in &plan.deletes {
        let destination = pair.destination.join(&action.rel_path);
        if let Err(error) = remove_file(
            &pair.destination,
            &destination,
            &action.rel_path,
            &run_id,
            permanent_delete,
        ) {
            failed += 1;
            eprintln!("vibesync: DELETE {} failed: {error}", action.rel_path.display());
        }
    }

    let _ = fs::remove_file(run_lock);
    if failed == 0 {
        Ok(EXIT_OK)
    } else {
        Ok(1)
    }
}

fn confirm() -> Result<bool, AppError> {
    print!("Proceed with COPY actions? [y/N] ");
    io::stdout().flush().map_err(io_error)?;
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
    action: &Action,
    run_id: &str,
    permanent_delete: bool,
) -> io::Result<()> {
    let source_before = fs::metadata(source)?;
    let parent = destination
        .parent()
        .expect("relative COPY path always has a parent");
    fs::create_dir_all(parent)?;
    let temp = temporary_path(destination, run_id);

    let result = (|| {
        copyfile_all_but_acls(source, &temp)?;
        fully_sync(&temp)?;
        let warnings = verify(source, &source_before, &temp, action.bytes)?;
        remove_file(
            destination_root,
            destination,
            &action.rel_path,
            run_id,
            permanent_delete,
        )?;
        fs::rename(&temp, destination)?;
        sync_directory(parent)?;
        for warning in warnings {
            eprintln!(
                "vibesync: COPY {} warning: {warning}",
                action.rel_path.display()
            );
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
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
) -> io::Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_dir() => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination path is a directory",
        )),
        Ok(_) if permanent_delete => fs::remove_file(destination),
        Ok(_) => archive_by_rename(destination_root, destination, relative_path, run_id),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
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
) -> io::Result<()> {
    let archive = destination_root
        .join("_SafetyNet")
        .join(run_id)
        .join(relative_path);
    let archive_parent = archive.parent().expect("archive relative path has a parent");
    fs::create_dir_all(archive_parent)?;
    fs::rename(destination, &archive)?;
    sync_directory(archive_parent)?;
    if let Some(destination_parent) = destination.parent() {
        sync_directory(destination_parent)?;
    }
    Ok(())
}

/// Deletes only direct, real Run folders below this pair's visible
/// `_SafetyNet/` root. No run path is pruned automatically.
pub fn prune(config_path: &Path, pair_name: &str) -> Result<i32, AppError> {
    let config = crate::config::load(config_path)?;
    let pair = config
        .pairs
        .get(pair_name)
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))?;
    let safety_net = pair.destination.join("_SafetyNet");
    let entries = match fs::read_dir(&safety_net) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(EXIT_OK),
        Err(error) => return Err(io_error(error)),
    };
    for entry in entries {
        let entry = entry.map_err(io_error)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if metadata.file_type().is_dir() {
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

/// Acquires a short-lived root lock with `create_new`, which makes Run id
/// allocation collision-safe across separate processes as well as threads.
/// The lock name is scanner machinery and is removed when this run returns.
fn allocate_run_id(destination_root: &Path) -> io::Result<(String, PathBuf)> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch");
    let base = utc_basic(now.as_secs());
    let mut suffix = 1_u32;
    loop {
        let run_id = if suffix == 1 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        let lock = destination_root.join(format!("._vibesync-run-{run_id}"));
        match OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(_) => return Ok((run_id, lock)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        suffix = suffix.checked_add(1).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "run id suffix space exhausted",
            )
        })?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_run_ids_use_the_basic_exfat_safe_format() {
        assert_eq!(utc_basic(0), "19700101T000000Z");
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
    fn run_id_allocator_suffixes_a_same_second_collision() {
        let root = tempfile::tempdir().unwrap();
        let (first, first_lock) = allocate_run_id(root.path()).unwrap();
        let (second, second_lock) = allocate_run_id(root.path()).unwrap();
        assert!(first.ends_with('Z'));
        assert_eq!(second, format!("{first}-2"));
        fs::remove_file(first_lock).unwrap();
        fs::remove_file(second_lock).unwrap();
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
            reason: "new".to_string(),
        };

        let result = copy_file(
            destination_dir.path(),
            &source,
            &destination,
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
            reason: "size differs".to_string(),
        };

        let result = copy_file(
            destination_dir.path(),
            &source,
            &destination,
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
