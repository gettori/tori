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

use crate::agents::{self, ChatConfig, ChatEffortExtra, ChatTransport};

use super::acp::AcpOverrides;
use super::acp_sessions;
use super::acp_transport::AcpTransport;
use super::approval;
use super::claude_transport::ClaudeTransport;
use super::host::{ChatState, SessionBridge, Spawned};
use super::mirror::Mirror;
use super::usage;
use super::snapshot::{self, SnapshotCache, CACHE_CAP};
use super::model::{
    ChatConfigValue, ChatEvent, ContentBlock, PermissionDecision, PermissionMode, PermissionScope,
    QuestionAnswer,
};
use super::ownership::{Claim, ClaimOutcome, Orphans, Reaped, Surface};
use super::transport::{AgentTransport, StartSpec};

/// Build a transport for a declared wire protocol.
///
/// **This is the extension point for a second agent.** The `match` is
/// exhaustive over [`ChatTransport`], so adding a variant fails to compile here
/// until a transport exists for it - which is the point: a TOML able to name a
/// transport with no implementation would be a runtime error instead of a build
/// one. `ChatTransport::as_str` is exhaustive for the same reason on the
/// serialization side; between them a new agent has exactly two compiler-named
/// obligations and no silent ones.
fn make_transport(
    transport: ChatTransport,
    session_id: &str,
    agent_id: &str,
    acp: AcpOverrides,
    effort_extras: Vec<ChatEffortExtra>,
    questions_as_permissions: bool,
) -> Box<dyn AgentTransport> {
    match transport {
        // The extras ride along because claude advertises fewer effort levels
        // than it accepts, so the extra levels are assembled from this table and
        // the model the session reports. An ACP agent publishes its own and
        // takes none. Claude's *levers* need no table any more: the handshake
        // publishes `supportsFastMode` per model.
        ChatTransport::ClaudeStreamJson => Box::new(
            ClaudeTransport::new(session_id)
                .with_effort_extras(effort_extras)
                .with_questions_as_permissions(questions_as_permissions),
        ),
        // Every ACP agent reaches Sway through this one arm. Which agent it is
        // comes from the adapter's `[chat]` table, not from here, which is what
        // makes a new ACP agent a TOML file rather than a Rust change. The
        // adapter id travels with it only so the session locators this transport
        // writes can name the agent they came from, and `acp` is that table's
        // `[chat.acp]` quirks rather than this build's defaults.
        ChatTransport::Acp => Box::new(AcpTransport::new(session_id, agent_id, acp)),
    }
}

/// The argument vector for one chat session.
///
/// Pure, so the composition order is assertable without spawning anything.
/// Order is load-bearing: the base args carry the stream-json protocol flags and
/// everything after them selects behaviour, so a later `--model` cannot be
/// swallowed by a flag that takes a value.
#[allow(clippy::too_many_arguments)]
pub fn build_args(
    chat: &ChatConfig,
    session_id: &str,
    resume: bool,
    fork_from: Option<&str>,
    model: Option<&str>,
    mode: Option<&str>,
    effort: Option<&str>,
    extra_dirs: &[String],
) -> Vec<String> {
    let mut args = chat.base_args.clone();
    // Three ways to name the session, and exactly one applies: `--session-id`
    // creates the id, `--resume` attaches to an existing one, and a fork reads
    // one id while writing another. Passing more than one would be
    // contradictory, so `fork_from` wins outright rather than layering.
    if let Some(from) = fork_from {
        args.extend(agents::apply_chat_template(
            &chat.fork_args,
            &[("from", from), ("id", session_id)],
        ));
    } else {
        let id_template = if resume { &chat.resume_args } else { &chat.session_id_args };
        args.extend(agents::apply_chat_template(id_template, &[("id", session_id)]));
    }
    if let Some(model) = model {
        args.extend(chat.model_args_for(model).unwrap_or_default());
    }
    // Resolved rather than looked up, so a mode the adapter no longer declares
    // starts the session on the adapter's default instead of contributing no
    // args at all. The bare `unwrap_or_default()` this replaced meant a stale
    // stored mode silently produced a session running something else, with the
    // picker still showing the mode that had been dropped.
    // Only when a mode was actually asked for: no pick stays no flag, leaving
    // the CLI on its own default rather than Sway asserting one.
    if let Some(resolved) = mode.and_then(|m| chat.resolve_mode(Some(m))) {
        args.extend(chat.mode_args_for(&resolved.id).unwrap_or_default());
    }
    if let Some(effort) = effort {
        args.extend(chat.effort_args_for(effort).unwrap_or_default());
    }
    for dir in extra_dirs {
        args.extend(agents::apply_chat_template(&chat.add_dir_args, &[("dir", dir)]));
    }
    args
}

/// Which account a chat session runs as.
///
/// `asked` is what the caller passed (`None` for "I did not say"), `found` is
/// the profile of the root that actually holds the transcript, which is `None`
/// for a fresh session and for a resume of one killed before its first turn
/// wrote a file.
///
/// **The disk wins.** A transcript lives in exactly one profile home, so that
/// home *is* the account: a caller that forgets to pass the profile still
/// resumes correctly, and one that names a different account is refused rather
/// than pointed at a home its session is not in. Trusting the caller instead
/// turns a single missed hop into a session silently running as somebody else.
///
/// A session with no transcript yet keeps the caller's value, because there is
/// nothing on disk to be authoritative and the tab is the only thing that knows.
pub(crate) fn resolve_profile(asked: Option<&str>, found: Option<&str>) -> Result<String, String> {
    match (asked, found) {
        (_, None) => Ok(asked.unwrap_or(crate::accounts::DEFAULT_PROFILE_ID).to_string()),
        (None, Some(found)) => Ok(found.to_string()),
        (Some(asked), Some(found)) if asked == found => Ok(found.to_string()),
        (Some(asked), Some(found)) => Err(format!(
            "this session's transcript is in the `{found}` account, not `{asked}`; \
             a session cannot be resumed under a different account"
        )),
    }
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
    /// The account the session is actually running as, which is not always the
    /// one the caller asked for: a resume takes the profile off the transcript
    /// (see [`resolve_profile`]), so a tab that spawned with `profile: null`
    /// would otherwise keep believing it had no account. `None` only when
    /// ownership was refused.
    pub profile_id: Option<String>,
}

/// Open a chat session: create it, resume it, or fork it.
///
/// `fork_from` is the session being forked *from*, when this is a fork. It is a
/// separate parameter from `session_id` because a fork is the one case where
/// the id being read and the id being claimed differ: `session_id` is the new
/// one, which Sway chooses and claims **before** starting the child. Measured
/// against claude 2.1.220: `--resume <old> --fork-session --session-id <new>`
/// honours the passed id and reports it back, so the claim can precede the
/// process rather than chase it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_spawn(
    state: State<'_, ChatState>,
    session_id: String,
    tab_id: String,
    agent_id: String,
    cwd: String,
    resume: bool,
    fork_from: Option<String>,
    // Which account to run as. `None` means the caller did not say, which on a
    // resume or a fork is answered from the transcript and on a fresh session
    // is the default profile.
    profile: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
    extra_dirs: Vec<String>,
    // Is this tab the one on screen? Carried at spawn rather than left to the
    // panel's own visibility effect, because a session restored into a
    // background tab would otherwise stream at full price until the first time
    // somebody looked at it and then looked away.
    visible: bool,
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

    // **A remount rewires and stops.** Everything below builds a *new* capture
    // bridge, and the running child cannot be told about it: the socket path it
    // will call went into its `--settings` at launch and is fixed for the life of
    // the process. Falling through would install a second server, tear the live
    // one down, and leave the child talking to a socket that had just been shut
    // down - every diff silently lost for the rest of the session.
    if live {
        let spawned = host.spawn(
            &session_id,
            &tab_id,
            Box::new(move |event| {
                let _ = on_event.send(event);
            }),
            StartSpec::default(),
            // The live session already owns its mirror; the rewire path reuses
            // that one and ignores this.
            None,
            // Never called: the session is live, so `spawn` takes the rewire
            // path and returns before it would need a transport.
            || unreachable!("a live session rewires rather than spawning"),
        )?;
        host.set_visible(&session_id, visible);
        return Ok(SpawnResult {
            ownership: ClaimOutcome::Granted { contested: false },
            spawned: Some(spawned),
            // A rewire never re-resolves, so the claim taken at the original
            // spawn is the account of record.
            profile_id: host.registry.profile_of(&session_id),
        });
    }

    // Before the claim, for two reasons: a caller naming the wrong account is
    // refused while the session is still only an idea, and the claim that is
    // taken records the account the session will actually run as, which is what
    // the removal guard reads. The transcript is looked up only when there is
    // one to look up: a fresh session has no file and no opinion to overrule.
    let source = fork_from.as_deref().unwrap_or(session_id.as_str());
    let found = (resume || fork_from.is_some())
        .then(|| crate::sessions::transcript_of(source, &agent_id))
        .flatten();
    let profile_id = resolve_profile(profile.as_deref(), found.as_ref().map(|t| t.profile.as_str()))?;
    let profile_env =
        crate::accounts::profile_env(adapter, &crate::accounts::load(), Some(&profile_id))?;

    let ownership = {
        let want = Claim {
            surface: Surface::Chat,
            tab_id: tab_id.clone(),
            child_pid: None,
            sway_pid: std::process::id(),
            agent: agent_id.clone(),
            profile: profile_id.clone(),
        };
        let outcome = host.registry.claim(&session_id, want);
        if !matches!(outcome, ClaimOutcome::Granted { .. }) {
            return Ok(SpawnResult { ownership: outcome, spawned: None, profile_id: None });
        }
        // Carried through rather than rebuilt: a granted-but-**contested** claim
        // means a `claude` we do not control is resuming this same id, and its
        // transcript can end up recording a conversation that never happened.
        // Flattening it back to `contested: false` here would detect that and
        // then say nothing, which is worse than not checking.
        outcome
    };

    // The capture socket has to exist before the child does: its path travels
    // in the `--settings` payload the child is launched with.
    let snapshots = Arc::new(Mutex::new(SnapshotCache::new(CACHE_CAP)));
    let repo = PathBuf::from(&cwd);
    let capture_into = snapshots.clone();
    let server = approval::start(
        // Runs on every authenticated call, while the file about to be written
        // still holds its prior content.
        Box::new(move |req| {
            let captured = snapshot::capture_all(&repo, &req.tool_name, &req.tool_input);
            if !captured.is_empty() {
                if let Ok(mut cache) = capture_into.lock() {
                    cache.insert(&req.tool_use_id, captured);
                }
            }
        }),
    )
    .map_err(|e| format!("could not start the capture bridge: {e}"))?;

    let mut args = build_args(
        chat,
        &session_id,
        resume,
        fork_from.as_deref(),
        model.as_deref(),
        mode.as_deref(),
        effort.as_deref(),
        &extra_dirs,
    );
    args.extend(approval::settings_args(&session_id, server.sock_path(), server.token())?);

    let spec = StartSpec {
        session_id: session_id.clone(),
        cwd,
        // The user's agent override wins over the adapter's program name.
        // Read at spawn time rather than cached, so changing it in Settings
        // applies to the next session started without restarting Sway.
        program: crate::settings::agent_override(&agent_id).unwrap_or_else(|| chat.program.clone()),
        args,
        // The account this session runs as, and the only thing that makes it
        // one: the agent resolves its login from this variable, so the whole of
        // "which account" is here rather than in a flag.
        env: profile_env.into_iter().collect(),
    };

    let transport = chat.transport;
    let acp_overrides = chat.acp.clone();
    let effort_extras = chat.effort_extras.clone();
    let questions_as_permissions = !crate::settings::answer_questions_inline();
    let id_for_factory = session_id.clone();
    let agent_for_factory = agent_id.clone();
    // **Only a transport whose conversation Sway cannot otherwise read back.**
    // A claude session's transcript is a file `chat_history` already reads, so
    // it gets `None` and pays one `if let Some` per event and nothing else.
    // Keyed on the transport rather than on the agent id, so a fifth ACP adapter
    // inherits this without a line of code.
    let mirror = matches!(chat.transport, ChatTransport::Acp)
        .then(|| Arc::new(Mirror::at(acp_sessions::log_path(&session_id))));
    let spawned = host.spawn(
        &session_id,
        &tab_id,
        Box::new(move |event| {
            let _ = on_event.send(event);
        }),
        spec,
        mirror,
        move || {
            make_transport(
                transport,
                &id_for_factory,
                &agent_for_factory,
                acp_overrides.clone(),
                effort_extras.clone(),
                questions_as_permissions,
            )
        },
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
    host.set_visible(&session_id, visible);
    host.install_bridge(&session_id, SessionBridge::new(server, snapshots, &session_id));

    // Said only once the session is actually up, and only when the mode that
    // was asked for is not the mode it is running. Non-fatal on purpose: the
    // session works, but the user chose something it is not doing, and a
    // control silently showing the wrong mode is the failure this prevents.
    if let Some(asked) = mode.as_deref() {
        if let Some(from) = chat.resolve_mode(Some(asked)).and_then(|r| r.downgraded_from.map(|f| (f, r.id))) {
            let (asked, running) = from;
            host.emitter()(
                &session_id,
                ChatEvent::SessionError {
                    session_id: session_id.clone(),
                    message: format!(
                        "{} no longer offers the `{asked}` permission mode, so this session is running `{running}`.",
                        adapter.label
                    ),
                    fatal: false,
                },
            );
        }
    }

    Ok(SpawnResult { ownership, spawned: Some(spawned), profile_id: Some(profile_id) })
}

#[tauri::command]
pub async fn chat_send(
    state: State<'_, ChatState>,
    session_id: String,
    blocks: Vec<ContentBlock>,
) -> Result<(), String> {
    state.0.send(&session_id, blocks)
}

/// Deliver a message into the turn already running, rather than opening one.
///
/// A separate command from [`chat_send`] because the transport treats the two
/// differently: `send` also flushes a queued mode or model switch, which a
/// steer must leave for the turn it was promised to.
#[tauri::command]
pub async fn chat_steer(
    state: State<'_, ChatState>,
    session_id: String,
    blocks: Vec<ContentBlock>,
) -> Result<(), String> {
    state.0.steer(&session_id, blocks)
}

#[tauri::command]
pub async fn chat_interrupt(state: State<'_, ChatState>, session_id: String) -> Result<(), String> {
    state.0.interrupt(&session_id)
}

/// A chat tab came on screen, or left it.
///
/// `Ok(())` whether or not it landed: a tab switch races its own session's
/// teardown, and failing the call would turn an ordinary close into an error
/// toast. What it controls is pacing only, so being wrong costs a repaint rather
/// than a message.
#[tauri::command]
pub async fn chat_set_visible(state: State<'_, ChatState>, session_id: String, visible: bool) -> Result<(), String> {
    state.0.set_visible(&session_id, visible);
    Ok(())
}

/// Answer a permission question the agent asked.
///
/// **Nothing is persisted here.** The scope rode back to the agent in the same
/// response, as `updatedPermissions`, in the agent's own rule grammar - and
/// that copy is the one its next tool call consults. Sway used to write a rule
/// of its own alongside it, which recorded one decision twice in two formats and
/// left the two free to disagree. There is no second store now.
#[tauri::command]
pub async fn chat_respond_permission(
    state: State<'_, ChatState>,
    session_id: String,
    request_id: String,
    tool_use_id: String,
    decision: PermissionDecision,
    scope: PermissionScope,
    reason: Option<String>,
) -> Result<(), String> {
    state.0.answer_permission(&session_id, &tool_use_id, &request_id, decision, scope, reason.as_deref())
}

/// Answer a question the agent asked the user.
///
/// **Returns whether anything was still waiting on it.** A form filled in after
/// the question was cancelled has nowhere to land, and the surface has to be
/// able to say so rather than clear itself as though the agent had read it.
/// This is the one place the transport's routing bool is worth carrying all the
/// way out, which is why it is not a `()` like `chat_respond_permission`.
#[tauri::command]
pub async fn chat_answer_question(
    state: State<'_, ChatState>,
    session_id: String,
    request_id: String,
    tool_use_id: String,
    answers: Vec<QuestionAnswer>,
) -> Result<bool, String> {
    state.0.answer_question(&session_id, &tool_use_id, &request_id, &answers)
}

// --- spend ceilings --------------------------------------------------------

/// Record one completed turn against this session's running total.
///
/// Returns the session's new total **and** the project's, because the two
/// ceilings are checked against different sums and the caller would otherwise
/// need a second round trip to learn the one it did not ask for.
#[tauri::command]
pub async fn chat_record_usage(
    cwd: String,
    session_id: String,
    tokens: u64,
    cost_usd: Option<f64>,
) -> Result<UsageTotals, String> {
    let path = usage::usage_path(&cwd);
    let session = usage::record_turn(&path, &session_id, tokens, cost_usd)?;
    Ok(UsageTotals { project: usage::project_total(&usage::load(&path)), session })
}

/// How many human prompts this session's transcript holds.
///
/// The denominator of the honesty rule: compared against the turns this chat saw
/// a `result` frame for, it says whether the session total is the truth or a
/// floor. Resolved from the session id here rather than in the panel, which
/// knows its id but not the file the agent writes it to - and the resolution
/// is `transcript_path`, the same one the replay uses, so the two cannot drift
/// onto different files.
///
/// 0 for a session with no transcript yet, which reads as "not known to be
/// complete" and keeps the caveat. A brand-new chat has nothing to be complete
/// about.
#[tauri::command]
pub async fn chat_prompt_count(session_id: String, agent_id: String) -> Result<u32, String> {
    let Some(path) = crate::sessions::transcript_path(&session_id, &agent_id) else {
        return Ok(0);
    };
    let tail = crate::sessions::session_prompt_tail(path, agent_id).await?;
    Ok(tail.count)
}

/// This chat session's figures, resolved from its id rather than from a path.
///
/// The same payload the toolbar shows for a sidebar selection, deliberately: the
/// chat's status strip and the toolbar are usually describing the *same session*
/// at the same moment, and two derivations of "prompts" that disagreed by one
/// would be worse than showing neither. `transcript_path` is the resolution the
/// replay uses, so the figures and the conversation on screen come off one file.
///
/// `None` when the session has no transcript on disk yet (a brand-new chat, or a
/// SQLite-backed agent that keeps no per-session file), which the panel renders
/// as no figures rather than as zeroes it cannot stand behind.
#[tauri::command(async)]
pub fn chat_session_detail(
    touched: tauri::State<crate::sessions::TouchedIndex>,
    session_id: String,
    agent_id: String,
) -> Result<Option<crate::sessions::SessionDetail>, String> {
    let Some(path) = crate::sessions::transcript_path(&session_id, &agent_id) else {
        return Ok(None);
    };
    crate::sessions::session_detail(touched, path, agent_id).map(Some)
}

/// This session's persisted total, for a panel that has just reopened.
#[tauri::command]
pub async fn chat_usage_totals(cwd: String, session_id: String) -> Result<UsageTotals, String> {
    let file = usage::load(&usage::usage_path(&cwd));
    let session = file.sessions.get(&session_id).cloned().unwrap_or_default();
    Ok(UsageTotals { project: usage::project_total(&file), session })
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub session: usage::SessionUsage,
    pub project: usage::SessionUsage,
}

// `chat_set_budget_stop` used to live here, arming a spend stop in the rule file
// so the hook would refuse every subsequent tool call. Sway no longer decides
// tool calls, so the ceiling moved to the one boundary it still owns: whether a
// new turn starts at all. That belongs entirely to the panel, so there is
// nothing left for a command to do.

// `chat_add_restriction`, `chat_list_rules`, `chat_remove_rule` and
// `chat_accept_rule_offer` used to live here, writing and reading Sway's own
// allow/ask/deny store. There is no such store: the agent decides its own tool
// calls and records its own grants, so a Sway-owned rule could only be a second
// opinion nothing consults.

/// Every MCP server configured for `cwd`, across Claude's three scopes.
///
/// Read straight from Claude's own files rather than from `system/init`, so the
/// list is answerable before a session starts and includes servers that failed
/// to connect (which init reports) *and* ones still pending approval (which it
/// does not connect to at all).
#[tauri::command]
pub async fn chat_mcp_list(
    cwd: String,
    agent_id: String,
    profile: Option<String>,
) -> Result<Vec<super::mcp::McpEntry>, String> {
    Ok(super::mcp::list_for(&cwd, profile_home(&agent_id, profile.as_deref()).as_deref()))
}

#[tauri::command]
pub async fn chat_mcp_add(
    cwd: String,
    name: String,
    config: serde_json::Value,
    agent_id: String,
    profile: Option<String>,
) -> Result<Vec<super::mcp::McpEntry>, String> {
    super::mcp::add_to_project(
        &cwd,
        &name,
        config,
        profile_home(&agent_id, profile.as_deref()).as_deref(),
    )
}

#[tauri::command]
pub async fn chat_mcp_remove(
    cwd: String,
    name: String,
    agent_id: String,
    profile: Option<String>,
) -> Result<Vec<super::mcp::McpEntry>, String> {
    super::mcp::remove_from_project(
        &cwd,
        &name,
        profile_home(&agent_id, profile.as_deref()).as_deref(),
    )
}

/// The isolated home one account runs in, or `None` for the default account.
///
/// `None` rather than an error for a profile that no longer exists: this is a
/// read of somebody's config, not a spawn, so the worst a stale id can do is
/// list the default account's servers. A spawn goes through
/// `accounts::profile_env`, which refuses instead.
fn profile_home(agent_id: &str, profile: Option<&str>) -> Option<String> {
    crate::accounts::profile(&crate::accounts::load(), agent_id, profile?)?.home
}

#[tauri::command]
pub async fn chat_set_mode(
    state: State<'_, ChatState>,
    session_id: String,
    mode: PermissionMode,
) -> Result<(), String> {
    state.0.set_mode(&session_id, mode)
}

/// Switch one of the agent's own configuration options, by the id it
/// published. What the mirrored controls call, and nothing else: a model, an
/// effort level or a mode goes through its own command, which has the pending
/// state those need.
#[tauri::command]
pub async fn chat_set_config_option(
    state: State<'_, ChatState>,
    session_id: String,
    config_id: String,
    value: ChatConfigValue,
) -> Result<(), String> {
    state.0.set_config_option(&session_id, &config_id, value)
}

#[tauri::command]
pub async fn chat_set_model(
    state: State<'_, ChatState>,
    session_id: String,
    model: String,
    effort: Option<String>,
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

/// One file a tool call wrote, as a diff the card can render.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDiff {
    pub path: String,
    /// Unified diff at git's own context width, or `None` when there is nothing
    /// to diff against. `Some("")` is different and means the file is unchanged.
    pub diff: Option<String>,
    /// Whether this call created the file, so a creation renders as one rather
    /// than as a large edit.
    pub created: bool,
}

/// The diffs for one tool call's writes, computed on demand when a card expands.
///
/// Separate from `chat_tool_before_state`, which hands back raw content: a card
/// wants hunks, and computing them in Rust keeps the object store, the context
/// width and the hunk parser in one place instead of reimplementing git's
/// grouping in TypeScript.
#[tauri::command]
pub async fn chat_tool_diff(
    state: State<'_, ChatState>,
    session_id: String,
    tool_use_id: String,
    cwd: String,
) -> Result<Vec<ToolDiff>, String> {
    let Some(cache) = state.0.snapshots(&session_id) else { return Ok(Vec::new()) };
    let captured = {
        let guard = cache.lock().map_err(|e| e.to_string())?;
        guard.get(&tool_use_id).cloned()
    };
    let repo = PathBuf::from(&cwd);
    Ok(captured
        .unwrap_or_default()
        .into_iter()
        .map(|c| ToolDiff {
            diff: snapshot::diff_against_now(&repo, &c.before, &c.path),
            created: matches!(c.before, snapshot::BeforeState::Absent),
            path: c.path,
        })
        .collect())
}

/// The whole text of one tool call's output, for a card that asked for the rest.
///
/// `None` rather than an error for everything that could go wrong, because from
/// the card's side they are one case: an output that was never over the cap has
/// nothing more to give, an evicted one is gone, and a session that has ended
/// took its cache with it. All three mean "keep showing the extract you have",
/// and an `Err` here would make a card render a failure over a perfectly good
/// answer.
#[tauri::command]
pub async fn chat_tool_output(
    state: State<'_, ChatState>,
    session_id: String,
    tool_use_id: String,
) -> Result<Option<String>, String> {
    Ok(state.0.tool_output(&session_id, &tool_use_id))
}

/// One file's whole-session diff, for the transcript's diff view.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileDiff {
    pub path: String,
    #[serde(flatten)]
    pub accumulated: snapshot::AccumulatedDiff,
}

/// Every file this session wrote, each as one diff spanning the session rather
/// than one diff per tool call.
///
/// The transcript's diff view is the same session read a different way: instead
/// of "what happened, in order", it answers "what is different now, and which
/// step made it so". Both come off the same captured before-states, so the two
/// views cannot disagree about what changed.
///
/// Files are ordered by when the session first touched them, so the list reads
/// in the order the work happened.
#[tauri::command]
pub async fn chat_session_diff(
    state: State<'_, ChatState>,
    session_id: String,
    cwd: String,
) -> Result<Vec<SessionFileDiff>, String> {
    let Some(cache) = state.0.snapshots(&session_id) else { return Ok(Vec::new()) };
    let captures = {
        let guard = cache.lock().map_err(|e| e.to_string())?;
        guard.in_order()
    };

    // Group by path, preserving both first-touch order and per-path call order.
    let mut order: Vec<String> = Vec::new();
    let mut by_path: HashMap<String, Vec<(String, snapshot::BeforeState)>> = HashMap::new();
    for (id, c) in captures {
        if !by_path.contains_key(&c.path) {
            order.push(c.path.clone());
        }
        by_path.entry(c.path).or_default().push((id, c.before));
    }

    let repo = PathBuf::from(&cwd);
    Ok(order
        .into_iter()
        .filter_map(|path| {
            let calls = by_path.get(&path)?;
            let accumulated = snapshot::accumulate(&repo, &path, calls)?;
            // A file the session opened and put back unchanged is not a change.
            (!accumulated.diff.is_empty()).then_some(SessionFileDiff { path, accumulated })
        })
        .collect())
}

/// Undo one hunk of a tool call's edit, in the working tree.
///
/// Scoped to the before-state *this call* captured rather than to a checkpoint:
/// a turn can write one file several times, and a checkpoint boundary would take
/// all of those edits back when the user asked for one hunk of one of them.
///
/// The blast-radius guard runs in the frontend, where the chat tier's exact
/// status lives (`revertGuard`); this command is the write itself.
#[tauri::command]
pub async fn chat_revert_tool_hunk(
    state: State<'_, ChatState>,
    session_id: String,
    tool_use_id: String,
    cwd: String,
    path: String,
    hunk_index: usize,
    fingerprint: String,
) -> Result<String, String> {
    let cache = state
        .0
        .snapshots(&session_id)
        .ok_or_else(|| "This chat is no longer running, so its captured before-states are gone.".to_string())?;
    let captured = {
        let guard = cache.lock().map_err(|e| e.to_string())?;
        guard.get(&tool_use_id).cloned()
    };
    let before = captured
        .unwrap_or_default()
        .into_iter()
        .find(|c| c.path == path)
        .map(|c| c.before)
        .ok_or_else(|| "No before-state was captured for this call, so there is nothing to revert to.".to_string())?;
    snapshot::revert_hunk(&PathBuf::from(&cwd), &before, &path, hunk_index, &fingerprint)
        .map(str::to_string)
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

/// Replay a session's transcript as the events that rebuild it.
///
/// **Pulled by the panel rather than pushed through the live channel.** Backfill
/// has to land before the first live event or the transcript renders out of
/// order, and a return value is ordered by construction where two producers on
/// one channel are not.
///
/// Works for a session Sway never ran: the file is the agent's own jsonl, and
/// a PTY tab, an outside terminal and a chat tab all write the same one.
///
/// A session with no transcript yet returns no events rather than an error - a
/// brand-new chat is the common case, not a failure.
///
/// `from_session_id` is the transcript to *read*; `session_id` is the session
/// the events are stamped for. They differ for a fork, which shows the history
/// it forked from under its own new id - stamping that history with the
/// original's id would have every event dropped by the panel's own routing
/// guard, and the fork would open blank.
///
/// `up_to_prompt_ts` is a rewind: the replay stops before the prompt that
/// checkpoint was taken for, so the panel shows the conversation as it stood
/// when the files did. It cuts the **panel** only. The child is still spawned
/// `--resume <old> --fork-session`, so the agent's own context is the whole
/// original conversation including the turns being undone - the one thing about
/// a rewind that cannot be hidden, and therefore the thing the rewind banner and
/// the seeded first message both say out loud.
#[tauri::command]
pub async fn chat_history(
    state: State<'_, ChatState>,
    session_id: String,
    from_session_id: Option<String>,
    agent_id: String,
    up_to_prompt_ts: Option<u64>,
) -> Result<Vec<ChatEvent>, String> {
    let source = from_session_id.as_deref().unwrap_or(&session_id);
    let Some(path) = crate::sessions::transcript_path(source, &agent_id) else {
        return Ok(Vec::new());
    };
    let turns = crate::sessions::transcript_turns(&path, &agent_id);
    let shown = match up_to_prompt_ts.and_then(|ts| super::history::prompt_boundary(&turns, ts)) {
        Some(at) => &turns[..at],
        None => &turns[..],
    };
    // Read whole rather than cut at the rewind boundary: a subagent is placed at
    // its own `Agent` call, so one launched after the cut simply has no call
    // left to hang on and drops out on its own.
    let subagents = crate::sessions::subagent_transcripts(&path, &agent_id);
    let mut events = super::history::events_from_turns(&session_id, shown, &subagents);
    // The cut a live event gets on its way through the sink wrapper. Applied
    // here because replay does not pass through it, and applied through the
    // same cache so a backfilled card can fetch its remainder too.
    state.0.cut_outputs(&session_id, &mut events);
    Ok(events)
}

// --- mid-turn quit recovery ------------------------------------------------
//
// A turn that was running when Sway went away leaves no trace the transcript can
// be read for: the file simply stops, which is indistinguishable from a turn
// that ended normally and from one still streaming. So Sway records its own
// side - the turn it believes is open - and clears it on completion. Anything
// still marked at the next launch was interrupted.
//
// Deliberately **not** derived from the transcript tail. `classify_tail` answers
// "what was the last thing written", which a killed turn and a finished one can
// share; only the writer knows whether it ever saw the end.

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenTurn {
    pub session_id: String,
    pub turn_id: String,
}

fn open_turn_path(session_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/chat-open-turn")
        .join(format!("{session_id}.json"))
}

/// Mark a turn as open, or clear the mark when it completes.
///
/// Called on every `TurnStarted`/`TurnCompleted`, so the file exists for exactly
/// as long as a turn is in flight. A crash leaves it behind, which is the whole
/// signal.
#[tauri::command]
pub async fn chat_mark_turn(session_id: String, turn_id: Option<String>) -> Result<(), String> {
    mark_turn(&session_id, turn_id)
}

/// The file half of `chat_mark_turn`, split out so it is testable without a
/// Tauri app or an async runtime.
fn mark_turn(session_id: &str, turn_id: Option<String>) -> Result<(), String> {
    let path = open_turn_path(session_id);
    let Some(turn_id) = turn_id else {
        // Completion. A missing file is the normal case on a second clear, so
        // absence is not an error.
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.to_string());
            }
        }
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&OpenTurn { session_id: session_id.to_string(), turn_id })
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// The turn this session was running when Sway last went away, if any.
///
/// **Consumed, not merely read**: the mark is cleared as it is reported, so the
/// interruption is announced exactly once. Left in place it would re-announce
/// on every reopen, long after the user had dealt with it.
#[tauri::command]
pub async fn chat_take_interrupted_turn(session_id: String) -> Result<Option<OpenTurn>, String> {
    Ok(take_interrupted_turn(&session_id))
}

/// The file half of `chat_take_interrupted_turn`. See `mark_turn` for why.
fn take_interrupted_turn(session_id: &str) -> Option<OpenTurn> {
    let path = open_turn_path(session_id);
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    serde_json::from_str::<OpenTurn>(&text).ok()
}

/// Every chat session this process still holds, by **session** id.
///
/// A webview reload keeps the backend but loses every tab, so a restore has to
/// ask what survived rather than assume. Chat and terminal answer separately
/// because they are keyed differently: this returns session ids, `pty_live_ids`
/// returns frontend tab ids, and the two sets never overlap.
#[tauri::command]
pub async fn chat_live_sessions(state: State<'_, ChatState>) -> Result<Vec<String>, String> {
    Ok(state.0.live_ids())
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

/// Clear the rule store the retired gate left behind, and say what went.
///
/// Run from the frontend rather than from Tauri's `setup` for the same reason
/// the reap above is pulled: nothing can be told to a webview that does not
/// exist yet. Unlike the reap it needs no parking, because the sweep's own
/// "once" is the disk - a second call finds nothing and answers `None`.
///
/// Late is fine. Nothing reads these files, which is the whole reason they are
/// being removed, so there is no window in which their presence matters.
#[tauri::command]
pub async fn chat_retired_stores() -> Result<Option<super::retired::RetiredRuleStore>, String> {
    Ok(super::retired::sweep_rule_store())
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
        let fresh = build_args(chat, "abc-123", false, None, None, None, None, &[]);
        assert!(fresh.windows(2).any(|w| w == ["--session-id", "abc-123"]));
        assert!(!fresh.iter().any(|a| a == "--resume"));

        let resumed = build_args(chat, "abc-123", true, None, None, None, None, &[]);
        assert!(resumed.windows(2).any(|w| w == ["--resume", "abc-123"]));
        assert!(!resumed.iter().any(|a| a == "--session-id"));
    }

    /// The protocol flags must lead. A selection flag ahead of them could be
    /// parsed as the value of a preceding option, and the stream would never
    /// start.
    #[test]
    fn the_stream_json_protocol_flags_come_first() {
        let args = build_args(claude_chat(), "s1", false, None, Some("claude-opus-5"), None, None, &[]);
        let base = &claude_chat().base_args;
        assert_eq!(&args[..base.len()], base.as_slice());
    }

    #[test]
    fn model_mode_and_effort_all_reach_the_argv() {
        let args = build_args(
            claude_chat(),
            "s1",
            false, None,
            Some("claude-opus-5"),
            Some("plan"),
            Some("high"),
            &[],
        );
        assert!(args.windows(2).any(|w| w == ["--model", "claude-opus-5"]));
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "high"]));
    }

    /// Pins the exact argv measured against claude 2.1.220: forking reads the
    /// old id and *writes* the new one, and the CLI honours the id we pass.
    /// Verified live - the fork answered from the original's context, reported
    /// the id Sway chose, and the original transcript never saw the fork's turn.
    #[test]
    fn a_fork_reads_the_old_session_and_claims_the_new_one() {
        let args = build_args(claude_chat(), "new-id", false, Some("old-id"), None, None, None, &[]);
        assert!(args.windows(2).any(|w| w == ["--resume", "old-id"]));
        assert!(args.windows(2).any(|w| w == ["--session-id", "new-id"]));
        assert!(args.iter().any(|a| a == "--fork-session"));
    }

    /// The three ways to name a session are mutually exclusive. A fork that also
    /// emitted a bare `--session-id`/`--resume` pair would be contradictory, and
    /// a resume flag left in would reuse the id the fork exists to avoid.
    #[test]
    fn naming_a_session_picks_exactly_one_form() {
        let fork = build_args(claude_chat(), "new-id", true, Some("old-id"), None, None, None, &[]);
        // `resume: true` is ignored outright rather than layered on: a fork that
        // also resumed in place would write into the session it forked from.
        assert_eq!(fork.iter().filter(|a| *a == "--resume").count(), 1);
        assert!(fork.windows(2).all(|w| w != ["--resume", "new-id"]));

        let resumed = build_args(claude_chat(), "s1", true, None, None, None, None, &[]);
        assert!(resumed.windows(2).any(|w| w == ["--resume", "s1"]));
        assert!(!resumed.iter().any(|a| a == "--fork-session"));
        assert!(!resumed.iter().any(|a| a == "--session-id"));

        let fresh = build_args(claude_chat(), "s1", false, None, None, None, None, &[]);
        assert!(fresh.windows(2).any(|w| w == ["--session-id", "s1"]));
        assert!(!fresh.iter().any(|a| a == "--resume"));
    }


    /// Mid-turn quit recovery. The transcript cannot answer this: a killed turn
    /// and a finished one both just stop, so Sway records its own side.
    #[test]
    fn an_open_turn_survives_a_quit_and_is_announced_exactly_once() {
        let sid = format!("open-turn-test-{}", std::process::id());

        // Nothing recorded yet: a session that never ran reports no interruption.
        assert_eq!(take_interrupted_turn(&sid), None);

        // A turn opens, and Sway goes away before it completes.
        mark_turn(&sid, Some("turn-3".into())).unwrap();
        let found = take_interrupted_turn(&sid);
        assert_eq!(found.map(|o| o.turn_id), Some("turn-3".to_string()));

        // Consumed on read, so reopening the tab again does not re-announce a
        // turn the user has already dealt with.
        assert_eq!(take_interrupted_turn(&sid), None);

        let _ = std::fs::remove_file(open_turn_path(&sid));
    }

    #[test]
    fn a_completed_turn_leaves_nothing_to_recover() {
        let sid = format!("closed-turn-test-{}", std::process::id());

        mark_turn(&sid, Some("turn-1".into())).unwrap();
        mark_turn(&sid, None).unwrap();
        assert_eq!(take_interrupted_turn(&sid), None);

        // Clearing twice is normal (a completion after an interrupt) and is not
        // an error.
        mark_turn(&sid, None).unwrap();

        let _ = std::fs::remove_file(open_turn_path(&sid));
    }

    /// Only the newest open turn matters: a second `turnStarted` replaces the
    /// mark rather than accumulating, so recovery names the turn that was
    /// actually running.
    #[test]
    fn a_later_turn_replaces_the_recorded_one() {
        let sid = format!("replace-turn-test-{}", std::process::id());

        mark_turn(&sid, Some("turn-1".into())).unwrap();
        mark_turn(&sid, Some("turn-2".into())).unwrap();
        let found = take_interrupted_turn(&sid);
        assert_eq!(found.map(|o| o.turn_id), Some("turn-2".to_string()));

        let _ = std::fs::remove_file(open_turn_path(&sid));
    }

    #[test]
    fn each_extra_directory_gets_its_own_flag() {
        let args = build_args(
            claude_chat(),
            "s1",
            false, None,
            None,
            None,
            None,
            &["/a".to_string(), "/b".to_string()],
        );
        assert!(args.windows(2).any(|w| w == ["--add-dir", "/a"]));
        assert!(args.windows(2).any(|w| w == ["--add-dir", "/b"]));
        assert_eq!(args.iter().filter(|a| *a == "--add-dir").count(), 2);
    }

    /// **No pick, no flag**, which is the rule that actually matters here: a
    /// session nobody chose a model for starts on the CLI's own default rather
    /// than on one Sway asserted.
    ///
    /// What this test used to say was that an *undeclared* model was dropped,
    /// back when `[[chat.models]]` was a list and `model_args_for` gated on it.
    /// That gate is gone with the list: a hand-maintained table deciding what
    /// the user may run meant a model the CLI offered but the TOML had not
    /// caught up with produced no `--model` and silently ran something else.
    /// Which models exist is the catalogue's answer now, and the frontend drops
    /// a stored pick the catalogue does not offer (`restoredPicks`) before it
    /// can reach here.
    #[test]
    fn no_model_asked_for_means_no_model_flag() {
        let args = build_args(claude_chat(), "s1", false, None, None, None, None, &[]);
        assert!(!args.iter().any(|a| a == "--model"));

        // And an id that no TOML mentions now reaches the argv, because the
        // catalogue it came from is what vouched for it.
        let args = build_args(claude_chat(), "s1", false, None, Some("some-new-model"), None, None, &[]);
        assert!(args.windows(2).any(|w| w == ["--model", "some-new-model"]));
    }

    /// **A mode is not treated like a model, on purpose.**
    ///
    /// Both would be safe to omit, in that the CLI would fall back to its own
    /// default either way. The difference is that a mode is a claim about what
    /// the agent may do *without asking*, and the picker shows one: omitting it
    /// silently leaves the session on a default while the control still
    /// displays the mode that was dropped, which is the one disagreement here
    /// that could matter. So an unresolvable mode resolves to the adapter's
    /// declared default and is asserted explicitly, and `chat_spawn` says so.
    #[test]
    fn an_undeclared_mode_downgrades_to_the_adapters_default_rather_than_vanishing() {
        let args = build_args(claude_chat(), "s1", false, None, None, Some("no-such-mode"), None, &[]);
        assert!(
            args.windows(2).any(|w| w == ["--permission-mode", "default"]),
            "expected the adapter's declared default in {args:?}"
        );
        assert!(!args.iter().any(|a| a == "no-such-mode"), "the unresolvable mode must not reach the child");
    }

    /// No pick stays no flag: Sway asserting a mode nobody chose would be a
    /// different session from the one the CLI would have started.
    #[test]
    fn no_mode_at_all_passes_no_mode_flag() {
        let args = build_args(claude_chat(), "s1", false, None, None, None, None, &[]);
        assert!(!args.iter().any(|a| a == "--permission-mode"));
    }

    /// A fresh session is whatever the caller said, and "nothing" is the
    /// default account rather than a refusal.
    #[test]
    fn a_session_with_no_transcript_keeps_the_callers_profile() {
        assert_eq!(resolve_profile(None, None).unwrap(), "default");
        assert_eq!(resolve_profile(Some("default"), None).unwrap(), "default");
        // A chat killed before its first turn wrote a file: nothing on disk to
        // ask, so the tab is the only thing that knows which account it is on.
        assert_eq!(resolve_profile(Some("fonn"), None).unwrap(), "fonn");
    }

    /// The root that holds the transcript is the account, so a caller that
    /// forgot to pass one still resumes into the right home.
    #[test]
    fn a_resume_takes_its_profile_from_the_matched_root() {
        assert_eq!(resolve_profile(None, Some("fonn")).unwrap(), "fonn");
        assert_eq!(resolve_profile(Some("fonn"), Some("fonn")).unwrap(), "fonn");
    }

    /// The failure this rule exists for: a caller naming a different account is
    /// refused, rather than resuming somebody else's session in the wrong home.
    #[test]
    fn a_resume_naming_a_different_account_is_refused() {
        let err = resolve_profile(Some("default"), Some("fonn")).unwrap_err();
        assert!(err.contains("fonn"), "the error names the account the session is actually in: {err}");
        assert!(resolve_profile(Some("fonn"), Some("default")).is_err());
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
            profile_id: Some("fonn".into()),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["ownership"]["type"], "granted");
        assert_eq!(json["ownership"]["contested"], true, "the warning must reach the frontend");
    }

    /// The resolved profile is what the tab has to store: a resume passing
    /// `None` runs under the transcript's account, and a tab that kept its own
    /// `null` would file that session's quota readings under no account at all.
    #[test]
    fn the_resolved_profile_reaches_the_frontend() {
        let resolved = resolve_profile(None, Some("fonn")).unwrap();
        let result = SpawnResult {
            ownership: ClaimOutcome::Granted { contested: false },
            spawned: Some(Spawned::Started),
            profile_id: Some(resolved),
        };
        assert_eq!(serde_json::to_value(&result).unwrap()["profileId"], "fonn");
    }

    /// A refusal is a normal answer, not an error, so the frontend can focus the
    /// holding tab rather than parse a string.
    #[test]
    fn a_refusal_is_reported_as_a_value_with_nothing_spawned() {
        let result = SpawnResult {
            ownership: ClaimOutcome::HeldByOther { surface: Surface::PtyAgent, tab_id: "pty-1".into() },
            spawned: None,
            profile_id: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["ownership"]["type"], "heldByOther");
        assert_eq!(json["ownership"]["tabId"], "pty-1");
        assert!(json["spawned"].is_null());
        // Nothing was started, so there is no account of record to report.
        assert!(json["profileId"].is_null());
    }

    /// **The whole of what shipping an ACP agent costs**: a TOML naming the
    /// transport, and the launch it composes.
    ///
    /// Pinned end to end from the bundled adapter rather than from a fixture,
    /// because the claim [[adr_agent_breadth]] rests on is that this file is
    /// all there was. Every arg template an ACP adapter leaves empty is asserted
    /// empty here: a stray `--session-id` would be sent to an agent that mints
    /// its own ids in-protocol and would fail at spawn, on a path no unit test
    /// of the transport would reach.
    #[test]
    fn the_bundled_opencode_adapter_composes_its_whole_launch_and_gets_an_acp_transport() {
        let adapter = agents::find("opencode").expect("opencode ships bundled");
        let chat = adapter.chat.as_ref().expect("with a chat transport");
        assert_eq!(chat.transport, ChatTransport::Acp);
        // Defaulted from `[launch] program`, not restated in `[chat]`.
        assert_eq!(chat.program, "opencode");

        let args = build_args(chat, "sway-minted-id", false, None, None, None, None, &[]);
        assert_eq!(args, vec!["acp"], "the launch is `opencode acp` and nothing else");

        // A resume composes the same command: reopening is `session/load` inside
        // the protocol, so there is no second command line for it.
        let resumed = build_args(chat, "sway-minted-id", true, None, None, None, None, &[]);
        assert_eq!(resumed, vec!["acp"]);

        // And a model choice does not become a flag, because the switch is a
        // request. A `model_args` template here would silently win over it.
        let with_model =
            build_args(chat, "s", false, None, Some("github-copilot/claude-sonnet-4.6"), None, None, &[]);
        assert_eq!(with_model, vec!["acp"]);

        let t = make_transport(chat.transport, "s1", "opencode", chat.acp.clone(), Vec::new(), false);
        assert!(t.child_pid().is_none(), "a transport is inert until started");
    }

    #[test]
    fn the_claude_transport_is_what_the_factory_builds_for_the_bundled_adapter() {
        let chat = claude_chat();
        assert_eq!(chat.transport, ChatTransport::ClaudeStreamJson);
        let t = make_transport(
            chat.transport,
            "s1",
            "claude",
            Default::default(),
            chat.effort_extras.clone(),
            false,
        );
        assert!(t.child_pid().is_none(), "a transport is inert until started");
    }
}
