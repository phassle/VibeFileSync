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

const EXIT_OK: i32 = 0;
const EXIT_PRECONDITION: i32 = 2;
const EXIT_USAGE: i32 = 64;

fn vibesync(config_home: &Path) -> Command {
    let mut cmd = Command::cargo_bin("vibesync").expect("binary builds");
    cmd.env("XDG_CONFIG_HOME", config_home);
    cmd
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
        self.cmd()
            .args([
                "pair",
                "add",
                "photos",
                "--source",
                self.source.path().to_str().unwrap(),
                "--destination",
                self.destination.path().to_str().unwrap(),
                "--mode",
                "mirror",
            ])
            .assert()
            .success();
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
        .code(1);
}

#[test]
fn plan_stub_accepts_json_and_exclude_flags() {
    let fx = Fixture::new();
    fx.cmd()
        .args(["plan", "photos", "--json", "--exclude", "a/b"])
        .assert()
        .code(1);
}

#[test]
fn history_stub_accepts_json_flag() {
    let fx = Fixture::new();
    fx.cmd()
        .args(["history", "photos", "--json"])
        .assert()
        .code(1);
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
    for verb in ["plan", "run", "status", "history", "prune"] {
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
fn missing_subcommand_is_a_usage_error_exit_64() {
    let fx = Fixture::new();
    let output = fx.cmd().output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_USAGE));
}

#[test]
fn help_exits_zero() {
    let fx = Fixture::new();
    fx.cmd().arg("--help").assert().success();
}
