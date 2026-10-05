//! Where connections come from. Everything above this (framing, auth, dispatch,
//! subscriptions) sees only [`Stream`], so a TCP or WebSocket listener later is
//! a second implementation here and nothing else.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

pub trait Stream: Read + Write + Send {
    fn try_clone_box(&self) -> io::Result<Box<dyn Stream>>;
    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()>;
    /// Ends both directions, which also unblocks a thread reading the stream.
    fn close(&self);
}

pub trait Transport: Send + Sync {
    /// The next connection, or `None` once the transport has been shut down.
    fn accept(&self) -> io::Result<Option<Box<dyn Stream>>>;
    fn shutdown(&self);
}

impl Stream for UnixStream {
    fn try_clone_box(&self) -> io::Result<Box<dyn Stream>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        UnixStream::set_read_timeout(self, timeout)
    }
    fn close(&self) {
        let _ = UnixStream::shutdown(self, Shutdown::Both);
    }
}

pub struct UnixTransport {
    listener: UnixListener,
    sock_path: PathBuf,
    dir: PathBuf,
    stopping: AtomicBool,
}

impl UnixTransport {
    /// Binds `$TMPDIR/tori-rpc-<pid>-<seq>/s`. The counter keeps two servers in
    /// one process (parallel tests) off each other's socket, and the path stays
    /// short because Darwin caps `sun_path` at 104 bytes.
    pub fn bind() -> io::Result<Self> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori-rpc-{}-{}", std::process::id(), seq));
        let sock_path = dir.join("s");
        if sock_path.as_os_str().len() >= 104 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("rpc socket path too long for sun_path: {}", sock_path.display()),
            ));
        }
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        let _ = std::fs::remove_file(&sock_path);
        let listener = UnixListener::bind(&sock_path)?;
        std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            listener,
            sock_path,
            dir,
            stopping: AtomicBool::new(false),
        })
    }

    pub fn sock_path(&self) -> &Path {
        &self.sock_path
    }
}

impl Transport for UnixTransport {
    fn accept(&self) -> io::Result<Option<Box<dyn Stream>>> {
        let (stream, _) = self.listener.accept()?;
        // Checked after the accept returns, so `shutdown`'s own wake-up connect
        // is never served as a client.
        if self.stopping.load(Ordering::SeqCst) {
            return Ok(None);
        }
        Ok(Some(Box::new(stream)))
    }

    /// Idempotent. The self-connect is what wakes a blocked `accept`.
    fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = UnixStream::connect(&self.sock_path);
        let _ = std::fs::remove_file(&self.sock_path);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Drop for UnixTransport {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.sock_path);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::fs::MetadataExt;
    use std::sync::Arc;

    #[test]
    fn two_transports_in_one_process_bind_side_by_side() {
        let a = UnixTransport::bind().unwrap();
        let b = UnixTransport::bind().unwrap();
        assert_ne!(a.sock_path(), b.sock_path());
        assert!(a.sock_path().as_os_str().len() < 104, "{}", a.sock_path().display());
        let dir_mode = std::fs::metadata(a.sock_path().parent().unwrap()).unwrap().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
    }

    #[test]
    fn an_accepted_stream_carries_bytes_both_ways() {
        let t = Arc::new(UnixTransport::bind().unwrap());
        let server = t.clone();
        let echo = std::thread::spawn(move || {
            let mut s = server.accept().unwrap().unwrap();
            let mut line = String::new();
            BufReader::new(s.try_clone_box().unwrap()).read_line(&mut line).unwrap();
            s.write_all(line.as_bytes()).unwrap();
        });
        let mut c = UnixStream::connect(t.sock_path()).unwrap();
        c.write_all(b"ping\n").unwrap();
        let mut back = String::new();
        BufReader::new(c).read_line(&mut back).unwrap();
        echo.join().unwrap();
        assert_eq!(back, "ping\n");
    }

    #[test]
    fn shutdown_wakes_accept_and_removes_the_dir() {
        let t = Arc::new(UnixTransport::bind().unwrap());
        let dir = t.sock_path().parent().unwrap().to_path_buf();
        let accepting = t.clone();
        let waiter = std::thread::spawn(move || accepting.accept().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(50));
        t.shutdown();
        assert!(waiter.join().unwrap(), "accept returns None once shut down");
        assert!(!dir.exists());
    }
}
