mod config;
mod pty;

use config::ConfigWatch;
use pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(ConfigWatch::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            config::get_config,
            config::list_branches,
            config::config_watch_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
