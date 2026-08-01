//! Catchable process-interruption state. The signal handler only flips an
//! atomic flag; ordinary Run code observes it at safe filesystem boundaries.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);

pub struct BlockedSignals {
    previous: libc::sigset_t,
    active: bool,
}

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

pub fn block() -> io::Result<BlockedSignals> {
    let mut signals = unsafe { std::mem::zeroed() };
    let mut previous = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut signals);
        libc::sigaddset(&mut signals, libc::SIGINT);
        libc::sigaddset(&mut signals, libc::SIGTERM);
    }
    let result = unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &signals, &mut previous) };
    if result == 0 {
        Ok(BlockedSignals {
            previous,
            active: true,
        })
    } else {
        Err(io::Error::from_raw_os_error(result))
    }
}

impl BlockedSignals {
    pub fn restore(mut self) -> io::Result<()> {
        self.active = false;
        restore(&self.previous)
    }
}

impl Drop for BlockedSignals {
    fn drop(&mut self) {
        if self.active {
            let _ = restore(&self.previous);
        }
    }
}

fn restore(previous: &libc::sigset_t) -> io::Result<()> {
    let result =
        unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, previous, std::ptr::null_mut()) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(result))
    }
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
