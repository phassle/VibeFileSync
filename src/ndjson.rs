use std::io::{self, Write};

use crate::error::AppError;

pub fn stdout(value: &serde_json::Value) -> Result<(), AppError> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value).map_err(interrupted)?;
    out.write_all(b"\n")
        .and_then(|_| out.flush())
        .map_err(|error| AppError::Interrupted(error.to_string()))
}

fn interrupted(error: serde_json::Error) -> AppError {
    AppError::Interrupted(error.to_string())
}
