//! Golden-capture harness pinning exactly what a Dry-run produces today, so
//! every later ticket in Feature #67 can prove it changed nothing a user or
//! an agent can observe. Both surfaces of ADR-0003 are pinned: the grouped
//! human diff (§1) and the `vibefilesync.plan/v1` NDJSON stream (§2).
//!
//! Captures live as files under `tests/captures/`, never as string literals
//! in this file: a regression is reported as the first differing row and
//! field, so diagnosing one never means reading a whole expected output back
//! into context.
//!
//! # Regenerating captures
//!
//! Captures are never hand-edited. One command rewrites every one of them
//! (the `fault-injection` feature is required so the exFAT-destination
//! scenarios can force their "cannot store a symlink" error deterministically):
//!
//! ```text
//! REGEN_CAPTURES=1 cargo test --test plan_captures --features fault-injection
//! ```
//!
//! Review the resulting diff under `tests/captures/` before committing: an
//! intended change shows up there as a reviewable delta, an unintended one as
//! a surprise.

use assert_cmd::Command;
use std::fs;
use std::path::{Path, PathBuf};

const EXIT_OK: i32 = 0;

fn captures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/captures")
}

/// Regeneration mode: write the captures instead of asserting against them.
fn regenerating() -> bool {
    std::env::var_os("REGEN_CAPTURES").is_some()
}

/// One isolated Folder pair over real temp trees — the `tests/cli.rs::Fixture`
/// idiom, narrowed to what the capture scenarios need. Each pair is named
/// `sync` so the pair name never leaks a scenario detail into a capture.
struct Pair {
    xdg: tempfile::TempDir,
    home: tempfile::TempDir,
    source: tempfile::TempDir,
    destination: tempfile::TempDir,
}

impl Pair {
    fn new(mode: &str) -> Self {
        let pair = Pair {
            xdg: tempfile::tempdir().expect("xdg tempdir"),
            home: tempfile::tempdir().expect("home tempdir"),
            source: tempfile::tempdir().expect("source tempdir"),
            destination: tempfile::tempdir().expect("destination tempdir"),
        };
        pair.cmd()
            .args([
                "pair",
                "add",
                "sync",
                "--source",
                pair.source.path().to_str().unwrap(),
                "--destination",
                pair.destination.path().to_str().unwrap(),
                "--mode",
                mode,
            ])
            .assert()
            .success();
        pair
    }

    fn cmd(&self) -> Command {
        let mut cmd = Command::cargo_bin("vibesync").expect("binary builds");
        cmd.env("XDG_CONFIG_HOME", self.xdg.path());
        cmd.env("HOME", self.home.path());
        cmd
    }

    fn write(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn source_file(&self, rel: &str, contents: &str) {
        Self::write(self.source.path(), rel, contents);
    }

    fn dest_file(&self, rel: &str, contents: &str) {
        Self::write(self.destination.path(), rel, contents);
    }

    fn source_dir(&self, rel: &str) {
        fs::create_dir_all(self.source.path().join(rel)).unwrap();
    }

    fn dest_dir(&self, rel: &str) {
        fs::create_dir_all(self.destination.path().join(rel)).unwrap();
    }

    /// An identical file on both sides. A hard link shares the inode, so size
    /// and mtime match exactly — the only way to force an "unchanged" outcome
    /// under APFS's zero mtime tolerance.
    fn unchanged_file(&self, rel: &str, contents: &str) {
        self.source_file(rel, contents);
        fs::hard_link(
            self.source.path().join(rel),
            self.destination.path().join(rel),
        )
        .unwrap();
    }

    fn source_symlink(&self, rel: &str, target: &str) {
        std::os::unix::fs::symlink(target, self.source.path().join(rel)).unwrap();
    }

    /// The four temp-dir prefixes that would otherwise stamp an absolute,
    /// per-run path into a capture. Replaced with stable tokens before any
    /// capture is written or compared.
    fn path_tokens(&self) -> [(String, &'static str); 4] {
        [
            (self.source.path().to_string_lossy().into_owned(), "<SRC>"),
            (
                self.destination.path().to_string_lossy().into_owned(),
                "<DST>",
            ),
            (self.home.path().to_string_lossy().into_owned(), "<HOME>"),
            (self.xdg.path().to_string_lossy().into_owned(), "<XDG>"),
        ]
    }
}

/// Populate a pair with every Folder-pair state the ticket enumerates, in one
/// tree shared by both Sync modes. The classification each state produces
/// differs by mode (Mirror deletes destination-only paths, Update leaves
/// them) — that divergence is exactly what the per-mode captures pin.
fn build_full_tree(pair: &Pair) {
    // New file, changed file, unchanged file.
    pair.source_file("new.txt", "brand new contents\n");
    pair.source_file("changed.txt", "the source is longer now\n");
    pair.dest_file("changed.txt", "old\n");
    pair.unchanged_file("unchanged.txt", "identical on both sides\n");

    // Destination-only file and directory (Mirror deletes, Update ignores).
    pair.dest_file("destination-only.txt", "only at the destination\n");
    pair.dest_dir("destination-only-dir");

    // New directory (source-only, empty).
    pair.source_dir("new-dir");

    // A destination directory replaced by a source file, and a destination
    // file replaced by a source directory.
    pair.source_file("dir-to-file", "was a directory\n");
    pair.dest_file("dir-to-file/inner.txt", "inner\n");
    pair.source_file("file-to-dir/inner.txt", "inner\n");
    pair.dest_file("file-to-dir", "was a file\n");

    // A symlink. On APFS it is copied; the exFAT scenarios pin the error.
    pair.source_symlink("link", "some-target");

    // SafetyNet trees, Publish temps and Run locks at BOTH ends, so machinery
    // exclusion is pinned on both surfaces.
    pair.source_file("_SafetyNet/20200101T000000Z/archived.txt", "archived\n");
    pair.dest_file("_SafetyNet/20200102T000000Z/archived.txt", "archived\n");
    pair.source_file(".new.txt.vibesync-tmp-src01", "half written\n");
    pair.dest_file(".other.txt.vibesync-tmp-dst01", "half written\n");
    pair.source_file("._vibesync-run-20200101T000000Z", "lock\n");
    pair.dest_file("._vibesync-run-20200102T000000Z", "lock\n");
}

/// Normalise the volatile fields ADR-0003's surfaces carry so a capture is a
/// function of behaviour alone: absolute temp paths become tokens, and the
/// `plan_id` (minted from `SystemTime::now`) becomes a placeholder. NDJSON is
/// re-serialised through `serde_json`, which also canonicalises key order.
fn normalize(raw: &[u8], pair: &Pair, ndjson: bool) -> String {
    let mut text = String::from_utf8_lossy(raw).into_owned();
    for (needle, token) in pair.path_tokens() {
        text = text.replace(&needle, token);
    }
    if !ndjson {
        return text;
    }
    text.lines()
        .map(|line| {
            let mut value: serde_json::Value =
                serde_json::from_str(line).expect("each NDJSON row is JSON");
            if value.get("plan_id").is_some() {
                value["plan_id"] = serde_json::Value::String("<plan-id>".into());
            }
            value.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// Assert `actual` matches the stored capture, or write it in regen mode. A
/// mismatch names the first differing row and — for NDJSON — the first
/// differing field, never dumping both whole outputs.
fn check_capture(relative: &str, actual: &str) {
    let path = captures_root().join(relative);
    if regenerating() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, actual).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "missing capture `{relative}`; regenerate with:\n  \
             REGEN_CAPTURES=1 cargo test --test plan_captures --features fault-injection"
        )
    });
    if expected != actual {
        panic!("{}", locate_mismatch(relative, &expected, actual));
    }
}

/// Report the first row where two captures diverge. For an NDJSON capture the
/// row is parsed and the first differing JSON field is named; otherwise the
/// differing line is shown whole.
fn locate_mismatch(relative: &str, expected: &str, actual: &str) -> String {
    let ndjson = relative.ends_with(".ndjson");
    let expected_rows: Vec<&str> = expected.lines().collect();
    let actual_rows: Vec<&str> = actual.lines().collect();
    let hint = "regenerate intentionally with:\n  \
         REGEN_CAPTURES=1 cargo test --test plan_captures --features fault-injection";

    for row in 0..expected_rows.len().max(actual_rows.len()) {
        let expected_row = expected_rows.get(row).copied();
        let actual_row = actual_rows.get(row).copied();
        if expected_row == actual_row {
            continue;
        }
        let where_ = format!("capture `{relative}` differs at row {}", row + 1);
        return match (expected_row, actual_row) {
            (Some(e), Some(a)) if ndjson => {
                let field = first_differing_field(e, a);
                format!("{where_}, field {field}\n{hint}")
            }
            (Some(e), Some(a)) => {
                format!("{where_}:\n  expected: {e}\n  actual:   {a}\n{hint}")
            }
            (Some(e), None) => {
                format!("{where_}: expected row present, actual missing\n  expected: {e}\n{hint}")
            }
            (None, Some(a)) => format!("{where_}: unexpected extra row\n  actual: {a}\n{hint}"),
            (None, None) => unreachable!(),
        };
    }
    format!("capture `{relative}` differs\n{hint}")
}

/// Name the first JSON field that differs between two NDJSON rows, with the
/// expected and actual values for just that field.
fn first_differing_field(expected: &str, actual: &str) -> String {
    let expected: serde_json::Value = serde_json::from_str(expected).expect("expected row is JSON");
    let actual: serde_json::Value = serde_json::from_str(actual).expect("actual row is JSON");
    let empty = serde_json::Map::new();
    let expected_obj = expected.as_object().unwrap_or(&empty);
    let actual_obj = actual.as_object().unwrap_or(&empty);
    let mut keys: Vec<&String> = expected_obj.keys().chain(actual_obj.keys()).collect();
    keys.sort_unstable();
    keys.dedup();
    for key in keys {
        let e = expected_obj.get(key);
        let a = actual_obj.get(key);
        if e != a {
            let e = e
                .map(|v| v.to_string())
                .unwrap_or_else(|| "<absent>".into());
            let a = a
                .map(|v| v.to_string())
                .unwrap_or_else(|| "<absent>".into());
            return format!("`{key}`: expected {e}, actual {a}");
        }
    }
    "(rows differ only in whitespace)".into()
}

/// Capture both Dry-run surfaces of the full-tree pair for one Sync mode.
fn capture_full_plan(mode: &str) {
    let pair = Pair::new(mode);
    build_full_tree(&pair);

    let human = pair.cmd().args(["plan", "sync"]).output().unwrap();
    assert_eq!(human.status.code(), Some(EXIT_OK));
    assert!(human.stderr.is_empty(), "human plan must not log");
    let human = normalize(&human.stdout, &pair, false);
    assert_machinery_excluded(mode, "plan.human.txt", &human);
    check_capture(&format!("{mode}/plan.human.txt"), &human);

    let json = pair
        .cmd()
        .args(["plan", "sync", "--json"])
        .output()
        .unwrap();
    assert_eq!(json.status.code(), Some(EXIT_OK));
    assert!(json.stderr.is_empty(), "JSON plan must not log");
    let json = normalize(&json.stdout, &pair, true);
    assert_machinery_excluded(mode, "plan.ndjson", &json);
    check_capture(&format!("{mode}/plan.ndjson"), &json);
}

/// A first-class pin that machinery is invisible on both surfaces, not left
/// implicit in the golden bytes. Every SafetyNet run folder, run lock, and
/// source-side Publish temp `build_full_tree` plants at both ends must be
/// absent from a Dry-run surface — only the destination stray temp surfaces,
/// as a cleanup row. Catches a regression that leaked machinery with a
/// message naming the leak, ahead of the whole-capture diff.
fn assert_machinery_excluded(mode: &str, surface: &str, output: &str) {
    for marker in [
        "20200101T000000Z",            // SafetyNet run folder / source run lock stamp
        "20200102T000000Z",            // SafetyNet run folder / destination run lock stamp
        "archived.txt",                // SafetyNet tree contents at either end
        ".new.txt.vibesync-tmp-src01", // source-side Publish temp
        "._vibesync-run",              // Run locks at either end
    ] {
        assert!(
            !output.contains(marker),
            "machinery `{marker}` leaked into {mode}/{surface}:\n{output}"
        );
    }
}

#[test]
fn mirror_dry_run_surfaces_are_pinned() {
    capture_full_plan("mirror");
}

#[test]
fn update_dry_run_surfaces_are_pinned() {
    capture_full_plan("update");
}

/// Capture the human Dry-run review a `run` prints before its confirmation
/// prompt — the only Dry-run surface that accepts `--exclude` (a `run` flag,
/// ADR-0004). Answering `n` leaves the destination untouched, so this stays a
/// Dry-run. Both an excluded action path and an exclude matching nothing are
/// exercised: the render's `excluded` count pins the first, and the
/// unknown-exclude notice on stderr pins the second.
///
/// There is deliberately no NDJSON counterpart: `plan --json` takes no
/// `--exclude`, and a cancelled `run --json` emits nothing, so the NDJSON
/// Dry-run surface structurally cannot express an exclusion. Pinning it on
/// the human review is the faithful capture of what a Dry-run can observe.
fn capture_exclude_review(mode: &str) {
    let pair = Pair::new(mode);
    pair.source_file("keep.txt", "kept\n");
    pair.source_file("drop.txt", "excluded\n");

    let output = pair
        .cmd()
        .args([
            "run",
            "sync",
            "--ignore-space-check",
            "--exclude",
            "drop.txt",
            "--exclude",
            "matches-nothing.txt",
        ])
        .write_stdin("n\n")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));

    check_capture(
        &format!("{mode}-exclude/review.human.txt"),
        &normalize(&output.stdout, &pair, false),
    );

    // Keep only the unknown-exclude notice; the free-space preflight warning
    // on stderr is a Run concern, not part of the Dry-run diff contract.
    let stderr = normalize(&output.stderr, &pair, false);
    let notice: String = stderr
        .lines()
        .filter(|line| line.contains("exclude path not found in plan"))
        .map(|line| format!("{line}\n"))
        .collect();
    check_capture(&format!("{mode}-exclude/review.stderr.txt"), &notice);
}

#[test]
fn mirror_exclude_review_is_pinned() {
    capture_exclude_review("mirror");
}

#[test]
fn update_exclude_review_is_pinned() {
    capture_exclude_review("update");
}

/// A symlink bound for a destination that cannot store it (exFAT) is a
/// per-file plan error, not a copy. Forcing that outcome deterministically
/// needs the `fault-injection` filesystem-type override, so these captures
/// only run — and only regenerate — under that feature.
#[cfg(feature = "fault-injection")]
fn capture_symlink_error(mode: &str) {
    let pair = Pair::new(mode);
    pair.source_file("safe.txt", "safe\n");
    pair.source_symlink("link", "some-target");

    let human = pair
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .args(["plan", "sync"])
        .output()
        .unwrap();
    assert_eq!(human.status.code(), Some(EXIT_OK));
    check_capture(
        &format!("{mode}-exfat/plan.human.txt"),
        &normalize(&human.stdout, &pair, false),
    );

    let json = pair
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .args(["plan", "sync", "--json"])
        .output()
        .unwrap();
    assert_eq!(json.status.code(), Some(EXIT_OK));
    check_capture(
        &format!("{mode}-exfat/plan.ndjson"),
        &normalize(&json.stdout, &pair, true),
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn mirror_symlink_to_unsupported_destination_is_pinned() {
    capture_symlink_error("mirror");
}

#[cfg(feature = "fault-injection")]
#[test]
fn update_symlink_to_unsupported_destination_is_pinned() {
    capture_symlink_error("update");
}
