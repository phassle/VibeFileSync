//! Owns the "a destination directory/file is in the way of a copy, so it
//! must be archived once before that copy Publishes" rule end to end:
//! classifying it from a [`Plan`], the one-shot archive ordering invariant
//! (ADR-0001, ADR-0008), and the review-subset derivation the TUI needs.
//!
//! [`StructuralConflict`] itself stays in `plan` as the data type each
//! [`Action`] carries; this module owns the rule that consumes it.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::plan::{Action, Plan, StructuralConflict};

impl StructuralConflict {
    pub(crate) fn has_dependent_copy(self, deletion: &Path, copy: &Path) -> bool {
        match self {
            Self::DestinationDirectory => copy == deletion,
            Self::DestinationFile => copy.starts_with(deletion),
        }
    }
}

fn structural_dependency_satisfied(deletion: &Action, copies: &[Action]) -> bool {
    match deletion.structural_conflict {
        Some(conflict) => copies
            .iter()
            .any(|copy| conflict.has_dependent_copy(&deletion.rel_path, &copy.rel_path)),
        None => true,
    }
}

/// A structural delete exists only to unblock a reviewed Publish. If review
/// filtering or reconciliation removes every dependent COPY, the delete must
/// disappear too so destination content is never archived on its own.
pub(crate) fn drop_orphan_structural_deletions(plan: &mut Plan) -> usize {
    let before = plan.deletes.len();
    plan.deletes
        .retain(|deletion| structural_dependency_satisfied(deletion, &plan.copies));
    let removed = before - plan.deletes.len();
    plan.excluded += removed;
    removed
}

/// The structural-delete/dependent-conflict pairs a [`Plan`] carries, plus
/// the one-shot archive-before-publish ordering invariant for each: a
/// structural delete may have several dependent copies (e.g. multiple files
/// under a replaced directory), but its archive starts and completes exactly
/// once regardless of how many of those copies trigger the check.
#[derive(Debug, Default)]
pub(crate) struct ConflictSet {
    conflicts: Vec<(PathBuf, StructuralConflict)>,
    started: BTreeSet<PathBuf>,
    completed: BTreeSet<PathBuf>,
}

impl ConflictSet {
    /// Classifies every structural-delete/conflict pair carried by `plan`.
    /// Pure and total: no I/O, no started/completed state yet.
    pub(crate) fn classify(plan: &Plan) -> Self {
        let conflicts = plan
            .deletes
            .iter()
            .filter_map(|deletion| {
                deletion
                    .structural_conflict
                    .map(|conflict| (deletion.rel_path.clone(), conflict))
            })
            .collect();
        Self {
            conflicts,
            started: BTreeSet::new(),
            completed: BTreeSet::new(),
        }
    }

    /// The structural delete `copy_path` depends on, if any and not already
    /// completed. Used by the run engine to decide whether a copy/update
    /// action needs to archive a structural delete before it can Publish.
    pub(crate) fn find_structural_delete_for<'a>(
        &self,
        plan: &'a Plan,
        copy_path: &Path,
    ) -> Option<&'a Action> {
        let deletion_path = self
            .conflicts
            .iter()
            .find(|(deletion_path, conflict)| {
                !self.completed.contains(deletion_path)
                    && conflict.has_dependent_copy(deletion_path, copy_path)
            })
            .map(|(deletion_path, _)| deletion_path)?;
        plan.deletes
            .iter()
            .find(|deletion| deletion.rel_path == *deletion_path)
    }

    /// Records that this structural delete lifecycle has started. Returns
    /// `true` the first time, so the caller fires `action_start` exactly
    /// once per structural delete no matter how many dependent copies
    /// reach this point.
    pub(crate) fn begin_structural_delete(&mut self, deletion: &Action) -> bool {
        self.started.insert(deletion.rel_path.clone())
    }

    /// Records that this structural delete's archive completed.
    pub(crate) fn complete_structural_delete(&mut self, deletion: &Action) {
        self.completed.insert(deletion.rel_path.clone());
    }

    /// Structural deletes whose lifecycle started but never completed — their
    /// dependent copy failed its publish gate before the archive finished.
    pub(crate) fn drain_incomplete<'a>(&self, plan: &'a Plan) -> Vec<&'a Action> {
        plan.deletes
            .iter()
            .filter(|deletion| {
                self.started.contains(&deletion.rel_path)
                    && !self.completed.contains(&deletion.rel_path)
            })
            .collect()
    }
}

/// Review-subset query: of the structurally-conflicting `rows` (each a
/// review row's path and its [`StructuralConflict`]), which should stay
/// included given the currently-included copy paths? Used by the TUI so a
/// structural delete tracks the inclusion of the copy it depends on,
/// without the TUI holding any diff logic of its own (ADR-0010).
///
/// Returns owned paths rather than borrowing `rows` so a caller iterating
/// its own row storage to build `rows` can still mutate that storage with
/// the result in hand.
pub(crate) fn included_structural_deletes(
    rows: impl Iterator<Item = (String, StructuralConflict)>,
    included_copies: &[String],
) -> Vec<String> {
    rows.filter(|(path, conflict)| {
        included_copies
            .iter()
            .any(|copy| conflict.has_dependent_copy(Path::new(path), Path::new(copy)))
    })
    .map(|(path, _)| path)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::Plan;
    use std::time::SystemTime;

    fn action(path: &str, conflict: Option<StructuralConflict>) -> Action {
        Action {
            rel_path: PathBuf::from(path),
            bytes: 10,
            source_mtime: Some(SystemTime::UNIX_EPOCH),
            old_bytes: Some(10),
            reason: "test".to_string(),
            structural_conflict: conflict,
        }
    }

    #[test]
    fn classifier_finds_the_structural_delete_a_copy_depends_on() {
        let plan = Plan {
            copies: vec![action("report.txt", None)],
            deletes: vec![action(
                "report.txt",
                Some(StructuralConflict::DestinationDirectory),
            )],
            ..Plan::default()
        };
        let conflicts = ConflictSet::classify(&plan);

        let found = conflicts.find_structural_delete_for(&plan, Path::new("report.txt"));
        assert_eq!(
            found.map(|a| &a.rel_path),
            Some(&PathBuf::from("report.txt"))
        );
    }

    #[test]
    fn classifier_finds_a_destination_file_conflict_via_a_descendant_copy() {
        let plan = Plan {
            copies: vec![action("docs/new.txt", None)],
            deletes: vec![action("docs", Some(StructuralConflict::DestinationFile))],
            ..Plan::default()
        };
        let conflicts = ConflictSet::classify(&plan);

        let found = conflicts.find_structural_delete_for(&plan, Path::new("docs/new.txt"));
        assert_eq!(found.map(|a| &a.rel_path), Some(&PathBuf::from("docs")));
    }

    #[test]
    fn classifier_reports_no_delete_for_an_unrelated_copy() {
        let plan = Plan {
            copies: vec![action("unrelated.txt", None)],
            deletes: vec![action(
                "report.txt",
                Some(StructuralConflict::DestinationDirectory),
            )],
            ..Plan::default()
        };
        let conflicts = ConflictSet::classify(&plan);

        assert!(conflicts
            .find_structural_delete_for(&plan, Path::new("unrelated.txt"))
            .is_none());
    }

    #[test]
    fn one_shot_invariant_fires_start_and_done_exactly_once_across_multiple_copies() {
        let plan = Plan {
            copies: vec![action("docs/a.txt", None), action("docs/b.txt", None)],
            deletes: vec![action("docs", Some(StructuralConflict::DestinationFile))],
            ..Plan::default()
        };
        let mut conflicts = ConflictSet::classify(&plan);

        let mut starts = 0;
        let mut dones = 0;
        // The first dependent copy's verification triggers the archive; once
        // it completes, later dependent copies find no outstanding delete to
        // pair with — the same "at most one action_start/action_done per
        // structural delete" outcome the run engine relied on before the move.
        let first_copy = &plan.copies[0];
        let deletion = conflicts
            .find_structural_delete_for(&plan, &first_copy.rel_path)
            .expect("the first copy depends on the structural delete");
        if conflicts.begin_structural_delete(deletion) {
            starts += 1;
        }
        conflicts.complete_structural_delete(deletion);
        dones += 1;

        let second_copy = &plan.copies[1];
        assert!(
            conflicts
                .find_structural_delete_for(&plan, &second_copy.rel_path)
                .is_none(),
            "a second dependent copy finds no outstanding delete once it has archived"
        );

        assert_eq!(starts, 1, "action_start fires exactly once");
        assert_eq!(dones, 1, "action_done fires exactly once");
        assert!(conflicts.drain_incomplete(&plan).is_empty());
    }

    #[test]
    fn one_shot_invariant_is_order_independent() {
        let plan = Plan {
            deletes: vec![action("docs", Some(StructuralConflict::DestinationFile))],
            ..Plan::default()
        };
        let deletion = &plan.deletes[0];
        let mut conflicts = ConflictSet::classify(&plan);

        // "copy verified" then "archived", scripted in either order across
        // repeated calls, must never re-fire either transition.
        assert!(conflicts.begin_structural_delete(deletion));
        assert!(!conflicts.begin_structural_delete(deletion));
        conflicts.complete_structural_delete(deletion);
        conflicts.complete_structural_delete(deletion);
        assert!(conflicts.drain_incomplete(&plan).is_empty());
    }

    #[test]
    fn drain_incomplete_reports_a_started_but_never_completed_delete() {
        let plan = Plan {
            deletes: vec![action(
                "report.txt",
                Some(StructuralConflict::DestinationDirectory),
            )],
            ..Plan::default()
        };
        let deletion = &plan.deletes[0];
        let mut conflicts = ConflictSet::classify(&plan);
        conflicts.begin_structural_delete(deletion);

        let incomplete = conflicts.drain_incomplete(&plan);
        assert_eq!(incomplete.len(), 1);
        assert_eq!(incomplete[0].rel_path, PathBuf::from("report.txt"));
    }

    fn rows() -> Vec<(String, StructuralConflict)> {
        vec![
            (
                "report.txt".to_string(),
                StructuralConflict::DestinationDirectory,
            ),
            ("docs".to_string(), StructuralConflict::DestinationFile),
        ]
    }

    #[test]
    fn review_subset_keeps_a_structural_delete_only_while_its_copy_stays_included() {
        let included_copies = vec!["report.txt".to_string()];
        let kept = included_structural_deletes(rows().into_iter(), &included_copies);
        assert_eq!(kept, vec!["report.txt".to_string()]);

        let no_copies: Vec<String> = vec![];
        let kept = included_structural_deletes(rows().into_iter(), &no_copies);
        assert!(kept.is_empty());
    }

    #[test]
    fn review_subset_matches_a_destination_file_conflict_via_a_descendant_copy() {
        let rows = vec![("docs".to_string(), StructuralConflict::DestinationFile)];
        let included_copies = vec!["docs/new.txt".to_string()];

        let kept = included_structural_deletes(rows.into_iter(), &included_copies);
        assert_eq!(kept, vec!["docs".to_string()]);
    }
}
