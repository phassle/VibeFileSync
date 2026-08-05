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
#[cfg(feature = "fault-injection")]
use std::io::{BufRead, BufReader};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command as ProcessCommand;
#[cfg(feature = "fault-injection")]
use std::process::Stdio;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

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

/// Like `vibesync_in_tty_with_input`, but also sets the child's working
/// directory — the seam startup-matching scenarios need, since they are
/// entirely about where the tool is launched from.
fn vibesync_in_tty_with_input_and_cwd(
    config_home: &Path,
    home: &Path,
    cwd: &Path,
    args: &[&str],
    input: &[u8],
) -> std::process::Output {
    vibesync_in_tty_with_input_after_start_in(config_home, home, Some(cwd), args, input, &[], || {})
}

/// Bytes crossterm writes when the TUI takes the terminal over. Raw mode is
/// enabled before this is sent (`src/tui.rs:138`), so observing it proves the
/// line discipline can no longer echo or reinterpret a scripted key press.
const TUI_ALTERNATE_SCREEN: &[u8] = b"\x1b[?1049h";
/// Tail of every ratatui frame flush. After the alternate-screen switch it can
/// only come from a completed `terminal.draw`, so it marks the first rendered
/// frame and therefore a TUI parked on its event read. The pseudo-terminal
/// `script` hands the child has no window size, so the frame itself paints no
/// glyphs to match on.
const TUI_FRAME_FLUSHED: &[u8] = b"\x1b[0m";
/// What ratatui emits for `Terminal::clear`. `run_pair_flow` clears exactly
/// once on entering a stage, so past the startup gate this is the only
/// byte-level marker of a stage boundary available: the frames themselves are
/// indistinguishable, since the window-less pseudo-terminal paints no glyphs.
const TUI_SCREEN_CLEARED: &[u8] = b"\x1b[2J";
/// Deliberately generous: startup normally takes single-digit milliseconds, so
/// only a genuinely wedged child should ever reach this ceiling.
const TUI_READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct PipeBuffer {
    bytes: Vec<u8>,
    at_end: bool,
}

/// Drains one of the child's pipes on a background thread. Draining keeps a
/// full pipe from stalling the TUI, and the shared buffer lets a test wait on
/// what the child has actually written rather than guess a startup budget.
struct PipeDrain {
    shared: Arc<(Mutex<PipeBuffer>, Condvar)>,
    reader: std::thread::JoinHandle<()>,
}

impl PipeDrain {
    fn spawn(mut pipe: impl Read + Send + 'static) -> Self {
        let shared = Arc::new((Mutex::new(PipeBuffer::default()), Condvar::new()));
        let sink = Arc::clone(&shared);
        let reader = std::thread::spawn(move || {
            let (buffer, arrived) = &*sink;
            let mut chunk = [0u8; 4096];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        buffer
                            .lock()
                            .expect("pipe buffer is readable")
                            .bytes
                            .extend_from_slice(&chunk[..count]);
                        arrived.notify_all();
                    }
                    // A signal landing mid-read is not end of output. Treating
                    // it as one would report the pipe closed and fail the very
                    // readiness gate this driver exists to make reliable.
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            buffer.lock().expect("pipe buffer is readable").at_end = true;
            arrived.notify_all();
        });
        Self { shared, reader }
    }

    /// Blocks until `marker` appears at or after `from`, returning the offset
    /// just past the match. Returns `None` once the pipe closes without it —
    /// the child exited early — or when `timeout` elapses.
    fn wait_for(&self, marker: &[u8], from: usize, timeout: Duration) -> Option<usize> {
        let (buffer, arrived) = &*self.shared;
        let deadline = Instant::now() + timeout;
        let mut buffer = buffer.lock().expect("pipe buffer is readable");
        loop {
            if let Some(offset) = buffer
                .bytes
                .get(from..)
                .and_then(|tail| tail.windows(marker.len()).position(|run| run == marker))
            {
                return Some(from + offset + marker.len());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if buffer.at_end || remaining.is_zero() {
                return None;
            }
            buffer = arrived
                .wait_timeout(buffer, remaining)
                .expect("pipe buffer is readable")
                .0;
        }
    }

    fn snapshot(&self) -> String {
        let (buffer, _) = &*self.shared;
        let buffer = buffer.lock().expect("pipe buffer is readable");
        String::from_utf8_lossy(&buffer.bytes).into_owned()
    }

    /// Waits for the pipe to close and takes everything it carried.
    fn collect(self) -> Vec<u8> {
        let Self { shared, reader } = self;
        reader.join().expect("pipe drain finishes");
        let mut buffer = shared.0.lock().expect("pipe buffer is readable");
        std::mem::take(&mut buffer.bytes)
    }
}

/// `script` and the TUI share a dedicated process group. Every path that gives
/// up on the child runs this first, so no failure leaves a live PTY behind for
/// later tests to inherit.
fn terminate_process_group(child: &mut std::process::Child) {
    // SAFETY: the negative id targets only the dedicated process group we
    // assign at spawn; the live child still owns that id here.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    for _ in 0..20 {
        if child
            .try_wait()
            .expect("terminated TUI can be polled")
            .is_some()
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // SAFETY: same scoped process group; SIGKILL prevents a broken terminal
    // teardown from hanging the test suite or leaving an orphaned PTY.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
}

fn vibesync_in_tty_with_input_after_start(
    config_home: &Path,
    home: &Path,
    args: &[&str],
    input: &[u8],
    extra_env: &[(&str, &str)],
    before_input: impl FnOnce(),
) -> std::process::Output {
    vibesync_in_tty_with_input_after_start_in(
        config_home,
        home,
        None,
        args,
        input,
        extra_env,
        before_input,
    )
}

fn vibesync_in_tty_with_input_after_start_in(
    config_home: &Path,
    home: &Path,
    cwd: Option<&Path>,
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
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for (name, value) in extra_env {
        command.env(name, value);
    }
    let mut child = command.spawn().expect("script starts a pseudo-terminal");
    let pty = PipeDrain::spawn(child.stdout.take().expect("script stdout is piped"));
    let errors = PipeDrain::spawn(child.stderr.take().expect("script stderr is piped"));

    // ADR-0011: wait on what the child actually wrote instead of assuming a
    // startup budget. A key press sent before the PTY is raw is echoed and
    // reshaped by the line discipline rather than reaching the review loop.
    let taken_over = pty.wait_for(TUI_ALTERNATE_SCREEN, 0, TUI_READY_TIMEOUT);
    let rendered =
        taken_over.and_then(|from| pty.wait_for(TUI_FRAME_FLUSHED, from, TUI_READY_TIMEOUT));
    if rendered.is_none() {
        let stage = if taken_over.is_some() {
            "render its first frame"
        } else {
            "take the terminal"
        };
        // The child never reached its event loop but still owns the process
        // group, so it needs the same bounding a bad key sequence gets.
        terminate_process_group(&mut child);
        panic!(
            "TUI never managed to {stage} for {args:?}: pty {:?}, stderr {:?}",
            pty.snapshot(),
            errors.snapshot()
        );
    }

    before_input();
    child
        .stdin
        .take()
        .expect("script stdin is piped")
        .write_all(input)
        .expect("terminal input is written");

    for _ in 0..100 {
        if let Some(status) = child.try_wait().expect("TUI status can be polled") {
            return std::process::Output {
                status,
                stdout: pty.collect(),
                stderr: errors.collect(),
            };
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    // Bound a bad key sequence without leaving a child PTY behind.
    terminate_process_group(&mut child);
    panic!("TUI did not exit within five seconds for {args:?}");
}

/// Like `vibesync_in_tty_with_input_after_start`, but `between` runs once
/// `first` has driven the TUI through a completed Compare scan and into
/// Review, and before `second` is written — used to land a filesystem change
/// inside a specific stage rather than only before the TUI ever opens.
fn vibesync_in_tty_with_staged_input(
    config_home: &Path,
    home: &Path,
    args: &[&str],
    first: &[u8],
    second: &[u8],
    between: impl FnOnce(),
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
    let mut child = command.spawn().expect("script starts a pseudo-terminal");
    let pty = PipeDrain::spawn(child.stdout.take().expect("script stdout is piped"));
    let errors = PipeDrain::spawn(child.stderr.take().expect("script stderr is piped"));

    // ADR-0011: the same rendezvous the single-input driver uses. Startup is
    // never guessed at here either — a first key press written before the PTY
    // is raw is echoed and reshaped rather than delivered.
    let taken_over = pty.wait_for(TUI_ALTERNATE_SCREEN, 0, TUI_READY_TIMEOUT);
    let rendered =
        taken_over.and_then(|from| pty.wait_for(TUI_FRAME_FLUSHED, from, TUI_READY_TIMEOUT));
    if rendered.is_none() {
        let stage = if taken_over.is_some() {
            "render its first frame"
        } else {
            "take the terminal"
        };
        terminate_process_group(&mut child);
        panic!(
            "TUI never managed to {stage} for {args:?}: pty {:?}, stderr {:?}",
            pty.snapshot(),
            errors.snapshot()
        );
    }

    // The startup gate above returns or panics, so this is always `Some`.
    let started = rendered.expect("startup gate yields the first frame's offset");

    let mut stdin = child.stdin.take().expect("script stdin is piped");
    stdin.write_all(first).expect("first input is written");

    // The staging rendezvous the helper exists for, and ADR-0011 §1 applies
    // here too: `between` must land after Compare captured its plan, not
    // merely a while after `first` was written, or the test silently exercises
    // a different stage than the one it is named for. `run_pair_flow` clears
    // the screen once per stage entry, so past the startup gate the clears are
    // the boundaries: the pane gate proceeding into Compare (`src/tui.rs:1057`),
    // then the finished scan handing its plan to Review (`src/tui.rs:1081`).
    // The next frame flush would not do — Compare draws on entry, before it has
    // even read the key that starts the scan, and again every 50 ms while the
    // scan runs (`src/tui.rs:441`), so a flush proves nothing about progress.
    let comparing = pty.wait_for(TUI_SCREEN_CLEARED, started, TUI_READY_TIMEOUT);
    let reviewing =
        comparing.and_then(|from| pty.wait_for(TUI_SCREEN_CLEARED, from, TUI_READY_TIMEOUT));
    let parked =
        reviewing.and_then(|from| pty.wait_for(TUI_FRAME_FLUSHED, from, TUI_READY_TIMEOUT));
    if parked.is_none() {
        let stage = match (comparing, reviewing) {
            (None, _) => "leave the pane gate",
            (_, None) => "finish comparing",
            _ => "render the review it compared",
        };
        terminate_process_group(&mut child);
        panic!(
            "TUI never managed to {stage} for {args:?}: pty {:?}, stderr {:?}",
            pty.snapshot(),
            errors.snapshot()
        );
    }

    between();
    stdin.write_all(second).expect("second input is written");
    drop(stdin);

    for _ in 0..100 {
        if let Some(status) = child.try_wait().expect("TUI status can be polled") {
            return std::process::Output {
                status,
                stdout: pty.collect(),
                stderr: errors.collect(),
            };
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    // Bound a bad key sequence without leaving a child PTY behind.
    terminate_process_group(&mut child);
    panic!("TUI did not exit within five seconds for {args:?}");
}

fn config_file(config_home: &Path) -> std::path::PathBuf {
    config_home.join("vibesync").join("config.toml")
}

/// Wraps `value` in single quotes for a POSIX shell, escaping any embedded
/// single quotes.
#[cfg(feature = "fault-injection")]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `stty -a` prints disabled flags with a leading `-` (e.g. `-icanon`,
/// `-echo`); an enabled flag appears as the bare token. Tokenizing avoids
/// false positives from related flags that share a prefix, like `echoe` or
/// `echok`.
#[cfg(feature = "fault-injection")]
fn stty_flag_is_enabled(stty_output: &str, flag: &str) -> bool {
    stty_output
        .split(|c: char| c.is_whitespace() || c == ';')
        .any(|token| token == flag)
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
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");

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
fn pair_add_writes_cosmetic_volume_names_into_the_config_file() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let contents = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    assert!(
        contents.contains("source_volume_name"),
        "config should record a cosmetic source volume name: {contents}"
    );
    assert!(
        contents.contains("destination_volume_name"),
        "config should record a cosmetic destination volume name: {contents}"
    );
}

#[test]
fn pair_list_without_check_does_no_volume_io_and_is_byte_identical_to_plain_list() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let baseline = fx.cmd().args(["pair", "list"]).output().unwrap();
    let repeated = fx.cmd().args(["pair", "list"]).output().unwrap();
    assert_eq!(baseline.stdout, repeated.stdout);

    let baseline_json = fx.cmd().args(["pair", "list", "--json"]).output().unwrap();
    let repeated_json = fx.cmd().args(["pair", "list", "--json"]).output().unwrap();
    assert_eq!(baseline_json.stdout, repeated_json.stdout);
    let value: serde_json::Value = serde_json::from_slice(&baseline_json.stdout).unwrap();
    assert!(value["pairs"][0].get("status").is_none());
}

#[test]
fn pair_list_check_reports_ready_state_for_both_sides_in_json() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args(["pair", "list", "--check", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");

    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["pairs"][0]["status"]["source"]["state"], "ready");
    assert_eq!(value["pairs"][0]["status"]["destination"]["state"], "ready");
    assert!(value["pairs"][0]["status"]["source"]["volume"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));
}

#[test]
fn pair_list_check_reports_state_in_the_human_table() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx.cmd().args(["pair", "list", "--check"]).output().unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("STATUS"), "{stdout}");
    assert!(stdout.contains("source"), "{stdout}");
    assert!(stdout.contains("ready"), "{stdout}");
}

#[test]
fn pair_list_check_reports_volume_absent_for_an_unmounted_uuid() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let path = config_file(fx.xdg.path());
    let contents = fs::read_to_string(&path).unwrap();
    let rewritten = contents
        .replacen(
            "destination_volume_uuid = \"",
            "destination_volume_uuid = \"00000000-0000-0000-0000-000000000000#",
            1,
        )
        .replacen(
            &format!("destination = \"{}\"", fx.destination.path().display()),
            "destination = \"/no/such/path/vibesync-volume-absent-test\"",
            1,
        );
    fs::write(&path, rewritten).unwrap();

    let output = fx
        .cmd()
        .args(["pair", "list", "--check", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["pairs"][0]["status"]["destination"]["state"],
        "volume_absent"
    );
}

#[test]
fn pair_list_check_matching_nothing_is_still_an_empty_list_exit_0() {
    let fx = Fixture::new();

    let output = fx
        .cmd()
        .args(["pair", "list", "--check", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["pairs"].as_array().unwrap().len(), 0);
}

#[test]
fn pair_list_source_narrows_to_the_matching_pair_in_json() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args([
            "pair",
            "list",
            "--json",
            "--source",
            fx.source.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let pairs = value["pairs"].as_array().unwrap();
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0]["name"], "photos");
}

#[test]
fn pair_list_source_narrows_to_the_matching_pair_in_the_human_table() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args([
            "pair",
            "list",
            "--source",
            fx.source.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("photos"), "{stdout}");
}

#[test]
fn pair_list_source_excludes_a_pair_when_given_its_destination() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args([
            "pair",
            "list",
            "--json",
            "--source",
            fx.destination.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["pairs"].as_array().unwrap().len(), 0);
}

#[test]
fn pair_list_source_matching_nothing_is_an_empty_list_exit_0() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    let elsewhere = tempfile::tempdir().unwrap();

    let output = fx
        .cmd()
        .args([
            "pair",
            "list",
            "--json",
            "--source",
            elsewhere.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["pairs"].as_array().unwrap().len(), 0);
}

#[test]
fn pair_list_source_matches_even_when_the_recorded_source_path_has_gone_stale() {
    // Mirrors `run_against_a_relocated_volume_records_the_path_it_actually_used`
    // (issue #49): rewrite the stored `source` display path to a stale
    // string while leaving `source_volume_uuid` and
    // `source_volume_relative_path` untouched, since those two fields
    // (not the display path) are what matching is derived from — this is
    // exactly the shape of "the volume got mounted somewhere else".
    let fx = Fixture::new();
    fx.add_photos_pair();

    let path = config_file(fx.xdg.path());
    let original_source = fx.source.path().display().to_string();
    let stale_source = "/Volumes/VibeFileSync-Stale/Photos";
    let config = fs::read_to_string(&path).unwrap().replace(
        &format!("source = \"{original_source}\""),
        &format!("source = \"{stale_source}\""),
    );
    assert_ne!(
        config,
        fs::read_to_string(&path).unwrap(),
        "replacement must have matched"
    );
    fs::write(&path, config).unwrap();

    let output = fx
        .cmd()
        .args([
            "pair",
            "list",
            "--json",
            "--source",
            fx.source.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let pairs = value["pairs"].as_array().unwrap();
    assert_eq!(pairs.len(), 1, "{value}");
    assert_eq!(pairs[0]["name"], "photos");
}

#[test]
fn pair_list_source_matches_a_case_different_spelling_of_the_same_directory() {
    // Identity is decided by (device, inode) from filesystem metadata, not
    // by string comparison, so a case-insensitive volume resolves a
    // case-flipped spelling of the path to the same directory. This is
    // only meaningful on a case-insensitive volume (macOS's default, and
    // the volume backing the system temp dir these fixtures live on); the
    // canary below skips (rather than falsely passing) if that assumption
    // doesn't hold.
    let fx = Fixture::new();
    fx.add_photos_pair();

    let original = fx.source.path().to_str().unwrap().to_string();
    let flipped: String = original
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() {
                c.to_ascii_uppercase()
            } else if c.is_ascii_uppercase() {
                c.to_ascii_lowercase()
            } else {
                c
            }
        })
        .collect();
    assert_ne!(original, flipped, "fixture path must contain letters");

    if fs::metadata(&flipped).is_err() {
        eprintln!(
            "skipping: {flipped} does not resolve, so the backing volume is not \
             case-insensitive here"
        );
        return;
    }

    let output = fx
        .cmd()
        .args(["pair", "list", "--json", "--source", &flipped])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let pairs = value["pairs"].as_array().unwrap();
    assert_eq!(pairs.len(), 1, "{value}");
    assert_eq!(pairs[0]["name"], "photos");
}

#[test]
fn pair_list_source_silently_skips_a_pair_pinned_to_an_unmounted_volume() {
    // A pair whose pinned `source_volume_uuid` matches no currently
    // mounted volume must simply not appear — no error, no warning, exit
    // 0. `matching_source_names` never enumerates mounted volumes; it
    // only compares the pinned UUID against the query target's UUID, so a
    // UUID belonging to nothing mounted is filtered out by that same
    // equality check, with the same silence as a genuinely unmounted
    // volume would produce.
    let fx = Fixture::new();
    fx.add_photos_pair();

    let path = config_file(fx.xdg.path());
    let contents = fs::read_to_string(&path).unwrap();
    let real_uuid = contents
        .lines()
        .find_map(|line| line.strip_prefix("source_volume_uuid = \""))
        .and_then(|rest| rest.strip_suffix('"'))
        .expect("source_volume_uuid present in config")
        .to_string();
    let unmounted_uuid = "00000000-0000-0000-0000-000000000000";
    assert_ne!(real_uuid, unmounted_uuid);
    let config = contents.replace(
        &format!("source_volume_uuid = \"{real_uuid}\""),
        &format!("source_volume_uuid = \"{unmounted_uuid}\""),
    );
    fs::write(&path, config).unwrap();

    let output = fx
        .cmd()
        .args([
            "pair",
            "list",
            "--json",
            "--source",
            fx.source.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.is_empty(), "{stderr}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["pairs"].as_array().unwrap().len(), 0, "{value}");
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
fn pair_add_refuses_an_identical_source_and_destination_exit_64() {
    let fx = Fixture::new();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            fx.source.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("same directory"),
        "error should explain the refusal: {stderr}"
    );
    assert!(!config_file(fx.xdg.path()).exists());
}

#[test]
fn pair_add_refuses_an_identical_pair_even_through_a_case_difference() {
    let fx = Fixture::new();
    let uppercased = fx.source.path().to_str().unwrap().to_ascii_uppercase();
    // Only meaningful on a case-insensitive volume (the macOS default); on a
    // case-sensitive one the uppercased path simply won't resolve, so guard
    // rather than assert a spurious failure.
    if !Path::new(&uppercased).is_dir() {
        return;
    }

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            &uppercased,
            "--mode",
            "mirror",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
}

#[test]
fn pair_add_refuses_an_identical_pair_through_a_symlink() {
    let fx = Fixture::new();
    let alias = fx.home.path().join("alias-to-source");
    std::os::unix::fs::symlink(fx.source.path(), &alias).unwrap();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            alias.to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("same directory"),
        "error should explain the refusal: {stderr}"
    );
}

#[test]
fn pair_add_refuses_a_destination_nested_inside_the_source_in_mirror_mode() {
    let fx = Fixture::new();
    let nested = fx.source.path().join("child");
    fs::create_dir(&nested).unwrap();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            nested.to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("nested"),
        "error should say nested: {stderr}"
    );
}

#[test]
fn pair_add_refuses_a_source_nested_inside_the_destination_in_update_mode() {
    let fx = Fixture::new();
    let nested = fx.destination.path().join("child");
    fs::create_dir(&nested).unwrap();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            nested.to_str().unwrap(),
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
        stderr.contains("nested"),
        "error should say nested: {stderr}"
    );
}

#[test]
fn pair_add_replace_refuses_redefining_a_pair_as_identical() {
    let fx = Fixture::new();
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--replace",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            fx.source.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_USAGE));
    let contents = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    assert!(
        contents.contains(fx.destination.path().to_str().unwrap()),
        "a refused replace must not alter the config: {contents}"
    );
}

#[test]
fn pair_add_warns_when_the_new_destination_overlaps_another_pairs_destination() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    let other_source = tempfile::tempdir().unwrap();
    let nested_destination = fx.destination.path().join("videos-child");
    fs::create_dir(&nested_destination).unwrap();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "videos",
            "--source",
            other_source.path().to_str().unwrap(),
            "--destination",
            nested_destination.to_str().unwrap(),
            "--mode",
            "update",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("photos"),
        "warning should name the other pair: {stderr}"
    );
    let output = fx.cmd().args(["pair", "list", "--json"]).output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["pairs"].as_array().unwrap().len(),
        2,
        "the warning must not block the add"
    );
}

#[test]
fn a_hand_edited_config_with_an_identical_pair_is_caught_at_compare() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    let before = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    let source_str = fx.source.path().to_str().unwrap();
    let destination_str = fx.destination.path().to_str().unwrap();
    let edited = before.replace(destination_str, source_str);
    fs::write(config_file(fx.xdg.path()), edited).unwrap();

    let output = fx.cmd().args(["plan", "photos"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_PRECONDITION));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("same directory"),
        "compare should refuse the self-consuming pair: {stderr}"
    );
}

#[test]
fn a_hand_edited_config_with_an_identical_pair_is_caught_at_run() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    let before = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    let source_str = fx.source.path().to_str().unwrap();
    let destination_str = fx.destination.path().to_str().unwrap();
    let edited = before.replace(destination_str, source_str);
    fs::write(config_file(fx.xdg.path()), edited).unwrap();

    let output = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_PRECONDITION));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("same directory"),
        "run should refuse the self-consuming pair: {stderr}"
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
fn pair_add_without_replace_is_still_a_duplicate_error_when_a_new_destination_is_also_given() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    let other_destination = tempfile::tempdir().unwrap();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            other_destination.path().to_str().unwrap(),
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
    let contents = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    assert!(
        contents.contains(fx.destination.path().to_str().unwrap()),
        "the original destination must survive the rejected add: {contents}"
    );
}

#[test]
fn pair_add_replace_redefines_the_pair_in_one_atomic_save() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    let new_destination = tempfile::tempdir().unwrap();

    fx.cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--replace",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            new_destination.path().to_str().unwrap(),
            "--mode",
            "update",
        ])
        .assert()
        .success();

    let output = fx.cmd().args(["pair", "list", "--json"]).output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let pairs = value["pairs"].as_array().unwrap();
    assert_eq!(pairs.len(), 1, "replace must not create a second pair");
    assert_eq!(pairs[0]["name"], "photos");
    assert_eq!(pairs[0]["mode"], "update");
    assert_eq!(
        pairs[0]["destination"],
        new_destination.path().to_str().unwrap()
    );
}

#[test]
fn pair_add_replace_with_unchanged_paths_repins_uuids_and_refreshes_volume_names() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    let before = fs::read_to_string(config_file(fx.xdg.path())).unwrap();

    fx.cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--replace",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            fx.destination.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .assert()
        .success();

    let after = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    assert!(after.contains("source_volume_uuid"));
    assert!(after.contains("destination_volume_uuid"));
    assert!(after.contains("source_volume_name"));
    assert!(after.contains("destination_volume_name"));
    // The pair's identity (name) and both paths are unchanged.
    assert!(after.contains("[pairs.photos]"));
    assert_eq!(
        before.contains(fx.source.path().to_str().unwrap()),
        after.contains(fx.source.path().to_str().unwrap())
    );
}

#[test]
fn pair_add_replace_keeps_the_pair_name_and_therefore_its_run_history() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    fx.write_source("a.txt", "hello");
    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    let history_before = fx
        .cmd()
        .args(["history", "photos", "--json"])
        .output()
        .unwrap();
    let value_before: serde_json::Value = serde_json::from_slice(&history_before.stdout).unwrap();
    assert!(!value_before["runs"].as_array().unwrap().is_empty());

    let new_destination = tempfile::tempdir().unwrap();
    fx.cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--replace",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            new_destination.path().to_str().unwrap(),
            "--mode",
            "update",
        ])
        .assert()
        .success();

    let history_after = fx
        .cmd()
        .args(["history", "photos", "--json"])
        .output()
        .unwrap();
    assert_eq!(history_after.status.code(), Some(EXIT_OK));
    let value_after: serde_json::Value = serde_json::from_slice(&history_after.stdout).unwrap();
    assert_eq!(
        value_before["runs"].as_array().unwrap().len(),
        value_after["runs"].as_array().unwrap().len(),
        "history for the pair name must survive the replace: {value_after}"
    );
}

#[test]
fn pair_add_replace_on_an_unknown_pair_is_a_usage_error_exit_64() {
    let fx = Fixture::new();

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--replace",
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
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("photos"),
        "error should name the pair: {stderr}"
    );
}

#[test]
fn a_failed_replace_leaves_the_previous_definition_intact() {
    let fx = Fixture::new();
    fx.add_photos_pair();
    let before = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    let missing_source = fx.source.path().join("does-not-exist");

    let output = fx
        .cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--replace",
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
    let after = fs::read_to_string(config_file(fx.xdg.path())).unwrap();
    assert_eq!(before, after, "a failed replace must not alter the config");
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

    let expected = ["a/a.txt", "a/z.txt", "b.txt", "c", "d.txt"];
    assert_eq!(action_paths(), expected);
    assert_eq!(action_paths(), expected);
}

#[cfg(feature = "fault-injection")]
#[test]
fn plan_json_emits_actions_before_the_scan_finishes() {
    let fx = Fixture::new();
    for index in 0..100 {
        fx.write_source(&format!("{index:03}.txt"), "data");
    }
    fx.add_photos_pair();

    let binary = Command::cargo_bin("vibesync").expect("binary builds");
    let mut child = ProcessCommand::new(binary.get_program())
        .args(["plan", "photos", "--json"])
        .env("XDG_CONFIG_HOME", fx.xdg.path())
        .env("HOME", fx.home.path())
        .env("VIBESYNC_TEST_PLAN_SCAN_DELAY_MS", "5")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let start: serde_json::Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    let action: serde_json::Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    assert_eq!(start["type"], "plan_start");
    assert_eq!(action["type"], "action");
    assert!(
        child.try_wait().unwrap().is_none(),
        "first action must cross stdout while later entries are still scanning"
    );
    for line in lines {
        let _: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
    }
    assert_eq!(child.wait().unwrap().code(), Some(EXIT_OK));
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
fn run_against_a_relocated_volume_records_the_path_it_actually_used() {
    let fx = Fixture::new();
    let source = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
    let destination = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
    fs::write(source.path().join("photo.txt"), "photo").unwrap();
    fx.cmd()
        .args([
            "pair",
            "add",
            "photos",
            "--source",
            source.path().to_str().unwrap(),
            "--destination",
            destination.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .assert()
        .success();
    let path = config_file(fx.xdg.path());
    let original_source = source.path().display().to_string();
    let original_destination = destination.path().display().to_string();
    let stale_source = "/Volumes/VibeFileSync-Stale/Photos";
    let stale_destination = "/Volumes/VibeFileSync-Stale/PhotosBackup";
    let config = fs::read_to_string(&path)
        .unwrap()
        .replace(
            &format!("source = \"{original_source}\""),
            &format!("source = \"{stale_source}\""),
        )
        .replace(
            &format!("destination = \"{original_destination}\""),
            &format!("destination = \"{stale_destination}\""),
        );
    fs::write(&path, config).unwrap();

    let output = fx
        .cmd()
        .args(["run", "photos", "--json", "--yes"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains(stale_source), "{stderr}");
    assert!(stderr.contains(stale_destination), "{stderr}");
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("each stdout line is JSON"))
        .collect();
    assert_eq!(rows.first().unwrap()["type"], "run_start");
    let recorded_source = rows[0]["source"].as_str().unwrap();
    assert!(
        recorded_source.ends_with(&original_source),
        "{recorded_source}"
    );
    assert_ne!(recorded_source, stale_source);
    let recorded_destination = rows[0]["destination"].as_str().unwrap();
    assert!(
        recorded_destination.ends_with(&original_destination),
        "{recorded_destination}"
    );
    assert_ne!(recorded_destination, stale_destination);
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
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
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
    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert_eq!(
        fs::read_to_string(unreviewed_directory.destination.path().join("node")).unwrap(),
        "new file"
    );

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
    let plan = machinery_directory
        .cmd()
        .args(["plan", "photos", "--json"])
        .output()
        .unwrap();
    let rows: Vec<serde_json::Value> = String::from_utf8(plan.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(!rows
        .iter()
        .any(|row| { row["type"] == "action" && row["op"] == "delete" && row["path"] == "node" }));
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

/// Pinned against the `vibefilesync.run/v1` stream produced by the
/// pre-refactor `RunReporter` (issue #112): the reporter's internal seam may
/// change, but this NDJSON shape must not. `run_id` is the run's only
/// non-deterministic field, so it is redacted before comparison.
#[test]
fn run_json_output_is_byte_identical_to_the_pinned_reporter_baseline() {
    let fx = Fixture::new();
    fx.write_source("file.txt", "hello world");
    fx.write_source("sub/nested.txt", "nested");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args(["run", "photos", "--yes", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");

    let raw = String::from_utf8(output.stdout).unwrap();
    let run_id = find_run_id(&raw);
    let redacted: Vec<String> = raw
        .lines()
        .map(|line| line.replace(run_id, "RUN_ID"))
        .collect();

    let source = fx.source.path().to_string_lossy().into_owned();
    let destination = fx.destination.path().to_string_lossy().into_owned();
    // `serde_json::Value`'s default `Map` is a `BTreeMap` (this crate does
    // not enable serde_json's `preserve_order` feature), so every object's
    // keys serialize in the same alphabetical order regardless of the
    // insertion order in `src/event.rs`'s `json!()` literals. These
    // expectations are literal bytes, not re-parsed JSON, so a field-order
    // regression in `src/event.rs` fails this assertion directly.
    let expected: Vec<String> = vec![
        format!(
            r#"{{"degradations":[],"destination":"{destination}","mode":"mirror","pair":"photos","planned":2,"planned_actions":[{{"bytes":11,"op":"copy","path":"file.txt"}},{{"bytes":6,"op":"copy","path":"sub/nested.txt"}}],"run_id":"RUN_ID","schema":"vibefilesync.run/v1","source":"{source}","type":"run_start","warnings":["vibesync: warning: _SafetyNet/ uses 0 bytes"]}}"#
        ),
        r#"{"bytes":11,"op":"copy","path":"file.txt","run_id":"RUN_ID","schema":"vibefilesync.run/v1","type":"action_start"}"#.to_string(),
        r#"{"bytes":11,"op":"copy","path":"file.txt","result":"done","run_id":"RUN_ID","safety_net":null,"schema":"vibefilesync.run/v1","type":"action_done","verified":"standard","warnings":[]}"#.to_string(),
        r#"{"bytes":6,"op":"copy","path":"sub/nested.txt","run_id":"RUN_ID","schema":"vibefilesync.run/v1","type":"action_start"}"#.to_string(),
        r#"{"bytes":6,"op":"copy","path":"sub/nested.txt","result":"done","run_id":"RUN_ID","safety_net":null,"schema":"vibefilesync.run/v1","type":"action_done","verified":"standard","warnings":[]}"#.to_string(),
        r#"{"bytes":17,"counts":{"copied":2,"deleted":0,"done":2,"failed":0,"planned":2,"updated":0},"discovered_after_review":0,"result":"success","run_id":"RUN_ID","schema":"vibefilesync.run/v1","type":"summary","warnings":0}"#.to_string(),
    ];

    assert_eq!(
        redacted, expected,
        "run --json NDJSON stream must stay byte-identical (including field order) across the reporter refactor"
    );
}

/// Locates the run's `run_id` value by a raw substring search rather than a
/// JSON parse, so the byte-identity assertion above never routes through
/// `serde_json::Value` (which would silently re-normalize field order).
fn find_run_id(raw: &str) -> &str {
    let key = "\"run_id\":\"";
    let key_start = raw.find(key).expect("a run_id field is present");
    let rest = &raw[key_start + key.len()..];
    let end = rest.find('"').expect("run_id value is quoted");
    &rest[..end]
}

#[cfg(feature = "fault-injection")]
#[test]
fn structural_replacement_gate_failure_leaves_destination_and_safetynet_untouched() {
    for (source_path, destination_path, destination_is_directory) in
        [("docs/new.txt", "docs", false), ("node", "node", true)]
    {
        let fx = Fixture::new();
        fx.write_source(source_path, "new verified bytes");
        if destination_is_directory {
            fs::create_dir(fx.destination.path().join(destination_path)).unwrap();
        } else {
            fx.write_dest(destination_path, "old destination");
        }
        fx.add_photos_pair();

        let output = fx
            .cmd()
            .env(
                "VIBESYNC_TEST_EXEC_AT",
                "copy_complete:truncate -s 1 \"$VIBESYNC_TEST_TEMP\"",
            )
            .args(["run", "photos", "--json", "--yes", "--verify"])
            .output()
            .unwrap();

        assert_eq!(output.status.code(), Some(EXIT_PARTIAL), "{output:?}");
        let stream_rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        if destination_is_directory {
            assert!(stream_rows.iter().any(|row| {
                row["type"] == "action_failed"
                    && row["op"] == "delete"
                    && row["path"] == destination_path
                    && row["reason"] == "dependency_failed"
            }));
            let journal_path = fs::read_dir(fx.journal_dir("photos"))
                .unwrap()
                .find(|entry| {
                    entry.as_ref().is_ok_and(|entry| {
                        entry
                            .path()
                            .extension()
                            .is_some_and(|extension| extension == "ndjson")
                    })
                })
                .unwrap()
                .unwrap()
                .path();
            let journal_rows: Vec<serde_json::Value> = fs::read_to_string(journal_path)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert!(journal_rows.iter().any(|row| {
                row["type"] == "action_failed"
                    && row["op"] == "delete"
                    && row["path"] == destination_path
                    && row["reason"] == "dependency_failed"
            }));
        }
        if destination_is_directory {
            assert!(fx.destination.path().join(destination_path).is_dir());
        } else {
            assert_eq!(
                fs::read_to_string(fx.destination.path().join(destination_path)).unwrap(),
                "old destination"
            );
        }
        assert!(!fx.destination.path().join("_SafetyNet").exists());
    }
}

#[cfg(feature = "fault-injection")]
#[test]
fn structural_delete_has_one_lifecycle_across_multiple_dependent_copies() {
    let fx = Fixture::new();
    fx.write_source("docs/a.txt", "first");
    fx.write_source("docs/b.txt", "second");
    fx.write_dest("docs", "old blocker");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:test \"$VIBESYNC_TEST_RELATIVE_PATH\" != \"docs/a.txt\" || truncate -s 1 \"$VIBESYNC_TEST_TEMP\"",
        )
        .args(["run", "photos", "--json", "--yes", "--verify"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(EXIT_PARTIAL), "{output:?}");
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let delete_events: Vec<_> = rows
        .iter()
        .filter(|row| row["op"] == "delete" && row["path"] == "docs")
        .map(|row| row["type"].as_str().unwrap())
        .collect();
    assert_eq!(delete_events, ["action_start", "action_done"]);
    assert!(!fx.destination.path().join("docs/a.txt").exists());
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("docs/b.txt")).unwrap(),
        "second"
    );
}

#[test]
fn plan_json_matches_run_review_for_nonempty_structural_replacement() {
    let fx = Fixture::new();
    fx.write_source("node", "new file");
    fx.write_dest("node/subdir/old.txt", "old file");
    fx.add_photos_pair();

    let plan = fx
        .cmd()
        .args(["plan", "photos", "--json"])
        .output()
        .unwrap();
    assert_eq!(plan.status.code(), Some(EXIT_OK));
    let rows: Vec<serde_json::Value> = String::from_utf8(plan.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let actions: Vec<_> = rows
        .iter()
        .filter(|row| row["type"] == "action")
        .map(|row| (row["op"].clone(), row["path"].clone()))
        .collect();
    assert_eq!(
        actions,
        [
            (serde_json::json!("copy"), serde_json::json!("node")),
            (serde_json::json!("delete"), serde_json::json!("node")),
        ]
    );
    assert_eq!(rows.last().unwrap()["counts"]["scanned"], 3);

    let run = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();
    assert_eq!(run.status.code(), Some(EXIT_OK));
    assert_eq!(
        fs::read_to_string(fx.destination.path().join("node")).unwrap(),
        "new file"
    );
}

#[test]
fn mirror_preserves_empty_directory_shape_while_update_remains_additive() {
    let mirror = Fixture::new();
    fs::create_dir(mirror.source.path().join("source-empty")).unwrap();
    fs::create_dir(mirror.destination.path().join("destination-empty")).unwrap();
    mirror.add_photos_pair();
    let plan = mirror
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
        row["type"] == "action" && row["op"] == "copy" && row["path"] == "source-empty"
    }));
    assert!(rows.iter().any(|row| {
        row["type"] == "action" && row["op"] == "delete" && row["path"] == "destination-empty"
    }));
    assert_eq!(rows.last().unwrap()["counts"]["scanned"], 2);
    let human = mirror.cmd().args(["plan", "photos"]).output().unwrap();
    assert!(String::from_utf8(human.stdout)
        .unwrap()
        .contains("Scanned 2"));
    mirror
        .cmd()
        .args(["run", "photos", "--yes"])
        .assert()
        .success();
    assert!(mirror.destination.path().join("source-empty").is_dir());
    assert!(!mirror.destination.path().join("destination-empty").exists());
    assert!(fs::read_dir(mirror.destination.path().join("_SafetyNet"))
        .unwrap()
        .map(|entry| entry.unwrap().path().join("destination-empty"))
        .any(|path| path.is_dir()));

    let update = Fixture::new();
    fs::create_dir(update.source.path().join("source-empty")).unwrap();
    fs::create_dir(update.destination.path().join("destination-empty")).unwrap();
    update.add_pair("photos", "update");
    update
        .cmd()
        .args(["run", "photos", "--yes"])
        .assert()
        .success();
    assert!(update.destination.path().join("source-empty").is_dir());
    assert!(update.destination.path().join("destination-empty").is_dir());
}

#[test]
fn apfs_run_copies_symlink_identity_without_following_its_target() {
    let fx = Fixture::new();
    let source_link = fx.source.path().join("link");
    std::os::unix::fs::symlink("missing-relative-target", &source_link).unwrap();
    assert!(ProcessCommand::new("xattr")
        .args(["-w", "-s", "com.example.vibesync-test", "link metadata"])
        .arg(&source_link)
        .status()
        .unwrap()
        .success());
    fx.write_dest("link", "old regular file");
    fx.add_photos_pair();

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    let destination = fx.destination.path().join("link");
    assert!(fs::symlink_metadata(&destination)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_link(destination).unwrap(),
        Path::new("missing-relative-target")
    );
    let xattr = ProcessCommand::new("xattr")
        .args(["-p", "-s", "com.example.vibesync-test"])
        .arg(fx.destination.path().join("link"))
        .output()
        .unwrap();
    assert!(xattr.status.success());
    assert_eq!(
        String::from_utf8(xattr.stdout).unwrap().trim(),
        "link metadata"
    );
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
    assert_eq!(
        rows[0]["source"],
        fx.source.path().to_string_lossy().into_owned()
    );
    assert_eq!(
        rows[0]["destination"],
        fx.destination.path().to_string_lossy().into_owned()
    );
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
#[cfg(feature = "fault-injection")]
fn catchable_signal_exits_four_with_summaryless_interrupted_journal() {
    let fx = Fixture::new();
    fs::write(
        fx.source.path().join("large.bin"),
        vec![7_u8; 16 * 1024 * 1024],
    )
    .unwrap();
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
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    for line in lines.by_ref() {
        let row: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        if row["type"] == "progress" && row["bytes"].as_u64().unwrap_or(0) > 0 {
            assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
            break;
        }
    }
    for line in lines {
        let _: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
    }
    assert_eq!(child.wait().unwrap().code(), Some(EXIT_INTERRUPTED));
    assert!(!fx.destination.path().join("large.bin").exists());

    let journal_path = fs::read_dir(fx.journal_dir("photos"))
        .unwrap()
        .find(|entry| {
            entry.as_ref().is_ok_and(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "ndjson")
            })
        })
        .unwrap()
        .unwrap()
        .path();
    let journal = fs::read_to_string(journal_path).unwrap();
    assert!(journal
        .lines()
        .any(|line| line.contains("\"type\":\"action_start\"")));
    assert!(!journal
        .lines()
        .any(|line| line.contains("\"type\":\"summary\"")));
}

#[test]
#[cfg(feature = "fault-injection")]
fn signal_immediately_after_run_start_still_exits_four() {
    let fx = Fixture::new();
    fs::write(
        fx.source.path().join("photo.bin"),
        vec![7_u8; 16 * 1024 * 1024],
    )
    .unwrap();
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
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let start: serde_json::Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    assert_eq!(start["type"], "run_start");
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
    for line in lines {
        let _: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
    }
    assert_eq!(child.wait().unwrap().code(), Some(EXIT_INTERRUPTED));
    assert!(!fx.destination.path().join("photo.bin").exists());
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

/// Lock contention at execute must still exit 2, per ADR-0010's lifecycle:
/// the TUI now returns to Review instead of tearing down the session on
/// contention (see `run::RunOutcome::LockContention`), so the CLI's own exit
/// code on the same contention is a regression guard the TUI change could
/// otherwise silently break. Contention is made genuine by holding the pair's `.lock`
/// file's flock from this test process before invoking the binary, exactly
/// as `journal::PairLock::acquire` would from a concurrent run.
#[test]
fn lock_contention_at_run_exits_two() {
    let fx = Fixture::new();
    fx.write_source("photo.jpg", "contents");
    fx.add_photos_pair();

    let lock_dir = fx.journal_dir("photos");
    fs::create_dir_all(&lock_dir).unwrap();
    let lock_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_dir.join(".lock"))
        .unwrap();
    let locked = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    assert_eq!(locked, 0, "test process must hold the pair lock first");

    let output = fx.cmd().args(["run", "photos", "--yes"]).output().unwrap();

    assert_eq!(output.status.code(), Some(EXIT_PRECONDITION));
    assert!(
        !fx.destination.path().join("photo.jpg").exists(),
        "a run refused for lock contention must not touch the destination"
    );

    drop(lock_file);
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

#[cfg(feature = "fault-injection")]
#[test]
fn run_json_reports_a_file_that_appeared_after_review_as_discovered_after_review() {
    let fx = Fixture::new();
    fx.write_source("reviewed.txt", "reviewed before the run started");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "cleanup_complete:echo -n 'appeared during reconciliation' > \"$VIBESYNC_TEST_SOURCE/unreviewed.txt\"",
        )
        .args(["run", "photos", "--yes", "--json"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK), "{output:?}");
    assert!(fx.destination.path().join("reviewed.txt").is_file());
    assert!(
        !fx.destination.path().join("unreviewed.txt").exists(),
        "an action absent from the reviewed plan must wait for another run"
    );
    let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let summary = rows
        .iter()
        .find(|row| row["type"] == "summary")
        .expect("a summary event is always emitted");
    assert_eq!(summary["discovered_after_review"], 1);
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
        "VIBESYNC_TEST_PLAN_SCAN_DELAY_MS",
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

    // Enter passes the volume-state pane gate; Enter starts Compare; Enter
    // advances from action review to confirmation; y confirms; Enter
    // dismisses the persisted Result stage.
    let output = vibesync_in_tty_with_input(
        fx.xdg.path(),
        fx.home.path(),
        &["tui", "photos"],
        b"\r\r\ry\r",
    );

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
fn tui_shows_preflight_warnings_before_final_confirmation() {
    let fx = Fixture::new();
    fx.write_source("new.txt", "new");
    fx.write_dest("_SafetyNet/old-run/old.txt", "archived bytes");
    fx.add_photos_pair();

    // Enter passes the volume-state pane gate; Enter starts Compare; Enter
    // reaches final confirmation; q cancels without mutation. The preflight
    // warning's rendered text is asserted through the `Terminal<TestBackend>`
    // seam (`tui::tests:: confirm_screen_renders_compare_s_notices`) — a real
    // pty's reported size is not guaranteed in this harness, so text
    // assertions belong to the rendered-content seam, not this end-to-end
    // one.
    let output = vibesync_in_tty_with_input(
        fx.xdg.path(),
        fx.home.path(),
        &["tui", "photos"],
        b"\r\r\rq",
    );
    assert!(output.status.success());
    assert!(!fx.destination.path().join("new.txt").exists());
}

#[test]
fn tui_exclusion_applies_to_one_run_and_is_not_persisted() {
    let fx = Fixture::new();
    fx.write_source("later.txt", "still needs copying");
    fx.add_photos_pair();

    // Enter passes the volume-state pane gate; Enter starts Compare; Space
    // excludes the selected row, Enter advances, y confirms, Enter dismisses
    // the Result stage.
    let output = vibesync_in_tty_with_input(
        fx.xdg.path(),
        fx.home.path(),
        &["tui", "photos"],
        b"\r\r \ry\r",
    );
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

/// Guards ADR-0011 §4: the readiness gate must distinguish a slow child from
/// one that never takes the terminal. Without the pipe-close check this would
/// sit on the full timeout instead of failing immediately.
#[test]
#[should_panic(expected = "TUI never managed to take the terminal")]
fn scripted_input_fails_fast_when_the_child_never_takes_the_terminal() {
    let fx = Fixture::new();
    // A named pair that does not exist is a usage error, so `tui` reports and
    // exits before it starts a terminal session — the driver has no first
    // frame to wait for. (An empty config no longer works as the arrangement:
    // issue #55 made a pairless `tui` open the seeded pane rather than abort.)
    vibesync_in_tty_with_input(fx.xdg.path(), fx.home.path(), &["tui", "missing"], b"q");
}

#[test]
fn tui_does_not_execute_an_action_that_appears_after_review_started() {
    let fx = Fixture::new();
    fx.write_source("reviewed.txt", "reviewed before the TUI opened");
    fx.add_photos_pair();

    // First "\r" passes the volume-state pane gate, the second starts
    // Compare and lets its scan capture the plan; the extra file then lands
    // after that scan, during Review, before the rest of the input (Enter
    // to Confirm, y to run, Enter to dismiss).
    let output = vibesync_in_tty_with_staged_input(
        fx.xdg.path(),
        fx.home.path(),
        &["tui", "photos"],
        b"\r\r",
        b"\ry\r",
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
fn tui_recompares_instead_of_crashing_when_the_pair_definition_changes_during_review() {
    let fx = Fixture::new();
    fx.write_source("reviewed.txt", "reviewed before the pair was redefined");
    fx.add_photos_pair();
    let redefined_destination = tempfile::tempdir().unwrap();

    // First "\r\r" passes the volume-state pane gate and starts Compare,
    // whose scan captures a plan against the original destination. Another
    // process then redefines the pair (`pair add --replace`) before the
    // first execute attempt: "\r" opens Confirm, "y" attempts to run and
    // must be refused instead of crashing the session, discarding the
    // stale plan and returning to Compare. The rest re-compares against the
    // now-current definition and completes normally: "\r" starts the
    // second scan, "\ry" confirms and runs, "\r" dismisses Result.
    let output = vibesync_in_tty_with_staged_input(
        fx.xdg.path(),
        fx.home.path(),
        &["tui", "photos"],
        b"\r\r",
        b"\ry\r\ry\r",
        || {
            fx.cmd()
                .args([
                    "pair",
                    "add",
                    "photos",
                    "--source",
                    fx.source.path().to_str().unwrap(),
                    "--destination",
                    redefined_destination.path().to_str().unwrap(),
                    "--mode",
                    "mirror",
                    "--replace",
                ])
                .assert()
                .success();
        },
    );

    assert!(output.status.success(), "{output:?}");
    assert!(
        !fx.destination.path().join("reviewed.txt").exists(),
        "the stale plan must never reach a run against the original destination"
    );
    assert!(
        redefined_destination.path().join("reviewed.txt").is_file(),
        "the re-compared plan must run against the pair's current definition"
    );
}

#[test]
fn cleanup_is_mandatory_even_when_its_path_is_excluded() {
    let fx = Fixture::new();
    let stray = ".note.vibesync-tmp-stale-run";
    fx.write_dest(stray, "crash debris");
    fx.add_photos_pair();

    let output = fx
        .cmd()
        .args(["run", "photos", "--yes", "--exclude", stray])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(EXIT_OK));
    assert!(!fx.destination.path().join(stray).exists());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("exclude path not found"),
        "mandatory cleanup is outside selectable sync content"
    );
}

#[test]
fn tui_without_a_pair_selects_from_configured_folder_pairs() {
    let fx = Fixture::new();
    fx.write_source("selected.txt", "from the selected pair");
    fx.add_pair("photos", "mirror");
    fx.add_pair("documents", "mirror");

    // BTreeMap order puts documents first: select it, pass the volume-state
    // pane gate, start Compare, review, confirm, then dismiss the persisted
    // Result stage.
    let output =
        vibesync_in_tty_with_input(fx.xdg.path(), fx.home.path(), &["tui"], b"\r\r\r\ry\r");
    assert!(
        output.status.success(),
        "pair selection failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(fx.destination.path().join("selected.txt").is_file());
    assert!(fx.journal_dir("documents").is_dir());
    assert!(!fx.journal_dir("photos").exists());
}

// --- Slice 15: startup seeds from the working directory (issue #55) ---

#[test]
fn tui_started_from_a_pair_source_preselects_it_and_discloses_the_match() {
    let fx = Fixture::new();
    fx.write_source("selected.txt", "from the matched pair");
    fx.add_photos_pair();

    // No pair name and no picker: launching from the pair's source directory
    // preselects it, so the input sequence is identical to `tui photos`
    // (pane gate, Compare, Confirm, run, dismiss Result).
    let output = vibesync_in_tty_with_input_and_cwd(
        fx.xdg.path(),
        fx.home.path(),
        fx.source.path(),
        &["tui"],
        b"\r\r\ry\r",
    );

    assert!(
        output.status.success(),
        "startup match failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fx.destination.path().join("selected.txt").is_file());
    assert!(fx.journal_dir("photos").is_dir());
}

#[cfg(feature = "fault-injection")]
#[test]
fn tui_startup_with_a_single_match_never_enumerates_pair_choices() {
    let fx = Fixture::new();
    fx.write_source("selected.txt", "from the matched pair");
    fx.add_photos_pair();

    // A single working-directory match must preselect without ever
    // building the full picker list, which is what classifies every
    // configured pair's destination (issue #55: "no destination-side I/O").
    // `VIBESYNC_TEST_CRASH_AT=startup_pair_choices` aborts the process if
    // `pair_choices` runs at all, so this only stays green while the
    // preselect branch never reaches it.
    let output = vibesync_in_tty_with_input_after_start_in(
        fx.xdg.path(),
        fx.home.path(),
        Some(fx.source.path()),
        &["tui"],
        b"\r\r\ry\r",
        &[("VIBESYNC_TEST_CRASH_AT", "startup_pair_choices")],
        || {},
    );

    assert!(
        output.status.success(),
        "single-match startup must not enumerate pair choices: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fx.destination.path().join("selected.txt").is_file());
}

/// Issue #46 acceptance criterion 67: a crash must restore the terminal.
/// `TerminalSession::start` is the single guarded entry point and its `Drop`
/// restores raw mode, the alternate screen, and the cursor during unwinding
/// (the crate unwinds by default). `VIBESYNC_TEST_CRASH_AT=panic`, unlike
/// `startup_pair_choices`'s `abort()`, panics rather than aborting, so the
/// unwind actually runs and this test can observe the restoration rather
/// than merely proving a path is unreached.
///
/// The child runs under a shell inside the same `script`-supplied
/// pseudo-terminal, so `stty -a` — run immediately after the panicking
/// process exits — observes whether `disable_raw_mode()` actually ran
/// during unwind, not just whether the process happened to exit.
///
/// Verified by deleting each line of `TerminalSession::drop` in turn:
/// removing `disable_raw_mode()` turns the raw-mode assertions red, and
/// removing `execute!(Show, LeaveAlternateScreen)` turns the alternate-screen
/// assertion red — both independently caught.
///
/// The cursor-show assertion is *not* independently isolated to one line:
/// `execute!(..., Show, LeaveAlternateScreen)` and the standalone
/// `self.terminal.show_cursor()` each emit their own `Show` sequence, so
/// either line alone still satisfies the assertion when the other runs.
/// Deleting `execute!` alone leaves `\x1b[?25h` intact (from
/// `show_cursor()`) and only the alternate-screen assertion goes red;
/// deleting `show_cursor()` alone leaves `\x1b[?25h` intact (from
/// `execute!`'s `Show`) and nothing goes red. The assertion is real — it
/// would fail if cursor restoration were removed entirely — but this
/// double redundancy in production code means no single-line deletion is
/// caught by it. Acknowledged limitation, not silently counted as covered.
#[cfg(feature = "fault-injection")]
#[test]
fn tui_panic_after_terminal_takeover_still_restores_the_terminal() {
    let fx = Fixture::new();

    // The fault fires from inside the seeded-pane loop, right after its
    // first `terminal.draw`, so no scripted key press is needed: the child
    // panics on its own once it has provably taken the terminal over.
    let binary = Command::cargo_bin("vibesync").expect("binary builds");
    let binary_path = binary.get_program().to_str().expect("binary path is utf-8");
    let shell_command = format!(
        "{} tui; echo VIBESYNC_TUI_EXIT=$?; stty -a",
        shell_single_quote(binary_path)
    );
    let output = ProcessCommand::new("script")
        .args(["-q", "/dev/null", "sh", "-c", &shell_command])
        .env("XDG_CONFIG_HOME", fx.xdg.path())
        .env("HOME", fx.home.path())
        .env("VIBESYNC_TEST_CRASH_AT", "terminal_session_started")
        .output()
        .expect("script starts a pseudo-terminal");

    let stdout = String::from_utf8_lossy(&output.stdout);
    // The restore escape sequences land on the same terminal line as this
    // marker (no newline separates the panicking child's last output from
    // the shell's `echo`), so the marker is found by substring, not by
    // scanning whole lines.
    let exit_code: i32 = {
        const MARKER: &str = "VIBESYNC_TUI_EXIT=";
        let start = stdout.find(MARKER).expect("shell echoes the tui exit code") + MARKER.len();
        let digits: String = stdout[start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        digits.parse().expect("exit code is an integer")
    };
    assert_ne!(
        exit_code, 0,
        "fault injection should panic, not exit cleanly: {stdout}"
    );

    // `TUI_ALTERNATE_SCREEN` (`\x1b[?1049h`) is its counterpart: this proves
    // the session guard's `Drop` ran during the panic's unwind rather than
    // being skipped, which is exactly the property criterion 67 protects.
    assert!(
        stdout.contains("\x1b[?1049l"),
        "panic must still leave the alternate screen: {stdout}"
    );
    assert!(
        stdout.contains("\x1b[?25h"),
        "panic must still show the cursor: {stdout}"
    );

    assert!(
        stty_flag_is_enabled(&stdout, "icanon"),
        "panic must still restore canonical (non-raw) mode: {stdout}"
    );
    assert!(
        stty_flag_is_enabled(&stdout, "echo"),
        "panic must still restore terminal echo: {stdout}"
    );
}

#[test]
fn tui_with_no_pairs_configured_opens_the_seeded_pane_instead_of_aborting() {
    let fx = Fixture::new();

    // No pairs exist at all: startup must not abort. `q` dismisses the
    // seeded pane.
    let output = vibesync_in_tty_with_input_and_cwd(
        fx.xdg.path(),
        fx.home.path(),
        fx.source.path(),
        &["tui"],
        b"q",
    );

    assert!(
        output.status.success(),
        "empty-config startup must not abort: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn tui_started_from_a_shared_source_opens_the_picker_with_both_matches() {
    let fx = Fixture::new();
    fx.write_source("shared.txt", "from whichever pair is picked");
    let other_destination = tempfile::tempdir().expect("other destination tempdir");
    fx.add_pair("photos", "mirror");
    fx.cmd()
        .args([
            "pair",
            "add",
            "vault",
            "--source",
            fx.source.path().to_str().unwrap(),
            "--destination",
            other_destination.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .assert()
        .success();

    // Both pairs share this source; the picker still opens (nothing
    // auto-selected). Alphabetically "photos" < "vault", so Enter on the
    // first row picks "photos": pane gate, Compare, Confirm, run, dismiss.
    let output = vibesync_in_tty_with_input_and_cwd(
        fx.xdg.path(),
        fx.home.path(),
        fx.source.path(),
        &["tui"],
        b"\r\r\r\ry\r",
    );

    assert!(
        output.status.success(),
        "shared-source picker failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fx.destination.path().join("shared.txt").is_file());
    assert!(!other_destination.path().join("shared.txt").exists());
}

#[test]
fn tui_with_a_named_pair_never_reads_the_working_directory() {
    let fx = Fixture::new();
    fx.write_source("named.txt", "reached by name, not by directory");
    fx.add_photos_pair();
    let other_source = tempfile::tempdir().expect("unrelated cwd tempdir");
    let other_destination = tempfile::tempdir().expect("unrelated destination tempdir");
    fx.cmd()
        .args([
            "pair",
            "add",
            "vault",
            "--source",
            other_source.path().to_str().unwrap(),
            "--destination",
            other_destination.path().to_str().unwrap(),
            "--mode",
            "mirror",
        ])
        .assert()
        .success();

    // Launched from "vault"'s source directory but naming "photos": the
    // working directory must never be consulted, so this opens "photos"
    // directly rather than preselecting or picking "vault".
    let output = vibesync_in_tty_with_input_and_cwd(
        fx.xdg.path(),
        fx.home.path(),
        other_source.path(),
        &["tui", "photos"],
        b"\r\r\ry\r",
    );

    assert!(
        output.status.success(),
        "named pair launch failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fx.destination.path().join("named.txt").is_file());
    assert!(!other_destination.path().join("named.txt").exists());
}

#[test]
fn tui_started_from_a_pairs_destination_does_not_preselect_it() {
    let fx = Fixture::new();
    fx.write_source("standing_in_destination.txt", "destination is not a match");
    fx.add_photos_pair();

    // Standing in the one configured pair's destination is not a source
    // match (AC6), so this behaves like the no-match, single-choice case:
    // the picker still opens rather than auto-selecting, per AC8.
    let output = vibesync_in_tty_with_input_and_cwd(
        fx.xdg.path(),
        fx.home.path(),
        fx.destination.path(),
        &["tui"],
        b"\r\r\r\ry\r",
    );

    assert!(
        output.status.success(),
        "destination cwd should still reach the picker: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fx
        .destination
        .path()
        .join("standing_in_destination.txt")
        .is_file());
    assert!(fx.journal_dir("photos").is_dir());
}

#[cfg(feature = "fault-injection")]
#[test]
fn tui_included_error_blocks_until_the_row_is_excluded() {
    let fx = Fixture::new();
    std::os::unix::fs::symlink("target", fx.source.path().join("link")).unwrap();
    fx.add_photos_pair();

    // Enter passes the volume-state pane gate; Enter starts Compare; Enter
    // confirm; y is blocked; b returns; Space excludes the only row; Enter
    // and y then run the now-valid reviewed subset; Enter dismisses the
    // persisted Result stage.
    let output = vibesync_in_tty_with_input_and_env(
        fx.xdg.path(),
        fx.home.path(),
        &["tui", "photos"],
        b"\r\r\ryb \ry\r",
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
        // `tui` with zero pairs configured opens the seeded pane rather
        // than exiting immediately (issue #55, AC8), so it needs a `q` to
        // dismiss; the other two surfaces exit on their own.
        let output = if args == &["tui"][..] {
            vibesync_in_tty_with_input(fx.xdg.path(), fx.home.path(), args, b"q")
        } else {
            vibesync_in_tty(fx.xdg.path(), args, false)
        };
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
    assert!(stdout.contains("old"), "DELETE row present: {stdout}");
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
fn retained_journal_run_start_records_resolved_source_and_destination() {
    let fx = Fixture::new();
    fx.write_source("photo.txt", "photo");
    fx.add_photos_pair();

    fx.cmd().args(["run", "photos", "--yes"]).assert().success();

    let journal_path = fs::read_dir(fx.journal_dir("photos"))
        .expect("run creates the per-pair Journal directory")
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            (path.extension().and_then(|value| value.to_str()) == Some("ndjson")).then_some(path)
        })
        .next()
        .expect("one retained Journal exists");
    let events: Vec<serde_json::Value> = fs::read_to_string(&journal_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("every Journal line is JSON"))
        .collect();

    let run_start = events
        .first()
        .expect("Journal records at least the run_start event");
    assert_eq!(run_start["type"], "run_start");
    assert_eq!(
        run_start["source"],
        fx.source.path().to_string_lossy().into_owned()
    );
    assert_eq!(
        run_start["destination"],
        fx.destination.path().to_string_lossy().into_owned()
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
