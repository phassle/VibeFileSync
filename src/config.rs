//! Config per ADR-0006: a single strict TOML file at
//! `~/.config/vibesync/config.toml` (honoring `$XDG_CONFIG_HOME`). Unknown
//! keys and missing required fields are hard load errors — a typo must
//! abort, never silently default. Rewrites are atomic (temp + rename).

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const CURRENT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Mirror,
    Update,
}

impl fmt::Display for Mode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Mode::Mirror => write!(f, "mirror"),
            Mode::Update => write!(f, "update"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pair {
    pub source: PathBuf,
    pub source_volume_uuid: String,
    #[serde(default)]
    pub source_volume_relative_path: Option<PathBuf>,
    pub destination: PathBuf,
    pub destination_volume_uuid: String,
    #[serde(default)]
    pub destination_volume_relative_path: Option<PathBuf>,
    pub mode: Mode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    #[serde(default)]
    pub pairs: std::collections::BTreeMap<String, Pair>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            version: CURRENT_VERSION,
            pairs: std::collections::BTreeMap::new(),
        }
    }
}

/// An error loading or saving the config file. Every variant renders a
/// message naming the offender (bad key, missing field, path, etc.) since
/// config load failures are precondition aborts (exit 2) that must be
/// actionable without a debugger.
#[derive(Debug)]
pub enum ConfigError {
    Io { path: PathBuf, source: io::Error },
    Parse { path: PathBuf, message: String },
    UnsupportedVersion { path: PathBuf, found: u32 },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Io { path, source } => {
                write!(f, "{}: {}", path.display(), source)
            }
            ConfigError::Parse { path, message } => {
                write!(f, "{}: {}", path.display(), message)
            }
            ConfigError::UnsupportedVersion { path, found } => write!(
                f,
                "{}: unsupported config version {} (expected {})",
                path.display(),
                found,
                CURRENT_VERSION
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Resolves the config file path: `$XDG_CONFIG_HOME/vibesync/config.toml`
/// if `XDG_CONFIG_HOME` is set, else `~/.config/vibesync/config.toml`.
pub fn config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            home.join(".config")
        });
    base.join("vibesync").join("config.toml")
}

/// Loads the config from `path`. A missing file is treated as an empty,
/// version-1 config (nothing configured yet) rather than an error — the
/// first `pair add` creates the file.
pub fn load(path: &Path) -> Result<Config, ConfigError> {
    let contents = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(e) => {
            return Err(ConfigError::Io {
                path: path.to_path_buf(),
                source: e,
            })
        }
    };

    let config: Config = toml::from_str(&contents).map_err(|e| ConfigError::Parse {
        path: path.to_path_buf(),
        message: e.message().to_string(),
    })?;

    if config.version != CURRENT_VERSION {
        return Err(ConfigError::UnsupportedVersion {
            path: path.to_path_buf(),
            found: config.version,
        });
    }

    Ok(config)
}

/// Writes `config` to `path` atomically: a temp file in the same directory
/// is written and fsynced, then renamed into place — the tool's own
/// Publish idiom (ADR-0006 §2), so a crash mid-write never corrupts the
/// existing config.
pub fn save(path: &Path, config: &Config) -> Result<(), ConfigError> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|e| ConfigError::Io {
        path: dir.to_path_buf(),
        source: e,
    })?;

    let contents = toml::to_string_pretty(config).expect("Config always serializes");

    let mut temp = tempfile::Builder::new()
        .prefix(".config.toml.")
        .suffix(".tmp")
        .tempfile_in(dir)
        .map_err(|e| ConfigError::Io {
            path: dir.to_path_buf(),
            source: e,
        })?;

    use std::io::Write;
    temp.write_all(contents.as_bytes())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| ConfigError::Io {
            path: path.to_path_buf(),
            source: e,
        })?;

    temp.persist(path).map_err(|e| ConfigError::Io {
        path: path.to_path_buf(),
        source: e.error,
    })?;

    // Publish idiom (CONTEXT.md: "rename + parent-directory sync"): fsync
    // the directory so the rename itself is durable, not just the file's
    // contents.
    fs::File::open(dir)
        .and_then(|dir_file| dir_file.sync_all())
        .map_err(|e| ConfigError::Io {
            path: dir.to_path_buf(),
            source: e,
        })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn missing_file_loads_as_empty_default_config() {
        let dir = tempdir();
        let path = dir.path().join("config.toml");
        let config = load(&path).expect("missing file is not an error");
        assert_eq!(config.version, CURRENT_VERSION);
        assert!(config.pairs.is_empty());
    }

    #[test]
    fn round_trips_a_pair_through_save_and_load() {
        let dir = tempdir();
        let path = dir.path().join("config.toml");

        let mut config = Config::default();
        config.pairs.insert(
            "photos".to_string(),
            Pair {
                source: PathBuf::from("/Users/per/Photos"),
                source_volume_uuid: "A1B2".to_string(),
                source_volume_relative_path: Some(PathBuf::from("Users/per/Photos")),
                destination: PathBuf::from("/Volumes/Backup/Photos"),
                destination_volume_uuid: "C3D4".to_string(),
                destination_volume_relative_path: Some(PathBuf::from("Photos")),
                mode: Mode::Mirror,
            },
        );

        save(&path, &config).expect("save succeeds");
        let loaded = load(&path).expect("load succeeds");

        assert_eq!(loaded.pairs.len(), 1);
        let pair = &loaded.pairs["photos"];
        assert_eq!(pair.source, PathBuf::from("/Users/per/Photos"));
        assert_eq!(pair.mode, Mode::Mirror);
    }

    #[test]
    fn unknown_top_level_key_is_a_parse_error() {
        let dir = tempdir();
        let path = dir.path().join("config.toml");
        fs::write(&path, "version = 1\nbogus = true\n").unwrap();

        let err = load(&path).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("bogus"),
            "error should name the offending key: {message}"
        );
    }

    #[test]
    fn unknown_pair_key_is_a_parse_error() {
        let dir = tempdir();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"
version = 1

[pairs.photos]
source = "/a"
source_volume_uuid = "u1"
destination = "/b"
destination_volume_uuid = "u2"
mod = "mirror"
"#,
        )
        .unwrap();

        let err = load(&path).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("mod") || message.contains("mode"),
            "error should name the missing/offending field: {message}"
        );
    }

    #[test]
    fn missing_required_field_is_a_parse_error() {
        let dir = tempdir();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"
version = 1

[pairs.photos]
source = "/a"
destination = "/b"
mode = "mirror"
"#,
        )
        .unwrap();

        assert!(load(&path).is_err());
    }

    #[test]
    fn unsupported_version_is_rejected() {
        let dir = tempdir();
        let path = dir.path().join("config.toml");
        fs::write(&path, "version = 2\n").unwrap();

        let err = load(&path).unwrap_err();
        assert!(matches!(err, ConfigError::UnsupportedVersion { .. }));
    }

    #[test]
    fn save_is_atomic_and_does_not_leave_temp_files_on_success() {
        let dir = tempdir();
        let path = dir.path().join("config.toml");
        save(&path, &Config::default()).expect("save succeeds");

        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("config.toml")]);
    }
}
