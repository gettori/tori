// Claude hook-driven authoritative session status (Phase 3, Finding A
// mechanism D). The tail join (`sessions::classify_tail`) only *guesses*
// "needs you" from a quiet PTY plus a pending tool_use; claude's own hook
// events are ground truth - in particular `Notification`, which claude fires
// exactly when it decides it needs the user (a permission prompt or an idle
// nudge).
//
// Injection mechanism (verified phase 1, empirically confirmed
// non-invasive): `claude --settings <path>` layers an *additional* settings
// source on top of the normal ones (`~/.claude/settings.json` stays
// byte-identical); this is Tori-launched-only - an externally-launched
// `claude` never sees the flag, so it never sees the hooks either. The value
// is a **file path** (`~/.config/tori/tab-settings/<tab>.json`), not
// inline JSON - see `write_tab_settings`'s doc comment for why an
// inline blob broke every claude launch (the command is typed into the
// tab's login shell, and a PTY in canonical mode truncates a single long
// line).
//
// The injected hook command never writes prompt text or tool input to disk:
// it greps only `session_id`/`hook_event_name` out of the raw JSON payload
// on stdin (POSIX `grep`/`sed`/`printf` only, no jq/node/python dependency)
// and writes a small `{event, at}` marker to
// `~/.config/tori/hooks-status/<session id>.json` - same directory
// convention as `checkpoint.rs`'s `~/.config/tori/checkpoint-index/<id>`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::sessions::{SessionMeta, TailState};

fn hooks_status_dir() -> PathBuf {
    crate::owned_state::config_dir().join("hooks-status")
}

fn status_path(session_id: &str) -> PathBuf {
    hooks_status_dir().join(format!("{session_id}.json"))
}

#[derive(Deserialize)]
struct StatusFile {
    event: String,
    at: u64,
    // The head of the tab's `TORI_CALLER`: enough to find the tab, not enough
    // to call the socket as it.
    #[serde(default)]
    caller: String,
}

pub const CALLER_PREFIX: usize = 16;

#[derive(Default)]
pub struct Callers(HashMap<PathBuf, (std::time::SystemTime, Option<(String, u64)>)>);

impl Callers {
    pub fn scan(&mut self) -> Vec<(String, String, u64)> {
        let Ok(entries) = std::fs::read_dir(hooks_status_dir()) else {
            self.0.clear();
            return Vec::new();
        };
        let mut seen = HashMap::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(mtime) = entry.metadata().and_then(|m| m.modified()).ok() else {
                continue;
            };
            let read = match self.0.remove(&path) {
                Some((at, read)) if at == mtime => read,
                _ => std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|t| serde_json::from_str::<StatusFile>(&t).ok())
                    .filter(|f| f.caller.len() == CALLER_PREFIX)
                    .map(|f| (f.caller, f.at)),
            };
            seen.insert(path, (mtime, read));
        }
        self.0 = seen;
        self.0
            .iter()
            .filter_map(|(path, (_, read))| {
                let (caller, at) = read.clone()?;
                let session = path.file_stem()?.to_str()?.to_string();
                Some((session, caller, at))
            })
            .collect()
    }
}

pub fn bound_tabs(fired: &[(String, String, u64)], tab_of: impl Fn(&str) -> Option<String>) -> HashMap<String, String> {
    let mut newest: HashMap<String, (u64, &str)> = HashMap::new();
    for (session, caller, at) in fired {
        let Some(tab) = tab_of(caller) else { continue };
        let slot = newest.entry(tab).or_insert((*at, session));
        if (*at, session.as_str()) > (slot.0, slot.1) {
            *slot = (*at, session);
        }
    }
    newest.into_iter().map(|(tab, (_, s))| (tab, s.to_string())).collect()
}

fn read_status(session_id: &str) -> Option<StatusFile> {
    let text = std::fs::read_to_string(status_path(session_id)).ok()?;
    serde_json::from_str(&text).ok()
}

/// What each wired hook event means for the working/needs-you dot.
/// `Notification` is claude's own "I need you" signal - the ground-truth
/// counterpart to the tail join's "quiet + pending tool_use" guess.
/// `PreToolUse`/`UserPromptSubmit` mean it is actively working; `Stop` means
/// it reached a resting state. Any other/unrecognized event name yields no
/// opinion, so an unexpected payload falls back to the tail join rather than
/// asserting a status it can't back up.
fn tail_state_for_event(event: &str) -> Option<TailState> {
    match event {
        "Notification" => Some(TailState::BlockedCandidate),
        "UserPromptSubmit" | "PreToolUse" => Some(TailState::Working),
        "Stop" => Some(TailState::Done),
        _ => None,
    }
}

/// The hook-reported status for `session_id`, if a status file exists and
/// names a recognized event. `None` means "no hook signal yet" (a session
/// just launched, or an externally-launched claude with no injected hooks) -
/// the caller falls back to the transcript tail join.
pub fn status_for(session_id: &str) -> Option<TailState> {
    tail_state_for_event(&read_status(session_id)?.event)
}

/// Remove a session's hook status file (session delete/archive). Called from
/// the frontend alongside `checkpoint::checkpoint_prune` at the same two call
/// sites; a no-op for a non-claude session (a bare `remove_file` on an id
/// that was never hook-tracked).
#[tauri::command(async)]
pub fn hooks_status_prune(session_id: String) {
    let _ = std::fs::remove_file(status_path(&session_id));
}

/// Sweep leftover status files at app start: a file naming a session that no
/// longer exists, or one whose `at` predates that session's own last
/// transcript activity (the hook stopped being authoritative - a crash, or a
/// resume that dropped the injected `--settings`), is stale and removed so it
/// can't pin a dot at a status that no longer reflects reality. Cheap no-op
/// when the directory doesn't exist yet (never used claude, or a fresh
/// install) - never forces the caller's session-index walk needlessly.
pub fn prune_stale(sessions: impl Fn() -> Vec<SessionMeta>) {
    let dir = hooks_status_dir();
    let entries: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(e) => e.flatten().collect(),
        Err(_) => return,
    };
    if entries.is_empty() {
        return;
    }
    let last_active: HashMap<String, u64> = sessions().into_iter().map(|s| (s.id, s.last_active)).collect();
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let stale = match last_active.get(id) {
            None => true,
            Some(&active) => std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<StatusFile>(&t).ok())
                .map(|f| f.at < active)
                .unwrap_or(true),
        };
        if stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The shell one-liner every injected hook event shares. Reads the JSON
/// payload from stdin, extracts only `session_id`/`hook_event_name` via
/// `grep`/`sed` (never persisting prompt text or tool input to disk), and
/// writes the small status marker. No-ops silently if either field can't be
/// found, or if `session_id` isn't a bare path segment (a defensive guard
/// against a `sid` containing `/` reaching outside `hooks-status/` via the
/// unquoted-path concatenation below - claude's own session ids are UUIDs,
/// so this should never actually trip).
fn status_writer_command() -> String {
    let dir = hooks_status_dir().to_string_lossy().into_owned();
    const CALLER_GLOB: &str = "????????????????";
    format!(
        r#"in=$(cat); sid=$(printf '%s' "$in" | grep -o '"session_id" *: *"[^"]*"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/'); ev=$(printf '%s' "$in" | grep -o '"hook_event_name" *: *"[^"]*"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/'); case "$sid" in */*|"") sid="" ;; esac; cal="${{TORI_CALLER%"${{TORI_CALLER#{CALLER_GLOB}}}"}}"; case "$cal" in *[!0-9a-f]*) cal="" ;; esac; if [ -n "$sid" ] && [ -n "$ev" ]; then mkdir -p '{dir}'; printf '{{"event":"%s","at":%s,"caller":"%s"}}' "$ev" "$(date +%s)" "$cal" > '{dir}/'"$sid"'.json'; fi"#
    )
}

fn hook_entry(command: &str) -> serde_json::Value {
    json!([{ "hooks": [{ "type": "command", "command": command }] }])
}

pub const ENV_SHELL_HOOK: &str = "TORI_SHELL_HOOK";

pub(crate) fn shell_hook_command(exe: &Path) -> String {
    format!(
        "{ENV_SHELL_HOOK}=1 {}",
        crate::chat::approval::sh_quote(&exe.to_string_lossy())
    )
}

fn claude_settings_json(exe: &Path, sandbox: Option<Value>) -> String {
    let cmd = status_writer_command();
    let entry = hook_entry(&cmd);
    let mut settings = json!({
        "permissions": { "allow": crate::rpc::mcp_allow(false) },
        "hooks": {
            "UserPromptSubmit": entry,
            "PreToolUse": [
                { "matcher": "*", "hooks": [{ "type": "command", "command": cmd }] },
                { "matcher": "Bash", "hooks": [{
                    "type": "command",
                    "command": shell_hook_command(exe),
                    "timeout": crate::chat::approval::HOOK_TIMEOUT_SECS,
                }] },
            ],
            "Notification": entry,
            "Stop": entry,
        }
    });
    if let Some(sandbox) = sandbox {
        settings["sandbox"] = sandbox;
    }
    settings.to_string()
}

fn tab_settings_path(tab: &str) -> PathBuf {
    let safe: String = tab
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
        .join("tab-settings")
        .join(format!("{safe}.json"))
}

pub fn forget_tab(tab: &str) {
    let _ = std::fs::remove_file(tab_settings_path(tab));
}

/// The `--settings <path>` value (phase 1's verified non-invasive injection
/// mechanism accepts either inline JSON or a file path). A **file path**, not
/// inline JSON, is load-bearing here: every agent tab's launch command is
/// typed into its login shell one byte at a time (`pty.rs`'s `init`
/// delivery), and macOS PTYs in canonical mode silently truncate a single
/// line beyond the kernel's line-discipline buffer - an inline settings blob
/// (2KB+) got cut mid-string, landing on an unclosed quote and hanging the
/// shell (confirmed live: the typed command appeared but never ran).
/// `--settings-sources user,project,local` stays at claude's default, so
/// this layers *on top of* `~/.claude/settings.json` rather than replacing
/// it - that file is never opened or edited. Failure degrades to no hook args
/// rather than a launch that can't proceed.
///
/// The deny hook carries no token: it reaches Tori with the tab's own
/// `TORI_SOCK` and `TORI_CALLER`, so a file outliving a daemon restart still
/// works in the tab's next shell.
fn write_tab_settings(tab: &str, cwd: &str) -> Result<PathBuf, String> {
    let boxed = tab_boxed(cwd);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = tab_settings_path(tab);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let sandbox = boxed.then(|| crate::unattended::claude_sandbox(cwd));
    std::fs::write(&path, claude_settings_json(&exe, sandbox)).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Extra launch args to append to an agent's args (Tori-launched sessions
/// only, never editing user config): `["--mcp-config", "<path>", "--settings",
/// "<path>"]` for claude, empty for every other adapter (no verified injection mechanism yet, see
/// `AgentAdapter::hooks`) or if the settings file can't be written.
#[tauri::command(async)]
pub fn agent_hook_launch_args(agent_id: String, tab_id: String, cwd: String) -> Vec<String> {
    crate::agents::find(&agent_id)
        .map(|a| launch_args(&a, &tab_id, &cwd))
        .unwrap_or_default()
}

// Tori's MCP server reaches any claude transport, whether or not its adapter
// takes the status hooks.
fn launch_args(adapter: &crate::agents::AgentAdapter, tab: &str, cwd: &str) -> Vec<String> {
    let claude = adapter
        .chat
        .as_ref()
        .is_some_and(|c| c.transport == crate::agents::ChatTransport::ClaudeStreamJson);
    let mut args = if claude {
        crate::rpc::mcp_config_args()
    } else {
        Vec::new()
    };
    if adapter.hooks {
        if let Ok(path) = write_tab_settings(tab, cwd) {
            args.extend(["--settings".to_string(), path.to_string_lossy().into_owned()]);
        }
    }
    if adapter.id == crate::unattended::codex::AGENT && tab_boxed(cwd) {
        let exe = std::env::current_exe().ok();
        args.extend(crate::unattended::codex::boxed_tab_args(exe.as_deref()));
    }
    args
}

fn tab_boxed(cwd: &str) -> bool {
    crate::unattended::tab_boxed(crate::unattended::level_for(cwd))
}

#[tauri::command(async)]
pub fn tab_launch_refusal(agent_id: String, cwd: String, args: Vec<String>) -> Option<String> {
    (agent_id == crate::unattended::codex::AGENT)
        .then(|| crate::unattended::codex::yolo_refusal(&args, tab_boxed(&cwd)))
        .flatten()
}

pub fn is_shell_helper() -> bool {
    std::env::var_os(ENV_SHELL_HOOK).is_some()
}

pub fn run_shell_helper() -> i32 {
    let mut payload = String::new();
    let _ = std::io::stdin().read_to_string(&mut payload);
    if let Some(reason) = shell_check(&payload, || crate::settings::unattended().deny(), ask_tori) {
        let mut stdout = std::io::stdout();
        let _ = stdout.write_all(shell_denial(&reason).as_bytes());
        let _ = stdout.flush();
    }
    0
}

// No marker key, unlike the chat hook's: Codex fails a hook whose output has a
// key it does not know, and a failed hook lets the command run.
fn shell_denial(reason: &str) -> String {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
    })
    .to_string()
}

fn ask_tori(session: &str, command: &str) -> Option<Option<String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let params = json!({ "session": session, "command": command });
    std::thread::spawn(move || {
        let ask = || {
            let endpoint = crate::rpc::client::locate()?;
            let mut client = crate::rpc::client::Client::connect(&endpoint).ok()?;
            let answer = client.call("shell.check", params).ok()?;
            Some(answer["deny"].as_str().map(str::to_string))
        };
        let _ = tx.send(ask());
    });
    rx.recv_timeout(crate::unattended::SHELL_CHECK_TIMEOUT).ok().flatten()
}

fn shell_check(
    payload: &str,
    deny: impl FnOnce() -> Vec<String>,
    ask: impl FnOnce(&str, &str) -> Option<Option<String>>,
) -> Option<String> {
    let parsed: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    if parsed["tool_name"] != "Bash" {
        return None;
    }
    let command = parsed["tool_input"]["command"].as_str().unwrap_or_default();
    let deny = deny();
    let entry = crate::unattended::deny_match(command, &deny)?;
    let session = parsed["session_id"].as_str().unwrap_or_default();
    ask(session, command).unwrap_or_else(|| Some(crate::unattended::unreachable_refusal(entry)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// Serializes every test that touches the shared hooks-status directory.
    ///
    /// `status_for`/`prune` go through the real `dirs::home_dir()`-derived path
    /// (no env-var override in this codebase's convention), so these tests all
    /// share **one** real directory. `prune_stale_is_a_noop_...` empties it
    /// outright, which raced the tests that write a file and read it back:
    /// either the wipe landed between another test's write and its read (that
    /// test saw `None`), or a write landed between the wipe and the noop
    /// assertion (the closure ran, and `assert!(!called)` failed). Both were
    /// observed intermittently, roughly one full-suite run in five.
    ///
    /// Poisoning is recovered from rather than propagated: one failing test
    /// should report its own assertion, not turn every sibling into a panic.
    static DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_dir() -> std::sync::MutexGuard<'static, ()> {
        DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write_status(session_id: &str, event: &str, at: u64) {
        std::fs::create_dir_all(hooks_status_dir()).unwrap();
        std::fs::write(status_path(session_id), json!({ "event": event, "at": at }).to_string()).unwrap();
    }

    #[test]
    fn a_clear_in_one_claude_tab_moves_that_tab_alone_to_its_new_session() {
        use crate::rpc::auth::{Caller, Children};
        use std::io::Write;
        let _guard = lock_dir();
        let children = Children::default();
        let a = children.mint(Caller::Terminal("tab-a".into()));
        let b = children.mint(Caller::Terminal("tab-b".into()));
        let session = format!("test-clear-{}-{}", std::process::id(), now_secs());
        let payload = json!({ "session_id": session, "hook_event_name": "UserPromptSubmit" }).to_string();
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &status_writer_command()])
            .env(crate::rpc::ENV_CALLER, &a)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        let written = Callers::default().scan().into_iter().find(|(s, _, _)| *s == session);
        let _ = std::fs::remove_file(status_path(&session));
        let (_, head, _) = written.expect("the hook wrote the tab's caller");
        assert_eq!(head, a[..CALLER_PREFIX]);

        let fired = |session: &str, token: &str, at: u64| (session.to_string(), token[..CALLER_PREFIX].to_string(), at);
        let bound = bound_tabs(
            &[fired("old-a", &a, 10), fired("old-b", &b, 10), fired("new-a", &a, 11)],
            |head| children.tab_of(head),
        );
        assert_eq!(bound.get("tab-a").map(String::as_str), Some("new-a"));
        assert_eq!(bound.get("tab-b").map(String::as_str), Some("old-b"));
        assert_eq!(bound.len(), 2);
    }

    #[test]
    fn status_for_maps_known_events() {
        let _guard = lock_dir();
        let id = format!("test-status-{}", now_secs());
        write_status(&id, "Notification", now_secs());
        assert_eq!(status_for(&id), Some(TailState::BlockedCandidate));
        write_status(&id, "PreToolUse", now_secs());
        assert_eq!(status_for(&id), Some(TailState::Working));
        write_status(&id, "UserPromptSubmit", now_secs());
        assert_eq!(status_for(&id), Some(TailState::Working));
        write_status(&id, "Stop", now_secs());
        assert_eq!(status_for(&id), Some(TailState::Done));
        hooks_status_prune(id.clone());
    }

    #[test]
    fn status_for_unrecognized_event_falls_back() {
        let _guard = lock_dir();
        let id = format!("test-status-unknown-{}", now_secs());
        write_status(&id, "SessionStart", now_secs());
        assert_eq!(status_for(&id), None);
        hooks_status_prune(id.clone());
    }

    #[test]
    fn status_for_missing_file_is_none() {
        let _guard = lock_dir();
        assert_eq!(status_for("no-such-session-ever"), None);
    }

    #[test]
    fn prune_removes_the_file() {
        let _guard = lock_dir();
        let id = format!("test-prune-{}", now_secs());
        write_status(&id, "Stop", now_secs());
        assert!(status_path(&id).exists());
        hooks_status_prune(id.clone());
        assert!(!status_path(&id).exists());
    }

    #[test]
    fn prune_stale_removes_files_for_gone_or_outdated_sessions() {
        let _guard = lock_dir();
        let gone = format!("test-stale-gone-{}", now_secs());
        let outdated = format!("test-stale-outdated-{}", now_secs());
        let fresh = format!("test-stale-fresh-{}", now_secs());
        write_status(&gone, "Working", now_secs());
        write_status(&outdated, "Working", 100);
        write_status(&fresh, "Working", now_secs() + 10_000);

        let sessions = vec![
            SessionMeta {
                id: outdated.clone(),
                path: String::new(),
                cwd: String::new(),
                branch: String::new(),
                title: String::new(),
                last_active: 500, // newer than the outdated file's `at`
                created_at: 0,
                name: None,
                agent: "claude".to_string(),
                profile: None,
                profile_label: None,
            },
            SessionMeta {
                id: fresh.clone(),
                path: String::new(),
                cwd: String::new(),
                branch: String::new(),
                title: String::new(),
                last_active: 1, // older than the fresh file's `at`
                created_at: 0,
                name: None,
                agent: "claude".to_string(),
                profile: None,
                profile_label: None,
            },
        ];
        prune_stale(|| sessions.clone());

        assert!(
            !status_path(&gone).exists(),
            "a status file for a session that no longer exists is stale"
        );
        assert!(
            !status_path(&outdated).exists(),
            "a status file older than its session's last activity is stale"
        );
        assert!(
            status_path(&fresh).exists(),
            "a status file newer than its session's last activity is kept"
        );
        hooks_status_prune(fresh.clone());
    }

    #[test]
    fn prune_stale_is_a_noop_when_the_directory_is_empty() {
        let _guard = lock_dir();
        // No panic/side effect when hooks-status has never been created or
        // has nothing in it - must not force the sessions() closure to run.
        let dir = hooks_status_dir();
        std::fs::create_dir_all(&dir).unwrap();
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
        let called = std::sync::atomic::AtomicBool::new(false);
        prune_stale(|| {
            called.store(true, std::sync::atomic::Ordering::SeqCst);
            Vec::new()
        });
        // Directory exists but is empty: the sessions() closure is skipped.
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    }

    fn launch(agent: &str, tab: &str) -> Vec<String> {
        agent_hook_launch_args(agent.to_string(), tab.to_string(), "/nowhere".to_string())
    }

    #[test]
    fn non_claude_agent_gets_no_extra_args() {
        assert!(launch("unknown-agent", "t").is_empty());
    }

    #[test]
    fn two_claude_tabs_get_two_settings_files_each_with_the_status_and_deny_hooks() {
        let tabs = [
            format!("tab-a-{}", std::process::id()),
            format!("tab-b-{}", std::process::id()),
        ];
        let files: Vec<String> = tabs
            .iter()
            .map(|tab| {
                let args = launch("claude", tab);
                assert_eq!(
                    (args[0].as_str(), args[2].as_str()),
                    ("--mcp-config", "--settings"),
                    "{args:?}"
                );
                args[3].clone()
            })
            .collect();
        assert_ne!(files[0], files[1]);
        for file in &files {
            // Load-bearing: a *path*, not inline JSON - see write_tab_settings's
            // doc comment for why an inline blob hangs the shell it's typed into.
            assert!(
                !file.trim_start().starts_with('{'),
                "must be a file path, not inline JSON"
            );
            let parsed: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
            assert_eq!(parsed["permissions"], json!({ "allow": crate::rpc::mcp_allow(false) }));
            for event in ["Notification", "UserPromptSubmit", "Stop"] {
                assert_eq!(
                    parsed["hooks"][event][0]["hooks"][0]["command"],
                    status_writer_command()
                );
            }
            let pre = &parsed["hooks"]["PreToolUse"];
            assert_eq!(pre[0]["matcher"], "*");
            assert_eq!(pre[1]["matcher"], "Bash");
            let deny = pre[1]["hooks"][0]["command"].as_str().unwrap();
            assert!(deny.starts_with(&format!("{ENV_SHELL_HOOK}=1 ")), "{deny}");
            assert!(
                parsed.get("sandbox").is_none(),
                "an attended tab under the default level is not boxed"
            );
        }
        for tab in &tabs {
            forget_tab(tab);
        }
        assert!(
            files.iter().all(|f| !Path::new(f).exists()),
            "a closed tab leaves no file"
        );
    }

    #[test]
    fn a_boxed_tab_carries_the_sandbox() {
        let sandbox = json!({ "enabled": true });
        let parsed: Value =
            serde_json::from_str(&claude_settings_json(Path::new("/bin/tori"), Some(sandbox.clone()))).unwrap();
        assert_eq!(parsed["sandbox"], sandbox);
    }

    #[test]
    fn the_tab_hook_asks_tori_only_for_a_listed_command_and_refuses_when_it_cannot() {
        let deny = || vec!["aws".to_string()];
        let bash = |command: &str| {
            json!({ "session_id": "s1", "tool_name": "Bash", "tool_input": { "command": command } }).to_string()
        };
        let never = |_: &str, _: &str| -> Option<Option<String>> { panic!("an unlisted command asked Tori") };
        assert_eq!(shell_check(&bash("ls"), deny, never), None);

        let asked = shell_check(&bash("aws s3 ls"), deny, |session, command| {
            assert_eq!((session, command), ("s1", "aws s3 ls"));
            Some(Some("nobody is watching".to_string()))
        });
        assert_eq!(asked.as_deref(), Some("nobody is watching"));
        assert_eq!(
            shell_check(&bash("aws s3 ls"), deny, |_, _| Some(None)),
            None,
            "attended"
        );

        let unreachable = shell_check(&bash("aws s3 ls"), deny, |_, _| None).expect("fails closed");
        assert!(unreachable.contains("could not be reached"), "{unreachable}");
    }

    #[test]
    fn an_attended_codex_tab_under_the_default_level_keeps_hook_trust() {
        let args = launch("codex", "tab-codex");
        assert!(!args.iter().any(|a| a == "--dangerously-bypass-hook-trust"), "{args:?}");
        assert!(!args.iter().any(|a| a == "--sandbox"), "{args:?}");
    }

    #[test]
    fn an_adapter_with_hooks_but_no_claude_transport_gets_no_mcp_config() {
        let mut adapter = crate::agents::find("claude").unwrap().clone();
        adapter.chat.as_mut().unwrap().transport = crate::agents::ChatTransport::Acp;
        let args = launch_args(&adapter, &format!("tab-acp-{}", std::process::id()), "/nowhere");
        assert_eq!(args[0], "--settings", "{args:?}");
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        forget_tab(&format!("tab-acp-{}", std::process::id()));
    }
}
