//! Shared constructors for the public run stream and retained Journal event
//! vocabulary. Sinks choose their schema and whether absent optional fields
//! are explicit `null`/empty values.

use std::path::Path;

use serde_json::{json, Value};

use crate::journal::{Operation, RunStats};
use crate::plan::Action;

#[derive(Clone, Copy)]
pub struct Context<'a> {
    pub schema: &'a str,
    pub run_id: &'a str,
}

pub fn run_start(
    context: Context<'_>,
    pair: &str,
    warnings: &[String],
    degradations: &[&str],
) -> Value {
    json!({
        "schema": context.schema, "type": "run_start", "run_id": context.run_id,
        "pair": pair, "warnings": warnings, "degradations": degradations,
    })
}

pub fn action_start(context: Context<'_>, operation: Operation, action: &Action) -> Value {
    json!({
        "schema": context.schema, "type": "action_start", "run_id": context.run_id,
        "op": operation, "path": path_text(&action.rel_path), "bytes": action.bytes,
    })
}

pub fn action_done(
    context: Context<'_>,
    operation: Operation,
    action: &Action,
    safety_net: Option<&Path>,
    warnings: &[String],
    verified: Option<&str>,
    explicit_absence: bool,
) -> Value {
    let warnings: Vec<_> = warnings
        .iter()
        .map(|detail| json!({"code":"metadata_mismatch","detail":detail}))
        .collect();
    let mut row = json!({
        "schema": context.schema, "type": "action_done", "run_id": context.run_id,
        "op": operation, "path": path_text(&action.rel_path), "result": "done",
        "bytes": action.bytes,
    });
    if explicit_absence || verified.is_some() {
        row["verified"] = verified.map_or(Value::Null, |tier| json!(tier));
    }
    if explicit_absence || safety_net.is_some() {
        row["safety_net"] = safety_net.map_or(Value::Null, |path| json!(path_text(path)));
    }
    if explicit_absence || !warnings.is_empty() {
        row["warnings"] = warnings.into();
    }
    row
}

/// Retained `journal/v1` predates the public structured-warning shape. Keep
/// its warning array as plain detail strings under the unchanged schema.
pub fn journal_action_done(
    context: Context<'_>,
    operation: Operation,
    action: &Action,
    safety_net: Option<&Path>,
    warnings: &[String],
    verified: Option<&str>,
) -> Value {
    let mut row = action_done(
        context, operation, action, safety_net, warnings, verified, true,
    );
    row["warnings"] = json!(warnings);
    row
}

pub fn action_failed(
    context: Context<'_>,
    operation: Operation,
    action: &Action,
    reason: &str,
) -> Value {
    json!({
        "schema": context.schema, "type": "action_failed", "run_id": context.run_id,
        "op": operation, "path": path_text(&action.rel_path), "result": "failed",
        "bytes": action.bytes, "reason": crate::failure::normalize(reason), "warnings": [],
    })
}

/// `journal/v1` keeps forensic error text verbatim; only the public run
/// stream maps it to stable agent-facing reason codes.
pub fn journal_action_failed(
    context: Context<'_>,
    operation: Operation,
    action: &Action,
    reason: &str,
) -> Value {
    let mut row = action_failed(context, operation, action, reason);
    row["reason"] = reason.into();
    row
}

pub fn summary(context: Context<'_>, stats: &RunStats) -> Value {
    json!({
        "schema": context.schema, "type": "summary", "run_id": context.run_id,
        "result": if stats.counts.failed == 0 { "success" } else { "partial" },
        "counts": stats.counts, "bytes": stats.bytes, "warnings": stats.warnings,
    })
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn action() -> Action {
        Action {
            rel_path: PathBuf::from("photo.jpg"),
            bytes: 42,
            source_mtime: None,
            old_bytes: None,
            reason: "new".to_string(),
        }
    }

    fn journal_context() -> Context<'static> {
        Context {
            schema: "vibefilesync.journal/v1",
            run_id: "20260801T120000Z",
        }
    }

    #[test]
    fn journal_done_preserves_plain_warning_strings() {
        let row = journal_action_done(
            journal_context(),
            Operation::Copy,
            &action(),
            None,
            &["modified time differs".to_string()],
            Some("standard"),
        );

        assert_eq!(row["warnings"], json!(["modified time differs"]));
    }

    #[test]
    fn journal_failure_preserves_raw_reason_text() {
        let row = journal_action_failed(
            journal_context(),
            Operation::Copy,
            &action(),
            "verify mismatch: size differs",
        );

        assert_eq!(row["reason"], "verify mismatch: size differs");
    }
}
