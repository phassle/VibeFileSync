//! ADR-0009 process/filesystem acceptance harness. The suite owns exactly
//! one APFS and one exFAT sparse image; every matrix cell gets a fresh Folder
//! pair and destination directory on the applicable mounted image.
#![cfg(debug_assertions)]

use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread;
use std::time::Duration;

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
        Self::create_sized(filesystem, "128m")
    }

    fn create_sized(filesystem: Filesystem, size: &str) -> Self {
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
                size,
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
        Self::create_mode(image, filesystem, transition, "mirror")
    }

    fn create_mode(
        image: &MountedImage,
        filesystem: Filesystem,
        transition: &str,
        mode: &str,
    ) -> Self {
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
                mode,
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
fn full_crash_and_fault_matrix_passes_on_real_filesystems() {
    let mut images: Vec<_> = FILESYSTEMS
        .iter()
        .copied()
        .map(|filesystem| (filesystem, MountedImage::create(filesystem)))
        .collect();

    exercise_new_file_crash_transitions(&images);
    exercise_replacement_crash_transitions(&images);
    exercise_deletion_crash_transitions(&images);
    exercise_update_replacement_parity(&images[0].1, images[0].0);
    exercise_f1_source_rewrite(&images[0].1, images[0].0);
    exercise_f2_truncated_temp(&images[0].1, images[0].0);
    for (filesystem, image) in &images {
        exercise_metadata_matrix(image, *filesystem);
    }
    for (filesystem, image) in &images {
        exercise_f3_stripped_xattr(image, *filesystem);
    }
    exercise_f4_hash_tier_boundary(&images[0].1, images[0].0);
    exercise_f5_enospc();
    exercise_f6_strays(&images);
    exercise_f8_concurrent_run(&images[0].1, images[0].0);

    detach_all(&mut images);
}

fn exercise_new_file_crash_transitions(images: &[(Filesystem, MountedImage)]) {
    for (filesystem, image) in images {
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
}

fn exercise_replacement_crash_transitions(images: &[(Filesystem, MountedImage)]) {
    for (filesystem, image) in images {
        for transition in [
            "temp_created",
            "copy_complete",
            "verify_complete",
            "source_revalidated",
            "archived",
            "publish_complete",
            "action_done_written",
        ] {
            exercise_replacement_cell(image, *filesystem, transition);
        }
    }
}

fn exercise_deletion_crash_transitions(images: &[(Filesystem, MountedImage)]) {
    for (filesystem, image) in images {
        for transition in ["archived", "action_done_written"] {
            exercise_deletion_cell(image, *filesystem, transition);
        }
    }
}

fn exercise_deletion_cell(image: &MountedImage, filesystem: Filesystem, transition: &str) {
    let label = format!("{}:deletion:{transition}", filesystem.slug);
    let case = Case::create(image, filesystem, &format!("deletion-{transition}"));
    fs::remove_file(case.source.path().join("new.txt")).unwrap();
    fs::write(
        case.destination.join("deleted.txt"),
        "old deleted content\n",
    )
    .unwrap();

    let crashed = case
        .command()
        .env("VIBESYNC_TEST_CRASH_AT", transition)
        .args(["run", &case.pair, "--yes"])
        .output()
        .expect("deletion crash starts");
    assert_eq!(crashed.status.signal(), Some(libc::SIGABRT), "{label}");
    let journals = case.journals();
    let journal = fs::read_to_string(&journals[0]).unwrap();
    let run_id = journals[0].file_stem().unwrap().to_str().unwrap();
    let archive = case
        .destination
        .join("_SafetyNet")
        .join(run_id)
        .join("deleted.txt");

    assert!(
        !case.destination.join("deleted.txt").exists(),
        "{label}: I1"
    );
    assert_eq!(
        fs::read_to_string(&archive).unwrap(),
        "old deleted content\n",
        "{label}: I1 archived deletion"
    );
    assert!(machinery_temps(&case.destination).is_empty(), "{label}: I2");
    assert_crashed_records_are_honest(&case, &label, &journal, transition);
    assert_plan_hides_machinery(&case, &label);
    assert_eq!(
        fs::read_to_string(case.destination.join("_SafetyNet/manual/protected.txt")).unwrap(),
        "protected\n",
        "{label}: I5 post-crash machinery"
    );

    let rerun = case
        .command()
        .args(["run", &case.pair, "--yes"])
        .output()
        .expect("deletion convergence rerun starts");
    assert_command_success(&format!("{label}: I3 rerun"), &rerun);
    assert!(
        !case.destination.join("deleted.txt").exists(),
        "{label}: I3"
    );
    assert_eq!(
        fs::read_to_string(&archive).unwrap(),
        "old deleted content\n",
        "{label}: I1 post-rerun"
    );
    assert!(
        machinery_temps(&case.destination).is_empty(),
        "{label}: I2 post-rerun"
    );
    assert_eq!(
        fs::read_to_string(case.destination.join("_SafetyNet/manual/protected.txt")).unwrap(),
        "protected\n",
        "{label}: I5"
    );
    assert_eq!(
        assert_plan_hides_machinery(&case, &label),
        0,
        "{label}: I3/I5"
    );
    let rerun_events = assert_rerun_records_are_honest(&case, &label, &journals[0], &journal);
    assert!(
        !rerun_events
            .iter()
            .any(|event| event["type"] == "action_start"),
        "{label}: D1/D2 rerun must plan and execute no actions"
    );
    assert_eq!(
        rerun_events.last().unwrap()["counts"]["planned"],
        0,
        "{label}: D1/D2 rerun plan must be empty"
    );
}

fn exercise_update_replacement_parity(image: &MountedImage, filesystem: Filesystem) {
    let mirror = Case::create_mode(image, filesystem, "u1-mirror", "mirror");
    let update = Case::create_mode(image, filesystem, "u1-update", "update");
    for case in [&mirror, &update] {
        fs::write(case.destination.join("new.txt"), "old\n").unwrap();
    }

    let mirror_output = mirror
        .command()
        .args(["run", &mirror.pair, "--json", "--yes"])
        .output()
        .unwrap();
    let update_output = update
        .command()
        .args(["run", &update.pair, "--json", "--yes"])
        .output()
        .unwrap();
    assert_command_success("U1 Mirror", &mirror_output);
    assert_command_success("U1 Update", &update_output);

    assert_eq!(
        visible_files(&mirror.destination, false),
        visible_files(&update.destination, false),
        "U1 destination parity"
    );
    assert_eq!(
        safety_net_payloads(&mirror.destination),
        safety_net_payloads(&update.destination),
        "U1 SafetyNet parity"
    );
    assert_eq!(
        normalized_action_events(&mirror.journals()[0]),
        normalized_action_events(&update.journals()[0]),
        "U1 Journal action parity"
    );
}

fn exercise_f1_source_rewrite(image: &MountedImage, filesystem: Filesystem) {
    let case = Case::create(image, filesystem, "f1-source-rewrite");
    fs::write(case.destination.join("new.txt"), "old\n").unwrap();

    let failed = case
        .command()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:printf 'rewritten source with different size\\n' > \"$VIBESYNC_TEST_SOURCE\"",
        )
        .args(["run", &case.pair, "--json", "--yes"])
        .output()
        .unwrap();
    assert_eq!(failed.status.code(), Some(1), "F1 exit");
    assert_event_reason(&failed, "source_changed");
    assert_eq!(
        fs::read_to_string(case.destination.join("new.txt")).unwrap(),
        "old\n"
    );
    assert!(safety_net_files_named(&case.destination, "new.txt").is_empty());

    let rerun = case
        .command()
        .args(["run", &case.pair, "--yes"])
        .output()
        .unwrap();
    assert_command_success("F1 rerun", &rerun);
    assert_eq!(
        fs::read_to_string(case.destination.join("new.txt")).unwrap(),
        "rewritten source with different size\n"
    );
}

fn exercise_f2_truncated_temp(image: &MountedImage, filesystem: Filesystem) {
    let case = Case::create(image, filesystem, "f2-truncated-temp");
    fs::write(case.destination.join("new.txt"), "old\n").unwrap();

    let failed = case
        .command()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:: > \"$VIBESYNC_TEST_TEMP\"",
        )
        .args(["run", &case.pair, "--json", "--yes"])
        .output()
        .unwrap();
    assert_eq!(failed.status.code(), Some(1), "F2 exit");
    assert_event_reason(&failed, "verify_mismatch");
    assert_eq!(
        fs::read_to_string(case.destination.join("new.txt")).unwrap(),
        "old\n"
    );
    assert!(
        machinery_temps(&case.destination).is_empty(),
        "F2 removes rejected temp"
    );
}

fn exercise_f3_stripped_xattr(image: &MountedImage, filesystem: Filesystem) {
    let case = Case::create(image, filesystem, "f3-xattr");
    let xattr = Command::new("xattr")
        .args(["-w", "com.vibesync.acceptance", "kept"])
        .arg(case.source.path().join("new.txt"))
        .output()
        .unwrap();
    assert_command_success("F3 fixture xattr", &xattr);

    let output = case
        .command()
        .env(
            "VIBESYNC_TEST_EXEC_AT",
            "copy_complete:xattr -d com.vibesync.acceptance \"$VIBESYNC_TEST_TEMP\"",
        )
        .args(["run", &case.pair, "--json", "--yes"])
        .output()
        .unwrap();
    assert_command_success("F3 run", &output);
    let events = output_events(&output);
    let done = events
        .iter()
        .find(|event| event["type"] == "action_done")
        .unwrap();
    assert_eq!(done["warnings"][0]["code"], "metadata_mismatch");
    assert!(events.last().unwrap()["warnings"].as_u64().unwrap() >= 1);
    assert_eq!(
        fs::read_to_string(case.destination.join("new.txt")).unwrap(),
        CONTENT
    );
}

fn exercise_metadata_matrix(image: &MountedImage, filesystem: Filesystem) {
    let case = Case::create(image, filesystem, "metadata-matrix");
    let source = case.source.path().join("new.txt");
    let destination = case.destination.join("new.txt");
    set_xattr_text(&source, "com.vibesync.acceptance", "custom-value");
    set_resource_fork(&source, b"resource-fork");
    set_xattr_hex(
        &source,
        "com.apple.FinderInfo",
        &format!("54455854{}", "00".repeat(28)),
    );
    fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
    let timestamped = Command::new("touch")
        .args(["-t", "202001010000.01"])
        .arg(&source)
        .output()
        .unwrap();
    assert_command_success("metadata fixture timestamp", &timestamped);

    let output = case
        .command()
        .args(["run", &case.pair, "--json", "--yes"])
        .output()
        .unwrap();
    assert_command_success(&format!("{} metadata run", filesystem.slug), &output);
    let events = output_events(&output);
    let start = events
        .iter()
        .find(|event| event["type"] == "run_start")
        .unwrap();
    let degradations: Vec<_> = start["degradations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    let expected = if filesystem.slug == "exfat" {
        vec![
            "posix_permissions",
            "acls",
            "bsd_flags",
            "timestamp_granularity",
        ]
    } else {
        Vec::new()
    };
    assert_eq!(degradations, expected, "{} degradations", filesystem.slug);

    for name in ["com.vibesync.acceptance", "com.apple.FinderInfo"] {
        assert_eq!(
            read_xattr_hex(&source, name),
            read_xattr_hex(&destination, name),
            "{} must preserve {name}",
            filesystem.slug
        );
    }
    assert_eq!(
        fs::read(source.join("..namedfork/rsrc")).unwrap(),
        fs::read(destination.join("..namedfork/rsrc")).unwrap(),
        "{} must preserve the resource fork",
        filesystem.slug
    );
    let source_mtime = fs::metadata(&source).unwrap().modified().unwrap();
    let destination_mtime = fs::metadata(&destination).unwrap().modified().unwrap();
    let delta = source_mtime
        .duration_since(destination_mtime)
        .unwrap_or_else(|_| destination_mtime.duration_since(source_mtime).unwrap());
    let allowed = if filesystem.slug == "exfat" {
        Duration::from_millis(10)
    } else {
        Duration::ZERO
    };
    assert!(
        delta <= allowed,
        "{} timestamp delta {delta:?} exceeds {allowed:?}",
        filesystem.slug
    );
    if filesystem.slug == "apfs" {
        assert_eq!(
            fs::metadata(&source).unwrap().permissions().mode() & 0o777,
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            "APFS preserves POSIX mode"
        );
    }

    let old_fork = read_xattr_hex(&destination, "com.apple.ResourceFork");
    fs::write(&source, "replacement data\n").unwrap();
    set_resource_fork(&source, b"replacement-fork");
    let replacement_fork = read_xattr_hex(&source, "com.apple.ResourceFork");
    let replacement = case
        .command()
        .args(["run", &case.pair, "--json", "--yes"])
        .output()
        .unwrap();
    assert_command_success(
        &format!("{} metadata replacement", filesystem.slug),
        &replacement,
    );
    let replacement_events = output_events(&replacement);
    let done = replacement_events
        .iter()
        .find(|event| event["type"] == "action_done")
        .unwrap();
    let archived = Path::new(done["safety_net"].as_str().unwrap());
    assert_eq!(
        read_xattr_hex(&destination, "com.apple.ResourceFork"),
        replacement_fork,
        "{} must publish the replacement resource fork",
        filesystem.slug
    );
    assert_eq!(
        read_xattr_hex(archived, "com.apple.ResourceFork"),
        old_fork,
        "{} must archive the prior resource fork",
        filesystem.slug
    );
}

fn set_xattr_text(path: &Path, name: &str, value: &str) {
    let output = Command::new("xattr")
        .args(["-w", name, value])
        .arg(path)
        .output()
        .unwrap();
    assert_command_success(&format!("set {name}"), &output);
}

fn set_xattr_hex(path: &Path, name: &str, value: &str) {
    let output = Command::new("xattr")
        .args(["-wx", name, value])
        .arg(path)
        .output()
        .unwrap();
    assert_command_success(&format!("set {name}"), &output);
}

fn set_resource_fork(path: &Path, value: &[u8]) {
    let _ = Command::new("xattr")
        .args(["-d", "com.apple.ResourceFork"])
        .arg(path)
        .output()
        .unwrap();
    let resource_source = path.with_extension("vibesync-resource.r");
    let hex: String = value.iter().map(|byte| format!("{byte:02X}")).collect();
    fs::write(
        &resource_source,
        format!("data 'TEST' (128) {{ $\"{hex}\" }};\n"),
    )
    .unwrap();
    let output = Command::new("Rez")
        .arg(&resource_source)
        .args(["-o"])
        .arg(path)
        .output()
        .unwrap();
    fs::remove_file(resource_source).unwrap();
    assert_command_success("create valid resource fork", &output);
}

fn read_xattr_hex(path: &Path, name: &str) -> String {
    let output = Command::new("xattr")
        .args(["-px", name])
        .arg(path)
        .output()
        .unwrap();
    assert_command_success(&format!("read {name}"), &output);
    String::from_utf8(output.stdout)
        .unwrap()
        .split_whitespace()
        .collect::<String>()
        .to_ascii_lowercase()
}

fn exercise_f4_hash_tier_boundary(image: &MountedImage, filesystem: Filesystem) {
    let standard = Case::create(image, filesystem, "f4-standard");
    let full = Case::create(image, filesystem, "f4-full");
    for case in [&standard, &full] {
        fs::write(case.source.path().join("new.txt"), "ABCD").unwrap();
        fs::write(case.destination.join("new.txt"), "old").unwrap();
    }
    let injection = "copy_complete:printf X | dd of=\"$VIBESYNC_TEST_TEMP\" bs=1 seek=2 conv=notrunc 2>/dev/null";

    let standard_output = standard
        .command()
        .env("VIBESYNC_TEST_EXEC_AT", injection)
        .args(["run", &standard.pair, "--json", "--yes"])
        .output()
        .unwrap();
    assert_command_success("F4 standard", &standard_output);
    assert_eq!(
        fs::read_to_string(standard.destination.join("new.txt")).unwrap(),
        "ABXD"
    );

    let full_output = full
        .command()
        .env("VIBESYNC_TEST_EXEC_AT", injection)
        .args(["run", &full.pair, "--json", "--yes", "--verify"])
        .output()
        .unwrap();
    assert_eq!(full_output.status.code(), Some(1), "F4 full exit");
    assert_event_reason(&full_output, "verify_mismatch");
    assert_eq!(
        fs::read_to_string(full.destination.join("new.txt")).unwrap(),
        "old"
    );
}

fn exercise_f5_enospc() {
    for filesystem in FILESYSTEMS {
        let mut image = MountedImage::create_sized(filesystem, "32m");
        let case = Case::create(&image, filesystem, "f5-enospc");
        fs::write(case.source.path().join("new.txt"), vec![b'n'; 1024 * 1024]).unwrap();
        fs::write(case.destination.join("new.txt"), "old\n").unwrap();
        let filler = case.destination.join("filler.bin");

        let failed = case
            .command()
            .env(
                "VIBESYNC_TEST_EXEC_AT",
                "temp_created:dd if=/dev/zero of=\"$(dirname \"$VIBESYNC_TEST_DESTINATION\")/filler.bin\" bs=1m count=128 2>/dev/null || true",
            )
            .args(["run", &case.pair, "--json", "--yes", "--ignore-space-check"])
            .output()
            .unwrap();
        assert_eq!(
            failed.status.code(),
            Some(1),
            "F5 {} expected ENOSPC: stdout={} stderr={}",
            filesystem.slug,
            String::from_utf8_lossy(&failed.stdout),
            String::from_utf8_lossy(&failed.stderr)
        );
        assert_event_reason(&failed, "destination_full");
        assert_eq!(
            fs::read_to_string(case.destination.join("new.txt")).unwrap(),
            "old\n",
            "F5 {}: I1 old version",
            filesystem.slug
        );
        assert!(
            safety_net_files_named(&case.destination, "new.txt").is_empty(),
            "F5 {}: I1 failure occurred before archive",
            filesystem.slug
        );
        assert!(
            machinery_temps(&case.destination).is_empty(),
            "F5: I2 temp cleanup"
        );
        let events = output_events(&failed);
        assert_eq!(
            events.last().unwrap()["result"],
            "partial",
            "F5: I4 honest summary"
        );
        assert_plan_hides_machinery(&case, &format!("F5 {}", filesystem.slug));

        fs::remove_file(&filler).unwrap();
        let rerun = case
            .command()
            .args(["run", &case.pair, "--yes"])
            .output()
            .unwrap();
        assert_command_success(&format!("F5 {} rerun", filesystem.slug), &rerun);
        assert_eq!(
            fs::read(case.destination.join("new.txt")).unwrap(),
            vec![b'n'; 1024 * 1024],
            "F5 {}: I3 converged",
            filesystem.slug
        );
        assert!(
            safety_net_files_named(&case.destination, "new.txt")
                .iter()
                .any(|path| fs::read_to_string(path).unwrap() == "old\n"),
            "F5 {}: I1 old replacement survived the convergence rerun",
            filesystem.slug
        );
        assert!(
            machinery_temps(&case.destination).is_empty(),
            "F5: I3 cleanup"
        );
        assert_eq!(
            fs::read_to_string(case.destination.join("_SafetyNet/manual/protected.txt")).unwrap(),
            "protected\n",
            "F5 {}: I5 machinery",
            filesystem.slug
        );
        assert_eq!(
            assert_plan_hides_machinery(&case, &format!("F5 {} post-rerun", filesystem.slug)),
            0,
            "F5 {}: I3/I5 post-rerun plan",
            filesystem.slug
        );
        assert!(
            case.journals().iter().any(|journal| {
                fs::read_to_string(journal).unwrap().lines().any(|line| {
                    serde_json::from_str::<Value>(line)
                        .ok()
                        .is_some_and(|event| {
                            event["type"] == "summary" && event["result"] == "success"
                        })
                })
            }),
            "F5 {}: I4 rerun Journal must complete honestly",
            filesystem.slug
        );
        image.detach().unwrap();
    }
}

fn exercise_f6_strays(images: &[(Filesystem, MountedImage)]) {
    for (filesystem, image) in images {
        let case = Case::create(image, *filesystem, "f6-strays");
        let stray = case.destination.join(".orphan.vibesync-tmp-fabricated");
        fs::write(&stray, "orphaned").unwrap();
        let before = tree_payloads(&case.destination);
        for args in [vec!["plan", &case.pair], vec!["status", &case.pair]] {
            let output = case.command().args(args).output().unwrap();
            assert_command_success("F6 read-only command", &output);
            assert!(
                String::from_utf8_lossy(&output.stdout).contains(".orphan.vibesync-tmp-fabricated"),
                "F6 command did not report the planted stray: {}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert_eq!(
                tree_payloads(&case.destination),
                before,
                "F6 read-only claim"
            );
        }
        let run = case
            .command()
            .args(["run", &case.pair, "--yes"])
            .output()
            .unwrap();
        assert_command_success("F6 cleanup run", &run);
        assert!(!stray.exists(), "F6 stray cleaned");
        let journal = fs::read_to_string(case.journals().last().unwrap()).unwrap();
        assert!(
            journal.contains("\"op\":\"cleanup\""),
            "F6 cleanup journaled"
        );
    }
}

fn exercise_f8_concurrent_run(image: &MountedImage, filesystem: Filesystem) {
    let case = Case::create(image, filesystem, "f8-lock");
    let mut first = case
        .command()
        .env("VIBESYNC_TEST_EXEC_AT", "temp_created:sleep 2")
        .args(["run", &case.pair, "--yes"])
        .spawn()
        .unwrap();
    let mut reached_transition = false;
    for _ in 0..100 {
        if !machinery_temps(&case.destination).is_empty() {
            reached_transition = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        reached_transition,
        "F8 first run did not reach the held transition"
    );
    let before_second = tree_payloads(&case.destination);
    let second = case
        .command()
        .args(["run", &case.pair, "--yes"])
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(2), "F8 lock contention");
    assert!(String::from_utf8_lossy(&second.stderr).contains("already in progress"));
    assert_eq!(
        tree_payloads(&case.destination),
        before_second,
        "F8 second run wrote"
    );
    assert!(first.wait().unwrap().success(), "F8 first run completes");
}

fn exercise_replacement_cell(image: &MountedImage, filesystem: Filesystem, transition: &str) {
    let label = format!("{}:replacement:{transition}", filesystem.slug);
    let case = Case::create(image, filesystem, &format!("replacement-{transition}"));
    fs::write(case.destination.join("new.txt"), "old\n").expect("old replacement fixture");

    let crashed = case
        .command()
        .env("VIBESYNC_TEST_CRASH_AT", transition)
        .args(["run", &case.pair, "--yes"])
        .output()
        .expect("replacement crash starts");
    assert_eq!(crashed.status.signal(), Some(libc::SIGABRT), "{label}");

    let crashed_journals = case.journals();
    assert_eq!(crashed_journals.len(), 1, "{label}: one crashed Journal");
    let crashed_journal = fs::read_to_string(&crashed_journals[0]).unwrap();
    let run_id = crashed_journals[0].file_stem().unwrap().to_str().unwrap();
    let final_path = case.destination.join("new.txt");
    let archive = case
        .destination
        .join("_SafetyNet")
        .join(run_id)
        .join("new.txt");
    let archived = matches!(
        transition,
        "archived" | "publish_complete" | "action_done_written"
    );
    let published = matches!(transition, "publish_complete" | "action_done_written");

    // I1/I2: before the archive boundary the complete old version remains
    // live; after it, that exact version is safe in the crashed Run folder.
    assert_eq!(archive.exists(), archived, "{label}: I1 archive boundary");
    if archived {
        assert_eq!(
            fs::read_to_string(&archive).unwrap(),
            "old\n",
            "{label}: I1 archived old version"
        );
    }
    match (archived, published) {
        (false, false) => assert_eq!(
            fs::read_to_string(&final_path).unwrap(),
            "old\n",
            "{label}: I1 old version remains live"
        ),
        (true, false) => assert!(!final_path.exists(), "{label}: R5 accepted window"),
        (true, true) => assert_eq!(
            fs::read_to_string(&final_path).unwrap(),
            CONTENT,
            "{label}: I2 only complete content is Published"
        ),
        (false, true) => unreachable!(),
    }
    assert_eq!(
        sibling_temps(&case.destination).is_empty(),
        published,
        "{label}: I2 temp boundary"
    );

    assert_crashed_records_are_honest(&case, &label, &crashed_journal, transition);
    assert_plan_hides_machinery(&case, &label);
    assert_eq!(
        fs::read_to_string(case.destination.join("_SafetyNet/manual/protected.txt")).unwrap(),
        "protected\n",
        "{label}: I5 Mirror touched protected machinery"
    );

    let rerun = case
        .command()
        .args(["run", &case.pair, "--yes"])
        .output()
        .expect("replacement convergence rerun starts");
    assert_command_success(&format!("{label}: I3 rerun"), &rerun);
    assert_eq!(
        fs::read_to_string(&final_path).unwrap(),
        CONTENT,
        "{label}: I3"
    );
    assert!(
        safety_net_files_named(&case.destination, "new.txt")
            .iter()
            .any(|path| fs::read_to_string(path).unwrap() == "old\n"),
        "{label}: I1 old version survived rerun"
    );
    assert!(machinery_temps(&case.destination).is_empty(), "{label}: I3");
    assert_eq!(
        visible_files(case.source.path(), false),
        visible_files(&case.destination, filesystem.slug == "exfat"),
        "{label}: I3 destination converged"
    );
    assert_eq!(
        fs::read_to_string(case.destination.join("_SafetyNet/manual/protected.txt")).unwrap(),
        "protected\n",
        "{label}: I5 post-rerun machinery"
    );
    let rerun_events =
        assert_rerun_records_are_honest(&case, &label, &crashed_journals[0], &crashed_journal);
    let recopied = rerun_events.iter().any(|event| {
        event["type"] == "action_start"
            && matches!(event["op"].as_str(), Some("copy" | "update"))
            && event["path"] == "new.txt"
    });
    assert_eq!(
        recopied, !published,
        "{label}: R1-R5 must re-plan the copy; R6/R7 must not recopy"
    );
    let cleanup_journaled = rerun_events.iter().any(|event| {
        event["type"] == "action_done"
            && event["op"] == "cleanup"
            && event["path"]
                .as_str()
                .is_some_and(|path| path.starts_with(".new.txt.vibesync-tmp-"))
    });
    assert_eq!(
        cleanup_journaled, !published,
        "{label}: R1-R5 stray cleanup Journal boundary"
    );
    assert_eq!(assert_plan_hides_machinery(&case, &label), 0, "{label}: I5");
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
    assert_crashed_records_are_honest(&case, &label, &crashed_journal, transition);
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
    }

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

    let rerun_events =
        assert_rerun_records_are_honest(&case, &label, &crashed_journals[0], &crashed_journal);
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

fn safety_net_files_named(destination: &Path, name: &str) -> Vec<PathBuf> {
    let root = destination.join("_SafetyNet");
    if !root.exists() {
        return Vec::new();
    }
    fs::read_dir(root)
        .unwrap()
        .filter_map(|entry| {
            let candidate = entry.unwrap().path().join(name);
            candidate.exists().then_some(candidate)
        })
        .collect()
}

fn safety_net_payloads(destination: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let root = destination.join("_SafetyNet");
    let mut payloads = BTreeMap::new();
    if !root.exists() {
        return payloads;
    }
    for run in fs::read_dir(root).unwrap() {
        let run = run.unwrap().path();
        if run.is_dir() {
            for (path, bytes) in tree_payloads(&run) {
                payloads.insert(path, bytes);
            }
        }
    }
    payloads
}

fn tree_payloads(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, files);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

fn output_events(output: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).expect("run output is NDJSON"))
        .collect()
}

fn assert_event_reason(output: &Output, reason: &str) {
    assert!(
        output_events(output)
            .iter()
            .any(|event| event["type"] == "action_failed" && event["reason"] == reason),
        "missing action_failed reason {reason}: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

fn normalized_action_events(journal: &Path) -> Vec<Value> {
    fs::read_to_string(journal)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| {
            matches!(
                event["type"].as_str(),
                Some("action_start" | "action_done" | "summary")
            )
        })
        .map(|event| {
            let safety_net = event["safety_net"].as_str().map(|path| {
                let after_root = path
                    .split_once("_SafetyNet/")
                    .expect("SafetyNet event path contains its root")
                    .1;
                after_root
                    .split_once('/')
                    .expect("SafetyNet event path contains a Run id")
                    .1
                    .to_string()
            });
            serde_json::json!({
                "type": event["type"],
                "op": event["op"],
                "path": event["path"],
                "bytes": event["bytes"],
                "counts": event["counts"],
                "result": event["result"],
                "verified": event["verified"],
                "warnings": event["warnings"],
                "safety_net": safety_net,
            })
        })
        .collect()
}

fn assert_crashed_records_are_honest(case: &Case, label: &str, journal: &str, transition: &str) {
    assert!(
        !journal.contains("\"type\":\"summary\""),
        "{label}: I4 summary"
    );
    let has_done = journal.contains("\"type\":\"action_done\"");
    assert_eq!(
        has_done,
        transition == "action_done_written",
        "{label}: I4 action_done boundary"
    );
    let status = case
        .command()
        .args(["status", &case.pair])
        .output()
        .expect("status starts");
    assert_command_success(&format!("{label}: status"), &status);
    assert!(
        String::from_utf8_lossy(&status.stdout).contains("Result: interrupted"),
        "{label}: I4 status"
    );
    let history = case
        .command()
        .args(["history", &case.pair])
        .output()
        .expect("history starts");
    assert_command_success(&format!("{label}: history"), &history);
    assert!(
        String::from_utf8_lossy(&history.stdout).contains("interrupted"),
        "{label}: F7 history"
    );
}

fn assert_rerun_records_are_honest(
    case: &Case,
    label: &str,
    crashed_path: &Path,
    crashed_before: &str,
) -> Vec<Value> {
    assert_eq!(
        fs::read_to_string(crashed_path).unwrap(),
        crashed_before,
        "{label}: I4 rerun changed crashed Journal"
    );
    let journals = case.journals();
    assert_eq!(journals.len(), 2, "{label}: I4 retained two Journals");
    let rerun = journals
        .iter()
        .find(|path| path.as_path() != crashed_path)
        .unwrap();
    let events: Vec<Value> = fs::read_to_string(rerun)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        events.last().unwrap()["type"],
        "summary",
        "{label}: I4 rerun"
    );
    events
}

fn detach_all(images: &mut [(Filesystem, MountedImage)]) {
    let mut errors = Vec::new();
    for (filesystem, image) in images {
        if let Err(error) = image.detach() {
            errors.push(format!("{} teardown: {error}", filesystem.slug));
        }
    }
    assert!(
        errors.is_empty(),
        "suite image teardown: {}",
        errors.join("; ")
    );
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
            let path = event["path"].as_str().unwrap();
            if event["op"] == "cleanup" {
                assert!(
                    path.contains(".vibesync-tmp-"),
                    "{label}: cleanup row must name only an abandoned temp: {event}"
                );
                continue;
            }
            actions += 1;
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
