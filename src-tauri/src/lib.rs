mod askpass;
mod config;
mod env;
mod fs;
mod git;
mod launch;
mod lsp;
mod model;
mod pty;
mod sessions;
mod theme;
mod worktree;

use config::{ConfigWatch, ProjectIndex, RootWatch};
use fs::FsWatch;
use lsp::LspState;
use pty::PtyState;
use sessions::{PiIndex, SessionIndex, SessionWatch};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Same-binary re-exec as the askpass helper: git/ssh invoke this exe with the
    // socket marker env set. Detect it and run the stdout-answer-only helper path
    // *before* any Tauri/AppKit init, then exit. The app's own process never has
    // the marker (it is set only on the git child command).
    if askpass::is_helper() {
        std::process::exit(askpass::run_helper());
    }

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

            // Start the askpass credential bridge: a private Unix socket whose
            // prompts fan out to the frontend as `askpass://prompt`. If it fails
            // to bind, the app still runs (network git ops just can't prompt).
            let emit_handle = app.handle().clone();
            match askpass::start(Box::new(move |ev| {
                let _ = emit_handle.emit("askpass://prompt", ev);
            })) {
                Ok(inner) => {
                    app.manage(askpass::AskpassState(inner));
                }
                Err(e) => eprintln!("sway: askpass bridge failed to start: {e}"),
            }
            Ok(())
        })
        .manage(PtyState::default())
        .manage(ConfigWatch::default())
        .manage(ProjectIndex::default())
        .manage(RootWatch::default())
        .manage(FsWatch::default())
        .manage(LspState::default())
        .manage(SessionIndex::default())
        .manage(PiIndex::default())
        .manage(SessionWatch::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            config::get_config,
            config::list_branches,
            config::list_remote_branches,
            config::config_watch_start,
            config::pick_folder,
            config::set_root,
            config::remove_root,
            config::pin_path,
            config::unpin_path,
            config::add_group,
            config::add_folder,
            config::delete_group,
            config::group_delete_preview,
            config::rediscover,
            config::roots_watch_start,
            config::cleanup_incomplete,
            config::seed_attached,
            config::attach_branch,
            config::new_branch,
            config::detach_branch,
            config::delete_branch,
            config::attach_remote_branch,
            fs::fs_read_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::file_exists,
            fs::list_project_files,
            fs::fs_watch_start,
            git::git_status,
            git::git_diff_file,
            git::git_diff_text,
            git::git_checkout,
            git::git_init,
            git::git_remote_add,
            git::git_origin,
            git::git_fetch,
            git::git_has_credential_helper,
            askpass::askpass_respond,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            sessions::list_sessions,
            sessions::sessions_watch_start,
            sessions::set_session_name,
            sessions::set_session_archived,
            sessions::delete_session,
            sessions::session_running,
            sessions::adopt_path,
            sessions::seed_adopted,
            sessions::folder_historical,
            sessions::session_detail,
            model::model_context_caps,
            launch::open_in_vscode,
            launch::open_in_ghostty,
            worktree::list_worktrees,
            worktree::create_worktree,
            worktree::worktree_dirty,
            worktree::remove_worktree,
            worktree::remove_worktree_and_branch,
            worktree::relink_worktrees,
            theme::get_theme_colors,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
