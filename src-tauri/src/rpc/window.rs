//! The app's end of the window link. Each relayed call runs on a thread of its
//! own and replies when done, so a slow read never holds up a quick one
//! behind it. See `daemon.rs` for the other end.

use std::collections::HashMap;
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

use super::auth::Caller;
use super::daemon::{build_id, read_line, wait_released, Paths, MAX_LINK_LINE, PROTOCOL, SLOW_ON_LINK, WINDOW_METHOD};
use super::frame::{to_line, Notification, Response, RpcError, INTERNAL_ERROR, REFUSED};
use super::hub::Channel;
use super::outbox::{Outbox, OUTBOX_BYTES};

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
    #[serde(rename = "restartNeeded")]
    RestartNeeded(String),
    Off,
    #[serde(rename = "gaveUp")]
    GaveUp(u32),
}

enum Waiter {
    Value(SyncSender<Result<Value, RpcError>>),
    Raw(SyncSender<Result<String, RpcError>>),
}

type Pending = Mutex<HashMap<u64, Waiter>>;

// Only the head of a line is read here; a reply's result is parsed only by a
// caller that wants it as a value.
#[derive(serde::Deserialize)]
struct Envelope<'a> {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default, borrow)]
    method: Option<std::borrow::Cow<'a, str>>,
    #[serde(default, borrow)]
    params: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    result: Option<&'a serde_json::value::RawValue>,
    #[serde(default)]
    error: Option<Value>,
}

pub type OnEvent = Box<dyn Fn(&str, &Value) + Send + Sync>;

type Screened = Arc<dyn Fn(&str, Value) -> Result<Value, RpcError> + Send + Sync>;

pub struct Answers {
    pub hub: Arc<super::hub::Hub>,
    pub screen: Screened,
}

impl Default for Answers {
    fn default() -> Self {
        Self {
            hub: Arc::default(),
            screen: Arc::new(|method, _| Err(RpcError::new(REFUSED, format!("no screen for {method}")))),
        }
    }
}

struct Conn {
    out: Arc<Outbox>,
    pending: Pending,
    next: AtomicU64,
    stream: UnixStream,
}

impl Conn {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Waiter>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct Link {
    answers: Answers,
    paths: Paths,
    // Off in tests, which start their own daemon.
    spawn: bool,
    instance: String,
    conn: Mutex<Option<Arc<Conn>>>,
    attached: Condvar,
    // Set once an attach has failed, so a spawn stops waiting on a link that is not coming.
    unreachable: AtomicBool,
    closing: AtomicBool,
    outdated: AtomicBool,
    on_status: Box<dyn Fn(&Status) + Send + Sync>,
    on_event: OnEvent,
}

impl Link {
    pub fn start(
        answers: Answers,
        paths: Paths,
        spawn: bool,
        on_status: Box<dyn Fn(&Status) + Send + Sync>,
        on_event: OnEvent,
    ) -> Arc<Self> {
        let link = Arc::new(Self {
            answers,
            paths,
            spawn,
            instance: format!("{}-{}", std::process::id(), crate::chat::approval::random_token()),
            conn: Mutex::default(),
            attached: Condvar::new(),
            unreachable: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            outdated: AtomicBool::new(false),
            on_status,
            on_event,
        });
        let upstream = Arc::downgrade(&link);
        link.answers.hub.set_upstream(Arc::new(move |channel, data| {
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
                    if self.outdated.swap(false, Ordering::SeqCst) {
                        let link = self.clone();
                        thread::spawn(move || link.replace_when_idle());
                    }
                    self.read(&conn, reader);
                    *self.slot() = None;
                    if self.closing.load(Ordering::SeqCst) {
                        return;
                    }
                    (self.on_status)(&Status::Connecting);
                }
                Err(Attach::Restarting) => continue,
                Err(Attach::Outdated(e)) => {
                    failures += 1;
                    self.unreachable.store(true, Ordering::SeqCst);
                    self.attached.notify_all();
                    (self.on_status)(&Status::RestartNeeded(e));
                }
                Err(Attach::Failed(e)) => {
                    failures += 1;
                    self.unreachable.store(true, Ordering::SeqCst);
                    self.attached.notify_all();
                    eprintln!("tori: daemon unreachable: {e}");
                    let failed = super::daemon::failed_starts();
                    match (
                        super::launchd::managed() && super::launchd::is_off(),
                        failed >= super::daemon::GIVE_UP_AFTER,
                    ) {
                        (true, _) => (self.on_status)(&Status::Off),
                        (_, true) => (self.on_status)(&Status::GaveUp(failed)),
                        _ => (self.on_status)(&Status::Unreachable(e)),
                    }
                }
            }
            let wait = Duration::from_millis(250 * 2u64.pow(failures.min(5))).min(BACKOFF_MAX);
            thread::sleep(wait);
        }
    }

    // A daemon from before restarting when idle existed goes at once, as it
    // always did.
    fn replace_when_idle(&self) {
        match self.request("restart_when_idle", json!({}), HANDSHAKE_WAIT) {
            Ok(_) => {}
            Err(e) if e.code == super::frame::METHOD_NOT_FOUND => self.notify("shutdown", json!({})),
            Err(e) => eprintln!("tori: the outdated daemon stays until restarted: {}", e.message),
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
        if super::launchd::managed() {
            return super::launchd::start(&self.paths.log);
        }
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
        let spoken = protocol == Some(u64::from(PROTOCOL));
        let replaced = reply["result"]["build"] != build_id() && self.spawn;
        if replaced && super::launchd::managed() && !spoken {
            return Err(Attach::Outdated(format!(
                "the running daemon speaks link protocol {}, this window {PROTOCOL}",
                protocol.unwrap_or_default()
            )));
        }
        if replaced && !super::launchd::managed() && !*restarted {
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
        if replaced && super::launchd::managed() {
            self.outdated.store(true, Ordering::SeqCst);
        }
        let out = conn.out.clone();
        thread::spawn(move || {
            out.drain(&mut stream);
            let _ = stream.shutdown(Shutdown::Both);
        });
        Ok((conn, reader))
    }

    fn read(&self, conn: &Arc<Conn>, mut reader: BufReader<UnixStream>) {
        while let Ok(Some(line)) = read_line(&mut reader, MAX_LINK_LINE) {
            let Ok(head) = serde_json::from_str::<Envelope>(&line) else {
                eprintln!("tori: a malformed frame on the daemon link, dropped");
                continue;
            };
            let params = || -> Value {
                head.params
                    .and_then(|p| serde_json::from_str(p.get()).ok())
                    .unwrap_or_default()
            };
            let id = head.id.clone().unwrap_or(Value::Null);
            match head.method.as_deref() {
                Some("screen") => {
                    let (screen, conn, params) = (self.answers.screen.clone(), conn.clone(), params());
                    thread::spawn(move || {
                        // Answered either way: the caller waits on this reply,
                        // not on the thread, and would wait until the link drops.
                        let run = || screen(params["method"].as_str().unwrap_or_default(), params["params"].clone());
                        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
                            .unwrap_or_else(|_| Err(RpcError::new(INTERNAL_ERROR, "the window failed this call")));
                        conn.out.push(to_line(&Response::reply(id, outcome)));
                    });
                }
                Some(event) => {
                    let began = Instant::now();
                    (self.on_event)(event, &params());
                    if began.elapsed() >= SLOW_ON_LINK {
                        eprintln!(
                            "tori: the daemon's {event} held the link for {} ms",
                            began.elapsed().as_millis()
                        );
                    }
                }
                None => {
                    let Some(id) = head.id.as_ref().and_then(Value::as_u64) else {
                        continue;
                    };
                    let Some(waiter) = conn.pending().remove(&id) else {
                        continue;
                    };
                    let failed = |error: Value| {
                        serde_json::from_value(error)
                            .unwrap_or_else(|_| RpcError::new(REFUSED, "the daemon failed this call"))
                    };
                    let raw = head.result.map_or("null", |r| r.get());
                    match waiter {
                        Waiter::Value(tx) => {
                            let outcome = match head.error {
                                Some(error) => Err(failed(error)),
                                None => Ok(serde_json::from_str(raw).unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(outcome);
                        }
                        Waiter::Raw(tx) => {
                            let outcome = match head.error {
                                Some(error) => Err(failed(error)),
                                None => Ok(raw.to_string()),
                            };
                            let _ = tx.send(outcome);
                        }
                    }
                }
            }
        }
        conn.out.close();
        conn.pending().clear();
        let _ = conn.stream.shutdown(Shutdown::Both);
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

    pub fn request(&self, method: &str, params: Value, wait: Duration) -> Result<Value, RpcError> {
        let (tx, rx) = sync_channel(1);
        self.send(method, params, wait, Waiter::Value(tx))?;
        rx.recv_timeout(wait).unwrap_or_else(|_| Err(unanswered(method, wait)))
    }

    pub fn request_raw(&self, method: &str, params: Value, wait: Duration) -> Result<String, RpcError> {
        let (tx, rx) = sync_channel(1);
        self.send(method, params, wait, Waiter::Raw(tx))?;
        rx.recv_timeout(wait).unwrap_or_else(|_| Err(unanswered(method, wait)))
    }

    fn send(&self, method: &str, params: Value, wait: Duration, waiter: Waiter) -> Result<(), RpcError> {
        let conn = self
            .wait_for_conn(wait)
            .ok_or_else(|| RpcError::new(REFUSED, "the daemon is not attached"))?;
        let id = conn.next.fetch_add(1, Ordering::Relaxed) + 1;
        conn.pending().insert(id, waiter);
        let line = to_line(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        if !conn.out.push(line) {
            conn.pending().remove(&id);
            return Err(RpcError::new(REFUSED, "the daemon link closed"));
        }
        Ok(())
    }

    pub fn notify(&self, method: &'static str, params: Value) {
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

    pub fn revoke(&self, caller: &Caller) {
        self.notify("revoke", json!({ "caller": caller }));
    }

    /// Never blocks: a publish runs on whatever thread noticed the event.
    fn publish(&self, channel: &Channel, data: &Value) {
        self.notify("publish", json!({ "topic": channel.to_string(), "data": data }));
    }

    // With the ring: a surface attaching is a fresh xterm, since one that
    // unmounts kills its tab.
    pub fn attach_pty(&self, tab: &str, cols: u16, rows: u16) -> Result<(UnixStream, BufReader<UnixStream>), String> {
        let sock = self.paths.sock.to_string_lossy();
        let token = crate::credential::socket_in_file(&self.paths.rpc_json)
            .filter(|(at, _)| *at == sock)
            .map(|(_, token)| token)
            .ok_or_else(|| format!("{} names another socket", self.paths.rpc_json.display()))?;
        let params = crate::pty::wire::AttachParams {
            token,
            tab: tab.to_string(),
            replay: true,
            cols,
            rows,
        };
        open_attach(&sock, &params)
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
    Outdated(String),
    Failed(String),
}

fn unanswered(method: &str, wait: Duration) -> RpcError {
    eprintln!(
        "tori: the daemon did not answer {method} within {} ms",
        wait.as_millis()
    );
    RpcError::new(REFUSED, "the daemon did not answer")
}

pub fn open_attach(
    sock: &str,
    params: &crate::pty::wire::AttachParams,
) -> Result<(UnixStream, BufReader<UnixStream>), String> {
    let frame = json!({ "jsonrpc": "2.0", "id": 0, "method": crate::pty::wire::ATTACH_METHOD, "params": params });
    let mut stream = UnixStream::connect(sock).map_err(|e| e.to_string())?;
    stream
        .write_all(to_line(&frame).as_bytes())
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(HANDSHAKE_WAIT))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let reply = read_line(&mut reader, MAX_LINK_LINE)
        .map_err(|e| e.to_string())?
        .ok_or("the daemon closed the attach stream")?;
    let reply: Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
    if let Some(message) = reply["error"]["message"].as_str() {
        return Err(message.to_string());
    }
    stream.set_read_timeout(None).map_err(|e| e.to_string())?;
    Ok((stream, reader))
}
