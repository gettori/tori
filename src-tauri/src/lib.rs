mod accounts;
mod agent_lines;
mod agents;
mod askpass;
mod attempts;
mod auth;
mod backstop;
mod blame;
mod chat;
mod checkpoint;
mod config;
mod conflict;
mod dap;
mod env;
mod exec;
mod features;
pub mod forge;
mod format;
mod fs;
mod git;
mod catalog_probe;
mod health;
mod hooks;
mod hot_exit;
mod icons;
mod install;
mod launch;
mod local_history;
mod lsp;
mod model;
mod onboarding;
mod owned_state;
pub mod palette;
mod patch;
mod presence;
mod pty;
mod scratch;
mod search;
mod sessions;
mod settings;
mod workspace_settings;
mod themes;
mod trace;
mod update;
mod worktree;

use chat::host::ChatState;
use config::{ConfigWatch, ProjectIndex, RootWatch};
use fs::FsWatch;
use settings::SettingsWatch;
use dap::DapState;
use lsp::LspState;
use presence::TrayState;
use pty::PtyState;
use sessions::{SessionIndex, SessionWatch, TouchedIndex};
use std::sync::Mutex;
use tauri::menu::Menu;
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{Emitter, Manager};

/// Builds the menu-bar tray icon. Split out of `.setup()` so its failure path
/// can be handled the same non-fatal way as the askpass bridge, without a
/// panic-on-missing-icon or a `?` that would abort the whole app.
fn build_tray(app: &tauri::App) -> Result<TrayIcon, Box<dyn std::error::Error>> {
    let icon = app.default_window_icon().cloned().ok_or("no default window icon configured")?;
    let empty_menu = Menu::new(app)?;
    let tray_app = app.handle().clone();
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&empty_menu)
        .tooltip("Sway")
        .on_menu_event(move |_tray, event| {
            presence::handle_tray_menu_event(&tray_app, event.id.as_ref());
        })
        .build(app)?;
    Ok(tray)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Same-binary re-exec as the askpass helper: git/ssh invoke this exe with the
    // socket marker env set. Detect it and run the stdout-answer-only helper path
    // *before* any Tauri/AppKit init, then exit. The app's own process never has
    // the marker (it is set only on the git child command).
    if askpass::is_helper() {
        std::process::exit(askpass::run_helper());
    }

    // Same re-exec trick for the chat approval hook: `claude` runs this binary
    // as its `PreToolUse` hook with the socket markers set inline on the command
    // string. Checked before any Tauri/AppKit init, because this path runs on
    // every single tool call and must stay cheap.
    if chat::approval::is_helper() {
        std::process::exit(chat::approval::run_helper());
    }

    // Before the builder: the invoke wrapper and `trace_config` both read the
    // flag, and the frontend asks for it on its first frame.
    trace::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // The traffic lights are the system's own. They used to be hidden here
            // so the web layer could draw three smaller dots, which cost every
            // behaviour AppKit attaches to the real buttons: the Move & Resize /
            // Fill & Arrange tiling menu on hover, the option-click variants
            // (close all, minimize all, zoom), the hover glyphs, the dimming that
            // says which window is focused, and the accessibility affordances.
            // None of that is reachable from the web layer, so the buttons stay
            // native and `trafficLightPosition` in tauri.conf.json places them.
            // The topbar reserves their space (WindowControls) and is pinned to a
            // fixed height, since that inset is a constant the UI scale must not
            // move out from under.

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

            // Menu-bar tray (Finding F3/presence): starts empty (no sessions
            // yet at launch) - the frontend calls `update_tray` once presence
            // state exists. Menu-item clicks (a session's own id) fan out as
            // `tray://focus-session` for the frontend to focus that tab.
            // Non-fatal like the askpass bridge above: a tray is a presence
            // nice-to-have, not something a startup failure should take the
            // whole app down over.
            match build_tray(app) {
                Ok(tray) => {
                    app.manage(TrayState(Mutex::new(tray)));
                }
                Err(e) => eprintln!("sway: tray icon failed to start: {e}"),
            }

            // Sweep leftover claude hook-status files (Phase 3): a stale
            // marker from a crashed or hook-less-resumed session must not
            // pin a dot at a status that no longer reflects reality. Cheap
            // no-op when hooks-status is empty/missing.
            let session_index = app.state::<SessionIndex>();
            hooks::prune_stale(|| sessions::all_sessions(&session_index));

            // Chat claims left by a previous run. A record whose Sway is gone is
            // either litter (dropped here) or an orphan: a `claude` child that
            // outlived the app and is still writing to a transcript. Orphans are
            // announced rather than killed, because ending someone's running
            // session without asking is not ours to decide - and their records
            // are kept, so the session stays unclaimable until they do.
            // Parked, not emitted: this runs before the webview has loaded, so
            // an event here would reach no listener and the orphan would block
            // its session id with nothing on screen saying why. The frontend
            // pulls them with `chat_orphans` once it is ready.
            app.state::<chat::ownership::Orphans>().set(chat::ownership::reap_on_startup());

            // Install the keychain store and restore the forge credential.
            // Non-fatal like the askpass bridge and the tray above: a keychain
            // that will not open should leave Sway signed out, not stop it
            // starting.
            forge::commands::restore_at_startup(settings::get_settings().github.enabled);

            Ok(())
        })
        .manage(forge::commands::DeviceFlowState::default())
        .manage(PtyState::default())
        .manage(ChatState::default())
        .manage(chat::ownership::Orphans::default())
        .manage(ConfigWatch::default())
        .manage(ProjectIndex::default())
        .manage(RootWatch::default())
        .manage(FsWatch::default())
        .manage(DapState::default())
        .manage(LspState::default())
        .manage(SessionIndex::default())
        .manage(SessionWatch::default())
        .manage(TouchedIndex::default())
        .manage(SettingsWatch::default())
        .manage(themes::ThemesWatch::default())
        .invoke_handler(trace::traced(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_live_ids,
            chat::commands::chat_spawn,
            chat::commands::chat_live_sessions,
            catalog_probe::model_catalogs,
            catalog_probe::refresh_model_catalog,
            attempts::create_attempt,
            attempts::promote_attempt,
            attempts::list_project_attempts,
            features::commands::list_features,
            features::commands::create_feature,
            features::commands::retry_member,
            features::commands::add_member,
            features::commands::remove_member,
            features::commands::reorder_members,
            features::commands::rename_member,
            features::commands::rename_feature,
            features::commands::delete_feature,
            features::commands::probe_feature_branch,
            chat::commands::chat_send,
            chat::commands::chat_steer,
            chat::commands::chat_interrupt,
            chat::commands::chat_set_visible,
            chat::commands::chat_respond_permission,
            chat::commands::chat_answer_question,
            chat::commands::chat_set_mode,
            chat::commands::chat_set_model,
            chat::commands::chat_set_config_option,
            chat::commands::chat_close,
            chat::commands::chat_tool_before_state,
            chat::commands::chat_tool_diff,
            chat::commands::chat_tool_output,
            chat::commands::chat_session_diff,
            chat::commands::chat_revert_tool_hunk,
            chat::commands::chat_mcp_list,
            chat::commands::chat_mcp_add,
            chat::commands::chat_mcp_remove,
            chat::commands::chat_record_usage,
            chat::commands::chat_usage_totals,
            chat::commands::chat_prompt_count,
            chat::commands::chat_session_detail,
            chat::commands::chat_history,
            chat::commands::chat_mark_turn,
            chat::commands::chat_take_interrupted_turn,
            chat::commands::chat_orphans,
            chat::commands::chat_retired_stores,
            chat::commands::chat_terminate_orphan,
            config::get_config,
            config::get_docs_root,
            config::list_branches,
            config::list_remote_branches,
            config::config_watch_start,
            config::pick_folder,
            config::set_root,
            config::remove_root,
            config::pin_path,
            config::unpin_path,
            config::add_space,
            config::set_project_icon,
            config::set_project_icon_file,
            icons::pick_icon_file,
            config::set_space_meta,
            config::set_space_order,
            config::add_folder,
            config::delete_space,
            config::remove_folder,
            config::remove_project,
            config::space_delete_preview,
            config::project_delete_preview,
            config::rediscover,
            config::roots_watch_start,
            config::cleanup_incomplete,
            config::seed_attached,
            config::attach_branch,
            config::new_branch,
            config::detach_branch,
            config::delete_branch,
            config::attach_remote_branch,
            format::format_document,
            fs::fs_read_dir,
            fs::fs_read_dir_compact,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::file_exists,
            fs::fs_write_files,
            fs::fs_mkdir,
            fs::fs_delete,
            fs::fs_rename,
            fs::list_project_files,
            fs::fs_watch_start,
            search::grep_project,
            search::preview_replace,
            search::replace_in_files,
            search::apply_line_edits,
            git::git_status,
            git::git_diff_file,
            git::git_diff_text,
            git::git_apply_hunks,
            git::git_apply_lines,
            git::git_file_slice,
            git::git_blob_slice,
            git::git_fetch_pr_head,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_head_message,
            git::git_log,
            git::git_head_sha,
            blame::git_blame,
            agent_lines::agent_lines,
            conflict::git_conflict_stages,
            conflict::git_conflict_op,
            conflict::git_conflict_resolve,
            git::git_commit_detail,
            git::git_commit_file_diff,
            git::git_checkout,
            git::git_init,
            git::bare_init,
            git::git_remote_add,
            git::git_origin,
            git::git_fetch,
            git::git_push,
            git::git_ahead_behind,
            git::git_default_base_branch,
            git::delete_remote_branch,
            git::git_has_credential_helper,
            askpass::askpass_respond,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_stop_all,
            lsp::lsp_registry,
            lsp::lsp_schema_associations,
            lsp::lsp_schema_dir,
            lsp::lsp_health,
            dap::dap_start,
            dap::dap_connect,
            dap::dap_send,
            dap::dap_stop,
            dap::dap_stop_all,
            dap::dap_registry,
            dap::dap_root_for,
            dap::dap_launch_env,
            dap::dap_health,
            agents::list_agents,
            health::agent_health,
            health::refresh_agent_health,
            accounts::agent_accounts,
            accounts::agent_account_counts,
            accounts::add_agent_account,
            accounts::remove_agent_account,
            accounts::rename_agent_account,
            install::agent_install_route,
            install::agent_update_route,
            install::agent_uninstall_route,
            accounts::sign_out_agent_account,
            auth::agent_login_route,
            onboarding::onboarding_should_show,
            onboarding::onboarding_content,
            onboarding::onboarding_mark_shown,
            hot_exit::hot_exit_load,
            hot_exit::hot_exit_save,
            scratch::scratch_dir,
            scratch::scratch_new,
            update::check_for_update,
            update::open_releases_page,
            sessions::list_sessions,
            sessions::sessions_watch_start,
            sessions::set_session_name,
            sessions::delete_session,
            sessions::session_running,
            sessions::session_running_elsewhere,
            sessions::sessions_running,
            sessions::adopt_path,
            sessions::seed_adopted,
            sessions::folder_historical,
            sessions::session_detail,
            sessions::session_touched_files,
            sessions::session_editing_now,
            sessions::session_tail_state,
            sessions::session_prompt_tail,
            checkpoint::checkpoint_snapshot,
            checkpoint::checkpoint_note_touched,
            checkpoint::checkpoint_list,
            checkpoint::checkpoint_turn_files,
            checkpoint::checkpoint_diff_file,
            checkpoint::checkpoint_revert_file,
            checkpoint::checkpoint_revert_tree,
            checkpoint::checkpoint_prune,
            local_history::local_history_note,
            local_history::local_history_list,
            local_history::local_history_read,
            local_history::local_history_diff,
            local_history::local_history_restore,
            local_history::local_history_rename,
            local_history::local_history_forget,
            local_history::local_history_prune,
            git::git_discard_hunks,
            git::git_discard_files,
            git::git_stash_list,
            git::git_stash_push,
            git::git_stash_apply,
            git::git_stash_drop,
            backstop::backstop_take,
            backstop::backstop_available,
            backstop::backstop_list,
            backstop::backstop_restore_tree,
            backstop::backstop_restore_file,
            backstop::backstop_prune,
            hooks::agent_hook_launch_args,
            hooks::hooks_status_prune,
            presence::update_tray,
            presence::set_badge_count,
            model::model_context_caps,
            launch::open_in_vscode,
            launch::open_in_ghostty,
            worktree::list_worktrees,
            worktree::create_worktree,
            worktree::worktree_dirty,
            worktree::worktree_status,
            worktree::branch_status,
            worktree::remove_worktree,
            worktree::remove_worktree_and_branch,
            forge::commands::github_auth_state,
            forge::commands::github_is_configured,
            forge::commands::github_device_start,
            forge::commands::github_device_poll,
            forge::commands::github_device_cancel,
            forge::commands::github_sign_out,
            forge::commands::github_pr_for_branch,
            forge::commands::github_create_pr,
            forge::commands::github_push_and_create_pr,
            forge::commands::github_unit_statuses,
            forge::commands::github_list_prs,
            forge::commands::github_pr_files,
            forge::commands::github_review_threads,
            forge::commands::github_reply_to_thread,
            forge::commands::github_set_thread_resolved,
            forge::commands::github_viewer,
            forge::commands::github_submit_review,
            forge::commands::github_mergeability,
            forge::commands::github_merge,
            forge::commands::github_update_branch,
            settings::get_settings,
            settings::set_settings,
            workspace_settings::get_workspace_settings,
            workspace_settings::set_workspace_settings,
            settings::settings_watch_start,
            settings::take_theme_import_notice,
            themes::list_user_themes,
            themes::themes_watch_start,
            trace::trace_config,
            trace::trace_write,
            trace::trace_quit,
        ]))
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // `build` + a run callback rather than `run`, so app exit can be
        // observed. A `claude` child holds its own stdin and would otherwise
        // outlive the window that started it: still writing to the transcript,
        // still holding its session id unclaimable on the next launch.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<ChatState>().0.shutdown();
                // And every debug adapter. A language server is a plain child
                // and goes with the process; an adapter is deliberately put in
                // its own process group so that killing it takes the debuggee
                // down, which also means quitting does not reach it.
                app.state::<DapState>().shutdown();
            }
        });
}
