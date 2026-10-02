// Askpass credential bridge for backgrounded git.
//
// git and ssh ask for credentials by invoking `$GIT_ASKPASS`/`$SSH_ASKPASS`
// with the human prompt as argv[1] and reading the answer off the helper's
// stdout. We point those at Tori's own binary re-exec'd (see [[helper mode]]),
// so a backgrounded `git fetch` never needs a TTY: each prompt round-trips over
// a private Unix socket into a native in-app dialog and back.
//
// The same socket answers one other question: `crate::credential` asks it for a
// git credential, which is resolved from the op or the repo path rather than
// shown to anyone.
// `Request.kind` is what tells the two apart.
//
// Two halves live here:
//   * `run_helper` - the stdout-answer-only helper path, entered from `run()`
//     before any Tauri/AppKit init when the askpass marker env is present.
//   * `AskpassServer` - the socket server the app hosts; an accept loop with a
//     thread per connection, each round-tripping one prompt to the frontend.
//
// git calls askpass once per field as a *separate* process ("Username for ..."
// then "Password for ..."), so one fetch is 2+ helper runs = 2+ prompts. The
// flow is modeled per-op (`op_id`) not per-prompt: a per-op cancel latch lets a
// single cancel abort the whole op, so cancelling the username prompt makes the
// password prompt auto-return empty and git aborts under GIT_TERMINAL_PROMPT=0.
//
// Fail-closed is the invariant: any error, wrong token, timeout, or cancel
// yields an *empty* credential, never a hang. Secrets transit app memory and the
// local socket but are never logged and never persisted (git's own credential
// helper owns caching).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;

/// Env marker + fields git/ssh see when Tori re-execs itself as the helper.
pub const ENV_SOCK: &str = "TORI_ASKPASS_SOCK";
pub const ENV_TOKEN: &str = "TORI_ASKPASS_TOKEN";
pub const ENV_OP: &str = "TORI_ASKPASS_OP";

/// How long a connection blocks for a resolution before failing closed. A user
/// staring at the dialog is fine; this only bounds a wedged/abandoned prompt.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(300);

/// Reject frames larger than this (defense against a runaway/hostile peer on the
/// socket). Prompts and credentials are small; 64 KiB is generous headroom.
const MAX_FRAME: u64 = 64 * 1024;

/// One prompt surfaced to the frontend. `id` is the per-request handle the
/// frontend echoes back via `askpass_respond`; `op_id` ties sibling
/// username/password prompts of one git op together for the cancel latch.
#[derive(Clone, Serialize)]
pub struct PromptEvent {
    pub id: u64,
    pub op_id: String,
    pub prompt: String,
    /// "username" | "password" - drives masked vs plain input on the frontend.
    pub kind: String,
}

/// The `kind` that asks for a git credential instead of surfacing a prompt.
pub const CREDENTIAL: &str = "credential";

/// Wire frame the helper sends the server: authenticated, per-op, one question.
#[derive(serde::Deserialize)]
struct Request {
    token: String,
    op_id: String,
    #[serde(default)]
    prompt: String,
    /// [`CREDENTIAL`] for the git credential helper; absent is a prompt.
    #[serde(default)]
    kind: String,
    /// The host git named, credential requests only.
    #[serde(default)]
    host: String,
    /// The repo path, which git only hands a helper under `useHttpPath`.
    #[serde(default)]
    path: String,
}

/// Wire frame the server sends back. An empty `value` is the fail-closed answer
/// (cancel/timeout/error) - git then receives an empty credential and aborts,
/// or, for a credential request, falls through to a prompt.
#[derive(Serialize, serde::Deserialize)]
struct Response {
    value: String,
}

// ---------------------------------------------------------------------------
// Helper mode (runs in the re-exec'd binary, before Tauri init)
// ---------------------------------------------------------------------------

/// True when this process was launched by git/ssh as the askpass helper (the
/// socket env marker is set). The app's own process never has it - it is set
/// only on the git child `Command`, so `run()` can branch on it safely.
pub fn is_helper() -> bool {
    std::env::var_os(ENV_SOCK).is_some()
}

/// The helper path: read the prompt from argv[1], round-trip it over the socket,
/// and write **only** the answer to stdout (all diagnostics to stderr). Any
/// error prints nothing to stdout and exits non-zero, so git sees an empty
/// credential and fails closed. Returns the process exit code.
pub fn run_helper() -> i32 {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let sock = match std::env::var(ENV_SOCK) {
        Ok(s) => s,
        Err(_) => return 1,
    };
    let token = std::env::var(ENV_TOKEN).unwrap_or_default();
    let op_id = std::env::var(ENV_OP).unwrap_or_default();

    match helper_exchange(Path::new(&sock), &token, &op_id, &prompt) {
        Ok(answer) => {
            // Answer-only: exactly the credential, no trailing newline (git
            // strips a trailing newline but we keep stdout pristine regardless).
            let mut stdout = std::io::stdout();
            if stdout.write_all(answer.as_bytes()).is_err() || stdout.flush().is_err() {
                return 1;
            }
            0
        }
        Err(e) => {
            // Diagnostics to stderr only; never echo the prompt/answer.
            eprintln!("tori askpass: {e}");
            1
        }
    }
}

fn helper_exchange(
    sock: &Path,
    token: &str,
    op_id: &str,
    prompt: &str,
) -> std::io::Result<String> {
    exchange(sock, serde_json::json!({ "token": token, "op_id": op_id, "prompt": prompt }))
}

/// The credential helper's question on the same socket: no prompt, and the
/// answer is git's whole `key=value` block rather than one field. See
/// [`crate::credential`] for how the op id or the path identifies the account.
pub fn ask_credential(sock: &Path, token: &str, op_id: &str, host: &str, path: &str) -> std::io::Result<String> {
    exchange(
        sock,
        serde_json::json!({ "token": token, "op_id": op_id, "kind": CREDENTIAL, "host": host, "path": path }),
    )
}

/// Connect to the server, send the authenticated frame, read one response line,
/// return its `value`. Isolated from env/stdout so it is unit-testable against a
/// stub listener.
fn exchange(sock: &Path, req: serde_json::Value) -> std::io::Result<String> {
    let mut stream = UnixStream::connect(sock)?;
    let req = serde_json::to_string(&req)?;
    stream.write_all(req.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let resp: Response = serde_json::from_str(line.trim_end())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(resp.value)
}

// ---------------------------------------------------------------------------
// Server (hosted by the app)
// ---------------------------------------------------------------------------

struct Pending {
    op_id: String,
    tx: Sender<Option<String>>,
}

#[derive(Default)]
struct ServerState {
    /// In-flight prompts awaiting a frontend resolution, by request id.
    pending: HashMap<u64, Pending>,
    /// Op ids that were cancelled; a later field-prompt for the same op returns
    /// empty immediately without surfacing a second dialog.
    cancelled: HashSet<String>,
    next_id: u64,
}

/// The live askpass server: a bound socket, a per-session token, and the shared
/// state the accept-loop threads and `askpass_respond` coordinate through. The
/// `emit` closure fans a prompt out to the frontend (in tests, a recorder).
pub struct AskpassInner {
    token: String,
    // Handed to processes Tori spawns for the user, where anything running can
    // read it, so it gets a credential and never raises a dialog.
    credential_token: String,
    // Written to the bridge file, which any process of the user's can read, so
    // it reaches only hosts set to answer git everywhere.
    everywhere_token: String,
    sock_path: PathBuf,
    dir: PathBuf,
    timeout: Duration,
    state: Mutex<ServerState>,
    emit: Box<dyn Fn(PromptEvent) + Send + Sync>,
}

impl AskpassInner {
    pub fn sock_path(&self) -> &Path {
        &self.sock_path
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn credential_token(&self) -> &str {
        &self.credential_token
    }
    pub fn everywhere_token(&self) -> &str {
        &self.everywhere_token
    }
}

impl Drop for AskpassInner {
    fn drop(&mut self) {
        // Best-effort cleanup of the private socket dir on shutdown.
        let _ = std::fs::remove_file(&self.sock_path);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Handle to the running server, stored as Tauri managed state.
pub struct AskpassState(pub Arc<AskpassInner>);

/// Start the askpass server: create a private `0700` dir under `$TMPDIR`, bind a
/// short-path Unix socket in it (Darwin's `sun_path` caps at 104 bytes), mint a
/// per-session random token, and spawn the accept loop (thread per connection).
pub fn start(emit: Box<dyn Fn(PromptEvent) + Send + Sync>) -> std::io::Result<Arc<AskpassInner>> {
    start_with(emit, RESOLVE_TIMEOUT)
}

fn start_with(
    emit: Box<dyn Fn(PromptEvent) + Send + Sync>,
    timeout: Duration,
) -> std::io::Result<Arc<AskpassInner>> {
    let token = random_token();

    // Short path: `$TMPDIR` is already short on macOS; the dir + socket names
    // are tiny. Assert we stay under the 104-byte sun_path limit. A per-start
    // counter keeps concurrent servers (e.g. parallel tests) on distinct dirs.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = std::env::temp_dir();
    let dir = base.join(format!("tori-akp-{}-{}", std::process::id(), seq));
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let sock_path = dir.join("s");
    // A stale socket from a crashed prior run would make bind fail with EADDRINUSE.
    let _ = std::fs::remove_file(&sock_path);
    // Darwin caps `sun_path` at 104 bytes; fail soft (the caller logs and the app
    // still runs) rather than panicking startup on a pathological $TMPDIR.
    if sock_path.as_os_str().len() >= 104 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("askpass socket path too long for sun_path: {}", sock_path.display()),
        ));
    }

    let listener = UnixListener::bind(&sock_path)?;
    std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o700))?;

    let inner = Arc::new(AskpassInner {
        token,
        credential_token: random_token(),
        everywhere_token: random_token(),
        sock_path,
        dir,
        timeout,
        state: Mutex::new(ServerState::default()),
        emit,
    });

    let accept_inner = inner.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let conn_inner = accept_inner.clone();
                    thread::spawn(move || handle_conn(&conn_inner, stream));
                }
                Err(_) => break,
            }
        }
    });

    Ok(inner)
}

/// Serve one helper connection: authenticate, honour the cancel latch, surface
/// the prompt, block for a resolution (or timeout), and write the answer back.
/// Every non-happy path writes an empty `value` (fail-closed).
fn handle_conn(inner: &Arc<AskpassInner>, stream: UnixStream) {
    let value = handle_request(inner, &stream).unwrap_or_default();
    // Best-effort response; a dead peer just means git already gave up.
    let _ = write_response(&stream, &value);
}

/// The authenticated request/resolve core, returning the answer string (empty =
/// fail-closed). Split out so `handle_conn` owns only the socket write.
fn handle_request(inner: &Arc<AskpassInner>, stream: &UnixStream) -> Option<String> {
    let mut reader = BufReader::new(stream.try_clone().ok()?.take(MAX_FRAME));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let req: Request = serde_json::from_str(line.trim_end()).ok()?;

    // A private 0700 dir already gates access; the token is defense-in-depth
    // against a same-user process guessing the path.
    let token = req.token.as_bytes();
    let is = |held: &str| crate::rpc::auth::constant_time_eq(token, held.as_bytes());
    let full = is(&inner.token);
    let reach = if full || is(&inner.credential_token) {
        crate::credential::Reach::Tori
    } else if is(&inner.everywhere_token) {
        crate::credential::Reach::Everywhere
    } else {
        return None;
    };
    // A credential is answered from the op's checkout or the repo path, with no
    // dialog and no user in the loop. Empty means Tori has nothing for it and
    // git falls through to the prompts below.
    if req.kind == CREDENTIAL {
        return Some(crate::credential::answer(&req.op_id, &req.host, &req.path, reach).unwrap_or_default());
    }
    if !full {
        return None;
    }
    // Bound the prompt we surface; a runaway prompt is treated as hostile.
    if req.prompt.len() > 4096 {
        return None;
    }

    let kind = classify(&req.prompt);

    let (tx, rx) = channel::<Option<String>>();
    let id = {
        let mut st = inner.state.lock().ok()?;
        // Latched-cancelled op: return empty immediately, never emit a dialog.
        if st.cancelled.contains(&req.op_id) {
            return Some(String::new());
        }
        st.next_id += 1;
        let id = st.next_id;
        st.pending.insert(
            id,
            Pending {
                op_id: req.op_id.clone(),
                tx,
            },
        );
        id
    };

    (inner.emit)(PromptEvent {
        id,
        op_id: req.op_id.clone(),
        prompt: req.prompt.clone(),
        kind,
    });

    // Block for the frontend's resolution or fail closed on timeout.
    let answer = match rx.recv_timeout(inner.timeout) {
        Ok(Some(v)) => v,
        _ => String::new(),
    };

    // Drop the pending entry either way (resolve already removed it, but a
    // timeout path did not).
    if let Ok(mut st) = inner.state.lock() {
        st.pending.remove(&id);
    }
    Some(answer)
}

fn write_response(mut stream: &UnixStream, value: &str) -> std::io::Result<()> {
    let resp = serde_json::to_string(&Response {
        value: value.to_string(),
    })?;
    stream.write_all(resp.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

/// Resolve an in-flight prompt. `Some(value)` answers it; `None` cancels the
/// whole op: the op id is latched so its remaining field-prompts auto-return
/// empty (no second dialog), and this prompt resolves empty too.
pub fn resolve(inner: &Arc<AskpassInner>, id: u64, value: Option<String>) {
    let mut st = match inner.state.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(p) = st.pending.remove(&id) {
        if value.is_none() {
            st.cancelled.insert(p.op_id.clone());
        }
        // If the receiver already timed out, the send is a harmless no-op.
        let _ = p.tx.send(value);
    }
}

/// Frontend answer to a surfaced prompt. `value: Some(_)` submits the
/// credential; `value: None` cancels, latching the op so its remaining field
/// prompts auto-return empty (git then aborts, fail-closed).
#[tauri::command]
pub fn askpass_respond(state: tauri::State<AskpassState>, id: u64, value: Option<String>) {
    resolve(&state.0, id, value);
}

/// Classify a git/ssh prompt (under LC_ALL=C, so English is stable) into the
/// input kind. Anything that is not explicitly a username is treated as secret
/// (password/passphrase) so it renders masked.
fn classify(prompt: &str) -> String {
    let p = prompt.to_ascii_lowercase();
    if p.contains("username") {
        "username".to_string()
    } else {
        "password".to_string()
    }
}

/// A per-session random token from `/dev/urandom`, hex-encoded. Falls back to a
/// pid/time mix if urandom is unreadable (the 0700 dir is the real gate).
fn random_token() -> String {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    /// Start a server whose `emit` forwards each prompt over a channel the test
    /// drains, so the test can inject resolutions deterministically.
    fn test_server(timeout: Duration) -> (Arc<AskpassInner>, Receiver<PromptEvent>) {
        let (etx, erx) = channel::<PromptEvent>();
        let emit = Box::new(move |ev: PromptEvent| {
            let _ = etx.send(ev);
        });
        let inner = start_with(emit, timeout).unwrap();
        (inner, erx)
    }

    /// Client side of one helper exchange: connect, send a frame, read the value.
    fn client(sock: &Path, token: &str, op_id: &str, prompt: &str) -> Option<String> {
        helper_exchange(sock, token, op_id, prompt).ok()
    }

    #[test]
    fn concurrent_ops_each_get_their_own_resolution() {
        let (inner, erx) = test_server(Duration::from_secs(5));
        let sock = inner.sock_path().to_path_buf();
        let token = inner.token().to_string();

        // Two concurrent connections, distinct op ids.
        let s1 = sock.clone();
        let t1 = token.clone();
        let h1 = thread::spawn(move || client(&s1, &t1, "opA", "Username for 'https://x': "));
        let s2 = sock.clone();
        let t2 = token.clone();
        let h2 = thread::spawn(move || client(&s2, &t2, "opB", "Password for 'https://x': "));

        // Resolve each emitted prompt with an op-specific answer.
        for _ in 0..2 {
            let ev = erx.recv_timeout(Duration::from_secs(5)).unwrap();
            resolve(&inner, ev.id, Some(format!("ans-{}", ev.op_id)));
        }

        assert_eq!(h1.join().unwrap().as_deref(), Some("ans-opA"));
        assert_eq!(h2.join().unwrap().as_deref(), Some("ans-opB"));
    }

    #[test]
    fn wrong_token_is_refused_without_emitting() {
        let (inner, erx) = test_server(Duration::from_secs(2));
        let got = client(inner.sock_path(), "not-the-token", "op", "Password: ");
        // Refused connections return an empty value and never surface a dialog.
        assert!(got.as_deref() == Some("") || got.is_none());
        assert!(erx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn latched_cancel_returns_empty_without_emitting() {
        let (inner, erx) = test_server(Duration::from_secs(2));
        // Pre-latch the op as cancelled.
        inner.state.lock().unwrap().cancelled.insert("dead-op".to_string());
        let got = client(inner.sock_path(), inner.token(), "dead-op", "Password: ");
        assert_eq!(got.as_deref(), Some(""));
        assert!(erx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn cancel_latches_the_op_so_the_next_field_auto_empties() {
        let (inner, erx) = test_server(Duration::from_secs(5));
        let sock = inner.sock_path().to_path_buf();
        let token = inner.token().to_string();

        // First field (username) is cancelled by the frontend.
        let s1 = sock.clone();
        let t1 = token.clone();
        let h1 = thread::spawn(move || client(&s1, &t1, "op1", "Username for 'https://x': "));
        let ev = erx.recv_timeout(Duration::from_secs(5)).unwrap();
        resolve(&inner, ev.id, None); // cancel

        assert_eq!(h1.join().unwrap().as_deref(), Some(""));

        // Second field (password) for the same op must auto-empty, no emit.
        let got = client(&sock, &token, "op1", "Password for 'https://x': ");
        assert_eq!(got.as_deref(), Some(""));
        assert!(erx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn a_credential_request_answers_empty_without_a_dialog() {
        // The socket's other question (`crate::credential`) has no user in the
        // loop, so a request naming no live op and no repo has to fail closed
        // rather than surface a prompt nobody asked for.
        let (inner, erx) = test_server(Duration::from_secs(2));
        let got = ask_credential(inner.sock_path(), inner.token(), "op-unknown", "github.com", "");
        assert_eq!(got.ok().as_deref(), Some(""));
        assert!(erx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn timeout_fails_closed() {
        let (inner, erx) = test_server(Duration::from_millis(200));
        let got = client(inner.sock_path(), inner.token(), "op", "Password: ");
        // A dialog is surfaced, but no one answers within the timeout.
        assert!(erx.recv_timeout(Duration::from_secs(1)).is_ok());
        assert_eq!(got.as_deref(), Some(""));
    }

    #[test]
    fn classify_distinguishes_username_from_secret() {
        assert_eq!(classify("Username for 'https://github.com': "), "username");
        assert_eq!(classify("Password for 'https://x': "), "password");
        assert_eq!(classify("Enter passphrase for key '/k': "), "password");
    }

    #[test]
    fn helper_exchange_errors_when_no_socket() {
        let missing = std::env::temp_dir().join("tori-akp-does-not-exist/s");
        assert!(helper_exchange(&missing, "t", "op", "Password: ").is_err());
    }
}
