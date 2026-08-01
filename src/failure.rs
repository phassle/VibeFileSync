use std::fmt;
use std::io;

/// Closed, versioned action-failure vocabulary shared by run/v1 and
/// journal/v1. Human detail stays in the wrapped `io::Error`; machines never
/// infer a reason from that mutable prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    VerifyMismatch,
    SourceChanged,
    DestinationFull,
    ReconciliationChanged,
    DependencyFailed,
    FilesystemError,
}

#[derive(Debug)]
pub struct ActionFailure {
    reason: FailureReason,
    error: io::Error,
}

impl ActionFailure {
    pub fn new(reason: FailureReason, error: io::Error) -> Self {
        Self { reason, error }
    }

    pub fn reason(&self) -> FailureReason {
        self.reason
    }

    pub fn kind(&self) -> io::ErrorKind {
        self.error.kind()
    }
}

impl From<io::Error> for ActionFailure {
    fn from(error: io::Error) -> Self {
        let reason = if error.raw_os_error() == Some(libc::ENOSPC) {
            FailureReason::DestinationFull
        } else {
            FailureReason::FilesystemError
        };
        Self { reason, error }
    }
}

impl fmt::Display for ActionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for ActionFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}
