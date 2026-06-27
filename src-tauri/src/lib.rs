mod config;
mod pty;
mod sessions;

use config::ConfigWatch;
use pty::PtyState;
use sessions::{SessionIndex, SessionWatch};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(ConfigWatch::default())
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
            sessions::list_sessions,
            sessions::sessions_watch_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
