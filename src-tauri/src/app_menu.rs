// The menu bar, and the one router every menu click goes through, the tray's
// included: Tauri calls every menu handler for every menu event, so a second
// handler would see each click twice.

use tauri::{AppHandle, Emitter, Manager};

const QUIT_ID: &str = "app-quit";

const MENU_PREFIX: &str = "menu:";

pub const TRAY_PREFIX: &str = "tray:";

pub const TRAY_FOOTER: [(&str, &str); 3] = [
    ("open", "Open Tori"),
    ("next-waiting", "Next Waiting Session"),
    ("open-inbox", "Show Inbox"),
];

pub const TRAY_QUIT: &str = "quit";

// Opened from here rather than through a command the frontend calls with a
// URL, so the webview can never be talked into opening an arbitrary one.
const HELP_LINKS: [(&str, &str); 3] = [
    ("help-docs", "https://gettori.app/docs/"),
    ("help-changelog", "https://gettori.app/changelog/"),
    ("help-issue", "https://github.com/gettori/tori/issues/new"),
];

pub fn route(app: &AppHandle, id: &str) {
    if id == QUIT_ID {
        quit(app);
    } else if let Some(item) = id.strip_prefix(TRAY_PREFIX) {
        crate::presence::raise_window(app);
        match item {
            "open" => {}
            TRAY_QUIT => quit(app),
            command => {
                let _ = app.emit("menu://command", command.to_string());
            }
        }
    } else if let Some(session) = id.strip_prefix(crate::presence::SESSION_MENU_PREFIX) {
        crate::presence::focus_session(app, session);
    } else if let Some(item) = id.strip_prefix(MENU_PREFIX) {
        match HELP_LINKS.iter().find(|(link, _)| *link == item) {
            Some((_, url)) => {
                use tauri_plugin_opener::OpenerExt;
                if let Err(e) = app.opener().open_url(*url, None::<&str>) {
                    eprintln!("tori: could not open {url}: {e}");
                }
            }
            None => {
                let _ = app.emit("menu://command", item.to_string());
            }
        }
    }
}

fn quit(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.close();
        }
        None => app.exit(0),
    }
}

// The system Quit item terminates the app outright, past the window's close
// question, so Cmd+Q is swapped for one that closes the window instead.
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID};

    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, format!("{MENU_PREFIX}{id}"), label, true, accelerator)
    };
    let separator = || PredefinedMenuItem::separator(app);
    let name = app.package_info().name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &separator()?,
            &item("open-settings", "Settings...", Some("CmdOrCtrl+,"))?,
            &item("check-updates", "Check for Updates...", None)?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &separator()?,
            &MenuItem::with_id(app, QUIT_ID, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let menu = Menu::default(app)?;
    menu.remove_at(0)?;
    menu.prepend(&app_menu)?;
    if let Some(MenuItemKind::Submenu(help)) = menu.get(HELP_SUBMENU_ID) {
        help.append_items(&[
            &item("help-docs", "Tori Documentation", None)?,
            &item("shortcut-sheet", "Keyboard Shortcuts", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("help-changelog", "Release Notes", None)?,
            &item("help-issue", "Report an Issue", None)?,
        ])?;
    }
    app.set_menu(menu)?;
    Ok(())
}
