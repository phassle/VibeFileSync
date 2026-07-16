//! Folder pair management: `pair add | list | remove`. Per ADR-0006, the
//! Pair name is the identity (a slug: lowercase letters, digits, dashes,
//! unique) and `pair add` is the only writer that pins volume UUIDs.

use std::path::Path;

use serde::Serialize;

use crate::config::{self, Config, Mode, Pair};
use crate::error::AppError;
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

    cfg.pairs.insert(
        name.to_string(),
        Pair {
            source: source.to_path_buf(),
            source_volume_uuid,
            source_volume_relative_path: Some(
                source
                    .strip_prefix(&source_mount)
                    .expect("mount contains source")
                    .to_path_buf(),
            ),
            destination: destination.to_path_buf(),
            destination_volume_uuid,
            destination_volume_relative_path: Some(
                destination
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
struct PairJson<'a> {
    name: &'a str,
    source: &'a Path,
    source_volume_uuid: &'a str,
    destination: &'a Path,
    destination_volume_uuid: &'a str,
    mode: String,
}

#[derive(Serialize)]
struct PairsListJson<'a> {
    schema: &'a str,
    pairs: Vec<PairJson<'a>>,
}

pub fn list_json(config_path: &Path) -> Result<String, AppError> {
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
            })
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&payload).expect("pairs list always serializes"))
}

pub fn list_table(config_path: &Path) -> Result<String, AppError> {
    let cfg = config::load(config_path)?;
    Ok(render_table(&cfg))
}

fn render_table(cfg: &Config) -> String {
    if cfg.pairs.is_empty() {
        return "No Folder pairs configured. Add one with `vibesync pair add`.\n".to_string();
    }

    let name_width = cfg.pairs.keys().map(|n| n.len()).max().unwrap_or(4).max(4);
    let mode_width = 6usize; // "mirror" / "update"

    let mut out = String::new();
    out.push_str(&format!(
        "{:<name_width$}  {:<mode_width$}  {:<40}  {}\n",
        "NAME",
        "MODE",
        "SOURCE",
        "DESTINATION",
        name_width = name_width,
        mode_width = mode_width,
    ));
    for (name, pair) in &cfg.pairs {
        out.push_str(&format!(
            "{:<name_width$}  {:<mode_width$}  {:<40}  {}\n",
            name,
            pair.mode.to_string(),
            pair.source.display(),
            pair.destination.display(),
            name_width = name_width,
            mode_width = mode_width,
        ));
    }
    out
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
        let table = render_table(&cfg);
        assert!(table.contains("No Folder pairs configured"));
    }
}
