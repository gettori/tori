use std::fs::File;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::FromRawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use super::wire::{self, AttachParams, DATA, EXIT, RESIZE};

// Ctrl-\, as dtach has it: one key, and one a TUI rarely binds.
const DETACH: u8 = 0x1c;

// So the shell beneath does not inherit modes the program left on.
const UNDO_MODES: &[u8] = b"\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l";

pub enum Ended {
    Detached,
    Exited(Option<u32>),
    Closed,
}

struct Raw(libc::termios);

impl Raw {
    fn enter() -> io::Result<Self> {
        let mut saved: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut saved) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut raw = saved;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(saved))
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0) };
    }
}

pub fn is_terminal() -> bool {
    unsafe { libc::isatty(libc::STDIN_FILENO) == 1 && libc::isatty(libc::STDOUT_FILENO) == 1 }
}

fn size() -> (u16, u16) {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    match unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) } {
        0 if ws.ws_col > 0 && ws.ws_row > 0 => (ws.ws_col, ws.ws_row),
        _ => (80, 24),
    }
}

static WINCH: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_winch(_: libc::c_int) {
    let fd = WINCH.load(Ordering::Relaxed);
    unsafe { libc::write(fd, [0u8].as_ptr().cast(), 1) };
}

// A blocked SIGWINCH left at its default is dropped on this kernel, so
// `sigwait` never sees it: a handler hands it to a thread through a pipe.
fn resizes() -> io::Result<File> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    WINCH.store(fds[1], Ordering::Relaxed);
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = on_winch as *const () as libc::sighandler_t;
    action.sa_flags = libc::SA_RESTART;
    if unsafe { libc::sigaction(libc::SIGWINCH, &action, std::ptr::null_mut()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fds[0]) })
}

pub fn run(sock: &str, token: &str, target: &str) -> Result<Ended, String> {
    let (cols, rows) = size();
    let params = AttachParams {
        token: token.to_string(),
        tab: target.to_string(),
        replay: true,
        cols,
        rows,
    };
    let (stream, mut reader) = crate::rpc::window::open_attach(sock, &params)?;
    let writer = Arc::new(Mutex::new(stream.try_clone().map_err(|e| e.to_string())?));
    let detached = Arc::new(AtomicBool::new(false));
    let raw = Raw::enter().map_err(|e| e.to_string())?;

    let mut signals = resizes().map_err(|e| e.to_string())?;
    let resized = writer.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 64];
        while signals.read(&mut buf).is_ok_and(|n| n > 0) {
            let (cols, rows) = size();
            let mut out = resized.lock().unwrap_or_else(|e| e.into_inner());
            if wire::write_frame(&mut *out, RESIZE, &wire::resize(cols, rows)).is_err() {
                return;
            }
        }
    });

    let input = writer.clone();
    let leaving = detached.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            let n = match io::stdin().read(&mut buf) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Ok(0) | Err(_) => 0,
                Ok(n) => n,
            };
            let typed = &buf[..n];
            let cut = typed.iter().position(|b| *b == DETACH);
            let send = &typed[..cut.unwrap_or(n)];
            let mut out = input.lock().unwrap_or_else(|e| e.into_inner());
            if !send.is_empty() && wire::write_frame(&mut *out, DATA, send).is_err() {
                return;
            }
            if n == 0 || cut.is_some() {
                leaving.store(true, Ordering::SeqCst);
                let _ = out.shutdown(Shutdown::Both);
                return;
            }
        }
    });

    let mut out = io::stdout().lock();
    let ended = loop {
        match wire::read_frame(&mut reader) {
            Ok(Some((DATA, payload))) => {
                if out.write_all(&payload).and_then(|()| out.flush()).is_err() {
                    let _ = stream.shutdown(Shutdown::Both);
                    break Ended::Closed;
                }
            }
            Ok(Some((EXIT, payload))) => break Ended::Exited(wire::parse_exit(&payload)),
            Ok(Some(_)) => {}
            _ if detached.load(Ordering::SeqCst) => break Ended::Detached,
            Ok(None) | Err(_) => break Ended::Closed,
        }
    };
    let _ = out.write_all(UNDO_MODES).and_then(|()| out.flush());
    drop(raw);
    Ok(ended)
}
