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
use std::io::Write;
#[cfg(feature = "fault-injection")]
use std::io::{BufRead, BufReader};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command as ProcessCommand;
#[cfg(feature = "fault-injection")]
use std::process::Stdio;

const EXIT_OK: i32 = 0;
const EXIT_PARTIAL: i32 = 1;
const EXIT_PRECONDITION: i32 = 2;
#[cfg(feature = "fault-injection")]
const EXIT_BLOCKED_PLAN: i32 = 3;
const EXIT_INTERRUPTED: i32 = 4;
const EXIT_USAGE: i32 = 64;

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

/// Run the real binary in a pseudo-terminal and feed raw key presses to its
/// stdin. This is the thinnest practical boundary around a terminal UI: the
/// test still observes only process exit and on-disk sync state.
fn vibesync_in_tty_with_input(
    config_home: &Path,
    home: &Path,
    args: &[&str],
    input: &[u8],
) -> std::process::Output {
    vibesync_in_tty_with_input_and_env(config_home, home, args, input, &[])
}

fn vibesync_in_tty_with_input_and_env(
    config_home: &Path,
    home: &Path,
    args: &[&str],
    input: &[u8],
    extra_env: &[(&str, &str)],
) -> std::process::Output {
    vibesync_in_tty_with_input_after_start(config_home, home, args, input, extra_env, || {})
}

fn vibesync_in_tty_with_input_after_start(
    config_home: &Path,
    home: &Path,
    args: &[&str],
    input: &[u8],
    extra_env: &[(&str, &str)],
    before_input: impl FnOnce(),
) -> std::process::Output {
    let binary = Command::cargo_bin("vibesync").expect("binary builds");
    let mut command = ProcessCommand::new("script");
    command
        .args(["-q", "/dev/null"])
        .arg(binary.get_program())
        .args(args)
        .env("XDG_CONFIG_HOME", config_home)
        .env("HOME", home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0);
    for (name, value) in extra_env {
        command.env(name, value);
    }
    let mut child = command.spawn().expect("script starts a pseudo-terminal");
    // Let the child switch the PTY to raw mode before sending key presses;
    // otherwise the line discipline can retain a trailing confirmation key.
    std::thread::sleep(std::time::Duration::from_millis(500));
    before_input();
    child
        .stdin
        .take()
        .expect("script stdin is piped")
        .write_all(input)
        .expect("terminal input is written");

    for _ in 0..100 {
        if child
            .try_wait()
            .expect("TUI status can be polled")
            .is_some()
        {
            return child.wait_with_output().expect("TUI output is collected");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    // `script` and the TUI share this dedicated process group. Bound a bad
    // key sequence without leaving a child PTY behind for later tests.
    // SAFETY: the negative id targets only the dedicated process group we
    // assigned above; the live child still owns that id during this branch.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    for _ in 0..20 {
        if child
            .try_wait()
            .expect("terminated TUI can be polled")
            .is_some()
        {
            panic!("TUI did not exit within five seconds for {args:?}");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // SAFETY: same scoped process group; SIGKILL prevents a broken terminal
    // teardown from hanging the test suite or leaving an orphaned PTY.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
    panic!("TUI did not exit within five seconds for {args:?}");
}

fn config_file(config_home: &Path) -> std::path::PathBuf {
    config_home.join("vibesync").join("config.toml")
}

struct Fixture {
    xdg: tempfile::TempDir,
    home: tempfile::TempDir,
    source: tempfile::TempDir,
    destination: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        Fixture {
            xdg: tempfile::tempdir().expect("xdg tempdir"),
            home: tempfile::tempdir().expect("home tempdir"),
            source: tempfile::tempdir().expect("source tempdir"),
            destination: tempfile::tempdir().expect("destination tempdir"),
        }
    }

    fn cmd(&self) -> Command {
        let mut cmd = vibesync(self.xdg.path());
        cmd.env("HOME", self.home.path());
        cmd
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
                let rel = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
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

    fn journal_dir(&self, pair: &str) -> std::path::PathBuf {
        self.home
            .path()
            .join("Library/Application Support/VibeFileSync/runs")
            .join(pair)
    }

    #[cfg(feature = "fault-injection")]
    fn only_journal_events(&self, pair: &str) -> Vec<serde_json::Value> {
        let journal = fs::read_dir(self.journal_dir(pair))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("ndjson"))
            .expect("one retained Journal exists");
        fs::read_to_string(journal)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
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
    assert!(contents.contains("source_volume_relative_path"));
    assert!(contents.contains("destination_volume_uuid"));
    assert!(contents.contains("destination_volume_relative_path"));
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
fn run_accepts_the_adr_0004_per_run_flags() {
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
            "--verify",
            "--exclude",
            "some/relative/path",
        ])
        .assert()
        .code(EXIT_USAGE);
}

#[test]
fn plan_json_stream_has_versioned_rows_in_contract_order_and_pure_stdout() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "new");
    fx.write_source("changed.txt", "new value");
    fx.write_dest("changed.txt", "old");
    fx.write_dest("removed.txt", "gone");
    fx.write_dest(".abandoned.vibesync-tmp-old-run", "stale");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args(["plan", "photos", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert!(
        output.stderr.is_empty(),
        "JSON plan must not log: {:?}",
        output.stderr
    );
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("each stdout line is JSON"))
        .collect();
    assert_eq!(rows.first().unwrap()["type"], "plan_start");
    assert_eq!(rows.last().unwrap()["type"], "summary");
    assert!(rows[1..rows.len() - 1]
        .iter()
        .all(|row| row["type"] == "action"));
    assert!(rows
        .iter()
        .all(|row| row["schema"] == "vibefilesync.plan/v1"));
    assert_eq!(rows[0]["pair"], "photos");
    assert_eq!(rows[0]["mode"], "mirror");
    assert_eq!(rows[0]["dry_run"], true);
    let plan_id = rows[0]["plan_id"]
        .as_str()
        .expect("Dry-run keeps its established plan identity");
    assert!(rows.iter().all(|row| row["plan_id"] == plan_id));
    assert!(rows.iter().all(|row| row.get("run_id").is_none()));
    let update = rows.iter().find(|row| row["op"] == "update").unwrap();
    assert_eq!(update["path"], "changed.txt");
    assert_eq!(update["bytes"], 9);
    assert_eq!(update["old_bytes"], 3);
    assert!(update["safety_net"]
        .as_str()
        .unwrap()
        .contains("_SafetyNet/"));
    let delete = rows.iter().find(|row| row["op"] == "delete").unwrap();
    assert_eq!(delete["bytes"], 4);
    assert_eq!(delete["old_bytes"], 4);
    let cleanup = rows.iter().find(|row| row["op"] == "cleanup").unwrap();
    assert_eq!(cleanup["bytes"], 5);
    assert_eq!(cleanup["reason"], "abandoned temp");
    let summary = rows.last().unwrap();
    assert_eq!(summary["counts"]["copy"], 1);
    assert_eq!(summary["counts"]["cleanup"], 1);
    for field in [
        "copy",
        "update",
        "delete",
        "error",
        "cleanup",
        "scanned",
        "unchanged",
        "excluded",
    ] {
        assert!(
            summary["counts"][field].is_number(),
            "missing count {field}"
        );
    }
    assert!(summary.get("scanned").is_none());
    assert!(summary.get("strays").is_none());
}

#[test]
fn plan_json_action_order_is_deterministic_for_nested_trees() {
    let fx = Fixture::new();
    fx.write_source("b.txt", "b");
    fx.write_source("a/z.txt", "z");
    fx.write_source("a/a.txt", "a");
    fx.write_dest("d.txt", "d");
    fx.write_dest("c/x.txt", "x");
    fx.add_photos_pair();

    let action_paths = || {
        let output = fx
            .cmd()
            .args(["plan", "photos", "--json"])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(EXIT_OK));
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|row| row["type"] == "action")
            .map(|row| row["path"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };

    let expected = ["a/a.txt", "a/z.txt", "b.txt", "c/x.txt", "d.txt"];
    assert_eq!(action_paths(), expected);
    assert_eq!(action_paths(), expected);
}

#[test]
fn relocated_json_plan_reports_notice_on_stderr_and_keeps_stdout_ndjson_only() {
    let fx = Fixture::new();
    let source = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
    fs::write(source.path().join("photo.txt"), "photo").unwrap();
    fx.cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            source.path().to_str().unwrap(),
            "--destination",
            fx.destination.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .assert()
        .success();
    let path = config_file(fx.xdg.path());
    let original = source.path().display().to_string();
    let stale = "/Volumes/VibeFileSync-Stale/Photos";
    let config = fs::read_to_string(&path).unwrap().replace(
        &format!("source = \"{original}\""),
        &format!("source = \"{stale}\""),
    );
    fs::write(path, config).unwrap();

    let output = fx
        .cmd()
        .args(["plan", "photos", "--json"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("source volume moved"), "{stderr}");
    assert!(stderr.contains(stale), "{stderr}");
    assert!(stderr.contains(&original), "{stderr}");
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok()));
}

#[test]
fn reviewed_structural_conflicts_preserve_unreviewed_directories() {
    let orphaned_replacement = Fixture::new();
    orphaned_replacement.write_source("docs/new.txt", "new");
    orphaned_replacement.write_dest("docs", "old file");
    orphaned_replacement.add_pair("photos", "update");
    let output = orphaned_replacement
        .cmd()
        .args(["run", "photos", "--yes", "--exclude", "docs/new.txt"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    assert_eq!(
        fs::read_to_string(orphaned_replacement.destination.path().join("docs")).unwrap(),
        "old file"
    );
    assert!(!orphaned_replacement
        .destination
        .path()
        .join("_SafetyNet")
        .exists());

    let orphaned_empty_directory = Fixture::new();
    orphaned_empty_directory.write_source("node", "new file");
    fs::create_dir(orphaned_empty_directory.destination.path().join("node")).unwrap();
    orphaned_empty_directory.add_pair("photos", "update");
    let output = orphaned_empty_directory
        .cmd()
        .args(["run", "photos", "--yes", "--exclude", "node"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    assert!(orphaned_empty_directory
        .destination
        .path()
        .join("node")
        .is_dir());
    assert!(!orphaned_empty_directory
        .destination
        .path()
        .join("_SafetyNet")
        .exists());

    let source_directory = Fixture::new();
    source_directory.write_source("docs/new.txt", "new");
    source_directory.write_dest("docs", "old file");
    source_directory.add_photos_pair();
    let output = source_directory
        .cmd()
        .args(["plan", "photos", "--json"])
        .output()
        .unwrap();
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(rows
        .iter()
        .any(|row| row["op"] == "delete" && row["path"] == "docs"));
    assert!(rows
        .iter()
        .any(|row| row["op"] == "copy" && row["path"] == "docs/new.txt"));
    let output = source_directory
        .cmd()
        .args(["run", "photos", "--yes", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert_eq!(
        fs::read_to_string(source_directory.destination.path().join("docs/new.txt")).unwrap(),
        "new"
    );

    let source_file = Fixture::new();
    source_file.write_source("node", "new file");
    source_file.write_dest("node/subdir/old.txt", "old child");
    source_file.add_photos_pair();
    let output = source_file
        .cmd()
        .args(["run", "photos", "--yes", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert_eq!(
        fs::read_to_string(source_file.destination.path().join("node")).unwrap(),
        "new file"
    );

    let update_directory = Fixture::new();
    update_directory.write_source("docs/new.txt", "new");
    update_directory.write_dest("docs", "old file");
    update_directory.add_pair("photos", "update");
    let output = update_directory
        .cmd()
        .args(["run", "photos", "--yes", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert_eq!(
        fs::read_to_string(update_directory.destination.path().join("docs/new.txt")).unwrap(),
        "new"
    );
    assert!(
        fs::read_dir(update_directory.destination.path().join("_SafetyNet"))
            .unwrap()
            .map(|entry| entry.unwrap().path().join("docs"))
            .any(|path| fs::read_to_string(path).is_ok_and(|contents| contents == "old file"))
    );

    for mode in ["mirror", "update"] {
        let empty_directory = Fixture::new();
        empty_directory.write_source("empty", "new file");
        fs::create_dir(empty_directory.destination.path().join("empty")).unwrap();
        empty_directory.add_pair("photos", mode);

        let plan = empty_directory
            .cmd()
            .args(["plan", "photos", "--json"])
            .output()
            .unwrap();
        let rows: Vec<serde_json::Value> = String::from_utf8(plan.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(rows.iter().any(|row| {
            row["op"] == "delete"
                && row["path"] == "empty"
                && row["reason"] == "replaced by source file"
        }));
        assert!(rows
            .iter()
            .any(|row| row["op"] == "copy" && row["path"] == "empty"));

        let output = empty_directory
            .cmd()
            .args(["run", "photos", "--yes", "--json"])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(EXIT_OK), "{mode}: {output:?}");
        assert_eq!(
            fs::read_to_string(empty_directory.destination.path().join("empty")).unwrap(),
            "new file"
        );
        let archived = fs::read_dir(empty_directory.destination.path().join("_SafetyNet"))
            .unwrap()
            .map(|entry| entry.unwrap().path().join("empty"))
            .find(|path| path.is_dir())
            .expect("the reviewed empty directory is retained in SafetyNet");
        assert!(archived.is_dir());
    }

    let unreviewed_directory = Fixture::new();
    unreviewed_directory.write_source("node", "new file");
    fs::create_dir_all(
        unreviewed_directory
            .destination
            .path()
            .join("node/unreviewed-empty"),
    )
    .unwrap();
    unreviewed_directory.add_photos_pair();
    let output = unreviewed_directory
        .cmd()
        .args(["run", "photos", "--yes", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_PARTIAL));
    assert!(unreviewed_directory
        .destination
        .path()
        .join("node/unreviewed-empty")
        .is_dir());

    let machinery_directory = Fixture::new();
    machinery_directory.write_source("node", "new file");
    fs::create_dir_all(
        machinery_directory
            .destination
            .path()
            .join("node/_SafetyNet"),
    )
    .unwrap();
    machinery_directory.add_photos_pair();
    let output = machinery_directory
        .cmd()
        .args(["run", "photos", "--yes", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_PARTIAL));
    assert!(machinery_directory
        .destination
        .path()
        .join("node/_SafetyNet")
        .is_dir());
}

#[test]
fn run_json_stream_reports_execution_order_verification_and_safetynet() {
    let fx = Fixture::new();
    fx.write_source("created.txt", "created");
    fx.write_source("updated.txt", "new value");
    fx.write_dest("updated.txt", "old");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args(["run", "photos", "--json", "--yes", "--verify"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert!(
        output.stderr.is_empty(),
        "JSON run must not log: {:?}",
        output.stderr
    );
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("each stdout line is JSON"))
        .collect();
    assert!(rows
        .iter()
        .all(|row| row["schema"] == "vibefilesync.run/v1"));
    assert_eq!(rows.first().unwrap()["type"], "run_start");
    assert_eq!(rows.last().unwrap()["type"], "summary");
    assert!(rows[0]["degradations"].is_array());
    let planned = rows[0]["planned_actions"]
        .as_array()
        .expect("run_start declares the reviewed action set");
    assert_eq!(planned.len(), 2);
    assert!(planned
        .iter()
        .any(|action| action["op"] == "copy" && action["path"] == "created.txt"));
    assert!(planned
        .iter()
        .any(|action| action["op"] == "update" && action["path"] == "updated.txt"));
    for path in ["created.txt", "updated.txt"] {
        let events: Vec<_> = rows.iter().filter(|row| row["path"] == path).collect();
        assert_eq!(events.first().unwrap()["type"], "action_start");
        assert_eq!(events.last().unwrap()["type"], "action_done");
        assert_eq!(events.last().unwrap()["result"], "done");
        assert_eq!(events.last().unwrap()["verified"], "full");
        assert!(events.last().unwrap()["warnings"].is_array());
    }
    let created = rows
        .iter()
        .find(|row| row["type"] == "action_done" && row["path"] == "created.txt")
        .unwrap();
    assert!(created["safety_net"].is_null());
    assert_eq!(created["warnings"], serde_json::json!([]));
    let updated = rows
        .iter()
        .find(|row| row["type"] == "action_done" && row["path"] == "updated.txt")
        .unwrap();
    assert!(updated["safety_net"]
        .as_str()
        .unwrap()
        .contains("_SafetyNet/"));
    assert_eq!(rows.last().unwrap()["warnings"], 0);
}

#[test]
fn run_json_cancellation_and_early_errors_keep_stdout_clean() {
    let cancelled = Fixture::new();
    cancelled.write_source("photo.txt", "would copy if approved");
    cancelled.add_photos_pair();
    let output = cancelled
        .cmd()
        .args(["run", "photos", "--json"])
        .write_stdin("n\n")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert!(output.stdout.is_empty(), "stdout must remain NDJSON-only");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("Proceed with COPY actions?"), "{stderr}");
    assert!(stderr.contains("Run cancelled"), "{stderr}");
    assert!(!cancelled.destination.path().join("photo.txt").exists());

    let unknown_pair = Fixture::new();
    let usage = unknown_pair
        .cmd()
        .args(["plan", "missing", "--json"])
        .output()
        .unwrap();
    assert_eq!(usage.status.code(), Some(EXIT_USAGE));
    assert!(usage.stdout.is_empty());

    let bad_config = Fixture::new();
    let path = config_file(bad_config.xdg.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "version = 1\nbogus = true\n").unwrap();
    let precondition = bad_config
        .cmd()
        .args(["plan", "photos", "--json"])
        .output()
        .unwrap();
    assert_eq!(precondition.status.code(), Some(EXIT_PRECONDITION));
    assert!(precondition.stdout.is_empty());
}

#[test]
#[cfg(feature = "fault-injection")]
fn run_json_progress_is_live_during_a_large_file_copy() {
    let fx = Fixture::new();
    fs::write(
        fx.source.path().join("large.bin"),
        vec![7_u8; 16 * 1024 * 1024],
    )
    .unwrap();
    fx.write_source("small.txt", "small");
    fx.add_photos_pair();

    let binary = Command::cargo_bin("vibesync").expect("binary builds");
    let mut child = ProcessCommand::new(binary.get_program())
        .args(["run", "photos", "--json", "--yes"])
        .env("XDG_CONFIG_HOME", fx.xdg.path())
        .env("HOME", fx.home.path())
        .env("VIBESYNC_TEST_COPY_CHUNK_DELAY_MS", "5")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut saw_live_progress = false;
    for line in lines {
        let row: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        if !saw_live_progress
            && row["type"] == "progress"
            && row["bytes"].as_u64().unwrap() > 0
            && row["bytes"].as_u64().unwrap() < row["total_bytes"].as_u64().unwrap()
        {
            assert!(
                child.try_wait().unwrap().is_none(),
                "an intermediate progress row must cross stdout before copy completion"
            );
            saw_live_progress = true;
        }
    }
    assert!(
        saw_live_progress,
        "copy emitted no intermediate progress row"
    );
    assert_eq!(child.wait().unwrap().code(), Some(EXIT_OK));
}

#[test]
fn json_exit_codes_distinguish_partial_precondition_blocked_and_usage() {
    let fx = Fixture::new();
    fx.write_source("blocked.txt", "contents");
    fs::create_dir_all(fx.destination.path().join("blocked.txt/_SafetyNet")).unwrap();
    fx.add_photos_pair();
    assert_eq!(
        fx.cmd()
            .args(["run", "photos", "--json", "--yes"])
            .output()
            .unwrap()
            .status
            .code(),
        Some(EXIT_PARTIAL)
    );

    let missing = Fixture::new();
    missing.add_photos_pair();
    fs::remove_dir_all(missing.source.path()).unwrap();
    assert_eq!(
        missing
            .cmd()
            .args(["run", "photos", "--json", "--yes"])
            .output()
            .unwrap()
            .status
            .code(),
        Some(EXIT_PRECONDITION)
    );

    assert_eq!(
        fx.cmd()
            .args(["run", "photos", "--json", "--unknown"])
            .output()
            .unwrap()
            .status
            .code(),
        Some(EXIT_USAGE)
    );
    #[cfg(feature = "fault-injection")]
    {
        let blocked = Fixture::new();
        std::os::unix::fs::symlink("target", blocked.source.path().join("link")).unwrap();
        blocked.add_photos_pair();
        assert_eq!(
            blocked
                .cmd()
                .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
                .args(["run", "photos", "--json", "--yes"])
                .output()
                .unwrap()
                .status
                .code(),
            Some(EXIT_BLOCKED_PLAN)
        );
    }
}

#[cfg(feature = "fault-injection")]
#[test]
fn run_json_process_boundary_covers_failure_warning_delete_and_interruption_rows() {
    let failed = Fixture::new();
    failed.write_source("blocked.txt", "contents");
    fs::create_dir_all(failed.destination.path().join("blocked.txt/_SafetyNet")).unwrap();
    failed.add_photos_pair();
    let failed_output = failed
        .cmd()
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();
    assert_eq!(failed_output.status.code(), Some(EXIT_PARTIAL));
    let failed_rows: Vec<serde_json::Value> = String::from_utf8(failed_output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(failed_rows[0]["type"], "run_start");
    assert_eq!(failed_rows[1]["type"], "action_start");
    assert_eq!(failed_rows[2]["type"], "action_failed");
    assert_eq!(failed_rows[2]["result"], "failed");
    assert!(failed_rows[2]["reason"].is_string());
    assert_eq!(failed_rows[3]["type"], "summary");

    let warning = Fixture::new();
    warning.write_source("warning.txt", "contents");
    warning.add_photos_pair();
    let warning_output = warning
        .cmd()
        .env("VIBESYNC_TEST_WARNING_PATH", "warning.txt")
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();
    assert_eq!(warning_output.status.code(), Some(EXIT_OK));
    let warning_rows: Vec<serde_json::Value> = String::from_utf8(warning_output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let done = warning_rows
        .iter()
        .find(|row| row["type"] == "action_done")
        .unwrap();
    assert_eq!(done["result"], "done");
    assert_eq!(done["verified"], "standard");
    assert_eq!(done["warnings"][0]["code"], "metadata_mismatch");
    assert_eq!(warning_rows.last().unwrap()["warnings"], 1);
    let journal_done = warning
        .only_journal_events("photos")
        .into_iter()
        .find(|row| row["type"] == "action_done")
        .unwrap();
    assert_eq!(journal_done["warnings"][0]["code"], "metadata_mismatch");
    assert!(journal_done["warnings"][0]["detail"].is_string());

    let deletion = Fixture::new();
    deletion.write_dest("gone.txt", "gone");
    deletion.write_dest(".gone.txt.vibesync-tmp-old-run", "abandoned");
    deletion.add_photos_pair();
    let deletion_output = deletion
        .cmd()
        .args(["run", "photos", "--json", "--yes", "--allow-empty-source"])
        .output()
        .unwrap();
    assert_eq!(deletion_output.status.code(), Some(EXIT_OK));
    let deletion_rows: Vec<serde_json::Value> = String::from_utf8(deletion_output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let deleted = deletion_rows
        .iter()
        .find(|row| row["type"] == "action_done" && row["op"] == "delete")
        .unwrap();
    assert_eq!(deleted["op"], "delete");
    assert_eq!(deleted["result"], "done");
    assert!(deleted["safety_net"].as_str().is_some());
    assert!(deleted["verified"].is_null());
    assert_eq!(deleted["warnings"], serde_json::json!([]));
    let cleanup = deletion_rows
        .iter()
        .find(|row| row["type"] == "action_done" && row["op"] == "cleanup")
        .expect("cleanup emits action_done");
    assert!(cleanup["verified"].is_null());
    assert!(cleanup["safety_net"].is_null());
    assert_eq!(cleanup["warnings"], serde_json::json!([]));

    let interrupted = Fixture::new();
    interrupted.write_source("crash.txt", "contents");
    interrupted.add_photos_pair();
    let interrupted_output = interrupted
        .cmd()
        .env("VIBESYNC_TEST_CRASH_AT", "copy_complete")
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();
    assert!(!interrupted_output.status.success());
    let interrupted_rows: Vec<serde_json::Value> = String::from_utf8(interrupted_output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(interrupted_rows[0]["type"], "run_start");
    assert_eq!(interrupted_rows[1]["type"], "action_start");
    assert!(interrupted_rows
        .iter()
        .all(|row| row["schema"] == "vibefilesync.run/v1"));
    assert!(!interrupted_rows.iter().any(|row| row["type"] == "summary"));
}

// --- Slice 10: Verification and Expected degradations (issue #24) ---

#[cfg(feature = "fault-injection")]
#[test]
fn full_verification_rejects_corrupt_temp_without_publishing_and_continues() {
    let fx = Fixture::new();
    fx.write_source("corrupt.bin", "ABCD");
    fx.write_source("later.txt", "still copied");
    fx.write_dest("corrupt.bin", "old destination");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:if [ \"$VIBESYNC_TEST_RELATIVE_PATH\" = corrupt.bin ]; then printf WXYZ > \"$VIBESYNC_TEST_TEMP\"; fi",
        )
        .args(["run", "photos", "--json", "--yes", "--verify"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_PARTIAL));
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let failed = rows
        .iter()
        .find(|row| row["type"] == "action_failed" && row["path"] == "corrupt.bin")
        .unwrap();
    assert_eq!(failed["reason"], "verify_mismatch");
    assert!(fx.only_journal_events("photos").iter().any(|row| {
        row["type"] == "action_failed"
            && row["path"] == "corrupt.bin"
            && row["reason"] == "verify_mismatch"
    }));
    assert!(rows.iter().any(|row| {
        row["type"] == "action_done" && row["path"] == "later.txt" && row["verified"] == "full"
    }));
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("corrupt.bin")).unwrap(),
        "old destination"
    );
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("later.txt")).unwrap(),
        "still copied"
    );
    assert!(!fx.destination.path().join("_SafetyNet").exists());
    assert!(!fs::read_dir(fx.destination.path())
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".vibesync-tmp-")));
}

#[cfg(feature = "fault-injection")]
#[test]
fn standard_verification_reports_standard_and_does_not_read_back_file_data() {
    let fx = Fixture::new();
    fx.write_source("photo.bin", "ABCD");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:printf WXYZ > \"$VIBESYNC_TEST_TEMP\"",
        )
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let done = rows
        .iter()
        .find(|row| row["type"] == "action_done" && row["path"] == "photo.bin")
        .unwrap();
    assert_eq!(done["verified"], "standard");
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("photo.bin")).unwrap(),
        "WXYZ"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn source_changed_keeps_old_destination_and_next_run_converges() {
    let fx = Fixture::new();
    fx.write_source("report.txt", "planned source");
    fx.write_dest("report.txt", "old destination");
    fx.add_photos_pair();

    let first = fx
        .cmd()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:printf 'new source after copy' > \"$VIBESYNC_TEST_SOURCE\"",
        )
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();

    assert_eq!(first.status.code(), Some(EXIT_PARTIAL));
    let rows: Vec<serde_json::Value> = String::from_utf8(first.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(rows.iter().any(|row| {
        row["type"] == "action_failed"
            && row["path"] == "report.txt"
            && row["reason"] == "source_changed"
    }));
    assert!(fx.only_journal_events("photos").iter().any(|row| {
        row["type"] == "action_failed"
            && row["path"] == "report.txt"
            && row["reason"] == "source_changed"
    }));
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("report.txt")).unwrap(),
        "old destination"
    );
    assert!(!fx.destination.path().join("_SafetyNet").exists());

    let second = fx
        .cmd()
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(EXIT_OK));
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("report.txt")).unwrap(),
        "new source after copy"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn metadata_mismatch_publishes_structured_warning_and_exits_zero() {
    let fx = Fixture::new();
    fx.write_source("metadata.txt", "verified data");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:touch -t 197001010000 \"$VIBESYNC_TEST_TEMP\"",
        )
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let done = rows
        .iter()
        .find(|row| row["type"] == "action_done" && row["path"] == "metadata.txt")
        .unwrap();
    assert_eq!(done["warnings"][0]["code"], "metadata_mismatch");
    assert!(done["warnings"][0]["detail"]
        .as_str()
        .unwrap()
        .contains("modified time"));
    assert_eq!(rows.last().unwrap()["warnings"], 1);
    assert_eq!(rows.last().unwrap()["result"], "success");
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("metadata.txt")).unwrap(),
        "verified data"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn apfs_one_second_mtime_delta_is_an_unexpected_metadata_mismatch() {
    let fx = Fixture::new();
    fx.write_source("metadata.txt", "verified data");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "apfs")
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:touch -A -000001 \"$VIBESYNC_TEST_TEMP\"",
        )
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let done = rows
        .iter()
        .find(|row| row["type"] == "action_done" && row["path"] == "metadata.txt")
        .unwrap();
    assert!(done["warnings"].as_array().unwrap().iter().any(|warning| {
        warning["code"] == "metadata_mismatch"
            && warning["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("modified time"))
    }));
}

#[cfg(feature = "fault-injection")]
#[test]
fn unknown_filesystem_metadata_contract_aborts_before_mutation() {
    let fx = Fixture::new();
    fx.write_source("metadata.txt", "new data");
    fx.write_dest("metadata.txt", "old");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "mysteryfs")
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_PRECONDITION));
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("unknown timestamp granularity for filesystem 'mysteryfs'"));
    assert!(output.stdout.is_empty());
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("metadata.txt")).unwrap(),
        "old"
    );
    assert!(!fx.destination.path().join("_SafetyNet").exists());
}

// --- Slice 11: Generic transition fault injection (issue #25) ---

#[cfg(feature = "fault-injection")]
#[test]
fn crash_at_temp_created_kills_the_real_binary_before_copying_data() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "complete source data");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env("VIBESYNC_TEST_CRASH_AT", "temp_created")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();

    assert!(!output.status.success(), "the real binary must abort");
    assert!(!fx.destination.path().join("new.txt").exists());
    let temps: Vec<_> = fs::read_dir(fx.destination.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".new.txt.vibesync-tmp-")
        })
        .collect();
    assert_eq!(temps.len(), 1, "the named temp must be externally visible");
    assert_eq!(fs::metadata(&temps[0]).unwrap().len(), 0);
}

#[cfg(feature = "fault-injection")]
#[test]
fn exec_at_runs_at_every_named_copy_transition() {
    for transition in [
        "temp_created",
        "copy_complete",
        "verify_complete",
        "source_revalidated",
        "archived",
        "publish_complete",
        "action_done_written",
    ] {
        let fx = Fixture::new();
        fx.write_source("file.txt", "new content");
        if transition == "archived" {
            fx.write_dest("file.txt", "old content");
        }
        fx.add_photos_pair();
        let marker = fx.home.path().join(format!("{transition}.marker"));
        let command = format!(
            "printf '%s' \"$VIBESYNC_TEST_TRANSITION\" > '{}'",
            marker.display()
        );

        let output = fx
            .cmd()
            .env("VIBESYNC_TEST_EXEC_AT", format!("{transition}:{command}"))
            .args(["run", "photos", "--yes"])
            .output()
            .unwrap();

        assert_eq!(
            output.status.code(),
            Some(EXIT_OK),
            "{transition}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(marker).unwrap_or_default(),
            transition,
            "EXEC_AT did not run at {transition}"
        );
    }
}

#[cfg(feature = "fault-injection")]
#[test]
fn crash_at_archived_keeps_the_old_version_in_safetynet() {
    let fx = Fixture::new();
    fx.write_source("file.txt", "new content");
    fx.write_dest("file.txt", "old content");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env("VIBESYNC_TEST_CRASH_AT", "archived")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();

    assert!(!output.status.success(), "the real binary must abort");
    assert!(!fx.destination.path().join("file.txt").exists());
    let archived: Vec<_> = fs::read_dir(fx.destination.path().join("_SafetyNet"))
        .unwrap()
        .map(|entry| entry.unwrap().path().join("file.txt"))
        .collect();
    assert_eq!(archived.len(), 1);
    assert_eq!(fs::read_to_string(&archived[0]).unwrap(), "old content");
}

#[cfg(not(feature = "fault-injection"))]
#[test]
fn fault_injection_environment_is_absent_without_the_feature() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "complete source data");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env("VIBESYNC_TEST_CRASH_AT", "temp_created")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("new.txt")).unwrap(),
        "complete source data"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn release_binary_with_fault_feature_contains_no_environment_hooks() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let status = ProcessCommand::new("cargo")
        .current_dir(manifest)
        .args([
            "build",
            "--release",
            "--locked",
            "--features",
            "fault-injection",
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| manifest.join("target"));
    let binary = fs::read(target.join("release/vibesync")).unwrap();

    for hook in [
        "VIBESYNC_TEST_CRASH_AT",
        "VIBESYNC_TEST_EXEC_AT",
        "VIBESYNC_TEST_FILESYSTEM_TYPE",
        "VIBESYNC_TEST_AVAILABLE_BYTES",
        "VIBESYNC_TEST_ENOSPC_PATH",
        "VIBESYNC_TEST_WARNING_PATH",
        "VIBESYNC_TEST_COPY_CHUNK_DELAY_MS",
        "VIBESYNC_TEST_TRANSITION",
        "VIBESYNC_TEST_RELATIVE_PATH",
        "VIBESYNC_TEST_SOURCE",
        "VIBESYNC_TEST_TEMP",
        "VIBESYNC_TEST_DESTINATION",
        "VIBESYNC_TEST_SAFETY_NET",
    ] {
        assert!(
            !binary
                .windows(hook.len())
                .any(|bytes| bytes == hook.as_bytes()),
            "release binary exposes {hook}"
        );
    }
}

#[cfg(feature = "fault-injection")]
#[test]
fn expected_degradations_are_once_per_exfat_run_and_absent_on_apfs() {
    let human = Fixture::new();
    human.write_source("one.txt", "one");
    human.write_source("two.txt", "two");
    human.add_photos_pair();
    let output = human
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(
        stderr.matches("expected destination degradations:").count(),
        1,
        "Expected degradations must be one preflight fact, not per-file noise: {stderr}"
    );
    for code in [
        "posix_permissions",
        "acls",
        "bsd_flags",
        "timestamp_granularity",
    ] {
        assert!(stderr.contains(code), "missing {code}: {stderr}");
    }
    assert!(!stderr.contains("COPY one.txt warning"));
    assert!(!stderr.contains("COPY two.txt warning"));

    let exfat_json = Fixture::new();
    exfat_json.write_source("file.txt", "data");
    exfat_json.add_photos_pair();
    let exfat_output = exfat_json
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();
    let exfat_rows: Vec<serde_json::Value> = String::from_utf8(exfat_output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        exfat_rows[0]["degradations"],
        serde_json::json!([
            "posix_permissions",
            "acls",
            "bsd_flags",
            "timestamp_granularity"
        ])
    );
    assert!(exfat_rows
        .iter()
        .filter(|row| row["type"] == "action_done")
        .all(|row| row["warnings"] == serde_json::json!([])));

    let apfs_json = Fixture::new();
    apfs_json.write_source("file.txt", "data");
    apfs_json.add_photos_pair();
    let apfs_output = apfs_json
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "apfs")
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();
    let apfs_start: serde_json::Value = serde_json::from_str(
        String::from_utf8(apfs_output.stdout)
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(apfs_start["degradations"], serde_json::json!([]));
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

// --- Slice 13: TUI review and confirmation (issue #27, ADR-0003) ---

#[test]
fn tui_confirmation_executes_the_reviewed_plan_through_the_run_engine() {
    let fx = Fixture::new();
    fx.write_source("changed.txt", "published by the shared engine");
    fx.write_dest("changed.txt", "old destination version");
    fx.add_photos_pair();

    // Enter advances from action review to confirmation; y confirms.
    let output =
        vibesync_in_tty_with_input(fx.xdg.path(), fx.home.path(), &["tui", "photos"], b"\ry");

    assert!(
        output.status.success(),
        "TUI failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("changed.txt")).unwrap(),
        "published by the shared engine"
    );
    let run_folder = fs::read_dir(fx.destination.path().join("_SafetyNet"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        fs::read_to_string(run_folder.join("changed.txt")).unwrap(),
        "old destination version",
        "TUI confirmation must retain replaced versions through SafetyNet"
    );
    assert_eq!(
        fs::read_dir(fx.journal_dir("photos")).unwrap().count(),
        2,
        "the shared run engine writes one Journal plus its live lock file"
    );
    let journal = fs::read_dir(fx.journal_dir("photos"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "ndjson")
        })
        .unwrap();
    let journal = fs::read_to_string(journal).unwrap();
    assert!(journal.contains("\"type\":\"action_done\""));
    assert!(journal.contains("\"safety_net\""));
}

#[test]
fn tui_exclusion_applies_to_one_run_and_is_not_persisted() {
    let fx = Fixture::new();
    fx.write_source("later.txt", "still needs copying");
    fx.add_photos_pair();

    // Space excludes the selected row, Enter advances, y confirms.
    let output =
        vibesync_in_tty_with_input(fx.xdg.path(), fx.home.path(), &["tui", "photos"], b" \ry");
    assert!(output.status.success());
    assert!(!fx.destination.path().join("later.txt").exists());

    let next_plan = fx
        .cmd()
        .args(["plan", "photos"])
        .output()
        .expect("plan runs after TUI exclusion");
    assert_eq!(next_plan.status.code(), Some(EXIT_OK));
    assert!(
        String::from_utf8(next_plan.stdout)
            .unwrap()
            .contains("later.txt"),
        "TUI exclusions must never persist"
    );
}

#[test]
fn tui_does_not_execute_an_action_that_appears_after_review_started() {
    let fx = Fixture::new();
    fx.write_source("reviewed.txt", "reviewed before the TUI opened");
    fx.add_photos_pair();

    let output = vibesync_in_tty_with_input_after_start(
        fx.xdg.path(),
        fx.home.path(),
        &["tui", "photos"],
        b"\ry",
        &[],
        || fx.write_source("unreviewed.txt", "appeared during review"),
    );

    assert!(output.status.success());
    assert!(fx.destination.path().join("reviewed.txt").is_file());
    assert!(
        !fx.destination.path().join("unreviewed.txt").exists(),
        "an action absent from the displayed plan must wait for another run"
    );
}

#[test]
fn cli_and_tui_can_both_exclude_a_reviewed_stray_cleanup_for_one_run() {
    let fx = Fixture::new();
    let stray = ".note.vibesync-tmp-stale-run";
    fx.write_dest(stray, "retain for this reviewed run");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args(["run", "photos", "--yes", "--exclude", stray])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert!(fx.destination.path().join(stray).is_file());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("exclude path not found"),
        "a cleanup row printed by plan is an exact excludable plan path"
    );
}

#[test]
fn tui_without_a_pair_selects_from_configured_folder_pairs() {
    let fx = Fixture::new();
    fx.write_source("selected.txt", "from the selected pair");
    fx.add_pair("photos", "mirror");
    fx.add_pair("documents", "mirror");

    // BTreeMap order puts documents first: select it, review, then confirm.
    let output = vibesync_in_tty_with_input(fx.xdg.path(), fx.home.path(), &["tui"], b"\r\ry");
    assert!(
        output.status.success(),
        "pair selection failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(fx.destination.path().join("selected.txt").is_file());
    assert!(fx.journal_dir("documents").is_dir());
    assert!(!fx.journal_dir("photos").exists());
}

#[cfg(feature = "fault-injection")]
#[test]
fn tui_included_error_blocks_until_the_row_is_excluded() {
    let fx = Fixture::new();
    std::os::unix::fs::symlink("target", fx.source.path().join("link")).unwrap();
    fx.add_photos_pair();

    // Enter confirm; y is blocked; b returns; Space excludes the only row;
    // Enter and y then run the now-valid reviewed subset.
    let output = vibesync_in_tty_with_input_and_env(
        fx.xdg.path(),
        fx.home.path(),
        &["tui", "photos"],
        b"\ryb \ry",
        &[("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")],
    );

    assert!(output.status.success());
    assert!(!fx.destination.path().join("link").exists());
    assert!(
        fs::read_dir(fx.journal_dir("photos")).unwrap().count() >= 2,
        "execution after excluding the error must reach the shared Run engine"
    );
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
        assert!(
            output.contains("V I B E S Y N C"),
            "wordmark missing for {args:?}: {output}"
        );
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

    assert!(
        output.contains("V I B E S Y N C — one-way file sync with SafetyNet · plan → review → run")
    );
    assert!(
        !output.contains("\x1b["),
        "NO_COLOR output must contain no ANSI bytes: {output:?}"
    );
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
        summary_line.contains("1 copy")
            && summary_line.contains("1 update")
            && summary_line.contains("1 delete")
            && summary_line.contains("0 error"),
        "totals summary should lead: {summary_line}"
    );
    assert!(summary_line.to_lowercase().contains("dry-run"));

    // Sections are grouped and ordered COPY, UPDATE, DELETE, ERRORS.
    let copy = stdout.find("COPY").unwrap();
    let update = stdout.find("UPDATE").unwrap();
    let delete = stdout.find("DELETE").unwrap();
    let errors = stdout.find("ERRORS").unwrap();
    assert!(
        copy < update && update < delete && delete < errors,
        "section order: {stdout}"
    );

    assert!(stdout.contains("new.txt"), "COPY row present: {stdout}");
    assert!(
        stdout.contains("changed.txt"),
        "UPDATE row present: {stdout}"
    );
    assert!(
        stdout.contains("old/stale.txt"),
        "DELETE row present: {stdout}"
    );
}

#[test]
fn plan_update_and_delete_sections_carry_the_safetynet_annotation() {
    let fx = Fixture::new();
    fx.write_source("changed.txt", "aaaaaa");
    fx.write_dest("changed.txt", "bb");
    fx.write_dest("gone.txt", "zzz");
    fx.add_photos_pair();

    let stdout =
        String::from_utf8(fx.cmd().args(["plan", "photos"]).output().unwrap().stdout).unwrap();

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

    let stdout =
        String::from_utf8(fx.cmd().args(["plan", "docs"]).output().unwrap().stdout).unwrap();

    // The DELETE section still prints (fixed four-section layout) but is
    // always empty in Update — nothing at the destination is ever removed.
    assert!(stdout.contains("(update)"));
    assert!(
        stdout.contains("0 delete"),
        "Update totals report zero deletes: {stdout}"
    );
    assert!(
        stdout.contains("DELETE (0)"),
        "empty DELETE section still shown: {stdout}"
    );
    assert!(
        !stdout.contains("only-on-dest.txt"),
        "dest-only file must not be a delete row: {stdout}"
    );
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

    let stdout =
        String::from_utf8(fx.cmd().args(["plan", "photos"]).output().unwrap().stdout).unwrap();

    // Machinery content is never a plan row (`_SafetyNet/` still appears in
    // the UPDATE/DELETE header annotation — that's the archive destination,
    // not a synced path — so we check the actual entries, not the prefix).
    assert!(
        !stdout.contains("archived.txt"),
        "SafetyNet contents must never appear: {stdout}"
    );
    assert!(
        !stdout.contains("20200101T000000Z"),
        "SafetyNet run folder must never appear: {stdout}"
    );
    assert!(
        stdout.contains("Stray temps (1)") && stdout.contains(".real.txt.vibesync-tmp-abc123"),
        "strays are reported separately, never as sync content: {stdout}"
    );
    // The only planned action is the real source file (a COPY); nothing is
    // planned for deletion even though the destination is non-empty.
    assert!(
        stdout.contains("1 copy") && stdout.contains("0 delete"),
        "{stdout}"
    );
}

#[test]
fn plan_does_not_expose_a_public_exclude_flag() {
    let fx = Fixture::new();
    fx.write_source("keep.txt", "aaaa");
    fx.write_source("skip.txt", "aaaa");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args(["plan", "photos", "--exclude", "skip.txt"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    assert!(String::from_utf8_lossy(&output.stderr).contains("unexpected argument '--exclude'"));
}

#[test]
fn run_excludes_exact_plan_json_paths_and_reports_unknown_paths() {
    let fx = Fixture::new();
    fx.write_source("keep.txt", "keep");
    fx.write_source("skip.txt", "skip");
    fx.write_dest("remove.txt", "old");
    fx.add_photos_pair();

    let plan = fx
        .cmd()
        .args(["plan", "photos", "--json"])
        .output()
        .unwrap();
    assert_eq!(plan.status.code(), Some(EXIT_OK));
    let paths: Vec<String> = String::from_utf8(plan.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|row| row["type"] == "action")
        .map(|row| row["path"].as_str().unwrap().to_owned())
        .collect();
    assert!(paths.iter().any(|path| path == "skip.txt"));
    assert!(paths.iter().any(|path| path == "remove.txt"));

    let output = fx
        .cmd()
        .args([
            "run",
            "photos",
            "--yes",
            "--exclude",
            "skip.txt",
            "--exclude",
            "remove.txt",
            "--exclude",
            "missing.txt",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("keep.txt")).unwrap(),
        "keep"
    );
    assert!(!fx.destination.path().join("skip.txt").exists());
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("remove.txt")).unwrap(),
        "old"
    );
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("exclude path not found in plan: missing.txt"));
}

#[test]
fn exclusions_only_match_unfiltered_action_and_error_rows() {
    let fx = Fixture::new();
    fx.write_source("unchanged.txt", "same");
    fs::hard_link(
        fx.source.path().join("unchanged.txt"),
        fx.destination.path().join("unchanged.txt"),
    )
    .unwrap();
    fx.write_dest("destination-only.txt", "existing");
    fx.add_pair("photos", "update");

    let output = fx
        .cmd()
        .args([
            "run",
            "photos",
            "--yes",
            "--exclude",
            "unchanged.txt",
            "--exclude",
            "destination-only.txt",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("unchanged 1"), "{stdout}");
    assert!(stdout.contains("excluded 0"), "{stdout}");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("exclude path not found in plan: unchanged.txt"),
        "{stderr}"
    );
    assert!(
        stderr.contains("exclude path not found in plan: destination-only.txt"),
        "{stderr}"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn included_error_blocks_yes_and_interactive_runs_until_excluded() {
    let fx = Fixture::new();
    fx.write_source("safe.txt", "safe");
    std::os::unix::fs::symlink("target", fx.source.path().join("link")).unwrap();
    fx.add_photos_pair();
    let before = Fixture::snapshot(fx.destination.path());

    let blocked_yes = fx
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();
    assert_eq!(blocked_yes.status.code(), Some(EXIT_BLOCKED_PLAN));
    assert_eq!(Fixture::snapshot(fx.destination.path()), before);

    let blocked_interactive = fx
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .args(["run", "photos"])
        .write_stdin("yes\n")
        .output()
        .unwrap();
    assert_eq!(blocked_interactive.status.code(), Some(EXIT_BLOCKED_PLAN));
    assert_eq!(Fixture::snapshot(fx.destination.path()), before);

    fx.cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .args(["run", "photos", "--yes", "--exclude", "link"])
        .assert()
        .success();
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("safe.txt")).unwrap(),
        "safe"
    );
    assert!(!fx.destination.path().join("link").exists());
}

#[cfg(feature = "fault-injection")]
#[test]
fn included_plan_error_takes_precedence_over_a_failing_run_precondition() {
    let fx = Fixture::new();
    fx.write_source("safe.txt", "safe");
    std::os::unix::fs::symlink("target", fx.source.path().join("link")).unwrap();
    fx.add_photos_pair();
    let before = Fixture::snapshot(fx.destination.path());

    let output = fx
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .env("VIBESYNC_TEST_AVAILABLE_BYTES", "0")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_BLOCKED_PLAN));
    assert_eq!(Fixture::snapshot(fx.destination.path()), before);
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("run blocked by 1 plan error(s)"));
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

    assert_eq!(
        src_before,
        Fixture::snapshot(fx.source.path()),
        "plan wrote to the source"
    );
    assert_eq!(
        dst_before,
        Fixture::snapshot(fx.destination.path()),
        "plan wrote to the destination"
    );
}

#[test]
fn plan_for_an_unknown_pair_is_a_usage_error_exit_64() {
    let fx = Fixture::new();
    let output = fx.cmd().args(["plan", "nope"]).output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("nope"),
        "error should name the pair: {stderr}"
    );
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
    assert!(
        stdout.starts_with("Dry-run for 'photos'"),
        "review must print first: {stdout}"
    );
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("nested/photo.txt")).unwrap(),
        "the complete photo"
    );
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

    fx.cmd()
        .args(["run", "photos", "--yes", "--allow-empty-source"])
        .assert()
        .success();

    assert_eq!(
        fs::read_to_string(fx.destination.path().join("document.txt")).unwrap(),
        "complete contents"
    );
    let names: Vec<_> = fs::read_dir(fx.destination.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().all(|name| !name.contains(".vibesync-tmp-")),
        "no temporary file may be published: {names:?}"
    );
}

#[test]
fn a_failed_copy_stops_remaining_mutations() {
    let fx = Fixture::new();
    fx.write_source("blocked.txt", "would be partial if published");
    fx.write_source("good.txt", "this copy should still finish");
    // Invisible machinery makes this directory non-empty without creating a
    // reviewed DELETE row. The run must preserve it and stop before later work.
    fs::create_dir_all(fx.destination.path().join("blocked.txt/_SafetyNet")).unwrap();
    fx.write_dest("would-be-deleted.txt", "keep me");
    fx.add_photos_pair();

    let output = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(fx.destination.path().join("blocked.txt").is_dir());
    assert!(
        !fx.destination.path().join("good.txt").exists(),
        "a copy failure must stop later copies"
    );
    assert!(
        fx.destination.path().join("would-be-deleted.txt").exists(),
        "a copy failure must stop Mirror deletions"
    );
    assert!(
        fs::read_dir(fx.destination.path())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".vibesync-tmp-")),
        "a failed file must not leave a publishable temp"
    );
}

#[test]
fn run_preserves_a_source_xattr_through_copyfile() {
    let fx = Fixture::new();
    fx.write_source("tagged.txt", "complete contents");
    let source = fx.source.path().join("tagged.txt");
    let status = std::process::Command::new("xattr")
        .args([
            "-w",
            "com.vibesync.slice3",
            "kept",
            source.to_str().unwrap(),
        ])
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
    assert!(
        value.status.success(),
        "copyfile must preserve source xattrs"
    );
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

    assert_eq!(
        fs::read_to_string(fx.destination.path().join("report.txt")).unwrap(),
        "new version"
    );
    let archive = fx.destination.path().join("_SafetyNet");
    let run_folders: Vec<_> = fs::read_dir(&archive)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(run_folders.len(), 1, "one Run folder is created");
    assert_eq!(
        fs::read_to_string(run_folders[0].join("report.txt")).unwrap(),
        "old version"
    );
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
    assert_eq!(
        fs::read_to_string(run.join("report.txt")).unwrap(),
        "old version"
    );
}

#[test]
fn mirror_deletion_archives_old_file_and_leaves_safetynet_untouched() {
    let fx = Fixture::new();
    fx.write_dest("removed.txt", "old version");
    fx.write_dest("_SafetyNet/older-run/kept.txt", "already archived");
    fx.add_photos_pair();

    fx.cmd()
        .args(["run", "photos", "--yes", "--allow-empty-source"])
        .assert()
        .success();

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
    assert_eq!(
        fs::read_to_string(new_archives[0].join("removed.txt")).unwrap(),
        "old version"
    );
}

#[test]
fn permanent_delete_bypasses_safetynet_for_this_run() {
    let fx = Fixture::new();
    fx.write_dest("removed.txt", "old version");
    fx.add_photos_pair();

    fx.cmd()
        .args([
            "run",
            "photos",
            "--yes",
            "--allow-empty-source",
            "--permanent-delete",
        ])
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
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("current.txt")).unwrap(),
        "current"
    );
}

// --- Slice 6: deterministic run preconditions (issue #20) ---

#[test]
fn mirror_empty_source_against_a_nonempty_destination_aborts_unless_overridden() {
    let fx = Fixture::new();
    fx.write_dest("would-be-deleted.txt", "keep me");
    fx.add_photos_pair();

    let blocked = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();
    assert_eq!(blocked.status.code(), Some(EXIT_PRECONDITION));
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("--allow-empty-source"));
    assert!(fx.destination.path().join("would-be-deleted.txt").exists());

    fx.cmd()
        .args(["run", "photos", "--yes", "--allow-empty-source"])
        .assert()
        .success();
    assert!(!fx.destination.path().join("would-be-deleted.txt").exists());
}

#[test]
fn missing_pinned_volume_aborts_plan_before_scanning() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "contents");
    fx.add_photos_pair();
    let path = config_file(fx.xdg.path());
    let contents = fs::read_to_string(&path).unwrap().replace(
        "source_volume_uuid = \"",
        "source_volume_uuid = \"00000000-0000-0000-0000-000000000000#",
    );
    // Keep valid TOML while changing only the pinned UUID.
    fs::write(&path, contents.replace("#", "")).unwrap();

    let output = fx.cmd().args(["plan", "photos"]).output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_PRECONDITION));
    assert!(String::from_utf8_lossy(&output.stderr).contains("not mounted"));
    assert!(!fx.destination.path().join("new.txt").exists());
}

#[test]
fn run_warns_about_existing_safetynet_size() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "contents");
    fx.write_dest("_SafetyNet/old-run/old.txt", "archived bytes");
    fx.add_photos_pair();

    let output = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("_SafetyNet/ uses"),
        "warning missing: {stderr}"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn insufficient_space_aborts_before_mutation_and_its_override_runs_the_copy() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "contents");
    fx.add_photos_pair();

    let blocked = fx
        .cmd()
        .env("VIBESYNC_TEST_AVAILABLE_BYTES", "0")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();
    assert_eq!(blocked.status.code(), Some(EXIT_PRECONDITION));
    assert!(!fx.destination.path().join("new.txt").exists());

    fx.cmd()
        .env("VIBESYNC_TEST_AVAILABLE_BYTES", "0")
        .args(["run", "photos", "--yes", "--ignore-space-check"])
        .assert()
        .success();
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("new.txt")).unwrap(),
        "contents"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn injected_enospc_discards_temp_retains_commits_and_exits_nonzero() {
    let fx = Fixture::new();
    fx.write_source("a-committed.txt", "first");
    fx.write_source("z-full.txt", "second");
    fx.write_dest("would-be-deleted.txt", "keep me");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env("VIBESYNC_TEST_ENOSPC_PATH", "z-full.txt")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("a-committed.txt")).unwrap(),
        "first"
    );
    assert!(!fx.destination.path().join("z-full.txt").exists());
    assert!(
        fx.destination.path().join("would-be-deleted.txt").exists(),
        "a copy failure must stop remaining Mirror deletions"
    );
    let names: Vec<_> = fs::read_dir(fx.destination.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().all(|name| !name.contains(".vibesync-tmp-")),
        "ENOSPC must discard the in-progress temp: {names:?}"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("destination full"),
        "clear disk-full error required: {:?}",
        output.stderr
    );
}

// --- Slice 5: Journal, lock, status, and history (issue #19) ---

#[test]
fn completed_run_journal_correlates_every_event_and_safetynet_folder() {
    let fx = Fixture::new();
    fx.write_source("report.txt", "new version");
    fx.write_dest("report.txt", "old version");
    fx.add_photos_pair();

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    let journals: Vec<_> = fs::read_dir(fx.journal_dir("photos"))
        .expect("run creates the per-pair Journal directory")
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            (path.extension().and_then(|value| value.to_str()) == Some("ndjson")).then_some(path)
        })
        .collect();
    assert_eq!(journals.len(), 1, "one Journal is retained per run");
    let run_id = journals[0].file_stem().unwrap().to_str().unwrap();
    let events: Vec<serde_json::Value> = fs::read_to_string(&journals[0])
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("every Journal line is JSON"))
        .collect();

    assert_eq!(events.first().unwrap()["type"], "run_start");
    assert_eq!(events.last().unwrap()["type"], "summary");
    assert!(events.iter().all(|event| {
        event["schema"] == "vibefilesync.journal/v1" && event["run_id"] == run_id
    }));
    assert!(events
        .iter()
        .any(|event| event["type"] == "action_done" && event["path"] == "report.txt"));
    let action_start = events
        .iter()
        .find(|event| event["type"] == "action_start" && event["path"] == "report.txt")
        .expect("Journal records the in-progress transition");
    assert!(action_start["temp_path"]
        .as_str()
        .is_some_and(|path| path.contains(&format!(".vibesync-tmp-{run_id}"))));
    assert_eq!(action_start["source_identity"]["size"], 11);
    assert!(action_start["source_identity"]["modified_ns"].is_string());
    assert_eq!(
        fs::read_to_string(
            fx.destination
                .path()
                .join("_SafetyNet")
                .join(run_id)
                .join("report.txt")
        )
        .unwrap(),
        "old version"
    );
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("report.txt")).unwrap(),
        "new version",
        "action_done describes content already Published at the process boundary"
    );
}

#[test]
fn pair_lock_rejects_overlap_and_dies_with_a_killed_process() {
    let fx = Fixture::new();
    fx.write_source("photo.txt", "complete photo");
    fx.add_photos_pair();

    let binary = Command::cargo_bin("vibesync").expect("binary builds");
    let mut first = ProcessCommand::new(binary.get_program())
        .args(["run", "photos"])
        .env("XDG_CONFIG_HOME", fx.xdg.path())
        .env("HOME", fx.home.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("first run starts");

    let lock = fx.journal_dir("photos").join(".lock");
    let mut lock_held = false;
    for _ in 0..100 {
        if let Ok(probe) = fs::OpenOptions::new().read(true).write(true).open(&lock) {
            let result = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock
            {
                lock_held = true;
                break;
            }
            if result == 0 {
                unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_UN) };
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(lock_held, "first process acquired the pair lock");

    let before = Fixture::snapshot(fx.destination.path());
    let second = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();
    first.kill().expect("kill lock holder");
    first.wait().expect("reap lock holder");

    assert!(
        lock.exists(),
        "run creates the specified per-pair lock file"
    );
    assert_eq!(second.status.code(), Some(EXIT_PRECONDITION));
    assert!(String::from_utf8_lossy(&second.stderr).contains("run already in progress"));
    assert_eq!(
        Fixture::snapshot(fx.destination.path()),
        before,
        "contending run performs zero destination writes"
    );

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("photo.txt")).unwrap(),
        "complete photo",
        "killing the holder leaves no stale lock"
    );
}

#[test]
fn status_reports_the_latest_summaryless_journal_as_interrupted() {
    let fx = Fixture::new();
    fx.write_dest("kept.txt", "untouched");
    fx.add_photos_pair();
    let journal_dir = fx.journal_dir("photos");
    fs::create_dir_all(&journal_dir).unwrap();
    let run_id = "20991231T235959Z";
    fs::write(
        journal_dir.join(format!("{run_id}.ndjson")),
        format!(
            "{{\"schema\":\"vibefilesync.journal/v1\",\"type\":\"run_start\",\"run_id\":\"{run_id}\",\"pair\":\"photos\",\"planned_actions\":[]}}\n"
        ),
    )
    .unwrap();
    let before = Fixture::snapshot(fx.destination.path());

    let output = fx.cmd().args(["status", "photos"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains(run_id),
        "status identifies the latest run: {stdout}"
    );
    assert!(
        stdout.to_ascii_lowercase().contains("interrupted"),
        "summary-less Journal is interrupted: {stdout}"
    );
    assert_eq!(
        Fixture::snapshot(fx.destination.path()),
        before,
        "status is read-only on the destination"
    );
}

#[test]
fn history_human_lists_runs_with_results_counts_bytes_and_warnings() {
    let fx = Fixture::new();
    fx.write_source("photo.txt", "first");
    fx.add_photos_pair();
    fx.cmd().args(["run", "photos", "--yes"]).assert().success();
    fx.write_source("photo.txt", "a longer second version");
    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    let output = fx.cmd().args(["history", "photos"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Run id") && stdout.contains("Result"));
    assert!(stdout.contains("Done/Planned"));
    assert!(stdout.contains("Bytes") && stdout.contains("Warnings"));
    assert_eq!(
        stdout.matches("success").count(),
        2,
        "both retained runs are listed: {stdout}"
    );
}

#[test]
fn history_json_emits_the_versioned_run_list_shape() {
    let fx = Fixture::new();
    fx.write_source("photo.txt", "five!");
    fx.add_photos_pair();
    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    let output = fx
        .cmd()
        .args(["history", "photos", "--json"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["schema"], "vibefilesync.history/v1");
    assert_eq!(payload["pair"], "photos");
    let runs = payload["runs"]
        .as_array()
        .expect("history contains a run list");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["result"], "success");
    assert_eq!(runs[0]["counts"]["planned"], 1);
    assert_eq!(runs[0]["counts"]["done"], 1);
    assert_eq!(runs[0]["bytes"], 5);
    assert_eq!(runs[0]["warnings"], 0);
    assert!(runs[0]["run_id"].as_str().unwrap().ends_with('Z'));
}

#[test]
fn journal_failure_after_publish_is_an_interrupted_run_not_a_precondition_abort() {
    let fx = Fixture::new();
    fx.write_source("photo.txt", "x");
    fx.add_pair("baseline", "mirror");
    fx.cmd()
        .args(["run", "baseline", "--yes"])
        .assert()
        .success();

    let baseline_journal = fs::read_dir(fx.journal_dir("baseline"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("ndjson"))
        .unwrap();
    let contents = fs::read_to_string(baseline_journal).unwrap();
    let mut file_limit = 0;
    for line in contents.split_inclusive('\n') {
        file_limit += line.len();
        let event: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        if event["type"] == "action_start" {
            break;
        }
    }

    fs::remove_file(fx.destination.path().join("photo.txt")).unwrap();
    fx.add_pair("limited", "mirror");
    let binary = Command::cargo_bin("vibesync").expect("binary builds");
    let mut command = ProcessCommand::new(binary.get_program());
    command
        .args(["run", "limited", "--json", "--yes"])
        .env("XDG_CONFIG_HOME", fx.xdg.path())
        .env("HOME", fx.home.path());
    unsafe {
        command.pre_exec(move || {
            libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
            let limit = libc::rlimit {
                rlim_cur: file_limit as libc::rlim_t,
                rlim_max: file_limit as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }

    let output = command.output().unwrap();

    assert_eq!(
        fs::read_to_string(fx.destination.path().join("photo.txt")).unwrap(),
        "x",
        "the Journal tail fails only after Publish"
    );
    assert_eq!(output.status.code(), Some(EXIT_INTERRUPTED));
    let stream: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(stream[0]["type"], "run_start");
    assert_eq!(stream[1]["type"], "action_start");
    assert!(stream
        .iter()
        .all(|row| row["schema"] == "vibefilesync.run/v1"));
    assert!(!stream.iter().any(|row| row["type"] == "summary"));
    let status = fx.cmd().args(["status", "limited"]).output().unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).contains("interrupted"));
}

// --- Slice 7: convergence (issue #21) ---

#[test]
fn plan_and_status_report_stray_temps_without_destination_writes() {
    let fx = Fixture::new();
    fx.write_source("photo.txt", "published source");
    fx.write_dest(
        ".photo.txt.vibesync-tmp-20260731T120000Z",
        "interrupted temp",
    );
    fx.add_photos_pair();
    let before = Fixture::snapshot(fx.destination.path());

    let plan = fx.cmd().args(["plan", "photos"]).output().unwrap();
    assert_eq!(plan.status.code(), Some(EXIT_OK));
    assert!(String::from_utf8_lossy(&plan.stdout).contains("Stray temps (1)"));
    assert_eq!(
        Fixture::snapshot(fx.destination.path()),
        before,
        "plan wrote to destination"
    );

    let json_plan = fx
        .cmd()
        .args(["plan", "photos", "--json"])
        .output()
        .unwrap();
    assert_eq!(json_plan.status.code(), Some(EXIT_OK));
    let rows: Vec<serde_json::Value> = String::from_utf8(json_plan.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        rows.iter()
            .map(|row| row["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["plan_start", "action", "action", "summary"]
    );
    assert_eq!(rows.last().unwrap()["counts"]["cleanup"], 1);
    assert!(rows.iter().any(|row| {
        row["type"] == "action"
            && row["op"] == "cleanup"
            && row["path"] == ".photo.txt.vibesync-tmp-20260731T120000Z"
    }));
    assert_eq!(
        Fixture::snapshot(fx.destination.path()),
        before,
        "JSON plan wrote to destination"
    );

    let status = fx.cmd().args(["status", "photos"]).output().unwrap();
    assert_eq!(status.status.code(), Some(EXIT_OK));
    assert!(String::from_utf8_lossy(&status.stdout).contains("Stray temps (1)"));
    assert_eq!(
        Fixture::snapshot(fx.destination.path()),
        before,
        "status wrote to destination"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn rerun_cleans_strays_journals_cleanup_and_scans_fresh() {
    let fx = Fixture::new();
    fx.write_source("published.txt", "already published");
    fx.add_photos_pair();
    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    fx.write_source("interrupted.txt", "must be recopied");
    let crashed = fx
        .cmd()
        .env("VIBESYNC_TEST_CRASH_AT", "copy_complete")
        .args(["run", "photos", "--yes"])
        .output()
        .unwrap();
    assert!(
        !crashed.status.success(),
        "fault injection kills the real binary"
    );
    assert!(fs::read_dir(fx.destination.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".interrupted.txt.vibesync-tmp-")
    }));
    let crashed_journal = fs::read_dir(fx.journal_dir("photos"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("ndjson"))
        .find(|path| !fs::read_to_string(path).unwrap().contains("\"summary\""))
        .unwrap();
    assert!(
        !fs::read_to_string(crashed_journal)
            .unwrap()
            .contains("\"summary\""),
        "a killed run remains summary-less"
    );

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    assert_eq!(
        fs::read_to_string(fx.destination.path().join("published.txt")).unwrap(),
        "already published"
    );
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("interrupted.txt")).unwrap(),
        "must be recopied"
    );
    assert!(
        fs::read_dir(fx.destination.path())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".vibesync-tmp-")),
        "the rerun removes the abandoned sibling temp"
    );

    let journal = fs::read_dir(fx.journal_dir("photos"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("ndjson"))
        .find(|path| {
            fs::read_to_string(path)
                .unwrap()
                .contains("\"op\":\"cleanup\"")
        })
        .unwrap();
    let events: Vec<serde_json::Value> = fs::read_to_string(journal)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(events.iter().any(|event| {
        event["type"] == "action_done"
            && event["op"] == "cleanup"
            && event["path"]
                .as_str()
                .is_some_and(|path| path.starts_with(".interrupted.txt.vibesync-tmp-"))
    }));
    assert!(events.iter().any(|event| {
        event["type"] == "action_done" && event["op"] == "cleanup" && event["verified"].is_null()
    }));
    let planned = events
        .iter()
        .find(|event| event["type"] == "run_start")
        .unwrap()["planned_actions"]
        .as_array()
        .unwrap();
    assert_eq!(
        planned.len(),
        2,
        "cleanup is part of the declared run intent"
    );
    assert!(planned.iter().any(|action| {
        action["op"] == "cleanup"
            && action["path"]
                .as_str()
                .is_some_and(|path| path.starts_with(".interrupted.txt.vibesync-tmp-"))
    }));
    assert!(
        planned
            .iter()
            .any(|action| { action["op"] == "copy" && action["path"] == "interrupted.txt" }),
        "fresh scan must not replay published work"
    );

    let status = fx.cmd().args(["status", "photos"]).output().unwrap();
    assert_eq!(status.status.code(), Some(EXIT_OK));
    assert!(
        String::from_utf8_lossy(&status.stdout).contains("Actions: 2 done · 0 failed · 2 planned"),
        "status must retain the journal's cleanup action in its counts"
    );
}

#[cfg(feature = "fault-injection")]
#[test]
fn post_cleanup_new_plan_error_is_partial_and_never_executes_unreviewed_scope() {
    let fx = Fixture::new();
    fx.write_source("drift.txt", "reviewed file");
    fx.write_dest(".abandoned.vibesync-tmp-old-run", "stale temp");
    fx.add_photos_pair();
    let command = format!(
        "rm '{}'; ln -s target '{}'",
        fx.source.path().join("drift.txt").display(),
        fx.source.path().join("drift.txt").display()
    );

    let output = fx
        .cmd()
        .env("VIBESYNC_TEST_FILESYSTEM_TYPE", "exfat")
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            format!("cleanup_complete:{command}"),
        )
        .args(["run", "photos", "--yes", "--json"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_PARTIAL), "{output:?}");
    assert!(!fx
        .destination
        .path()
        .join(".abandoned.vibesync-tmp-old-run")
        .exists());
    assert!(!fx.destination.path().join("drift.txt").exists());
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(rows.iter().any(|row| {
        row["type"] == "action_failed"
            && row["path"] == "drift.txt"
            && row["reason"] == "reconciliation_changed"
    }));
    assert_eq!(rows.last().unwrap()["result"], "partial");
}
