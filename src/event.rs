//! Shared constructors for the public run stream and retained Journal event
//! vocabulary. Sinks choose their schema and whether absent optional fields
//! are explicit `null`/empty values.

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use crate::failure::FailureReason;
use crate::journal::{Operation, RunStats};
use crate::plan::{Action, Plan};

#[derive(Clone, Copy)]
pub struct Context<'a> {
    pub schema: &'a str,
    pub run_id: &'a str,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationTier {
    Standard,
    Full,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataWarningCode {
    MetadataMismatch,
}

#[derive(Serialize)]
pub struct MetadataWarning {
    code: MetadataWarningCode,
    detail: String,
}

impl MetadataWarning {
    pub fn mismatch(detail: impl Into<String>) -> Self {
        Self {
            code: MetadataWarningCode::MetadataMismatch,
            detail: detail.into(),
        }
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }
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

pub fn planned_actions(plan: &Plan) -> Vec<Value> {
    let planned = |operation: Operation, action: &Action| {
        json!({
            "op": operation,
            "path": path_text(&action.rel_path),
            "bytes": action.bytes,
        })
    };
    let mut actions = Vec::new();
    actions.extend(
        plan.copies
            .iter()
            .map(|action| planned(Operation::Copy, action)),
    );
    actions.extend(
        plan.updates
            .iter()
            .map(|action| planned(Operation::Update, action)),
    );
    actions.extend(
        plan.deletes
            .iter()
            .map(|action| planned(Operation::Delete, action)),
    );
    actions.extend(plan.strays.iter().map(|stray| {
        planned(
            Operation::Cleanup,
            &Action {
                rel_path: stray.clone(),
                bytes: 0,
                source_mtime: None,
                old_bytes: None,
                reason: "abandoned temp".to_string(),
                structural_conflict: None,
            },
        )
    }));
    actions
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
    warnings: &[MetadataWarning],
    verified: Option<VerificationTier>,
    explicit_absence: bool,
) -> Value {
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
        row["warnings"] = json!(warnings);
    }
    row
}

pub fn action_failed(
    context: Context<'_>,
    operation: Operation,
    action: &Action,
    reason: FailureReason,
) -> Value {
    json!({
        "schema": context.schema, "type": "action_failed", "run_id": context.run_id,
        "op": operation, "path": path_text(&action.rel_path), "result": "failed",
        "bytes": action.bytes, "reason": reason, "warnings": [],
    })
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
            structural_conflict: None,
        }
    }

    fn journal_context() -> Context<'static> {
        Context {
            schema: "vibefilesync.journal/v1",
            run_id: "20260801T120000Z",
        }
    }

    #[test]
    fn journal_done_uses_structured_warning_vocabulary() {
        let row = action_done(
            journal_context(),
            Operation::Copy,
            &action(),
            None,
            &[MetadataWarning::mismatch("modified time differs")],
            Some(VerificationTier::Standard),
            true,
        );

        assert_eq!(
            row["warnings"],
            json!([{"code":"metadata_mismatch","detail":"modified time differs"}])
        );
    }

    #[test]
    fn journal_failure_uses_typed_reason_codes() {
        let mismatch = action_failed(
            journal_context(),
            Operation::Copy,
            &action(),
            FailureReason::VerifyMismatch,
        );
        let source_changed = action_failed(
            journal_context(),
            Operation::Copy,
            &action(),
            FailureReason::SourceChanged,
        );

        assert_eq!(mismatch["reason"], "verify_mismatch");
        assert_eq!(source_changed["reason"], "source_changed");
    }
}
