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

#[derive(serde::Deserialize)]
pub struct MenuSpec {
    title: String,
    items: Vec<MenuEntry>,
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuEntry {
    Command {
        id: String,
        label: String,
        accelerator: Option<String>,
    },
    System {
        item: SystemItem,
    },
    Separator,
}

#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum SystemItem {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
}

// What stands in until the frontend sends its menus: the system items alone,
// since the webview's copy and paste only work through an Edit menu.
#[cfg(target_os = "macos")]
fn startup_spec() -> Vec<MenuSpec> {
    let system = |title: &str, items: &[SystemItem]| MenuSpec {
        title: title.to_string(),
        items: items.iter().map(|&item| MenuEntry::System { item }).collect(),
    };
    use SystemItem::*;
    vec![
        system("Edit", &[Undo, Redo, Cut, Copy, Paste, SelectAll]),
        system("View", &[Fullscreen]),
        system("Window", &[Minimize, Maximize]),
    ]
}

#[derive(serde::Serialize)]
pub struct AboutInfo {
    version: String,
    commit: Option<&'static str>,
}

#[tauri::command]
pub fn about_info(app: AppHandle) -> AboutInfo {
    AboutInfo {
        version: app.package_info().version.to_string(),
        commit: Some(env!("TORI_COMMIT")).filter(|c| !c.is_empty()),
    }
}

#[tauri::command]
pub async fn set_app_menu(app: AppHandle, spec: Vec<MenuSpec>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    build(&app, &spec).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, spec);
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    build(app, &startup_spec())
}

// The system Quit item terminates the app outright, past the window's close
// question, so Cmd+Q is swapped for one that closes the window instead.
#[cfg(target_os = "macos")]
fn build(app: &AppHandle, spec: &[MenuSpec]) -> tauri::Result<()> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};

    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, format!("{MENU_PREFIX}{id}"), label, true, accelerator)
    };
    let separator = || PredefinedMenuItem::separator(app);
    let name = app.package_info().name.clone();
    let menu = Menu::with_items(
        app,
        &[&Submenu::with_items(
            app,
            &name,
            true,
            &[
                &item("about", &format!("About {name}"), None)?,
                &separator()?,
                &item("open-settings", "Settings...", None)?,
                &item("check-updates", "Check for Updates...", None)?,
                &separator()?,
                &PredefinedMenuItem::services(app, None)?,
                &separator()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &separator()?,
                &MenuItem::with_id(app, QUIT_ID, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?,
            ],
        )?],
    )?;
    for section in spec {
        let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
        for entry in &section.items {
            items.push(match entry {
                MenuEntry::Command { id, label, accelerator } => Box::new(item(id, label, accelerator.as_deref())?),
                MenuEntry::Separator => Box::new(separator()?),
                MenuEntry::System { item } => Box::new(match item {
                    SystemItem::Undo => PredefinedMenuItem::undo(app, None)?,
                    SystemItem::Redo => PredefinedMenuItem::redo(app, None)?,
                    SystemItem::Cut => PredefinedMenuItem::cut(app, None)?,
                    SystemItem::Copy => PredefinedMenuItem::copy(app, None)?,
                    SystemItem::Paste => PredefinedMenuItem::paste(app, None)?,
                    SystemItem::SelectAll => PredefinedMenuItem::select_all(app, None)?,
                    SystemItem::Fullscreen => PredefinedMenuItem::fullscreen(app, None)?,
                    SystemItem::Minimize => PredefinedMenuItem::minimize(app, None)?,
                    SystemItem::Maximize => PredefinedMenuItem::maximize(app, None)?,
                }),
            });
        }
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|i| i.as_ref()).collect();
        // The Window menu's id is what macOS lists open windows under.
        let submenu = match section.title.as_str() {
            "Window" => Submenu::with_id_and_items(app, WINDOW_SUBMENU_ID, &section.title, true, &refs)?,
            _ => Submenu::with_items(app, &section.title, true, &refs)?,
        };
        menu.append(&submenu)?;
    }
    menu.append(&Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &item("help-docs", "Tori Documentation", None)?,
            &item("shortcut-sheet", "Keyboard Shortcuts", None)?,
            &separator()?,
            &item("help-changelog", "Release Notes", None)?,
            &item("help-issue", "Report an Issue", None)?,
        ],
    )?)?;
    app.set_menu(menu)?;
    Ok(())
}
