//! `tori daemon`: the process that owns the app socket, so the socket outlives
//! the window. It authenticates every client, holds their subscriptions and the
//! child tokens, and relays each method to the one window attached, which still
//! answers them. See [[adr_one_protocol_several_fronts]].
//!
//! The window link is one connection carrying both directions: the daemon
//! sends `call` requests down and reads their replies, the window sends
//! `mint`, `revoke` and `publish` up. Replies come back in any order.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread::{self, JoinHandle};

use serde::Deserialize;
use serde_json::{json, Value};

use super::auth::{authenticate, Caller, Children, Credential, Principal, AUTH_METHOD};
use super::frame::{
    read_request, to_line, Notification, Request, Response, RpcError, INVALID_PARAMS, INVALID_REQUEST,
    METHOD_NOT_FOUND, REFUSED,
};
use super::hub::{Channel, ConnId, Hub};
use super::outbox::{Outbox, OUTBOX_BYTES};
use super::server::{handle_first, subscribe, unsubscribe, Dispatch, AUTH_TIMEOUT};
use super::table::CallerKind;
use super::transport::{Stream, Transport, UnixTransport};
use crate::pty::host::{Events, Host};
use crate::pty::wire::{AttachParams, Spawn, ATTACH_METHOD};

pub const WINDOW_METHOD: &str = "window";
/// The shape of the window link. A window and a daemon that disagree on it
/// cannot talk, whatever their builds.
pub const PROTOCOL: u32 = 1;
/// A reply the window sends back can be a whole diff, and the window is the
/// one peer here that is already trusted with everything.
pub const MAX_LINK_LINE: usize = 1024 * 1024 * 1024;

const NO_WINDOW: &str = "no Tori window is open to answer this";

/// Where one config dir's daemon lives. Everything is derived, so the app, the
/// daemon and a test agree on it without asking each other.
#[derive(Debug, Clone)]
pub struct Paths {
    pub dir: PathBuf,
    pub sock: PathBuf,
    pub cli_link_dir: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
    pub rpc_json: PathBuf,
}

impl Paths {
    pub fn under(config: &Path) -> Self {
        let dir = config.join("run");
        let mut sock = dir.join("tori.sock");
        // Darwin caps `sun_path` at 104 bytes; a long home dir gets a short,
        // still per config dir, path instead.
        if sock.as_os_str().len() >= 104 {
            use sha2::Digest;
            let tag = format!("{:x}", sha2::Sha256::digest(config.as_os_str().as_encoded_bytes()));
            sock = PathBuf::from(format!("/tmp/tori-{}-{}", euid(), &tag[..8])).join("s");
        }
        Self {
            cli_link_dir: dir.join("bin"),
            lock: dir.join("daemon.lock"),
            log: dir.join("daemon.log"),
            rpc_json: config.join("rpc.json"),
            sock,
            dir,
        }
    }
}

pub fn paths() -> Paths {
    Paths::under(&crate::owned_state::config_dir())
}

fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// Which binary this process is. A rebuild keeps the version, so the version
/// alone would call a stale daemon current.
pub fn build_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let stamp = std::env::current_exe()
            .and_then(std::fs::metadata)
            .map(|m| format!("{}.{}.{}", m.mtime(), m.mtime_nsec(), m.size()))
            .unwrap_or_default();
        format!("{}+{stamp}", env!("CARGO_PKG_VERSION"))
    })
}

// The socket and the lock live here, so a link or another user's dir is refused.
fn private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !meta.is_dir() || meta.uid() != euid() {
        return Err(format!("{} is not a directory of this user's", dir.display()));
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(())
}

fn take_lock(path: &Path) -> Result<Option<File>, String> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    // SAFETY: the fd is open for as long as `file` lives, which outlives the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    let e = io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::EWOULDBLOCK) => Ok(None),
        _ => Err(format!("{}: {e}", path.display())),
    }
}

// So a replacement started after this does not find the old one still holding it.
pub fn wait_released(lock: &Path, wait: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + wait;
    loop {
        if let Ok(Some(_held)) = take_lock(lock) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn link_cli(bin: &Path) -> io::Result<()> {
    std::fs::create_dir_all(bin)?;
    let link = bin.join("tori");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(std::env::current_exe()?, link)
}

struct Window {
    out: Arc<Outbox>,
    pending: Mutex<HashMap<u64, SyncSender<Result<Value, RpcError>>>>,
    next: AtomicU64,
}

impl Window {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, SyncSender<Result<Value, RpcError>>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Blocks this client's reader only: every other client, and the window's
    /// own traffic, goes on while the window answers.
    fn await_reply(&self, principal: &Principal, req: &Request) -> Result<Value, RpcError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = sync_channel(1);
        self.pending().insert(id, tx);
        let line = to_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "call",
            "params": { "principal": principal, "method": req.method, "params": req.params },
        }));
        if !self.out.push(line) {
            self.pending().remove(&id);
            return Err(RpcError::new(REFUSED, NO_WINDOW));
        }
        rx.recv().unwrap_or_else(|_| Err(RpcError::new(REFUSED, NO_WINDOW)))
    }

    fn notify(&self, method: &'static str, params: Value) {
        self.out.push(to_line(&Notification::new(method, params)));
    }

    fn settle(&self, id: u64, outcome: Result<Value, RpcError>) {
        if let Some(tx) = self.pending().remove(&id) {
            let _ = tx.send(outcome);
        }
    }

    // After the outbox is closed, so no call can register behind this.
    fn fail_all(&self) {
        self.pending().clear();
    }
}

pub struct Daemon {
    hub: Arc<Hub>,
    credential: Arc<Credential>,
    children: Arc<Children>,
    transport: Arc<UnixTransport>,
    paths: Paths,
    window: Mutex<Option<Arc<Window>>>,
    ptys: Arc<Host>,
    // The app process last attached, so a new one starts with no stale child tokens.
    instance: Mutex<Option<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowParams {
    token: String,
    build: String,
    instance: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MintParams {
    caller: Caller,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TabParams {
    tab: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteParams {
    tab: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResizeParams {
    tab: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublishParams {
    topic: String,
    data: Value,
}

impl Daemon {
    fn window(&self) -> Option<Arc<Window>> {
        self.window
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .filter(|w| !w.out.is_closed())
    }

    fn notify_window(&self, method: &'static str, params: Value) {
        if let Some(window) = self.window() {
            window.notify(method, params);
        }
    }

    // The link too, so the window hears it at once rather than at process exit.
    pub fn stop(&self) {
        self.transport.shutdown();
        if let Some(window) = self.window() {
            window.out.close();
        }
    }

    fn connection(self: &Arc<Self>, stream: Box<dyn Stream>) {
        let Ok(read_half) = stream.try_clone_box() else { return };
        let mut reader = BufReader::new(read_half);
        let _ = stream.set_read_timeout(Some(AUTH_TIMEOUT));
        let first = read_request(&mut reader);
        if let Ok(Some(req)) = &first {
            if req.method == WINDOW_METHOD {
                let _ = stream.set_read_timeout(None);
                let req = req.clone();
                self.serve_window(req, stream, reader);
                return;
            }
            if req.method == ATTACH_METHOD {
                let _ = stream.set_read_timeout(None);
                let req = req.clone();
                self.serve_attach(req, stream, reader);
                return;
            }
        }
        handle_first(self.as_ref(), &self.credential, stream, reader, first);
    }

    // Only the process token: a child's would let an agent stand in for the
    // person at every card and prompt the window answers.
    fn admit(&self, first: &Request) -> Result<(WindowParams, Arc<Window>), RpcError> {
        let params: WindowParams =
            serde_json::from_value(first.params.clone()).map_err(|e| RpcError::new(INVALID_PARAMS, e.to_string()))?;
        self.local_only(&params.token, "be the window")?;
        let mut slot = self.window.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|w| !w.out.is_closed()) {
            eprintln!("tori daemon: refused a second window while one is attached");
            return Err(RpcError::new(REFUSED, "a Tori window is already attached"));
        }
        let mut instance = self.instance.lock().unwrap_or_else(|e| e.into_inner());
        if instance.as_deref() != Some(params.instance.as_str()) {
            // The daemon's own shells outlive the window; what it spawned did not.
            self.children.keep_only(&self.ptys.tokens());
            *instance = Some(params.instance.clone());
        }
        drop(instance);
        if let Some(token) = self.credential.rotate() {
            let sock = self.paths.sock.to_string_lossy();
            if let Err(e) = crate::credential::write_bridge(&self.paths.rpc_json, &sock, &token) {
                eprintln!("tori daemon: rpc bridge file not written: {e}");
            }
        }
        let window = Arc::new(Window {
            out: Arc::new(Outbox::new(OUTBOX_BYTES)),
            pending: Mutex::default(),
            next: AtomicU64::new(0),
        });
        *slot = Some(window.clone());
        Ok((params, window))
    }

    fn local_only(&self, token: &str, what: &str) -> Result<(), RpcError> {
        let auth = Request {
            jsonrpc: "2.0".into(),
            id: None,
            method: AUTH_METHOD.into(),
            params: json!({ "token": token }),
        };
        match authenticate(&auth, &self.credential) {
            Ok(Principal::Local) => Ok(()),
            Ok(_) => Err(RpcError::new(REFUSED, format!("only a local client may {what}"))),
            Err(e) => Err(e.rpc()),
        }
    }

    // Only the process token: a child's would let an agent type into every
    // shell the person has open.
    fn serve_attach(&self, first: Request, mut stream: Box<dyn Stream>, reader: BufReader<Box<dyn Stream>>) {
        let id = first.id.clone().unwrap_or(Value::Null);
        let admitted = serde_json::from_value::<AttachParams>(first.params)
            .map_err(|e| RpcError::new(INVALID_PARAMS, e.to_string()))
            .and_then(|params| self.local_only(&params.token, "attach to a tab").map(|()| params));
        match admitted {
            Ok(params) => self.ptys.attach(id, &params, stream, reader),
            Err(e) => {
                let _ = super::frame::write_line(&mut stream, &to_line(&Response::err(id, e)));
                stream.close();
            }
        }
    }

    fn serve_window(
        self: &Arc<Self>,
        first: Request,
        mut stream: Box<dyn Stream>,
        mut reader: BufReader<Box<dyn Stream>>,
    ) {
        let id = first.id.clone().unwrap_or(Value::Null);
        let (params, window) = match self.admit(&first) {
            Ok(admitted) => admitted,
            Err(e) => {
                let _ = super::frame::write_line(&mut stream, &to_line(&Response::err(id, e)));
                stream.close();
                return;
            }
        };
        if params.build != build_id() {
            eprintln!("tori daemon: window build {} differs from {}", params.build, build_id());
        }
        window.out.push(to_line(&Response::ok(
            id,
            json!({
                "build": build_id(),
                "protocol": PROTOCOL,
                "sock": self.paths.sock,
                "bin": self.paths.cli_link_dir,
            }),
        )));
        window.notify("chats", json!(self.hub.chats()));
        let Ok(mut write_half) = stream.try_clone_box() else {
            return;
        };
        let out = window.out.clone();
        let writer = thread::spawn(move || {
            out.drain(&mut write_half);
            write_half.close();
        });
        while let Ok(Some(line)) = read_line(&mut reader, MAX_LINK_LINE) {
            self.heard(&window, &line);
        }
        window.out.close();
        window.fail_all();
        stream.close();
        let _ = writer.join();
        let mut slot = self.window.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|w| Arc::ptr_eq(w, &window)) {
            *slot = None;
        }
    }

    fn heard(&self, window: &Window, line: &str) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            eprintln!("tori daemon: a malformed frame from the window, dropped");
            return;
        };
        if value.get("method").is_none() {
            let Some(id) = value["id"].as_u64() else { return };
            let outcome = match value.get("error") {
                Some(error) => Err(serde_json::from_value(error.clone())
                    .unwrap_or_else(|_| RpcError::new(REFUSED, "the window failed this call"))),
                None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
            };
            window.settle(id, outcome);
            return;
        }
        let Ok(req) = serde_json::from_value::<Request>(value) else {
            return;
        };
        let outcome = self.window_request(&req);
        if let Some(id) = req.id {
            window.out.push(to_line(&Response::reply(id, outcome)));
        }
    }

    // Deliberately short: anything that could wait, `session.wait` or
    // `ask.wait`, would stall the one link every window call rides on.
    fn window_request(&self, req: &Request) -> Result<Value, RpcError> {
        let parse = |what: &str| RpcError::new(INVALID_PARAMS, format!("{what}: bad params"));
        match req.method.as_str() {
            "mint" => {
                let p: MintParams = serde_json::from_value(req.params.clone()).map_err(|_| parse("mint"))?;
                Ok(json!(self.children.mint(p.caller)))
            }
            "revoke" => {
                let p: MintParams = serde_json::from_value(req.params.clone()).map_err(|_| parse("revoke"))?;
                self.children.revoke(&p.caller);
                Ok(json!({}))
            }
            "publish" => {
                let p: PublishParams = serde_json::from_value(req.params.clone()).map_err(|_| parse("publish"))?;
                let channel = Channel::parse(&p.topic)
                    .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("unknown topic {}", p.topic)))?;
                self.hub.publish(&channel, p.data);
                Ok(json!({}))
            }
            "pty.spawn" => {
                let p: Spawn = serde_json::from_value(req.params.clone()).map_err(|_| parse("pty.spawn"))?;
                let existed = self.ptys.spawn(p).map_err(|e| RpcError::new(REFUSED, e))?;
                Ok(json!({ "existed": existed }))
            }
            "pty.write" => {
                let p: WriteParams = serde_json::from_value(req.params.clone()).map_err(|_| parse("pty.write"))?;
                self.ptys.write(&p.tab, p.data.as_bytes());
                Ok(json!({}))
            }
            "pty.resize" => {
                let p: ResizeParams = serde_json::from_value(req.params.clone()).map_err(|_| parse("pty.resize"))?;
                self.ptys.resize(&p.tab, p.cols, p.rows);
                Ok(json!({}))
            }
            "pty.kill" => {
                let p: TabParams = serde_json::from_value(req.params.clone()).map_err(|_| parse("pty.kill"))?;
                self.ptys.kill(&p.tab);
                Ok(json!({}))
            }
            "pty.list" => Ok(json!(self.ptys.list())),
            "shutdown" => {
                eprintln!("tori daemon: stopping, asked by the window");
                self.stop();
                Ok(json!({}))
            }
            name => Err(RpcError::new(
                METHOD_NOT_FOUND,
                format!("the window link carries mint, revoke, publish, pty and shutdown, not {name}"),
            )),
        }
    }
}

impl Dispatch for Daemon {
    fn hub(&self) -> &Hub {
        &self.hub
    }

    fn auth_timeout(&self) -> std::time::Duration {
        AUTH_TIMEOUT
    }

    fn dispatch(&self, conn: ConnId, principal: &Principal, req: &Request) -> Result<Value, RpcError> {
        match req.method.as_str() {
            "subscribe" => subscribe(&self.hub, CallerKind::of(principal), conn, &req.params, || {
                self.notify_window("watching", json!({}))
            }),
            "unsubscribe" => unsubscribe(&self.hub, conn, &req.params),
            "auth" => Err(RpcError::new(INVALID_REQUEST, "already authenticated")),
            _ => match self.window() {
                Some(window) => window.await_reply(principal, req),
                None => Err(RpcError::new(REFUSED, NO_WINDOW)),
            },
        }
    }
}

/// A line past `cap` ends the link: the rest of it is still in the stream.
pub fn read_line(reader: &mut impl BufRead, cap: usize) -> io::Result<Option<String>> {
    loop {
        let mut line = Vec::new();
        let n = reader.by_ref().take(cap as u64 + 1).read_until(b'\n', &mut line)?;
        if n == 0 {
            return Ok(None);
        }
        if line.len() > cap {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "link line too long"));
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim();
        if !text.is_empty() {
            return Ok(Some(text.to_string()));
        }
    }
}

pub struct Started {
    accept: JoinHandle<()>,
    #[cfg(test)]
    daemon: Arc<Daemon>,
    _lock: File,
}

impl Started {
    pub fn wait(self) {
        let _ = self.accept.join();
    }
}

pub enum Start {
    Started(Started),
    Running,
}

pub fn start(paths: Paths) -> Result<Start, String> {
    private_dir(&paths.dir)?;
    if let Some(parent) = paths.sock.parent().filter(|p| *p != paths.dir) {
        private_dir(parent)?;
    }
    let Some(mut lock) = take_lock(&paths.lock)? else {
        return Ok(Start::Running);
    };
    let _ = lock.set_len(0).and_then(|()| writeln!(lock, "{}", std::process::id()));
    let transport = Arc::new(UnixTransport::bind_at(&paths.sock).map_err(|e| e.to_string())?);
    let children = Arc::new(Children::default());
    let token = crate::chat::approval::random_token();
    let credential = Arc::new(Credential::Local {
        process: token.clone().into(),
        children: children.clone(),
    });
    crate::credential::write_bridge(&paths.rpc_json, &paths.sock.to_string_lossy(), &token)
        .map_err(|e| format!("rpc bridge file not written: {e}"))?;
    if let Err(e) = link_cli(&paths.cli_link_dir) {
        eprintln!("tori daemon: cli not linked: {e}");
    }
    let daemon = Arc::new_cyclic(|weak: &Weak<Daemon>| {
        let weak = weak.clone();
        let events: Events = Box::new(move |event, payload| {
            if let Some(daemon) = weak.upgrade() {
                daemon.notify_window(event, payload);
            }
        });
        Daemon {
            hub: Arc::new(Hub::default()),
            ptys: Host::new(events, children.clone(), paths.sock.clone(), paths.cli_link_dir.clone()),
            credential,
            children,
            transport: transport.clone(),
            paths,
            window: Mutex::default(),
            instance: Mutex::default(),
        }
    });
    let weak: Weak<Daemon> = Arc::downgrade(&daemon);
    daemon.hub.watch_chats(Box::new(move |ids: HashSet<String>| {
        if let Some(daemon) = weak.upgrade() {
            daemon.notify_window("chats", json!(ids));
        }
    }));
    let accepting = daemon.clone();
    let accept = thread::spawn(move || loop {
        match accepting.transport.accept() {
            Ok(Some(stream)) => {
                let daemon = accepting.clone();
                thread::spawn(move || daemon.connection(stream));
            }
            Ok(None) => break,
            Err(e) => {
                eprintln!("tori daemon: accept failed: {e}");
                thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    });
    Ok(Start::Started(Started {
        accept,
        #[cfg(test)]
        daemon: daemon.clone(),
        _lock: lock,
    }))
}

pub fn run() -> i32 {
    match start(paths()) {
        Ok(Start::Running) => {
            eprintln!("tori daemon: already running");
            0
        }
        Ok(Start::Started(started)) => {
            // After the socket answers, so a window never waits on a slow
            // login shell. Every spawn waits on this capture instead.
            thread::spawn(|| {
                crate::env::login_path();
            });
            started.wait();
            0
        }
        Err(e) => {
            eprintln!("tori daemon: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::server::tests::{StubBackend, SLOW};
    use crate::rpc::server::Server;
    use crate::rpc::window::Link;
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    fn config(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn started(paths: &Paths) -> Started {
        match start(paths.clone()).unwrap() {
            Start::Started(s) => s,
            Start::Running => panic!("a daemon already holds {}", paths.lock.display()),
        }
    }

    fn app(paths: &Paths) -> (Arc<Server>, Arc<Link>) {
        let server = Arc::new(Server {
            hub: Arc::default(),
            backend: Box::<StubBackend>::default(),
            auth_timeout: AUTH_TIMEOUT,
        });
        let link = Link::start(
            server.clone(),
            paths.clone(),
            false,
            Box::new(|_| {}),
            Box::new(|_, _| {}),
        );
        assert!(link.attached(Duration::from_secs(5)), "the window attaches");
        (server, link)
    }

    struct Raw {
        out: UnixStream,
        reader: BufReader<UnixStream>,
    }

    impl Raw {
        fn connect(paths: &Paths) -> Self {
            let out = UnixStream::connect(&paths.sock).unwrap();
            out.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let reader = BufReader::new(out.try_clone().unwrap());
            Self { out, reader }
        }

        fn send(&mut self, v: Value) {
            self.out.write_all(to_line(&v).as_bytes()).unwrap();
        }

        fn recv(&mut self) -> Value {
            serde_json::from_str(&read_line(&mut self.reader, MAX_LINK_LINE).unwrap().unwrap()).unwrap()
        }

        fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
            self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
            loop {
                let v = self.recv();
                if v["id"] == json!(id) {
                    return v;
                }
            }
        }

        fn authed(paths: &Paths, token: &str) -> Self {
            let mut raw = Self::connect(paths);
            assert!(raw.call(1, "auth", json!({ "token": token }))["error"].is_null());
            raw
        }
    }

    fn token(paths: &Paths) -> String {
        crate::credential::socket_in_file(&paths.rpc_json).unwrap().1
    }

    fn stop(started: Started) {
        started.daemon.stop();
        started.wait();
    }

    #[test]
    fn two_daemons_started_together_leave_one_running() {
        let paths = Paths::under(&config("two"));
        let racers: Vec<_> = (0..2)
            .map(|_| {
                let paths = paths.clone();
                thread::spawn(move || start(paths).unwrap())
            })
            .collect();
        let outcomes: Vec<Start> = racers.into_iter().map(|t| t.join().unwrap()).collect();
        let mut running = outcomes.into_iter().filter_map(|o| match o {
            Start::Started(s) => Some(s),
            Start::Running => None,
        });
        let one = running.next().expect("one starts");
        assert!(running.next().is_none(), "the other finds it running");
        stop(one);
    }

    #[test]
    fn the_window_is_answered_at_once_on_a_cold_start() {
        let paths = Paths::under(&config("cold"));
        let begun = Instant::now();
        let daemon = started(&paths);
        let mut raw = Raw::connect(&paths);
        let reply = raw.call(
            0,
            WINDOW_METHOD,
            json!({ "token": token(&paths), "build": build_id(), "instance": "a" }),
        );
        assert!(begun.elapsed() < Duration::from_millis(100), "{:?}", begun.elapsed());
        assert_eq!(reply["result"]["protocol"], json!(PROTOCOL));
        raw.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }));
        daemon.wait();
    }

    #[test]
    fn attaching_a_window_rotates_the_bridge_token() {
        let paths = Paths::under(&config("rotate"));
        let daemon = started(&paths);
        let before = token(&paths);
        let (_server, link) = app(&paths);
        let after = token(&paths);
        assert_ne!(before, after);
        let mut stale = Raw::connect(&paths);
        assert!(!stale.call(1, "auth", json!({ "token": before }))["error"].is_null());
        Raw::authed(&paths, &after);
        link.close();
        stop(daemon);
    }

    #[test]
    fn only_one_local_window_is_admitted() {
        let paths = Paths::under(&config("window"));
        let daemon = started(&paths);
        let (_server, link) = app(&paths);
        let child = link.mint(Caller::Terminal("t1".into())).unwrap();
        let mut agent = Raw::connect(&paths);
        let refused = agent.call(
            0,
            WINDOW_METHOD,
            json!({ "token": child, "build": build_id(), "instance": "x" }),
        );
        assert_eq!(refused["error"]["message"], "only a local client may be the window");
        let mut second = Raw::connect(&paths);
        let refused = second.call(
            0,
            WINDOW_METHOD,
            json!({ "token": token(&paths), "build": build_id(), "instance": "x" }),
        );
        assert_eq!(refused["error"]["message"], "a Tori window is already attached");
        let mut tab = Raw::authed(&paths, &child);
        assert_eq!(tab.call(2, "caller", json!({}))["result"]["caller"]["id"], "t1");
        link.close();
        stop(daemon);
    }

    #[test]
    fn a_slow_call_holds_up_no_other_client() {
        let paths = Paths::under(&config("order"));
        let daemon = started(&paths);
        let (_server, link) = app(&paths);
        let local = token(&paths);
        let slow = {
            let (paths, local) = (paths.clone(), local.clone());
            thread::spawn(move || Raw::authed(&paths, &local).call(2, "session.wait", json!({ "id": SLOW })))
        };
        thread::sleep(Duration::from_millis(100));
        let begun = Instant::now();
        let quick = Raw::authed(&paths, &local).call(2, "caller", json!({}));
        assert!(quick["error"].is_null(), "{quick}");
        assert!(begun.elapsed() < Duration::from_millis(400), "{:?}", begun.elapsed());
        assert_eq!(slow.join().unwrap()["result"]["id"], SLOW);
        link.close();
        stop(daemon);
    }

    #[test]
    fn the_window_link_refuses_the_waits() {
        let paths = Paths::under(&config("waits"));
        let daemon = started(&paths);
        let mut window = Raw::connect(&paths);
        window.call(
            0,
            WINDOW_METHOD,
            json!({ "token": token(&paths), "build": build_id(), "instance": "a" }),
        );
        for method in ["session.wait", "ask.wait"] {
            let refused = window.call(5, method, json!({ "id": "s1" }));
            assert_eq!(refused["error"]["code"], json!(METHOD_NOT_FOUND), "{method}");
        }
        window.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }));
        daemon.wait();
    }

    #[test]
    fn the_apps_events_reach_the_daemons_subscribers() {
        let paths = Paths::under(&config("events"));
        let daemon = started(&paths);
        let (server, link) = app(&paths);
        let mut client = Raw::authed(&paths, &token(&paths));
        client.call(2, "subscribe", json!({ "topic": "sessions" }));
        client.call(3, "subscribe", json!({ "topic": "chat:s1" }));
        server
            .hub
            .publish(&Channel::Sessions, json!({ "kind": "session.started", "id": "s1" }));
        let event = client.recv();
        assert_eq!(event["params"]["data"]["kind"], "session.started");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !server.hub.watches_chat("s1") && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(server.hub.watches_chat("s1"), "the app hears who reads a chat");
        link.close();
        stop(daemon);
    }

    fn window(paths: &Paths) -> Raw {
        let mut window = Raw::connect(paths);
        let reply = window.call(
            0,
            WINDOW_METHOD,
            json!({ "token": token(paths), "build": build_id(), "instance": "a" }),
        );
        assert!(reply["error"].is_null(), "{reply}");
        window
    }

    fn spawn_command(window: &mut Raw, tab: &str, program: &str, args: &[&str]) {
        let spawn = Spawn {
            tab: tab.into(),
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cwd: "/".into(),
            cols: 80,
            rows: 24,
            kind: "command".into(),
            init: None,
            quiet_ms: None,
            env: Vec::new(),
            agent: None,
            profile: None,
        };
        let reply = window.call(1, "pty.spawn", json!(spawn));
        assert_eq!(reply["result"]["existed"], false, "{reply}");
    }

    fn attach(paths: &Paths, token: &str, tab: &str, replay: bool) -> (UnixStream, BufReader<UnixStream>, Value) {
        let mut stream = UnixStream::connect(&paths.sock).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let params = AttachParams {
            token: token.into(),
            tab: tab.into(),
            replay,
            cols: 80,
            rows: 24,
        };
        let frame = json!({ "jsonrpc": "2.0", "id": 0, "method": ATTACH_METHOD, "params": params });
        stream.write_all(to_line(&frame).as_bytes()).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let reply = serde_json::from_str(&read_line(&mut reader, MAX_LINK_LINE).unwrap().unwrap()).unwrap();
        (stream, reader, reply)
    }

    fn drain(reader: &mut BufReader<UnixStream>, until: impl Fn(&[u8]) -> bool) -> (Vec<u8>, Option<Option<u32>>) {
        let mut seen = Vec::new();
        while let Some((kind, payload)) = crate::pty::wire::read_frame(reader).unwrap() {
            match kind {
                crate::pty::wire::DATA => seen.extend_from_slice(&payload),
                crate::pty::wire::EXIT => return (seen, Some(crate::pty::wire::parse_exit(&payload))),
                _ => {}
            }
            if until(&seen) {
                break;
            }
        }
        (seen, None)
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        String::from_utf8_lossy(haystack).contains(needle)
    }

    #[test]
    fn an_attach_gets_the_ring_then_live_bytes_and_types_into_the_tab() {
        let paths = Paths::under(&config("attach"));
        let daemon = started(&paths);
        let mut window = window(&paths);
        spawn_command(
            &mut window,
            "t1",
            "/bin/sh",
            &["-c", "printf early; read x; printf \"late:$x\""],
        );
        thread::sleep(Duration::from_millis(300));
        let (mut stream, mut reader, reply) = attach(&paths, &token(&paths), "t1", true);
        assert!(reply["error"].is_null(), "{reply}");
        let (replayed, _) = drain(&mut reader, |seen| contains(seen, "early"));
        assert!(contains(&replayed, "early"), "{:?}", String::from_utf8_lossy(&replayed));
        crate::pty::wire::write_frame(&mut stream, crate::pty::wire::DATA, b"go\n").unwrap();
        let (live, exit) = drain(&mut reader, |_| false);
        assert!(contains(&live, "late:go"), "{:?}", String::from_utf8_lossy(&live));
        assert_eq!(exit, Some(Some(0)));
        window.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }));
        daemon.wait();
    }

    #[test]
    fn a_child_token_cannot_attach_to_a_tab() {
        let paths = Paths::under(&config("attach-child"));
        let daemon = started(&paths);
        let mut window = window(&paths);
        spawn_command(&mut window, "t1", "sleep", &["5"]);
        let child = window.call(2, "mint", json!({ "caller": Caller::Terminal("t2".into()) }));
        let child = child["result"].as_str().unwrap();
        let (_stream, _reader, reply) = attach(&paths, child, "t1", true);
        assert_eq!(reply["error"]["message"], "only a local client may attach to a tab");
        window.call(3, "pty.kill", json!({ "tab": "t1" }));
        window.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }));
        daemon.wait();
    }

    #[test]
    fn a_flood_of_output_arrives_whole_and_the_window_keeps_answering() {
        let paths = Paths::under(&config("flood"));
        let daemon = started(&paths);
        let mut window = window(&paths);
        spawn_command(&mut window, "t1", "/bin/sh", &["-c", "sleep 0.2; seq 1 200000"]);
        let (_stream, mut reader, _) = attach(&paths, &token(&paths), "t1", true);
        let listed = window.call(4, "pty.list", json!({}));
        assert_eq!(listed["result"][0]["tab"], "t1", "{listed}");
        let (seen, exit) = drain(&mut reader, |_| false);
        assert_eq!(exit, Some(Some(0)));
        let expected: String = (1..=200_000).map(|i| format!("{i}\n")).collect();
        assert!(
            String::from_utf8_lossy(&seen).replace('\r', "") == expected,
            "{} bytes arrived of {}",
            seen.len(),
            expected.len()
        );
        window.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }));
        daemon.wait();
    }

    #[test]
    fn a_keystroke_echoes_back_through_the_daemon() {
        let paths = Paths::under(&config("echo"));
        let daemon = started(&paths);
        let mut window = window(&paths);
        spawn_command(&mut window, "t1", "cat", &[]);
        let (mut stream, mut reader, _) = attach(&paths, &token(&paths), "t1", false);
        let mut took = Vec::new();
        for _ in 0..50 {
            // Spaced like typing: back to back, each echo would wait out the coalescing window.
            thread::sleep(Duration::from_millis(30));
            let begun = Instant::now();
            crate::pty::wire::write_frame(&mut stream, crate::pty::wire::DATA, b"a").unwrap();
            drain(&mut reader, |seen| contains(seen, "a"));
            took.push(begun.elapsed());
        }
        took.sort();
        eprintln!("echo through the daemon: median {:?}, worst {:?}", took[25], took[49]);
        assert!(took[25] < Duration::from_millis(5), "median echo {:?}", took[25]);
        window.call(3, "pty.kill", json!({ "tab": "t1" }));
        window.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "shutdown" }));
        daemon.wait();
    }

    #[test]
    fn a_window_whose_daemon_restarts_attaches_again() {
        let paths = Paths::under(&config("again"));
        let daemon = started(&paths);
        let (_server, link) = app(&paths);
        let mut window_side = Raw::authed(&paths, &token(&paths));
        assert!(window_side.call(2, "caller", json!({}))["error"].is_null());
        drop(window_side);
        stop(daemon);
        let daemon = started(&paths);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut answered = false;
        // The window attaching rotates the token, so a read just before it is stale.
        while Instant::now() < deadline && !answered {
            let mut client = Raw::connect(&paths);
            answered = client.call(1, "auth", json!({ "token": token(&paths) }))["error"].is_null()
                && client.call(2, "caller", json!({}))["error"].is_null();
            thread::sleep(Duration::from_millis(50));
        }
        assert!(answered, "the relaunched daemon reaches the same window");
        link.close();
        stop(daemon);
    }
}
