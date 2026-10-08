mod account_commands;
mod accounts;
mod agent_config;
mod agent_lines;
mod agent_plugins;
mod agents;
mod askpass;
mod attachments;
mod attempts;
mod auth;
mod autopilot;
mod backstop;
mod blame;
mod blind_edit;
mod catalog_probe;
mod chat;
mod checkpoint;
mod cli;
mod config;
mod conflict;
mod crash;
mod credential;
mod dap;
mod dragboard;
mod editorconfig;
mod env;
mod exec;
pub mod forge;
mod format;
mod fs;
mod git;
mod git_health;
mod health;
mod hooks;
mod hot_exit;
mod icons;
mod install;
mod issues;
mod launch;
mod local_history;
mod lsp;
mod mcp;
mod model;
mod onboarding;
mod owned_state;
pub mod palette;
mod patch;
#[cfg(test)]
mod perf_budgets;
mod presence;
mod provenance;
mod pty;
mod rpc;
mod scratch;
mod search;
mod secret_watch;
mod sessions;
mod settings;
mod setup;
mod shared;
mod sound;
mod themes;
mod topic_home;
mod topics;
mod trace;
mod trust;
mod unit_home;
mod update;
mod usage_probe;
mod usage_snapshot;
mod usage_token;
mod verification;
mod workspace_settings;
mod worktree;
mod worktree_cleanup;

use chat::host::ChatState;
use config::{ConfigWatch, ProjectIndex, RootWatch};
use dap::DapState;
use fs::FsWatch;
use lsp::LspState;
use presence::TrayState;
use pty::PtyState;
use sessions::{SessionIndex, SessionWatch, TouchedIndex};
use settings::SettingsWatch;
use std::sync::{Arc, Mutex};
use tauri::menu::Menu;
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{Emitter, Manager};

/// Builds the menu-bar tray icon. Split out of `.setup()` so its failure path
/// can be handled the same non-fatal way as the askpass bridge, without a
/// panic-on-missing-icon or a `?` that would abort the whole app.
fn build_tray(app: &tauri::App) -> Result<TrayIcon, Box<dyn std::error::Error>> {
    // A template image (black on transparent), not the app icon: macOS paints
    // it black or white to match the menu bar and dims it when the bar is
    // inactive, which the coloured mark would never do.
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let empty_menu = Menu::new(app)?;
    let tray_app = app.handle().clone();
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&empty_menu)
        .tooltip("Tori")
        .on_menu_event(move |_tray, event| {
            presence::handle_tray_menu_event(&tray_app, event.id.as_ref());
        })
        .build(app)?;
    Ok(tray)
}

/// WebKit's text checking is a user default, not a menu item or an element
/// attribute: continuous spell check on, and the smart dash, quote and text
/// substitutions off, since `--` and straight quotes are what a prompt means.
/// Grammar off too: spelling is the only check a prompt wants.
#[cfg(target_os = "macos")]
fn set_webkit_text_defaults() {
    use objc2_foundation::{NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    for (key, on) in [
        ("WebContinuousSpellCheckingEnabled", true),
        ("WebGrammarCheckingEnabled", false),
        ("WebAutomaticDashSubstitutionEnabled", false),
        ("WebAutomaticQuoteSubstitutionEnabled", false),
        ("WebAutomaticTextReplacementEnabled", false),
    ] {
        defaults.setBool_forKey(on, &NSString::from_str(key));
    }
}

/// macOS 26 draws a plain `.icns` shrunk onto a system tile, in the Dock and in
/// Finder alike. An icon set on the running app is drawn as-is (VLC's bare cone
/// is this call), and Tauri makes it only in dev, so the release build repeats it.
#[cfg(target_os = "macos")]
fn set_dock_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(include_bytes!("../icons/icon.icns"));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&icon)) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Same-binary re-exec as the askpass helper: git/ssh invoke this exe with the
    // socket marker env set. Detect it and run the stdout-answer-only helper path
    // *before* any Tauri/AppKit init, then exit. The app's own process never has
    // the marker (it is set only on the git child command).
    if credential::is_helper() {
        // Before the askpass check, not after: git runs its credential helper
        // with the whole environment of the op, askpass markers included, so
        // the argv marker is the only thing telling the two modes apart.
        std::process::exit(credential::run_helper());
    }

    // Ahead of the env markers, which a `tori` run from a git hook inherits.
    if cli::is_cli() {
        std::process::exit(cli::run());
    }

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

    // Before the builder, so a panic in setup is on disk too.
    crash::install();

    // Before the builder: the invoke wrapper and `trace_config` both read the
    // flag, and the frontend asks for it on its first frame.
    trace::init();

    // The persistent domain, written before the webview exists: WebKit reads
    // these once, at its first text-checker use, and registers its own
    // defaults underneath, so a registration-domain write would lose.
    #[cfg(target_os = "macos")]
    set_webkit_text_defaults();

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
                    credential::publish(inner.sock_path(), inner.credential_token(), inner.everywhere_token());
                    app.manage(askpass::AskpassState(inner));
                }
                Err(e) => eprintln!("tori: askpass bridge failed to start: {e}"),
            }

            setup::set_publisher(app.handle().clone());

            // The app level socket the CLI and MCP fronts talk to. Fail-soft like
            // the askpass bridge: without it Tori runs, nothing outside can ask.
            match rpc::start(app.handle().clone()) {
                Ok(state) => {
                    let (hub, autopilot) = (state.hub.clone(), state.autopilot.clone());
                    let handle = app.handle().clone();
                    app.state::<ChatState>().0.set_publisher(Arc::new(move |id, data| {
                        let compacted = (data["kind"] == "session.compacted").then(|| data["trigger"] == "auto");
                        rpc::publish_session(&hub, &autopilot, id, data);
                        if let Some(mid_turn) = compacted {
                            rpc::retell_topic(&handle, id, mid_turn);
                        }
                    }));
                    let runner = state.runner.clone();
                    app.manage(state);
                    runner.autostart();
                }
                Err(e) => eprintln!("tori: rpc socket failed to start: {e}"),
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
                Err(e) => eprintln!("tori: tray icon failed to start: {e}"),
            }

            // Sweep leftover claude hook-status files (Phase 3): a stale
            // marker from a crashed or hook-less-resumed session must not
            // pin a dot at a status that no longer reflects reality. Cheap
            // no-op when hooks-status is empty/missing.
            let session_index = app.state::<SessionIndex>();
            hooks::prune_stale(|| sessions::all_sessions(&session_index));

            // At launch, not at the first gated open: a repo cloned between the
            // two would otherwise be swept into the seed and start trusted.
            trust::seed();

            // Chat claims left by a previous run. A record whose Tori is gone is
            // either litter (dropped here) or an orphan: a `claude` child that
            // outlived the app and is still writing to a transcript. Orphans are
            // announced rather than killed, because ending someone's running
            // session without asking is not ours to decide - and their records
            // are kept, so the session stays unclaimable until they do.
            // Parked, not emitted: this runs before the webview has loaded, so
            // an event here would reach no listener and the orphan would block
            // its session id with nothing on screen saying why. The frontend
            // pulls them with `chat_orphans` once it is ready.
            app.state::<chat::ownership::Orphans>()
                .set(chat::ownership::reap_on_startup());

            // A command tab takes its PATH from this without waiting, so the
            // probe has to have started before the first one opens.
            std::thread::spawn(|| {
                env::login_path();
            });

            std::thread::spawn(account_commands::sync_quietly);

            // Install the keychain store and restore the forge credential.
            // Non-fatal like the askpass bridge and the tray above: a keychain
            // that will not open should leave Tori signed out, not stop it
            // starting.
            forge::commands::restore_at_startup(settings::get_settings().forge.enabled);

            // Tori's git config file names this binary, which may have moved
            // since it was written.
            std::thread::spawn(forge::commands::resync_global_config);

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
            pty::pty_busy_ids,
            chat::commands::chat_spawn,
            chat::commands::chat_live_sessions,
            attachments::store_attachment,
            attachments::attachments_dir,
            catalog_probe::model_catalogs,
            catalog_probe::refresh_model_catalog,
            catalog_probe::record_live_catalog,
            usage_snapshot::usage_snapshot_load,
            usage_snapshot::usage_snapshot_save,
            usage_probe::usage_probe_codex,
            usage_token::usage_token_claude,
            attempts::create_attempt,
            attempts::promote_attempt,
            attempts::list_project_attempts,
            topics::commands::list_topics,
            topics::commands::create_topic,
            topics::commands::retry_member,
            topics::commands::add_member,
            topics::commands::promote_member,
            topics::commands::demote_member,
            topics::commands::relocate_member,
            topics::commands::remove_member,
            topics::commands::reorder_members,
            topics::commands::rename_member,
            topics::commands::rename_topic,
            topics::commands::set_topic_promotion,
            topics::commands::delete_topic,
            topics::commands::probe_topic_branch,
            chat::commands::chat_send,
            chat::commands::chat_steer,
            chat::commands::chat_queue_load,
            chat::commands::chat_queue_save,
            chat::commands::stash_list,
            chat::commands::stash_push,
            chat::commands::stash_take,
            chat::commands::stash_discard,
            chat::commands::chat_grant_dirs,
            chat::commands::chat_interrupt,
            chat::commands::chat_send_held,
            chat::commands::chat_set_visible,
            chat::commands::chat_respond_permission,
            chat::commands::chat_answer_question,
            chat::commands::chat_waiting,
            chat::commands::chat_set_mode,
            chat::commands::chat_set_model,
            chat::commands::chat_set_config_option,
            chat::commands::chat_close,
            chat::commands::chat_detach,
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
            chat::commands::chat_history_page,
            chat::commands::session_secrets,
            chat::commands::session_verification,
            verification::verification_commands,
            chat::commands::chat_mark_turn,
            chat::commands::chat_take_interrupted_turn,
            chat::commands::chat_orphans,
            chat::commands::chat_retired_stores,
            chat::commands::chat_terminate_orphan,
            config::get_config,
            config::project_of_folder,
            config::list_branches,
            config::list_remote_branches,
            config::repo_default_branch,
            config::config_watch_start,
            config::pick_folder,
            config::set_root,
            config::remove_root,
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
            format::formatter_health,
            fs::fs_read_dir,
            fs::fs_read_dir_compact,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::file_exists,
            fs::fs_is_dir,
            dragboard::drag_paths,
            fs::fs_mtime_ms,
            fs::fs_file_size,
            editorconfig::editorconfig_indent,
            fs::fs_write_files,
            fs::fs_mkdir,
            fs::fs_delete,
            fs::fs_rename,
            fs::fs_copy,
            fs::list_project_files,
            fs::fs_watch_start,
            fs::fs_watch_set,
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
            git::git_blob_sizes,
            git::git_fetch_pr_head,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_head_message,
            git::git_log,
            git::git_branch_paths,
            git::git_diff_stat,
            git::git_worktree_stat,
            shared::shared_overview,
            shared::shared_drift,
            shared::shared_link,
            shared::shared_plan,
            shared::shared_add,
            shared::shared_keep_in,
            shared::shared_remove,
            shared::shared_unlink,
            git::git_head_sha,
            git::git_base_offset,
            blame::git_blame,
            agent_lines::agent_lines,
            provenance::diff_provenance,
            provenance::checkpoint_provenance,
            provenance::pr_provenance,
            conflict::git_conflict_stages,
            conflict::git_conflict_op,
            conflict::git_conflict_sides,
            conflict::git_conflict_resolve,
            git::git_commit_detail,
            git::git_commit_file_diff,
            git::git_checkout,
            git::git_init,
            git::bare_init,
            git::git_remote_add,
            git::git_origin,
            git::git_fetch,
            git::git_fetch_quiet,
            git::git_push,
            git::git_ahead_behind,
            git::git_branch_sync,
            git::git_branch_sync_many,
            git::git_pr_relation,
            git::git_default_base_branch,
            git::delete_remote_branch,
            git::git_has_credential_helper,
            askpass::askpass_respond,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_stop_all,
            lsp::lsp_log,
            lsp::lsp_registry,
            lsp::lsp_schema_associations,
            lsp::lsp_schema_dir,
            lsp::lsp_health,
            lsp::lsp_resolve,
            lsp::lsp_install,
            lsp::lsp_uninstall,
            trust::trusted_projects,
            trust::untrusted_projects,
            trust::trust_project,
            trust::revoke_project,
            dap::dap_start,
            dap::dap_connect,
            dap::dap_send,
            dap::dap_stop,
            dap::dap_stop_all,
            dap::dap_registry,
            dap::dap_root_for,
            dap::dap_launch_env,
            dap::dap_python,
            dap::dap_health,
            dap::dap_install,
            dap::dap_uninstall,
            dap::dap_cargo_bins,
            dap::dap_cargo_build,
            dap::dap_cargo_cancel,
            dap::dap_pick_program,
            agents::list_agents,
            health::agent_health,
            health::refresh_agent_health,
            git_health::git_health,
            git_health::refresh_git_health,
            accounts::agent_accounts,
            accounts::agent_account_counts,
            accounts::profile_spawn_env,
            accounts::add_agent_account,
            accounts::pick_account_folder,
            accounts::remove_agent_account,
            accounts::rename_agent_account,
            install::agent_install_route,
            install::agent_update_route,
            install::agent_uninstall_route,
            accounts::sign_out_agent_account,
            accounts::complete_sign_in,
            auth::agent_login_route,
            onboarding::first_run_state,
            onboarding::first_run_mark_intro_seen,
            onboarding::first_run_forget_intro,
            hot_exit::hot_exit_load,
            hot_exit::hot_exit_save,
            scratch::scratch_dir,
            scratch::scratch_new,
            scratch::scratch_remove,
            update::check_for_update,
            update::open_releases_page,
            update::relaunch,
            crash::record_webview_error,
            crash::crash_logs,
            crash::open_crash_issue,
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
            sessions::session_prompts,
            checkpoint::checkpoint_snapshot,
            checkpoint::checkpoint_note_touched,
            checkpoint::checkpoint_list,
            checkpoint::checkpoint_sessions,
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
            git::git_pull,
            git::git_merge,
            git::git_rebase,
            git::git_abort,
            git::git_undo_last_commit,
            git::git_continue,
            git::git_skip,
            git::git_rebase_plan,
            git::git_rebase_interactive,
            git::git_rebase_autosquash,
            git::git_reset_to_upstream,
            git::git_branch_create,
            git::git_branch_rename,
            git::git_branch_delete,
            backstop::backstop_take,
            backstop::backstop_available,
            backstop::backstop_list,
            backstop::backstop_files,
            backstop::backstop_diff_file,
            backstop::backstop_restore_tree,
            backstop::backstop_restore_file,
            backstop::backstop_prune,
            hooks::agent_hook_launch_args,
            hooks::hooks_status_prune,
            rpc::rpc_session_facts,
            rpc::rpc_attention,
            rpc::session_dots,
            rpc::rpc_quota,
            rpc::pr_watch_list,
            rpc::pr_watch_start,
            rpc::pr_watch_stop,
            rpc::rpc_reply,
            rpc::rpc_asks_pending,
            rpc::rpc_ask_answer,
            rpc::autopilot_start,
            rpc::remote_set,
            rpc::remote_status,
            rpc::remote_interfaces,
            rpc::remote_tailscale,
            rpc::tailscale_open,
            rpc::pairing_start,
            rpc::pairing_cancel,
            rpc::devices_list,
            rpc::device_revoke,
            rpc::autopilot_stop,
            rpc::autopilot_status,
            rpc::autopilot_locked,
            rpc::autopilot_closed_by_hand,
            rpc::autopilot_state,
            rpc::autopilot_log,
            rpc::autopilot_pickup,
            rpc::autopilot_contracts,
            rpc::autopilot_project_set,
            model::model_context_caps,
            agent_config::agent_config_files,
            agent_config::agent_config_new,
            agent_config::agent_config_delete,
            agent_plugins::agent_plugins,
            launch::reveal_in_finder,
            worktree::list_worktrees,
            worktree::create_worktree,
            worktree::worktree_dirty,
            worktree::worktree_status,
            worktree::branch_status,
            worktree::remove_worktree,
            worktree::prune_worktree_records,
            worktree::remove_worktree_and_branch,
            worktree_cleanup::worktree_cleanup_facts,
            forge::commands::forge_accounts,
            forge::commands::forge_sign_in_start,
            forge::commands::forge_cli_installed,
            forge::commands::forge_set_app_id,
            forge::commands::forge_set_git_credentials,
            forge::commands::forge_set_git_everywhere,
            forge::commands::forge_set_default_account,
            forge::commands::forge_device_poll,
            forge::commands::forge_device_cancel,
            forge::commands::forge_add_token,
            forge::commands::forge_remove_account,
            forge::commands::forge_repo_account,
            forge::commands::forge_pick_account,
            forge::commands::forge_pr_for_branch,
            forge::commands::forge_create_pr,
            forge::commands::forge_push_and_create_pr,
            forge::commands::forge_unit_statuses,
            forge::commands::pr_watch_polled,
            forge::commands::forge_list_prs,
            forge::commands::forge_pr_files,
            forge::commands::forge_review_threads,
            forge::commands::forge_reply_to_thread,
            forge::commands::forge_set_thread_resolved,
            forge::commands::forge_viewer,
            forge::commands::forge_submit_review,
            forge::commands::forge_add_review_comment,
            forge::commands::forge_pr_summary,
            forge::commands::forge_get_pr,
            forge::commands::forge_merge,
            forge::commands::forge_update_branch,
            forge::commands::forge_reopen,
            issues::commands::issues_source,
            issues::commands::issues_assigned,
            issues::commands::issues_get,
            issues::commands::issues_link,
            issues::commands::issues_record,
            settings::get_settings,
            settings::set_settings,
            sound::sound_preview,
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
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Ready = event {
                set_dock_icon();
            }
            if let tauri::RunEvent::Exit = event {
                credential::unpublish();
                app.state::<ChatState>().0.shutdown();
                // And every debug adapter. A language server is a plain child
                // and goes with the process; an adapter is deliberately put in
                // its own process group so that killing it takes the debuggee
                // down, which also means quitting does not reach it.
                app.state::<DapState>().shutdown();
                if let Some(rpc) = app.try_state::<rpc::RpcState>() {
                    rpc.shutdown();
                }
            }
        });
}
