//! Where connections come from. Everything above this (framing, auth, dispatch,
//! subscriptions) sees only [`Stream`], so a TCP or WebSocket listener later is
//! a second implementation here and nothing else.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::platform::ipc::{self, PrivateListener, UnixStream};

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
    listener: PrivateListener,
    stopping: AtomicBool,
}

impl UnixTransport {
    /// Binds `<temp>/tori-rpc-<pid>-<seq>/s`.
    pub fn bind() -> io::Result<Self> {
        Ok(Self {
            listener: PrivateListener::bind("tori-rpc")?,
            stopping: AtomicBool::new(false),
        })
    }

    pub fn sock_path(&self) -> &Path {
        self.listener.path()
    }
}

impl Transport for UnixTransport {
    fn accept(&self) -> io::Result<Option<Box<dyn Stream>>> {
        let (stream, _) = self.listener.listener().accept()?;
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
        let _ = ipc::connect(self.sock_path());
        if let Some(dir) = self.sock_path().parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::sync::Arc;

    #[test]
    fn two_transports_in_one_process_bind_side_by_side() {
        let a = UnixTransport::bind().unwrap();
        let b = UnixTransport::bind().unwrap();
        assert_ne!(a.sock_path(), b.sock_path());
        crate::platform::testing::assert_private(a.sock_path().parent().unwrap());
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
        let mut c = ipc::connect(t.sock_path()).unwrap();
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
