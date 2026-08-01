//! Catchable process-interruption state. The signal handler only flips an
//! atomic flag; ordinary Run code observes it at safe filesystem boundaries.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn request(_: libc::c_int) {
    REQUESTED.store(true, Ordering::Relaxed);
}

pub fn install() -> io::Result<()> {
    REQUESTED.store(false, Ordering::Relaxed);
    for signal in [libc::SIGINT, libc::SIGTERM] {
        if unsafe { libc::signal(signal, request as *const () as libc::sighandler_t) }
            == libc::SIG_ERR
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn check() -> io::Result<()> {
    if REQUESTED.load(Ordering::Relaxed) {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "run interrupted by signal",
        ))
    } else {
        Ok(())
    }
}
