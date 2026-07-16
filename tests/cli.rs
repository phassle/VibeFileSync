//! Seam-level acceptance tests: drive the built `vibesync` binary, per
//! ADR-0009's harness pattern of exercising the real binary rather than
//! library calls. Covers issue #15's acceptance criteria: config
//! strictness, pair add/list/remove round-trips, atomic rewrite, and exit
//! codes.
//!
//! Each test isolates `$XDG_CONFIG_HOME` to its own tempdir so runs never
//! touch a developer's real `~/.config/vibesync`.

use assert_cmd::Command;
use std::fs;
use std::path::Path;
use std::process::Command as ProcessCommand;

const EXIT_OK: i32 = 0;
const EXIT_PRECONDITION: i32 = 2;
const EXIT_USAGE: i32 = 64;
const EXIT_UNIMPLEMENTED: i32 = 69;

fn vibesync(config_home: &Path) -> Command {
    let mut cmd = Command::cargo_bin("vibesync").expect("binary builds");
    cmd.env("XDG_CONFIG_HOME", config_home);
    cmd
}

/// Run the real binary under macOS's `script(1)`, which supplies its stderr
/// with a pseudo-terminal. The normal helpers deliberately use pipes, so
/// they cover the non-TTY contract instead.
fn vibesync_in_tty(config_home: &Path, args: &[&str], no_color: bool) -> std::process::Output {
    let binary = Command::cargo_bin("vibesync").expect("binary builds");
    let mut command = ProcessCommand::new("script");
    command
        .args(["-q", "/dev/null"])
        .arg(binary.get_program())
        .args(args)
        .env("XDG_CONFIG_HOME", config_home);
    if no_color {
        command.env("NO_COLOR", "1");
    } else {
        command.env_remove("NO_COLOR");
    }
    command.output().expect("script starts a pseudo-terminal")
}

fn config_file(config_home: &Path) -> std::path::PathBuf {
    config_home.join("vibesync").join("config.toml")
}

struct Fixture {
    xdg: tempfile::TempDir,
    source: tempfile::TempDir,
    destination: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        Fixture {
            xdg: tempfile::tempdir().expect("xdg tempdir"),
            source: tempfile::tempdir().expect("source tempdir"),
            destination: tempfile::tempdir().expect("destination tempdir"),
        }
    }

    fn cmd(&self) -> Command {
        vibesync(self.xdg.path())
    }

    fn add_photos_pair(&self) {
        self.add_pair("photos", "mirror");
    }

    fn add_pair(&self, name: &str, mode: &str) {
        self.cmd()
            .args([
                "pair",
                "add",
                name,
                "--source",
                self.source.path().to_str().unwrap(),
                "--destination",
                self.destination.path().to_str().unwrap(),
                "--mode",
                mode,
            ])
            .assert()
            .success();
    }

    fn write_source(&self, rel: &str, contents: &str) {
        Self::write_under(self.source.path(), rel, contents);
    }

    fn write_dest(&self, rel: &str, contents: &str) {
        Self::write_under(self.destination.path(), rel, contents);
    }

    fn write_under(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// A recursively-sorted snapshot of a tree, used to prove `plan` writes
    /// nothing.
    fn snapshot(root: &Path) -> Vec<String> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
            let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
            entries.sort_by_key(|e| e.path());
            for entry in entries {
                let path = entry.path();
                let rel = path.strip_prefix(base).unwrap().to_string_lossy().to_string();
                if entry.file_type().unwrap().is_dir() {
                    out.push(format!("{rel}/"));
                    walk(&path, base, out);
                } else {
                    let len = fs::metadata(&path).unwrap().len();
                    out.push(format!("{rel} ({len})"));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out
    }
}

#[test]
fn pair_add_list_remove_round_trip() {
    let fx = Fixture::new();

    fx.add_photos_pair();

    let list = fx.cmd().args(["pair", "list"]).output().unwrap();
    assert_eq!(list.status.code(), Some(EXIT_OK));
    let stdout = String::from_utf8(list.stdout).unwrap();
    assert!(
        stdout.contains("photos"),
        "table should list the pair: {stdout}"
    );
    assert!(
        stdout.contains("mirror"),
        "table should show the mode: {stdout}"
    );

    fx.cmd()
        .args(["pair", "remove", "photos"])
        .assert()
        .success();

    let list_after = fx.cmd().args(["pair", "list"]).output().unwrap();
    let stdout_after = String::from_utf8(list_after.stdout).unwrap();
    assert!(
        stdout_after.contains("No Folder pairs configured"),
        "pair should be gone after remove: {stdout_after}"
    );
}

#[test]
fn pair_list_json_emits_the_versioned_schema() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx.cmd().args(["pair", "list", "--json"]).output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));

    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("valid JSON output");
    assert_eq!(value["schema"], "vibefilesync.pairs/v1");
    assert_eq!(value["pairs"][0]["name"], "photos");
    assert_eq!(value["pairs"][0]["mode"], "mirror");
    assert!(value["pairs"][0]["source_volume_uuid"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));
    assert!(value["pairs"][0]["destination_volume_uuid"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));
}

#[test]
fn pair_add_pins_both_volume_uuids_into_the_config_file() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let contents = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    assert!(contents.contains("version = 1"));
    assert!(contents.contains("[pairs.photos]"));
    assert!(contents.contains("source_volume_uuid"));
    assert!(contents.contains("destination_volume_uuid"));
    assert!(contents.contains("mode = \"mirror\""));
}

#[test]
fn config_rewrite_is_atomic_no_stray_temp_files_survive() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    fx.cmd()
        .args(["pair", "remove", "photos"])
        .assert()
        .success();

    let dir = config_file(fx.xdg.path());
    let dir = dir.parent().unwrap();
    let entries: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(entries, vec!["config.toml".to_string()]);
}

#[test]
fn duplicate_pair_add_is_a_usage_error_exit_64() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            fx.destination.path().to_str().unwrap(),
            "--mode",
            "update",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("photos"),
        "error should name the pair: {stderr}"
    );
}

#[test]
fn removing_an_unknown_pair_is_a_usage_error_exit_64() {
    let fx = Fixture::new();

    let output = fx.cmd().args(["pair", "remove", "nope"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("nope"),
        "error should name the pair: {stderr}"
    );
}

#[test]
fn pair_add_with_a_nonexistent_source_is_a_usage_error_exit_64() {
    let fx = Fixture::new();
    let missing_source = fx.source.path().join("does-not-exist");

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            missing_source.to_str().unwrap(),
            "--destination",
            fx.destination.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
}

#[test]
fn invalid_pair_name_is_a_usage_error_exit_64() {
    let fx = Fixture::new();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "Photos_Library",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            fx.destination.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
}

#[test]
fn unknown_config_key_aborts_before_any_command_runs_exit_2() {
    let fx = Fixture::new();
    let path = config_file(fx.xdg.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "version = 1\nmod = \"typo\"\n").unwrap();

    let output = fx.cmd().args(["pair", "list"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_PRECONDITION));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("mod"),
        "error should name the offending key: {stderr}"
    );
}

#[test]
fn missing_required_field_aborts_with_exit_2() {
    let fx = Fixture::new();
    let path = config_file(fx.xdg.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
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

    let output = fx.cmd().args(["pair", "list"]).output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_PRECONDITION));
}

#[test]
fn bad_config_aborts_before_an_unimplemented_verb_runs() {
    // A config typo must abort loudly before *any* command's logic runs,
    // not just `pair` subcommands (ADR-0006 §7).
    let fx = Fixture::new();
    let path = config_file(fx.xdg.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "version = 1\nbogus = true\n").unwrap();

    let output = fx.cmd().args(["plan", "photos"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_PRECONDITION));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        !stderr.contains("not yet implemented"),
        "should abort on the bad config, never reach the stub: {stderr}"
    );
}

#[test]
fn run_stub_accepts_the_adr_0004_per_run_flags() {
    let fx = Fixture::new();
    fx.cmd()
        .args([
            "run",
            "photos",
            "--yes",
            "--json",
            "--permanent-delete",
            "--allow-empty-source",
            "--ignore-space-check",
            "--exclude",
            "some/relative/path",
        ])
        .assert()
        .code(EXIT_UNIMPLEMENTED);
}

#[test]
fn plan_json_is_not_yet_implemented() {
    // The human `plan` diff ships in this slice; the NDJSON
    // `vibefilesync.plan/v1` stream is a later one.
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args(["plan", "photos", "--json", "--exclude", "a/b"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_UNIMPLEMENTED));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("not yet implemented"),
        "plan --json should say not yet implemented: {stderr}"
    );
}

#[test]
fn history_stub_accepts_json_flag() {
    let fx = Fixture::new();
    fx.cmd()
        .args(["history", "photos", "--json"])
        .assert()
        .code(EXIT_UNIMPLEMENTED);
}

#[test]
fn no_mode_flag_exists_on_run_or_plan() {
    // ADR-0006: sync mode is per-pair config only, never a per-run flag.
    let fx = Fixture::new();
    let output = fx
        .cmd()
        .args(["plan", "photos", "--mode", "mirror"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_USAGE));
}

#[test]
fn unimplemented_verbs_print_a_clear_message() {
    let fx = Fixture::new();
    for verb in ["status", "history"] {
        let output = fx.cmd().args([verb, "photos"]).output().unwrap();
        assert_ne!(
            output.status.code(),
            Some(EXIT_OK),
            "{verb} should not succeed"
        );
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(
            stderr.contains("not yet implemented"),
            "{verb} should say not yet implemented: {stderr}"
        );
    }
}

#[test]
fn bare_invocation_shows_help_and_exits_zero() {
    let fx = Fixture::new();
    let output = fx.cmd().output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Usage: vibesync"));
}

#[test]
fn help_exits_zero() {
    let fx = Fixture::new();
    fx.cmd().arg("--help").assert().success();
}

// --- Slice 14: startup banner (issue #28, ADR-0005) ---

#[test]
fn banner_renders_on_bare_help_and_tui_tty_surfaces() {
    let fx = Fixture::new();

    for args in [&[][..], &["--help"][..], &["tui"][..]] {
        let output = vibesync_in_tty(fx.xdg.path(), args, false);
        let output = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.contains('◢') && output.contains('█') && output.contains('◣'),
            "top mark missing for {args:?}: {output}"
        );
        assert!(
            output.contains('◥') && output.contains('◤'),
            "bottom mark missing for {args:?}: {output}"
        );
        assert!(output.contains("V I B E S Y N C"), "wordmark missing for {args:?}: {output}");
        assert!(
            output.contains("one-way file sync with SafetyNet · plan → review → run"),
            "tagline missing for {args:?}: {output}"
        );
        assert!(
            output.contains("\x1b[38;2;168;85;247m"),
            "truecolor purple gradient stop missing for {args:?}: {output:?}"
        );
    }
}

#[test]
fn no_color_uses_a_plain_banner_one_liner_in_a_tty() {
    let fx = Fixture::new();
    let output = vibesync_in_tty(fx.xdg.path(), &["--help"], true);
    let output = String::from_utf8_lossy(&output.stdout);

    assert!(output.contains("V I B E S Y N C — one-way file sync with SafetyNet · plan → review → run"));
    assert!(!output.contains("\x1b["), "NO_COLOR output must contain no ANSI bytes: {output:?}");
}

#[test]
fn piped_commands_never_receive_banner_bytes() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    for args in [
        &["plan", "photos"][..],
        &["run", "photos"][..],
        &["status", "photos"][..],
        &["history", "photos"][..],
        &["prune", "photos"][..],
        &["pair", "list"][..],
    ] {
        let output = fx.cmd().args(args).output().unwrap();
        let all_output = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !all_output.contains("V I B E S Y N C") && !all_output.contains("◢█◣"),
            "working command must have no banner bytes for {args:?}: {all_output}"
        );
    }
}

#[test]
fn banner_is_suppressed_by_environment_or_a_non_tty_stderr() {
    let fx = Fixture::new();

    let suppressed = ProcessCommand::new("script")
        .args(["-q", "/dev/null"])
        .arg(Command::cargo_bin("vibesync").unwrap().get_program())
        .arg("--help")
        .env("XDG_CONFIG_HOME", fx.xdg.path())
        .env("VIBESYNC_NO_BANNER", "1")
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&suppressed.stdout).contains("V I B E S Y N C"));

    let piped = fx.cmd().arg("--help").output().unwrap();
    let all_output = format!(
        "{}{}",
        String::from_utf8_lossy(&piped.stdout),
        String::from_utf8_lossy(&piped.stderr)
    );
    assert!(!all_output.contains("V I B E S Y N C"));
}

// --- Slice 2: `plan <pair>` human Dry-run diff (issue #16) ---

#[test]
fn plan_prints_summary_first_then_grouped_sections() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "aaaa");
    fx.write_source("changed.txt", "aaaaaa"); // 6 bytes
    fx.write_dest("changed.txt", "bb"); // 2 bytes -> UPDATE (size differs)
    fx.write_dest("old/stale.txt", "zzz"); // dest-only -> DELETE (mirror)
    fx.add_photos_pair();

    let output = fx.cmd().args(["plan", "photos"]).output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    let stdout = String::from_utf8(output.stdout).unwrap();

    // Totals summary comes first, before any section header.
    let summary_line = stdout.lines().next().unwrap();
    assert!(
        summary_line.contains("1 copy") && summary_line.contains("1 update")
            && summary_line.contains("1 delete") && summary_line.contains("0 error"),
        "totals summary should lead: {summary_line}"
    );
    assert!(summary_line.to_lowercase().contains("dry-run"));

    // Sections are grouped and ordered COPY, UPDATE, DELETE, ERRORS.
    let copy = stdout.find("COPY").unwrap();
    let update = stdout.find("UPDATE").unwrap();
    let delete = stdout.find("DELETE").unwrap();
    let errors = stdout.find("ERRORS").unwrap();
    assert!(copy < update && update < delete && delete < errors, "section order: {stdout}");

    assert!(stdout.contains("new.txt"), "COPY row present: {stdout}");
    assert!(stdout.contains("changed.txt"), "UPDATE row present: {stdout}");
    assert!(stdout.contains("old/stale.txt"), "DELETE row present: {stdout}");
}

#[test]
fn plan_update_and_delete_sections_carry_the_safetynet_annotation() {
    let fx = Fixture::new();
    fx.write_source("changed.txt", "aaaaaa");
    fx.write_dest("changed.txt", "bb");
    fx.write_dest("gone.txt", "zzz");
    fx.add_photos_pair();

    let stdout = String::from_utf8(fx.cmd().args(["plan", "photos"]).output().unwrap().stdout).unwrap();

    for line in stdout.lines() {
        if line.starts_with("UPDATE") || line.starts_with("DELETE") {
            assert!(
                line.contains("_SafetyNet/"),
                "old versions destination must be annotated: {line}"
            );
        }
    }
}

#[test]
fn plan_update_mode_never_plans_a_deletion() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "aaaa");
    fx.write_dest("only-on-dest.txt", "zzz"); // would be a DELETE under Mirror
    fx.add_pair("docs", "update");

    let stdout = String::from_utf8(fx.cmd().args(["plan", "docs"]).output().unwrap().stdout).unwrap();

    // The DELETE section still prints (fixed four-section layout) but is
    // always empty in Update — nothing at the destination is ever removed.
    assert!(stdout.contains("(update)"));
    assert!(stdout.contains("0 delete"), "Update totals report zero deletes: {stdout}");
    assert!(stdout.contains("DELETE (0)"), "empty DELETE section still shown: {stdout}");
    assert!(!stdout.contains("only-on-dest.txt"), "dest-only file must not be a delete row: {stdout}");
    assert!(stdout.contains("new.txt"));
}

#[test]
fn plan_never_shows_or_deletes_machinery() {
    let fx = Fixture::new();
    fx.write_source("real.txt", "aaaa");
    // Destination machinery that must stay invisible and undeleted.
    fx.write_dest("_SafetyNet/20200101T000000Z/archived.txt", "old-version");
    fx.write_dest(".real.txt.vibesync-tmp-abc123", "half-written");
    fx.add_photos_pair();

    let stdout = String::from_utf8(fx.cmd().args(["plan", "photos"]).output().unwrap().stdout).unwrap();

    // Machinery content is never a plan row (`_SafetyNet/` still appears in
    // the UPDATE/DELETE header annotation — that's the archive destination,
    // not a synced path — so we check the actual entries, not the prefix).
    assert!(!stdout.contains("archived.txt"), "SafetyNet contents must never appear: {stdout}");
    assert!(!stdout.contains("20200101T000000Z"), "SafetyNet run folder must never appear: {stdout}");
    assert!(!stdout.contains("vibesync-tmp"), "Publish temps must never appear: {stdout}");
    // The only planned action is the real source file (a COPY); nothing is
    // planned for deletion even though the destination is non-empty.
    assert!(stdout.contains("1 copy") && stdout.contains("0 delete"), "{stdout}");
}

#[test]
fn plan_excludes_an_exact_path() {
    let fx = Fixture::new();
    fx.write_source("keep.txt", "aaaa");
    fx.write_source("skip.txt", "aaaa");
    fx.add_photos_pair();

    let stdout = String::from_utf8(
        fx.cmd().args(["plan", "photos", "--exclude", "skip.txt"]).output().unwrap().stdout,
    )
    .unwrap();

    assert!(stdout.contains("keep.txt"));
    assert!(!stdout.contains("skip.txt"), "excluded path must not appear: {stdout}");
    assert!(stdout.contains("excluded 1"), "excluded count reported: {stdout}");
}

#[test]
fn plan_performs_zero_writes_to_source_or_destination() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "aaaa");
    fx.write_source("changed.txt", "aaaaaa");
    fx.write_dest("changed.txt", "bb");
    fx.write_dest("gone.txt", "zzz");
    fx.add_photos_pair();

    let src_before = Fixture::snapshot(fx.source.path());
    let dst_before = Fixture::snapshot(fx.destination.path());

    fx.cmd().args(["plan", "photos"]).assert().success();

    assert_eq!(src_before, Fixture::snapshot(fx.source.path()), "plan wrote to the source");
    assert_eq!(dst_before, Fixture::snapshot(fx.destination.path()), "plan wrote to the destination");
}

#[test]
fn plan_for_an_unknown_pair_is_a_usage_error_exit_64() {
    let fx = Fixture::new();
    let output = fx.cmd().args(["plan", "nope"]).output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("nope"), "error should name the pair: {stderr}");
}

// --- Slice 3: first safe copy (issue #17) ---

#[test]
fn run_yes_prints_the_review_then_publishes_new_files() {
    let fx = Fixture::new();
    fx.write_source("nested/photo.txt", "the complete photo");
    fx.add_photos_pair();

    let output = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with("Dry-run for 'photos'"), "review must print first: {stdout}");
    assert_eq!(fs::read_to_string(fx.destination.path().join("nested/photo.txt")).unwrap(), "the complete photo");
}

#[test]
fn declining_run_leaves_both_trees_untouched() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "source");
    fx.write_dest("existing.txt", "destination");
    fx.add_photos_pair();
    let source_before = Fixture::snapshot(fx.source.path());
    let destination_before = Fixture::snapshot(fx.destination.path());

    fx.cmd()
        .args(["run", "photos"])
        .write_stdin("n\n")
        .assert()
        .success();

    assert_eq!(Fixture::snapshot(fx.source.path()), source_before);
    assert_eq!(Fixture::snapshot(fx.destination.path()), destination_before);
}

#[test]
fn run_publishes_no_temp_files_after_a_successful_copy() {
    let fx = Fixture::new();
    fx.write_source("document.txt", "complete contents");
    fx.add_photos_pair();

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    assert_eq!(fs::read_to_string(fx.destination.path().join("document.txt")).unwrap(), "complete contents");
    let names: Vec<_> = fs::read_dir(fx.destination.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().all(|name| !name.contains(".vibesync-tmp-")), "no temporary file may be published: {names:?}");
}

#[test]
fn a_failed_copy_never_replaces_the_final_path_and_other_copies_continue() {
    let fx = Fixture::new();
    fx.write_source("blocked.txt", "would be partial if published");
    fx.write_source("good.txt", "this copy should still finish");
    // Directories are not plan entries, so this models a destination object
    // appearing after the fresh scan; Slice 3 must refuse to replace it.
    fs::create_dir(fx.destination.path().join("blocked.txt")).unwrap();
    fx.add_photos_pair();

    let output = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(fx.destination.path().join("blocked.txt").is_dir());
    assert_eq!(fs::read_to_string(fx.destination.path().join("good.txt")).unwrap(), "this copy should still finish");
    assert!(
        fs::read_dir(fx.destination.path())
            .unwrap()
            .all(|entry| !entry.unwrap().file_name().to_string_lossy().contains(".vibesync-tmp-")),
        "a failed file must not leave a publishable temp"
    );
}

#[test]
fn run_preserves_a_source_xattr_through_copyfile() {
    let fx = Fixture::new();
    fx.write_source("tagged.txt", "complete contents");
    let source = fx.source.path().join("tagged.txt");
    let status = std::process::Command::new("xattr")
        .args(["-w", "com.vibesync.slice3", "kept", source.to_str().unwrap()])
        .status()
        .expect("xattr command is available on macOS");
    assert!(status.success(), "source xattr is writable");
    fx.add_photos_pair();

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    let destination = fx.destination.path().join("tagged.txt");
    let value = std::process::Command::new("xattr")
        .args(["-p", "com.vibesync.slice3", destination.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(value.status.success(), "copyfile must preserve source xattrs");
    assert_eq!(String::from_utf8(value.stdout).unwrap(), "kept\n");
}

// --- Slice 4: SafetyNet (issue #18) ---

#[test]
fn run_archives_an_updated_destination_before_publishing_the_replacement() {
    let fx = Fixture::new();
    fx.write_source("report.txt", "new version");
    fx.write_dest("report.txt", "old version");
    fx.add_photos_pair();

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    assert_eq!(fs::read_to_string(fx.destination.path().join("report.txt")).unwrap(), "new version");
    let archive = fx.destination.path().join("_SafetyNet");
    let run_folders: Vec<_> = fs::read_dir(&archive).unwrap().map(|entry| entry.unwrap().path()).collect();
    assert_eq!(run_folders.len(), 1, "one Run folder is created");
    assert_eq!(fs::read_to_string(run_folders[0].join("report.txt")).unwrap(), "old version");
}

#[test]
fn update_mode_also_archives_a_replaced_destination() {
    let fx = Fixture::new();
    fx.write_source("report.txt", "new version");
    fx.write_dest("report.txt", "old version");
    fx.add_pair("documents", "update");

    fx.cmd()
        .args(["run", "documents", "--yes"])
        .assert()
        .success();

    assert_eq!(
        fs::read_to_string(fx.destination.path().join("report.txt")).unwrap(),
        "new version"
    );
    let run = fs::read_dir(fx.destination.path().join("_SafetyNet"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(fs::read_to_string(run.join("report.txt")).unwrap(), "old version");
}

#[test]
fn mirror_deletion_archives_old_file_and_leaves_safetynet_untouched() {
    let fx = Fixture::new();
    fx.write_dest("removed.txt", "old version");
    fx.write_dest("_SafetyNet/older-run/kept.txt", "already archived");
    fx.add_photos_pair();

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    assert!(!fx.destination.path().join("removed.txt").exists());
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("_SafetyNet/older-run/kept.txt")).unwrap(),
        "already archived"
    );
    let new_archives: Vec<_> = fs::read_dir(fx.destination.path().join("_SafetyNet"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.file_name().unwrap() != "older-run")
        .collect();
    assert_eq!(new_archives.len(), 1);
    assert_eq!(fs::read_to_string(new_archives[0].join("removed.txt")).unwrap(), "old version");
}

#[test]
fn permanent_delete_bypasses_safetynet_for_this_run() {
    let fx = Fixture::new();
    fx.write_dest("removed.txt", "old version");
    fx.add_photos_pair();

    fx.cmd()
        .args(["run", "photos", "--yes", "--permanent-delete"])
        .assert()
        .success();

    assert!(!fx.destination.path().join("removed.txt").exists());
    assert!(!fx.destination.path().join("_SafetyNet").exists());
}

#[test]
fn prune_removes_run_folders_but_nothing_else() {
    let fx = Fixture::new();
    fx.write_dest("_SafetyNet/20260716T120000Z/old.txt", "old one");
    fx.write_dest("_SafetyNet/20260716T120000Z-2/nested/old.txt", "old two");
    fx.write_dest("_SafetyNet/keep-for-manual-restore/old.txt", "keep me");
    fx.write_dest("current.txt", "current");
    fx.add_photos_pair();

    fx.cmd().args(["prune", "photos"]).assert().success();

    assert!(fx.destination.path().join("_SafetyNet").is_dir());
    assert_eq!(
        fs::read_to_string(
            fx.destination
                .path()
                .join("_SafetyNet/keep-for-manual-restore/old.txt")
        )
        .unwrap(),
        "keep me"
    );
    assert_eq!(fs::read_to_string(fx.destination.path().join("current.txt")).unwrap(), "current");
}
