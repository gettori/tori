// A needs-you notification is sent from here rather than the notification
// plugin, whose desktop send never reports a click: a click has to land on the
// session that needed you.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::menu::{IsMenuItem, Menu, MenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Emitter, Manager};

use crate::rpc::dots::Dot;

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
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrayEntry {
    pub id: String,
    pub label: String,
}

pub struct Presence {
    attended: HashMap<String, bool>,
    last: HashMap<String, Dot>,
    selected: Option<String>,
    focused: bool,
    tray: Option<(String, Vec<TrayEntry>)>,
    badge: Option<usize>,
}

impl Default for Presence {
    fn default() -> Self {
        Self { attended: HashMap::new(), last: HashMap::new(), selected: None, focused: true, tray: None, badge: None }
    }
}

impl Presence {
    /// Fold one tick of dots in. Returns the sessions that just crossed into
    /// needs-you: the rising edge, so one still blocked from the last tick does
    /// not fire again, and one that moved in between does.
    pub fn step(&mut self, live: &[Live]) -> Vec<String> {
        let mut rose = Vec::new();
        for l in live {
            if l.dot == Dot::NeedsYou && self.last.get(&l.id) != Some(&Dot::NeedsYou) {
                self.attended.insert(l.id.clone(), false);
                rose.push(l.id.clone());
            }
            self.last.insert(l.id.clone(), l.dot);
        }
        let ids: HashSet<&str> = live.iter().map(|l| l.id.as_str()).collect();
        self.last.retain(|id, _| ids.contains(id.as_str()));
        self.attended.retain(|id, _| ids.contains(id.as_str()));
        rose
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
            let project = if l.project.is_empty() { String::new() } else { format!(" ({})", l.project) };
            TrayEntry { id: l.id.clone(), label: format!("{mark}{}{project}", l.name) }
        })
        .collect()
}

pub fn set_tray(app: &AppHandle, tooltip: &str, entries: &[TrayEntry]) -> Result<(), String> {
    let state = app.try_state::<TrayState>().ok_or("no tray")?;
    let tray = state.0.lock().map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;

    let menu = if entries.is_empty() {
        let placeholder =
            MenuItem::with_id(app, "no-sessions", "No active sessions", false, None::<&str>)
                .map_err(|e| e.to_string())?;
        Menu::with_items(app, &[&placeholder]).map_err(|e| e.to_string())?
    } else {
        let items: Vec<MenuItem<tauri::Wry>> = entries
            .iter()
            .map(|e| MenuItem::with_id(app, &e.id, &e.label, true, None::<&str>))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
            items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
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

/// Shows a needs-you notification whose click brings the window forward and
/// opens the session. Elsewhere than macOS it is the plugin's, with no click.
pub fn notify_needs_you(app: AppHandle, live: &Live) {
    let title = live.name.clone();
    let body = if live.project.is_empty() { "Needs you".to_string() } else { format!("{} needs you", live.project) };
    let target = crate::autopilot::NavTarget { folder: Some(live.folder.clone()), session: Some(live.id.clone()) };
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || {
        // An unbundled dev binary has no identifier of its own, so it borrows
        // Terminal's, as the plugin does; the first call wins for both.
        let bundle = if tauri::is_dev() { "com.apple.Terminal".to_string() } else { app.config().identifier.clone() };
        let _ = mac_notification_sys::set_application(&bundle);
        // Blocks this thread until the notification is clicked or dismissed.
        let answer = mac_notification_sys::Notification::new().title(&title).message(&body).wait_for_click(true).send();
        if !matches!(answer, Ok(mac_notification_sys::NotificationResponse::Click)) {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = app.emit("nav://open", target);
    });
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = target;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

pub fn set_badge_count(app: &AppHandle, count: usize) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    window.set_badge_count((count > 0).then_some(count as i64)).map_err(|e| e.to_string())
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
        }
    }

    #[test]
    fn fires_once_on_the_rising_edge_not_while_it_stays_blocked() {
        let mut p = Presence::default();
        assert_eq!(p.step(&[live("s1", Dot::NeedsYou)]), ["s1"]);
        assert!(p.step(&[live("s1", Dot::NeedsYou)]).is_empty());
    }

    #[test]
    fn a_re_block_resets_attended_and_the_steady_state_does_not() {
        let mut p = Presence::default();
        p.step(&[live("s1", Dot::NeedsYou)]);
        p.attend(Some("s1".into()), true);
        assert!(!p.unattended("s1", Dot::NeedsYou));
        assert!(p.step(&[live("s1", Dot::NeedsYou)]).is_empty());
        assert!(!p.unattended("s1", Dot::NeedsYou));
        p.step(&[live("s1", Dot::Working)]);
        assert_eq!(p.step(&[live("s1", Dot::NeedsYou)]), ["s1"]);
        assert!(p.unattended("s1", Dot::NeedsYou));
    }

    #[test]
    fn attending_does_not_suppress_the_next_genuine_block() {
        let mut p = Presence::default();
        p.step(&[live("s1", Dot::NeedsYou)]);
        p.attend(Some("s1".into()), true);
        assert!(p.step(&[live("s1", Dot::Working)]).is_empty());
        assert_eq!(p.step(&[live("s1", Dot::NeedsYou)]), ["s1"]);
    }

    #[test]
    fn tracks_sessions_independently() {
        let mut p = Presence::default();
        assert_eq!(p.step(&[live("a", Dot::NeedsYou), live("b", Dot::Working)]), ["a"]);
        assert_eq!(p.step(&[live("a", Dot::NeedsYou), live("b", Dot::NeedsYou)]), ["b"]);
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
        let all = [live("a", Dot::NeedsYou), live("b", Dot::NeedsYou), live("c", Dot::Working)];
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
        Live { name: name.into(), project: project.into(), ..live(id, dot) }
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
        assert_eq!(tray_entries(&[named("chat-1", Dot::NeedsYou, "chat A", "")])[0].label, "\u{26a0} chat A");
    }
}
