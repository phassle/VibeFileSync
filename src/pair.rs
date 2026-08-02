//! Folder pair management: `pair add | list | remove`. Per ADR-0006, the
//! Pair name is the identity (a slug: lowercase letters, digits, dashes,
//! unique) and `pair add` is the only writer that pins volume UUIDs.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::{self, Config, Mode, Pair};
use crate::error::AppError;
use crate::preconditions::{self, VolumeState};
use crate::volume;

const PAIRS_SCHEMA: &str = "vibefilesync.pairs/v1";

fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn require_existing_dir(path: &Path) -> Result<(), AppError> {
    if !path.is_dir() {
        return Err(AppError::Usage(format!(
            "{}: not a directory (must exist before `pair add` can pin its volume)",
            path.display()
        )));
    }
    Ok(())
}

/// Pins `path`'s volume UUID, wrapping any failure as the `AppError`
/// variant the CLI reports (used identically for both the source and
/// destination side of a pair).
fn pin_volume_uuid(path: &Path) -> Result<String, AppError> {
    volume::volume_uuid(path).map_err(|e| AppError::VolumeUuid {
        path: path.to_path_buf(),
        source: e,
    })
}

pub fn add(
    config_path: &Path,
    name: &str,
    source: &Path,
    destination: &Path,
    mode: Mode,
) -> Result<(), AppError> {
    if !is_valid_name(name) {
        return Err(AppError::Usage(format!(
            "invalid pair name '{name}': must be lowercase letters, digits, and dashes only"
        )));
    }

    let mut cfg = config::load(config_path)?;
    if cfg.pairs.contains_key(name) {
        return Err(AppError::Usage(format!(
            "pair '{name}' already exists (`pair remove {name}` first to redefine it)"
        )));
    }

    require_existing_dir(source)?;
    require_existing_dir(destination)?;

    let source_volume_uuid = pin_volume_uuid(source)?;
    let destination_volume_uuid = pin_volume_uuid(destination)?;
    let source_mount =
        volume::mount_point_for_path(source).map_err(|e| AppError::Precondition(e.to_string()))?;
    let destination_mount = volume::mount_point_for_path(destination)
        .map_err(|e| AppError::Precondition(e.to_string()))?;
    // `mount_point_for_path` canonicalizes internally (the mount table
    // reports canonical paths, e.g. `/private/var/...` for a `/var/...`
    // symlink) and returns a canonical mount; stripping it from an
    // uncanonicalized `source`/`destination` would not find it as a
    // prefix, so canonicalize the same way here.
    let source_canonical = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());
    let destination_canonical = destination
        .canonicalize()
        .unwrap_or_else(|_| destination.to_path_buf());
    // Cosmetic only: a lookup failure here must never block `pair add`,
    // since the UUID pinned above is the sole identity authority.
    let source_volume_name = volume::volume_name(&source_canonical).ok();
    let destination_volume_name = volume::volume_name(&destination_canonical).ok();

    cfg.pairs.insert(
        name.to_string(),
        Pair {
            source: source.to_path_buf(),
            source_volume_uuid,
            source_volume_name,
            source_volume_relative_path: Some(
                source_canonical
                    .strip_prefix(&source_mount)
                    .expect("mount contains source")
                    .to_path_buf(),
            ),
            destination: destination.to_path_buf(),
            destination_volume_uuid,
            destination_volume_name,
            destination_volume_relative_path: Some(
                destination_canonical
                    .strip_prefix(&destination_mount)
                    .expect("mount contains destination")
                    .to_path_buf(),
            ),
            mode,
        },
    );

    config::save(config_path, &cfg)?;
    Ok(())
}

pub fn remove(config_path: &Path, name: &str) -> Result<(), AppError> {
    let mut cfg = config::load(config_path)?;
    if cfg.pairs.remove(name).is_none() {
        return Err(AppError::Usage(format!("pair '{name}' not found")));
    }
    config::save(config_path, &cfg)?;
    Ok(())
}

#[derive(Serialize)]
struct SideStatusJson {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    at: Option<String>,
    volume: String,
}

#[derive(Serialize)]
struct PairStatusJson {
    source: SideStatusJson,
    destination: SideStatusJson,
}

#[derive(Serialize)]
struct PairJson<'a> {
    name: &'a str,
    source: &'a Path,
    source_volume_uuid: &'a str,
    destination: &'a Path,
    destination_volume_uuid: &'a str,
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<PairStatusJson>,
}

#[derive(Serialize)]
struct PairsListJson<'a> {
    schema: &'a str,
    pairs: Vec<PairJson<'a>>,
}

pub fn list_json(config_path: &Path, check: bool) -> Result<String, AppError> {
    let cfg = config::load(config_path)?;
    let payload = PairsListJson {
        schema: PAIRS_SCHEMA,
        pairs: cfg
            .pairs
            .iter()
            .map(|(name, pair)| PairJson {
                name,
                source: &pair.source,
                source_volume_uuid: &pair.source_volume_uuid,
                destination: &pair.destination,
                destination_volume_uuid: &pair.destination_volume_uuid,
                mode: pair.mode.to_string(),
                status: check.then(|| pair_status_json(pair)),
            })
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&payload).expect("pairs list always serializes"))
}

fn pair_status_json(pair: &Pair) -> PairStatusJson {
    let (source, destination) = preconditions::classify_pair(pair);
    PairStatusJson {
        source: side_status_json(
            &source,
            pair.source_volume_name.as_deref(),
            &pair.source,
            pair.source_volume_relative_path.as_deref(),
        ),
        destination: side_status_json(
            &destination,
            pair.destination_volume_name.as_deref(),
            &pair.destination,
            pair.destination_volume_relative_path.as_deref(),
        ),
    }
}

fn side_status_json(
    state: &VolumeState,
    name: Option<&str>,
    path: &Path,
    relative_path: Option<&Path>,
) -> SideStatusJson {
    let (state_name, at) = state_name_and_location(state);
    SideStatusJson {
        state: state_name,
        at: at.map(|p| p.display().to_string()),
        volume: volume_label(name, path, relative_path),
    }
}

/// The short machine-readable state vocabulary shared by `pair list --check`
/// (JSON `state` field and table `STATUS` column) and the TUI pair
/// selector's per-side tag — one name per `VolumeState`, so the wording
/// never diverges between the two surfaces.
pub(crate) fn state_name_and_location(state: &VolumeState) -> (&'static str, Option<&Path>) {
    match state {
        VolumeState::Ready => ("ready", None),
        VolumeState::Relocated { at } => ("relocated", Some(at.as_path())),
        VolumeState::VolumeAbsent => ("volume_absent", None),
        VolumeState::FolderMissing { at } => ("folder_missing", Some(at.as_path())),
        VolumeState::ForeignVolume { at } => ("foreign_volume", Some(at.as_path())),
        VolumeState::Inaccessible => ("inaccessible", None),
    }
}

pub fn list_table(config_path: &Path, check: bool) -> Result<String, AppError> {
    let cfg = config::load(config_path)?;
    Ok(render_table(&cfg, check))
}

/// Cosmetic label for a Folder pair's side: the recorded volume name if
/// present, else the stored path's mount component (derived from the
/// recorded volume-relative path, no volume I/O), else the stored path
/// itself.
pub(crate) fn volume_label(
    name: Option<&str>,
    path: &Path,
    relative_path: Option<&Path>,
) -> String {
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    let mount_component = relative_path
        .and_then(|relative_path| strip_suffix_components(path, relative_path))
        .and_then(|mount| mount.file_name().map(|n| n.to_string_lossy().into_owned()));
    mount_component.unwrap_or_else(|| path.display().to_string())
}

fn strip_suffix_components(path: &Path, suffix: &Path) -> Option<PathBuf> {
    let suffix_count = suffix.components().count();
    let components: Vec<_> = path.components().collect();
    if suffix_count > components.len() {
        return None;
    }
    Some(
        components[..components.len() - suffix_count]
            .iter()
            .collect(),
    )
}

fn render_table(cfg: &Config, check: bool) -> String {
    if cfg.pairs.is_empty() {
        return "No Folder pairs configured. Add one with `vibesync pair add`.\n".to_string();
    }

    let name_width = cfg.pairs.keys().map(|n| n.len()).max().unwrap_or(4).max(4);
    let mode_width = 6usize; // "mirror" / "update"

    let mut out = String::new();
    out.push_str(&format!(
        "{:<name_width$}  {:<mode_width$}  {:<40}  {}",
        "NAME",
        "MODE",
        "SOURCE",
        "DESTINATION",
        name_width = name_width,
        mode_width = mode_width,
    ));
    if check {
        out.push_str("  STATUS");
    }
    out.push('\n');
    for (name, pair) in &cfg.pairs {
        out.push_str(&format!(
            "{:<name_width$}  {:<mode_width$}  {:<40}  {}",
            name,
            pair.mode.to_string(),
            pair.source.display(),
            pair.destination.display(),
            name_width = name_width,
            mode_width = mode_width,
        ));
        if check {
            let (source_state, destination_state) = preconditions::classify_pair(pair);
            out.push_str(&format!(
                "  source ({}): {}; destination ({}): {}",
                volume_label(
                    pair.source_volume_name.as_deref(),
                    &pair.source,
                    pair.source_volume_relative_path.as_deref()
                ),
                render_state(&source_state),
                volume_label(
                    pair.destination_volume_name.as_deref(),
                    &pair.destination,
                    pair.destination_volume_relative_path.as_deref()
                ),
                render_state(&destination_state),
            ));
        }
        out.push('\n');
    }
    out
}

fn render_state(state: &VolumeState) -> String {
    let (name, at) = state_name_and_location(state);
    match at {
        Some(at) => format!("{name} at {}", at.display()),
        None => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_uppercase_and_symbol_names() {
        assert!(!is_valid_name("Photos"));
        assert!(!is_valid_name("photos_lib"));
        assert!(!is_valid_name(""));
    }

    #[test]
    fn accepts_lowercase_digits_and_dashes() {
        assert!(is_valid_name("photos"));
        assert!(is_valid_name("photos-2024"));
        assert!(is_valid_name("a1-b2"));
    }

    #[test]
    fn empty_config_renders_a_friendly_table() {
        let cfg = Config::default();
        let table = render_table(&cfg, false);
        assert!(table.contains("No Folder pairs configured"));
    }

    #[test]
    fn volume_label_prefers_the_recorded_name() {
        assert_eq!(
            volume_label(Some("Backup"), Path::new("/Volumes/Backup/Photos"), None),
            "Backup"
        );
    }

    #[test]
    fn volume_label_falls_back_to_the_mount_component_when_no_name_is_recorded() {
        assert_eq!(
            volume_label(
                None,
                Path::new("/Volumes/Backup/Photos"),
                Some(Path::new("Photos"))
            ),
            "Backup"
        );
    }

    #[test]
    fn volume_label_falls_back_to_the_stored_path_when_neither_name_nor_relative_path_exist() {
        assert_eq!(
            volume_label(None, Path::new("/Volumes/Backup/Photos"), None),
            "/Volumes/Backup/Photos"
        );
    }

    #[test]
    fn volume_label_ignores_an_empty_recorded_name() {
        assert_eq!(
            volume_label(
                Some(""),
                Path::new("/Volumes/Backup/Photos"),
                Some(Path::new("Photos"))
            ),
            "Backup"
        );
    }
}
