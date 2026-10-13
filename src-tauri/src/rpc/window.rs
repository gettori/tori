//! The app's end of the window link. Each relayed call runs on a thread of its
//! own and replies when done, so a slow read never holds up a quick one
//! behind it. See `daemon.rs` for the other end.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::auth::{Caller, Principal};
use super::daemon::{build_id, read_line, wait_released, Paths, MAX_LINK_LINE, PROTOCOL, WINDOW_METHOD};
use super::frame::{to_line, Notification, Request, Response, RpcError, INTERNAL_ERROR, INVALID_PARAMS, REFUSED};
use super::hub::Channel;
use super::outbox::{Outbox, OUTBOX_BYTES};
use super::server::Server;

const MINT_WAIT: Duration = Duration::from_secs(3);
const HANDSHAKE_WAIT: Duration = Duration::from_secs(5);
const DAEMON_START_WAIT: Duration = Duration::from_secs(3);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", content = "message", rename_all = "lowercase")]
pub enum Status {
    Connecting,
    Connected,
    Unreachable(String),
}

type Pending = Mutex<HashMap<u64, SyncSender<Result<Value, RpcError>>>>;

struct Conn {
    out: Arc<Outbox>,
    pending: Pending,
    next: AtomicU64,
    stream: UnixStream,
}

impl Conn {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, SyncSender<Result<Value, RpcError>>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct Link {
    server: Arc<Server>,
    paths: Paths,
    // Off in tests, which start their own daemon.
    spawn: bool,
    instance: String,
    conn: Mutex<Option<Arc<Conn>>>,
    attached: Condvar,
    // Set once an attach has failed, so a spawn stops waiting on a link that is not coming.
    unreachable: AtomicBool,
    closing: AtomicBool,
    on_status: Box<dyn Fn(&Status) + Send + Sync>,
}

impl Link {
    pub fn start(
        server: Arc<Server>,
        paths: Paths,
        spawn: bool,
        on_status: Box<dyn Fn(&Status) + Send + Sync>,
    ) -> Arc<Self> {
        let link = Arc::new(Self {
            server,
            paths,
            spawn,
            instance: format!("{}-{}", std::process::id(), crate::chat::approval::random_token()),
            conn: Mutex::default(),
            attached: Condvar::new(),
            unreachable: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            on_status,
        });
        let upstream = Arc::downgrade(&link);
        link.server.hub.set_upstream(Arc::new(move |channel, data| {
            if let Some(link) = upstream.upgrade() {
                link.publish(channel, data);
            }
        }));
        let running = link.clone();
        thread::spawn(move || running.run());
        link
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Arc<Conn>>> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current(&self) -> Option<Arc<Conn>> {
        self.slot().clone().filter(|c| !c.out.is_closed())
    }

    fn run(self: Arc<Self>) {
        let mut failures: u32 = 0;
        let mut restarted = false;
        (self.on_status)(&Status::Connecting);
        while !self.closing.load(Ordering::SeqCst) {
            match self.attach(&mut restarted) {
                Ok((conn, reader)) => {
                    failures = 0;
                    self.unreachable.store(false, Ordering::SeqCst);
                    *self.slot() = Some(conn.clone());
                    self.attached.notify_all();
                    (self.on_status)(&Status::Connected);
                    self.read(&conn, reader);
                    *self.slot() = None;
                    if self.closing.load(Ordering::SeqCst) {
                        return;
                    }
                    (self.on_status)(&Status::Connecting);
                }
                Err(Attach::Restarting) => continue,
                Err(Attach::Failed(e)) => {
                    failures += 1;
                    self.unreachable.store(true, Ordering::SeqCst);
                    self.attached.notify_all();
                    eprintln!("tori: daemon unreachable: {e}");
                    (self.on_status)(&Status::Unreachable(e));
                }
            }
            let wait = Duration::from_millis(250 * 2u64.pow(failures.min(5))).min(BACKOFF_MAX);
            thread::sleep(wait);
        }
    }

    fn connect(&self) -> Result<UnixStream, String> {
        match UnixStream::connect(&self.paths.sock) {
            Ok(stream) => return Ok(stream),
            Err(e) if !self.spawn => return Err(format!("{}: {e}", self.paths.sock.display())),
            Err(_) => {}
        }
        self.spawn_daemon()?;
        let started = Instant::now();
        loop {
            match UnixStream::connect(&self.paths.sock) {
                Ok(stream) => return Ok(stream),
                Err(e) if started.elapsed() >= DAEMON_START_WAIT => {
                    return Err(format!(
                        "the daemon did not start: {e}, see {}",
                        self.paths.log.display()
                    ))
                }
                Err(_) => thread::sleep(Duration::from_millis(25)),
            }
        }
    }

    fn spawn_daemon(&self) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&self.paths.dir).map_err(|e| e.to_string())?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.paths.log)
            .map_err(|e| format!("{}: {e}", self.paths.log.display()))?;
        let mut command = Command::new(exe);
        command
            .arg("daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            // A Tori started from another Tori's terminal carries that one's socket.
            .env_remove(super::ENV_SOCK)
            .env_remove(super::ENV_CALLER);
        // SAFETY: setsid is async-signal-safe and touches nothing of the parent's.
        // Its own session, so the daemon is not in the app's process group when that goes.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    fn attach(&self, restarted: &mut bool) -> Result<(Arc<Conn>, BufReader<UnixStream>), Attach> {
        let mut stream = self.connect().map_err(Attach::Failed)?;
        let sock = self.paths.sock.to_string_lossy();
        let token = crate::credential::socket_in_file(&self.paths.rpc_json)
            .filter(|(at, _)| *at == sock)
            .map(|(_, token)| token)
            .ok_or_else(|| Attach::Failed(format!("{} names another socket", self.paths.rpc_json.display())))?;
        let frame = json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": WINDOW_METHOD,
            "params": { "token": token, "build": build_id(), "instance": self.instance },
        });
        let failed = |e: std::io::Error| Attach::Failed(e.to_string());
        stream.write_all(to_line(&frame).as_bytes()).map_err(failed)?;
        stream.set_read_timeout(Some(HANDSHAKE_WAIT)).map_err(failed)?;
        let mut reader = BufReader::new(stream.try_clone().map_err(failed)?);
        let reply = read_line(&mut reader, MAX_LINK_LINE)
            .map_err(failed)?
            .ok_or_else(|| Attach::Failed("the daemon closed the link".into()))?;
        stream.set_read_timeout(None).map_err(failed)?;
        let reply: Value = serde_json::from_str(&reply).map_err(|e| Attach::Failed(e.to_string()))?;
        if let Some(message) = reply["error"]["message"].as_str() {
            return Err(Attach::Failed(message.to_string()));
        }
        let protocol = reply["result"]["protocol"].as_u64();
        let current = protocol == Some(u64::from(PROTOCOL)) && reply["result"]["build"] == build_id();
        if !current && self.spawn && !*restarted {
            // Once: a restarted daemon that still differs is this app being
            // the stale one, and it keeps going rather than loop.
            *restarted = true;
            eprintln!("tori: restarting the daemon, its build differs from this one");
            let stop = json!({ "jsonrpc": "2.0", "id": 0, "method": "shutdown" });
            let _ = stream.write_all(to_line(&stop).as_bytes());
            let _ = stream.set_read_timeout(Some(DAEMON_START_WAIT));
            while let Ok(Some(_)) = read_line(&mut reader, MAX_LINK_LINE) {}
            wait_released(&self.paths.lock, DAEMON_START_WAIT);
            return Err(Attach::Restarting);
        }
        if protocol != Some(u64::from(PROTOCOL)) {
            return Err(Attach::Failed(format!(
                "the daemon speaks link protocol {}, this window {PROTOCOL}",
                protocol.unwrap_or_default()
            )));
        }
        let conn = Arc::new(Conn {
            out: Arc::new(Outbox::new(OUTBOX_BYTES)),
            pending: Mutex::default(),
            next: AtomicU64::new(0),
            stream: stream.try_clone().map_err(failed)?,
        });
        let out = conn.out.clone();
        thread::spawn(move || {
            out.drain(&mut stream);
            let _ = stream.shutdown(Shutdown::Both);
        });
        Ok((conn, reader))
    }

    fn read(&self, conn: &Arc<Conn>, mut reader: BufReader<UnixStream>) {
        while let Ok(Some(line)) = read_line(&mut reader, MAX_LINK_LINE) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                eprintln!("tori: a malformed frame on the daemon link, dropped");
                continue;
            };
            match value["method"].as_str() {
                Some("call") => {
                    let (server, conn) = (self.server.clone(), conn.clone());
                    thread::spawn(move || {
                        // Answered either way: the caller waits on this reply,
                        // not on the thread, and would wait until the link drops.
                        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            answer(&server, &value["params"])
                        }))
                        .unwrap_or_else(|_| Err(RpcError::new(INTERNAL_ERROR, "the window failed this call")));
                        conn.out.push(to_line(&Response::reply(value["id"].clone(), outcome)));
                    });
                }
                Some("watching") => self.server.backend.watching_sessions(),
                Some("chats") => {
                    let ids: HashSet<String> = serde_json::from_value(value["params"].clone()).unwrap_or_default();
                    self.server.hub.set_remote_chats(ids);
                }
                Some(_) => {}
                None => {
                    let Some(id) = value["id"].as_u64() else { continue };
                    let outcome = match value.get("error") {
                        Some(error) => Err(serde_json::from_value(error.clone())
                            .unwrap_or_else(|_| RpcError::new(REFUSED, "the daemon failed this call"))),
                        None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    if let Some(tx) = conn.pending().remove(&id) {
                        let _ = tx.send(outcome);
                    }
                }
            }
        }
        conn.out.close();
        conn.pending().clear();
        let _ = conn.stream.shutdown(Shutdown::Both);
        self.server.hub.set_remote_chats(HashSet::new());
    }

    fn wait_for_conn(&self, wait: Duration) -> Option<Arc<Conn>> {
        let deadline = Instant::now() + wait;
        let mut slot = self.slot();
        loop {
            if let Some(conn) = slot.clone().filter(|c| !c.out.is_closed()) {
                return Some(conn);
            }
            let now = Instant::now();
            if now >= deadline || self.unreachable.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst) {
                return None;
            }
            slot = self
                .attached
                .wait_timeout(slot, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    fn request(&self, method: &str, params: Value, wait: Duration) -> Result<Value, RpcError> {
        let conn = self
            .wait_for_conn(wait)
            .ok_or_else(|| RpcError::new(REFUSED, "the daemon is not attached"))?;
        let id = conn.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = sync_channel(1);
        conn.pending().insert(id, tx);
        let line = to_line(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        if !conn.out.push(line) {
            conn.pending().remove(&id);
            return Err(RpcError::new(REFUSED, "the daemon link closed"));
        }
        rx.recv_timeout(wait)
            .unwrap_or_else(|_| Err(RpcError::new(REFUSED, "the daemon did not answer")))
    }

    fn notify(&self, method: &'static str, params: Value) {
        if let Some(conn) = self.current() {
            conn.out.push(to_line(&Notification::new(method, params)));
        }
    }

    /// A token for a child Tori is about to spawn, or `None` when the daemon
    /// is not there to vouch for it.
    pub fn mint(&self, caller: Caller) -> Option<String> {
        self.request("mint", json!({ "caller": caller }), MINT_WAIT)
            .ok()?
            .as_str()
            .map(str::to_string)
    }

    pub fn revoke_token(&self, token: &str) {
        self.notify("revoke_token", json!({ "token": token }));
    }

    pub fn revoke(&self, caller: &Caller) {
        self.notify("revoke", json!({ "caller": caller }));
    }

    /// Never blocks: a publish runs on whatever thread noticed the event.
    fn publish(&self, channel: &Channel, data: &Value) {
        self.notify("publish", json!({ "topic": channel.to_string(), "data": data }));
    }

    /// At app exit. Leaves the daemon running.
    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Some(conn) = self.slot().take() {
            conn.out.close();
            let _ = conn.stream.shutdown(Shutdown::Both);
        }
        self.attached.notify_all();
    }

    #[cfg(test)]
    pub fn attached(&self, wait: Duration) -> bool {
        self.wait_for_conn(wait).is_some()
    }
}

enum Attach {
    Restarting,
    Failed(String),
}

fn answer(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let principal: Principal = serde_json::from_value(params["principal"].clone())
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("principal: {e}")))?;
    let req = Request {
        jsonrpc: "2.0".into(),
        id: None,
        method: params["method"].as_str().unwrap_or_default().to_string(),
        params: params["params"].clone(),
    };
    server.call(&principal, &req)
}
