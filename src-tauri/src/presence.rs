// Presence outside the window (Finding F3): the menu-bar tray item and the
// dock badge. Both are driven by the frontend (presence.ts owns the
// rising-edge/attended state); this module is just the OS-native surface -
// rebuild the tray's tooltip/menu, or set the dock badge count, on request.
//
// The OS notification itself (task 2 of this phase) is entirely frontend-side
// (@tauri-apps/plugin-notification), needing no Rust command here.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{IsMenuItem, Menu, MenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct TrayState(pub Mutex<TrayIcon>);

#[derive(Deserialize)]
pub struct TrayEntry {
    id: String,
    label: String,
}

/// Rebuild the tray's tooltip (counts) and menu (one item per live session,
/// clicking emits `tray://focus-session` with that session's id for the
/// frontend to focus). Called by the frontend whenever the composed presence
/// state changes; there's no cheaper incremental-update path in tauri's menu
/// API, and tray updates are infrequent (agent state transitions, not PTY bytes).
#[tauri::command]
pub fn update_tray(
    app: AppHandle,
    state: State<TrayState>,
    running: i32,
    needs_you: i32,
    entries: Vec<TrayEntry>,
) -> Result<(), String> {
    let tray = state.0.lock().map_err(|e| e.to_string())?;

    let tooltip = if needs_you > 0 {
        format!("Sway - {running} running, {needs_you} need you")
    } else if running > 0 {
        format!("Sway - {running} running")
    } else {
        "Sway".to_string()
    };
    tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())?;

    let menu = if entries.is_empty() {
        let placeholder =
            MenuItem::with_id(&app, "no-sessions", "No active sessions", false, None::<&str>)
                .map_err(|e| e.to_string())?;
        Menu::with_items(&app, &[&placeholder]).map_err(|e| e.to_string())?
    } else {
        let items: Vec<MenuItem<tauri::Wry>> = entries
            .iter()
            .map(|e| MenuItem::with_id(&app, &e.id, &e.label, true, None::<&str>))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
            items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
        Menu::with_items(&app, &refs).map_err(|e| e.to_string())?
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

/// Sets (or clears, with `count <= 0`) the dock badge. Desktop-only; a no-op
/// error from a headless/CI environment with no window is swallowed the same
/// way the rest of this app's window-dependent commands are.
#[tauri::command]
pub fn set_badge_count(app: AppHandle, count: i64) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    window.set_badge_count(if count > 0 { Some(count) } else { None }).map_err(|e| e.to_string())
}
