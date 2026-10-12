//! A second opinion: another agent, read-only and out of sight, reads a
//! session's work since its review mark and leaves findings anchored to lines.
//! The findings are kept per worktree, so they outlive a relaunch, and their
//! status is kept beside them, so a sent or dropped one never comes back.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::chat::commands::{spawn_session, SpawnRequest};
use crate::chat::host::{ChatHost, ChatState};
use crate::chat::model::{
    ChatConfigKind, ChatConfigValue, ChatEvent, ContentBlock, PermissionDecision, PermissionScope,
};
use crate::checkpoint::CheckpointFile;
use crate::rpc::events::{EndReason, TurnBy};
use crate::sessions::SessionIndex;

const CHANGED_EVENT: &str = "second-opinion://changed";
const STATE_KIND: &str = "second-opinion";
const REVIEW_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const START_TIMEOUT: Duration = Duration::from_secs(90);
const MODE_TIMEOUT: Duration = Duration::from_secs(30);
const LINE_CAP: u32 = 2000;

const LOCKFILES: &[&str] = &[
    "Cargo.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "Gemfile.lock",
    "poetry.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
];

const DENIED: &str = "A second opinion is read-only. Do not act; finish the review in plain text.";
const NO_ANSWER: &str = "Nobody is here to answer. Finish the review with what you have.";

/// How each reviewer agent is held to reading. An agent missing here has no
/// mode Tori can confirm as read-only, so it cannot review.
#[derive(Clone, Copy)]
enum ReadOnly {
    /// A launch flag, confirmed from the mode the session reports it started in.
    Flag(&'static str),
    /// A `mode` config option, set and confirmed before the brief goes out.
    Option(&'static str),
}

const REVIEWERS: &[(&str, ReadOnly)] = &[
    ("claude", ReadOnly::Flag("plan")),
    ("codex", ReadOnly::Option("read-only")),
];

fn read_only(agent: &str) -> Option<ReadOnly> {
    REVIEWERS.iter().find(|(id, _)| *id == agent).map(|(_, how)| *how)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    #[default]
    Open,
    Sent,
    Dismissed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    /// Absolute.
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub body: String,
    /// The file's blob when the run started, `None` for a file the span deleted.
    pub blob: Option<String>,
    #[serde(default)]
    pub status: Status,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub reviewer: String,
    pub ts: u64,
    #[serde(default)]
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub error: Option<String>,
}

type Store = BTreeMap<String, Review>;

static STORE_LOCK: Mutex<()> = Mutex::new(());
static RUNNING: std::sync::LazyLock<Mutex<HashSet<String>>> = std::sync::LazyLock::new(Mutex::default);

// Keyed by the worktree's top level, so a session's cwd and a diff tab's
// folder find one file however each spells the path.
fn store_path(folder: &str) -> PathBuf {
    let root = crate::checkpoint::git_capture(folder, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| folder.to_string());
    crate::owned_state::project_state_path(STATE_KIND, &root)
}

fn load(path: &Path) -> Store {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(path, &text)
}

fn update(folder: &str, change: impl FnOnce(&mut Store)) -> Result<(), String> {
    let _held = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = store_path(folder);
    let mut store = load(&path);
    change(&mut store);
    save(&path, &store)
}

fn running(id: &str) -> bool {
    RUNNING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(id)
}

/// The agents a second opinion can run on.
#[tauri::command]
pub fn second_opinion_reviewers() -> Vec<String> {
    REVIEWERS.iter().map(|(id, _)| (*id).to_string()).collect()
}

/// The sessions with a second opinion running now.
#[tauri::command]
pub fn second_opinion_running() -> Vec<String> {
    RUNNING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .cloned()
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingView {
    #[serde(flatten)]
    pub finding: Finding,
    pub stale: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewView {
    pub session: String,
    /// The reviewed session as the sidebar lists it, so a send can resume it.
    /// `None` once its transcript is gone.
    pub author: Option<crate::sessions::SessionMeta>,
    pub reviewer: String,
    pub ts: u64,
    pub error: Option<String>,
    pub findings: Vec<FindingView>,
}

/// Every stored review for sessions in `folder`, each finding marked stale
/// when its file no longer holds the blob it was reviewed at.
#[tauri::command(async)]
pub fn second_opinion_list(index: State<SessionIndex>, folder: String) -> Vec<ReviewView> {
    let store = {
        let _held = STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        load(&store_path(&folder))
    };
    if store.is_empty() {
        return Vec::new();
    }
    let sessions = crate::sessions::listed_sessions(&index, Some(&folder));
    store
        .into_iter()
        .map(|(session, review)| ReviewView {
            author: sessions.iter().find(|s| s.id == session).cloned(),
            session,
            reviewer: review.reviewer,
            ts: review.ts,
            error: review.error,
            findings: review
                .findings
                .into_iter()
                .map(|finding| FindingView {
                    stale: live_blob(&folder, &finding.path) != finding.blob,
                    finding,
                })
                .collect(),
        })
        .collect()
}

fn live_blob(folder: &str, path: &str) -> Option<String> {
    if !Path::new(path).is_file() {
        return None;
    }
    crate::checkpoint::git_capture(folder, &["hash-object", "--", path])
        .ok()
        .map(|s| s.trim().to_string())
}

/// Record what happened to findings: sent to the author, or dropped.
#[tauri::command(async)]
pub fn second_opinion_set_status(
    app: AppHandle,
    folder: String,
    session: String,
    ids: Vec<String>,
    status: Status,
) -> Result<(), String> {
    update(&folder, |store| {
        if let Some(review) = store.get_mut(&session) {
            for finding in review.findings.iter_mut().filter(|f| ids.contains(&f.id)) {
                finding.status = status;
            }
        }
    })?;
    let _ = app.emit(CHANGED_EVENT, &session);
    Ok(())
}

/// Start a second opinion on a session's work since its review mark. Returns
/// once the reviewer is on its way; the findings arrive on `CHANGED_EVENT`.
#[tauri::command(async)]
pub fn second_opinion_run(
    app: AppHandle,
    index: State<SessionIndex>,
    session: String,
    agent: String,
    profile: Option<String>,
) -> Result<(), String> {
    let how = read_only(&agent).ok_or_else(|| format!("{agent} has no read-only mode, so it can't review."))?;
    if running(&session) {
        return Err("A second opinion is already running for this session.".into());
    }
    let span = crate::review::span_now(&index, &session)?;
    let subject = Subject::of(&span)?;
    let task = task_of(&span);
    let brief = brief(&task, &subject);
    let folder = span.session.cwd.clone();
    if !RUNNING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(session.clone())
    {
        return Err("A second opinion is already running for this session.".into());
    }
    let _ = app.emit(CHANGED_EVENT, &session);
    std::thread::Builder::new()
        .name(format!("second-opinion-{session}"))
        .spawn({
            let session = session.clone();
            move || {
                let host = &app.state::<ChatState>().0;
                let review = match drive(host, &agent, profile, &folder, &brief, how) {
                    Ok(reply) => match findings_of(&reply, &subject) {
                        Some(findings) => Review {
                            reviewer: agent,
                            ts: crate::owned_state::now_ms() / 1000,
                            findings,
                            error: None,
                        },
                        None => failed(agent, "The reviewer answered without the findings block."),
                    },
                    Err(e) => failed(agent, &e),
                };
                let _ = update(&folder, |store| {
                    store.insert(session.clone(), review);
                });
                RUNNING
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&session);
                let _ = app.emit(CHANGED_EVENT, &session);
            }
        })
        .map_err(|e| {
            RUNNING
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&session);
            format!("could not start the reviewer: {e}")
        })?;
    Ok(())
}

fn failed(reviewer: String, error: &str) -> Review {
    Review {
        reviewer,
        ts: crate::owned_state::now_ms() / 1000,
        findings: Vec::new(),
        error: Some(error.to_string()),
    }
}

/// What the reviewer is shown, fixed at the start of the run.
#[derive(Debug, Clone, PartialEq)]
struct Subject {
    root: String,
    diff: String,
    /// Repo-relative path to the blob it held when the run started.
    files: BTreeMap<String, Option<String>>,
    left_out: Vec<String>,
    lockfiles: Vec<String>,
}

impl Subject {
    fn of(span: &crate::review::Span) -> Result<Self, String> {
        let repo = span.session.cwd.as_str();
        if span.files.is_empty() {
            return Err("Nothing to review: this session changed nothing since it was last marked reviewed.".into());
        }
        let root = crate::checkpoint::git_capture(repo, &["rev-parse", "--show-toplevel"])?
            .trim()
            .to_string();
        let picked = pick(&span.files);
        if picked.included.is_empty() {
            return Err("Nothing to review: every changed file is a lockfile or too large to send.".into());
        }
        let mut args = vec!["diff".to_string(), span.before.clone(), span.after.clone(), "--".into()];
        args.extend(picked.included.iter().map(|f| format!(":(top){}", f.path)));
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let diff = crate::checkpoint::git_capture(repo, &args)?;
        let files = span
            .files
            .iter()
            .filter(|f| !is_lockfile(&f.path))
            .map(|f| {
                let blob = (f.status != "deleted")
                    .then(|| {
                        crate::checkpoint::git_capture(repo, &["rev-parse", &format!("{}:{}", span.after, f.path)])
                    })
                    .and_then(Result::ok)
                    .map(|s| s.trim().to_string());
                (f.path.clone(), blob)
            })
            .collect();
        Ok(Self {
            root,
            diff,
            files,
            left_out: picked.left_out,
            lockfiles: picked.lockfiles,
        })
    }
}

struct Picked<'a> {
    included: Vec<&'a CheckpointFile>,
    left_out: Vec<String>,
    lockfiles: Vec<String>,
}

fn is_lockfile(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    LOCKFILES.contains(&name)
}

fn pick(files: &[CheckpointFile]) -> Picked<'_> {
    let mut out = Picked {
        included: Vec::new(),
        left_out: Vec::new(),
        lockfiles: Vec::new(),
    };
    let mut lines = 0;
    for file in files {
        if is_lockfile(&file.path) {
            out.lockfiles.push(file.path.clone());
        } else if lines + file.added + file.removed > LINE_CAP {
            out.left_out.push(file.path.clone());
        } else {
            lines += file.added + file.removed;
            out.included.push(file);
        }
    }
    out
}

/// Every prompt since the mark, or the first one when the agent keeps no
/// transcript Tori can read prompts from.
fn task_of(span: &crate::review::Span) -> String {
    let session = &span.session;
    let prompts: Vec<String> = crate::sessions::session_prompts_body(session.path.clone(), session.agent.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.ts > span.since)
        .map(|p| p.text)
        .collect();
    if !prompts.is_empty() {
        return prompts.join("\n\n");
    }
    crate::chat::commands::first_prompt(&session.id, &session.agent).unwrap_or_else(|| session.title.clone())
}

fn brief(task: &str, subject: &Subject) -> String {
    let mut out = format!(
        "You are giving a second opinion on another agent's work in {root}. You are read-only: do not edit \
         files, do not run anything that changes state, and do not call ExitPlanMode. Answer in plain text.\n\n\
         What the author was asked to do:\n\n{task}\n\n\
         The author's changes, paths relative to {root}:\n\n```diff\n{diff}\n```\n",
        root = subject.root,
        diff = subject.diff.trim_end(),
    );
    if !subject.left_out.is_empty() {
        out.push_str(&format!(
            "\nLeft out because the diff is too large, read them yourself if they matter: {}\n",
            subject.left_out.join(", ")
        ));
    }
    if !subject.lockfiles.is_empty() {
        out.push_str(&format!("\nLockfiles left out: {}\n", subject.lockfiles.join(", ")));
    }
    out.push_str(
        "\nLook for bugs, missed requirements and risky changes. Comment only on lines the diff adds or \
         changes, and skip style nits.\n\n\
         End your reply with exactly one JSON block in this shape:\n\n\
         ```json\n{\"comments\": [{\"path\": \"src/a.rs\", \"startLine\": 10, \"line\": 12, \"body\": \"...\"}]}\n```\n\n\
         `path` is relative to the repository root, `line` is the last line of the range on the new side and \
         `startLine` the first (leave it out for one line). An empty list means nothing worth raising.\n",
    );
    out
}

/// What the reviewer said: its main text, and the plan it tried to hand over
/// through ExitPlanMode, which claude in plan mode reaches for despite the brief.
#[derive(Debug, Default)]
struct Reply {
    text: String,
    plan: Option<String>,
}

fn drive(
    host: &ChatHost,
    agent: &str,
    profile: Option<String>,
    folder: &str,
    brief: &str,
    how: ReadOnly,
) -> Result<Reply, String> {
    let id = crate::rpc::runner::new_session_id();
    let (tx, rx) = mpsc::channel::<ChatEvent>();
    let tx = Mutex::new(tx);
    let spawned = spawn_session(
        host,
        SpawnRequest {
            session_id: id.clone(),
            tab_id: format!("second-opinion-{id}"),
            agent_id: agent.to_string(),
            cwd: folder.to_string(),
            resume: false,
            fork_from: None,
            profile,
            model: None,
            mode: match how {
                ReadOnly::Flag(mode) => Some(mode.to_string()),
                ReadOnly::Option(_) => None,
            },
            effort: None,
            extra_dirs: Vec::new(),
            visible: false,
            background: false,
            spawner: None,
        },
        Box::new(move |event| {
            if let Ok(tx) = tx.lock() {
                let _ = tx.send(event);
            }
        }),
    )?;
    if spawned.spawned.is_none() {
        return Err(format!("the reviewer's session was refused: {:?}", spawned.ownership));
    }
    let result = review(host, &id, &rx, brief, how);
    let _ = host.close(&id, EndReason::Closed);
    result
}

fn review(host: &ChatHost, id: &str, rx: &Receiver<ChatEvent>, brief: &str, how: ReadOnly) -> Result<Reply, String> {
    let mut watch = Watch::new(how);
    if let ReadOnly::Option(value) = how {
        let deadline = Instant::now() + START_TIMEOUT;
        while !watch.started {
            watch.see(host, id, next(rx, deadline, "The reviewer never opened its session.")?)?;
        }
        let option = watch
            .mode_option
            .clone()
            .ok_or_else(|| "The reviewer offers no read-only mode.".to_string())?;
        host.set_config_option(id, &option, ChatConfigValue::Value(value.to_string()))?;
        let deadline = Instant::now() + MODE_TIMEOUT;
        while !watch.read_only {
            watch.see(
                host,
                id,
                next(rx, deadline, "The reviewer never confirmed read-only mode.")?,
            )?;
        }
    }
    let text = crate::rpc::events::from_tori("second-opinion", None, brief);
    host.deliver(id, vec![ContentBlock::Text { text }], false, TurnBy::Local)?;
    let deadline = Instant::now() + REVIEW_TIMEOUT;
    loop {
        let event = next(rx, deadline, "The reviewer ran past 15 minutes and was stopped.")?;
        if matches!(event, ChatEvent::TurnCompleted { .. }) {
            return Ok(watch.reply);
        }
        watch.see(host, id, event)?;
    }
}

fn next(rx: &Receiver<ChatEvent>, deadline: Instant, late: &str) -> Result<ChatEvent, String> {
    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(event) => Ok(event),
        Err(RecvTimeoutError::Timeout) => Err(late.to_string()),
        Err(RecvTimeoutError::Disconnected) => Err("The reviewer's session went away.".into()),
    }
}

struct Watch {
    how: ReadOnly,
    started: bool,
    mode_option: Option<String>,
    read_only: bool,
    reply: Reply,
}

impl Watch {
    fn new(how: ReadOnly) -> Self {
        Self {
            how,
            started: false,
            mode_option: None,
            read_only: false,
            reply: Reply::default(),
        }
    }

    fn see(&mut self, host: &ChatHost, id: &str, event: ChatEvent) -> Result<(), String> {
        match event {
            ChatEvent::SessionStarted { permission_mode, .. } => {
                self.started = true;
                if let ReadOnly::Flag(mode) = self.how {
                    if permission_mode.as_str() != mode {
                        return Err(format!(
                            "The reviewer started in {} mode instead of {mode}, so it was stopped.",
                            permission_mode.as_str()
                        ));
                    }
                }
            }
            ChatEvent::ConfigOptions { options, .. } => {
                let ReadOnly::Option(value) = self.how else {
                    return Ok(());
                };
                let Some(option) = options.iter().find(|o| o.category == "mode") else {
                    return Ok(());
                };
                let ChatConfigKind::Select { current, choices } = &option.kind else {
                    return Ok(());
                };
                if choices.iter().any(|c| c.value == value) {
                    self.mode_option = Some(option.id.clone());
                }
                let now = current == value;
                if self.read_only && !now {
                    return Err("The reviewer left read-only mode, so it was stopped.".into());
                }
                self.read_only = now;
            }
            ChatEvent::PermissionRequest {
                tool_use_id,
                request_id,
                tool_name,
                input,
                ..
            } => {
                if tool_name == "ExitPlanMode" {
                    if let Some(plan) = input.get("plan").and_then(|p| p.as_str()) {
                        self.reply.plan = Some(plan.to_string());
                    }
                }
                host.answer_permission(
                    id,
                    &tool_use_id,
                    &request_id,
                    PermissionDecision::Deny,
                    PermissionScope::Once,
                    Some(DENIED),
                )?;
            }
            ChatEvent::QuestionRequest {
                tool_use_id, questions, ..
            } => {
                let answers = vec![NO_ANSWER.to_string(); questions.len()];
                host.settle(id, &tool_use_id, &answers)?;
            }
            ChatEvent::TextDelta {
                text, agent_id: None, ..
            } => self.reply.text.push_str(&text),
            ChatEvent::SessionError {
                message, fatal: true, ..
            } => return Err(message),
            ChatEvent::SessionEnded { .. } => return Err("The reviewer ended before it answered.".into()),
            _ => {}
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct Draft {
    comments: Vec<DraftComment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftComment {
    path: String,
    line: u32,
    #[serde(default)]
    start_line: Option<u32>,
    body: String,
}

/// The last findings block in `text`: a fenced one first, then any bare object
/// that reads as one.
fn parse_draft(text: &str) -> Option<Draft> {
    let fenced = text
        .split("```")
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, block)| {
            let block = block.trim_start();
            block.strip_prefix("json").unwrap_or(block)
        });
    if let Some(draft) = fenced
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .find_map(|b| serde_json::from_str(b.trim()).ok())
    {
        return Some(draft);
    }
    text.match_indices('{').rev().find_map(|(i, _)| {
        serde_json::Deserializer::from_str(&text[i..])
            .into_iter::<Draft>()
            .next()
            .and_then(Result::ok)
    })
}

fn findings_of(reply: &Reply, subject: &Subject) -> Option<Vec<Finding>> {
    let draft = parse_draft(&reply.text).or_else(|| reply.plan.as_deref().and_then(parse_draft))?;
    let stamp = crate::owned_state::now_ms();
    let root = Path::new(&subject.root);
    Some(
        draft
            .comments
            .into_iter()
            .filter_map(|c| {
                let rel = c
                    .path
                    .strip_prefix(&format!("{}/", subject.root))
                    .unwrap_or(&c.path)
                    .trim_start_matches("./")
                    .to_string();
                let blob = subject.files.get(&rel)?.clone();
                let body = c.body.trim();
                if body.is_empty() || c.line == 0 {
                    return None;
                }
                Some((
                    rel,
                    c.start_line.unwrap_or(c.line).clamp(1, c.line),
                    c.line,
                    body.to_string(),
                    blob,
                ))
            })
            .enumerate()
            .map(|(i, (rel, start_line, end_line, body, blob))| Finding {
                id: format!("so-{stamp}-{i}"),
                path: root.join(rel).to_string_lossy().into_owned(),
                start_line,
                end_line,
                body,
                blob,
                status: Status::Open,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject() -> Subject {
        Subject {
            root: "/repo".into(),
            diff: String::new(),
            files: BTreeMap::from([("src/a.rs".to_string(), Some("blob-a".to_string()))]),
            left_out: Vec::new(),
            lockfiles: Vec::new(),
        }
    }

    fn reply(text: &str) -> Reply {
        Reply {
            text: text.into(),
            plan: None,
        }
    }

    #[test]
    fn a_fenced_block_becomes_findings_on_absolute_paths() {
        let text = "Looks mostly fine.\n\n```json\n{\"comments\": [{\"path\": \"src/a.rs\", \"startLine\": 3, \"line\": 5, \"body\": \"off by one\"}]}\n```\n";
        let found = findings_of(&reply(text), &subject()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "/repo/src/a.rs");
        assert_eq!((found[0].start_line, found[0].end_line), (3, 5));
        assert_eq!(found[0].blob.as_deref(), Some("blob-a"));
        assert_eq!(found[0].status, Status::Open);
    }

    #[test]
    fn a_block_inside_an_exit_plan_mode_input_is_read_when_the_text_has_none() {
        let reply = Reply {
            text: "I'll wait for approval.".into(),
            plan: Some(
                "Review\n```json\n{\"comments\": [{\"path\": \"src/a.rs\", \"line\": 7, \"body\": \"leak\"}]}\n```"
                    .into(),
            ),
        };
        let found = findings_of(&reply, &subject()).unwrap();
        assert_eq!((found[0].start_line, found[0].end_line), (7, 7));
    }

    #[test]
    fn a_reply_without_a_block_is_no_findings_at_all() {
        assert!(findings_of(&reply("All good, nothing to add."), &subject()).is_none());
    }

    #[test]
    fn a_finding_outside_the_span_is_dropped() {
        let text = "```json\n{\"comments\": [{\"path\": \"src/other.rs\", \"line\": 1, \"body\": \"x\"}, {\"path\": \"/repo/src/a.rs\", \"line\": 2, \"body\": \"y\"}]}\n```";
        let found = findings_of(&reply(text), &subject()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].body, "y");
    }
}
