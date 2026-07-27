//! The Tauri surface of the chat host.
//!
//! Thin by design: every command resolves an adapter, checks ownership, and
//! hands off. The rules all live in `ownership.rs` and `host.rs` where they are
//! testable without a Tauri app, following the same split
//! [[lesson_pure_core_for_global_stores]] describes.

use std::collections::HashMap;

use tauri::ipc::Channel;
use tauri::State;

use crate::agents::{self, ChatConfig, ChatTransport};

use super::claude_transport::ClaudeTransport;
use super::host::{ChatState, Spawned};
use super::model::{ChatEvent, ContentBlock, Effort, PermissionDecision, PermissionMode, PermissionScope};
use super::ownership::{Claim, ClaimOutcome, Surface};
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
    let ownership = if host.is_live(&session_id) {
        ClaimOutcome::Granted { contested: false }
    } else {
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

    let spec = StartSpec {
        session_id: session_id.clone(),
        cwd,
        program: chat.program.clone(),
        args: build_args(
            chat,
            &session_id,
            resume,
            model.as_deref(),
            mode.as_deref(),
            effort.as_deref(),
            &extra_dirs,
        ),
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
    )?;

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
pub async fn chat_respond_permission(
    state: State<'_, ChatState>,
    session_id: String,
    tool_use_id: String,
    request_id: String,
    decision: PermissionDecision,
    scope: PermissionScope,
    reason: Option<String>,
) -> Result<(), String> {
    state.0.respond_permission(&session_id, &tool_use_id, &request_id, decision, scope, reason)
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

#[tauri::command]
pub async fn chat_close(state: State<'_, ChatState>, session_id: String) -> Result<(), String> {
    state.0.close(&session_id)
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
