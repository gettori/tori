//! Verification: what a turn that changed code ran to check it.
//!
//! A fact on the turn, never a gate. The claim is only as strong as the exit
//! that reached the call: a check whose own exit was masked by a pipe, a `;`,
//! a `||`, a background run, an interrupt or a timeout is "ran, exit not seen",
//! and a turn resting on one of those reads unverified, never verified.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use serde::Serialize;
use serde_json::Value;

use crate::chat::model::{ChatEvent, Check, CheckResult, ToolKind, ToolLocation, ToolStatus, ToolSummary, Verdict};
use crate::secret_watch::command_text;

/// Commands that count as a check when no project says otherwise. Each is
/// matched as a word prefix of one command in a shell line, after wrappers
/// like `npx` or `uv run` are taken off.
pub const DEFAULTS: &[&str] = &[
    "cargo test",
    "cargo check",
    "cargo clippy",
    "cargo build",
    "cargo nextest",
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run build",
    "npm run typecheck",
    "npm run check",
    "pnpm test",
    "pnpm lint",
    "pnpm build",
    "pnpm typecheck",
    "pnpm check",
    "yarn test",
    "yarn lint",
    "yarn build",
    "yarn typecheck",
    "yarn check",
    "bun test",
    "bun run test",
    "bun run lint",
    "bun run build",
    "bun run typecheck",
    "bun run check",
    "tsc",
    "vitest",
    "jest",
    "pytest",
    "go test",
    "go vet",
    "mypy",
    "ruff",
    "eslint",
    "make test",
    "make check",
    "gradle test",
    "./gradlew test",
    "swift test",
];

/// The check list for a session in `cwd`: the list of the deepest project
/// holding it, else the defaults. A worktree sits under its project's path, so
/// it finds the project's list.
pub fn entries_for(cwd: Option<&Path>) -> Vec<Vec<String>> {
    match cwd {
        Some(cwd) => entries_in(&settings().commands, cwd),
        None => parse_entries(DEFAULTS.iter().copied()),
    }
}

pub(crate) fn entries_in(commands: &HashMap<String, Vec<String>>, cwd: &Path) -> Vec<Vec<String>> {
    if let Some(list) = project_list(commands, cwd) {
        return parse_entries(list.iter().map(String::as_str));
    }
    match repo_checks(cwd) {
        Some(list) => parse_entries(list.iter().map(String::as_str)),
        None => parse_entries(DEFAULTS.iter().copied()),
    }
}

fn repo_checks(cwd: &Path) -> Option<Vec<String>> {
    let root = crate::ports::root_of(cwd)?;
    crate::project_config::accepted(&root)?
        .checks
        .filter(|list| !list.is_empty())
}

/// The built-in list, for a reset that stays a draft until it is saved.
#[tauri::command]
pub fn verification_defaults() -> Vec<String> {
    DEFAULTS.iter().map(|c| c.to_string()).collect()
}

/// The commands that count as a check in `project`, as written, for the
/// project settings tab to start from.
#[tauri::command]
pub async fn verification_commands(project: String) -> Vec<String> {
    crate::exec::blocking("verification_commands", move || {
        let settings = settings();
        match project_list(&settings.commands, Path::new(&project)) {
            Some(list) => list.to_vec(),
            None => DEFAULTS.iter().map(|c| c.to_string()).collect(),
        }
    })
    .await
}

fn project_list<'a>(commands: &'a HashMap<String, Vec<String>>, cwd: &Path) -> Option<&'a [String]> {
    commands
        .iter()
        .filter(|(path, list)| !list.is_empty() && cwd.starts_with(path))
        .max_by_key(|(path, _)| Path::new(path).components().count())
        .map(|(_, list)| list.as_slice())
}

fn parse_entries<'a>(list: impl IntoIterator<Item = &'a str>) -> Vec<Vec<String>> {
    list.into_iter()
        .map(|e| strip_wrappers(e.split_whitespace().map(str::to_string).collect()))
        .filter(|w| !w.is_empty())
        .collect()
}

pub fn enabled() -> bool {
    settings().enabled
}

fn settings() -> Arc<crate::settings::Verification> {
    static CACHE: Mutex<Option<(Option<SystemTime>, Arc<crate::settings::Verification>)>> = Mutex::new(None);
    let stamp = crate::settings::modified();
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, settings)) = &*cache {
        if *at == stamp {
            return settings.clone();
        }
    }
    let settings = Arc::new(crate::settings::verification());
    *cache = Some((stamp, settings.clone()));
    settings
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    And,
    Or,
    Seq,
    Pipe,
    Background,
}

#[derive(Debug, Default)]
struct Command {
    words: Vec<String>,
    text: String,
}

// `2>&1` and `&>` stay words, or a redirect would read as a background `&`.
fn split(line: &str) -> Vec<(Command, Option<Op>)> {
    let mut out: Vec<(Command, Option<Op>)> = Vec::new();
    let mut cmd = Command::default();
    let mut word = String::new();
    let mut in_word = false;
    let mut start: Option<usize> = None;
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let mut i = 0;

    let end_word = |cmd: &mut Command, word: &mut String, in_word: &mut bool| {
        if *in_word {
            cmd.words.push(std::mem::take(word));
            *in_word = false;
        }
    };
    let end_cmd = |out: &mut Vec<(Command, Option<Op>)>,
                   cmd: &mut Command,
                   start: &mut Option<usize>,
                   at: usize,
                   op: Option<Op>| {
        if let Some(s) = start.take() {
            cmd.text = line[s..at].trim().to_string();
        }
        let done = std::mem::take(cmd);
        if done.words.is_empty() {
            // `a && && b` or a leading operator: keep the operator on the
            // command before, which is what a shell would have run.
            if let Some(last) = out.last_mut() {
                if op.is_some() {
                    last.1 = op;
                }
            }
            return;
        }
        out.push((done, op));
    };

    while i < chars.len() {
        let (at, c) = chars[i];
        let next = chars.get(i + 1).map(|(_, c)| *c);
        match c {
            '\'' => {
                start.get_or_insert(at);
                in_word = true;
                i += 1;
                while i < chars.len() && chars[i].1 != '\'' {
                    word.push(chars[i].1);
                    i += 1;
                }
            }
            '"' => {
                start.get_or_insert(at);
                in_word = true;
                i += 1;
                while i < chars.len() && chars[i].1 != '"' {
                    if chars[i].1 == '\\' && i + 1 < chars.len() {
                        i += 1;
                    }
                    word.push(chars[i].1);
                    i += 1;
                }
            }
            '\\' => {
                start.get_or_insert(at);
                if let Some(n) = next {
                    if n != '\n' {
                        word.push(n);
                        in_word = true;
                    }
                    i += 1;
                }
            }
            '&' if next == Some('>') || word.ends_with('>') || word.ends_with('<') => {
                start.get_or_insert(at);
                word.push(c);
                in_word = true;
            }
            '&' | '|' | ';' | '\n' => {
                end_word(&mut cmd, &mut word, &mut in_word);
                let (op, skip) = match (c, next) {
                    ('&', Some('&')) => (Op::And, 1),
                    ('|', Some('|')) => (Op::Or, 1),
                    ('|', Some('&')) => (Op::Pipe, 1),
                    ('|', _) => (Op::Pipe, 0),
                    ('&', _) => (Op::Background, 0),
                    _ => (Op::Seq, 0),
                };
                end_cmd(&mut out, &mut cmd, &mut start, at, Some(op));
                i += skip;
            }
            '(' | ')' => end_word(&mut cmd, &mut word, &mut in_word),
            c if c.is_whitespace() => end_word(&mut cmd, &mut word, &mut in_word),
            c => {
                start.get_or_insert(at);
                word.push(c);
                in_word = true;
            }
        }
        i += 1;
    }
    end_word(&mut cmd, &mut word, &mut in_word);
    end_cmd(&mut out, &mut cmd, &mut start, line.len(), None);
    // A trailing `;` or newline ends the line the same as nothing does.
    if let Some(last) = out.last_mut() {
        if last.1 == Some(Op::Seq) {
            last.1 = None;
        }
    }
    out
}

const SETUP: &[&str] = &["cd", "pushd", "popd", "export", "set", "source", "."];
const SHELLS: &[&str] = &["sh", "bash", "zsh"];
const RUNNERS: &[&str] = &["npm", "pnpm", "yarn", "bun", "cargo", "make"];
// Flags a runner takes before its subcommand that carry a value of their own.
const VALUE_FLAGS: &[&str] = &[
    "-C",
    "--dir",
    "--filter",
    "-F",
    "--prefix",
    "--cwd",
    "--manifest-path",
    "--workspace",
    "-w",
];

fn is_assignment(word: &str) -> bool {
    word.split_once('=')
        .is_some_and(|(name, _)| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

fn drop_flags(words: &mut Vec<String>) {
    while words.first().is_some_and(|w| w.starts_with('-')) {
        words.remove(0);
    }
}

fn strip_wrappers(mut words: Vec<String>) -> Vec<String> {
    while words.first().is_some_and(|w| is_assignment(w)) {
        words.remove(0);
    }
    while let Some(head) = words.first().map(String::as_str) {
        let second = words.get(1).map(String::as_str);
        match (head, second) {
            ("timeout", _) => {
                words.remove(0);
                drop_flags(&mut words);
                if !words.is_empty() {
                    words.remove(0);
                }
            }
            ("time" | "nice" | "command" | "npx" | "bunx", _) => {
                words.remove(0);
                drop_flags(&mut words);
            }
            ("env", _) => {
                words.remove(0);
                drop_flags(&mut words);
                while words.first().is_some_and(|w| is_assignment(w)) {
                    words.remove(0);
                }
            }
            ("pnpm" | "npm" | "yarn", Some("exec" | "dlx")) | ("uv" | "poetry", Some("run")) => {
                words.drain(..2);
                drop_flags(&mut words);
            }
            ("python" | "python3", Some("-m")) => {
                words.drain(..2);
            }
            _ => break,
        }
    }
    if let Some(head) = words.first().cloned() {
        if RUNNERS.contains(&head.as_str()) {
            let at = 1;
            while let Some(w) = words.get(at) {
                if w.starts_with('+') && head == "cargo" {
                    words.remove(at);
                } else if VALUE_FLAGS.contains(&w.as_str()) {
                    words.drain(at..(at + 2).min(words.len()));
                } else if w.starts_with('-') {
                    words.remove(at);
                } else {
                    break;
                }
            }
            if head != "npm" && words.get(1).map(String::as_str) == Some("run") {
                words.remove(1);
            }
        }
    }
    words
}

fn matches(entry: &[String], words: &[String]) -> bool {
    if entry.len() > words.len() {
        return false;
    }
    entry.iter().zip(words).enumerate().all(|(i, (e, w))| {
        e == w || (i + 1 == entry.len() && i > 0 && w.strip_prefix(e.as_str()).is_some_and(|r| r.starts_with(':')))
    })
}

enum Role {
    Setup,
    Check(String),
    Other,
}

fn role(cmd: &Command, entries: &[Vec<String>]) -> Role {
    let words = strip_wrappers(cmd.words.clone());
    let Some(head) = words.first() else { return Role::Setup };
    if SETUP.contains(&head.as_str()) {
        return Role::Setup;
    }
    // `npm run test` keeps its `run` because npm needs it; try both spellings.
    let without_run = (words.len() > 1 && words[1] == "run").then(|| {
        let mut w = words.clone();
        w.remove(1);
        w
    });
    // `pnpm vitest` and `yarn tsc` run a package's own binary.
    let bare = matches!(head.as_str(), "pnpm" | "yarn" | "bun").then(|| words[1..].to_vec());
    let hit = entries.iter().any(|e| {
        matches(e, &words)
            || without_run.as_ref().is_some_and(|w| matches(e, w))
            || bare.as_ref().is_some_and(|w| matches(e, w))
    });
    if hit {
        Role::Check(cmd.text.clone())
    } else {
        Role::Other
    }
}

fn commands(line: &str) -> Vec<(Command, Option<Op>)> {
    let mut out = Vec::new();
    for (cmd, op) in split(line) {
        let words = strip_wrappers(cmd.words.clone());
        let inner = match words.as_slice() {
            [shell, flag, script, ..]
                if SHELLS.contains(&shell.as_str()) && flag.starts_with('-') && flag.contains('c') =>
            {
                Some(script.clone())
            }
            _ => None,
        };
        match inner {
            Some(script) => {
                let mut nested = commands(&script);
                if let Some(last) = nested.last_mut() {
                    last.1 = op;
                }
                out.extend(nested);
            }
            None => out.push((cmd, op)),
        }
    }
    out
}

// ACP carries the exit on the summary. Claude has no field for it: a failed
// `Bash` leads its text with `Exit code N`, and one that succeeded exited 0.
fn exit_of(name: &str, status: ToolStatus, output: &str, summary: Option<&ToolSummary>) -> Option<i32> {
    if let Some(ToolSummary::Execute {
        exit_code: Some(code), ..
    }) = summary
    {
        return Some(*code);
    }
    if let Some(code) = output
        .strip_prefix("Exit code ")
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse().ok())
    {
        return Some(code);
    }
    (status == ToolStatus::Ok && name == "Bash").then_some(0)
}

// Measured on claude 2.1: a Bash timeout answers `Exit code 143` then
// `Command timed out after 2s`, and an interrupted call carries the
// `[Request interrupted by user` marker the transcript uses for it.
fn cut_short(output: &str) -> bool {
    output
        .lines()
        .nth(1)
        .is_some_and(|l| l.starts_with("Command timed out"))
        || output.contains("[Request interrupted by user")
}

// A call the user rejected never ran, so it checked nothing.
fn never_ran(status: ToolStatus, output: &str) -> bool {
    status == ToolStatus::Denied || output.starts_with("The user doesn't want to proceed with this tool use")
}

struct Call {
    name: String,
    command: Option<String>,
    background: bool,
    edits: bool,
    paths: Vec<String>,
    started: Option<Instant>,
}

fn target_paths<'a>(input: &'a Value, locations: &'a [ToolLocation]) -> impl Iterator<Item = &'a str> {
    ["file_path", "path", "notebook_path"]
        .into_iter()
        .filter_map(|k| input.get(k).and_then(Value::as_str))
        .chain(locations.iter().map(|l| l.path.as_str()))
}

// Wider than the edits that land, which costs a line each in one git ask
// rather than a second pass.
fn edited_paths(events: &[ChatEvent]) -> Vec<&str> {
    let mut out = Vec::new();
    for event in events {
        match event {
            ChatEvent::ToolCallStarted {
                kind: ToolKind::Edit | ToolKind::Delete | ToolKind::Move,
                input,
                locations,
                ..
            } => {
                out.extend(target_paths(input, locations));
            }
            ChatEvent::FileEdit { path, .. } => out.push(path.as_str()),
            ChatEvent::ToolCallCompleted { files, .. } => out.extend(files.iter().map(String::as_str)),
            _ => {}
        }
    }
    out
}

const UNCHECKED_EXTENSIONS: &[&str] = &[
    "md", "mdx", "markdown", "txt", "rst", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tiff", "svg",
    "pdf", "woff", "woff2", "ttf", "otf", "eot",
];
const UNCHECKED_NAMES: &[&str] = &["license", "changelog", "notice", "authors"];

fn doc_or_asset(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    let extension = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    let doc_extension = extension.as_deref().is_some_and(|e| UNCHECKED_EXTENSIONS.contains(&e));
    let stem = lower.split('.').next().unwrap_or_default();
    let doc_name = UNCHECKED_NAMES.iter().any(|n| {
        stem.strip_prefix(n)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(['-', '_']))
    });
    doc_extension || (doc_name && extension.is_none())
}

// Canonical through the deepest part that exists, so a deleted file and a
// symlinked `/var` still compare against git's canonical root.
fn canonical(path: &Path) -> PathBuf {
    let path = crate::secret_watch::normalize(path);
    let mut head = path.as_path();
    let mut tail = Vec::new();
    loop {
        if let Ok(real) = head.canonicalize() {
            return tail.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        match (head.parent(), head.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                head = parent;
            }
            _ => return path,
        }
    }
}

pub struct Scope {
    cwd: Option<PathBuf>,
    root: std::cell::OnceCell<Option<PathBuf>>,
    asked: std::collections::HashSet<PathBuf>,
    ignored: std::collections::HashSet<PathBuf>,
}

impl Scope {
    pub fn new(cwd: Option<&Path>) -> Self {
        Self {
            // An empty cwd would run git in Tori's own directory.
            cwd: cwd.filter(|c| c.is_absolute()).map(Path::to_path_buf),
            root: std::cell::OnceCell::new(),
            asked: Default::default(),
            ignored: Default::default(),
        }
    }

    fn root(&self) -> Option<&Path> {
        self.root
            .get_or_init(|| {
                let cwd = self.cwd.as_deref()?.to_str()?;
                crate::checkpoint::git_capture(cwd, &["rev-parse", "--show-toplevel"])
                    .ok()
                    .map(|top| canonical(Path::new(&top)))
            })
            .as_deref()
    }

    fn place(&self, raw: &str) -> Option<PathBuf> {
        let path = Path::new(raw);
        if path.is_absolute() {
            return Some(path.to_path_buf());
        }
        self.cwd.as_ref().map(|cwd| cwd.join(path))
    }

    pub fn learn<'a>(&mut self, raws: impl IntoIterator<Item = &'a str>) {
        let raws: Vec<&str> = raws.into_iter().collect();
        if raws.is_empty() {
            return;
        }
        let Some(root) = self.root().map(Path::to_path_buf) else {
            return;
        };
        // Outside paths stay out of the batch: git stops at the first one.
        let mut fresh: Vec<PathBuf> = Vec::new();
        for raw in raws {
            let Some(path) = self.place(raw) else { continue };
            if doc_or_asset(&path) {
                continue;
            }
            let path = canonical(&path);
            if path.starts_with(&root) && path != root && !self.asked.contains(&path) && !fresh.contains(&path) {
                fresh.push(path);
            }
        }
        let Some(dir) = root.to_str() else { return };
        let lines: Vec<String> = fresh.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let hits = crate::fs::gitignored_paths(dir, lines.iter().map(String::as_str));
        for path in fresh {
            if hits.contains(path.to_string_lossy().as_ref()) {
                self.ignored.insert(path.clone());
            }
            self.asked.insert(path);
        }
    }

    pub fn counts(&self, raw: &str) -> bool {
        let Some(path) = self.place(raw) else {
            return true;
        };
        if doc_or_asset(&path) {
            return false;
        }
        let Some(root) = self.root() else {
            return true;
        };
        let path = canonical(&path);
        path.starts_with(root) && !self.ignored.contains(&path)
    }
}

fn checks_of(
    tool_use_id: &str,
    call: &Call,
    status: ToolStatus,
    output: &str,
    summary: Option<&ToolSummary>,
    duration_ms: Option<u64>,
    entries: &[Vec<String>],
) -> Vec<Check> {
    let Some(line) = call.command.as_deref() else {
        return Vec::new();
    };
    if never_ran(status, output) {
        return Vec::new();
    }
    let cmds = commands(line);
    let roles: Vec<Role> = cmds.iter().map(|(c, _)| role(c, entries)).collect();
    if !roles.iter().any(|r| matches!(r, Role::Check(_))) {
        return Vec::new();
    }
    // The run of `&&` at the end of the line: only its commands' exits can be
    // the call's. It counts only when nothing before it could have skipped it.
    let mut first = cmds.len() - 1;
    while first > 0 && cmds[first - 1].1 == Some(Op::And) {
        first -= 1;
    }
    let trusted = (first == 0 || matches!(cmds[first - 1].1, Some(Op::Seq | Op::Background)))
        && cmds.last().is_some_and(|(_, op)| op.is_none())
        && !call.background
        && !cut_short(output);
    let exit = exit_of(&call.name, status, output, summary);
    let not_seen = |command: &str| Check {
        tool_use_id: tool_use_id.to_string(),
        command: command.to_string(),
        result: CheckResult::NotSeen,
        exit_code: None,
        duration_ms,
    };

    let mut out = Vec::new();
    for (i, role) in roles.iter().enumerate() {
        if i < first || !trusted {
            if let Role::Check(text) = role {
                out.push(not_seen(text));
            }
        }
    }
    if !trusted {
        return out;
    }
    let tail: Vec<&Role> = roles[first..].iter().collect();
    let names: Vec<&str> = tail
        .iter()
        .filter_map(|r| match r {
            Role::Check(text) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if names.is_empty() {
        return out;
    }
    if status == ToolStatus::Ok {
        out.extend(names.iter().map(|n| Check {
            tool_use_id: tool_use_id.to_string(),
            command: n.to_string(),
            result: CheckResult::Passed,
            exit_code: exit,
            duration_ms,
        }));
    } else if tail.iter().any(|r| matches!(r, Role::Other)) {
        // Something that is not a check could be what failed.
        out.extend(names.iter().map(|n| not_seen(n)));
    } else {
        out.push(Check {
            tool_use_id: tool_use_id.to_string(),
            command: names.join(" && "),
            result: CheckResult::Failed,
            exit_code: exit,
            duration_ms,
        });
    }
    out
}

enum Step {
    Edit(Vec<String>),
    UnplacedEdit,
    Checks(Vec<Check>),
}

impl Step {
    fn checks(&self) -> Option<&Vec<Check>> {
        match self {
            Step::Checks(c) => Some(c),
            Step::Edit(_) | Step::UnplacedEdit => None,
        }
    }

    fn changes_code(&self, scope: &Scope) -> bool {
        match self {
            Step::Edit(paths) => paths.iter().any(|p| scope.counts(p)),
            Step::UnplacedEdit => true,
            Step::Checks(_) => false,
        }
    }
}

#[derive(Default)]
pub struct Turn {
    calls: HashMap<String, Call>,
    steps: Vec<Step>,
}

impl Turn {
    // `now` is `None` on a replay, which has no timing to measure.
    pub fn observe(&mut self, event: &ChatEvent, now: Option<Instant>, entries: &[Vec<String>]) {
        match event {
            ChatEvent::ToolCallStarted {
                tool_use_id,
                name,
                input,
                kind,
                locations,
                ..
            } => {
                let call = self.calls.entry(tool_use_id.clone()).or_insert_with(|| Call {
                    name: String::new(),
                    command: None,
                    background: false,
                    edits: false,
                    paths: Vec::new(),
                    started: now,
                });
                if !name.is_empty() {
                    call.name = name.clone();
                }
                if matches!(kind, ToolKind::Edit | ToolKind::Delete | ToolKind::Move) {
                    call.edits = true;
                    call.paths.extend(target_paths(input, locations).map(str::to_string));
                }
                if *kind == ToolKind::Execute {
                    if let Some(command) = command_text(input) {
                        call.command = Some(command);
                    }
                    call.background |= input.get("run_in_background").and_then(Value::as_bool) == Some(true);
                }
            }
            ChatEvent::FileEdit { tool_use_id, path, .. } => {
                if let Some(call) = self.calls.get_mut(tool_use_id) {
                    call.edits = true;
                    call.paths.push(path.clone());
                }
            }
            ChatEvent::ToolCallCompleted {
                tool_use_id,
                status,
                output,
                files,
                summary,
                ..
            } => {
                let Some(mut call) = self.calls.remove(tool_use_id) else {
                    return;
                };
                if *status == ToolStatus::Ok && (call.edits || !files.is_empty()) {
                    call.paths.extend(files.iter().cloned());
                    self.steps.push(if call.paths.is_empty() {
                        Step::UnplacedEdit
                    } else {
                        Step::Edit(std::mem::take(&mut call.paths))
                    });
                }
                let duration_ms = match (call.started, now) {
                    (Some(from), Some(to)) => u64::try_from(to.saturating_duration_since(from).as_millis()).ok(),
                    _ => None,
                };
                let checks = checks_of(
                    tool_use_id,
                    &call,
                    *status,
                    output.as_deref().unwrap_or_default(),
                    summary.as_ref(),
                    duration_ms,
                    entries,
                );
                if !checks.is_empty() {
                    self.steps.push(Step::Checks(checks));
                }
            }
            _ => {}
        }
    }

    pub fn edited_paths(&self) -> impl Iterator<Item = &str> {
        self.steps
            .iter()
            .flat_map(|s| match s {
                Step::Edit(paths) => paths.as_slice(),
                Step::UnplacedEdit | Step::Checks(_) => &[],
            })
            .map(String::as_str)
    }

    // The last check call whose every exit was seen.
    fn last_trusted(&self) -> Option<&[Check]> {
        self.steps
            .iter()
            .rev()
            .filter_map(Step::checks)
            .find(|c| c.iter().all(|c| c.result != CheckResult::NotSeen))
            .map(Vec::as_slice)
    }

    /// The verdict and every check the turn ran, or `None` for a turn that
    /// changed no code `scope` counts. Only checks after the last such edit
    /// decide it, and of those the last call's worst result does.
    pub fn finish(&self, scope: &Scope) -> Option<(Verdict, Vec<Check>)> {
        let last_edit = self.steps.iter().rposition(|s| s.changes_code(scope))?;
        let checks: Vec<Check> = self.steps.iter().filter_map(Step::checks).flatten().cloned().collect();
        let verdict = match self.steps[last_edit..].iter().rev().find_map(Step::checks) {
            None => Verdict::Unverified,
            Some(last) if last.iter().any(|c| c.result == CheckResult::Failed) => Verdict::Failed,
            Some(last) if last.iter().any(|c| c.result == CheckResult::NotSeen) => Verdict::Unverified,
            Some(_) => Verdict::Verified,
        };
        Some((verdict, checks))
    }
}

fn verification_event(session_id: &str, turn_id: &str, turn: &Turn, scope: &Scope) -> Option<ChatEvent> {
    let (verdict, checks) = turn.finish(scope)?;
    Some(ChatEvent::TurnVerification {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        verdict,
        checks,
        settled_later: false,
    })
}

fn settled_event(session_id: &str, turn_id: &str, verdict: Verdict, checks: &[Check]) -> ChatEvent {
    ChatEvent::TurnVerification {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        verdict,
        checks: checks.to_vec(),
        settled_later: true,
    }
}

struct Open<K> {
    key: K,
    verdict: Verdict,
}

/// Turns not verified yet, oldest first. A later check covers the whole tree,
/// so it settles them whatever its own turn edited.
pub struct Settler<K> {
    open: Vec<Open<K>>,
}

impl<K> Default for Settler<K> {
    fn default() -> Self {
        Self { open: Vec::new() }
    }
}

impl<K: Clone + PartialEq> Settler<K> {
    fn is_empty(&self) -> bool {
        self.open.is_empty()
    }

    fn turn(&mut self, key: K, own: Option<Verdict>, trusted: Option<&[Check]>) -> Vec<(K, Verdict)> {
        let mut changed = Vec::new();
        if let Some(checks) = trusted {
            let verdict = if checks.iter().any(|c| c.result == CheckResult::Failed) {
                Verdict::Failed
            } else {
                Verdict::Verified
            };
            for open in &mut self.open {
                if open.verdict != verdict {
                    open.verdict = verdict;
                    changed.push((open.key.clone(), verdict));
                }
            }
            self.open.retain(|o| o.verdict != Verdict::Verified);
        }
        if let Some(verdict) = own.filter(|v| *v != Verdict::Verified) {
            if !self.open.iter().any(|o| o.key == key) {
                self.open.push(Open { key, verdict });
            }
        }
        changed
    }
}

/// What a finished turn sends ahead of its `TurnCompleted`.
#[derive(Debug, Default)]
pub struct Marks {
    pub settled: Vec<ChatEvent>,
    pub own: Option<ChatEvent>,
}

impl Marks {
    /// The session's verdict after this turn: its newest code turn's.
    pub fn session_verdict(&self) -> Option<Verdict> {
        verdict_of(self.own.as_ref()).or_else(|| verdict_of(self.settled.last()))
    }

    pub fn into_events(self) -> Vec<ChatEvent> {
        self.settled.into_iter().chain(self.own).collect()
    }
}

/// One live session's turns, fed every event in order.
pub struct Tracker {
    cwd: Option<PathBuf>,
    entries: Vec<Vec<String>>,
    scope: Scope,
    turns: HashMap<String, Turn>,
    // The first answer per turn. An ACP load replays the conversation through
    // the same sink, and a replay has no timing to measure, so the second pass
    // reuses what the live one measured.
    verdicts: HashMap<String, Option<ChatEvent>>,
    settler: Settler<(String, String)>,
}

impl Tracker {
    pub fn new(cwd: Option<&Path>) -> Self {
        Self {
            cwd: cwd.map(Path::to_path_buf),
            entries: entries_for(cwd),
            scope: Scope::new(cwd),
            turns: HashMap::new(),
            verdicts: HashMap::new(),
            settler: Settler::default(),
        }
    }

    pub fn seed(&mut self, open: Vec<OpenTurn>) {
        if !self.verdicts.is_empty() || !self.turns.is_empty() || !self.settler.is_empty() {
            return;
        }
        self.settler.open = open
            .into_iter()
            .map(|o| Open {
                key: (o.session_id, o.turn_id),
                verdict: o.verdict,
            })
            .collect();
    }

    pub fn observe(&mut self, event: &ChatEvent, now: Option<Instant>) -> Marks {
        match event {
            ChatEvent::ToolCallStarted { turn_id, .. }
            | ChatEvent::FileEdit { turn_id, .. }
            | ChatEvent::ToolCallCompleted { turn_id, .. } => {
                // Read once per turn, so a list saved mid-session applies from
                // the next turn without the current one changing its rules.
                if !self.turns.contains_key(turn_id) {
                    self.entries = entries_for(self.cwd.as_deref());
                }
                self.turns
                    .entry(turn_id.clone())
                    .or_default()
                    .observe(event, now, &self.entries);
                Marks::default()
            }
            ChatEvent::TurnCompleted {
                session_id, turn_id, ..
            } => {
                if let Some(first) = self.verdicts.get(turn_id) {
                    return Marks {
                        settled: Vec::new(),
                        own: first.clone(),
                    };
                }
                let turn = self.turns.remove(turn_id).unwrap_or_default();
                self.scope.learn(turn.edited_paths());
                let own = verification_event(session_id, turn_id, &turn, &self.scope);
                let trusted = turn.last_trusted();
                let mut settled = Vec::new();
                for ((sid, tid), verdict) in
                    self.settler
                        .turn((session_id.clone(), turn_id.clone()), verdict_of(own.as_ref()), trusted)
                {
                    let event = settled_event(&sid, &tid, verdict, trusted.unwrap_or_default());
                    self.verdicts.insert(tid, Some(event.clone()));
                    settled.push(event);
                }
                self.verdicts.insert(turn_id.clone(), own.clone());
                Marks { settled, own }
            }
            _ => Marks::default(),
        }
    }
}

fn verdict_of(event: Option<&ChatEvent>) -> Option<Verdict> {
    match event {
        Some(ChatEvent::TurnVerification { verdict, .. }) => Some(*verdict),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenTurn {
    pub session_id: String,
    pub turn_id: String,
    pub verdict: Verdict,
}

struct Group {
    verdict_before: usize,
    session_id: String,
    turn_id: String,
    turn_ids: Vec<String>,
    tool_events: Vec<usize>,
}

// A transcript has no `TurnCompleted`, so it groups by prompt instead.
fn groups(events: &[ChatEvent]) -> Vec<Group> {
    let mut out = Vec::new();
    if events.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. })) {
        let mut members: HashMap<&str, Vec<usize>> = HashMap::new();
        for (at, event) in events.iter().enumerate() {
            match event {
                ChatEvent::ToolCallStarted { turn_id, .. }
                | ChatEvent::FileEdit { turn_id, .. }
                | ChatEvent::ToolCallCompleted { turn_id, .. } => {
                    members.entry(turn_id.as_str()).or_default().push(at);
                }
                ChatEvent::TurnCompleted {
                    session_id, turn_id, ..
                } => out.push(Group {
                    verdict_before: at,
                    session_id: session_id.clone(),
                    turn_id: turn_id.clone(),
                    turn_ids: vec![turn_id.clone()],
                    tool_events: members.remove(turn_id.as_str()).unwrap_or_default(),
                }),
                _ => {}
            }
        }
        return out;
    }
    let mut prompt: Option<&str> = None;
    let mut current: Option<Group> = None;
    let mut members: Vec<usize> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    let close = |at: usize,
                 current: &mut Option<Group>,
                 members: &mut Vec<usize>,
                 ids: &mut Vec<String>,
                 out: &mut Vec<Group>| {
        if let Some(mut group) = current.take() {
            group.verdict_before = at;
            group.tool_events = std::mem::take(members);
            group.turn_ids = std::mem::take(ids);
            out.push(group);
        }
        members.clear();
        ids.clear();
    };
    for (at, event) in events.iter().enumerate() {
        match event {
            ChatEvent::UserMessage { turn_id, .. } if prompt != Some(turn_id.as_str()) => {
                close(at, &mut current, &mut members, &mut ids, &mut out);
                prompt = Some(turn_id.as_str());
            }
            ChatEvent::TextDelta {
                session_id, turn_id, ..
            }
            | ChatEvent::ThinkingDelta {
                session_id, turn_id, ..
            }
            | ChatEvent::ToolCallStarted {
                session_id, turn_id, ..
            } => {
                current.get_or_insert_with(|| Group {
                    verdict_before: 0,
                    session_id: session_id.clone(),
                    turn_id: turn_id.clone(),
                    turn_ids: Vec::new(),
                    tool_events: Vec::new(),
                });
                if !ids.contains(turn_id) {
                    ids.push(turn_id.clone());
                }
                if matches!(event, ChatEvent::ToolCallStarted { .. }) {
                    members.push(at);
                }
            }
            ChatEvent::FileEdit { .. } | ChatEvent::ToolCallCompleted { .. } => members.push(at),
            _ => {}
        }
    }
    close(events.len(), &mut current, &mut members, &mut ids, &mut out);
    out
}

fn fold(events: &[ChatEvent], groups: &[Group], cwd: Option<&Path>, measured: &Measured) -> Vec<Option<ChatEvent>> {
    let entries = entries_for(cwd);
    let mut scope = Scope::new(cwd);
    scope.learn(edited_paths(events));
    let mut settler: Settler<usize> = Settler::default();
    let mut out: Vec<Option<ChatEvent>> = Vec::with_capacity(groups.len());
    for (at, group) in groups.iter().enumerate() {
        let mut turn = Turn::default();
        for &i in &group.tool_events {
            turn.observe(&events[i], None, &entries);
        }
        let mut own = verification_event(&group.session_id, &group.turn_id, &turn, &scope);
        if let Some(ChatEvent::TurnVerification { checks, .. }) = &mut own {
            fill(checks, measured);
        }
        let mut trusted = turn.last_trusted().map(<[Check]>::to_vec);
        if let Some(checks) = &mut trusted {
            fill(checks, measured);
        }
        for (earlier, verdict) in settler.turn(at, verdict_of(own.as_ref()), trusted.as_deref()) {
            let g = &groups[earlier];
            out[earlier] = Some(settled_event(
                &g.session_id,
                &g.turn_id,
                verdict,
                trusted.as_deref().unwrap_or_default(),
            ));
        }
        out.push(own);
    }
    out
}

fn place(events: Vec<ChatEvent>, groups: &[Group], verdicts: Vec<Option<ChatEvent>>) -> Vec<ChatEvent> {
    let mut marks: Vec<(usize, ChatEvent)> = groups
        .iter()
        .zip(verdicts)
        .filter_map(|(g, v)| Some((g.verdict_before, v?)))
        .collect();
    marks.sort_by_key(|(at, _)| *at);
    let mut marks = marks.into_iter().peekable();
    let mut out: Vec<ChatEvent> = Vec::with_capacity(events.len() + groups.len());
    for (at, event) in events.into_iter().enumerate() {
        while let Some((_, mark)) = marks.next_if(|(m, _)| *m == at) {
            out.push(mark);
        }
        out.push(event);
    }
    out.extend(marks.map(|(_, mark)| mark));
    out
}

/// Mark a replayed conversation's turns the way `Tracker` marks a live one's,
/// against the check list as it is now. A logged `TurnVerification` is dropped
/// and recomputed, keeping only the durations it measured. Answers the turns
/// left unverified, oldest first.
pub fn mark_history(events: &mut Vec<ChatEvent>, cwd: Option<&Path>, enabled: bool) -> Vec<OpenTurn> {
    let measured = measured(events);
    events.retain(|e| !matches!(e, ChatEvent::TurnVerification { .. }));
    if !enabled {
        return Vec::new();
    }
    let groups = groups(events);
    let verdicts = fold(events, &groups, cwd, &measured);
    let open = groups
        .iter()
        .zip(&verdicts)
        .filter_map(|(g, v)| match v {
            Some(ChatEvent::TurnVerification { verdict, .. }) if *verdict != Verdict::Verified => Some(OpenTurn {
                session_id: g.session_id.clone(),
                turn_id: g.turn_id.clone(),
                verdict: *verdict,
            }),
            _ => None,
        })
        .collect();
    *events = place(std::mem::take(events), &groups, verdicts);
    open
}

/// Mark one page of a history read whole as `whole`, so a turn on it takes the
/// verdict a later page's check settled it to.
pub fn mark_page(page: &mut Vec<ChatEvent>, whole: &[ChatEvent], cwd: Option<&Path>, enabled: bool) {
    if whole.is_empty() {
        mark_history(page, cwd, enabled);
        return;
    }
    page.retain(|e| !matches!(e, ChatEvent::TurnVerification { .. }));
    if !enabled {
        return;
    }
    let whole_groups = groups(whole);
    let verdicts = fold(whole, &whole_groups, cwd, &measured(whole));
    let mut by_id: HashMap<&str, &ChatEvent> = HashMap::new();
    for (group, verdict) in whole_groups.iter().zip(&verdicts) {
        if let Some(verdict) = verdict {
            for id in &group.turn_ids {
                by_id.insert(id.as_str(), verdict);
            }
        }
    }
    let page_groups = groups(page);
    let shown = page_groups
        .iter()
        .map(|g| {
            let mut event = (*by_id.get(g.turn_id.as_str())?).clone();
            if let ChatEvent::TurnVerification { turn_id, .. } = &mut event {
                turn_id.clone_from(&g.turn_id);
            }
            Some(event)
        })
        .collect();
    *page = place(std::mem::take(page), &page_groups, shown);
}

// What a logged `TurnVerification` measured live, keyed by call and command,
// since a replay has no timing of its own.
type Measured = HashMap<(String, String), u64>;

fn measured(events: &[ChatEvent]) -> Measured {
    let mut out = Measured::new();
    for event in events {
        if let ChatEvent::TurnVerification { checks, .. } = event {
            for c in checks {
                if let Some(ms) = c.duration_ms {
                    out.insert((c.tool_use_id.clone(), c.command.clone()), ms);
                }
            }
        }
    }
    out
}

fn fill(checks: &mut [Check], measured: &Measured) {
    for c in checks {
        if c.duration_ms.is_none() {
            c.duration_ms = measured.get(&(c.tool_use_id.clone(), c.command.clone())).copied();
        }
    }
}

/// One turn that changed code, for the surfaces that show a session without
/// its tool calls: the tab, the History row, Checkpoints, and later the review
/// inbox's risk score.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedTurn {
    /// `None` for a history with no prompts to anchor on, which is an ACP log.
    pub prompt_ts: Option<u64>,
    pub verdict: Verdict,
    pub checks: Vec<Check>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub settled_later: bool,
}

/// Fold a conversation into one entry per turn that changed code, oldest
/// first. `prompts` pairs each prompt's timestamp with the index of its first
/// event; with none, calls are grouped by the turn id they carry instead.
pub fn session_turns(
    events: &[ChatEvent],
    prompts: &[(u64, usize)],
    entries: &[Vec<String>],
    cwd: Option<&Path>,
) -> Vec<VerifiedTurn> {
    let measured = measured(events);
    let mut scope = Scope::new(cwd);
    scope.learn(edited_paths(events));
    let mut turns: Vec<(String, Option<u64>, Turn)> = Vec::new();
    for (at, event) in events.iter().enumerate() {
        let (ChatEvent::ToolCallStarted { turn_id, .. }
        | ChatEvent::FileEdit { turn_id, .. }
        | ChatEvent::ToolCallCompleted { turn_id, .. }) = event
        else {
            continue;
        };
        let prompt_ts = prompts.iter().rev().find(|(_, first)| *first <= at).map(|(ts, _)| *ts);
        let key = match prompt_ts {
            Some(ts) => ts.to_string(),
            None if prompts.is_empty() => turn_id.clone(),
            None => String::new(),
        };
        let at = match turns.iter().position(|(k, _, _)| *k == key) {
            Some(at) => at,
            None => {
                turns.push((key, prompt_ts, Turn::default()));
                turns.len() - 1
            }
        };
        turns[at].2.observe(event, None, entries);
    }
    let mut settler: Settler<usize> = Settler::default();
    let mut out: Vec<Option<VerifiedTurn>> = Vec::with_capacity(turns.len());
    for (at, (_, prompt_ts, turn)) in turns.into_iter().enumerate() {
        let own = turn.finish(&scope).map(|(verdict, mut checks)| {
            fill(&mut checks, &measured);
            VerifiedTurn {
                prompt_ts,
                verdict,
                checks,
                settled_later: false,
            }
        });
        let mut trusted = turn.last_trusted().map(<[Check]>::to_vec);
        if let Some(checks) = &mut trusted {
            fill(checks, &measured);
        }
        for (earlier, verdict) in settler.turn(at, own.as_ref().map(|t| t.verdict), trusted.as_deref()) {
            if let Some(settled) = &mut out[earlier] {
                settled.verdict = verdict;
                settled.checks = trusted.clone().unwrap_or_default();
                settled.settled_later = true;
            }
        }
        out.push(own);
    }
    out.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults() -> Vec<Vec<String>> {
        entries_for(None)
    }

    fn is_check(command: &str) -> bool {
        let entries = defaults();
        commands(command)
            .iter()
            .any(|(c, _)| matches!(role(c, &entries), Role::Check(_)))
    }

    #[test]
    fn a_check_is_found_through_wrappers_assignments_and_cd() {
        for line in [
            "FOO=1 pnpm test --run",
            "cd crates && cargo test",
            "bash -c \"npx tsc --noEmit\"",
            "uv run pytest -q",
            "python -m pytest",
            "timeout 600 cargo test --workspace",
            "pnpm exec vitest run",
            "pnpm --filter web test",
            "pnpm run test",
            "npm run test",
            "cargo +nightly clippy",
            "cargo nextest run",
            "env CI=1 go test ./...",
            "pnpm vitest run",
            "yarn tsc --noEmit",
            "make -C app test",
            "npm --prefix app test",
        ] {
            assert!(is_check(line), "{line}");
        }
        for line in ["echo cargo test", "ls -la", "git status", "cat Cargo.toml", "rg cargo"] {
            assert!(!is_check(line), "{line}");
        }
    }

    #[test]
    fn the_users_list_beats_the_repos_checks_and_those_beat_the_defaults() {
        let wt = std::env::temp_dir().join(format!("tori-checks-tiers-{}", std::process::id()));
        std::fs::create_dir_all(wt.join(".git")).unwrap();
        std::fs::create_dir_all(wt.join("src")).unwrap();
        let wt = std::fs::canonicalize(wt).unwrap();
        let words = |line: &str| vec![line.split(' ').map(str::to_string).collect::<Vec<_>>()];
        let none = HashMap::new();
        assert_eq!(
            entries_in(&none, &wt.join("src")),
            parse_entries(DEFAULTS.iter().copied())
        );

        crate::project_config::seam_accepted(
            &wt,
            crate::project_config::Values {
                checks: Some(vec!["just ci".into()]),
                ..Default::default()
            },
        );
        assert_eq!(entries_in(&none, &wt.join("src")), words("just ci"));

        let mine = HashMap::from([(wt.to_string_lossy().into_owned(), vec!["make verify".to_string()])]);
        assert_eq!(entries_in(&mine, &wt.join("src")), words("make verify"));
        std::fs::remove_dir_all(&wt).ok();
    }

    #[test]
    fn a_projects_list_reaches_its_worktrees_and_nothing_beside_it() {
        let commands = HashMap::from([
            ("/work/app".to_string(), vec!["just ci".to_string()]),
            ("/work/app/vendor/lib".to_string(), vec!["make verify".to_string()]),
            ("/work/empty".to_string(), Vec::new()),
        ]);
        let list = |cwd: &str| entries_in(&commands, Path::new(cwd));
        let app = vec![vec!["just".to_string(), "ci".to_string()]];
        assert_eq!(list("/work/app"), app);
        assert_eq!(
            list("/work/app/feature-x"),
            app,
            "a sibling worktree under the container"
        );
        assert_eq!(
            list("/work/app/.tori/worktrees/x"),
            app,
            "a worktree Tori made inside the repo"
        );
        assert_eq!(
            list("/work/app/vendor/lib/src"),
            vec![vec!["make".to_string(), "verify".to_string()]]
        );
        assert_eq!(
            list("/work/app-other"),
            defaults(),
            "a path that only shares a prefix string"
        );
        assert_eq!(list("/elsewhere"), defaults());
        assert_eq!(list("/work/empty"), defaults(), "an empty list is no entry");
    }

    #[test]
    fn every_default_matches_its_plain_form() {
        for entry in DEFAULTS {
            assert!(is_check(entry), "{entry}");
        }
    }

    #[test]
    fn a_script_name_matches_its_suffixed_forms_only() {
        assert!(is_check("pnpm test:unit"));
        assert!(is_check("npm run lint:fix"));
        assert!(!is_check("pnpm build-docs"));
        assert!(!is_check("pnpm testing"));
    }

    #[test]
    fn redirects_stay_words_and_do_not_background() {
        let cmds = split("cargo test 2>&1 &> out.txt");
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].1, None);
        let cmds = split("cargo test &");
        assert_eq!(cmds[0].1, Some(Op::Background));
        let cmds = split("echo 'a && b' | tail");
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].0.words, vec!["echo", "a && b"]);
    }

    fn call(command: &str) -> Call {
        Call {
            name: "Bash".into(),
            command: Some(command.into()),
            background: false,
            edits: false,
            paths: Vec::new(),
            started: None,
        }
    }

    fn results(command: &str, status: ToolStatus, output: &str) -> Vec<(String, CheckResult, Option<i32>)> {
        checks_of("t1", &call(command), status, output, None, None, &defaults())
            .into_iter()
            .map(|c| (c.command, c.result, c.exit_code))
            .collect()
    }

    fn r(command: &str, result: CheckResult, exit: Option<i32>) -> (String, CheckResult, Option<i32>) {
        (command.into(), result, exit)
    }

    #[test]
    fn an_ok_and_chain_passes_every_check_in_it() {
        assert_eq!(
            results("cargo clippy && cargo test", ToolStatus::Ok, "ok"),
            vec![
                r("cargo clippy", CheckResult::Passed, Some(0)),
                r("cargo test", CheckResult::Passed, Some(0))
            ]
        );
        assert_eq!(
            results("cd app && cargo test", ToolStatus::Ok, ""),
            vec![r("cargo test", CheckResult::Passed, Some(0))]
        );
    }

    #[test]
    fn a_failing_chain_of_checks_is_one_entry_blaming_none() {
        assert_eq!(
            results("cargo build && cargo test", ToolStatus::Error, "Exit code 101\nerror"),
            vec![r("cargo build && cargo test", CheckResult::Failed, Some(101))]
        );
        assert_eq!(
            results("cargo test", ToolStatus::Error, "Exit code 1"),
            vec![r("cargo test", CheckResult::Failed, Some(1))]
        );
        // `pnpm install` may be what failed, so neither check is blamed.
        assert_eq!(
            results("pnpm install && pnpm test", ToolStatus::Error, "Exit code 1"),
            vec![r("pnpm test", CheckResult::NotSeen, None)]
        );
    }

    #[test]
    fn a_masked_exit_is_not_seen() {
        for (line, check) in [
            ("cargo test 2>&1 | tail -20", "cargo test 2>&1"),
            ("pnpm test; echo ok", "pnpm test"),
            ("pnpm test || true", "pnpm test"),
            ("true || cargo test", "cargo test"),
            ("cargo test &", "cargo test"),
        ] {
            for status in [ToolStatus::Ok, ToolStatus::Error] {
                assert_eq!(
                    results(line, status, ""),
                    vec![r(check, CheckResult::NotSeen, None)],
                    "{line}"
                );
            }
        }
    }

    #[test]
    fn a_check_after_a_semicolon_is_the_calls_own_exit() {
        assert_eq!(
            results("cd app; cargo test", ToolStatus::Ok, ""),
            vec![r("cargo test", CheckResult::Passed, Some(0))]
        );
        assert_eq!(
            results("cargo build; cargo test", ToolStatus::Error, "Exit code 2"),
            vec![
                r("cargo build", CheckResult::NotSeen, None),
                r("cargo test", CheckResult::Failed, Some(2))
            ]
        );
    }

    #[test]
    fn a_background_interrupted_or_timed_out_run_is_not_seen() {
        let mut bg = call("cargo test");
        bg.background = true;
        let got = checks_of(
            "t1",
            &bg,
            ToolStatus::Ok,
            "Command running in background with ID: x",
            None,
            None,
            &defaults(),
        );
        assert_eq!(got[0].result, CheckResult::NotSeen);

        assert_eq!(
            results(
                "cargo test",
                ToolStatus::Error,
                "Exit code 143\nCommand timed out after 2s"
            ),
            vec![r("cargo test", CheckResult::NotSeen, None)]
        );
        assert_eq!(
            results(
                "cargo test",
                ToolStatus::Error,
                "[Request interrupted by user for tool use]"
            ),
            vec![r("cargo test", CheckResult::NotSeen, None)]
        );
        assert!(results(
            "cargo test",
            ToolStatus::Error,
            "The user doesn't want to proceed with this tool use. The tool use was rejected"
        )
        .is_empty());
        assert!(results("cargo test", ToolStatus::Denied, "").is_empty());
    }

    #[test]
    fn an_acp_exit_comes_off_the_summary() {
        let mut c = call("cargo test");
        c.name = "Run tests".into();
        let summary = ToolSummary::Execute {
            exit_code: Some(3),
            lines: 1,
        };
        let got = checks_of("t1", &c, ToolStatus::Error, "boom", Some(&summary), None, &defaults());
        assert_eq!(got[0].exit_code, Some(3));
        let got = checks_of("t1", &c, ToolStatus::Ok, "fine", None, None, &defaults());
        assert_eq!(got[0].exit_code, None, "an ACP agent's silence is not exit 0");
    }

    struct Run {
        turn: Turn,
        next: usize,
    }

    impl Run {
        fn new() -> Self {
            Self {
                turn: Turn::default(),
                next: 0,
            }
        }

        fn feed(&mut self, kind: ToolKind, name: &str, input: Value, status: ToolStatus, output: &str) {
            self.next += 1;
            let id = format!("c{}", self.next);
            let entries = defaults();
            self.turn
                .observe(&started(&id, "turn", kind, name, input), None, &entries);
            self.turn
                .observe(&completed(&id, "turn", status, output), None, &entries);
        }

        fn edit(&mut self) {
            self.feed(
                ToolKind::Edit,
                "Edit",
                json!({ "file_path": "/w/a.rs" }),
                ToolStatus::Ok,
                "",
            );
        }

        fn shell(&mut self, command: &str, status: ToolStatus, output: &str) {
            self.feed(ToolKind::Execute, "Bash", json!({ "command": command }), status, output);
        }

        fn verdict(&self) -> Option<Verdict> {
            self.turn.finish(&Scope::new(None)).map(|(v, _)| v)
        }
    }

    fn started(id: &str, turn: &str, kind: ToolKind, name: &str, input: Value) -> ChatEvent {
        ChatEvent::ToolCallStarted {
            session_id: "s1".into(),
            turn_id: turn.into(),
            tool_use_id: id.into(),
            name: name.into(),
            input,
            kind,
            locations: Vec::new(),
            title: None,
            secret: None,
        }
    }

    fn completed(id: &str, turn: &str, status: ToolStatus, output: &str) -> ChatEvent {
        ChatEvent::ToolCallCompleted {
            session_id: "s1".into(),
            turn_id: turn.into(),
            tool_use_id: id.into(),
            status,
            output: Some(output.into()),
            files: Vec::new(),
            duration_ms: None,
            summary: None,
            output_truncated: false,
            patch: Vec::new(),
            blind_edits: Vec::new(),
        }
    }

    #[test]
    fn a_later_edit_voids_an_earlier_pass() {
        let mut run = Run::new();
        run.edit();
        run.shell("cargo test", ToolStatus::Ok, "");
        run.edit();
        assert_eq!(run.verdict(), Some(Verdict::Unverified));
    }

    #[test]
    fn a_fix_after_a_failure_verifies_the_turn() {
        let mut run = Run::new();
        run.edit();
        run.shell("cargo test", ToolStatus::Error, "Exit code 101");
        run.edit();
        run.shell("cargo test", ToolStatus::Ok, "");
        assert_eq!(run.verdict(), Some(Verdict::Verified));
        let (_, checks) = run.turn.finish(&Scope::new(None)).unwrap();
        assert_eq!(checks.len(), 2, "every check is listed, not only the deciding one");
    }

    #[test]
    fn the_last_check_after_the_last_edit_decides() {
        let mut run = Run::new();
        run.edit();
        run.shell("cargo test", ToolStatus::Error, "Exit code 101");
        assert_eq!(run.verdict(), Some(Verdict::Failed));

        let mut run = Run::new();
        run.edit();
        run.shell("cargo test 2>&1 | tail", ToolStatus::Ok, "");
        assert_eq!(run.verdict(), Some(Verdict::Unverified));

        let mut run = Run::new();
        run.edit();
        run.shell("cargo test | tail; cargo clippy", ToolStatus::Ok, "");
        assert_eq!(
            run.verdict(),
            Some(Verdict::Unverified),
            "a call's unseen check is not hidden by a passing one beside it"
        );
    }

    #[test]
    fn a_turn_that_changed_no_code_has_no_verdict() {
        let mut run = Run::new();
        run.shell("cargo test", ToolStatus::Ok, "");
        assert_eq!(run.verdict(), None);

        let mut run = Run::new();
        run.shell("sed -i '' s/a/b/ src/a.rs", ToolStatus::Ok, "");
        assert_eq!(run.verdict(), None, "a shell write is invisible here");

        let mut run = Run::new();
        run.feed(ToolKind::Edit, "Edit", json!({}), ToolStatus::Error, "");
        assert_eq!(run.verdict(), None, "a failed edit changed nothing");
    }

    #[test]
    fn an_edit_with_nothing_after_it_is_unverified() {
        let mut run = Run::new();
        run.shell("cargo test", ToolStatus::Ok, "");
        run.edit();
        assert_eq!(run.verdict(), Some(Verdict::Unverified));
    }

    fn turn_completed(turn: &str) -> ChatEvent {
        ChatEvent::TurnCompleted {
            session_id: "s1".into(),
            turn_id: turn.into(),
            outcome: crate::chat::model::TurnOutcome::Completed,
            stop_reason: None,
            usage: crate::chat::model::Usage::default(),
            cost_usd: None,
            permission_denials: Vec::new(),
            extra: crate::chat::model::Extra::new(),
        }
    }

    fn user(turn: &str) -> ChatEvent {
        ChatEvent::UserMessage {
            session_id: "s1".into(),
            turn_id: turn.into(),
            blocks: Vec::new(),
        }
    }

    fn turn_events(turn: &str, test_status: ToolStatus) -> Vec<ChatEvent> {
        vec![
            started(&format!("{turn}-e"), turn, ToolKind::Edit, "Edit", json!({})),
            completed(&format!("{turn}-e"), turn, ToolStatus::Ok, ""),
            started(
                &format!("{turn}-t"),
                turn,
                ToolKind::Execute,
                "Bash",
                json!({ "command": "cargo test" }),
            ),
            completed(
                &format!("{turn}-t"),
                turn,
                test_status,
                if test_status == ToolStatus::Ok {
                    ""
                } else {
                    "Exit code 101"
                },
            ),
        ]
    }

    fn verdicts(events: &[ChatEvent]) -> Vec<(String, Verdict)> {
        events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TurnVerification { turn_id, verdict, .. } => Some((turn_id.clone(), *verdict)),
                _ => None,
            })
            .collect()
    }

    fn repo_ignoring_scribe() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tori-verify-scope-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(dir.join("packages/app")).unwrap();
        std::fs::create_dir_all(dir.join("shared")).unwrap();
        std::fs::write(dir.join(".gitignore"), ".scribe\n").unwrap();
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        dir
    }

    fn write(id: &str, turn: &str, path: &Path) -> [ChatEvent; 2] {
        [
            started(id, turn, ToolKind::Edit, "Write", json!({ "file_path": path })),
            completed(id, turn, ToolStatus::Ok, ""),
        ]
    }

    fn check(id: &str, turn: &str) -> [ChatEvent; 2] {
        [
            started(id, turn, ToolKind::Execute, "Bash", json!({ "command": "cargo test" })),
            completed(id, turn, ToolStatus::Ok, ""),
        ]
    }

    fn verdict_in(cwd: &Path, events: &[ChatEvent]) -> Option<Verdict> {
        let turns = session_turns(events, &[], &defaults(), Some(cwd));
        turns.first().map(|t| t.verdict)
    }

    #[test]
    fn an_edit_nothing_could_check_gives_no_verdict() {
        let repo = repo_ignoring_scribe();
        let elsewhere = std::env::temp_dir().join("tori-verify-elsewhere/x.rs");
        let only = |paths: &[PathBuf]| {
            let events: Vec<ChatEvent> = paths
                .iter()
                .enumerate()
                .flat_map(|(i, p)| write(&format!("w{i}"), "t1", p))
                .collect();
            verdict_in(&repo, &events)
        };
        assert_eq!(only(&[repo.join(".scribe/plan.md")]), None, "gitignored");
        assert_eq!(
            only(&[repo.join("README.md"), repo.join("logo.png")]),
            None,
            "docs and assets"
        );
        assert_eq!(only(&[repo.join("LICENSE")]), None, "a license");
        assert_eq!(only(&[repo.join("LICENSE-MIT")]), None, "a suffixed license");
        assert_eq!(
            only(&[repo.join("src/license.rs")]),
            Some(Verdict::Unverified),
            "code named like a doc"
        );
        assert_eq!(only(std::slice::from_ref(&elsewhere)), None, "outside the repo");
        assert_eq!(
            only(&[elsewhere, repo.join(".scribe/plan.md")]),
            None,
            "an outside path first does not stop git reading the rest"
        );
        assert_eq!(only(&[repo.join("src/a.rs")]), Some(Verdict::Unverified));
    }

    #[test]
    fn a_session_below_the_root_counts_an_edit_beside_it() {
        let repo = repo_ignoring_scribe();
        let cwd = repo.join("packages/app");
        let events: Vec<ChatEvent> = write("w1", "t1", Path::new("../../shared/x.ts")).into();
        assert_eq!(verdict_in(&cwd, &events), Some(Verdict::Unverified));
    }

    #[test]
    fn an_unchecked_edit_after_a_pass_keeps_it_verified() {
        let repo = repo_ignoring_scribe();
        let mut events = Vec::new();
        events.extend(write("w1", "t1", &repo.join("src/a.rs")));
        events.extend(check("c1", "t1"));
        events.extend(write("w2", "t1", &repo.join(".scribe/plan.md")));
        assert_eq!(verdict_in(&repo, &events), Some(Verdict::Verified));
    }

    #[test]
    fn an_edit_with_no_path_still_counts() {
        let repo = repo_ignoring_scribe();
        let events = vec![
            started("e1", "t1", ToolKind::Edit, "Edit", json!({})),
            completed("e1", "t1", ToolStatus::Ok, ""),
        ];
        assert_eq!(verdict_in(&repo, &events), Some(Verdict::Unverified));
    }

    #[test]
    fn a_long_replay_asks_git_a_fixed_number_of_times() {
        let repo = repo_ignoring_scribe();
        let mut events = Vec::new();
        for n in 0..30 {
            let turn = format!("t{n}");
            events.push(user(&turn));
            events.extend(write(&format!("a{n}"), &turn, &repo.join(format!("src/{n}.rs"))));
            events.extend(write(&format!("b{n}"), &turn, &repo.join(".scribe/plan.md")));
            events.push(turn_completed(&turn));
        }
        // Under both spellings: the batch runs in git's canonical root.
        let real = repo.canonicalize().unwrap();
        let spawns = || {
            crate::exec::git_spawns_under(&repo)
                + if real == repo {
                    0
                } else {
                    crate::exec::git_spawns_under(&real)
                }
        };
        let before = spawns();
        mark_history(&mut events, Some(&repo), true);
        assert_eq!(spawns() - before, 2, "one root, one ignore batch");
        assert_eq!(verdicts(&events).len(), 30);
    }

    #[test]
    fn live_and_a_replay_agree_on_which_edits_count() {
        let repo = repo_ignoring_scribe();
        let mut log = Vec::new();
        log.push(user("docs"));
        log.extend(write("d1", "docs", &repo.join("README.md")));
        log.extend(write("d2", "docs", &repo.join(".scribe/plan.md")));
        log.push(turn_completed("docs"));
        log.push(user("mixed"));
        log.extend(write("m1", "mixed", &repo.join("src/a.rs")));
        log.extend(check("m2", "mixed"));
        log.extend(write("m3", "mixed", &repo.join("docs/guide.md")));
        log.push(turn_completed("mixed"));

        let mut tracker = Tracker::new(Some(&repo));
        let mut live = Vec::new();
        for event in &log {
            live.extend(tracker.observe(event, None).into_events());
            live.push(event.clone());
        }
        let expected = vec![("mixed".to_string(), Verdict::Verified)];
        assert_eq!(verdicts(&live), expected);
        let mut replayed = live.clone();
        mark_history(&mut replayed, Some(&repo), true);
        assert_eq!(verdicts(&replayed), expected);
    }

    fn logged_turn(turn: &str, edit: bool, checks: &[(&str, ToolStatus, &str)]) -> Vec<ChatEvent> {
        let mut out = vec![user(turn)];
        if edit {
            out.push(started(
                &format!("{turn}-e"),
                turn,
                ToolKind::Edit,
                "Edit",
                json!({ "file_path": "/w/a.rs" }),
            ));
            out.push(completed(&format!("{turn}-e"), turn, ToolStatus::Ok, ""));
        }
        for (n, (command, status, output)) in checks.iter().enumerate() {
            let id = format!("{turn}-c{n}");
            out.push(started(
                &id,
                turn,
                ToolKind::Execute,
                "Bash",
                json!({ "command": command }),
            ));
            out.push(completed(&id, turn, *status, output));
        }
        out.push(turn_completed(turn));
        out
    }

    fn settled(events: &[ChatEvent]) -> Vec<(String, Verdict, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TurnVerification {
                    turn_id,
                    verdict,
                    settled_later,
                    ..
                } => Some((turn_id.clone(), *verdict, *settled_later)),
                _ => None,
            })
            .collect()
    }

    fn replay(turns: &[Vec<ChatEvent>]) -> Vec<(String, Verdict, bool)> {
        let mut events: Vec<ChatEvent> = turns.concat();
        mark_history(&mut events, None, true);
        settled(&events)
    }

    const PASS: (&str, ToolStatus, &str) = ("cargo test", ToolStatus::Ok, "");
    const FAIL: (&str, ToolStatus, &str) = ("cargo test", ToolStatus::Error, "Exit code 101");
    const MASKED: (&str, ToolStatus, &str) = ("cargo test | tail", ToolStatus::Ok, "");

    fn v(turn: &str, verdict: Verdict, later: bool) -> (String, Verdict, bool) {
        (turn.to_string(), verdict, later)
    }

    #[test]
    fn a_later_check_settles_the_turns_before_it() {
        use Verdict::{Failed, Unverified, Verified};
        let edit = logged_turn("t1", true, &[]);
        assert_eq!(
            replay(&[edit.clone(), logged_turn("t2", false, &[PASS])]),
            vec![v("t1", Verified, true)]
        );
        assert_eq!(
            replay(&[edit.clone(), logged_turn("t2", false, &[FAIL])]),
            vec![v("t1", Failed, true)]
        );
        assert_eq!(
            replay(&[edit.clone(), logged_turn("t2", true, &[PASS])]),
            vec![v("t1", Verified, true), v("t2", Verified, false)],
            "a turn that edits and checks settles the one before"
        );
        assert_eq!(
            replay(&[logged_turn("t1", true, &[FAIL]), logged_turn("t2", true, &[PASS])]),
            vec![v("t1", Verified, true), v("t2", Verified, false)],
            "a fix in a later turn clears an earlier failure"
        );
        assert_eq!(
            replay(&[edit.clone(), logged_turn("t2", true, &[MASKED])]),
            vec![v("t1", Unverified, false), v("t2", Unverified, false)],
            "an exit not seen settles nothing"
        );
        assert_eq!(
            replay(&[
                edit.clone(),
                edit.iter().map(|e| retag(e, "t2")).collect(),
                logged_turn("t3", false, &[PASS])
            ]),
            vec![v("t1", Verified, true), v("t2", Verified, true)],
            "every open turn settles"
        );
        assert_eq!(
            replay(&[
                edit.clone(),
                logged_turn("t2", false, &[PASS]),
                logged_turn("t3", true, &[])
            ]),
            vec![v("t1", Verified, true), v("t3", Unverified, false)],
            "an edit after the check opens only its own turn"
        );
    }

    fn retag(event: &ChatEvent, to: &str) -> ChatEvent {
        let mut event = event.clone();
        match &mut event {
            ChatEvent::UserMessage { turn_id, .. }
            | ChatEvent::ToolCallStarted { turn_id, .. }
            | ChatEvent::ToolCallCompleted { turn_id, .. }
            | ChatEvent::TurnCompleted { turn_id, .. } => *turn_id = to.to_string(),
            _ => {}
        }
        if let ChatEvent::ToolCallStarted { tool_use_id, .. } | ChatEvent::ToolCallCompleted { tool_use_id, .. } =
            &mut event
        {
            *tool_use_id = format!("{to}-{tool_use_id}");
        }
        event
    }

    #[test]
    fn live_and_a_replay_agree_on_a_settle() {
        let log: Vec<ChatEvent> = [logged_turn("t1", true, &[]), logged_turn("t2", false, &[PASS])].concat();
        let mut tracker = Tracker::new(None);
        let mut live = Vec::new();
        for event in &log {
            live.extend(tracker.observe(event, None).into_events());
            live.push(event.clone());
        }
        assert_eq!(
            settled(&live),
            vec![v("t1", Verdict::Unverified, false), v("t1", Verdict::Verified, true)],
            "live sends the settle when the checking turn ends"
        );
        let mut replayed = live.clone();
        mark_history(&mut replayed, None, true);
        assert_eq!(settled(&replayed), vec![v("t1", Verdict::Verified, true)]);

        let mut again = Vec::new();
        for event in &log {
            again.extend(tracker.observe(event, None).into_events());
        }
        assert_eq!(
            settled(&again),
            vec![v("t1", Verdict::Verified, true)],
            "a second pass sends each turn's settled answer once"
        );
    }

    #[test]
    fn a_resumed_tracker_settles_turns_read_from_history() {
        let mut history = logged_turn("t1", true, &[]);
        let open = mark_history(&mut history, None, true);
        assert_eq!(open.len(), 1);
        let mut tracker = Tracker::new(None);
        tracker.seed(open);
        let mut live = Vec::new();
        for event in logged_turn("t2", false, &[PASS]) {
            live.extend(tracker.observe(&event, None).into_events());
        }
        assert_eq!(settled(&live), vec![v("t1", Verdict::Verified, true)]);
    }

    fn transcript_turn(n: usize, edit: bool, check: bool) -> Vec<ChatEvent> {
        let turn = format!("p{n}");
        let reply = format!("r{n}");
        let mut out = vec![
            user(&turn),
            ChatEvent::TextDelta {
                session_id: "s1".into(),
                turn_id: reply.clone(),
                text: "ok".into(),
                agent_id: None,
            },
        ];
        if edit {
            out.push(started(
                &format!("{reply}-e"),
                &reply,
                ToolKind::Edit,
                "Edit",
                json!({ "file_path": "/w/a.rs" }),
            ));
            out.push(completed(&format!("{reply}-e"), &reply, ToolStatus::Ok, ""));
        }
        if check {
            out.push(started(
                &format!("{reply}-c"),
                &reply,
                ToolKind::Execute,
                "Bash",
                json!({ "command": "cargo test" }),
            ));
            out.push(completed(&format!("{reply}-c"), &reply, ToolStatus::Ok, ""));
        }
        out
    }

    #[test]
    fn a_page_takes_the_settle_a_later_page_holds() {
        let mut whole = transcript_turn(0, true, false);
        for n in 1..5 {
            whole.extend(transcript_turn(n, false, false));
        }
        whole.extend(transcript_turn(5, false, true));
        let first_page_end = whole
            .iter()
            .position(|e| matches!(e, ChatEvent::UserMessage { turn_id, .. } if turn_id == "p2"))
            .unwrap();

        let mut alone = whole[..first_page_end].to_vec();
        mark_history(&mut alone, None, true);
        assert_eq!(
            settled(&alone),
            vec![v("r0", Verdict::Unverified, false)],
            "the page alone cannot see it"
        );

        let mut page = whole[..first_page_end].to_vec();
        mark_page(&mut page, &whole, None, true);
        assert_eq!(settled(&page), vec![v("r0", Verdict::Verified, true)]);
    }

    #[test]
    fn live_and_a_log_replay_give_the_same_verdicts() {
        let mut log = Vec::new();
        for (turn, status) in [("t1", ToolStatus::Ok), ("t2", ToolStatus::Error)] {
            log.push(user(turn));
            log.extend(turn_events(turn, status));
            log.push(turn_completed(turn));
        }
        let mut tracker = Tracker::new(None);
        let mut live = Vec::new();
        let at = Instant::now();
        for event in &log {
            live.extend(tracker.observe(event, Some(at)).into_events());
            live.push(event.clone());
        }
        let expected = vec![
            ("t1".to_string(), Verdict::Verified),
            ("t2".to_string(), Verdict::Failed),
        ];
        assert_eq!(verdicts(&live), expected);

        // The log holds what live sent; its replay recomputes to one per turn.
        let mut replayed = live.clone();
        mark_history(&mut replayed, None, true);
        assert_eq!(verdicts(&replayed), expected);
        assert_eq!(replayed.len(), live.len());
        let first = replayed
            .iter()
            .position(|e| matches!(e, ChatEvent::TurnVerification { .. }))
            .unwrap();
        assert!(matches!(replayed[first + 1], ChatEvent::TurnCompleted { .. }));
        let durations = |events: &[ChatEvent]| {
            events
                .iter()
                .filter_map(|e| match e {
                    ChatEvent::TurnVerification { checks, .. } => Some(checks[0].duration_ms),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(durations(&replayed), durations(&live), "a logged duration survives");
        assert!(durations(&live).iter().all(Option::is_some));

        let mut off = live.clone();
        mark_history(&mut off, None, false);
        assert!(verdicts(&off).is_empty(), "off drops even what the log holds");
    }

    #[test]
    fn a_second_pass_of_a_turn_reuses_the_first_answer() {
        let mut tracker = Tracker::new(None);
        let at = Instant::now();
        let mut first = None;
        for event in turn_events("t1", ToolStatus::Ok).iter().chain([&turn_completed("t1")]) {
            first = tracker.observe(event, Some(at)).own.or(first);
        }
        let mut second = None;
        for event in turn_events("t1", ToolStatus::Ok).iter().chain([&turn_completed("t1")]) {
            second = tracker.observe(event, None).own.or(second);
        }
        assert_eq!(first, second);
    }

    #[test]
    fn a_claude_transcript_replays_to_one_verdict_per_prompt() {
        let dir = std::env::temp_dir().join(format!("tori-verification-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("checked.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","timestamp":"2026-10-08T10:00:00Z","message":{"role":"user","content":"fix it"}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-10-08T10:00:01Z","message":{"content":[{"type":"text","text":"on it"},{"type":"tool_use","id":"toolu_e","name":"Edit","input":{"file_path":"/w/a.rs","old_string":"a","new_string":"b"}}]}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-10-08T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_e","content":"edited"}]}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-10-08T10:00:03Z","message":{"content":[{"type":"tool_use","id":"toolu_t","name":"Bash","input":{"command":"cargo test 2>&1 | tail -5"}}]}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-10-08T10:00:20Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_t","content":"test result: ok"}]}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-10-08T10:01:00Z","message":{"role":"user","content":"run it plainly"}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-10-08T10:01:01Z","message":{"content":[{"type":"tool_use","id":"toolu_w","name":"Write","input":{"file_path":"/w/b.rs","content":"x"}}]}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-10-08T10:01:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_w","content":"written"}]}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-10-08T10:01:03Z","message":{"content":[{"type":"tool_use","id":"toolu_u","name":"Bash","input":{"command":"cargo test"}}]}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-10-08T10:01:30Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_u","content":"Exit code 101\nfailures","is_error":true}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        let turns = crate::sessions::transcript_turns(path.to_str().unwrap(), "claude");
        let mut events = crate::chat::history::events_from_turns("s1", &turns, &[]);
        mark_history(&mut events, None, true);
        type Mark = (Verdict, Vec<(CheckResult, Option<i32>)>);
        let marks: Vec<Mark> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TurnVerification { verdict, checks, .. } => {
                    Some((*verdict, checks.iter().map(|c| (c.result, c.exit_code)).collect()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            marks,
            vec![
                (Verdict::Failed, vec![(CheckResult::Failed, Some(101))]),
                (Verdict::Failed, vec![(CheckResult::Failed, Some(101))]),
            ]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_transcript_groups_by_prompt_and_marks_the_first_reply_turn() {
        // A replayed Claude transcript gives each record its own turn id and
        // records no `TurnCompleted`.
        let reply = |turn: &str| ChatEvent::TextDelta {
            session_id: "s1".into(),
            turn_id: turn.into(),
            text: "ok".into(),
            agent_id: None,
        };
        let mut events = vec![user("h1"), reply("h2")];
        events.push(started("e1", "h3", ToolKind::Edit, "Edit", json!({})));
        events.push(completed("e1", "h4", ToolStatus::Ok, ""));
        events.push(started(
            "c1",
            "h5",
            ToolKind::Execute,
            "Bash",
            json!({ "command": "cargo test" }),
        ));
        events.push(completed("c1", "h6", ToolStatus::Ok, ""));
        events.extend([user("h7"), reply("h8")]);
        events.push(started("e2", "h9", ToolKind::Edit, "Edit", json!({})));
        events.push(completed("e2", "h10", ToolStatus::Ok, ""));
        mark_history(&mut events, None, true);
        assert_eq!(
            verdicts(&events),
            vec![
                ("h2".to_string(), Verdict::Verified),
                ("h8".to_string(), Verdict::Unverified)
            ]
        );
        let at = events
            .iter()
            .position(|e| matches!(e, ChatEvent::TurnVerification { .. }))
            .unwrap();
        assert!(matches!(&events[at + 1], ChatEvent::UserMessage { turn_id, .. } if turn_id == "h7"));
    }

    #[test]
    fn an_acp_log_with_timed_prompts_gives_every_turn_its_prompt_time() {
        let mut events = vec![user("a")];
        events.extend(turn_events("a", ToolStatus::Ok));
        events.push(user("b"));
        events.extend(turn_events("b", ToolStatus::Error));
        let prompts = crate::chat::mirror::timed_prompts(&events, &[1_760_000_000, 1_760_000_300]);
        let turns = session_turns(&events, &prompts, &parse_entries(DEFAULTS.iter().copied()), None);
        assert_eq!(turns.len(), 2);
        assert_eq!(
            turns.iter().map(|t| t.prompt_ts).collect::<Vec<_>>(),
            vec![Some(1_760_000_000), Some(1_760_000_300)]
        );
    }
}
