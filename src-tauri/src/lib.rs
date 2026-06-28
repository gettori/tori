mod config;
mod fs;
mod git;
mod launch;
mod pty;
mod sessions;
mod theme;
mod worktree;

use config::ConfigWatch;
use fs::FsWatch;
use pty::PtyState;
use sessions::{SessionIndex, SessionWatch};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .manage(FsWatch::default())
        .manage(SessionIndex::default())
        .manage(SessionWatch::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            config::get_config,
            config::list_branches,
            config::config_watch_start,
            fs::fs_read_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::file_exists,
            fs::fs_watch_start,
            git::git_status,
            git::git_diff_file,
            git::git_diff_text,
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
            theme::get_theme_colors,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
