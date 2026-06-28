mod codeserver;
mod config;
mod launch;
mod pty;
mod sessions;
mod theme;
mod worktree;

use codeserver::CodeServer;
use config::ConfigWatch;
use pty::PtyState;
use sessions::{SessionIndex, SessionWatch};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Hide the native macOS traffic-light buttons so we can draw our own
            // (smaller, centered, gray-until-hover) in the web layer. Keeping the
            // Overlay title-bar style preserves the window's rounded corners/shadow.
            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSWindow, NSWindowButton};
                use cocoa::base::{id, nil};
                use objc::{msg_send, sel, sel_impl};

                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(ns_window) = window.ns_window() {
                        let ns_window = ns_window as id;
                        unsafe {
                            for button in [
                                NSWindowButton::NSWindowCloseButton,
                                NSWindowButton::NSWindowMiniaturizeButton,
                                NSWindowButton::NSWindowZoomButton,
                            ] {
                                let b: id = ns_window.standardWindowButton_(button);
                                if b != nil {
                                    let _: () = msg_send![b, setHidden: true];
                                }
                            }
                        }
                    }
                }
            }
            Ok(())
        })
        .manage(PtyState::default())
        .manage(ConfigWatch::default())
        .manage(SessionIndex::default())
        .manage(SessionWatch::default())
        .manage(CodeServer::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            config::get_config,
            config::list_branches,
            config::config_watch_start,
            sessions::list_sessions,
            sessions::sessions_watch_start,
            sessions::set_session_name,
            sessions::set_session_archived,
            sessions::delete_session,
            sessions::session_running,
            sessions::session_detail,
            launch::open_in_vscode,
            launch::open_in_ghostty,
            worktree::list_worktrees,
            worktree::add_worktree,
            worktree::remove_worktree,
            codeserver::code_server_url,
            theme::get_theme_colors,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            app_handle.state::<CodeServer>().shutdown();
        }
    });
}
