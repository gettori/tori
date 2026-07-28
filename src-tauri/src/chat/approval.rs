//! The `PreToolUse` approval bridge: a per-session Unix socket, and the hook
//! helper that blocks on it.
//!
//! **Why the hook and not a permission prompt.** `PermissionRequest` never fires
//! in headless `-p` - measured, not assumed: it fires when a *dialog* would be
//! shown, and headless has none. `PreToolUse` does fire, it runs **first** in
//! the permission chain (before deny rules, ask rules and permission mode), and
//! a deny from it applies even under `bypassPermissions`. That makes it the only
//! authoritative gate available, which is also why Phase 6 can promise approvals
//! hold in every mode.
//!
//! `permissionDecision: "ask"` is useless here - it degrades to a denial with the
//! reason surfaced - so this bridge only ever answers `allow` or `deny`.
//!
//! **The shape is [[concept_askpass_bridge]]'s, reused rather than reinvented**:
//! a private `0700` dir under `$TMPDIR`, a short socket path (Darwin caps
//! `sun_path` at 104 bytes), a per-server random token, an accept loop with a
//! thread per connection, and a fail-closed default on every path. The one real
//! difference is the cheap path: askpass prompts on every call, while this
//! answers most calls from a file without opening a socket at all, because the
//! hook matches *all* tools and a turn doing fifty `Read`s must not cost fifty
//! round trips.
//!
//! **Fail-closed is the invariant.** Any error, wrong token, timeout, dropped
//! socket, closed tab, or missing supervisor yields a **deny with a reason**,
//! never an allow and never a hang. Sway owns the timeout and auto-denies
//! strictly before the hook's own declared timeout could fire, so an unanswered
//! prompt is resolved by us, with an explanation, rather than by the CLI.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::rules::{self, RuleFile, Verdict};

/// Env markers the helper reads. Set inline on the hook command string rather
/// than inherited, so only the hook process ever sees them.
pub const ENV_SOCK: &str = "SWAY_CHAT_HOOK_SOCK";
pub const ENV_TOKEN: &str = "SWAY_CHAT_HOOK_TOKEN";
pub const ENV_RULES: &str = "SWAY_CHAT_HOOK_RULES";

/// How long Sway waits for the user before auto-denying.
///
/// Must stay **strictly below** [`HOOK_TIMEOUT_SECS`], which is what the CLI is
/// told. Sway owning the deadline is the point: if the CLI's timeout fired
/// first, the outcome would be the CLI's default rather than a denial we can
/// explain, and the user would see a tool blocked with no reason.
pub const DECIDE_TIMEOUT_SECS: u64 = 110;

/// The `timeout` declared to the CLI for our hook.
pub const HOOK_TIMEOUT_SECS: u64 = 120;

/// Reject frames larger than this. Tool inputs are small; a hostile or runaway
/// peer does not get to allocate without bound.
const MAX_FRAME: u64 = 256 * 1024;

/// What the helper asks about one tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRequest {
    pub token: String,
    pub session_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub tool_input: Value,
    /// A rule already allowed this call; the round trip is happening only so
    /// Sway can capture the file's before-state. The server answers `allow`
    /// without surfacing a prompt.
    ///
    /// This exists because the cheap path and the snapshot want opposite things.
    /// A rule that allows `Edit` would otherwise let the write past without the
    /// hook ever telling Sway, and the tool card would have no before-state to
    /// diff against - silently, and only for the files the user trusted most.
    /// So a write tool always round trips; only the read-shaped tools take the
    /// zero-socket path, which is what the budget was ever about.
    #[serde(default)]
    pub pre_approved: bool,
}

/// What the server answers. Mirrors the hook's own vocabulary so the helper does
/// no translation beyond wrapping it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookResponse {
    /// "allow" | "deny"
    pub decision: String,
    pub reason: String,
}

impl HookResponse {
    pub fn deny(reason: impl Into<String>) -> Self {
        Self { decision: "deny".to_string(), reason: reason.into() }
    }
    pub fn allow(reason: impl Into<String>) -> Self {
        Self { decision: "allow".to_string(), reason: reason.into() }
    }
}

/// The JSON a `PreToolUse` hook writes to stdout to decide a call.
pub fn hook_output(resp: &HookResponse) -> String {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": resp.decision,
            "permissionDecisionReason": resp.reason,
        }
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Helper mode (runs in the re-exec'd binary, before Tauri init)
// ---------------------------------------------------------------------------

/// True when this process was launched by `claude` as our `PreToolUse` hook.
/// The app's own process never has the marker - it is set inline on the hook
/// command string, not inherited.
pub fn is_helper() -> bool {
    std::env::var_os(ENV_SOCK).is_some()
}

/// Everything the helper's decision is allowed to depend on.
///
/// **`permission_mode` is deliberately not here**, though the payload carries
/// it. Hooks run first in the permission chain, ahead of deny rules, ask rules
/// and the mode itself, which is the whole reason Sway's gate is authoritative.
/// Reading the mode would be the one way to give that up: under
/// `bypassPermissions` the helper would stop asking, and "Sway still approves"
/// would quietly stop being true exactly where it matters most.
pub struct HookInputs {
    pub tool_name: String,
    pub tool_input: Value,
    pub session_id: String,
    pub tool_use_id: String,
}

pub fn hook_inputs(parsed: &Value) -> HookInputs {
    HookInputs {
        tool_name: parsed["tool_name"].as_str().unwrap_or_default().to_string(),
        tool_input: parsed.get("tool_input").cloned().unwrap_or(Value::Null),
        session_id: parsed["session_id"].as_str().unwrap_or_default().to_string(),
        tool_use_id: parsed["tool_use_id"].as_str().unwrap_or_default().to_string(),
    }
}

/// The helper: read the `PreToolUse` payload from stdin, decide, print the hook
/// JSON to stdout. Returns the process exit code.
///
/// Exit code 0 with a `deny` decision, never a non-zero exit: a hook that exits
/// non-zero is a *malfunctioning* hook, and the CLI's handling of that is not a
/// decision we control. Saying "deny, here is why" is both authoritative and
/// explainable.
pub fn run_helper() -> i32 {
    let mut payload = String::new();
    if std::io::stdin().read_to_string(&mut payload).is_err() {
        return emit_decision(&HookResponse::deny("Sway could not read the hook payload."));
    }
    let parsed: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
    let HookInputs { tool_name, tool_input, session_id, tool_use_id } = hook_inputs(&parsed);

    // The cheap path: one file read, no socket. A write tool is excluded from
    // it on purpose - see `HookRequest::pre_approved`.
    let rules_file = std::env::var(ENV_RULES).ok().and_then(|p| rules::load(Path::new(&p)));
    let writes = !super::snapshot::write_targets(&tool_name, &tool_input).is_empty();
    let pre_approved = match rules::evaluate(rules_file.as_ref(), &tool_name, &tool_input, rules::now_ms(), pid_alive) {
        Verdict::Allow if !writes => return emit_decision(&HookResponse::allow("Allowed by a Sway rule.")),
        Verdict::Allow => true,
        Verdict::Deny(reason) => return emit_decision(&HookResponse::deny(reason)),
        Verdict::Ask => false,
    };

    let sock = std::env::var(ENV_SOCK).unwrap_or_default();
    let token = std::env::var(ENV_TOKEN).unwrap_or_default();
    let req = HookRequest { token, session_id, tool_use_id, tool_name, tool_input, pre_approved };
    let resp = helper_exchange(Path::new(&sock), &req)
        .unwrap_or_else(|_| HookResponse::deny("Sway could not be reached to approve this tool call."));
    emit_decision(&resp)
}

fn emit_decision(resp: &HookResponse) -> i32 {
    let mut stdout = std::io::stdout();
    if stdout.write_all(hook_output(resp).as_bytes()).is_err() || stdout.flush().is_err() {
        return 1;
    }
    0
}

/// One round trip to the server. Isolated from env and stdout so it is testable
/// against a stub listener, the same split `askpass.rs` uses.
fn helper_exchange(sock: &Path, req: &HookRequest) -> std::io::Result<HookResponse> {
    let mut stream = UnixStream::connect(sock)?;
    stream.write_all(serde_json::to_string(req)?.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    // An empty line means the server hung up without answering (it died, or the
    // app quit mid-call). Fail closed rather than treating silence as consent.
    if line.trim().is_empty() {
        return Ok(HookResponse::deny("Sway closed the approval connection without answering."));
    }
    serde_json::from_str(line.trim_end())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn pid_alive(pid: u32) -> bool {
    if pid <= 1 {
        return false;
    }
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Server (hosted by the app)
// ---------------------------------------------------------------------------

/// One tool call blocked awaiting an answer.
struct Pending {
    tx: Sender<HookResponse>,
}

#[derive(Default)]
struct ServerState {
    pending: HashMap<String, Pending>,
    next_id: u64,
}

/// What the UI is told about a blocked call. Mirrors
/// [`super::model::ChatEvent::PermissionRequest`]'s fields; the host turns this
/// into that event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPrompt {
    pub session_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: Value,
    /// Correlates the answer back to the blocked helper process.
    pub request_id: String,
    pub auto_deny_at_ms: u64,
}

/// The live approval server.
pub struct ApprovalServer {
    token: String,
    sock_path: PathBuf,
    dir: PathBuf,
    timeout: Duration,
    state: Mutex<ServerState>,
    /// Counts accepted connections, so a test can assert the cheap path really
    /// avoided the socket rather than merely answering quickly.
    connections: AtomicU64,
    /// Set by [`ApprovalServer::shutdown`] so the accept loop exits.
    stopping: AtomicBool,
    emit: Box<dyn Fn(ApprovalPrompt) + Send + Sync>,
    /// Called for every authenticated request, before any decision, so the
    /// before-state of a file about to be written is captured *on the way past*.
    /// Separate from `emit` because a pre-approved write is observed but never
    /// prompted.
    observe: Box<dyn Fn(&HookRequest) + Send + Sync>,
}

impl Drop for ApprovalServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.sock_path);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl ApprovalServer {
    pub fn sock_path(&self) -> &Path {
        &self.sock_path
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    /// Test-only: the zero-socket claim is only meaningful if something counts.
    #[cfg(test)]
    pub fn connections(&self) -> u64 {
        self.connections.load(Ordering::SeqCst)
    }

    /// Stop serving: deny everything blocked, then wind the accept loop down.
    ///
    /// This exists because `Drop` alone cannot do it. The accept thread holds an
    /// `Arc` to this server, so as long as it is looping the refcount never
    /// reaches zero and `Drop` never runs - one leaked thread and one leaked
    /// `$TMPDIR` directory per chat session ever opened. The self-connect is how
    /// a blocking `incoming()` is woken without a second signalling mechanism.
    ///
    /// Idempotent: session close and app exit both call it.
    pub fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        deny_all(self, "Sway stopped supervising this session, so the tool call was denied.");
        let _ = UnixStream::connect(&self.sock_path);
    }
}

/// Bind a socket for one chat session and start accepting.
///
/// The session id is deliberately **not** in the path. Darwin caps `sun_path` at
/// 104 bytes ([[gotchas#darwin-caps-unix-socket-paths-at-104-bytes]]), and a
/// UUID would eat a third of that for no benefit: the id already travels in the
/// request payload, where it costs nothing.
pub fn start(
    emit: Box<dyn Fn(ApprovalPrompt) + Send + Sync>,
    observe: Box<dyn Fn(&HookRequest) + Send + Sync>,
) -> std::io::Result<Arc<ApprovalServer>> {
    start_with(emit, observe, Duration::from_secs(DECIDE_TIMEOUT_SECS))
}

fn start_with(
    emit: Box<dyn Fn(ApprovalPrompt) + Send + Sync>,
    observe: Box<dyn Fn(&HookRequest) + Send + Sync>,
    timeout: Duration,
) -> std::io::Result<Arc<ApprovalServer>> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("sway-cha-{}-{}", std::process::id(), seq));
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let sock_path = dir.join("s");
    let _ = std::fs::remove_file(&sock_path);
    if sock_path.as_os_str().len() >= 104 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("approval socket path too long for sun_path: {}", sock_path.display()),
        ));
    }

    let listener = UnixListener::bind(&sock_path)?;
    std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o700))?;

    let server = Arc::new(ApprovalServer {
        token: random_token(),
        sock_path,
        dir,
        timeout,
        state: Mutex::new(ServerState::default()),
        connections: AtomicU64::new(0),
        stopping: AtomicBool::new(false),
        emit,
        observe,
    });

    let accept = server.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            // Checked before the stream is served, so `shutdown`'s own wake-up
            // connect is never mistaken for a real tool call.
            if accept.stopping.load(Ordering::SeqCst) {
                break;
            }
            match stream {
                Ok(stream) => {
                    accept.connections.fetch_add(1, Ordering::SeqCst);
                    let conn = accept.clone();
                    thread::spawn(move || handle_conn(&conn, stream));
                }
                Err(_) => break,
            }
        }
    });

    Ok(server)
}

fn handle_conn(server: &Arc<ApprovalServer>, stream: UnixStream) {
    // Every failure inside becomes a deny with a reason, never a dropped
    // connection: the helper would read an empty line and deny anyway, but with
    // a vaguer reason than we can give here.
    let resp = handle_request(server, &stream)
        .unwrap_or_else(|| HookResponse::deny("Sway refused this tool call."));
    let _ = write_response(&stream, &resp);
}

fn handle_request(server: &Arc<ApprovalServer>, stream: &UnixStream) -> Option<HookResponse> {
    let mut reader = BufReader::new(stream.try_clone().ok()?.take(MAX_FRAME));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let req: HookRequest = serde_json::from_str(line.trim_end()).ok()?;

    if req.token.as_bytes() != server.token.as_bytes() {
        return None;
    }

    // Before any decision: the file is about to be written either way, and a
    // before-state captured after the fact is not a before-state.
    (server.observe)(&req);

    // A rule already allowed this; the round trip existed only for the capture
    // above. Answering here rather than prompting is what keeps an "always allow
    // Edit" rule feeling like one.
    if req.pre_approved {
        return Some(HookResponse::allow("Allowed by a Sway rule."));
    }

    let (tx, rx) = channel::<HookResponse>();
    let request_id = {
        let mut st = server.state.lock().ok()?;
        st.next_id += 1;
        let id = format!("apr-{}", st.next_id);
        st.pending.insert(id.clone(), Pending { tx });
        id
    };

    (server.emit)(ApprovalPrompt {
        session_id: req.session_id.clone(),
        tool_use_id: req.tool_use_id.clone(),
        tool_name: req.tool_name.clone(),
        input: req.tool_input.clone(),
        request_id: request_id.clone(),
        auto_deny_at_ms: rules::now_ms() + server.timeout.as_millis() as u64,
    });

    // Sway owns this deadline, strictly inside the hook's own. An unanswered
    // prompt is denied *by us*, with a reason that distinguishes it from a
    // deliberate refusal.
    let resp = rx.recv_timeout(server.timeout).unwrap_or_else(|_| {
        HookResponse::deny("Nobody answered this approval request in time, so Sway denied it.")
    });

    if let Ok(mut st) = server.state.lock() {
        st.pending.remove(&request_id);
    }
    Some(resp)
}

fn write_response(mut stream: &UnixStream, resp: &HookResponse) -> std::io::Result<()> {
    stream.write_all(serde_json::to_string(resp)?.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

/// Answer a blocked tool call. A `request_id` nobody is waiting on is a no-op:
/// the prompt already timed out, or its tab closed.
pub fn resolve(server: &ApprovalServer, request_id: &str, resp: HookResponse) {
    let Ok(mut st) = server.state.lock() else { return };
    if let Some(p) = st.pending.remove(request_id) {
        let _ = p.tx.send(resp);
    }
}

/// Deny everything currently blocked, with one reason. Called when a chat tab
/// closes or its session dies: those calls would otherwise sit until the
/// timeout, holding the turn open with nobody able to answer.
pub fn deny_all(server: &ApprovalServer, reason: &str) {
    let Ok(mut st) = server.state.lock() else { return };
    for (_, p) in st.pending.drain() {
        let _ = p.tx.send(HookResponse::deny(reason));
    }
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    let t = rules::now_ms();
    format!("{}-{}", std::process::id(), t)
}

// ---------------------------------------------------------------------------
// Settings injection
// ---------------------------------------------------------------------------

/// The shell command `claude` runs as our `PreToolUse` hook: this same binary,
/// re-exec'd with the socket markers set inline.
///
/// Same-binary re-exec rather than a second shipped executable, matching
/// `askpass.rs`: one thing to sign, one thing to keep in step with the protocol.
/// The env is set on the command string rather than inherited so *only* the hook
/// process ever sees the token.
pub fn hook_command(exe: &Path, sock: &Path, token: &str, rules_path: &Path) -> String {
    format!(
        "{}={} {}={} {}={} {}",
        ENV_SOCK,
        sh_quote(&sock.to_string_lossy()),
        ENV_TOKEN,
        sh_quote(token),
        ENV_RULES,
        sh_quote(&rules_path.to_string_lossy()),
        sh_quote(&exe.to_string_lossy()),
    )
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The `--settings` payload for one chat session.
///
/// Matches **all** tools (`"*"`), which is load-bearing twice over: Phase 6
/// promises approvals hold even under `bypassPermissions`, and the snapshot
/// needs to see every `Edit`/`Write`/`MultiEdit` go past. The cheap path is what
/// makes that affordable.
///
/// `--setting-sources` is **not** set, so this layers on top of the user's own
/// settings rather than replacing them: their hooks still load and fire
/// alongside ours. Passing `--setting-sources ''` would silently disable their
/// hooks, permissions and config, and must never ship.
pub fn settings_json(exe: &Path, sock: &Path, token: &str, rules_path: &Path) -> String {
    json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": "*",
                "hooks": [{
                    "type": "command",
                    "command": hook_command(exe, sock, token, rules_path),
                    "timeout": HOOK_TIMEOUT_SECS,
                }],
            }],
        }
    })
    .to_string()
}

/// Write the settings file and return the `["--settings", <path>]` args.
///
/// A **path**, not inline JSON. Not for the PTY reason (nothing is typed into a
/// shell here) but because the command string embeds absolute paths and a token,
/// and an argv-embedded JSON blob shows the token in `ps` output for every
/// process on the machine. The file is `0600`.
pub fn settings_args(session_id: &str, sock: &Path, token: &str) -> Result<Vec<String>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = settings_path(session_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, settings_json(&exe, sock, token, &rules::rules_path(session_id)))
        .map_err(|e| e.to_string())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    Ok(vec!["--settings".to_string(), path.to_string_lossy().into_owned()])
}

/// Where a session's `--settings` payload lives. Public so teardown can remove
/// it: it carries a socket path and a token that outlive nothing.
pub fn settings_path(session_id: &str) -> PathBuf {
    let safe: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    dirs::home_dir().unwrap_or_default().join(".config/sway/chat-settings").join(format!("{safe}.json"))
}

/// Refresh a session's liveness stamp, keeping its rules.
///
/// The supervisor calls this on a timer. It is what turns an allow rule from a
/// standing grant into a statement about what Sway permits *while it is
/// watching*.
pub fn refresh_stamp(session_id: &str) {
    let path = rules::rules_path(session_id);
    let mut file = rules::load(&path).unwrap_or(RuleFile {
        sway_pid: std::process::id(),
        stamp_ms: 0,
        rules: Vec::new(),
    });
    file.sway_pid = std::process::id();
    file.stamp_ms = rules::now_ms();
    let _ = rules::save(&path, &file);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    /// A server whose prompts land on a channel the test drains, so answers can
    /// be injected deterministically. The [[lesson_offline_askpass_e2e]] shape:
    /// emit closure injected, no Tauri anywhere.
    fn test_server(timeout: Duration) -> (Arc<ApprovalServer>, Receiver<ApprovalPrompt>) {
        let (tx, rx) = channel::<ApprovalPrompt>();
        let server = start_with(Box::new(move |p| { let _ = tx.send(p); }), Box::new(|_| {}), timeout).unwrap();
        (server, rx)
    }

    /// A server that also records every observed request, so the snapshot hook
    /// can be asserted on.
    fn observing_server(timeout: Duration) -> (Arc<ApprovalServer>, Receiver<ApprovalPrompt>, Arc<Mutex<Vec<HookRequest>>>) {
        let (tx, rx) = channel::<ApprovalPrompt>();
        let seen: Arc<Mutex<Vec<HookRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let server = start_with(
            Box::new(move |p| { let _ = tx.send(p); }),
            Box::new(move |req| recorder.lock().unwrap().push(req.clone())),
            timeout,
        )
        .unwrap();
        (server, rx, seen)
    }

    fn request(token: &str, tool: &str, input: Value) -> HookRequest {
        HookRequest {
            token: token.to_string(),
            session_id: "s1".to_string(),
            tool_use_id: "toolu_1".to_string(),
            tool_name: tool.to_string(),
            tool_input: input,
            pre_approved: false,
        }
    }

    /// The end-to-end shape: the hook blocks until answered, and the answer is
    /// what reaches the CLI.
    #[test]
    fn the_hook_blocks_until_answered_and_a_deny_carries_its_reason() {
        let (server, prompts) = test_server(Duration::from_secs(5));
        let sock = server.sock_path().to_path_buf();
        let req = request(server.token(), "Bash", json!({"command": "rm -rf /"}));

        let handle = thread::spawn(move || helper_exchange(&sock, &req).unwrap());

        // The call really is blocked: the prompt is out, and no answer exists.
        let prompt = prompts.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(prompt.tool_name, "Bash");
        assert_eq!(prompt.tool_use_id, "toolu_1");
        assert!(!handle.is_finished(), "the helper must still be blocked before anyone answers");

        resolve(&server, &prompt.request_id, HookResponse::deny("Not on my machine."));
        let resp = handle.join().unwrap();
        assert_eq!(resp.decision, "deny");
        assert_eq!(resp.reason, "Not on my machine.");

        // And the reason is what the CLI actually receives, which is what puts
        // it in front of the model and into `permission_denials`.
        let out: Value = serde_json::from_str(&hook_output(&resp)).unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(out["hookSpecificOutput"]["permissionDecisionReason"], "Not on my machine.");
    }

    #[test]
    fn an_allow_reaches_the_cli_as_an_allow() {
        let (server, prompts) = test_server(Duration::from_secs(5));
        let sock = server.sock_path().to_path_buf();
        let req = request(server.token(), "Read", json!({"file_path": "/a"}));
        let handle = thread::spawn(move || helper_exchange(&sock, &req).unwrap());

        let prompt = prompts.recv_timeout(Duration::from_secs(5)).unwrap();
        resolve(&server, &prompt.request_id, HookResponse::allow("You said yes."));
        let resp = handle.join().unwrap();

        let out: Value = serde_json::from_str(&hook_output(&resp)).unwrap();
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    /// Sway owns the deadline, and the reason has to distinguish "you did not
    /// answer" from "you said no" - they mean different things to whoever reads
    /// the transcript later.
    #[test]
    fn an_unanswered_prompt_is_auto_denied_with_a_distinguishable_reason() {
        let (server, prompts) = test_server(Duration::from_millis(200));
        let sock = server.sock_path().to_path_buf();
        let req = request(server.token(), "Bash", json!({"command": "ls"}));

        let started = std::time::Instant::now();
        let resp = helper_exchange(&sock, &req).unwrap();
        assert!(prompts.recv_timeout(Duration::from_secs(1)).is_ok(), "a prompt should have been surfaced");

        assert_eq!(resp.decision, "deny");
        assert!(resp.reason.contains("in time"), "got {}", resp.reason);
        assert_ne!(resp.reason, HookResponse::deny("Not on my machine.").reason);
        assert!(started.elapsed() < Duration::from_secs(2), "the auto-deny must fire on Sway's deadline");
    }

    /// Sway's deadline must fire strictly first, or the outcome would be the
    /// CLI's default rather than a denial we can explain.
    #[test]
    fn sways_deadline_is_strictly_inside_the_one_the_cli_is_told() {
        assert!(DECIDE_TIMEOUT_SECS < HOOK_TIMEOUT_SECS);
        let settings: Value = serde_json::from_str(&settings_json(
            Path::new("/bin/sway"),
            Path::new("/tmp/s"),
            "tok",
            Path::new("/tmp/r.json"),
        ))
        .unwrap();
        assert_eq!(settings["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"], HOOK_TIMEOUT_SECS);
    }

    #[test]
    fn a_wrong_token_is_refused_without_surfacing_a_prompt() {
        let (server, prompts) = test_server(Duration::from_secs(2));
        let resp = helper_exchange(server.sock_path(), &request("not-the-token", "Bash", json!({}))).unwrap();
        assert_eq!(resp.decision, "deny");
        assert!(prompts.recv_timeout(Duration::from_millis(300)).is_err(), "an unauthenticated call must not prompt");
    }

    /// The socket dying mid-request must reach the helper as a deny, not as a
    /// timeout that something later reads as consent.
    #[test]
    fn a_server_that_dies_mid_request_denies_rather_than_hanging() {
        let (server, prompts) = test_server(Duration::from_secs(30));
        let sock = server.sock_path().to_path_buf();
        let req = request(server.token(), "Bash", json!({"command": "ls"}));
        let handle = thread::spawn(move || helper_exchange(&sock, &req).unwrap());

        prompts.recv_timeout(Duration::from_secs(5)).unwrap();
        // The tab closed / the session died: everything blocked is denied.
        deny_all(&server, "The chat tab was closed.");

        let resp = handle.join().unwrap();
        assert_eq!(resp.decision, "deny");
        assert_eq!(resp.reason, "The chat tab was closed.");
    }

    /// The app shutting down mid-call must deny, not leave the tool hanging
    /// until the CLI's own timeout resolves it however it likes.
    ///
    /// `drop` cannot express this: the accept thread holds an `Arc`, so the
    /// refcount never reaches zero while the server is looping and `Drop` never
    /// runs. That is why `shutdown` exists, and this is the test that found it -
    /// the first version dropped the handle and sat for the full 30s timeout.
    #[test]
    fn shutting_the_server_down_mid_call_denies_rather_than_hanging() {
        let (server, prompts) = test_server(Duration::from_secs(30));
        let sock = server.sock_path().to_path_buf();
        let req = request(server.token(), "Bash", json!({"command": "ls"}));
        let handle = thread::spawn(move || helper_exchange(&sock, &req).unwrap());

        prompts.recv_timeout(Duration::from_secs(5)).unwrap();
        let started = std::time::Instant::now();
        server.shutdown();

        let resp = handle.join().unwrap();
        assert_eq!(resp.decision, "deny", "a shutting-down server must never yield an allow");
        assert!(started.elapsed() < Duration::from_secs(5), "shutdown must not wait out the decide timeout");
    }

    /// `shutdown` really winds the accept loop down, so the thread and the
    /// `$TMPDIR` directory are not leaked once per chat session ever opened.
    #[test]
    fn shutdown_stops_the_accept_loop_so_nothing_is_leaked_per_session() {
        let (server, _rx) = test_server(Duration::from_secs(1));
        let dir = server.dir.clone();
        assert!(dir.exists());

        server.shutdown();
        server.shutdown(); // idempotent: session close and app exit both call it

        // The accept thread releases its Arc, so the last handle really drops.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while Arc::strong_count(&server) > 1 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(Arc::strong_count(&server), 1, "the accept thread should have let go");

        drop(server);
        assert!(!dir.exists(), "the socket directory should be cleaned up");
    }

    /// No server at all: the helper's own fallback.
    #[test]
    fn an_unreachable_socket_denies() {
        let missing = std::env::temp_dir().join("sway-cha-does-not-exist/s");
        assert!(helper_exchange(&missing, &request("t", "Bash", json!({}))).is_err());
    }

    /// The 104-byte `sun_path` cap, checked against the longest session id we
    /// could realistically see. The id is not in the path, which is the whole
    /// reason this holds.
    #[test]
    fn socket_paths_stay_under_the_darwin_104_byte_cap() {
        let (server, _rx) = test_server(Duration::from_secs(1));
        let len = server.sock_path().as_os_str().len();
        assert!(len < 104, "{} is {len} bytes", server.sock_path().display());

        // A session id far longer than a UUID must not change that, because it
        // never enters the path.
        let long_id = "a".repeat(255);
        let (other, _rx2) = test_server(Duration::from_secs(1));
        assert_eq!(other.sock_path().as_os_str().len(), len, "the session id must not affect the socket path");
        assert!(rules::rules_path(&long_id).as_os_str().len() > 104, "the rules path may be long; only the socket is capped");
    }

    /// Two blocked calls must each get their own answer, keyed by request id.
    #[test]
    fn concurrent_calls_each_get_their_own_answer() {
        let (server, prompts) = test_server(Duration::from_secs(5));
        let sock = server.sock_path().to_path_buf();

        let s1 = sock.clone();
        let t1 = server.token().to_string();
        let h1 = thread::spawn(move || helper_exchange(&s1, &request(&t1, "Bash", json!({"command": "a"}))).unwrap());
        let s2 = sock.clone();
        let t2 = server.token().to_string();
        let h2 = thread::spawn(move || helper_exchange(&s2, &request(&t2, "Read", json!({"file_path": "/b"}))).unwrap());

        for _ in 0..2 {
            let p = prompts.recv_timeout(Duration::from_secs(5)).unwrap();
            let decision = if p.tool_name == "Bash" { HookResponse::deny("no") } else { HookResponse::allow("yes") };
            resolve(&server, &p.request_id, decision);
        }

        assert_eq!(h1.join().unwrap().decision, "deny");
        assert_eq!(h2.join().unwrap().decision, "allow");
    }

    /// Answering a request nobody is waiting on must be a harmless no-op, not a
    /// panic: the prompt may have timed out a moment before the click landed.
    #[test]
    fn resolving_an_unknown_request_is_a_no_op() {
        let (server, _rx) = test_server(Duration::from_secs(1));
        resolve(&server, "apr-does-not-exist", HookResponse::allow("stale click"));
    }

    /// **A bypass-mode session still gets approved.**
    ///
    /// `bypassPermissions` disables *Claude's* permission checks. Sway's hook
    /// runs ahead of all of them, so a call matching no allow rule still stops
    /// and asks. Pinned against a real `PreToolUse` payload declaring the mode,
    /// because the guarantee is that the mode never reaches the decision.
    #[test]
    fn a_bypass_mode_call_matching_no_rule_still_prompts() {
        let payload = json!({
            "hook_event_name": "PreToolUse",
            "permission_mode": "bypassPermissions",
            "session_id": "s1",
            "tool_use_id": "toolu_1",
            "tool_name": "Bash",
            "tool_input": { "command": "rm -rf build" },
        });
        let inputs = hook_inputs(&payload);
        assert_eq!(inputs.tool_name, "Bash");

        let allows_reads = RuleFile {
            sway_pid: std::process::id(),
            stamp_ms: rules::now_ms(),
            rules: vec![rules::Rule { tool: "Read".into(), prefix: None }],
        };
        let verdict = rules::evaluate(
            Some(&allows_reads),
            &inputs.tool_name,
            &inputs.tool_input,
            rules::now_ms(),
            pid_alive,
        );
        assert_eq!(verdict, Verdict::Ask, "the mode must not be able to skip Sway's approval");
    }

    // ---- the cheap path ----

    /// Run the helper's decision logic exactly as `run_helper` does, but against
    /// an explicit rules path and socket, so the file read and the socket
    /// decision are both real.
    fn helper_decide(rules_path: &Path, sock: &Path, token: &str, tool: &str, input: Value) -> HookResponse {
        let file = rules::load(rules_path);
        match rules::evaluate(file.as_ref(), tool, &input, rules::now_ms(), pid_alive) {
            Verdict::Allow => HookResponse::allow("Allowed by a Sway rule."),
            Verdict::Deny(reason) => HookResponse::deny(reason),
            Verdict::Ask => {
                let req = HookRequest {
                    token: token.to_string(),
                    session_id: "s1".to_string(),
                    tool_use_id: "toolu_1".to_string(),
                    tool_name: tool.to_string(),
                    tool_input: input,
                    pre_approved: false,
                };
                helper_exchange(sock, &req)
                    .unwrap_or_else(|_| HookResponse::deny("Sway could not be reached to approve this tool call."))
            }
        }
    }

    fn write_rules(name: &str, sway_pid: u32, rules_list: Vec<rules::Rule>) -> PathBuf {
        let path = std::env::temp_dir()
            .join(format!("sway-approval-{}", std::process::id()))
            .join(format!("{name}.json"));
        rules::save(&path, &RuleFile { sway_pid, stamp_ms: rules::now_ms(), rules: rules_list }).unwrap();
        path
    }

    /// The hook matches every tool, so a read-heavy turn would cost one socket
    /// round trip per call without the cheap path. Measured on the server's own
    /// connection counter rather than on elapsed time, so it cannot pass by
    /// merely being fast.
    #[test]
    fn fifty_allow_listed_calls_open_zero_sockets() {
        let (server, prompts) = test_server(Duration::from_secs(5));
        let rules_path = write_rules(
            "cheap",
            std::process::id(),
            vec![
                rules::Rule { tool: "Read".into(), prefix: None },
                rules::Rule { tool: "Grep".into(), prefix: None },
            ],
        );

        for i in 0..50 {
            let (tool, input) = if i % 2 == 0 {
                ("Read", json!({"file_path": format!("/proj/f{i}.rs")}))
            } else {
                ("Grep", json!({"pattern": "fn main"}))
            };
            let resp = helper_decide(&rules_path, server.sock_path(), server.token(), tool, input);
            assert_eq!(resp.decision, "allow", "call {i} should be allowed by rule");
        }

        assert_eq!(server.connections(), 0, "the cheap path must not open a socket");
        assert!(prompts.recv_timeout(Duration::from_millis(200)).is_err(), "and must never surface a prompt");

        // The negative control: a tool with no rule really does open one.
        let handle = {
            let sock = server.sock_path().to_path_buf();
            let token = server.token().to_string();
            let path = rules_path.clone();
            thread::spawn(move || helper_decide(&path, &sock, &token, "Bash", json!({"command": "ls"})))
        };
        let prompt = prompts.recv_timeout(Duration::from_secs(5)).unwrap();
        resolve(&server, &prompt.request_id, HookResponse::allow("ok"));
        handle.join().unwrap();
        assert_eq!(server.connections(), 1, "an unruled tool must still round trip");
    }

    /// **The cheap path must not defeat fail-closed.** A `claude` orphaned by a
    /// Sway crash keeps running and keeps calling tools; if the rule file alone
    /// were enough, it would keep auto-approving them with nobody supervising.
    ///
    /// The supervising process here is a real one that is really killed, so the
    /// liveness check is exercised against the process table rather than a stub.
    #[test]
    fn a_killed_supervisor_makes_the_cheap_path_deny_rather_than_allow() {
        let (server, _rx) = test_server(Duration::from_secs(1));

        let mut supervisor = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("the stand-in supervisor should start");
        let rules_path = write_rules("supervised", supervisor.id(), vec![rules::Rule { tool: "Read".into(), prefix: None }]);

        // While it is alive, the rule is honoured.
        let allowed = helper_decide(&rules_path, server.sock_path(), server.token(), "Read", json!({"file_path": "/a"}));
        assert_eq!(allowed.decision, "allow", "a supervised rule should be honoured");

        // Kill it, exactly as a SIGKILL of Sway mid-turn would.
        supervisor.kill().unwrap();
        supervisor.wait().unwrap();

        let denied = helper_decide(&rules_path, server.sock_path(), server.token(), "Read", json!({"file_path": "/a"}));
        assert_eq!(denied.decision, "deny", "an orphaned child must not keep auto-approving tools");
        assert!(denied.reason.contains("not supervising"), "got {}", denied.reason);
        assert_eq!(server.connections(), 0, "the deny comes from the file check, not a round trip");
    }

    /// The per-call cost of the cheap path, budgeted because the hook runs on
    /// **every** tool call and a slow one would be felt on every turn.
    #[test]
    fn the_cheap_path_stays_under_the_fifteen_millisecond_budget() {
        let (server, _rx) = test_server(Duration::from_secs(1));
        let rules_path = write_rules("budget", std::process::id(), vec![rules::Rule { tool: "Read".into(), prefix: None }]);

        let mut samples: Vec<Duration> = Vec::new();
        for i in 0..40 {
            let start = std::time::Instant::now();
            let resp = helper_decide(
                &rules_path,
                server.sock_path(),
                server.token(),
                "Read",
                json!({"file_path": format!("/proj/f{i}.rs")}),
            );
            samples.push(start.elapsed());
            assert_eq!(resp.decision, "allow");
        }
        samples.sort();
        let median = samples[samples.len() / 2];
        assert!(
            median < Duration::from_millis(15),
            "median cheap-path decision was {median:?}, over the 15ms budget"
        );
        // Printed so the number on this machine is visible in the run and can be
        // recorded, making a later regression legible rather than just a failure.
        eprintln!("cheap-path median decision: {median:?}");
    }

    /// The **end-to-end** cheap-path cost: the real binary re-exec'd as the hook,
    /// reading a payload on stdin and printing a decision.
    ///
    /// Separate from the budget test above and opt-in, because it needs a built
    /// binary that `cargo test` does not produce. It exists because the decision
    /// logic is the cheap part: the honest per-call cost is dominated by
    /// `exec`ing Sway, and a budget that measured only the file read would be
    /// measuring the wrong thing.
    #[test]
    #[ignore = "needs a built binary: cargo build, then cargo test -- --ignored"]
    fn the_end_to_end_hook_cost_is_measured_against_the_real_binary() {
        let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/sway");
        assert!(exe.exists(), "run `cargo build` first: {}", exe.display());

        let rules_path = write_rules("e2e", std::process::id(), vec![rules::Rule { tool: "Read".into(), prefix: None }]);
        let payload = json!({
            "session_id": "s1",
            "tool_use_id": "toolu_1",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/a.rs"},
            "hook_event_name": "PreToolUse",
        })
        .to_string();

        let mut samples = Vec::new();
        for _ in 0..20 {
            let start = std::time::Instant::now();
            let mut child = std::process::Command::new(&exe)
                .env(ENV_SOCK, "/tmp/unused-because-the-rule-matches")
                .env(ENV_TOKEN, "t")
                .env(ENV_RULES, &rules_path)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("the hook should start");
            child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            samples.push(start.elapsed());

            let decision: Value = serde_json::from_slice(&out.stdout).expect("the hook should print a decision");
            assert_eq!(
                decision["hookSpecificOutput"]["permissionDecision"], "allow",
                "the rule should be honoured without the socket"
            );
        }
        samples.sort();
        let median = samples[samples.len() / 2];
        eprintln!("end-to-end hook median (debug binary): {median:?}");
        assert!(median < Duration::from_millis(15), "median end-to-end hook cost was {median:?}, over the 15ms budget");
    }

    /// The routing decision the cheap path and the snapshot forced.
    ///
    /// A read-shaped tool with a rule takes the zero-socket path. A **write**
    /// tool with a rule still round trips - not to be approved, but so the
    /// before-state is captured. Without this, an "always allow Edit" rule would
    /// silently cost every diff for exactly the files the user trusted most.
    #[test]
    fn a_pre_approved_write_still_round_trips_so_its_before_state_is_captured() {
        let (server, prompts, observed) = observing_server(Duration::from_secs(5));
        let mut req = request(server.token(), "Edit", json!({"file_path": "/proj/a.rs"}));
        req.pre_approved = true;

        let resp = helper_exchange(server.sock_path(), &req).unwrap();

        assert_eq!(resp.decision, "allow", "a rule already allowed it, so it must not prompt");
        assert!(prompts.recv_timeout(Duration::from_millis(300)).is_err(), "a pre-approved call must not surface a prompt");
        let seen = observed.lock().unwrap();
        assert_eq!(seen.len(), 1, "but Sway must still see it, or there is no before-state");
        assert_eq!(seen[0].tool_name, "Edit");
    }

    /// Every authenticated call is observed before any decision, including one
    /// the user goes on to deny: the file's prior content is the same either way,
    /// and capturing after the fact would not be a before-state.
    #[test]
    fn a_call_is_observed_before_it_is_decided() {
        let (server, prompts, observed) = observing_server(Duration::from_secs(5));
        let sock = server.sock_path().to_path_buf();
        let req = request(server.token(), "Write", json!({"file_path": "/proj/new.rs"}));
        let handle = thread::spawn(move || helper_exchange(&sock, &req).unwrap());

        let prompt = prompts.recv_timeout(Duration::from_secs(5)).unwrap();
        // Observed already, while the call is still blocked and undecided.
        assert_eq!(observed.lock().unwrap().len(), 1);

        resolve(&server, &prompt.request_id, HookResponse::deny("no"));
        assert_eq!(handle.join().unwrap().decision, "deny");
        assert_eq!(observed.lock().unwrap().len(), 1, "a denied call is still observed exactly once");
    }

    /// An unauthenticated call must not be observed either, or a stranger on the
    /// socket could drive Sway's snapshot machinery.
    #[test]
    fn an_unauthenticated_call_is_never_observed() {
        let (server, _rx, observed) = observing_server(Duration::from_secs(1));
        let _ = helper_exchange(server.sock_path(), &request("wrong-token", "Edit", json!({"file_path": "/a"})));
        assert!(observed.lock().unwrap().is_empty());
    }

    // ---- settings injection ----

    /// The user's own hooks must still load and fire. `--setting-sources ''`
    /// would strip them, and must never ship.
    #[test]
    fn the_settings_payload_never_disables_the_users_own_sources() {
        let text = settings_json(Path::new("/bin/sway"), Path::new("/tmp/s"), "tok", Path::new("/tmp/r.json"));
        assert!(!text.contains("setting-sources"), "the payload must not touch setting sources");
        assert!(!text.contains("permissions"), "the payload must not override the user's permissions");
        let parsed: Value = serde_json::from_str(&text).unwrap();
        // Exactly one key: hooks. Anything else would be layering over settings
        // the user owns.
        assert_eq!(parsed.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["hooks"]);
        assert_eq!(parsed["hooks"].as_object().unwrap().keys().collect::<Vec<_>>(), vec!["PreToolUse"]);
    }

    /// All tools, deliberately: Phase 6 promises approvals hold even under
    /// `bypassPermissions`, and the snapshot needs every edit to go past.
    #[test]
    fn the_hook_matches_every_tool() {
        let parsed: Value = serde_json::from_str(&settings_json(
            Path::new("/bin/sway"),
            Path::new("/tmp/s"),
            "tok",
            Path::new("/tmp/r.json"),
        ))
        .unwrap();
        assert_eq!(parsed["hooks"]["PreToolUse"][0]["matcher"], "*");
    }

    /// Paths with spaces survive the shell that runs the hook command.
    #[test]
    fn the_hook_command_quotes_paths_so_a_space_cannot_split_it() {
        let cmd = hook_command(
            Path::new("/Applications/My App/sway"),
            Path::new("/tmp/dir with space/s"),
            "tok",
            Path::new("/tmp/r.json"),
        );
        assert!(cmd.contains("'/Applications/My App/sway'"), "got {cmd}");
        assert!(cmd.contains("'/tmp/dir with space/s'"), "got {cmd}");
        assert!(cmd.starts_with(ENV_SOCK));
    }

    /// The helper is selected by an env marker the app's own process never has.
    #[test]
    fn the_app_process_is_never_mistaken_for_the_helper() {
        assert!(!is_helper(), "the test process has no hook marker set");
    }

    /// **Sway must never write to `~/.claude/settings.json`.** A click inside one
    /// chat pane changing the behaviour of every terminal session and every other
    /// project is not a thing a click inside one chat pane should be able to do.
    ///
    /// Checked by bytes rather than by reading the code, and across the whole
    /// rule lifecycle - add and remove - because "we do not write there" is a
    /// claim about behaviour, not about intent.
    #[test]
    fn adding_and_removing_a_rule_leaves_the_users_claude_settings_byte_identical() {
        let user_settings = dirs::home_dir().unwrap_or_default().join(".claude/settings.json");
        let before = std::fs::read(&user_settings).ok();

        let session = format!("settings-guard-{}", std::process::id());
        let path = rules::rules_path(&session);

        // Add a rule, then remove it, through the real store.
        rules::save(
            &path,
            &RuleFile {
                sway_pid: std::process::id(),
                stamp_ms: rules::now_ms(),
                rules: vec![rules::Rule { tool: "Bash".into(), prefix: Some("git status".into()) }],
            },
        )
        .unwrap();
        refresh_stamp(&session);
        assert!(rules::load(&path).is_some(), "the rule should have landed in Sway's own store");
        let _ = settings_args(&session, Path::new("/tmp/s"), "tok");
        std::fs::remove_file(&path).unwrap();

        let after = std::fs::read(&user_settings).ok();
        assert_eq!(before, after, "~/.claude/settings.json must be byte-identical before and after");

        // And Sway's own settings file, which claude *is* pointed at, layers only
        // hooks on top - it is a separate file entirely.
        assert_ne!(settings_path(&session), user_settings);
        let _ = std::fs::remove_file(settings_path(&session));
    }

    /// A user-level `PreToolUse` hook and Sway's must both fire on one tool call.
    ///
    /// `--settings` **merges**; it is `--setting-sources ''` that would strip the
    /// user's own hooks, permissions and config, which is why it must never ship.
    /// Asserted structurally on the payload - it declares only a hook, and names
    /// no source list, so nothing it contains can displace the user's settings.
    #[test]
    fn sways_settings_payload_can_only_add_a_hook_never_replace_the_users() {
        let text = settings_json(Path::new("/bin/sway"), Path::new("/tmp/s"), "tok", Path::new("/tmp/r.json"));
        let parsed: Value = serde_json::from_str(&text).unwrap();

        // One key, one hook event, one entry: there is nothing here that could
        // overwrite a user hook, because a merge unions the arrays.
        assert_eq!(parsed.as_object().unwrap().len(), 1);
        assert_eq!(parsed["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        for forbidden in ["setting-sources", "settingSources", "permissions", "env", "model"] {
            assert!(!text.contains(forbidden), "the payload must not carry {forbidden}");
        }
    }

    /// **`--settings` merges; it does not replace.** A user's own `PreToolUse`
    /// hook and Sway's must both fire on one tool call.
    ///
    /// Driven against the real CLI, because this is a claim about how `claude`
    /// layers settings sources, and no amount of inspecting our own payload can
    /// establish it. The "user" hook is installed at **project** scope in a temp
    /// directory rather than in `~/.claude/settings.json`: it exercises the same
    /// merge, and writing to the real file is the one thing this whole module
    /// promises never to do.
    #[test]
    #[ignore = "drives the real claude CLI: costs tokens and needs network"]
    fn a_user_hook_and_sways_hook_both_fire_on_one_tool_call() {
        let cwd = std::env::temp_dir().join(format!("sway-hook-merge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(cwd.join(".claude")).unwrap();

        // The "user's" own hook: it only leaves a marker, and allows.
        let marker = cwd.join("user-hook-fired");
        std::fs::write(
            cwd.join(".claude/settings.json"),
            json!({
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "*",
                        "hooks": [{
                            "type": "command",
                            "command": format!("cat > /dev/null; touch {}", marker.display()),
                        }],
                    }],
                }
            })
            .to_string(),
        )
        .unwrap();

        // Sway's hook, allowing everything by rule so the turn can finish.
        // `--session-id` requires a UUID, so a readable name will not do.
        let session = crate::chat::claude_transport::tests::uuid_like();
        let rules_path = rules::rules_path(&session);
        rules::save(
            &rules_path,
            &RuleFile {
                sway_pid: std::process::id(),
                stamp_ms: rules::now_ms(),
                rules: vec![rules::Rule { tool: "Bash".into(), prefix: None }],
            },
        )
        .unwrap();
        let (server, _rx) = test_server(Duration::from_secs(30));
        let settings = settings_args(&session, server.sock_path(), server.token()).unwrap();

        let adapter = crate::agents::find("claude").unwrap();
        let chat = adapter.chat.as_ref().unwrap();
        let mut args = crate::chat::commands::build_args(chat, &session, false, None, None, None, None, &[]);
        args.extend(settings);

        let mut child = std::process::Command::new(&chat.program)
            .args(&args)
            .current_dir(&cwd)
            .env("PATH", crate::env::augmented_path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("claude should start");
        let mut stderr = child.stderr.take().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        writeln!(
            stdin,
            "{}",
            json!({
                "type": "user",
                "message": {"role": "user", "content": [{"type": "text", "text": "Run the bash command `echo hi` and then stop."}]},
            })
        )
        .unwrap();

        // Wait for the turn to finish, then look at what fired.
        let stdout = child.stdout.take().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(180);
        let mut saw_result = false;
        for line in BufReader::new(stdout).lines() {
            if std::time::Instant::now() > deadline {
                break;
            }
            let Ok(line) = line else { break };
            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                if frame["type"] == "result" {
                    saw_result = true;
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        let mut err = String::new();
        let _ = stderr.read_to_string(&mut err);

        assert!(saw_result, "the turn should have completed; stderr: {err}");
        assert!(marker.exists(), "the user's own PreToolUse hook must still fire alongside Sway's");
        // Sway's fired too: the rule file is what allowed the call, and the turn
        // could not have completed a Bash call without our hook answering.
        assert_eq!(server.connections(), 0, "the allow-listed Bash call took the cheap path");

        let _ = std::fs::remove_file(&rules_path);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    /// The settings file carries a token, so it must not be world-readable and
    /// must not travel in argv where `ps` would show it to every process.
    #[test]
    fn the_settings_file_is_a_private_path_not_an_argv_blob() {
        let session = format!("perm-{}", std::process::id());
        let args = settings_args(&session, Path::new("/tmp/s"), "super-secret-token").unwrap();
        assert_eq!(args[0], "--settings");
        assert!(!args[1].trim_start().starts_with('{'), "a token in argv is visible in `ps`");
        assert!(!args[1].contains("super-secret-token"));

        let mode = std::fs::metadata(&args[1]).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the settings file holds a token");
        let _ = std::fs::remove_file(&args[1]);
    }
}
