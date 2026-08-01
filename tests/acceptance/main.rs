//! ADR-0009 process/filesystem acceptance harness. The suite owns exactly
//! one APFS and one exFAT sparse image; every matrix cell gets a fresh Folder
//! pair and destination directory on the applicable mounted image.
#![cfg(debug_assertions)]

use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const CONTENT: &str = "complete source contents\n";

#[derive(Clone, Copy)]
struct Filesystem {
    slug: &'static str,
    hdiutil_name: &'static str,
}

const FILESYSTEMS: [Filesystem; 2] = [
    Filesystem {
        slug: "apfs",
        hdiutil_name: "APFS",
    },
    Filesystem {
        slug: "exfat",
        hdiutil_name: "ExFAT",
    },
];

struct MountedImage {
    _root: tempfile::TempDir,
    mount: PathBuf,
    device: Option<String>,
}

impl MountedImage {
    fn create(filesystem: Filesystem) -> Self {
        let root = tempfile::Builder::new()
            .prefix(&format!("vibesync-{}-acceptance-", filesystem.slug))
            .tempdir()
            .expect("suite image temp directory");
        let mount = root.path().join("mount");
        fs::create_dir(&mount).expect("suite mount point");
        let image = root.path().join("suite.sparseimage");
        // Keep the label below exFAT's volume-label limit.
        let label = format!(
            "VS25{}{}",
            &filesystem.slug[..1],
            std::process::id() % 10_000
        );
        let created = Command::new("hdiutil")
            .args([
                "create",
                "-size",
                "128m",
                "-type",
                "SPARSE",
                "-fs",
                filesystem.hdiutil_name,
                "-volname",
                &label,
                "-ov",
            ])
            .arg(&image)
            .output()
            .expect("hdiutil create starts");
        assert_command_success(&format!("hdiutil create {}", filesystem.slug), &created);

        let attached = Command::new("hdiutil")
            .args(["attach", "-nobrowse", "-noverify", "-plist", "-mountpoint"])
            .arg(&mount)
            .arg(&image)
            .output()
            .expect("hdiutil attach starts");
        assert_command_success("hdiutil attach", &attached);
        let plist = String::from_utf8(attached.stdout).expect("attach plist is UTF-8 XML");
        let device = first_plist_string_after_key(&plist, "dev-entry")
            .expect("attach plist names the exact created device");
        assert!(
            device.starts_with("/dev/disk"),
            "unexpected device returned by hdiutil: {device}"
        );
        assert!(mount.is_dir(), "image mounted at the suite-scoped path");

        Self {
            _root: root,
            mount,
            device: Some(device),
        }
    }

    fn detach(&mut self) -> Result<(), String> {
        let Some(device) = self.device.as_deref() else {
            return Ok(());
        };
        let output = Command::new("hdiutil")
            .args(["detach", device])
            .output()
            .map_err(|error| format!("failed to start hdiutil detach for {device}: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "failed to detach harness-owned device {device}: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        self.device = None;
        Ok(())
    }
}

impl Drop for MountedImage {
    fn drop(&mut self) {
        if let Err(error) = self.detach() {
            eprintln!("{error}");
        }
    }
}

fn first_plist_string_after_key(plist: &str, key: &str) -> Option<String> {
    let tail = plist.split_once(&format!("<key>{key}</key>"))?.1;
    let value = tail.split_once("<string>")?.1.split_once("</string>")?.0;
    Some(value.to_string())
}

struct Case {
    pair: String,
    xdg: tempfile::TempDir,
    home: tempfile::TempDir,
    source: tempfile::TempDir,
    destination: PathBuf,
}

impl Case {
    fn create(image: &MountedImage, filesystem: Filesystem, transition: &str) -> Self {
        let pair = format!("n-{}-{}", filesystem.slug, transition.replace('_', "-"));
        let xdg = tempfile::tempdir().expect("case config home");
        let home = tempfile::tempdir().expect("case state home");
        let source = tempfile::tempdir().expect("case source on native APFS");
        let destination = image.mount.join("cases").join(&pair);
        fs::create_dir_all(&destination).expect("fresh case destination");
        fs::write(source.path().join("new.txt"), CONTENT).expect("source fixture");
        let source_sentinel = source.path().join("existing.txt");
        let destination_sentinel = destination.join("existing.txt");
        fs::write(&source_sentinel, "retained\n").expect("source sentinel");
        fs::write(&destination_sentinel, "retained\n").expect("destination sentinel");
        let timestamped = Command::new("touch")
            .args(["-t", "202001010000"])
            .arg(&source_sentinel)
            .arg(&destination_sentinel)
            .output()
            .expect("sentinel timestamp setup starts");
        assert_command_success("sentinel timestamp setup", &timestamped);
        fs::create_dir_all(destination.join("_SafetyNet/manual"))
            .expect("protected machinery fixture");
        fs::write(
            destination.join("_SafetyNet/manual/protected.txt"),
            "protected\n",
        )
        .expect("protected SafetyNet fixture");

        let case = Self {
            pair,
            xdg,
            home,
            source,
            destination,
        };
        let added = case
            .command()
            .args([
                "pair",
                "add",
                &case.pair,
                "--source",
                case.source.path().to_str().unwrap(),
                "--destination",
                case.destination.to_str().unwrap(),
                "--mode",
                "mirror",
            ])
            .output()
            .expect("pair add starts");
        assert_command_success("pair add", &added);
        case
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_vibesync"));
        command
            .env("XDG_CONFIG_HOME", self.xdg.path())
            .env("HOME", self.home.path());
        command
    }

    fn journals(&self) -> Vec<PathBuf> {
        let directory = self
            .home
            .path()
            .join("Library/Application Support/VibeFileSync/runs")
            .join(&self.pair);
        let mut journals: Vec<_> = fs::read_dir(directory)
            .expect("Journal directory exists")
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("ndjson"))
            .collect();
        journals.sort();
        journals
    }
}

#[test]
fn new_file_crash_transitions_converge_on_apfs_and_exfat() {
    let mut images: Vec<_> = FILESYSTEMS
        .iter()
        .copied()
        .map(|filesystem| (filesystem, MountedImage::create(filesystem)))
        .collect();

    for (filesystem, image) in &images {
        for transition in [
            "temp_created",
            "copy_complete",
            "verify_complete",
            "source_revalidated",
            "publish_complete",
            "action_done_written",
        ] {
            exercise_new_file_cell(image, *filesystem, transition);
        }
    }

    let mut teardown_errors = Vec::new();
    for (filesystem, image) in &mut images {
        if let Err(error) = image.detach() {
            teardown_errors.push(format!("{} teardown: {error}", filesystem.slug));
        }
    }
    assert!(
        teardown_errors.is_empty(),
        "suite-owned image teardown failed after every detach was attempted: {}",
        teardown_errors.join("; ")
    );
}

fn exercise_new_file_cell(image: &MountedImage, filesystem: Filesystem, transition: &str) {
    let label = format!("{}:{transition}", filesystem.slug);
    let case = Case::create(image, filesystem, transition);
    let crashed = case
        .command()
        .env("VIBESYNC_TEST_CRASH_AT", transition)
        .args(["run", &case.pair, "--yes"])
        .output()
        .expect("crash run starts");
    assert_eq!(
        crashed.status.signal(),
        Some(libc::SIGABRT),
        "{label}: real process was not aborted: {}",
        String::from_utf8_lossy(&crashed.stderr)
    );

    let crashed_journals = case.journals();
    assert_eq!(crashed_journals.len(), 1, "{label}: one crashed Journal");
    let crashed_journal = fs::read_to_string(&crashed_journals[0]).unwrap();
    let run_id = crashed_journals[0].file_stem().unwrap().to_str().unwrap();

    // I1: the pre-existing destination evidence is never lost. A new-file
    // cell has no replaced version, and therefore creates no archive for it.
    assert_eq!(
        fs::read_to_string(case.destination.join("existing.txt")).unwrap(),
        "retained\n",
        "{label}: I1 retained destination evidence"
    );
    assert!(
        !case
            .destination
            .join("_SafetyNet")
            .join(run_id)
            .join("new.txt")
            .exists(),
        "{label}: I1 a new file must not invent an old version"
    );

    // I2: only absent or complete gate-passed content may occupy the final
    // path; incomplete work is confined to a named sibling temp.
    let final_path = case.destination.join("new.txt");
    if final_path.exists() {
        assert_eq!(
            fs::read_to_string(&final_path).unwrap(),
            CONTENT,
            "{label}: I2"
        );
    }
    let temps = sibling_temps(&case.destination);
    for temp in machinery_temps(&case.destination) {
        assert!(
            temp.file_name().unwrap().to_string_lossy().starts_with('.'),
            "{label}: I2 temp naming"
        );
    }
    let published = matches!(transition, "publish_complete" | "action_done_written");
    assert_eq!(
        final_path.exists(),
        published,
        "{label}: I2 Publish boundary"
    );
    assert_eq!(temps.is_empty(), published, "{label}: I2 temp boundary");
    if !published {
        assert_eq!(temps.len(), 1, "{label}: I2 one active sibling temp");
        let expected = if transition == "temp_created" {
            ""
        } else {
            CONTENT
        };
        assert_eq!(
            fs::read_to_string(&temps[0]).unwrap(),
            expected,
            "{label}: N1 is empty; N2-N4 hold the complete copied data"
        );
    }

    // I4: the killed run is permanently summary-less and status derives the
    // interrupted result from that external Journal evidence.
    assert!(
        !crashed_journal.lines().any(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .is_some_and(|event| event["type"] == "summary")
        }),
        "{label}: I4 crash Journal claimed completion"
    );
    if transition == "action_done_written" {
        let types: Vec<_> = crashed_journal
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["type"].clone())
            .collect();
        assert_eq!(
            types,
            ["run_start", "action_start", "action_done"],
            "{label}: N6 must contain action_done with only summary missing"
        );
    } else {
        assert!(
            !crashed_journal.lines().any(|line| {
                serde_json::from_str::<Value>(line)
                    .ok()
                    .is_some_and(|event| event["type"] == "action_done")
            }),
            "{label}: N1-N5 must crash before action_done is written"
        );
    }
    let status = case
        .command()
        .args(["status", &case.pair])
        .output()
        .expect("status starts");
    assert_command_success(&format!("{label}: status"), &status);
    assert!(
        String::from_utf8_lossy(&status.stdout).contains("Result: interrupted"),
        "{label}: I4 status must report interruption"
    );

    // I5: plan may report the temp as machinery, but no action may copy or
    // delete a temp or SafetyNet path as user content.
    assert_plan_hides_machinery(&case, &label);
    assert_eq!(
        fs::read_to_string(case.destination.join("_SafetyNet/manual/protected.txt")).unwrap(),
        "protected\n",
        "{label}: I5 Mirror touched SafetyNet"
    );

    // I3: one ordinary rerun performs a fresh scan, cleans any stray, and
    // converges. N5/N6 prove published work is not recopied.
    let rerun = case
        .command()
        .args(["run", &case.pair, "--yes"])
        .output()
        .expect("convergence rerun starts");
    assert_command_success(&format!("{label}: I3 rerun"), &rerun);
    assert_eq!(
        fs::read_to_string(&final_path).unwrap(),
        CONTENT,
        "{label}: I2/I3 complete Published content"
    );
    assert_eq!(
        fs::read_to_string(case.destination.join("existing.txt")).unwrap(),
        "retained\n",
        "{label}: I1 post-rerun retained destination evidence"
    );
    assert!(
        !case
            .destination
            .join("_SafetyNet")
            .join(run_id)
            .join("new.txt")
            .exists(),
        "{label}: I1 post-rerun a new file must not invent an archive"
    );
    assert_eq!(
        visible_files(case.source.path(), false),
        visible_files(&case.destination, filesystem.slug == "exfat"),
        "{label}: I3 post-rerun destination must match the source"
    );
    assert!(
        machinery_temps(&case.destination).is_empty(),
        "{label}: I3 stray temp machinery"
    );
    assert_eq!(
        fs::read_to_string(case.destination.join("_SafetyNet/manual/protected.txt")).unwrap(),
        "protected\n",
        "{label}: I5 post-rerun SafetyNet"
    );

    let journals = case.journals();
    assert_eq!(journals.len(), 2, "{label}: rerun Journal retained");
    let rerun_path = journals
        .iter()
        .find(|path| *path != &crashed_journals[0])
        .expect("rerun Journal differs from crashed Journal");
    let rerun_journal = fs::read_to_string(rerun_path).unwrap();
    let crashed_journal_after_rerun = fs::read_to_string(&crashed_journals[0]).unwrap();
    assert_eq!(
        crashed_journal_after_rerun, crashed_journal,
        "{label}: I4 rerun must never append to the crashed Journal"
    );
    assert!(
        !crashed_journal_after_rerun.contains("\"type\":\"summary\""),
        "{label}: I4 crashed Journal must remain summary-less after rerun"
    );
    let rerun_events: Vec<Value> = rerun_journal
        .lines()
        .map(|line| serde_json::from_str(line).expect("complete rerun Journal line"))
        .collect();
    assert_eq!(
        rerun_events.last().unwrap()["type"],
        "summary",
        "{label}: I4 rerun completion"
    );
    if published {
        assert!(
            !rerun_events.iter().any(|event| {
                event["type"] == "action_start"
                    && event["op"] == "copy"
                    && event["path"] == "new.txt"
            }),
            "{label}: N5/N6 rerun recopied already Published data"
        );
    } else {
        assert!(
            rerun_events.iter().any(|event| {
                event["type"] == "action_done"
                    && event["op"] == "cleanup"
                    && event["path"]
                        .as_str()
                        .is_some_and(|path| path.starts_with(".new.txt.vibesync-tmp-"))
            }),
            "{label}: I3/I4 rerun did not journal stray cleanup"
        );
    }
    let remaining_actions = assert_plan_hides_machinery(&case, &format!("{label}: post-rerun"));
    assert_eq!(
        remaining_actions, 0,
        "{label}: I3/I5 post-rerun plan must be converged and machinery-free"
    );
}

fn sibling_temps(destination: &Path) -> Vec<PathBuf> {
    machinery_temps(destination)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".new.txt.vibesync-tmp-")
        })
        .collect()
}

fn machinery_temps(destination: &Path) -> Vec<PathBuf> {
    fs::read_dir(destination)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".vibesync-tmp-")
        })
        .collect()
}

fn visible_files(root: &Path, skip_apple_double: bool) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(
        root: &Path,
        directory: &Path,
        skip_apple_double: bool,
        files: &mut BTreeMap<PathBuf, Vec<u8>>,
    ) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let path = entry.path();
            if name == "_SafetyNet"
                || (name.starts_with('.') && name.contains(".vibesync-tmp-"))
                || (skip_apple_double && apple_double_magic(&path))
            {
                continue;
            }
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, skip_apple_double, files);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }

    let mut files = BTreeMap::new();
    walk(root, root, skip_apple_double, &mut files);
    files
}

fn apple_double_magic(path: &Path) -> bool {
    fs::read(path)
        .ok()
        .is_some_and(|bytes| bytes.starts_with(&[0x00, 0x05, 0x16, 0x07]))
}

fn assert_plan_hides_machinery(case: &Case, label: &str) -> usize {
    let plan = case
        .command()
        .args(["plan", &case.pair, "--json"])
        .output()
        .expect("plan starts");
    assert_command_success(&format!("{label}: plan"), &plan);
    let mut actions = 0;
    for row in String::from_utf8(plan.stdout).unwrap().lines() {
        let event: Value = serde_json::from_str(row).expect("plan line is NDJSON");
        if event["type"] == "action" {
            actions += 1;
            let path = event["path"].as_str().unwrap();
            assert!(
                !path.contains(".vibesync-tmp-")
                    && !path.starts_with("_SafetyNet/")
                    && path != "._new.txt",
                "{label}: I5 machinery leaked into a plan action: {event}"
            );
        }
    }
    actions
}

fn assert_command_success(label: &str, output: &Output) {
    assert!(
        output.status.success(),
        "{label} failed (status {}): stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
