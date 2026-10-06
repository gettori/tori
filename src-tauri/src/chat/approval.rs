//! The `PreToolUse` capture hook: a per-session Unix socket, and the hook helper
//! that blocks on it just long enough to hand over a file's before-state.
//!
//! **This was a gate, and is not one any more.** It was built because nothing
//! else could ask: measured on claude 2.1.220, a permission prompt fires when a
//! *dialog* would be shown and headless `-p` has none. `PreToolUse` does fire, it
//! runs **first** in the permission chain (before deny rules, ask rules and
//! permission mode), and a deny from it applies even under `bypassPermissions`.
//! That made it the only authoritative gate available.
//!
//! That premise stopped holding on claude 2.1.231, where
//! `--permission-prompt-tool stdio` makes the CLI ask in-protocol with a
//! `can_use_tool` control request that `claude_transport.rs` answers. The two
//! cannot both be live for one call, and the hook wins: a `PreToolUse` `allow`
//! short-circuits the rest of the chain, so a hook that answers every tool means
//! the agent is never reached and never asks (measured three ways in
//! `dev/protocol-probe.mjs`). So the hook stopped answering, and now it is gone:
//! Tori decides no tool call, in any mode, for any agent.
//!
//! **What is left is a capture, and only a capture.** The helper matches the
//! write tools, exits 0 emitting **no** decision at all - which lets the chain
//! continue to the agent while the hook still runs - and the one thing it does
//! on the way is hand Tori the file's prior contents, synchronously, before the
//! write lands. A before-state captured after the write is not a before-state,
//! which is the whole reason a socket is involved rather than a fire-and-forget.
//!
//! **It is fail-open, deliberately.** Whatever goes wrong - no socket, wrong
//! token, a dead server - the agent is still going to ask, and denying here
//! would be Tori gating again by the back door on the one path built to have
//! stopped. The cost of a failure is a tool card with no diff.
//!
//! **The shape is [[concept_askpass_bridge]]'s, reused rather than reinvented**:
//! a socket in a private dir (`platform::ipc::PrivateListener`, which keeps the
//! path under Darwin's 104 byte `sun_path`), a per-server random token, and an accept loop with a
//! thread per connection. The gate needed a cheap path that answered most calls
//! from a file without opening a socket, because it matched *all* tools and a
//! turn doing fifty `Read`s must not cost fifty round trips. The capture gets
//! that for free by never being handed a `Read` in the first place.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::ChatTransport;
use crate::platform::ipc::{self, random_token, PrivateListener, UnixStream};

/// Env markers the helper reads. Set inline on the hook command string rather
/// than inherited, so only the hook process ever sees them.
pub const ENV_SOCK: &str = "TORI_CHAT_HOOK_SOCK";
pub const ENV_TOKEN: &str = "TORI_CHAT_HOOK_TOKEN";

/// The `matcher` the capture hook ships.
///
/// Measured on claude 2.1.231: a matcher of `"Edit|Write|MultiEdit|NotebookEdit"`
/// fires on `Edit` and `Write` and not on `Read`, so the alternation is a real
/// selector rather than a literal name (`dev/protocol-probe.mjs`, scenario
/// `hook-matcher`). Built from [`super::snapshot::WRITE_TOOLS`] rather than
/// written out, so a tool added to the snapshot list cannot be left off the
/// matcher and silently lose its diff.
fn matcher() -> String {
    super::snapshot::WRITE_TOOLS.join("|")
}

/// How long a agent may leave an in-protocol permission question unanswered.
///
/// Must stay **strictly below** [`HOOK_TIMEOUT_SECS`], which is what the CLI is
/// told. Tori owning the deadline is the point: if the CLI's timeout fired
/// first, the outcome would be the CLI's default rather than a denial we can
/// explain, and the user would see a tool blocked with no reason.
pub const DECIDE_TIMEOUT_SECS: u64 = 110;

/// The `timeout` declared to the CLI for our hook.
pub const HOOK_TIMEOUT_SECS: u64 = 120;

/// Reject frames larger than this. Tool inputs are small; a hostile or runaway
/// peer does not get to allocate without bound.
const MAX_FRAME: u64 = 256 * 1024;

/// What the helper hands over about one tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRequest {
    pub token: String,
    pub session_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub tool_input: Value,
}

/// What the server answers a capture with.
///
/// The helper discards it: the reply exists so the helper's blocking read
/// returns and the write can proceed, not to carry a decision - there is no
/// decision left to carry. It stays a JSON line rather than a bare newline so a
/// reader can still tell an answer from a hang-up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureAck {
    pub captured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny: Option<String>,
}

/// The marker that makes Tori's own hook identifiable in the in-band
/// `hook_response` stream.
///
/// Needed because nothing else distinguishes it. Measured on claude 2.1.220:
/// `hook_name` reports the **tool**, not the configured matcher, so Tori's
/// write-tool hook and a user's `PreToolUse` hook on the same tool both arrive
/// as `PreToolUse:Write`, and the frames carry no command. Rather than guess
/// from the shape of the output, Tori stamps its own.
///
/// Verified non-invasive: claude echoes the whole stdout string back in
/// `hook_response.output` verbatim and ignores keys it does not know.
pub const TORI_HOOK_MARKER: &str = "toriApproval";

/// The JSON the capture hook writes to stdout: the marker, and nothing else.
///
/// **There is deliberately no `permissionDecision` here.** Measured on claude
/// 2.1.231, any `permissionDecision` ends the permission chain at the hook, so
/// emitting one would take the question away from the agent - the exact
/// failure this whole change exists to undo.
///
/// Measured alongside it on claude 2.1.232: an output carrying **only** unknown
/// keys leaves the chain running - the `Write` still raised `can_use_tool` - and
/// comes back verbatim in `hook_response.output`, so the marker rides along for
/// free (`dev/protocol-probe.mjs`, scenario `hook-matcher`, which asserts both).
///
/// The marker is not decoration. It is what lets `claude.rs` say *whose* hook a
/// failed `PreToolUse:Write` row belongs to, which is the one moment the user
/// needs to know Tori put a hook there at all.
pub fn hook_output() -> String {
    json!({ TORI_HOOK_MARKER: true }).to_string()
}

/// The one decision the hook makes: a Topic chat writing into a member it may
/// only read. Ending the chain here is the point, since asking would offer to
/// write where the Topic says no.
pub fn hook_denial(reason: &str) -> String {
    json!({
        TORI_HOOK_MARKER: true,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
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

/// Everything the helper reads out of a `PreToolUse` payload.
///
/// **`permission_mode` is deliberately not here**, though the payload carries
/// it. Nothing in Tori is entitled to branch on it: the mode is the agent's
/// own control, and a helper that read it would be a helper capable of behaving
/// differently in one mode than another - which is a gate, however small.
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

/// The helper: read the `PreToolUse` payload from stdin, hand Tori the
/// before-state if there is one, stamp the marker on stdout. Returns the process
/// exit code.
///
/// Exit code 0 whatever happens, never a non-zero exit: a hook that exits
/// non-zero is a *malfunctioning* hook, and the CLI's handling of that is not a
/// decision we control.
pub fn run_helper() -> i32 {
    let mut payload = String::new();
    // A payload that could not be read is a call whose before-state is lost, and
    // nothing more. There is no decision to withhold and so nothing to fail
    // closed about; the write proceeds and its card has no diff.
    let mut deny = None;
    if std::io::stdin().read_to_string(&mut payload).is_ok() {
        let sock = std::env::var(ENV_SOCK).unwrap_or_default();
        deny = helper_capture(
            &payload,
            Path::new(&sock),
            &std::env::var(ENV_TOKEN).unwrap_or_default(),
        );
    }
    emit(&deny.map_or_else(hook_output, |reason| hook_denial(&reason)))
}

/// Hand the server this call's before-state, if this call has one.
///
/// Split out of [`run_helper`] so it is testable against a real socket without
/// re-execing the binary. Every input is an argument; nothing here reads the
/// environment.
fn helper_capture(payload: &str, sock: &Path, token: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    let HookInputs {
        tool_name,
        tool_input,
        session_id,
        tool_use_id,
    } = hook_inputs(&parsed);

    // The matcher should already have kept this tool away from us, but the
    // matcher is claude's and this is the claim Tori can keep on its own:
    // nothing with no before-state to capture costs a socket.
    if super::snapshot::write_targets(&tool_name, &tool_input).is_empty() {
        return None;
    }
    let req = HookRequest {
        token: token.to_string(),
        session_id,
        tool_use_id,
        tool_name,
        tool_input,
    };
    // Fail-open: whatever went wrong, the agent is still going to ask, and
    // refusing here would be Tori gating again by the back door. The round trip
    // is still synchronous, because a before-state captured after the write is
    // not a before-state.
    helper_exchange(sock, &req).ok().and_then(|ack| ack.deny)
}

/// Exit 0 having written `output`.
///
/// Measured on claude 2.1.231: a `PreToolUse` hook that exits 0 without a
/// `permissionDecision` lets the permission chain continue to the agent, while
/// any `permissionDecision` ends the chain there. A stdout that cannot be
/// written is not worth a non-zero exit - the capture already happened, and all
/// that is lost is the row's attribution.
fn emit(output: &str) -> i32 {
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(output.as_bytes());
    let _ = stdout.flush();
    0
}

/// One round trip to the server. Isolated from env and stdout so it is testable
/// against a stub listener, the same split `askpass.rs` uses.
fn helper_exchange(sock: &Path, req: &HookRequest) -> std::io::Result<CaptureAck> {
    let mut stream = ipc::connect(sock)?;
    stream.write_all(serde_json::to_string(req)?.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    // An empty line means the server hung up without answering (it died, or the
    // app quit mid-call). The capture is lost either way; saying so is only for
    // a caller that wants to log it.
    if line.trim().is_empty() {
        return Ok(CaptureAck {
            captured: false,
            deny: None,
        });
    }
    serde_json::from_str(line.trim_end()).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

// ---------------------------------------------------------------------------
// Server (hosted by the app)
// ---------------------------------------------------------------------------

type Guard = Box<dyn Fn(&HookRequest) -> Option<String> + Send + Sync>;

/// The live capture server.
pub struct CaptureServer {
    token: String,
    sock_path: PathBuf,
    /// Counts accepted connections, so a test can assert a read-shaped tool
    /// really avoided the socket rather than merely being answered quickly.
    connections: AtomicU64,
    /// Set by [`CaptureServer::shutdown`] so the accept loop exits.
    stopping: AtomicBool,
    /// Called for every authenticated request, so the before-state of a file
    /// about to be written is captured *on the way past*.
    observe: Box<dyn Fn(&HookRequest) + Send + Sync>,
    /// Asked first; a reason refuses the write, which then has nothing to capture.
    guard: Guard,
}

impl CaptureServer {
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

    /// Wind the accept loop down.
    ///
    /// This exists because `Drop` alone cannot do it. The accept thread holds an
    /// `Arc` to this server, so as long as it is looping the refcount never
    /// reaches zero and `Drop` never runs - one leaked thread and one leaked
    /// `$TMPDIR` directory per chat session ever opened. The self-connect is how
    /// a blocking `incoming()` is woken without a second signalling mechanism.
    ///
    /// Nothing has to be released first: a capture blocks its helper for as long
    /// as one snapshot takes, not for as long as a person takes to answer, so
    /// there is no queue of waiters to resolve on the way out.
    ///
    /// Idempotent: session close and app exit both call it.
    pub fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = ipc::connect(self.sock_path());
    }
}

/// Bind a socket for one chat session and start accepting.
///
/// The session id is deliberately **not** in the path. Darwin caps `sun_path` at
/// 104 bytes ([[gotchas#darwin-caps-unix-socket-paths-at-104-bytes]]), and a
/// UUID would eat a third of that for no benefit: the id already travels in the
/// request payload, where it costs nothing.
pub fn start_guarded(
    observe: Box<dyn Fn(&HookRequest) + Send + Sync>,
    guard: Guard,
) -> std::io::Result<Arc<CaptureServer>> {
    // The accept thread owns the listener, so the socket closes when the loop
    // exits and a helper arriving after `shutdown` is refused, not left waiting.
    let listener = PrivateListener::bind("tori-cha")?;
    let server = Arc::new(CaptureServer {
        token: random_token()?,
        sock_path: listener.path().to_path_buf(),
        connections: AtomicU64::new(0),
        stopping: AtomicBool::new(false),
        observe,
        guard,
    });

    let accept = server.clone();
    thread::spawn(move || {
        for stream in listener.listener().incoming() {
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

#[cfg(test)]
pub fn start(observe: Box<dyn Fn(&HookRequest) + Send + Sync>) -> std::io::Result<Arc<CaptureServer>> {
    start_guarded(observe, Box::new(|_| None))
}

fn handle_conn(server: &Arc<CaptureServer>, stream: UnixStream) {
    // A failure inside still gets an answer rather than a dropped connection:
    // the helper is blocking on this line and the write it belongs to is waiting
    // on the helper, so silence would cost more than a `captured: false` does.
    let ack = handle_request(server, &stream).unwrap_or(CaptureAck {
        captured: false,
        deny: None,
    });
    let _ = write_response(&stream, &ack);
}

fn handle_request(server: &Arc<CaptureServer>, stream: &UnixStream) -> Option<CaptureAck> {
    let mut reader = BufReader::new(stream.try_clone().ok()?.take(MAX_FRAME));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let req: HookRequest = serde_json::from_str(line.trim_end()).ok()?;

    if req.token.as_bytes() != server.token.as_bytes() {
        return None;
    }

    if let Some(reason) = (server.guard)(&req) {
        return Some(CaptureAck {
            captured: false,
            deny: Some(reason),
        });
    }
    // The file is about to be written, and a before-state captured after the
    // fact is not a before-state. This is the whole errand.
    (server.observe)(&req);
    Some(CaptureAck {
        captured: true,
        deny: None,
    })
}

fn write_response(mut stream: &UnixStream, ack: &CaptureAck) -> std::io::Result<()> {
    stream.write_all(serde_json::to_string(ack)?.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
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
pub fn hook_command(exe: &Path, sock: &Path, token: &str) -> String {
    format!(
        "{}={} {}={} {}",
        ENV_SOCK,
        sh_quote(&sock.to_string_lossy()),
        ENV_TOKEN,
        sh_quote(token),
        sh_quote(&exe.to_string_lossy()),
    )
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The `--settings` payload for one chat session.
///
/// The matcher is the write tools and nothing else. Narrowing it is what makes a
/// turn doing fifty `Read`s cost zero sockets: the helper never opens one for a
/// tool it is never handed.
///
/// `--setting-sources` is **not** set, so this layers on top of the user's own
/// settings rather than replacing them: their hooks still load and fire
/// alongside ours. Passing `--setting-sources ''` would silently disable their
/// hooks, permissions and config, and must never ship.
#[cfg(test)]
pub fn settings_json(exe: &Path, sock: &Path, token: &str, background: bool) -> String {
    settings_json_with(exe, sock, token, background, None)
}

/// `settings_json` plus the member rules a Topic home chat carries. Only the
/// rules: a member's hooks are tied to its own folder and never come along.
pub fn settings_json_with(
    exe: &Path,
    sock: &Path,
    token: &str,
    background: bool,
    home: Option<&crate::topic_home::HomeLaunch>,
) -> String {
    let mut permissions = json!({ "allow": crate::rpc::mcp_allow(background) });
    if let Some(home) = home {
        for (key, rules) in [("allow", &home.allow), ("deny", &home.deny), ("ask", &home.ask)] {
            if rules.is_empty() {
                continue;
            }
            let list = permissions
                .as_object_mut()
                .unwrap()
                .entry(key)
                .or_insert_with(|| json!([]));
            list.as_array_mut()
                .unwrap()
                .extend(rules.iter().cloned().map(Value::String));
        }
    }
    json!({
        "permissions": permissions,
        "hooks": {
            "PreToolUse": [{
                "matcher": matcher(),
                "hooks": [{
                    "type": "command",
                    "command": hook_command(exe, sock, token),
                    "timeout": HOOK_TIMEOUT_SECS,
                }],
            }],
        }
    })
    .to_string()
}

/// Write the settings file and return the `["--settings", <path>]` args, led
/// by `--mcp-config` for a claude transport. `--mcp-config` is variadic, so
/// `--settings` has to follow it directly.
///
/// A **path**, not inline JSON. Not for the PTY reason (nothing is typed into a
/// shell here) but because the command string embeds absolute paths and a token,
/// and an argv-embedded JSON blob shows the token in `ps` output for every
/// process on the machine. The file is `0600`.
pub fn settings_args(
    session_id: &str,
    sock: &Path,
    token: &str,
    transport: ChatTransport,
    background: bool,
    home: Option<&crate::topic_home::HomeLaunch>,
) -> Result<Vec<String>, String> {
    let exe = crate::platform::helper_exe().map_err(|e| e.to_string())?;
    let path = settings_path(session_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::platform::fs::write_private(
        &path,
        settings_json_with(&exe, sock, token, background, home).as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    let mut args = match transport {
        ChatTransport::ClaudeStreamJson => crate::rpc::mcp_config_args(),
        ChatTransport::Acp => Vec::new(),
    };
    args.extend(["--settings".to_string(), path.to_string_lossy().into_owned()]);
    Ok(args)
}

/// Where a session's `--settings` payload lives. Public so teardown can remove
/// it: it carries a socket path and a token that outlive nothing.
pub fn settings_path(session_id: &str) -> PathBuf {
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    crate::owned_state::config_dir()
        .join("chat-settings")
        .join(format!("{safe}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    /// A server that records every observed request, so the capture can be
    /// asserted on. The [[lesson_offline_askpass_e2e]] shape: the closure is
    /// injected, and no Tauri appears anywhere.
    fn observing_server() -> (Arc<CaptureServer>, Arc<Mutex<Vec<HookRequest>>>) {
        let seen: Arc<Mutex<Vec<HookRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let server = start(Box::new(move |req| recorder.lock().unwrap().push(req.clone()))).unwrap();
        (server, seen)
    }

    fn request(token: &str, tool: &str, input: Value) -> HookRequest {
        HookRequest {
            token: token.to_string(),
            session_id: "s1".to_string(),
            tool_use_id: "toolu_1".to_string(),
            tool_name: tool.to_string(),
            tool_input: input,
        }
    }

    fn payload(tool: &str, input: Value) -> String {
        json!({
            "session_id": "s1",
            "tool_use_id": "toolu_1",
            "tool_name": tool,
            "tool_input": input,
            "hook_event_name": "PreToolUse",
        })
        .to_string()
    }

    /// The whole reason a socket is involved: the write is held until Tori has
    /// the file's prior contents.
    #[test]
    fn a_write_is_captured_before_the_helper_is_released() {
        let (server, observed) = observing_server();
        let ack = helper_exchange(
            server.sock_path(),
            &request(server.token(), "Edit", json!({"file_path": "/proj/a.rs"})),
        )
        .unwrap();

        assert!(ack.captured, "the server should say it took the before-state");
        let seen = observed.lock().unwrap();
        assert_eq!(
            seen.len(),
            1,
            "an Edit that captures nothing leaves its tool card with no diff"
        );
        assert_eq!(seen[0].tool_name, "Edit");
        assert!(!super::super::snapshot::write_targets(&seen[0].tool_name, &seen[0].tool_input).is_empty());
    }

    /// An unauthenticated call must not be observed, or a stranger on the socket
    /// could drive Tori's snapshot machinery.
    #[test]
    fn an_unauthenticated_call_is_never_observed() {
        let (server, observed) = observing_server();
        let ack = helper_exchange(
            server.sock_path(),
            &request("wrong-token", "Edit", json!({"file_path": "/a"})),
        )
        .unwrap();
        assert!(!ack.captured, "a wrong token must not be answered as a capture");
        assert!(observed.lock().unwrap().is_empty());
    }

    /// The server dying mid-request must reach the helper as an answer, not as a
    /// hang: the write is waiting on the helper, which is waiting on this line.
    #[test]
    fn a_server_that_goes_away_mid_request_releases_the_helper() {
        let (server, _observed) = observing_server();
        let sock = server.sock_path().to_path_buf();
        let token = server.token().to_string();
        server.shutdown();

        let started = std::time::Instant::now();
        // Either the connect fails outright or the answer is a non-capture; what
        // must never happen is the helper sitting there.
        let _ = helper_exchange(&sock, &request(&token, "Write", json!({"file_path": "/a"})));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a dead server must not hold a write open"
        );
    }

    /// `shutdown` really winds the accept loop down, so the thread and the
    /// `$TMPDIR` directory are not leaked once per chat session ever opened.
    #[test]
    fn shutdown_stops_the_accept_loop_so_nothing_is_leaked_per_session() {
        let (server, _observed) = observing_server();
        let dir = server.sock_path().parent().unwrap().to_path_buf();
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

    /// No server at all. The helper treats this as a lost diff and nothing more,
    /// which is the fail-open rule; here we only pin that it is an error rather
    /// than a hang.
    #[test]
    fn an_unreachable_socket_errors_rather_than_blocking() {
        let missing = std::env::temp_dir().join("tori-cha-does-not-exist/s");
        assert!(helper_exchange(&missing, &request("t", "Write", json!({}))).is_err());
    }

    /// The 104-byte `sun_path` cap. The session id is not in the path, which is
    /// the whole reason this holds however long an id a agent mints.
    #[test]
    fn socket_paths_stay_under_the_darwin_104_byte_cap() {
        let (server, _observed) = observing_server();
        let len = server.sock_path().as_os_str().len();
        assert!(len < 104, "{} is {len} bytes", server.sock_path().display());

        let (other, _observed2) = observing_server();
        assert_eq!(
            other.sock_path().as_os_str().len(),
            len,
            "the socket path is fixed-width by construction"
        );
    }

    /// Two writes in flight must both be captured and both released.
    #[test]
    fn concurrent_captures_are_each_answered() {
        let (server, observed) = observing_server();
        let sock = server.sock_path().to_path_buf();

        let handles: Vec<_> = ["Edit", "Write"]
            .iter()
            .map(|tool| {
                let s = sock.clone();
                let t = server.token().to_string();
                let tool = tool.to_string();
                thread::spawn(move || {
                    helper_exchange(&s, &request(&t, &tool, json!({"file_path": "/proj/a.rs"}))).unwrap()
                })
            })
            .collect();

        for h in handles {
            assert!(h.join().unwrap().captured);
        }
        assert_eq!(observed.lock().unwrap().len(), 2);
    }

    // ---- the helper ----

    /// **The claim the whole change rests on**: the helper emits no
    /// `permissionDecision`. Any decision ends the permission chain at the hook,
    /// so a helper that answered here would suppress the agent's own question
    /// for exactly the write tools this hook is narrowed to.
    ///
    /// It does emit the marker, which carries no decision and is what lets a
    /// failed hook row be attributed to Tori rather than to the user.
    #[test]
    fn the_helper_prints_the_marker_and_no_decision() {
        let out: Value = serde_json::from_str(&hook_output()).unwrap();
        assert_eq!(out[TORI_HOOK_MARKER], true);
        assert_eq!(
            out.as_object().unwrap().len(),
            1,
            "the marker is the whole output: {out}"
        );
        assert!(
            out.get("hookSpecificOutput").is_none(),
            "a decision here would short-circuit the agent"
        );
    }

    /// The capture happens, and it happens without the helper deciding anything.
    #[test]
    fn the_helper_captures_a_write_and_decides_nothing() {
        let (server, observed) = observing_server();
        helper_capture(
            &payload("Edit", json!({"file_path": "/proj/a.rs"})),
            server.sock_path(),
            server.token(),
        );
        assert_eq!(
            observed.lock().unwrap().len(),
            1,
            "the before-state must have been captured"
        );
    }

    /// Fail-open. A capture that cannot reach Tori has lost a diff; refusing
    /// instead would be Tori gating by the back door, silently, on the one path
    /// that is supposed to have stopped gating.
    #[test]
    fn a_capture_that_cannot_reach_tori_is_not_a_refusal() {
        // No panic, no error propagated, nothing printed but the marker.
        helper_capture(
            &payload("Write", json!({"file_path": "/proj/new.rs"})),
            Path::new("/nonexistent/socket"),
            "tok",
        );
        let out: Value = serde_json::from_str(&hook_output()).unwrap();
        assert!(
            out.get("hookSpecificOutput").is_none(),
            "an unreachable Tori must not become a denial"
        );
    }

    #[test]
    fn a_refused_write_is_denied_with_its_reason_and_an_unreachable_tori_denies_nothing() {
        let server = start_guarded(
            Box::new(|_| {}),
            Box::new(|req| {
                let target = req.tool_input["file_path"].as_str().unwrap_or_default();
                target.starts_with("/p/web/").then(|| "web is a reference".to_string())
            }),
        )
        .unwrap();
        let call = |path: &str| {
            helper_capture(
                &payload("Edit", json!({"file_path": path})),
                server.sock_path(),
                server.token(),
            )
        };

        let reason = call("/p/web/app.ts").expect("a write under a reference is refused");
        let out: Value = serde_json::from_str(&hook_denial(&reason)).unwrap();
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(
            out["hookSpecificOutput"]["permissionDecisionReason"],
            "web is a reference"
        );
        assert_eq!(out[TORI_HOOK_MARKER], true);
        assert_eq!(call("/p/api/.tori/worktrees/auth/lib.rs"), None);
        let unreachable = helper_capture(
            &payload("Edit", json!({"file_path": "/p/web/app.ts"})),
            Path::new("/nonexistent/socket"),
            "tok",
        );
        assert_eq!(unreachable, None, "an unreachable Tori must not become a denial");
    }

    /// A payload that is not JSON at all must be survivable for the same reason.
    #[test]
    fn an_unparseable_payload_is_a_lost_diff_and_nothing_more() {
        let (server, observed) = observing_server();
        helper_capture("not json", server.sock_path(), server.token());
        assert!(observed.lock().unwrap().is_empty());
        assert_eq!(
            server.connections(),
            0,
            "there is nothing to capture, so nothing to connect for"
        );
    }

    /// A read-heavy turn must cost nothing. The matcher is the first line of
    /// this, but it belongs to claude; measured here on the server's own
    /// connection counter, so the claim holds even if a read reaches the helper.
    #[test]
    fn fifty_reads_open_no_sockets() {
        let (server, observed) = observing_server();
        for _ in 0..50 {
            helper_capture(
                &payload("Read", json!({"file_path": "/proj/a.rs"})),
                server.sock_path(),
                server.token(),
            );
        }
        assert_eq!(
            server.connections(),
            0,
            "a read has no before-state, so it must not cost a round trip"
        );
        assert!(observed.lock().unwrap().is_empty());
    }

    /// The per-call cost of a capture, budgeted because it sits in front of every
    /// write and a slow one would be felt as the agent stalling mid-edit.
    #[test]
    fn a_capture_stays_under_the_fifteen_millisecond_budget() {
        let (server, _observed) = observing_server();

        let mut samples: Vec<Duration> = Vec::new();
        for i in 0..40 {
            let start = std::time::Instant::now();
            helper_capture(
                &payload("Edit", json!({"file_path": format!("/proj/f{i}.rs")})),
                server.sock_path(),
                server.token(),
            );
            samples.push(start.elapsed());
        }
        samples.sort();
        let median = samples[samples.len() / 2];
        assert!(
            median < Duration::from_millis(15),
            "median capture round trip was {median:?}, over the 15ms budget"
        );
        // Printed so the number on this machine is visible in the run and can be
        // recorded, making a later regression legible rather than just a failure.
        eprintln!("capture round-trip median: {median:?}");
    }

    /// The **end-to-end** cost: the real binary re-exec'd as the hook, reading a
    /// payload on stdin and handing over a before-state.
    ///
    /// Separate from the budget test above and opt-in, because it needs a built
    /// binary that `cargo test` does not produce. It exists because the socket
    /// round trip is the cheap part: the honest per-call cost is dominated by
    /// `exec`ing Tori, and a budget that measured only the round trip would be
    /// measuring the wrong thing.
    #[test]
    #[ignore = "needs a built binary: cargo build, then cargo test -- --ignored"]
    fn the_end_to_end_hook_cost_is_measured_against_the_real_binary() {
        let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/tori");
        assert!(exe.exists(), "run `cargo build` first: {}", exe.display());

        let (server, observed) = observing_server();
        let text = payload("Write", json!({"file_path": "/proj/a.rs"}));

        let mut samples = Vec::new();
        for _ in 0..20 {
            let start = std::time::Instant::now();
            let mut child = crate::platform::process::command(&exe)
                .env(ENV_SOCK, server.sock_path())
                .env(ENV_TOKEN, server.token())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("the hook should start");
            child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            samples.push(start.elapsed());

            let printed: Value = serde_json::from_slice(&out.stdout).expect("the hook should print its marker");
            assert_eq!(printed[TORI_HOOK_MARKER], true);
            assert!(
                printed.get("hookSpecificOutput").is_none(),
                "the shipped helper must never print a decision"
            );
        }
        assert_eq!(observed.lock().unwrap().len(), 20, "every run should have captured");
        samples.sort();
        let median = samples[samples.len() / 2];
        eprintln!("end-to-end hook median (debug binary): {median:?}");
        assert!(
            median < Duration::from_millis(15),
            "median end-to-end hook cost was {median:?}, over the 15ms budget"
        );
    }

    /// The helper is selected by an env marker the app's own process never has.
    #[test]
    fn the_app_process_is_never_mistaken_for_the_helper() {
        assert!(!is_helper(), "the test process has no hook marker set");
    }

    // ---- settings injection ----

    /// Tori's deadline for an in-protocol answer must fire strictly before the
    /// timeout the CLI is told about, or the outcome would be the CLI's default
    /// rather than one Tori can explain.
    #[test]
    fn toris_deadline_is_strictly_inside_the_one_the_cli_is_told() {
        const { assert!(DECIDE_TIMEOUT_SECS < HOOK_TIMEOUT_SECS) };
        let settings: Value = serde_json::from_str(&settings_json(
            Path::new("/usr/local/bin/tori"),
            Path::new("/tmp/s"),
            "tok",
            false,
        ))
        .unwrap();
        assert_eq!(
            settings["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"],
            HOOK_TIMEOUT_SECS
        );
    }

    /// The user's own hooks must still load and fire. `--setting-sources ''`
    /// would strip them, and must never ship.
    #[test]
    fn the_settings_payload_never_disables_the_users_own_sources() {
        let text = settings_json(Path::new("/usr/local/bin/tori"), Path::new("/tmp/s"), "tok", false);
        assert!(
            !text.contains("setting-sources"),
            "the payload must not touch setting sources"
        );
        let parsed: Value = serde_json::from_str(&text).unwrap();
        // Hooks, and an allow for Tori's own tools only: anything else would be
        // layering over settings the user owns.
        assert_eq!(
            parsed.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["permissions", "hooks"]
        );
        let allowed = parsed["permissions"]["allow"].as_array().unwrap();
        assert!(
            allowed
                .iter()
                .all(|rule| rule.as_str().is_some_and(|r| r.starts_with("mcp__tori__"))),
            "only Tori's own tools"
        );
        assert_eq!(
            parsed["hooks"].as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["PreToolUse"]
        );
    }

    /// The hook is handed exactly the tools whose before-state is worth keeping,
    /// and nothing else. A tool `write_targets` reports but the matcher omits
    /// would lose its diff silently, which is why both read one list.
    #[test]
    fn the_hook_matches_the_write_tools_and_only_those() {
        let parsed: Value = serde_json::from_str(&settings_json(
            Path::new("/usr/local/bin/tori"),
            Path::new("/tmp/s"),
            "tok",
            false,
        ))
        .unwrap();
        let matcher = parsed["hooks"]["PreToolUse"][0]["matcher"]
            .as_str()
            .unwrap()
            .to_string();
        let named: Vec<&str> = matcher.split('|').collect();
        assert_eq!(named, super::super::snapshot::WRITE_TOOLS.to_vec());
        for tool in named {
            assert!(
                !super::super::snapshot::write_targets(tool, &json!({"file_path": "/a"})).is_empty(),
                "{tool} is in the matcher but captures nothing"
            );
        }
        assert!(!matcher.contains("Read"), "a read must never reach the hook");
        assert_ne!(
            matcher, "*",
            "matching every tool is what the gate did, and there is no gate"
        );
    }

    /// Paths with spaces survive the shell that runs the hook command.
    #[test]
    fn the_hook_command_quotes_paths_so_a_space_cannot_split_it() {
        let cmd = hook_command(
            Path::new("/Applications/My App/tori"),
            Path::new("/tmp/dir with space/s"),
            "tok",
        );
        assert!(cmd.contains("'/Applications/My App/tori'"), "got {cmd}");
        assert!(cmd.contains("'/tmp/dir with space/s'"), "got {cmd}");
        assert!(cmd.starts_with(ENV_SOCK));
    }

    /// **Tori must never write to `~/.claude/settings.json`.** A hook installed
    /// inside one chat pane changing the behaviour of every terminal session and
    /// every other project is not a thing one chat pane should be able to do.
    ///
    /// Checked by bytes rather than by reading the code, because "we do not write
    /// there" is a claim about behaviour, not about intent.
    #[test]
    fn spawning_a_session_leaves_the_users_claude_settings_byte_identical() {
        let user_settings = dirs::home_dir().unwrap_or_default().join(".claude/settings.json");
        let before = std::fs::read(&user_settings).ok();

        let session = format!("settings-guard-{}", std::process::id());
        let args = settings_args(
            &session,
            Path::new("/tmp/s"),
            "tok",
            ChatTransport::ClaudeStreamJson,
            false,
            None,
        )
        .unwrap();

        let after = std::fs::read(&user_settings).ok();
        assert_eq!(
            before, after,
            "~/.claude/settings.json must be byte-identical before and after"
        );

        // And Tori's own settings file, which claude *is* pointed at, layers only
        // hooks on top - it is a separate file entirely.
        assert_ne!(settings_path(&session), user_settings);
        assert_eq!(args.last().unwrap(), &settings_path(&session).to_string_lossy());
        let _ = std::fs::remove_file(settings_path(&session));
    }

    /// `--settings` **merges**; it is `--setting-sources ''` that would strip the
    /// user's own hooks, permissions and config. Asserted structurally on the
    /// payload: it declares one hook and one allow rule for Tori's own tools and
    /// names no source list, so nothing it contains can displace the user's settings.
    #[test]
    fn toris_settings_payload_can_only_add_a_hook_never_replace_the_users() {
        let text = settings_json(Path::new("/usr/local/bin/tori"), Path::new("/tmp/s"), "tok", false);
        let parsed: Value = serde_json::from_str(&text).unwrap();

        // One hook event, one entry and allow rules for Tori's tools: a merge
        // unions the arrays, so none of it can overwrite a user hook or rule.
        assert_eq!(parsed.as_object().unwrap().len(), 2);
        assert_eq!(parsed["permissions"], json!({ "allow": crate::rpc::mcp_allow(false) }));
        assert_eq!(parsed["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        for forbidden in [
            "setting-sources",
            "settingSources",
            "deny",
            "defaultMode",
            "env",
            "model",
        ] {
            assert!(!text.contains(forbidden), "the payload must not carry {forbidden}");
        }
    }

    /// The settings file carries a token, so it must not be world-readable and
    /// must not travel in argv where `ps` would show it to every process.
    #[test]
    fn the_settings_file_is_a_private_path_not_an_argv_blob() {
        let session = format!("perm-{}", std::process::id());
        let args = settings_args(
            &session,
            Path::new("/tmp/s"),
            "super-secret-token",
            ChatTransport::ClaudeStreamJson,
            false,
            None,
        )
        .unwrap();
        let [.., flag, file] = args.as_slice() else {
            panic!("no --settings in {args:?}")
        };
        assert_eq!(flag, "--settings");
        assert!(
            !file.trim_start().starts_with('{'),
            "a token in argv is visible in `ps`"
        );
        assert!(!args.iter().any(|a| a.contains("super-secret-token")));

        crate::platform::testing::assert_private(Path::new(file));
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn a_claude_session_gets_the_mcp_config_right_before_its_settings() {
        let session = format!("mcp-{}", std::process::id());
        let args = settings_args(
            &session,
            Path::new("/tmp/s"),
            "tok",
            ChatTransport::ClaudeStreamJson,
            false,
            None,
        )
        .unwrap();
        assert_eq!(args.len(), 4, "{args:?}");
        assert_eq!((args[0].as_str(), args[2].as_str()), ("--mcp-config", "--settings"));
        let config: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
        assert_eq!(
            config["mcpServers"]["tori"],
            json!({ "command": "tori", "args": ["mcp"] })
        );

        let acp = settings_args(&session, Path::new("/tmp/s"), "tok", ChatTransport::Acp, false, None).unwrap();
        assert_eq!(acp[0], "--settings");
        let _ = std::fs::remove_file(settings_path(&session));
    }

    #[test]
    fn only_a_background_session_pre_allows_the_outward_tools() {
        let allowed = |background| {
            let session = format!("allow-{background}-{}", std::process::id());
            let args = settings_args(
                &session,
                Path::new("/tmp/s"),
                "tok",
                ChatTransport::ClaudeStreamJson,
                background,
                None,
            )
            .unwrap();
            let settings: Value = serde_json::from_str(&std::fs::read_to_string(&args[3]).unwrap()).unwrap();
            let _ = std::fs::remove_file(settings_path(&session));
            settings["permissions"]["allow"].clone()
        };
        assert_eq!(allowed(true), json!(["mcp__tori__*"]));
        let foreground = allowed(false);
        let rules: Vec<&str> = foreground
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(
            rules.contains(&"mcp__tori__sessions_list") && rules.contains(&"mcp__tori__ask_create"),
            "{rules:?}"
        );
        for outward in [
            "mcp__tori__pr_create",
            "mcp__tori__review_submit",
            "mcp__tori__pr_merge",
            "mcp__tori__*",
        ] {
            assert!(
                !rules.contains(&outward),
                "{outward} must be left to the harness prompt"
            );
        }
    }

    // ---- against the real CLI ----

    /// A user-level `PreToolUse` hook and Tori's must both fire on one tool call.
    ///
    /// Driven against the real CLI, because this is a claim about how `claude`
    /// layers settings sources, and no amount of inspecting our own payload can
    /// establish it. The "user" hook is installed at **project** scope in a temp
    /// directory rather than in `~/.claude/settings.json`: it exercises the same
    /// merge, and writing to the real file is the one thing this whole module
    /// promises never to do.
    ///
    /// The prompt asks for a *write*, because that is the only tool Tori's own
    /// hook is handed now - a `Bash` call would prove only the user's hook fired.
    /// The hook is pointed at the built `target/debug/tori`, not at
    /// `current_exe()`: under `cargo test` that is the *test* binary, and handing
    /// claude a command that re-runs the suite is not a hook.
    #[test]
    #[ignore = "drives the real claude CLI and needs a built binary: cargo build, then cargo test -- --ignored"]
    fn a_user_hook_and_toris_hook_both_fire_on_one_tool_call() {
        let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/tori");
        assert!(exe.exists(), "run `cargo build` first: {}", exe.display());

        let cwd = std::env::temp_dir().join(format!("tori-hook-merge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(cwd.join(".claude")).unwrap();

        // The "user's" own hook: it only leaves a marker, and decides nothing.
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

        // `--session-id` requires a UUID, so a readable name will not do.
        let session = crate::chat::claude_transport::tests::uuid_like();
        let (server, observed) = observing_server();
        let settings_file = cwd.join("tori-settings.json");
        std::fs::write(
            &settings_file,
            settings_json(&exe, server.sock_path(), server.token(), false),
        )
        .unwrap();

        let adapter = crate::agents::find("claude").unwrap();
        let chat = adapter.chat.as_ref().unwrap();
        let mut args =
            crate::chat::commands::build_args(chat, &session, false, None, None, Some("bypassPermissions"), None, &[]);
        args.push("--settings".to_string());
        args.push(settings_file.to_string_lossy().into_owned());

        let mut child = crate::platform::process::command(&chat.program)
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
                "message": {"role": "user", "content": [{"type": "text", "text":
                    "Write a file called note.txt containing the word ok, then stop."}]},
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
        assert!(
            marker.exists(),
            "the user's own PreToolUse hook must still fire alongside Tori's"
        );
        // Tori's fired too, and this is the honest form of that claim: the
        // capture really landed on our socket.
        assert!(
            !observed.lock().unwrap().is_empty(),
            "Tori's own hook never reached the socket, so the merge did not include it"
        );

        let _ = std::fs::remove_dir_all(&cwd);
    }

    /// **The outcome this whole change exists for**, measured against the real
    /// CLI through the app's own spawn path: in `default` mode a chat that reads,
    /// greps and globs raises **no** permission prompt, while a write raises one -
    /// and the write's before-state is still captured.
    ///
    /// Deliberately not a unit test. Every part of the claim belongs to somebody
    /// else: which tools claude gates is claude's, whether the narrowed matcher
    /// selects is claude's, and whether a hook that emits only the marker lets the
    /// chain continue is claude's. What Tori contributes is the argv, so this uses
    /// `build_args` and `settings_json` rather than a hand-written approximation.
    #[test]
    #[ignore = "drives the real claude CLI and needs a built binary: cargo build, then cargo test -- --ignored"]
    fn reads_raise_no_prompt_while_a_write_still_does() {
        let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/tori");
        assert!(exe.exists(), "run `cargo build` first: {}", exe.display());

        let cwd = std::env::temp_dir().join(format!("tori-motivating-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(cwd.join("seed.txt"), "alpha\nbeta\n").unwrap();

        let session = crate::chat::claude_transport::tests::uuid_like();
        let (server, observed) = observing_server();
        let settings_file = cwd.join("tori-settings.json");
        std::fs::write(
            &settings_file,
            settings_json(&exe, server.sock_path(), server.token(), false),
        )
        .unwrap();

        let adapter = crate::agents::find("claude").unwrap();
        let chat = adapter.chat.as_ref().unwrap();
        let mut args = crate::chat::commands::build_args(chat, &session, false, None, None, Some("default"), None, &[]);
        args.push("--settings".to_string());
        args.push(settings_file.to_string_lossy().into_owned());

        let mut child = crate::platform::process::command(&chat.program)
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
                "message": {"role": "user", "content": [{"type": "text", "text":
                    "Do exactly these four things in order, one tool each and no others: (1) Read seed.txt, \
                     (2) Grep for alpha in seed.txt, (3) Glob for *.txt, (4) Write out.txt containing ok. Then stop."}]},
            })
        )
        .unwrap();

        let stdout = child.stdout.take().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        let mut asked: Vec<String> = Vec::new();
        let mut saw_result = false;
        for line in BufReader::new(stdout).lines() {
            if std::time::Instant::now() > deadline {
                break;
            }
            let Ok(line) = line else { break };
            let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if frame["type"] == "control_request" && frame["request"]["subtype"] == "can_use_tool" {
                asked.push(frame["request"]["tool_name"].as_str().unwrap_or_default().to_string());
                // Allowed so the turn can finish; *that* it was asked is the
                // measurement, not what the answer was.
                let _ = writeln!(
                    stdin,
                    "{}",
                    json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": frame["request_id"],
                            "response": {"behavior": "allow"},
                        },
                    })
                );
            }
            if frame["type"] == "result" {
                saw_result = true;
                break;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        let mut err = String::new();
        let _ = stderr.read_to_string(&mut err);

        assert!(saw_result, "the turn should have completed; stderr: {err}");
        assert!(
            asked.iter().any(|t| t == "Write"),
            "a write must still be asked about; asked: {asked:?}"
        );
        for quiet in ["Read", "Grep", "Glob"] {
            assert!(
                !asked.iter().any(|t| t == quiet),
                "{quiet} raised a permission prompt, which is the thing this change removes; asked: {asked:?}"
            );
        }

        // And the hook still did its one job, or the write's card would have no
        // diff - a silence that nothing else here would have noticed.
        let seen = observed.lock().unwrap();
        assert!(
            seen.iter().any(|r| r.tool_name == "Write"),
            "the write's before-state was never captured; observed: {:?}",
            seen.iter().map(|r| r.tool_name.as_str()).collect::<Vec<_>>()
        );
        assert!(
            !seen
                .iter()
                .any(|r| matches!(r.tool_name.as_str(), "Read" | "Grep" | "Glob")),
            "a read-shaped tool reached the hook, so the matcher is not narrowing"
        );

        let _ = std::fs::remove_dir_all(&cwd);
    }
}
