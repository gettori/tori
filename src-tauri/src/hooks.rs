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
// byte-identical); this is Sway-launched-only - an externally-launched
// `claude` never sees the flag, so it never sees the hooks either. The value
// is a **file path** (`~/.config/sway/claude-hooks-settings.json`), not
// inline JSON - see `write_claude_settings_file`'s doc comment for why an
// inline blob broke every claude launch (the command is typed into the
// tab's login shell, and a PTY in canonical mode truncates a single long
// line).
//
// The injected hook command never writes prompt text or tool input to disk:
// it greps only `session_id`/`hook_event_name` out of the raw JSON payload
// on stdin (POSIX `grep`/`sed`/`printf` only, no jq/node/python dependency)
// and writes a small `{event, at}` marker to
// `~/.config/sway/hooks-status/<session id>.json` - same directory
// convention as `checkpoint.rs`'s `~/.config/sway/checkpoint-index/<id>`.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::json;

use crate::sessions::{SessionMeta, TailState};

fn hooks_status_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/hooks-status")
}

fn status_path(session_id: &str) -> PathBuf {
    hooks_status_dir().join(format!("{session_id}.json"))
}

#[derive(Deserialize)]
struct StatusFile {
    event: String,
    at: u64,
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
#[tauri::command]
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
    let last_active: HashMap<String, u64> =
        sessions().into_iter().map(|s| (s.id, s.last_active)).collect();
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let stale = match last_active.get(id) {
            None => true,
            Some(&active) => {
                std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|t| serde_json::from_str::<StatusFile>(&t).ok())
                    .map(|f| f.at < active)
                    .unwrap_or(true)
            }
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
    format!(
        r#"in=$(cat); sid=$(printf '%s' "$in" | grep -o '"session_id" *: *"[^"]*"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/'); ev=$(printf '%s' "$in" | grep -o '"hook_event_name" *: *"[^"]*"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/'); case "$sid" in */*|"") sid="" ;; esac; if [ -n "$sid" ] && [ -n "$ev" ]; then mkdir -p '{dir}'; printf '{{"event":"%s","at":%s}}' "$ev" "$(date +%s)" > '{dir}/'"$sid"'.json'; fi"#
    )
}

fn hook_entry(command: &str) -> serde_json::Value {
    json!([{ "hooks": [{ "type": "command", "command": command }] }])
}

fn claude_settings_json() -> String {
    let cmd = status_writer_command();
    let entry = hook_entry(&cmd);
    let settings = json!({
        "hooks": {
            "UserPromptSubmit": entry,
            "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": cmd }] }],
            "Notification": entry,
            "Stop": entry,
        }
    });
    settings.to_string()
}

fn claude_settings_file_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/claude-hooks-settings.json")
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
/// it - that file is never opened or edited. Content is static across
/// launches, so writing it is cheap and idempotent; failure degrades to no
/// hook args rather than a launch that can't proceed.
fn write_claude_settings_file() -> Result<PathBuf, String> {
    let path = claude_settings_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, claude_settings_json()).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Extra launch args to append to an agent's args (Sway-launched sessions
/// only, never editing user config): `["--settings", "<path>"]` for claude,
/// empty for every other adapter (no verified injection mechanism yet, see
/// `AgentAdapter::hooks`) or if the settings file can't be written.
#[tauri::command]
pub fn agent_hook_launch_args(agent_id: String) -> Vec<String> {
    if !crate::agents::find(&agent_id).map(|a| a.hooks).unwrap_or(false) {
        return Vec::new();
    }
    match write_claude_settings_file() {
        Ok(path) => vec!["--settings".to_string(), path.to_string_lossy().into_owned()],
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now_secs() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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

        assert!(!status_path(&gone).exists(), "a status file for a session that no longer exists is stale");
        assert!(!status_path(&outdated).exists(), "a status file older than its session's last activity is stale");
        assert!(status_path(&fresh).exists(), "a status file newer than its session's last activity is kept");
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

    #[test]
    fn non_claude_agent_gets_no_extra_args() {
        assert!(agent_hook_launch_args("unknown-agent".to_string()).is_empty());
    }

    #[test]
    fn claude_gets_settings_flag_pointing_at_a_short_file_path() {
        let args = agent_hook_launch_args("claude".to_string());
        assert_eq!(args[0], "--settings");
        // Load-bearing: a *path*, not inline JSON - see write_claude_settings_file's
        // doc comment for why an inline blob hangs the shell it's typed into.
        assert!(!args[1].trim_start().starts_with('{'), "must be a file path, not inline JSON");
        let text = std::fs::read_to_string(&args[1]).expect("the settings file should exist");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
        assert!(parsed["hooks"]["Notification"].is_array());
        assert!(parsed["hooks"]["UserPromptSubmit"].is_array());
        assert!(parsed["hooks"]["PreToolUse"].is_array());
        assert!(parsed["hooks"]["Stop"].is_array());
    }
}
