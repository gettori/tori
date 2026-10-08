//! Verification: what a turn that changed code ran to check it.
//!
//! A fact on the turn, never a gate. The claim is only as strong as the exit
//! that reached the call: a check whose own exit was masked by a pipe, a `;`,
//! a `||`, a background run, an interrupt or a timeout is "ran, exit not seen",
//! and a turn resting on one of those reads unverified, never verified.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Instant, SystemTime};

use serde_json::Value;

use crate::chat::model::{ChatEvent, Check, CheckResult, ToolKind, ToolStatus, ToolSummary, Verdict};
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

pub fn entries_for(_cwd: Option<&Path>) -> Vec<Vec<String>> {
    parse_entries(DEFAULTS.iter().copied())
}

fn parse_entries<'a>(list: impl IntoIterator<Item = &'a str>) -> Vec<Vec<String>> {
    list.into_iter()
        .map(|e| strip_wrappers(e.split_whitespace().map(str::to_string).collect()))
        .filter(|w| !w.is_empty())
        .collect()
}

pub fn enabled() -> bool {
    static CACHE: Mutex<Option<(Option<SystemTime>, bool)>> = Mutex::new(None);
    let stamp = crate::settings::modified();
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, on)) = *cache {
        if at == stamp {
            return on;
        }
    }
    let on = crate::settings::verification().enabled;
    *cache = Some((stamp, on));
    on
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
    started: Option<Instant>,
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

#[derive(Default)]
pub struct Turn {
    calls: HashMap<String, Call>,
    // Each finished call that edited (`None`) or checked (its checks).
    steps: Vec<Option<Vec<Check>>>,
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
                ..
            } => {
                let call = self.calls.entry(tool_use_id.clone()).or_insert_with(|| Call {
                    name: String::new(),
                    command: None,
                    background: false,
                    edits: false,
                    started: now,
                });
                if !name.is_empty() {
                    call.name = name.clone();
                }
                call.edits |= matches!(kind, ToolKind::Edit | ToolKind::Delete | ToolKind::Move);
                if *kind == ToolKind::Execute {
                    if let Some(command) = command_text(input) {
                        call.command = Some(command);
                    }
                    call.background |= input.get("run_in_background").and_then(Value::as_bool) == Some(true);
                }
            }
            ChatEvent::FileEdit { tool_use_id, .. } => {
                if let Some(call) = self.calls.get_mut(tool_use_id) {
                    call.edits = true;
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
                let Some(call) = self.calls.remove(tool_use_id) else {
                    return;
                };
                if *status == ToolStatus::Ok && (call.edits || !files.is_empty()) {
                    self.steps.push(None);
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
                    self.steps.push(Some(checks));
                }
            }
            _ => {}
        }
    }

    /// The verdict and every check the turn ran, or `None` for a turn that
    /// changed no code. Only checks after the last edit decide it, and of
    /// those the last call's worst result does.
    pub fn finish(&self) -> Option<(Verdict, Vec<Check>)> {
        let last_edit = self.steps.iter().rposition(Option::is_none)?;
        let checks: Vec<Check> = self.steps.iter().flatten().flatten().cloned().collect();
        let verdict = match self.steps[last_edit..].iter().rev().find_map(Option::as_ref) {
            None => Verdict::Unverified,
            Some(last) if last.iter().any(|c| c.result == CheckResult::Failed) => Verdict::Failed,
            Some(last) if last.iter().any(|c| c.result == CheckResult::NotSeen) => Verdict::Unverified,
            Some(_) => Verdict::Verified,
        };
        Some((verdict, checks))
    }
}

fn verification_event(session_id: &str, turn_id: &str, turn: &Turn) -> Option<ChatEvent> {
    let (verdict, checks) = turn.finish()?;
    Some(ChatEvent::TurnVerification {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        verdict,
        checks,
    })
}

/// One live session's turns, fed every event in order. Returns the
/// `TurnVerification` to send ahead of a `TurnCompleted`.
pub struct Tracker {
    entries: Vec<Vec<String>>,
    turns: HashMap<String, Turn>,
    // The first answer per turn. An ACP load replays the conversation through
    // the same sink, and a replay has no timing to measure, so the second pass
    // reuses what the live one measured.
    verdicts: HashMap<String, Option<ChatEvent>>,
}

impl Tracker {
    pub fn new(cwd: Option<&Path>) -> Self {
        Self {
            entries: entries_for(cwd),
            turns: HashMap::new(),
            verdicts: HashMap::new(),
        }
    }

    pub fn observe(&mut self, event: &ChatEvent, now: Option<Instant>) -> Option<ChatEvent> {
        match event {
            ChatEvent::ToolCallStarted { turn_id, .. }
            | ChatEvent::FileEdit { turn_id, .. }
            | ChatEvent::ToolCallCompleted { turn_id, .. } => {
                self.turns
                    .entry(turn_id.clone())
                    .or_default()
                    .observe(event, now, &self.entries);
                None
            }
            ChatEvent::TurnCompleted {
                session_id, turn_id, ..
            } => {
                let turn = self.turns.remove(turn_id).unwrap_or_default();
                self.verdicts
                    .entry(turn_id.clone())
                    .or_insert_with(|| verification_event(session_id, turn_id, &turn))
                    .clone()
            }
            _ => None,
        }
    }
}

/// Mark a replayed conversation's turns the way `Tracker` marks a live one's,
/// against the check list as it is now. A logged `TurnVerification` is dropped
/// and recomputed, keeping only the durations it measured. A history with
/// `TurnCompleted`s (a mirror log) groups by turn id; a transcript has none and
/// groups by prompt, marking the first reply turn after each.
pub fn mark_history(events: &mut Vec<ChatEvent>, cwd: Option<&Path>, enabled: bool) {
    let mut measured: HashMap<(String, String), u64> = HashMap::new();
    events.retain(|e| match e {
        ChatEvent::TurnVerification { checks, .. } => {
            for c in checks {
                if let Some(ms) = c.duration_ms {
                    measured.insert((c.tool_use_id.clone(), c.command.clone()), ms);
                }
            }
            false
        }
        _ => true,
    });
    if !enabled {
        return;
    }
    let entries = entries_for(cwd);
    let with_durations = |event: Option<ChatEvent>| {
        let mut event = event?;
        if let ChatEvent::TurnVerification { checks, .. } = &mut event {
            for c in checks {
                if c.duration_ms.is_none() {
                    c.duration_ms = measured.get(&(c.tool_use_id.clone(), c.command.clone())).copied();
                }
            }
        }
        Some(event)
    };

    let mut out: Vec<ChatEvent> = Vec::with_capacity(events.len() + 8);
    if events.iter().any(|e| matches!(e, ChatEvent::TurnCompleted { .. })) {
        let mut turns: HashMap<String, Turn> = HashMap::new();
        for event in events.drain(..) {
            match &event {
                ChatEvent::ToolCallStarted { turn_id, .. }
                | ChatEvent::FileEdit { turn_id, .. }
                | ChatEvent::ToolCallCompleted { turn_id, .. } => {
                    turns
                        .entry(turn_id.clone())
                        .or_default()
                        .observe(&event, None, &entries);
                }
                ChatEvent::TurnCompleted {
                    session_id, turn_id, ..
                } => {
                    let turn = turns.remove(turn_id).unwrap_or_default();
                    out.extend(with_durations(verification_event(session_id, turn_id, &turn)));
                }
                _ => {}
            }
            out.push(event);
        }
    } else {
        let mut turn = Turn::default();
        let mut prompt: Option<String> = None;
        let mut anchor: Option<(String, String)> = None;
        let close = |turn: &mut Turn, anchor: &mut Option<(String, String)>, out: &mut Vec<ChatEvent>| {
            if let Some((session_id, turn_id)) = anchor.take() {
                out.extend(with_durations(verification_event(&session_id, &turn_id, turn)));
            }
            *turn = Turn::default();
        };
        for event in events.drain(..) {
            match &event {
                ChatEvent::UserMessage { turn_id, .. } if prompt.as_deref() != Some(turn_id.as_str()) => {
                    close(&mut turn, &mut anchor, &mut out);
                    prompt = Some(turn_id.clone());
                }
                ChatEvent::TextDelta {
                    session_id, turn_id, ..
                }
                | ChatEvent::ThinkingDelta {
                    session_id, turn_id, ..
                } => {
                    anchor.get_or_insert_with(|| (session_id.clone(), turn_id.clone()));
                }
                ChatEvent::ToolCallStarted {
                    session_id, turn_id, ..
                } => {
                    anchor.get_or_insert_with(|| (session_id.clone(), turn_id.clone()));
                    turn.observe(&event, None, &entries);
                }
                ChatEvent::FileEdit { .. } | ChatEvent::ToolCallCompleted { .. } => {
                    turn.observe(&event, None, &entries);
                }
                _ => {}
            }
            out.push(event);
        }
        close(&mut turn, &mut anchor, &mut out);
    }
    *events = out;
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
            self.turn.finish().map(|(v, _)| v)
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
        let (_, checks) = run.turn.finish().unwrap();
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
            if let Some(v) = tracker.observe(event, Some(at)) {
                live.push(v);
            }
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
            first = tracker.observe(event, Some(at)).or(first);
        }
        let mut second = None;
        for event in turn_events("t1", ToolStatus::Ok).iter().chain([&turn_completed("t1")]) {
            second = tracker.observe(event, None).or(second);
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
                (Verdict::Unverified, vec![(CheckResult::NotSeen, None)]),
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
}
