pub mod attach;
pub mod host;
pub mod wire;

use std::collections::HashMap;
use std::io::BufReader;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use wire::{Listed, Spawn, DATA, EXIT, RESIZE};

#[derive(Debug, Default, Clone, PartialEq)]
struct Tab {
    agent: Option<String>,
    profile: Option<String>,
    cwd: String,
    busy: bool,
    claimed_session: Option<String>,
}

// Output the surface has not drawn yet. Past this the stream is left unread,
// so the daemon, and then the program, wait for xterm.
const UNACKED_MAX: usize = 1024 * 1024;
// A surface that stops acking slows its tab rather than freezing it.
const ACK_WAIT: Duration = Duration::from_secs(1);

struct Attached {
    // Unbounded, so a keystroke or a paste never waits on the IPC thread.
    input: Sender<(u8, Vec<u8>)>,
    stream: UnixStream,
    // Set when a newer surface took the tab over, so this end is not read as the daemon going.
    replaced: AtomicBool,
    unacked: Mutex<usize>,
    drawn: Condvar,
    // No surface will ack again: a kill or a replacement.
    released: AtomicBool,
}

impl Attached {
    fn replace(&self) {
        self.replaced.store(true, Ordering::SeqCst);
        self.release();
        let _ = self.stream.shutdown(Shutdown::Both);
    }

    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.drawn.notify_all();
    }

    fn unacked(&self) -> MutexGuard<'_, usize> {
        self.unacked.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn sent(&self, bytes: usize) {
        *self.unacked() += bytes;
    }

    fn ack(&self, bytes: usize) {
        let mut unacked = self.unacked();
        *unacked = unacked.saturating_sub(bytes);
        self.drawn.notify_all();
    }

    fn wait_for_room(&self) {
        let mut unacked = self.unacked();
        while *unacked > UNACKED_MAX && !self.released.load(Ordering::SeqCst) {
            let (guard, waited) = self
                .drawn
                .wait_timeout(unacked, ACK_WAIT)
                .unwrap_or_else(|e| e.into_inner());
            unacked = guard;
            if waited.timed_out() {
                break;
            }
        }
    }
}

#[derive(Default)]
pub struct PtyState {
    tabs: Mutex<HashMap<String, Tab>>,
    attached: Mutex<HashMap<String, Arc<Attached>>>,
}

impl PtyState {
    fn tabs(&self) -> MutexGuard<'_, HashMap<String, Tab>> {
        self.tabs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn attached(&self) -> MutexGuard<'_, HashMap<String, Arc<Attached>>> {
        self.attached.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Every live tab id, sorted. Keyed by **frontend tab id**, unlike
    /// `ChatHost::live_ids`, which answers in session ids.
    pub fn live_ids(&self) -> Result<Vec<String>, String> {
        let mut ids: Vec<String> = self.tabs().keys().cloned().collect();
        ids.sort();
        Ok(ids)
    }

    /// Tab ids of every live agent tab running one `(agent, profile)` pair.
    ///
    /// The second table the removal guard asks, and it cannot be replaced by the
    /// claim registry: a **fresh** agent tab holds no claim until its session id
    /// exists (see `pty_spawn`), so a guard built on claims alone would delete
    /// the home of an account with an agent running in it.
    pub fn live_agent_tabs(&self, agent: &str, profile: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .tabs()
            .iter()
            .filter(|(_, t)| {
                t.agent.as_deref() == Some(agent)
                    && t.profile.as_deref().unwrap_or(crate::accounts::DEFAULT_PROFILE_ID) == profile
            })
            .map(|(id, _)| id.clone())
            .collect();
        // A `HashMap` has no order, and a message naming tabs must not shuffle
        // between two readings of the same state.
        ids.sort();
        ids
    }

    /// What a live tab runs: its agent and account when it is an agent tab, and
    /// the folder it was opened in.
    pub fn identity(&self, tab: &str) -> Option<crate::rpc::methods::Identity> {
        let tabs = self.tabs();
        let t = tabs.get(tab)?;
        Some(crate::rpc::methods::Identity {
            account: t.agent.as_ref().map(|_| {
                t.profile
                    .clone()
                    .unwrap_or_else(|| crate::accounts::DEFAULT_PROFILE_ID.to_string())
            }),
            agent: t.agent.clone(),
            cwd: Some(t.cwd.clone()).filter(|cwd| !cwd.is_empty()),
        })
    }

    fn replace(&self, listed: Vec<Listed>) {
        let attached: Vec<String> = self.attached().keys().cloned().collect();
        let mut tabs = self.tabs();
        let mut next = HashMap::new();
        // Spawned after the list was taken: its stream ends if the daemon lost it.
        for tab in attached {
            if let Some(kept) = tabs.remove(&tab) {
                next.insert(tab, kept);
            }
        }
        for l in listed {
            let claimed_session = tabs.remove(&l.tab).and_then(|t| t.claimed_session);
            next.insert(
                l.tab,
                Tab {
                    agent: l.agent,
                    profile: l.profile,
                    cwd: l.cwd,
                    busy: l.busy,
                    claimed_session,
                },
            );
        }
        *tabs = next;
    }

    fn detach(&self, tab: &str, attached: &Arc<Attached>) {
        let mut all = self.attached();
        if all.get(tab).is_some_and(|a| Arc::ptr_eq(a, attached)) {
            all.remove(tab);
        }
    }
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: Option<u32>,
}

pub fn heard(app: &AppHandle, event: &str, payload: &Value) {
    let state = app.state::<PtyState>();
    let id = payload["id"].as_str().unwrap_or_default();
    match event {
        // An attached tab hears its exit on the stream, after its last bytes.
        "pty://exit" if state.attached().contains_key(id) || !state.tabs().contains_key(id) => return,
        "pty://activity" => {}
        "pty://busy" => {
            if let Some(tab) = state.tabs().get_mut(id) {
                tab.busy = payload["busy"].as_bool().unwrap_or_default();
            }
        }
        "pty://init-refused" => {}
        _ => return,
    }
    let _ = app.emit(event, payload);
}

// The daemon may have been running before this window, or restarted under it.
pub fn resync(app: &AppHandle) {
    let Ok(listed) = crate::rpc::daemon_request("pty.list", json!({})) else {
        return;
    };
    if let Ok(listed) = serde_json::from_value::<Vec<Listed>>(listed) {
        app.state::<PtyState>().replace(listed);
    }
}

fn read_attached(
    app: AppHandle,
    tab: String,
    mut reader: BufReader<UnixStream>,
    sink: Channel<InvokeResponseBody>,
    attached: Arc<Attached>,
) {
    let mut ended = false;
    loop {
        attached.wait_for_room();
        let Ok(Some((kind, payload))) = wire::read_frame(&mut reader) else {
            break;
        };
        match kind {
            DATA => {
                attached.sent(payload.len());
                let _ = sink.send(InvokeResponseBody::Raw(payload));
            }
            EXIT => {
                ended = true;
                let code = wire::parse_exit(&payload);
                let _ = app.emit("pty://exit", ExitEvent { id: tab.clone(), code });
            }
            _ => {}
        }
    }
    if !ended && !attached.replaced.load(Ordering::SeqCst) {
        // The daemon went, and its shells with it.
        let state = app.state::<PtyState>();
        state.tabs().remove(&tab);
        state.detach(&tab, &attached);
        let _ = app.emit("pty://exit", ExitEvent { id: tab, code: None });
    }
}

fn attach(
    app: &AppHandle,
    tab: &str,
    sink: Channel<InvokeResponseBody>,
    cols: u16,
    rows: u16,
) -> Result<Arc<Attached>, String> {
    let (stream, reader) = crate::rpc::attach_pty(tab, cols, rows)?;
    let (input, queued) = channel::<(u8, Vec<u8>)>();
    let mut out = stream.try_clone().map_err(|e| e.to_string())?;
    thread::spawn(move || {
        for (kind, payload) in queued {
            if wire::write_frame(&mut out, kind, &payload).is_err() {
                break;
            }
        }
    });
    let attached = Arc::new(Attached {
        input,
        stream,
        replaced: AtomicBool::new(false),
        unacked: Mutex::new(0),
        drawn: Condvar::new(),
        released: AtomicBool::new(false),
    });
    let (app, tab, reading) = (app.clone(), tab.to_string(), attached.clone());
    thread::spawn(move || read_attached(app, tab, reader, sink, reading));
    Ok(attached)
}

/// The result of asking to open a PTY tab.
///
/// `ownership` is `None` for every tab that never took a claim - a shell tab, a
/// command tab, a fresh agent tab whose session id does not exist yet, and a
/// remount of a tab we already hold - and `Some(refusal)` when the claim was
/// declined and nothing was spawned. A granted claim also reports `None`: there
/// is nothing for the caller to do about it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResult {
    pub ownership: Option<crate::chat::ownership::ClaimOutcome>,
}

// Sync like the rest of the pty family: the IPC thread is what serializes a
// remount's re-subscribe against a concurrent spawn of the same id.
#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "a Tauri command: the arguments are the fields of the IPC payload"
)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    // "shell" | "agent" | "command" | "task". A command tab is `program args`
    // itself; every other kind is a login shell, and an agent/task is seeded
    // through `init`.
    kind: String,
    // Agent/task tabs: the command line to type into the shell once, after it is
    // ready (e.g. "claude --resume <id>\n"). Delivered backend-once. Ignored
    // for a command tab, which has no shell to type into.
    init: Option<String>,
    // Quiet threshold (ms) for this session's pty://activity transitions; an
    // agent tab passes its adapter's own `pty_quiet_ms`, a shell/command tab
    // omits it and gets the host's default.
    quiet_ms: Option<u64>,
    // Extra environment for this tab's process, on top of whatever it inherits.
    // Empty for every ordinary tab; a sign-in tab carries the profile's home
    // variable, which is the whole mechanism of signing in to a second account:
    // the agent writes its credentials wherever this points, so a login tab
    // spawned without it would sign the user in to the account they already had.
    env: Option<Vec<(String, String)>>,
    // The agent session this tab is resuming, and which adapter it belongs to.
    // Both `None` for a shell/command tab, and for a *fresh* agent tab: its
    // session id does not exist until the agent writes a transcript, so there is
    // nothing to claim and nothing that could conflict. A resume is the case
    // that can corrupt, and it is the case that carries these.
    session_id: Option<String>,
    agent_id: Option<String>,
    // Which account of `agent_id` this tab runs as, `None` for the default
    // profile. Recorded rather than acted on: the env that makes it true was
    // resolved by the caller and arrives above.
    profile: Option<String>,
    on_output: Channel<InvokeResponseBody>,
    chat: State<crate::chat::host::ChatState>,
) -> Result<PtySpawnResult, String> {
    // A remount after a webview reload: the old surface is gone with its xterm.
    let previous = state.attached().remove(&id);
    if let Some(previous) = previous {
        previous.replace();
        let attached = attach(&app, &id, on_output, cols, rows)?;
        state.attached().insert(id, attached);
        return Ok(PtySpawnResult { ownership: None });
    }
    // Running in the daemon already: this window was relaunched, or reloaded.
    let adopted = state.tabs().contains_key(&id);

    // Ownership, enforced here rather than by a separate command a caller could
    // forget: an agent session driven by two processes at once appends both
    // sides of a diverging conversation to one transcript, measured, with no
    // lock and no error from the CLI. Deliberately *after* the re-subscribe
    // return above, so a tab remount is not mistaken for a second opener.
    let mut claimed_session = None;
    if let (Some(session_id), Some(agent_id)) = (&session_id, &agent_id) {
        use crate::chat::ownership::{Claim, ClaimOutcome, Surface};
        let outcome = chat.0.registry.claim(
            session_id,
            Claim {
                surface: Surface::PtyAgent,
                tab_id: id.clone(),
                agent: agent_id.clone(),
                profile: profile
                    .clone()
                    .unwrap_or_else(|| crate::accounts::DEFAULT_PROFILE_ID.to_string()),
                // A PTY agent tab's child is a login shell, not the agent, so
                // its pid would never match the adapter's running pattern.
                // Recording it would make the orphan check answer "gone" for a
                // session that is in fact running.
                child_pid: None,
                tori_pid: std::process::id(),
            },
        );
        match outcome {
            ClaimOutcome::Granted { .. } => claimed_session = Some(session_id.clone()),
            // Its agent is the one the registry sees running: this tab's own.
            _ if adopted => {}
            // A refusal is a value, not an error string, exactly as `chat_spawn`
            // reports one: the frontend can only offer "go to the tab holding
            // it" or "end the leftover process" if it is told which tab and
            // which pid, and it cannot parse either back out of a message.
            // Nothing is spawned either way, so the corruption stays blocked.
            refused => {
                return Ok(PtySpawnResult {
                    ownership: Some(refused),
                })
            }
        }
    }

    if !adopted {
        let is_command = kind == "command";
        let spawn = Spawn {
            tab: id.clone(),
            program,
            args,
            cwd: cwd.clone(),
            cols,
            rows,
            kind: kind.clone(),
            init,
            quiet_ms,
            env: crate::credential::spawn_env()
                .into_iter()
                .chain(env.into_iter().flatten())
                .collect(),
            agent: agent_id.clone(),
            profile: profile.clone(),
        };
        if let Err(e) = crate::rpc::daemon_request("pty.spawn", json!(spawn)) {
            if let Some(session_id) = &claimed_session {
                chat.0.registry.release(session_id, &id);
            }
            if is_command {
                // A command that never started has still ended, and `pty://exit`
                // is the only place its verdict is read; 127 is what a shell reports.
                let _ = app.emit(
                    "pty://exit",
                    ExitEvent {
                        id: id.clone(),
                        code: Some(127),
                    },
                );
            }
            return Err(e);
        }
    }
    // Attached before it is in the copy, so a resync running now keeps it.
    let attached = attach(&app, &id, on_output, cols, rows);
    if let Ok(attached) = &attached {
        state.attached().insert(id.clone(), attached.clone());
    }
    {
        let mut tabs = state.tabs();
        let tab = tabs.entry(id).or_insert_with(|| Tab {
            agent: agent_id,
            profile,
            cwd,
            busy: kind == "task",
            claimed_session: None,
        });
        if claimed_session.is_some() {
            tab.claimed_session = claimed_session;
        }
    }
    attached.map(|_| PtySpawnResult { ownership: None })
}

/// Sync by design, and it must stay that way: keystrokes are fire-and-forget,
/// so their byte order is exactly IPC arrival order run inline.
#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let attached = state.attached().get(&id).cloned();
    match attached {
        Some(a) => {
            let _ = a.input.send((DATA, data.into_bytes()));
        }
        None => crate::rpc::daemon_tell("pty.write", json!({ "tab": id, "data": data })),
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let attached = state.attached().get(&id).cloned();
    match attached {
        Some(a) => {
            let _ = a.input.send((RESIZE, wire::resize(cols, rows)));
        }
        None => crate::rpc::daemon_tell("pty.resize", json!({ "tab": id, "cols": cols, "rows": rows })),
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, chat: State<crate::chat::host::ChatState>, id: String) -> Result<(), String> {
    if let Some(attached) = state.attached().remove(&id) {
        attached.release();
    }
    if let Some(tab) = state.tabs().remove(&id) {
        // Give the session id back, or closing an agent tab would leave it
        // permanently unopenable until Tori restarts.
        if let Some(session_id) = tab.claimed_session {
            let (registry, tab) = (chat.0.registry.clone(), id.clone());
            thread::spawn(move || registry.release(&session_id, &tab));
        }
    }
    crate::rpc::daemon_tell("pty.kill", json!({ "tab": id }));
    Ok(())
}

/// Output the surface has drawn, so its stream is read again past `UNACKED_MAX`.
#[tauri::command]
pub fn pty_ack(state: State<PtyState>, id: String, bytes: usize) {
    let attached = state.attached().get(&id).cloned();
    if let Some(attached) = attached {
        attached.ack(bytes);
    }
}

/// Every PTY tab the daemon still holds, by **frontend tab id**, sorted.
///
/// The counterpart to `chat_live_sessions`, which answers in session ids. A
/// relaunch loses the tabs but not the shells, so a restore matches its stored
/// tab ids against this to know which ones only need attaching.
// Asks the daemon: a restore can run before this window's resync.
#[tauri::command(async)]
pub fn pty_live_ids(app: AppHandle, state: State<PtyState>) -> Result<Vec<String>, String> {
    resync(&app);
    state.live_ids()
}

/// Task tabs whose command still holds the terminal, by **frontend tab id**,
/// sorted. `pty://busy` carries every change after this.
#[tauri::command]
pub fn pty_busy_ids(state: State<PtyState>) -> Result<Vec<String>, String> {
    let mut ids: Vec<String> = state
        .tabs()
        .iter()
        .filter(|(_, t)| t.busy)
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(agent: Option<&str>, profile: Option<&str>, cwd: &str) -> Tab {
        Tab {
            agent: agent.map(str::to_string),
            profile: profile.map(str::to_string),
            cwd: cwd.into(),
            ..Tab::default()
        }
    }

    fn holding(tabs: Vec<(&str, Tab)>) -> PtyState {
        let state = PtyState::default();
        state.tabs().extend(tabs.into_iter().map(|(id, t)| (id.to_string(), t)));
        state
    }

    /// The listing a restore matches terminal tabs against answers in **tab
    /// ids**, never the session id a tab happens to have claimed. Chat answers
    /// the other half in session ids (`ChatHost::live_ids`), so the two sets
    /// stay disjoint and a restore can match each surface by its own key.
    #[test]
    fn live_ids_are_tab_ids_not_the_sessions_those_tabs_claimed() {
        let state = holding(vec![
            ("tab-shell", Tab::default()),
            (
                "tab-agent",
                Tab {
                    claimed_session: Some("s-claimed".into()),
                    ..Tab::default()
                },
            ),
        ]);
        let ids = state.live_ids().unwrap();
        assert_eq!(ids, vec!["tab-agent", "tab-shell"], "sorted tab ids");
        assert!(
            !ids.iter().any(|id| id == "s-claimed"),
            "a claimed session id must not appear in the tab listing"
        );
    }

    /// The removal guard's second table. A **fresh** agent tab holds no claim
    /// until its session id exists, so this listing is the only thing that can
    /// stop an account's home being deleted out from under one.
    #[test]
    fn a_tab_identity_is_its_folder_and_for_an_agent_tab_its_account() {
        use crate::rpc::methods::Identity;
        let state = holding(vec![
            ("shell", tab(None, None, "/p")),
            ("agent", tab(Some("claude"), None, "/p/wt")),
        ]);
        assert_eq!(
            state.identity("shell"),
            Some(Identity {
                agent: None,
                account: None,
                cwd: Some("/p".into())
            })
        );
        assert_eq!(
            state.identity("agent"),
            Some(Identity {
                agent: Some("claude".into()),
                account: Some(crate::accounts::DEFAULT_PROFILE_ID.into()),
                cwd: Some("/p/wt".into()),
            })
        );
        assert_eq!(state.identity("closed"), None);
    }

    #[test]
    fn live_agent_tabs_names_only_the_agent_and_account_asked_about() {
        let state = holding(vec![
            // A fresh globex agent tab: no claimed session, and the case this
            // whole accessor exists for.
            ("tab-fresh-globex", tab(Some("claude"), Some("globex"), "")),
            (
                "tab-resumed-globex",
                Tab {
                    claimed_session: Some("s-1".into()),
                    ..tab(Some("claude"), Some("globex"), "")
                },
            ),
            ("tab-default", tab(Some("claude"), None, "")),
            ("tab-other-agent", tab(Some("codex"), Some("globex"), "")),
            ("tab-shell", Tab::default()),
        ]);

        let globex = state.live_agent_tabs("claude", "globex");
        let default = state.live_agent_tabs("claude", "default");

        assert_eq!(globex, vec!["tab-fresh-globex", "tab-resumed-globex"]);
        // A tab that recorded no profile ran on the login the user already had.
        assert_eq!(default, vec!["tab-default"]);
        // Another agent's tab is not this account's, and a bare shell runs no
        // agent at all, so neither can block a removal.
        assert!(!globex.iter().any(|id| id == "tab-other-agent" || id == "tab-shell"));
    }
}
