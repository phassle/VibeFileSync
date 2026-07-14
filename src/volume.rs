//! Volume identity, per ADR-0002 / ADR-0006: a Folder pair pins both its
//! source and destination to their volume UUID via `getattrlist(2)`'s
//! `ATTR_VOL_UUID`, so a run can detect drift (a volume remounted at a new
//! path) versus an actually-missing volume.

use std::ffi::CString;
use std::io;
use std::os::raw::{c_int, c_void};
use std::path::Path;

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
}
