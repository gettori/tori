//! The Tauri surface of the chat host.
//!
//! Thin by design: every command resolves an adapter, checks ownership, and
//! hands off. The rules all live in `ownership.rs` and `host.rs` where they are
//! testable without a Tauri app, following the same split
//! [[lesson_pure_core_for_global_stores]] describes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::State;

use crate::agents::{self, ChatConfig, ChatTransport};

use super::approval::{self, ApprovalPrompt, HookResponse};
use super::claude_transport::ClaudeTransport;
use super::host::{ChatState, SessionBridge, Spawned};
use super::rules;
use super::snapshot::{self, SnapshotCache, CACHE_CAP};
use super::model::{ChatEvent, ContentBlock, Effort, PermissionDecision, PermissionMode, PermissionScope};
use super::ownership::{Claim, ClaimOutcome, Orphans, Reaped, Surface};
use super::transport::{AgentTransport, StartSpec};

/// Build a transport for a declared wire protocol.
///
/// **This is the extension point for a second harness.** The `match` is
/// exhaustive over [`ChatTransport`], so adding a variant fails to compile here
/// until a transport exists for it - which is the point: a TOML able to name a
/// transport with no implementation would be a runtime error instead of a build
/// one. `ChatTransport::as_str` is exhaustive for the same reason on the
/// serialization side; between them a new harness has exactly two compiler-named
/// obligations and no silent ones.
fn make_transport(transport: ChatTransport, session_id: &str) -> Box<dyn AgentTransport> {
    match transport {
        ChatTransport::ClaudeStreamJson => Box::new(ClaudeTransport::new(session_id)),
    }
}

/// The argument vector for one chat session.
///
/// Pure, so the composition order is assertable without spawning anything.
/// Order is load-bearing: the base args carry the stream-json protocol flags and
/// everything after them selects behaviour, so a later `--model` cannot be
/// swallowed by a flag that takes a value.
pub fn build_args(
    chat: &ChatConfig,
    session_id: &str,
    resume: bool,
    model: Option<&str>,
    mode: Option<&str>,
    effort: Option<&str>,
    extra_dirs: &[String],
) -> Vec<String> {
    let mut args = chat.base_args.clone();
    // `--session-id` creates the id, `--resume` attaches to an existing one.
    // Passing both would be contradictory, so this is an either/or.
    let id_template = if resume { &chat.resume_args } else { &chat.session_id_args };
    args.extend(agents::apply_chat_template(id_template, &[("id", session_id)]));
    if let Some(model) = model {
        args.extend(chat.model_args_for(model).unwrap_or_default());
    }
    if let Some(mode) = mode {
        args.extend(chat.mode_args_for(mode).unwrap_or_default());
    }
    if let Some(effort) = effort {
        args.extend(chat.effort_args_for(effort).unwrap_or_default());
    }
    for dir in extra_dirs {
        args.extend(agents::apply_chat_template(&chat.add_dir_args, &[("dir", dir)]));
    }
    args
}

/// The result of asking to open a chat session.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    /// How the claim resolved. A refusal is a normal answer here, not an error:
    /// the frontend focuses the holding tab or offers the fork/read-only path,
    /// which it cannot do from an error string.
    pub ownership: ClaimOutcome,
    /// `None` when ownership was refused, so nothing was started.
    pub spawned: Option<Spawned>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_spawn(
    state: State<'_, ChatState>,
    session_id: String,
    tab_id: String,
    agent_id: String,
    cwd: String,
    resume: bool,
    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
    extra_dirs: Vec<String>,
    on_event: Channel<ChatEvent>,
) -> Result<SpawnResult, String> {
    let adapter = agents::find(&agent_id).ok_or_else(|| format!("unknown agent {agent_id}"))?;
    let chat = adapter
        .chat
        .as_ref()
        .ok_or_else(|| format!("{} has no chat transport", adapter.label))?;

    // A re-subscribe must not go through the claim at all: the session is
    // already ours, and re-claiming would report `AlreadyMineFocus` and refuse to
    // rewire the tab that is asking.
    let host = &state.0;
    let live = host.is_live(&session_id);

    // **A remount rewires and stops.** Everything below builds a *new* approval
    // bridge, and the running child cannot be told about it: the socket path it
    // will call went into its `--settings` at launch and is fixed for the life of
    // the process. Falling through would install a second server, tear the live
    // one down (denying whatever was blocked and deleting the session's rules),
    // and leave the child talking to a socket that had just been shut down -
    // approvals silently broken for the rest of the session.
    if live {
        let spawned = host.spawn(
            &session_id,
            &tab_id,
            Box::new(move |event| {
                let _ = on_event.send(event);
            }),
            StartSpec::default(),
            // Never called: the session is live, so `spawn` takes the rewire
            // path and returns before it would need a transport.
            || unreachable!("a live session rewires rather than spawning"),
        )?;
        return Ok(SpawnResult { ownership: ClaimOutcome::Granted { contested: false }, spawned: Some(spawned) });
    }

    let ownership = {
        let want = Claim {
            surface: Surface::Chat,
            tab_id: tab_id.clone(),
            child_pid: None,
            sway_pid: std::process::id(),
            agent: agent_id.clone(),
        };
        let outcome = host.registry.claim(&session_id, want);
        if !matches!(outcome, ClaimOutcome::Granted { .. }) {
            return Ok(SpawnResult { ownership: outcome, spawned: None });
        }
        // Carried through rather than rebuilt: a granted-but-**contested** claim
        // means a `claude` we do not control is resuming this same id, and its
        // transcript can end up recording a conversation that never happened.
        // Flattening it back to `contested: false` here would detect that and
        // then say nothing, which is worse than not checking.
        outcome
    };

    // The approval socket has to exist before the child does: its path travels
    // in the `--settings` payload the child is launched with.
    let snapshots = Arc::new(Mutex::new(SnapshotCache::new(CACHE_CAP)));
    let emitter = host.emitter();
    let repo = PathBuf::from(&cwd);
    let capture_into = snapshots.clone();
    let server = approval::start(
        Box::new(move |p: ApprovalPrompt| {
            emitter(
                &p.session_id,
                ChatEvent::PermissionRequest {
                    session_id: p.session_id.clone(),
                    tool_use_id: p.tool_use_id,
                    tool_name: p.tool_name,
                    input: p.input,
                    request_id: p.request_id,
                    auto_deny_at_ms: Some(p.auto_deny_at_ms),
                },
            );
        }),
        // Runs on every authenticated call, before any decision, so a file's
        // prior content is captured while it still *is* the prior content.
        Box::new(move |req| {
            let captured = snapshot::capture_all(&repo, &req.tool_name, &req.tool_input);
            if !captured.is_empty() {
                if let Ok(mut cache) = capture_into.lock() {
                    cache.insert(&req.tool_use_id, captured);
                }
            }
        }),
    )
    .map_err(|e| format!("could not start the approval bridge: {e}"))?;

    // The project's durable rules become this session's compiled file before the
    // child exists, so an "always allow in this project" from an earlier chat is
    // in force on this one's very first tool call rather than from its second.
    compile_project_rules(&session_id, &cwd)?;
    // A fresh stamp before the child starts, so its very first tool call sees a
    // supervised rules file rather than a stale one.
    approval::refresh_stamp(&session_id);
    let mut args = build_args(
        chat,
        &session_id,
        resume,
        model.as_deref(),
        mode.as_deref(),
        effort.as_deref(),
        &extra_dirs,
    );
    args.extend(approval::settings_args(&session_id, server.sock_path(), server.token())?);

    let spec = StartSpec {
        session_id: session_id.clone(),
        cwd,
        program: chat.program.clone(),
        args,
        // Empty today. The map exists so multi-account support later changes
        // this one line rather than every signature between here and the child.
        env: HashMap::new(),
    };

    let transport = chat.transport;
    let id_for_factory = session_id.clone();
    let spawned = host.spawn(
        &session_id,
        &tab_id,
        Box::new(move |event| {
            let _ = on_event.send(event);
        }),
        spec,
        move || make_transport(transport, &id_for_factory),
    );
    let spawned = match spawned {
        Ok(s) => s,
        Err(e) => {
            // The socket outlives nothing: a child that never started has no
            // hook to serve, and leaving the server up would leak a thread and a
            // $TMPDIR directory per failed spawn.
            server.shutdown();
            return Err(e);
        }
    };
    host.install_bridge(&session_id, SessionBridge::new(server, snapshots, &session_id));

    Ok(SpawnResult { ownership, spawned: Some(spawned) })
}

#[tauri::command]
pub async fn chat_send(
    state: State<'_, ChatState>,
    session_id: String,
    blocks: Vec<ContentBlock>,
) -> Result<(), String> {
    state.0.send(&session_id, blocks)
}

#[tauri::command]
pub async fn chat_interrupt(state: State<'_, ChatState>, session_id: String) -> Result<(), String> {
    state.0.interrupt(&session_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_respond_permission(
    state: State<'_, ChatState>,
    session_id: String,
    cwd: String,
    request_id: String,
    tool_name: String,
    tool_input: serde_json::Value,
    decision: PermissionDecision,
    scope: PermissionScope,
    reason: Option<String>,
) -> Result<(), String> {
    // **The answer goes out first.** A hook process is blocked on this call, and
    // the rule below is only an optimisation for *later* ones. Persisting first
    // meant an unwritable `~/.config` returned early and left the hook unanswered
    // until the 110s auto-deny - so a call the user clicked Allow on ended up
    // denied, by a disk error.
    //
    // It goes to the blocked hook over the approval socket, not to the child's
    // stdin: `PreToolUse` is the gate, and it is what is waiting.
    state.0.resolve_permission(&session_id, &request_id, hook_response_for(decision, reason))?;

    // "Allow, and stop asking" writes a Sway-owned rule so the next matching
    // call takes the cheap path. Never written to `~/.claude/settings.json`: a
    // click in one chat pane must not change how every terminal session and
    // every other project behaves.
    if matches!(decision, PermissionDecision::Allow) && !matches!(scope, PermissionScope::Once) {
        // A failure here is reported, not swallowed: the call was allowed, but
        // the promise not to ask again was not kept, and the user is the only
        // one who can tell those apart.
        add_rule(&session_id, &cwd, &tool_name, &tool_input, scope)?;
    }
    Ok(())
}

/// One answer, as the blocked hook will emit it.
///
/// The reason is not decoration. `permissionDecisionReason` reaches the model as
/// the tool result, which is what makes "deny with feedback" a redirection ("not
/// that file, use the fixture") rather than just a refusal. A typed reason
/// therefore has to survive verbatim; the defaults exist only for the buttons
/// that carry no message.
fn hook_response_for(decision: PermissionDecision, reason: Option<String>) -> HookResponse {
    match decision {
        PermissionDecision::Allow => HookResponse::allow(reason.unwrap_or_else(|| "Allowed in Sway.".to_string())),
        PermissionDecision::Deny => HookResponse::deny(reason.unwrap_or_else(|| "Denied in Sway.".to_string())),
    }
}

/// Record an allow rule for this session.
///
/// The scope decides how wide it is, and the widths are deliberately modest: a
/// rule is created by clicking a button on one specific call, and a user
/// clicking "always allow" on `Read /proj/a.rs` means files like that one, not
/// every file on the machine.
///
///   * `Session` - this exact tool with this exact primary argument.
///   * `Project` - this tool anywhere under the session's working directory.
fn add_rule(
    session_id: &str,
    cwd: &str,
    tool_name: &str,
    tool_input: &serde_json::Value,
    scope: PermissionScope,
) -> Result<(), String> {
    let prefix = match scope {
        PermissionScope::Once => return Ok(()),
        PermissionScope::Session => rules::primary_arg(tool_name, tool_input),
        // A project rule widens a path to its directory - but **only** for a
        // tool whose primary argument really is a path. `Bash`'s is the command
        // string, and `Path::parent("git status")` is `""`, which every argument
        // starts with: one click on "always allow in this project" would have
        // allowed every shell command the session ever runs. Widening is now
        // opt-in per tool, and anything else falls back to the exact argument.
        PermissionScope::Project => match rules::path_prefix_for(tool_name, tool_input) {
            Some(dir) => Some(dir),
            None => rules::primary_arg(tool_name, tool_input),
        },
    };
    // An empty prefix matches everything, which is never what a click on one
    // specific call meant. Belt and braces behind the widening rule above.
    let prefix = prefix.filter(|p| !p.is_empty());
    let path = rules::rules_path(session_id);
    let mut file = rules::load(&path).unwrap_or(rules::RuleFile {
        sway_pid: std::process::id(),
        stamp_ms: rules::now_ms(),
        rules: Vec::new(),
    });
    let rule = rules::Rule { tool: tool_name.to_string(), prefix };
    if !file.rules.contains(&rule) {
        file.rules.push(rule.clone());
    }
    file.sway_pid = std::process::id();
    file.stamp_ms = rules::now_ms();
    rules::save(&path, &file)?;

    // A project rule also lands in the durable store. Without this it would live
    // only in the session file, which is a compiled artefact deleted at
    // teardown - so "always allow in this project" would quietly mean "until
    // this tab closes", which is not what the button says.
    if matches!(scope, PermissionScope::Project) {
        let project_path = rules::project_rules_path(cwd);
        let mut project = rules::load_project(&project_path);
        if !project.rules.contains(&rule) {
            project.rules.push(rule);
            rules::save_project(&project_path, &project)?;
        }
    }
    Ok(())
}

/// Seed a session's compiled rule file from the project's durable one.
fn compile_project_rules(session_id: &str, cwd: &str) -> Result<(), String> {
    let project = rules::load_project(&rules::project_rules_path(cwd));
    let path = rules::rules_path(session_id);
    let existing = rules::load(&path);
    // Nothing to compile and nothing already there: leave the disk alone rather
    // than writing an empty file the helper would have to read on every call.
    if project.rules.is_empty() && existing.is_none() {
        return Ok(());
    }
    let compiled = rules::compiled(&project, existing.as_ref(), std::process::id(), rules::now_ms());
    rules::save(&path, &compiled)
}

/// One allow rule as the UI lists it: what it covers, and which store it lives
/// in, because removing it has to reach that store.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedRule {
    pub tool: String,
    pub prefix: Option<String>,
    pub scope: PermissionScope,
}

/// Every rule in force for this session, project-scoped ones marked as such.
///
/// Read from the compiled session file, which is the file the hook helper
/// actually consults, so the list is what is really in effect rather than a
/// second opinion about it.
#[tauri::command]
pub async fn chat_list_rules(session_id: String, cwd: String) -> Result<Vec<ScopedRule>, String> {
    let project = rules::load_project(&rules::project_rules_path(&cwd));
    let session = rules::load(&rules::rules_path(&session_id)).map(|f| f.rules).unwrap_or_default();
    Ok(session
        .into_iter()
        .map(|r| ScopedRule {
            scope: if project.rules.contains(&r) { PermissionScope::Project } else { PermissionScope::Session },
            tool: r.tool,
            prefix: r.prefix,
        })
        .collect())
}

/// Revoke a rule, so the next matching call prompts again.
///
/// Removed from both stores unconditionally: leaving it in the durable project
/// file would make it reappear in the next chat opened on this folder, which
/// reads as the revoke not having worked.
#[tauri::command]
pub async fn chat_remove_rule(
    session_id: String,
    cwd: String,
    tool: String,
    prefix: Option<String>,
) -> Result<(), String> {
    let target = rules::Rule { tool, prefix };

    let path = rules::rules_path(&session_id);
    if let Some(mut file) = rules::load(&path) {
        file.rules.retain(|r| r != &target);
        // The stamp is refreshed with the write, so the helper's next read is
        // both current and rule-free rather than current and stale-looking.
        file.sway_pid = std::process::id();
        file.stamp_ms = rules::now_ms();
        rules::save(&path, &file)?;
    }

    let project_path = rules::project_rules_path(&cwd);
    let mut project = rules::load_project(&project_path);
    if project.rules.contains(&target) {
        project.rules.retain(|r| r != &target);
        rules::save_project(&project_path, &project)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn chat_set_mode(
    state: State<'_, ChatState>,
    session_id: String,
    mode: PermissionMode,
) -> Result<(), String> {
    state.0.set_mode(&session_id, mode)
}

#[tauri::command]
pub async fn chat_set_model(
    state: State<'_, ChatState>,
    session_id: String,
    model: String,
    effort: Option<Effort>,
) -> Result<(), String> {
    state.0.set_model(&session_id, &model, effort)
}

/// The before-state of the files a tool call wrote, for a card the user
/// expanded. Read back out of the object store on demand, which is why only the
/// sha was ever cached.
///
/// `None` for a call that was never captured or has been evicted: the card says
/// the diff is unavailable and offers the file, rather than erroring.
#[tauri::command]
pub async fn chat_tool_before_state(
    state: State<'_, ChatState>,
    session_id: String,
    tool_use_id: String,
    cwd: String,
) -> Result<Option<Vec<BeforeContent>>, String> {
    let Some(cache) = state.0.snapshots(&session_id) else { return Ok(None) };
    let captured = {
        let guard = cache.lock().map_err(|e| e.to_string())?;
        guard.get(&tool_use_id).cloned()
    };
    let repo = PathBuf::from(&cwd);
    Ok(captured.map(|entries| {
        entries
            .into_iter()
            .map(|c| BeforeContent {
                content: match &c.before {
                    snapshot::BeforeState::Blob { sha } => snapshot::read_back(&repo, sha),
                    _ => None,
                },
                path: c.path,
                before: c.before,
            })
            .collect()
    }))
}

/// One file's before-state, resolved to content where there is content to
/// resolve. The `before` discriminant is kept so a creation renders as a
/// creation rather than as an empty file.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeContent {
    pub path: String,
    pub before: snapshot::BeforeState,
    pub content: Option<String>,
}

#[tauri::command]
pub async fn chat_close(state: State<'_, ChatState>, session_id: String) -> Result<(), String> {
    state.0.close(&session_id)
}

/// What the startup reap found, delivered once, when the frontend is ready to
/// show it.
///
/// A pull rather than an event: the reap runs inside Tauri's `setup`, before the
/// webview exists, so anything emitted there is emitted to nobody and the orphan
/// blocks its session id silently.
#[tauri::command]
pub async fn chat_orphans(orphans: State<'_, Orphans>) -> Result<Vec<Reaped>, String> {
    Ok(orphans.take())
}

/// End a `claude` child left behind by a crashed Sway, so its session id becomes
/// claimable again. Separate from `chat_close`, which only ever touches sessions
/// this process owns.
#[tauri::command]
pub async fn chat_terminate_orphan(
    state: State<'_, ChatState>,
    session_id: String,
    child_pid: u32,
    agent_id: String,
) -> Result<(), String> {
    super::ownership::terminate_orphan(&state.0.registry, &session_id, child_pid, &agent_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_chat() -> &'static ChatConfig {
        agents::find("claude").unwrap().chat.as_ref().unwrap()
    }

    #[test]
    fn a_fresh_session_selects_its_own_id_and_a_resume_attaches_to_one() {
        let chat = claude_chat();
        let fresh = build_args(chat, "abc-123", false, None, None, None, &[]);
        assert!(fresh.windows(2).any(|w| w == ["--session-id", "abc-123"]));
        assert!(!fresh.iter().any(|a| a == "--resume"));

        let resumed = build_args(chat, "abc-123", true, None, None, None, &[]);
        assert!(resumed.windows(2).any(|w| w == ["--resume", "abc-123"]));
        assert!(!resumed.iter().any(|a| a == "--session-id"));
    }

    /// The protocol flags must lead. A selection flag ahead of them could be
    /// parsed as the value of a preceding option, and the stream would never
    /// start.
    #[test]
    fn the_stream_json_protocol_flags_come_first() {
        let args = build_args(claude_chat(), "s1", false, Some("claude-opus-5"), None, None, &[]);
        let base = &claude_chat().base_args;
        assert_eq!(&args[..base.len()], base.as_slice());
    }

    #[test]
    fn model_mode_and_effort_all_reach_the_argv() {
        let args = build_args(
            claude_chat(),
            "s1",
            false,
            Some("claude-opus-5"),
            Some("plan"),
            Some("high"),
            &[],
        );
        assert!(args.windows(2).any(|w| w == ["--model", "claude-opus-5"]));
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "high"]));
    }

    #[test]
    fn each_extra_directory_gets_its_own_flag() {
        let args = build_args(
            claude_chat(),
            "s1",
            false,
            None,
            None,
            None,
            &["/a".to_string(), "/b".to_string()],
        );
        assert!(args.windows(2).any(|w| w == ["--add-dir", "/a"]));
        assert!(args.windows(2).any(|w| w == ["--add-dir", "/b"]));
        assert_eq!(args.iter().filter(|a| *a == "--add-dir").count(), 2);
    }

    /// An unknown selection is dropped rather than passed through: sending
    /// `--model not-a-model` would fail the whole session, where omitting it
    /// leaves the CLI on its own default.
    #[test]
    fn an_undeclared_model_or_mode_is_omitted_rather_than_guessed() {
        let args = build_args(claude_chat(), "s1", false, Some("no-such-model"), Some("no-such-mode"), None, &[]);
        assert!(!args.iter().any(|a| a == "--model"));
        assert!(!args.iter().any(|a| a == "--permission-mode"));
    }

    /// `chat_spawn` needs a Tauri `State` to run, so the flag's survival is
    /// asserted on the value it returns instead.
    ///
    /// A contested grant is the whole output of the external-session check: the
    /// session is also being resumed by a `claude` we do not control, so its
    /// transcript can end up recording a conversation that never happened. The
    /// first draft of `chat_spawn` computed that correctly and then returned a
    /// freshly built `Granted { contested: false }`, detecting the hazard and
    /// saying nothing. This pins that the flag is carried, not rebuilt.
    #[test]
    fn a_contested_grant_survives_into_the_spawn_result() {
        let result = SpawnResult {
            ownership: ClaimOutcome::Granted { contested: true },
            spawned: Some(Spawned::Started),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["ownership"]["type"], "granted");
        assert_eq!(json["ownership"]["contested"], true, "the warning must reach the frontend");
    }

    /// A refusal is a normal answer, not an error, so the frontend can focus the
    /// holding tab rather than parse a string.
    #[test]
    fn a_refusal_is_reported_as_a_value_with_nothing_spawned() {
        let result = SpawnResult {
            ownership: ClaimOutcome::HeldByOther { surface: Surface::PtyAgent, tab_id: "pty-1".into() },
            spawned: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["ownership"]["type"], "heldByOther");
        assert_eq!(json["ownership"]["tabId"], "pty-1");
        assert!(json["spawned"].is_null());
    }

    /// The five buttons are three decisions crossed with reach. This pins the
    /// decision half: what the blocked hook emits, and therefore what the model
    /// is told.
    #[test]
    fn every_answer_reaches_the_hook_as_the_decision_it_names() {
        let allow = approval::hook_output(&hook_response_for(PermissionDecision::Allow, None));
        assert!(allow.contains("\"permissionDecision\":\"allow\""), "{allow}");

        let deny = approval::hook_output(&hook_response_for(PermissionDecision::Deny, None));
        assert!(deny.contains("\"permissionDecision\":\"deny\""), "{deny}");
    }

    /// "Deny with feedback" is a redirection, not a refusal: the typed reason is
    /// delivered to the model as the tool result. A default substituted over it
    /// would throw away the only part the user wrote.
    #[test]
    fn a_typed_denial_reason_survives_verbatim_into_the_tool_result() {
        let typed = "Not that file - use dev/fixtures/chat/events.json.";
        let out = approval::hook_output(&hook_response_for(PermissionDecision::Deny, Some(typed.to_string())));
        assert!(out.contains(typed), "{out}");
        assert!(!out.contains("Denied in Sway."), "the default must not displace what the user wrote");
    }

    /// A working directory nothing else in the suite uses, so the durable
    /// project store these tests write to cannot collide with a real one.
    fn scratch_project(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("sway-rules-{}-{name}", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    fn cleanup(session_id: &str, cwd: &str) {
        let _ = std::fs::remove_file(rules::rules_path(session_id));
        let _ = std::fs::remove_file(rules::project_rules_path(cwd));
    }

    /// The whole point of the project scope: a rule granted in one chat is in
    /// force in the *next* chat opened on that folder. Written against the
    /// compiled file the hook helper actually reads, not against intent.
    #[test]
    fn a_project_rule_outlives_the_chat_that_granted_it() {
        let cwd = scratch_project("outlives");
        let first = format!("rules-first-{}", std::process::id());
        let second = format!("rules-second-{}", std::process::id());
        cleanup(&first, &cwd);
        let _ = std::fs::remove_file(rules::rules_path(&second));

        add_rule(&first, &cwd, "Read", &serde_json::json!({"file_path": format!("{cwd}/src/a.rs")}), PermissionScope::Project).unwrap();
        // The tab closes: its compiled file goes with it.
        std::fs::remove_file(rules::rules_path(&first)).unwrap();

        compile_project_rules(&second, &cwd).unwrap();
        let compiled = rules::load(&rules::rules_path(&second)).expect("the new session should have a compiled file");
        assert_eq!(compiled.rules.len(), 1);
        assert_eq!(compiled.rules[0].tool, "Read");

        cleanup(&second, &cwd);
    }

    /// A session-scoped rule is exactly that. Leaking it into the durable store
    /// would make "for this session" quietly permanent.
    #[test]
    fn a_session_rule_never_reaches_the_durable_project_store() {
        let cwd = scratch_project("session-only");
        let session = format!("rules-session-{}", std::process::id());
        cleanup(&session, &cwd);

        add_rule(&session, &cwd, "Bash", &serde_json::json!({"command": "git status"}), PermissionScope::Session).unwrap();
        assert!(rules::load_project(&rules::project_rules_path(&cwd)).rules.is_empty());

        cleanup(&session, &cwd);
    }

    /// Removing a rule has to reach both stores. Left in the durable one it
    /// would come back with the next chat on this folder, which reads as the
    /// revoke having failed.
    #[test]
    fn removing_a_rule_clears_it_from_the_session_and_from_the_project() {
        let cwd = scratch_project("remove");
        let session = format!("rules-remove-{}", std::process::id());
        let later = format!("rules-later-{}", std::process::id());
        cleanup(&session, &cwd);
        let _ = std::fs::remove_file(rules::rules_path(&later));

        let input = serde_json::json!({"file_path": format!("{cwd}/src/a.rs")});
        add_rule(&session, &cwd, "Read", &input, PermissionScope::Project).unwrap();
        let listed = tauri::async_runtime::block_on(chat_list_rules(session.clone(), cwd.clone())).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(matches!(listed[0].scope, PermissionScope::Project), "a rule from the project store lists as project-scoped");

        tauri::async_runtime::block_on(chat_remove_rule(
            session.clone(),
            cwd.clone(),
            listed[0].tool.clone(),
            listed[0].prefix.clone(),
        ))
        .unwrap();

        // Gone here, and gone for the next chat on this folder.
        assert!(tauri::async_runtime::block_on(chat_list_rules(session.clone(), cwd.clone())).unwrap().is_empty());
        // The point of removing it: the next matching call prompts again rather
        // than taking the cheap path.
        let verdict = rules::evaluate(
            rules::load(&rules::rules_path(&session)).as_ref(),
            "Read",
            &input,
            rules::now_ms(),
            |_| true,
        );
        assert_eq!(verdict, rules::Verdict::Ask);
        compile_project_rules(&later, &cwd).unwrap();
        assert!(rules::load(&rules::rules_path(&later)).map(|f| f.rules).unwrap_or_default().is_empty());

        cleanup(&session, &cwd);
        let _ = std::fs::remove_file(rules::rules_path(&later));
    }

    /// The guard the whole ownership layer exists for, stated as a fact about
    /// the flags: two live drivers of one session id both resume it and both
    /// append to one transcript.
    #[test]
    fn the_claude_transport_is_what_the_factory_builds_for_the_bundled_adapter() {
        let chat = claude_chat();
        assert_eq!(chat.transport, ChatTransport::ClaudeStreamJson);
        let t = make_transport(chat.transport, "s1");
        assert!(t.child_pid().is_none(), "a transport is inert until started");
    }
}
