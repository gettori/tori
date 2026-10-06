//! Local sockets only this user can reach.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
pub use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(windows)]
pub use uds_windows::{UnixListener, UnixStream};

// `sun_path` holds 104 bytes on Darwin, 108 on Linux and Windows. The smaller
// one everywhere on Unix, so a path that binds on Linux binds on a Mac.
#[cfg(unix)]
const MAX_SOCKET_PATH: usize = 104;
#[cfg(windows)]
const MAX_SOCKET_PATH: usize = 108;

// Bound at `<temp>/<prefix>-<pid>-<seq>/s`, in a `fs::private_dir`, so
// only this user reaches it even where the temp dir is shared. The directory
// goes when this does.
pub struct PrivateListener {
    listener: UnixListener,
    path: PathBuf,
    dir: PathBuf,
}

impl PrivateListener {
    pub fn bind(prefix: &str) -> io::Result<Self> {
        // The counter keeps two listeners in one process (parallel tests) apart.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{seq}", std::process::id()));
        let path = dir.join("s");
        if path.as_os_str().len() >= MAX_SOCKET_PATH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("socket path too long for sun_path: {}", path.display()),
            ));
        }
        super::fs::private_dir(&dir)?;
        // A stale socket from a crashed run would fail the bind with EADDRINUSE.
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { listener, path, dir })
    }

    pub fn listener(&self) -> &UnixListener {
        &self.listener
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    // The path as it travels in `TORI_SOCK`, `rpc.json` and helper env.
    pub fn path_string(&self) -> String {
        super::fs::display(&self.path)
    }
}

impl Drop for PrivateListener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn connect(path: impl AsRef<Path>) -> io::Result<UnixStream> {
    UnixStream::connect(path)
}

pub fn random_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("the OS random generator is unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn two_listeners_bind_side_by_side_in_private_dirs() {
        let a = PrivateListener::bind("tori-test").unwrap();
        let b = PrivateListener::bind("tori-test").unwrap();
        assert_ne!(a.path(), b.path());
        crate::platform::testing::assert_private(a.path().parent().unwrap());
    }

    #[test]
    fn bytes_cross_a_connection_both_ways() {
        let l = PrivateListener::bind("tori-test").unwrap();
        let mut client = connect(l.path_string()).unwrap();
        let (mut served, _) = l.listener().accept().unwrap();
        client.write_all(b"ping").unwrap();
        let mut buf = [0u8; 4];
        served.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping");
        served.write_all(b"pong").unwrap();
        client.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"pong");
    }

    #[test]
    fn dropping_the_listener_removes_its_dir() {
        let l = PrivateListener::bind("tori-test").unwrap();
        let dir = l.path().parent().unwrap().to_path_buf();
        drop(l);
        assert!(!dir.exists());
    }

    #[test]
    fn tokens_are_32_hex_chars_and_differ() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
