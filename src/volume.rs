//! Volume identity, per ADR-0002 / ADR-0006: a Folder pair pins both its
//! source and destination to their volume UUID via `getattrlist(2)`'s
//! `ATTR_VOL_UUID`, so a run can detect drift (a volume remounted at a new
//! path) versus an actually-missing volume.

use std::ffi::CString;
use std::io;
use std::os::raw::{c_int, c_void};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

/// Mirrors `<sys/attr.h>`'s `struct attrlist`. `bitmapcount` must be
/// `ATTR_BIT_MAP_COUNT` (5); the rest select which attribute groups to
/// return. We only ever ask for `volattr`.
#[repr(C)]
#[derive(Default)]
struct AttrList {
    bitmapcount: u16,
    reserved: u16,
    commonattr: u32,
    volattr: u32,
    dirattr: u32,
    fileattr: u32,
    forkattr: u32,
}

const ATTR_BIT_MAP_COUNT: u16 = 5;
const ATTR_VOL_INFO: u32 = 0x8000_0000;
const ATTR_VOL_UUID: u32 = 0x0004_0000;

#[repr(C)]
struct VolAttrBuf {
    length: u32,
    uuid: [u8; 16],
}

extern "C" {
    fn getattrlist(
        path: *const std::os::raw::c_char,
        attr_list: *mut AttrList,
        attr_buf: *mut c_void,
        attr_buf_size: usize,
        options: c_int,
    ) -> c_int;
}

/// Reads the volume UUID (`ATTR_VOL_UUID`) of the volume containing `path`,
/// formatted as a standard hyphenated UUID string (e.g.
/// `A1B2C3D4-E5F6-...`).
///
/// `path` must exist; `getattrlist` resolves the volume from any object on
/// it, so a directory is enough — the object itself need not be the mount
/// point.
pub fn volume_uuid(path: &Path) -> io::Result<String> {
    let c_path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path contains an interior NUL byte: {}", path.display()),
        )
    })?;

    let mut attr_list = AttrList {
        bitmapcount: ATTR_BIT_MAP_COUNT,
        volattr: ATTR_VOL_INFO | ATTR_VOL_UUID,
        ..Default::default()
    };
    let mut buf = VolAttrBuf {
        length: 0,
        uuid: [0u8; 16],
    };

    let ret = unsafe {
        getattrlist(
            c_path.as_ptr(),
            &mut attr_list,
            &mut buf as *mut VolAttrBuf as *mut c_void,
            std::mem::size_of::<VolAttrBuf>(),
            0,
        )
    };

    if ret != 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(format_uuid(&buf.uuid))
}

/// Reads the filesystem type name of the volume containing `path` (macOS
/// `statfs(2)`'s `f_fstypename`, e.g. `"apfs"`, `"exfat"`, `"msdos"`).
///
/// `plan` uses this to know whether the destination can store symlinks:
/// exFAT cannot, so a source symlink bound for it is a per-file plan error
/// rather than a copy.
pub fn filesystem_type(path: &Path) -> io::Result<String> {
    // Deterministic issue-22 blocked-plan process seam; ADR-0009's generic
    // filesystem acceptance harness is implemented by its downstream slice.
    #[cfg(feature = "fault-injection")]
    if let Ok(kind) = std::env::var("VIBESYNC_TEST_FILESYSTEM_TYPE") {
        return Ok(kind);
    }
    let c_path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path contains an interior NUL byte: {}", path.display()),
        )
    })?;

    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statfs(c_path.as_ptr(), &mut buf) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }

    // `f_fstypename` is a fixed-size, NUL-terminated C string. `c_char` is
    // signed on this target, so reinterpret as bytes before the NUL scan.
    let raw = &buf.f_fstypename;
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(raw.as_ptr() as *const u8, raw.len()) };
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    Ok(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

pub fn expected_degradations(destination: &Path) -> Vec<&'static str> {
    match filesystem_type(destination) {
        Ok(kind) if kind.eq_ignore_ascii_case("exfat") => vec![
            "posix_permissions",
            "acls",
            "bsd_flags",
            "timestamp_granularity",
        ],
        _ => Vec::new(),
    }
}

/// Finds the root of a currently mounted volume by its pinned UUID. This is
/// deliberately a mount-table scan rather than a pathname heuristic: a
/// remount at `/Volumes/Backup 1` must not be mistaken for the old path.
pub fn mounted_path_for_uuid(expected: &str) -> io::Result<Option<PathBuf>> {
    for path in mounted_paths()? {
        if volume_uuid(&path).ok().as_deref() == Some(expected) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Returns the mount point containing a path, selecting the longest match.
pub fn mount_point_for_path(path: &Path) -> io::Result<PathBuf> {
    mounted_paths()?
        .into_iter()
        .filter(|mount| path.starts_with(mount))
        .max_by_key(|mount| mount.as_os_str().len())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("no mount for {}", path.display()),
            )
        })
}

fn mounted_paths() -> io::Result<Vec<PathBuf>> {
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut mounts: Vec<libc::statfs> = (0..count).map(|_| unsafe { std::mem::zeroed() }).collect();
    let bytes = (mounts.len() * std::mem::size_of::<libc::statfs>()) as i32;
    let actual = unsafe { libc::getfsstat(mounts.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
    if actual < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(mounts
        .into_iter()
        .take(actual as usize)
        .map(|mount| {
            let raw = &mount.f_mntonname;
            let bytes: Vec<u8> = raw
                .iter()
                .map(|c| *c as u8)
                .take_while(|b| *b != 0)
                .collect();
            PathBuf::from(std::ffi::OsString::from_vec(bytes))
        })
        .collect())
}

fn format_uuid(bytes: &[u8; 16]) -> String {
    let mut s = String::with_capacity(36);
    for (i, b) in bytes.iter().enumerate() {
        if i == 4 || i == 6 || i == 8 || i == 10 {
            s.push('-');
        }
        s.push_str(&format!("{:02X}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_uuid_bytes_as_hyphenated_uppercase() {
        let bytes: [u8; 16] = [
            0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6, 0x07, 0x18, 0x29, 0x3A, 0x4B, 0x5C, 0x6D, 0x7E,
            0x8F, 0x90,
        ];
        assert_eq!(format_uuid(&bytes), "A1B2C3D4-E5F6-0718-293A-4B5C6D7E8F90");
    }

    #[test]
    fn reads_a_real_uuid_for_an_existing_path() {
        // The root volume is always mounted; this exercises the real
        // syscall rather than mocking the FFI boundary.
        let uuid = volume_uuid(Path::new("/")).expect("root volume must have a UUID");
        assert_eq!(uuid.len(), 36);
        assert_eq!(uuid.chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn errors_for_a_nonexistent_path() {
        let err = volume_uuid(Path::new("/no/such/path/vibesync-test")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn reads_a_nonempty_filesystem_type_for_the_root_volume() {
        // The Mac's native root volume is APFS; asserting the exact name
        // would be brittle, so we just require a plausible, non-empty type.
        let fs = filesystem_type(Path::new("/")).expect("root volume has a filesystem type");
        assert!(!fs.is_empty());
        assert!(fs.is_ascii());
    }
}
