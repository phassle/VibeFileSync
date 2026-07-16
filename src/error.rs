//! Errors that cross the CLI boundary, each carrying the exit code its
//! class maps to under ADR-0004's exit-code taxonomy (the subset this
//! slice uses: 2 precondition abort, 4 interrupted run, 64 usage, plus
//! 69 for this slice's own "not yet implemented" verbs).

use std::fmt;
use std::path::PathBuf;

use crate::config::ConfigError;

pub const EXIT_OK: i32 = 0;
pub const EXIT_PRECONDITION: i32 = 2;
/// The reviewed plan contains an included error action and cannot run.
pub const EXIT_BLOCKED_PLAN: i32 = 3;
/// A run started but could not complete reliably.
pub const EXIT_INTERRUPTED: i32 = 4;
pub const EXIT_USAGE: i32 = 64;
/// BSD sysexits `EX_UNAVAILABLE`. Used for verbs this slice hasn't
/// implemented yet — deliberately distinct from ADR-0004's exit 1, which
/// is reserved for a completed run with ≥1 failed action.
pub const EXIT_UNIMPLEMENTED: i32 = 69;

#[derive(Debug)]
pub enum AppError {
    /// Config file failed to load/parse — a precondition abort (exit 2):
    /// it must happen before any destination-touching logic runs.
    Config(ConfigError),
    /// Invalid command usage: bad pair name, duplicate/missing pair,
    /// non-existent source/destination path (exit 64).
    Usage(String),
    /// A run/plan precondition failed at invocation time — e.g. a pair's
    /// source directory is gone or unmounted (exit 2, same class as other
    /// pre-mutation aborts under ADR-0002).
    Precondition(String),
    /// A run failed after its durable start record was written (exit 4).
    Interrupted(String),
    /// Reading a volume's UUID failed (exit 2 — same class as other
    /// volume-identity precondition failures, ADR-0002).
    VolumeUuid {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl AppError {
    pub fn exit_code(&self) -> i32 {
        match self {
            AppError::Config(_) => EXIT_PRECONDITION,
            AppError::Usage(_) => EXIT_USAGE,
            AppError::Precondition(_) => EXIT_PRECONDITION,
            AppError::Interrupted(_) => EXIT_INTERRUPTED,
            AppError::VolumeUuid { .. } => EXIT_PRECONDITION,
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Config(e) => write!(f, "config error: {e}"),
            AppError::Usage(message) => write!(f, "{message}"),
            AppError::Precondition(message) => write!(f, "{message}"),
            AppError::Interrupted(message) => write!(f, "{message}"),
            AppError::VolumeUuid { path, source } => {
                write!(
                    f,
                    "could not read volume UUID for {}: {}",
                    path.display(),
                    source
                )
            }
        }
    }
}

impl std::error::Error for AppError {}

impl From<ConfigError> for AppError {
    fn from(e: ConfigError) -> Self {
        AppError::Config(e)
    }
}
