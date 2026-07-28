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
use super::usage;
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
        // The user's harness override wins over the adapter's program name.
        // Read at spawn time rather than cached, so changing it in Settings
        // applies to the next session started without restarting Sway.
        program: crate::settings::harness_override().unwrap_or_else(|| chat.program.clone()),
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
) -> Result<Option<RuleOffer>, String> {
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
        add_rule(&session_id, &cwd, &tool_name, &tool_input, scope, rules::RuleOrigin::Manual)?;
        return Ok(None);
    }
    if matches!(decision, PermissionDecision::Allow) {
        return Ok(note_repeat_approval(&cwd, &tool_name, &tool_input));
    }
    Ok(None)
}

/// How many times the same call must be approved by hand before Sway offers to
/// stop asking.
///
/// Three. Two is a coincidence - the same file opened twice in a row - and by
/// five the offer arrives long after the user started finding it tedious, which
/// is the moment it was meant to catch.
pub const OFFER_AFTER: u32 = 3;

/// An offer to turn a habit into a rule.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleOffer {
    pub tool: String,
    /// What the rule would cover: a directory for a path-shaped tool, the exact
    /// argument otherwise. Shown verbatim, so the user is agreeing to a scope
    /// they can see rather than to the word "project".
    pub prefix: String,
    pub approvals: u32,
}

/// Count one hand-approved call and decide whether to offer a rule for it.
///
/// **Counted here, in the supervisor, and never in the helper.** The helper runs
/// on every tool call and its cheap path is a single file read; a counter
/// written there would put a file write on the path
/// [[concept_pretooluse_approval_bridge]] exists to keep free. This runs once
/// per prompt the user actually answered, which is orders of magnitude rarer.
///
/// Offered **at** the threshold rather than at or above it, so declining is
/// remembered without storing that it was declined: the count keeps climbing and
/// never equals the threshold again.
///
/// A counting failure returns no offer and no error. The call was already
/// allowed and the answer already sent; failing the command over a tally would
/// turn a bookkeeping problem into a visible one.
fn note_repeat_approval(cwd: &str, tool: &str, input: &serde_json::Value) -> Option<RuleOffer> {
    let scope = rules::offer_scope(tool, input)?;
    if scope.is_empty() {
        return None;
    }
    let n = rules::record_approval(&rules::counts_path(cwd), tool, &scope).ok()?;
    (n == OFFER_AFTER).then(|| RuleOffer { tool: tool.to_string(), prefix: scope, approvals: n })
}

/// Accept an offer: write the rule it described, marked as learned.
///
/// Project-scoped, because the offer is made about a project path and the point
/// is to stop being asked in the next chat too - a session-scoped rule would
/// expire with the tab and the same offer would come back tomorrow.
#[tauri::command]
pub async fn chat_accept_rule_offer(
    session_id: String,
    cwd: String,
    tool: String,
    prefix: String,
) -> Result<(), String> {
    let rule = rules::Rule {
        origin: rules::RuleOrigin::Learned,
        ..rules::Rule::allow(&tool, Some(&prefix))
    };
    write_rule(&session_id, &cwd, rule, true)
}

/// Add a rule to a session's compiled file, and to the project's durable file
/// when it is project-scoped.
fn write_rule(session_id: &str, cwd: &str, rule: rules::Rule, project_scoped: bool) -> Result<(), String> {
    let path = rules::rules_path(session_id);
    let mut file = rules::load_ok(&path)
        .unwrap_or_else(|| rules::RuleFile::new(std::process::id(), rules::now_ms(), Vec::new()));
    if !file.rules.iter().any(|r| r.same_scope(&rule)) {
        file.rules.push(rule.clone());
    }
    file.sway_pid = std::process::id();
    file.stamp_ms = rules::now_ms();
    rules::save(&path, &file)?;

    // A project rule also lands in the durable store. Without this it would live
    // only in the session file, which is a compiled artefact deleted at
    // teardown - so "always allow in this project" would quietly mean "until
    // this tab closes", which is not what the button says.
    if project_scoped {
        let project_path = rules::project_rules_path(cwd);
        // Read strictly, because the next line writes. A file this build cannot
        // parse read as "empty" would be replaced by an empty one, and the
        // durable store is the copy with nothing to rebuild it from.
        let mut project = rules::read_project(&project_path).map_err(|e| {
            format!("Sway could not read this project's saved rules, so it did not change them: {e}")
        })?;
        if !project.rules.iter().any(|r| r.same_scope(&rule)) {
            project.rules.push(rule);
            rules::save_project(&project_path, &project)?;
        }
    }
    Ok(())
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
/// knows its id but not the file the harness writes it to - and the resolution
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
    let tail = crate::sessions::session_prompt_tail(path, agent_id)?;
    Ok(tail.count)
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

/// Arm or clear this session's spend stop.
///
/// Written into the rule file rather than held in memory, because that file is
/// the one thing the hook helper reads on **every** tool call - including the
/// ones a rule already allowed, which never open the approval socket. A ceiling
/// enforced only at the socket would be a ceiling that a session with allow-listed
/// reads could walk straight past.
///
/// Enforcement therefore lands at the next tool boundary, never mid-tool: the
/// hook fires before the call runs, so a refusal here means the tool did not
/// start, not that it was interrupted halfway.
#[tauri::command]
pub async fn chat_set_budget_stop(session_id: String, reason: Option<String>) -> Result<(), String> {
    let path = rules::rules_path(&session_id);
    let mut file = rules::load_ok(&path)
        .unwrap_or_else(|| rules::RuleFile::new(std::process::id(), rules::now_ms(), Vec::new()));
    file.stop = reason;
    file.sway_pid = std::process::id();
    file.stamp_ms = rules::now_ms();
    rules::save(&path, &file)
}

/// Add a restrictive rule: `ask` or `deny`, optionally scoped by a path glob.
///
/// Separate from the allow path on purpose. An allow rule is created by clicking
/// a button on one specific call, so its scope is derived from that call; a
/// restriction is written deliberately about a place in the tree, which is the
/// only reason a glob is offered at all. See the note on `rules::Rule`.
#[tauri::command]
pub async fn chat_add_restriction(
    session_id: String,
    cwd: String,
    tool: String,
    kind: rules::RuleKind,
    glob: Option<String>,
    prefix: Option<String>,
) -> Result<(), String> {
    if matches!(kind, rules::RuleKind::Allow) {
        return Err("Use the permission prompt to allow a tool; this is for restrictions.".into());
    }
    write_rule(session_id.as_str(), cwd.as_str(), rules::Rule { tool, prefix, glob, kind, origin: rules::RuleOrigin::Manual }, true)
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
///
/// `origin` records whether the user reached for this themselves or accepted an
/// offer Sway made after counting repeat approvals, so a rule can be explained
/// later rather than only listed.
fn add_rule(
    session_id: &str,
    cwd: &str,
    tool_name: &str,
    tool_input: &serde_json::Value,
    scope: PermissionScope,
    origin: rules::RuleOrigin,
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
    let rule = rules::Rule { origin, ..rules::Rule::allow(tool_name, prefix.as_deref()) };
    write_rule(session_id, cwd, rule, matches!(scope, PermissionScope::Project))
}

/// Seed a session's compiled rule file from the project's durable one.
fn compile_project_rules(session_id: &str, cwd: &str) -> Result<(), String> {
    let project = rules::load_project(&rules::project_rules_path(cwd));
    let path = rules::rules_path(session_id);
    let existing = rules::load_ok(&path);
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
    pub glob: Option<String>,
    pub kind: rules::RuleKind,
    /// Why this rule exists. A learned rule was accepted from an offer rather
    /// than reached for, so the list can say so instead of leaving the user to
    /// wonder when they wrote it.
    pub origin: rules::RuleOrigin,
    pub scope: PermissionScope,
}

/// Every MCP server configured for `cwd`, across Claude's three scopes.
///
/// Read straight from Claude's own files rather than from `system/init`, so the
/// list is answerable before a session starts and includes servers that failed
/// to connect (which init reports) *and* ones still pending approval (which it
/// does not connect to at all).
#[tauri::command]
pub async fn chat_mcp_list(cwd: String) -> Result<Vec<super::mcp::McpEntry>, String> {
    Ok(super::mcp::list_for(&cwd))
}

#[tauri::command]
pub async fn chat_mcp_add(cwd: String, name: String, config: serde_json::Value) -> Result<Vec<super::mcp::McpEntry>, String> {
    super::mcp::add_to_project(&cwd, &name, config)
}

#[tauri::command]
pub async fn chat_mcp_remove(cwd: String, name: String) -> Result<Vec<super::mcp::McpEntry>, String> {
    super::mcp::remove_from_project(&cwd, &name)
}

/// Every rule in force for this session, project-scoped ones marked as such.
///
/// Read from the compiled session file, which is the file the hook helper
/// actually consults, so the list is what is really in effect rather than a
/// second opinion about it.
#[tauri::command]
pub async fn chat_list_rules(session_id: String, cwd: String) -> Result<Vec<ScopedRule>, String> {
    let project = rules::load_project(&rules::project_rules_path(&cwd));
    let session = rules::load_ok(&rules::rules_path(&session_id)).map(|f| f.rules).unwrap_or_default();
    Ok(session
        .into_iter()
        .map(|r| ScopedRule {
            scope: if project.rules.iter().any(|p| p.same_scope(&r)) {
                PermissionScope::Project
            } else {
                PermissionScope::Session
            },
            tool: r.tool,
            prefix: r.prefix,
            glob: r.glob,
            kind: r.kind,
            origin: r.origin,
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
    glob: Option<String>,
    kind: Option<rules::RuleKind>,
) -> Result<(), String> {
    // Defaulted rather than required, so a caller that predates the restrictive
    // kinds still names an allow rule and cannot accidentally revoke a `deny`
    // that happens to share a tool and prefix with it.
    let target = rules::Rule {
        tool,
        prefix,
        glob,
        kind: kind.unwrap_or(rules::RuleKind::Allow),
        origin: rules::RuleOrigin::Manual,
    };

    let path = rules::rules_path(&session_id);
    if let Some(mut file) = rules::load_ok(&path) {
        file.rules.retain(|r| !r.same_scope(&target));
        // The stamp is refreshed with the write, so the helper's next read is
        // both current and rule-free rather than current and stale-looking.
        file.sway_pid = std::process::id();
        file.stamp_ms = rules::now_ms();
        rules::save(&path, &file)?;
    }

    let project_path = rules::project_rules_path(&cwd);
    // Strict for the same reason as `write_rule`: revoking one rule must not be
    // able to drop every other rule in a file this build could not parse.
    let mut project = rules::read_project(&project_path)
        .map_err(|e| format!("Sway could not read this project's saved rules, so it did not change them: {e}"))?;
    if project.rules.iter().any(|r| r.same_scope(&target)) {
        project.rules.retain(|r| !r.same_scope(&target));
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
/// Works for a session Sway never ran: the file is the harness's own jsonl, and
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
    Ok(super::history::events_from_turns(&session_id, shown))
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

    /// An unknown selection is dropped rather than passed through: sending
    /// `--model not-a-model` would fail the whole session, where omitting it
    /// leaves the CLI on its own default.
    #[test]
    fn an_undeclared_model_or_mode_is_omitted_rather_than_guessed() {
        let args = build_args(claude_chat(), "s1", false, None, Some("no-such-model"), Some("no-such-mode"), None, &[]);
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

        add_rule(&first, &cwd, "Read", &serde_json::json!({"file_path": format!("{cwd}/src/a.rs")}), PermissionScope::Project, rules::RuleOrigin::Manual).unwrap();
        // The tab closes: its compiled file goes with it.
        std::fs::remove_file(rules::rules_path(&first)).unwrap();

        compile_project_rules(&second, &cwd).unwrap();
        let compiled = rules::load_ok(&rules::rules_path(&second)).expect("the new session should have a compiled file");
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

        add_rule(&session, &cwd, "Bash", &serde_json::json!({"command": "git status"}), PermissionScope::Session, rules::RuleOrigin::Manual).unwrap();
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
        add_rule(&session, &cwd, "Read", &input, PermissionScope::Project, rules::RuleOrigin::Manual).unwrap();
        let listed = tauri::async_runtime::block_on(chat_list_rules(session.clone(), cwd.clone())).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(matches!(listed[0].scope, PermissionScope::Project), "a rule from the project store lists as project-scoped");

        tauri::async_runtime::block_on(chat_remove_rule(
            session.clone(),
            cwd.clone(),
            listed[0].tool.clone(),
            listed[0].prefix.clone(),
            listed[0].glob.clone(),
            Some(listed[0].kind),
        ))
        .unwrap();

        // Gone here, and gone for the next chat on this folder.
        assert!(tauri::async_runtime::block_on(chat_list_rules(session.clone(), cwd.clone())).unwrap().is_empty());
        // The point of removing it: the next matching call prompts again rather
        // than taking the cheap path.
        let verdict = rules::evaluate(
            &rules::load(&rules::rules_path(&session)),
            "Read",
            &input,
            rules::now_ms(),
            |_| true,
        );
        assert_eq!(verdict, rules::Verdict::Ask);
        compile_project_rules(&later, &cwd).unwrap();
        assert!(rules::load_ok(&rules::rules_path(&later)).map(|f| f.rules).unwrap_or_default().is_empty());

        cleanup(&session, &cwd);
        let _ = std::fs::remove_file(rules::rules_path(&later));
    }

    /// The guard the whole ownership layer exists for, stated as a fact about
    /// the flags: two live drivers of one session id both resume it and both
    /// append to one transcript.
    /// The offer arrives once, at the threshold, and the rule it writes is
    /// marked as learned so the rule list can explain itself later.
    ///
    /// **Offered at the threshold and not above it**, which is how declining is
    /// remembered without recording that it was declined: the count keeps
    /// climbing and never equals the threshold again. A `>=` here would nag on
    /// every subsequent approval, which is the behaviour that makes people stop
    /// reading prompts.
    #[test]
    fn a_repeatedly_approved_call_is_offered_as_a_rule_exactly_once() {
        let cwd = scratch_project("offer");
        let session = format!("rules-offer-{}", std::process::id());
        cleanup(&session, &cwd);
        let _ = std::fs::remove_file(rules::counts_path(&cwd));
        let call = serde_json::json!({ "file_path": format!("{cwd}/src/a.rs") });

        let mut offers = Vec::new();
        for _ in 0..(OFFER_AFTER + 2) {
            offers.push(note_repeat_approval(&cwd, "Read", &call));
        }
        let made: Vec<_> = offers.iter().flatten().collect();
        assert_eq!(made.len(), 1, "exactly one offer, however many times it is approved");
        assert_eq!(made[0].approvals, OFFER_AFTER);
        assert_eq!(made[0].prefix, format!("{cwd}/src/"));
        assert!(offers[OFFER_AFTER as usize - 1].is_some(), "the offer lands on the threshold approval");

        // Accepting writes a project rule that says where it came from.
        tauri::async_runtime::block_on(chat_accept_rule_offer(
            session.clone(),
            cwd.clone(),
            made[0].tool.clone(),
            made[0].prefix.clone(),
        ))
        .unwrap();
        let listed = tauri::async_runtime::block_on(chat_list_rules(session.clone(), cwd.clone())).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(matches!(listed[0].origin, rules::RuleOrigin::Learned), "a rule from an offer must say so");
        assert!(matches!(listed[0].scope, PermissionScope::Project), "the offer was about the project");

        let _ = std::fs::remove_file(rules::counts_path(&cwd));
        cleanup(&session, &cwd);
    }

    /// A restriction is written about a place in the tree, which is the only
    /// reason a glob exists at all - so the command that writes one refuses to
    /// be used to widen a grant.
    #[test]
    fn the_restriction_command_will_not_write_an_allow_rule() {
        let cwd = scratch_project("restrict");
        let session = format!("rules-restrict-{}", std::process::id());
        cleanup(&session, &cwd);

        assert!(tauri::async_runtime::block_on(chat_add_restriction(
            session.clone(),
            cwd.clone(),
            "Write".into(),
            rules::RuleKind::Allow,
            Some("**".into()),
            None,
        ))
        .is_err());

        tauri::async_runtime::block_on(chat_add_restriction(
            session.clone(),
            cwd.clone(),
            "Write".into(),
            rules::RuleKind::Ask,
            Some("**/migrations/**".into()),
            None,
        ))
        .unwrap();
        let listed = tauri::async_runtime::block_on(chat_list_rules(session.clone(), cwd.clone())).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(matches!(listed[0].kind, rules::RuleKind::Ask));
        assert_eq!(listed[0].glob.as_deref(), Some("**/migrations/**"));

        cleanup(&session, &cwd);
    }

    #[test]
    fn the_claude_transport_is_what_the_factory_builds_for_the_bundled_adapter() {
        let chat = claude_chat();
        assert_eq!(chat.transport, ChatTransport::ClaudeStreamJson);
        let t = make_transport(chat.transport, "s1");
        assert!(t.child_pid().is_none(), "a transport is inert until started");
    }
}
