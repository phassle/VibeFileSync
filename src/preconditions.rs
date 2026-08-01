//! Deterministic, pre-mutation guards from ADR-0002. Volume identity is
//! checked for both `plan` and `run`; the destructive-run guards live at the
//! run edge so a dry-run can still explain what would happen.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::{Mode, Pair};
use crate::error::AppError;
use crate::plan::Plan;
use crate::volume;

pub fn resolve_pair(pair: &Pair) -> Result<(Pair, Vec<String>), AppError> {
    let (source, source_notice) = resolve_path(
        &pair.source,
        &pair.source_volume_uuid,
        pair.source_volume_relative_path.as_deref(),
        "source",
    )?;
    let (destination, destination_notice) = resolve_path(
        &pair.destination,
        &pair.destination_volume_uuid,
        pair.destination_volume_relative_path.as_deref(),
        "destination",
    )?;
    let mut resolved = pair.clone();
    resolved.source = source;
    resolved.destination = destination;
    Ok((
        resolved,
        [source_notice, destination_notice]
            .into_iter()
            .flatten()
            .collect(),
    ))
}

fn resolve_path(
    path: &Path,
    expected_uuid: &str,
    relative_path: Option<&Path>,
    side: &str,
) -> Result<(PathBuf, Option<String>), AppError> {
    resolve_path_with_lookup(
        path,
        expected_uuid,
        relative_path,
        side,
        volume::mounted_path_for_uuid,
    )
}

fn resolve_path_with_lookup<F>(
    path: &Path,
    expected_uuid: &str,
    relative_path: Option<&Path>,
    side: &str,
    find_mounted_volume: F,
) -> Result<(PathBuf, Option<String>), AppError>
where
    F: FnOnce(&str) -> io::Result<Option<PathBuf>>,
{
    if path.is_dir() && volume::volume_uuid(path).ok().as_deref() == Some(expected_uuid) {
        return Ok((path.to_path_buf(), None));
    }
    let relocated = find_mounted_volume(expected_uuid)
        .map_err(|error| AppError::Precondition(format!("could not inspect mounted volumes for {side}: {error}")))?
        .ok_or_else(|| AppError::Precondition(format!(
            "{side} volume {expected_uuid} is not mounted; refusing to enumerate a different or empty path"
        )))?;
    let relocated_folder = relocated_folder(&relocated, relative_path, side, expected_uuid)?;
    Ok((
        relocated_folder.clone(),
        Some(relocation_notice(
            side,
            path,
            &relocated_folder,
            expected_uuid,
        )),
    ))
}

fn relocated_folder(
    mount: &Path,
    relative_path: Option<&Path>,
    side: &str,
    expected_uuid: &str,
) -> Result<PathBuf, AppError> {
    let relative_path = relative_path.ok_or_else(|| AppError::Precondition(format!(
        "{side} volume moved but this pair was created before its folder-relative path was recorded; remove and re-add the pair before running"
    )))?;
    let folder = mount.join(relative_path);
    if !folder.is_dir() {
        return Err(AppError::Precondition(format!(
            "{side} volume {expected_uuid} is mounted at {}, but the configured folder {} is absent",
            mount.display(), folder.display()
        )));
    }
    Ok(folder)
}

pub fn check_run(
    pair: &Pair,
    plan: &Plan,
    allow_empty_source: bool,
    ignore_space_check: bool,
) -> Result<Vec<String>, AppError> {
    if pair.mode == Mode::Mirror
        && plan.source_entries == 0
        && plan.destination_entries > 0
        && !allow_empty_source
    {
        return Err(AppError::Precondition(
            "source is empty while Mirror destination is non-empty; rerun with --allow-empty-source to override".to_string(),
        ));
    }

    let required = required_space(plan);
    let available = available_space(&pair.destination).map_err(|error| {
        AppError::Precondition(format!(
            "could not determine destination free space: {error}"
        ))
    })?;
    enforce_space(required, available, ignore_space_check)?;

    let mut warnings = Vec::new();
    match tree_size(&pair.destination.join("_SafetyNet")) {
        Ok(safety_net_bytes) => {
            warnings.push(format!(
                "vibesync: warning: _SafetyNet/ uses {safety_net_bytes} bytes"
            ));
        }
        Err(error) => warnings.push(format!(
            "vibesync: warning: could not measure _SafetyNet/: {error}"
        )),
    }
    if required > available {
        warnings.push(format!("vibesync: warning: ignoring free-space preflight (need {required} bytes; have {available})"));
    }
    Ok(warnings)
}

fn required_space(plan: &Plan) -> u64 {
    plan.copies
        .iter()
        .chain(&plan.updates)
        .map(|action| action.bytes)
        .sum()
}

fn enforce_space(required: u64, available: u64, ignore_space_check: bool) -> Result<(), AppError> {
    if required > available && !ignore_space_check {
        return Err(AppError::Precondition(format!(
            "destination free space is insufficient: need {required} bytes for new and changed files, have {available}; rerun with --ignore-space-check to override"
        )));
    }
    Ok(())
}

fn available_space(path: &Path) -> io::Result<u64> {
    #[cfg(all(feature = "fault-injection", debug_assertions))]
    if let Some(value) = std::env::var_os("VIBESYNC_TEST_AVAILABLE_BYTES") {
        return value.to_string_lossy().parse().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "bad VIBESYNC_TEST_AVAILABLE_BYTES",
            )
        });
    }
    let bytes = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains an interior NUL byte",
        )
    })?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(bytes.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

fn relocation_notice(side: &str, from: &Path, to: &Path, uuid: &str) -> String {
    format!(
        "vibesync: {side} volume moved: {} → {} (UUID {uuid})",
        from.display(),
        to.display()
    )
}

fn tree_size(root: &Path) -> io::Result<u64> {
    if !root.exists() {
        return Ok(0);
    }
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total += metadata.len();
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_empty_source_requires_its_one_run_override() {
        let pair = Pair {
            source: PathBuf::from("/"),
            source_volume_uuid: String::new(),
            source_volume_relative_path: Some(PathBuf::new()),
            destination: PathBuf::from("/"),
            destination_volume_uuid: String::new(),
            destination_volume_relative_path: Some(PathBuf::new()),
            mode: Mode::Mirror,
        };
        let plan = Plan {
            source_entries: 0,
            destination_entries: 1,
            ..Plan::default()
        };
        let error = check_run(&pair, &plan, false, true).unwrap_err();
        assert!(error.to_string().contains("--allow-empty-source"));
    }

    #[test]
    fn space_check_is_conservative_and_has_only_a_run_override() {
        let error = enforce_space(101, 100, false).unwrap_err();
        assert!(error.to_string().contains("--ignore-space-check"));
        enforce_space(101, 100, true).expect("explicit override permits this run");
        enforce_space(100, 100, false).expect("exact fit is sufficient");
    }

    #[test]
    fn required_space_counts_new_and_changed_files_only() {
        let plan = Plan {
            copies: vec![crate::plan::Action {
                rel_path: PathBuf::from("new"),
                bytes: 10,
                source_mtime: None,
                old_bytes: None,
                reason: String::new(),
                structural_conflict: None,
            }],
            updates: vec![crate::plan::Action {
                rel_path: PathBuf::from("changed"),
                bytes: 20,
                source_mtime: None,
                old_bytes: Some(5),
                reason: String::new(),
                structural_conflict: None,
            }],
            deletes: vec![crate::plan::Action {
                rel_path: PathBuf::from("removed"),
                bytes: 9_999,
                source_mtime: None,
                old_bytes: Some(9_999),
                reason: String::new(),
                structural_conflict: None,
            }],
            ..Plan::default()
        };
        assert_eq!(required_space(&plan), 30);
    }

    #[test]
    fn relocated_pair_keeps_its_folder_suffix_and_rejects_legacy_pairs() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("Photos/2026")).unwrap();
        assert_eq!(
            relocated_folder(
                mount.path(),
                Some(Path::new("Photos/2026")),
                "source",
                "uuid"
            )
            .unwrap(),
            mount.path().join("Photos/2026")
        );
        assert!(relocated_folder(mount.path(), None, "source", "uuid")
            .unwrap_err()
            .to_string()
            .contains("remove and re-add"));
    }

    #[test]
    fn relocation_notice_loudly_names_both_paths_and_uuid() {
        let notice = relocation_notice(
            "source",
            Path::new("/Volumes/Backup/Photos"),
            Path::new("/Volumes/Backup 1/Photos"),
            "A1B2",
        );
        assert!(notice.contains("moved"));
        assert!(notice.contains("/Volumes/Backup/Photos"));
        assert!(notice.contains("/Volumes/Backup 1/Photos"));
        assert!(notice.contains("A1B2"));
    }

    #[test]
    fn resolution_uses_the_relocated_folder_and_emits_its_notice() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("Photos/2026")).unwrap();
        let old = Path::new("/Volumes/Backup/Photos/2026");

        let (resolved, notice) = resolve_path_with_lookup(
            old,
            "A1B2",
            Some(Path::new("Photos/2026")),
            "source",
            |_| Ok(Some(mount.path().to_path_buf())),
        )
        .unwrap();

        assert_eq!(resolved, mount.path().join("Photos/2026"));
        let notice = notice.expect("mount drift must be loud");
        assert!(notice.contains("source volume moved"));
        assert!(notice.contains("A1B2"));
        assert!(notice.contains(&resolved.display().to_string()));
    }
}
