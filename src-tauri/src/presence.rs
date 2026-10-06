// A needs-you notification is sent from here rather than the notification
// plugin, whose desktop send never reports a click: a click has to land on the
// session that needed you.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::menu::{IsMenuItem, Menu, MenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Emitter, Manager};

use crate::rpc::dots::Dot;

// A click wait polls the whole delivered list on the main run loop every 0.5s
// until its notification is clicked or gone, and an answer from the phone does
// neither, so a session that stops needing you takes its notification down.
#[cfg(target_os = "macos")]
static NEEDS_YOU_NOTES: Mutex<Option<HashMap<String, [u8; 16]>>> = Mutex::new(None);

pub struct TrayState(pub Mutex<TrayIcon>);

/// One session a tab or a chat hosts, as the surfaces list it.
#[derive(Debug, Clone, PartialEq)]
pub struct Live {
    pub id: String,
    pub dot: Dot,
    pub name: String,
    pub project: String,
    pub folder: String,
    pub chat: bool,
    pub visible: bool,
    pub spawner: Option<String>,
    pub done_at: u64,
}

/// The sessions that crossed into a state on one tick.
#[derive(Debug, Default, PartialEq)]
pub struct Edges {
    pub rose: Vec<String>,
    pub finished: Vec<String>,
    pub cleared: Vec<String>,
}

/// What one tick's edges come to under the user's switches: the sessions to
/// send a notification for, and whether each state's sound plays.
#[derive(Debug, Default, PartialEq)]
pub struct Alerts {
    pub needs_you: Vec<String>,
    pub finished: Vec<String>,
    pub needs_you_sound: bool,
    pub finished_sound: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrayEntry {
    pub id: String,
    pub label: String,
}

pub struct Presence {
    attended: HashMap<String, bool>,
    last: HashMap<String, Dot>,
    announced: HashMap<String, u64>,
    worked: HashSet<String>,
    selected: Option<String>,
    focused: bool,
    tray: Option<(String, Vec<TrayEntry>)>,
    badge: Option<usize>,
}

impl Default for Presence {
    fn default() -> Self {
        Self {
            attended: HashMap::new(),
            last: HashMap::new(),
            announced: HashMap::new(),
            worked: HashSet::new(),
            selected: None,
            focused: true,
            tray: None,
            badge: None,
        }
    }
}

impl Presence {
    /// Fold one tick of dots in. Returns the sessions that just crossed into
    /// needs-you: the rising edge, so one still blocked from the last tick does
    /// not fire again, and one that moved in between does. And the chats whose
    /// turn just finished: idle after working, on a completion not yet
    /// announced. Going idle and the completion can arrive a tick apart. And
    /// the sessions that stopped needing you, by moving on or by going away.
    pub fn step(&mut self, live: &[Live]) -> Edges {
        let mut edges = Edges::default();
        for l in live {
            let was = self.last.insert(l.id.clone(), l.dot);
            if l.dot == Dot::NeedsYou && was != Some(Dot::NeedsYou) {
                self.attended.insert(l.id.clone(), false);
                edges.rose.push(l.id.clone());
            }
            if l.dot != Dot::NeedsYou && was == Some(Dot::NeedsYou) {
                edges.cleared.push(l.id.clone());
            }
            match l.dot {
                Dot::Working => {
                    self.worked.insert(l.id.clone());
                }
                // A turn that ended blocked is needs-you's to announce, and
                // the block clearing later is not the turn finishing.
                Dot::NeedsYou => {
                    self.worked.remove(&l.id);
                }
                _ => {}
            }
            let fresh = l.done_at != 0 && self.announced.get(&l.id) != Some(&l.done_at);
            if l.dot == Dot::Solid && fresh && self.worked.remove(&l.id) {
                self.announced.insert(l.id.clone(), l.done_at);
                edges.finished.push(l.id.clone());
            }
        }
        let ids: HashSet<&str> = live.iter().map(|l| l.id.as_str()).collect();
        for (id, dot) in &self.last {
            if *dot == Dot::NeedsYou && !ids.contains(id.as_str()) {
                edges.cleared.push(id.clone());
            }
        }
        self.last.retain(|id, _| ids.contains(id.as_str()));
        self.attended.retain(|id, _| ids.contains(id.as_str()));
        self.announced.retain(|id, _| ids.contains(id.as_str()));
        self.worked.retain(|id| ids.contains(id.as_str()));
        edges
    }

    /// What the user is looking at. A selected row in a focused window is attended.
    pub fn attend(&mut self, selected: Option<String>, focused: bool) {
        if let Some(id) = selected.as_ref().filter(|_| focused) {
            self.attended.insert(id.clone(), true);
        }
        self.selected = selected;
        self.focused = focused;
    }

    /// Blocked, and nobody has looked since.
    pub fn unattended(&self, id: &str, dot: Dot) -> bool {
        dot == Dot::NeedsYou && !self.attended.get(id).copied().unwrap_or(false)
    }

    pub fn suppressed(&self, live: &Live) -> bool {
        should_suppress(&live.id, live.visible, self.selected.as_deref(), self.focused)
    }

    /// What the tray and the dock badge should change to for `live`, `None`
    /// for each that already shows it.
    pub fn surface(&mut self, live: &[Live]) -> (Option<(String, Vec<TrayEntry>)>, Option<usize>) {
        let tray = (tooltip(live), tray_entries(live));
        let tray = (self.tray.as_ref() != Some(&tray)).then(|| {
            self.tray = Some(tray.clone());
            tray
        });
        let badge = live.iter().filter(|l| self.unattended(&l.id, l.dot)).count();
        let badge = (self.badge != Some(badge)).then(|| {
            self.badge = Some(badge);
            badge
        });
        (tray, badge)
    }
}

/// Don't notify for the session you are looking at when it blocks. A PTY
/// session is watched as the selected row. A chat is watched by having its tab
/// on screen, since its session id exists before any transcript does, so
/// selecting its tab resolves only as far as its branch. An unfocused window
/// suppresses nothing: that is the case the notification exists for.
pub fn should_suppress(id: &str, on_screen: bool, selected: Option<&str>, focused: bool) -> bool {
    focused && (selected == Some(id) || on_screen)
}

/// Whether a worker's question reaches you through its spawner instead: while
/// the chat that spawned it is open, or while the autopilot runs.
pub fn relayed(spawner: Option<&str>, live_chats: &HashSet<String>, autopilot_on: bool) -> bool {
    spawner.is_some_and(|s| autopilot_on || live_chats.contains(s))
}

/// Apply the switches to one tick's edges. `quiet` holds the sessions that are
/// being watched or relayed, which neither notify nor count toward a sound.
pub fn decide(edges: Edges, quiet: &HashSet<String>, on: &crate::settings::Notifications) -> Alerts {
    let loud = |ids: Vec<String>| ids.into_iter().filter(|id| !quiet.contains(id)).collect::<Vec<_>>();
    let (rose, finished) = (loud(edges.rose), loud(edges.finished));
    Alerts {
        needs_you_sound: on.needs_you.sound && !rose.is_empty(),
        finished_sound: on.turn_finished.sound && !finished.is_empty(),
        needs_you: if on.needs_you.notify { rose } else { Vec::new() },
        finished: if on.turn_finished.notify { finished } else { Vec::new() },
    }
}

fn tooltip(live: &[Live]) -> String {
    let running = live.iter().filter(|l| l.dot != Dot::None).count();
    let needs_you = live.iter().filter(|l| l.dot == Dot::NeedsYou).count();
    if needs_you > 0 {
        format!("Tori - {running} running, {needs_you} need you")
    } else if running > 0 {
        format!("Tori - {running} running")
    } else {
        "Tori".to_string()
    }
}

/// The tray's menu, from the same list the counts come from, so everything the
/// badge counts has a row to click. What needs you sorts first, and the sort is
/// stable so the menu does not reshuffle on an unrelated change.
fn tray_entries(live: &[Live]) -> Vec<TrayEntry> {
    let mut shown: Vec<&Live> = live.iter().filter(|l| l.dot != Dot::None).collect();
    shown.sort_by_key(|l| l.dot != Dot::NeedsYou);
    shown
        .into_iter()
        .map(|l| {
            let mark = if l.dot == Dot::NeedsYou { "\u{26a0} " } else { "" };
            let project = if l.project.is_empty() {
                String::new()
            } else {
                format!(" ({})", l.project)
            };
            TrayEntry {
                id: l.id.clone(),
                label: format!("{mark}{}{project}", l.name),
            }
        })
        .collect()
}

pub fn set_tray(app: &AppHandle, tooltip: &str, entries: &[TrayEntry]) -> Result<(), String> {
    let state = app.try_state::<TrayState>().ok_or("no tray")?;
    let tray = state.0.lock().map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;

    let menu = if entries.is_empty() {
        let placeholder = MenuItem::with_id(app, "no-sessions", "No active sessions", false, None::<&str>)
            .map_err(|e| e.to_string())?;
        Menu::with_items(app, &[&placeholder]).map_err(|e| e.to_string())?
    } else {
        let items: Vec<MenuItem<tauri::Wry>> = entries
            .iter()
            .map(|e| MenuItem::with_id(app, &e.id, &e.label, true, None::<&str>))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
        Menu::with_items(app, &refs).map_err(|e| e.to_string())?
    };
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

    Ok(())
}

/// Menu-item click handler, wired once at tray creation (lib.rs's `setup`):
/// a session entry's id is the session id itself, so this is a direct
/// passthrough. The placeholder "no-sessions" item is disabled and never
/// reaches here.
pub fn handle_tray_menu_event(app: &AppHandle, id: &str) {
    let _ = app.emit("tray://focus-session", id.to_string());
}

pub fn needs_you_body(live: &Live) -> String {
    if live.project.is_empty() {
        "Needs you".to_string()
    } else {
        format!("{} needs you", live.project)
    }
}

pub fn finished_body(live: &Live) -> String {
    if live.project.is_empty() {
        "Finished".to_string()
    } else {
        format!("{} finished", live.project)
    }
}

/// Shows a notification about a session. With `click`, a click brings the
/// window forward and opens the session, at the cost of a thread parked until
/// the notification is clicked or gone; `withdraw_notification` takes it down
/// once the session stops needing you. Elsewhere than macOS it is the
/// plugin's, with no click.
pub fn notify_session(app: AppHandle, live: &Live, body: String, click: bool) {
    let title = live.name.clone();
    let target = crate::autopilot::NavTarget {
        folder: Some(live.folder.clone()),
        session: Some(live.id.clone()),
    };
    #[cfg(target_os = "macos")]
    {
        let session = live.id.clone();
        let id = uuid::Uuid::new_v4().into_bytes();
        if click {
            needs_you_notes(|notes| notes.insert(session.clone(), id));
        }
        std::thread::spawn(move || {
            // An unbundled dev binary has no identifier of its own, so it borrows
            // Terminal's, as the plugin does; the first call wins for both.
            let bundle = if tauri::is_dev() {
                "com.apple.Terminal".to_string()
            } else {
                app.config().identifier.clone()
            };
            let _ = mac_notification_sys::set_application(&bundle);
            // With a click wait this blocks until the notification is clicked or
            // gone, and without one only until it is delivered.
            let answer = mac_notification_sys::Notification::new()
                .title(&title)
                .message(&body)
                .identifier(id)
                .wait_for_click(click)
                .send();
            if click {
                needs_you_notes(|notes| {
                    if notes.get(&session) == Some(&id) {
                        notes.remove(&session);
                    }
                });
            }
            if !click || !matches!(answer, Ok(mac_notification_sys::NotificationResponse::Click)) {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("nav://open", target);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = (target, click);
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[cfg(target_os = "macos")]
fn needs_you_notes<T>(f: impl FnOnce(&mut HashMap<String, [u8; 16]>) -> T) -> T {
    let mut notes = NEEDS_YOU_NOTES.lock().unwrap_or_else(|e| e.into_inner());
    f(notes.get_or_insert_with(HashMap::new))
}

/// Takes down the session's needs-you notification, if one is still up. Its
/// click wait sees it gone on the next poll and lets its thread go.
pub fn withdraw_notification(app: &AppHandle, session: &str) {
    #[cfg(target_os = "macos")]
    {
        let Some(id) = needs_you_notes(|notes| notes.remove(session)) else {
            return;
        };
        let identifier = uuid::Uuid::from_bytes(id).hyphenated().to_string();
        let _ = app.run_on_main_thread(move || {
            // NSUserNotification is the API mac-notification-sys sends with,
            // so its delivered list is where the notification sits.
            #[allow(deprecated)]
            {
                use objc2_foundation::NSUserNotificationCenter;
                let center = NSUserNotificationCenter::defaultUserNotificationCenter();
                for note in center.deliveredNotifications().iter() {
                    if note
                        .identifier()
                        .is_some_and(|i| i.to_string().eq_ignore_ascii_case(&identifier))
                    {
                        center.removeDeliveredNotification(&note);
                    }
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, session);
}

pub fn set_badge_count(app: &AppHandle, count: usize) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    crate::platform::native::set_badge(&window, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(id: &str, dot: Dot) -> Live {
        Live {
            id: id.into(),
            dot,
            name: String::new(),
            project: String::new(),
            folder: String::new(),
            chat: false,
            visible: false,
            spawner: None,
            done_at: 0,
        }
    }

    #[test]
    fn fires_once_on_the_rising_edge_not_while_it_stays_blocked() {
        let mut p = Presence::default();
        assert_eq!(p.step(&[live("s1", Dot::NeedsYou)]).rose, ["s1"]);
        assert!(p.step(&[live("s1", Dot::NeedsYou)]).rose.is_empty());
    }

    #[test]
    fn a_re_block_resets_attended_and_the_steady_state_does_not() {
        let mut p = Presence::default();
        p.step(&[live("s1", Dot::NeedsYou)]);
        p.attend(Some("s1".into()), true);
        assert!(!p.unattended("s1", Dot::NeedsYou));
        assert!(p.step(&[live("s1", Dot::NeedsYou)]).rose.is_empty());
        assert!(!p.unattended("s1", Dot::NeedsYou));
        p.step(&[live("s1", Dot::Working)]);
        assert_eq!(p.step(&[live("s1", Dot::NeedsYou)]).rose, ["s1"]);
        assert!(p.unattended("s1", Dot::NeedsYou));
    }

    fn chat(id: &str, dot: Dot, done_at: u64) -> Live {
        Live {
            chat: true,
            done_at,
            ..live(id, dot)
        }
    }

    #[test]
    fn a_chat_finishes_once_when_a_completed_turn_goes_idle() {
        let mut p = Presence::default();
        assert!(p.step(&[chat("c", Dot::Working, 0)]).finished.is_empty());
        assert_eq!(p.step(&[chat("c", Dot::Solid, 10)]).finished, ["c"]);
        assert!(p.step(&[chat("c", Dot::Solid, 10)]).finished.is_empty());
        p.step(&[chat("c", Dot::Working, 10)]);
        assert_eq!(p.step(&[chat("c", Dot::Solid, 20)]).finished, ["c"]);
    }

    #[test]
    fn a_completion_that_arrives_a_tick_after_idle_still_finishes_once() {
        let mut p = Presence::default();
        p.step(&[chat("c", Dot::Working, 0)]);
        assert!(p.step(&[chat("c", Dot::Solid, 0)]).finished.is_empty());
        assert_eq!(p.step(&[chat("c", Dot::Solid, 10)]).finished, ["c"]);
        assert!(p.step(&[chat("c", Dot::Solid, 10)]).finished.is_empty());
    }

    #[test]
    fn going_idle_without_a_new_completion_is_not_a_finish() {
        let mut p = Presence::default();
        // A session with no completion to report: a terminal, or a chat whose
        // history is replaying.
        p.step(&[live("pty", Dot::Working), chat("replay", Dot::Working, 0)]);
        assert!(p
            .step(&[live("pty", Dot::Solid), chat("replay", Dot::Solid, 0)])
            .finished
            .is_empty());
        // A turn that ended with a message queued behind it, or was cancelled:
        // idle shows for a moment and the last completion is the old one.
        p.step(&[chat("c", Dot::Working, 0)]);
        p.step(&[chat("c", Dot::Solid, 10)]);
        p.step(&[chat("c", Dot::Working, 10)]);
        assert!(p.step(&[chat("c", Dot::Solid, 10)]).finished.is_empty());
    }

    #[test]
    fn only_idle_after_working_is_a_finish() {
        let mut p = Presence::default();
        p.step(&[chat("blocked", Dot::Working, 0), chat("detached", Dot::Hollow, 0)]);
        let edges = p.step(&[chat("blocked", Dot::NeedsYou, 10), chat("detached", Dot::Solid, 10)]);
        assert_eq!(edges.rose, ["blocked"]);
        assert!(edges.finished.is_empty());
        // The red check clears later: that is not the turn finishing.
        assert!(p.step(&[chat("blocked", Dot::Solid, 10)]).finished.is_empty());
    }

    fn switches(needs_you: (bool, bool), finished: (bool, bool)) -> crate::settings::Notifications {
        use crate::settings::Alert;
        crate::settings::Notifications {
            needs_you: Alert {
                notify: needs_you.0,
                sound: needs_you.1,
            },
            turn_finished: Alert {
                notify: finished.0,
                sound: finished.1,
            },
        }
    }

    fn edges(rose: &[&str], finished: &[&str]) -> Edges {
        let own = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect();
        Edges {
            rose: own(rose),
            finished: own(finished),
            cleared: vec![],
        }
    }

    #[test]
    fn each_switch_decides_its_own_alert_and_nothing_else() {
        let none = HashSet::new();
        let both = || edges(&["a"], &["b"]);
        let banner = decide(both(), &none, &switches((true, false), (false, false)));
        assert_eq!(
            banner,
            Alerts {
                needs_you: vec!["a".into()],
                ..Alerts::default()
            }
        );
        let sound = decide(both(), &none, &switches((false, true), (false, false)));
        assert_eq!(
            sound,
            Alerts {
                needs_you_sound: true,
                ..Alerts::default()
            }
        );
        let done = decide(both(), &none, &switches((false, false), (true, false)));
        assert_eq!(
            done,
            Alerts {
                finished: vec!["b".into()],
                ..Alerts::default()
            }
        );
        let chime = decide(both(), &none, &switches((false, false), (false, true)));
        assert_eq!(
            chime,
            Alerts {
                finished_sound: true,
                ..Alerts::default()
            }
        );
        assert_eq!(
            decide(both(), &none, &switches((false, false), (false, false))),
            Alerts::default()
        );
    }

    #[test]
    fn a_watched_or_relayed_session_neither_notifies_nor_sounds() {
        let quiet: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        assert_eq!(
            decide(edges(&["a"], &["b"]), &quiet, &switches((true, true), (true, true))),
            Alerts::default()
        );
    }

    #[test]
    fn several_chats_finishing_at_once_are_one_sound() {
        let quiet: HashSet<String> = ["x".to_string()].into();
        let got = decide(
            edges(&[], &["x", "y", "z"]),
            &quiet,
            &switches((true, true), (true, true)),
        );
        assert_eq!(
            got,
            Alerts {
                finished: vec!["y".into(), "z".into()],
                finished_sound: true,
                ..Alerts::default()
            }
        );
    }

    #[test]
    fn attending_does_not_suppress_the_next_genuine_block() {
        let mut p = Presence::default();
        p.step(&[live("s1", Dot::NeedsYou)]);
        p.attend(Some("s1".into()), true);
        assert!(p.step(&[live("s1", Dot::Working)]).rose.is_empty());
        assert_eq!(p.step(&[live("s1", Dot::NeedsYou)]).rose, ["s1"]);
    }

    #[test]
    fn tracks_sessions_independently() {
        let mut p = Presence::default();
        assert_eq!(p.step(&[live("a", Dot::NeedsYou), live("b", Dot::Working)]).rose, ["a"]);
        assert_eq!(
            p.step(&[live("a", Dot::NeedsYou), live("b", Dot::NeedsYou)]).rose,
            ["b"]
        );
    }

    #[test]
    fn attending_twice_is_a_no_op() {
        let mut p = Presence::default();
        p.step(&[live("s1", Dot::NeedsYou)]);
        p.attend(Some("s1".into()), true);
        let once = p.attended.clone();
        p.attend(Some("s1".into()), true);
        assert_eq!(p.attended, once);
    }

    #[test]
    fn counts_only_blocked_sessions_nobody_has_looked_at() {
        let mut p = Presence::default();
        let all = [
            live("a", Dot::NeedsYou),
            live("b", Dot::NeedsYou),
            live("c", Dot::Working),
        ];
        p.step(&all);
        let count = |p: &Presence| all.iter().filter(|l| p.unattended(&l.id, l.dot)).count();
        assert_eq!(count(&p), 2);
        p.attend(Some("a".into()), true);
        assert_eq!(count(&p), 1);
        p.attend(Some("b".into()), true);
        assert_eq!(count(&p), 0);
    }

    #[test]
    fn suppresses_only_the_selected_session_in_a_focused_window() {
        assert!(should_suppress("s1", false, Some("s1"), true));
        assert!(!should_suppress("s1", false, Some("s1"), false));
        assert!(!should_suppress("s1", false, Some("other"), true));
        assert!(!should_suppress("s1", false, None, true));
    }

    #[test]
    fn also_suppresses_a_chat_whose_tab_is_on_screen() {
        assert!(should_suppress("chat-1", true, None, true));
        assert!(!should_suppress("chat-1", false, None, true));
    }

    #[test]
    fn suppresses_nothing_while_the_window_is_unfocused() {
        assert!(!should_suppress("chat-1", true, Some("chat-1"), false));
    }

    #[test]
    fn relays_a_worker_only_while_its_spawner_is_there() {
        let open = HashSet::from(["chat-a".to_string()]);
        assert!(relayed(Some("pilot"), &HashSet::new(), true));
        assert!(!relayed(Some("pilot"), &HashSet::new(), false));
        assert!(relayed(Some("chat-a"), &open, false));
        assert!(!relayed(None, &open, true));
    }

    fn named(id: &str, dot: Dot, name: &str, project: &str) -> Live {
        Live {
            name: name.into(),
            project: project.into(),
            ..live(id, dot)
        }
    }

    #[test]
    fn lists_what_needs_you_first_and_marked_and_leaves_out_what_has_no_dot() {
        let all = [
            named("pty-1", Dot::Working, "agent", "repo"),
            named("chat-1", Dot::NeedsYou, "chat A", "repo"),
            named("gone", Dot::None, "ended chat", "repo"),
        ];
        let labels: Vec<String> = tray_entries(&all).into_iter().map(|e| e.label).collect();
        assert_eq!(labels, ["\u{26a0} chat A (repo)", "agent (repo)"]);
    }

    #[test]
    fn keeps_the_order_of_sessions_that_share_a_rank() {
        let all = [live("a", Dot::Working), live("b", Dot::Solid), live("c", Dot::Hollow)];
        let ids: Vec<String> = tray_entries(&all).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, ["a", "b", "c"]);
    }

    #[test]
    fn omits_the_project_suffix_when_there_is_no_project() {
        assert_eq!(
            tray_entries(&[named("chat-1", Dot::NeedsYou, "chat A", "")])[0].label,
            "\u{26a0} chat A"
        );
    }
}
