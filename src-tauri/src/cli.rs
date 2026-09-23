//! `tori <command>`: the CLI front on the app socket, run from the same binary
//! as the app and before any Tauri init. See [[adr_one_protocol_several_fronts]].

use std::collections::HashMap;
use std::io::{self, Write};

use serde_json::{json, Value};

use crate::rpc::client::{self, Client, Found};

const COMMANDS: [&str; 14] = [
    "sessions", "session", "events", "whoami", "steer", "worktree", "checkpoints", "checkpoint", "spawn", "open", "budget",
    "ask", "pr", "mcp",
];

const USAGE: &str = "usage:
  tori sessions [--live] [--cwd <path>] [--limit <n>] [--json]
  tori session tail <id> [--lines <n>] [--agent <id>] [--json]
  tori session wait <id> [--timeout <secs>] [--json]
  tori events [--topic <topic>]...
  tori whoami [--json]
  tori steer <id> <text>...
  tori worktree new <branch> [--project <path>] [--from <ref>]
  tori checkpoints <id> [--json]
  tori checkpoint diff <id> <n> [<m>]
  tori checkpoint revert <id> <n> [--force]
  tori spawn [--agent <id>] [--account <id>] [--folder <path> | --new-worktree <branch> [--project <path>] [--from <ref>]]
             [--prompt <text>] [--attach <path>]... [--background] [--json]
  tori open <path> [--line <n>]
  tori budget [<id>] [--folder <path>] [--json]
  tori ask <question>... [--option <text>]... [--timeout <secs>] [--approval <json> [--project <path>]]
  tori ask --wait <id> [--timeout <secs>]
  tori ask --answer <id> <text>...
  tori pr create --head <branch> --base <branch> --title <text> [--body <text>] [--draft] [--project <path>] [--approval <id>] [--json]
  tori pr review <number> --event approve|comment|request-changes [--body <text>] [--comments <json>] [--project <path>] [--approval <id>]
  tori pr merge <number> --method merge|squash|rebase --head-sha <sha> [--project <path>] [--approval <id>]
  tori mcp";

pub fn is_cli() -> bool {
    std::env::args().nth(1).is_some_and(|arg| COMMANDS.contains(&arg.as_str()))
}

pub fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match dispatch(&args) {
        Ok(()) => 0,
        // A reader that went away (`tori events | head`) is a normal end.
        Err(Failure::Io(e)) if e.kind() == io::ErrorKind::BrokenPipe => 0,
        // Not an error, but a script has to tell it from an answer.
        Err(Failure::Unanswered(id)) => {
            println!("{id}");
            eprintln!("tori: no answer yet, poll with: tori ask --wait {id}");
            2
        }
        Err(e) => {
            eprintln!("tori: {e}");
            1
        }
    }
}

enum Failure {
    Usage(String),
    Client(client::ClientError),
    Io(io::Error),
    Unanswered(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Usage(message) => write!(f, "{message}\n{USAGE}"),
            Failure::Client(e) => write!(f, "{e}"),
            Failure::Io(e) => write!(f, "{e}"),
            Failure::Unanswered(id) => write!(f, "no answer yet for {id}"),
        }
    }
}

impl From<client::ClientError> for Failure {
    fn from(e: client::ClientError) -> Self {
        Failure::Client(e)
    }
}

impl From<io::Error> for Failure {
    fn from(e: io::Error) -> Self {
        Failure::Io(e)
    }
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

fn dispatch(args: &[String]) -> Result<(), Failure> {
    let rest = &args[1..];
    match args[0].as_str() {
        "sessions" => sessions(rest),
        "session" => match rest.first().map(String::as_str) {
            Some("tail") => session_tail(&rest[1..]),
            Some("wait") => session_wait(&rest[1..]),
            _ => Err(usage("session needs a subcommand: tail or wait")),
        },
        "events" => events(rest),
        "whoami" => whoami(rest),
        "steer" => steer(rest),
        "worktree" => match rest.first().map(String::as_str) {
            Some("new") => worktree_new(&rest[1..]),
            _ => Err(usage("worktree needs a subcommand: new")),
        },
        "checkpoints" => checkpoints(rest),
        "checkpoint" => match rest.first().map(String::as_str) {
            Some("diff") => checkpoint_diff(&rest[1..]),
            Some("revert") => checkpoint_revert(&rest[1..]),
            _ => Err(usage("checkpoint needs a subcommand: diff or revert")),
        },
        "spawn" => spawn(rest),
        "open" => open(rest),
        "budget" => budget(rest),
        "ask" => ask(rest),
        "pr" => pr(rest),
        "mcp" => Ok(crate::mcp::run()?),
        other => Err(usage(format!("unknown command {other}"))),
    }
}

struct Parsed {
    positional: Vec<String>,
    flags: HashMap<String, Vec<String>>,
}

impl Parsed {
    fn new(args: &[String], valued: &[&str], switches: &[&str]) -> Result<Self, Failure> {
        let mut parsed = Parsed { positional: Vec::new(), flags: HashMap::new() };
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            let Some(name) = arg.strip_prefix("--") else {
                parsed.positional.push(arg.clone());
                continue;
            };
            if valued.contains(&name) {
                let value = args.next().ok_or_else(|| usage(format!("--{name} needs a value")))?;
                parsed.flags.entry(name.to_string()).or_default().push(value.clone());
            } else if switches.contains(&name) {
                parsed.flags.entry(name.to_string()).or_default();
            } else {
                return Err(usage(format!("unknown flag --{name}")));
            }
        }
        Ok(parsed)
    }

    fn has(&self, name: &str) -> bool {
        self.flags.contains_key(name)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.flags.get(name).and_then(|v| v.last()).map(String::as_str)
    }

    fn number(&self, name: &str) -> Result<Option<usize>, Failure> {
        self.value(name)
            .map(|v| v.parse().map_err(|_| usage(format!("--{name} takes a number, got {v}"))))
            .transpose()
    }
}

fn connect() -> Result<Client, Failure> {
    let endpoint = client::locate().ok_or_else(|| {
        let message = "Tori is not running: no TORI_SOCK in the environment and no ~/.config/tori/rpc.json";
        Failure::Io(io::Error::new(io::ErrorKind::NotFound, message))
    })?;
    if endpoint.found == Found::File {
        eprintln!("tori: not started by Tori, connecting through ~/.config/tori/rpc.json as an outside caller");
    }
    match Client::connect(&endpoint) {
        // A crash leaves the bridge file behind, naming a socket nobody serves.
        Err(client::ClientError::Io(e)) if endpoint.found == Found::File && e.kind() == io::ErrorKind::ConnectionRefused => {
            let message = "Tori is not running: ~/.config/tori/rpc.json names a socket nobody is serving";
            Err(Failure::Io(io::Error::new(io::ErrorKind::NotFound, message)))
        }
        connected => Ok(connected?),
    }
}

fn sessions(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["cwd", "limit"], &["live", "json"])?;
    let params = json!({ "cwd": p.value("cwd"), "live": p.has("live"), "limit": p.number("limit")? });
    let rows = connect()?.call("sessions.list", params)?;
    let mut out = io::stdout().lock();
    if p.has("json") {
        return Ok(writeln!(out, "{rows}")?);
    }
    let rows = rows.as_array().cloned().unwrap_or_default();
    let table: Vec<[String; 7]> = rows.iter().map(session_cells).collect();
    let header = ["ID", "AGENT", "ACCOUNT", "STATE", "BRANCH", "FOLDER", "TITLE"].map(String::from);
    let mut widths = header.clone().map(|h| h.len());
    for row in &table {
        for (w, cell) in widths.iter_mut().zip(row) {
            *w = (*w).max(cell.chars().count());
        }
    }
    for row in std::iter::once(&header).chain(&table) {
        let line: Vec<String> = row.iter().zip(widths).map(|(cell, w)| format!("{cell:<w$}")).collect();
        writeln!(out, "{}", line.join("  ").trim_end())?;
    }
    Ok(())
}

fn session_cells(row: &Value) -> [String; 7] {
    let text = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let account = row
        .get("profile_label")
        .and_then(Value::as_str)
        .or_else(|| row.get("profile").and_then(Value::as_str))
        .unwrap_or("default")
        .to_string();
    let state = match row.get("state").and_then(Value::as_str) {
        Some(state) => state.replace('_', " "),
        None => "live".to_string(),
    };
    let title = row.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| text("title"));
    [text("id"), text("agent"), account, state, text("branch"), home_relative(&text("cwd")), clip(&title, 60)]
}

fn home_relative(path: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return path.to_string();
    };
    match path.strip_prefix(&*home.to_string_lossy()) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => path.to_string(),
    }
}

fn clip(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or("");
    if line.chars().count() <= max {
        return line.to_string();
    }
    let cut: String = line.chars().take(max - 3).collect();
    format!("{cut}...")
}

fn session_tail(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["lines", "agent"], &["json"])?;
    let [id] = p.positional.as_slice() else {
        return Err(usage("session tail takes one session id"));
    };
    let lines = p.number("lines")?;
    let json = p.has("json");
    // One reply streams as many text pieces, so N lines of text need far more
    // than N events. `--json` prints events, so there it counts events.
    let limit = if json { lines } else { lines.map(|n| n.saturating_mul(20)) };
    let params = json!({ "id": id, "agent": p.value("agent"), "limit": limit });
    let events = connect()?.call("session.tail", params)?;
    let mut out = io::stdout().lock();
    if json {
        return Ok(writeln!(out, "{events}")?);
    }
    let text = transcript(events.as_array().map(Vec::as_slice).unwrap_or_default()).join("\n");
    let all: Vec<&str> = text.lines().collect();
    for line in &all[all.len().saturating_sub(lines.unwrap_or(all.len()))..] {
        writeln!(out, "{line}")?;
    }
    Ok(())
}

fn transcript(events: &[Value]) -> Vec<String> {
    let mut lines = Vec::new();
    let mut prose = String::new();
    let flush = |prose: &mut String, lines: &mut Vec<String>| {
        if !prose.trim().is_empty() {
            lines.push(prose.trim().to_string());
        }
        prose.clear();
    };
    for event in events {
        let field = |key: &str| event.get(key).and_then(Value::as_str);
        match field("type").unwrap_or("") {
            "textDelta" if event.get("agentId").is_none_or(Value::is_null) => {
                prose.push_str(field("text").unwrap_or(""));
            }
            "userMessage" => {
                flush(&mut prose, &mut lines);
                let text: Vec<&str> = event["blocks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|b| b.get("text").and_then(Value::as_str))
                    .collect();
                lines.push(format!("> {}", text.join("\n").replace('\n', "\n> ")));
            }
            "toolCallStarted" => {
                flush(&mut prose, &mut lines);
                let input = |key: &str| event["input"].get(key).and_then(Value::as_str);
                let what = field("title")
                    .or_else(|| input("command"))
                    .or_else(|| input("file_path"))
                    .or_else(|| input("path"))
                    .unwrap_or("");
                lines.push(format!("  [{}] {}", field("name").unwrap_or("tool"), clip(what, 100)).trim_end().to_string());
            }
            "sessionError" => {
                flush(&mut prose, &mut lines);
                lines.push(format!("error: {}", field("message").unwrap_or("")));
            }
            _ => {}
        }
    }
    flush(&mut prose, &mut lines);
    lines
}

fn wait_params(args: &[String]) -> Result<(Value, bool), Failure> {
    let p = Parsed::new(args, &["timeout"], &["json"])?;
    let [id] = p.positional.as_slice() else {
        return Err(usage("session wait takes one session id"));
    };
    Ok((json!({ "id": id, "timeout": p.number("timeout")? }), p.has("json")))
}

fn session_wait(args: &[String]) -> Result<(), Failure> {
    let (params, json) = wait_params(args)?;
    let settled = connect()?.call("session.wait", params)?;
    let mut out = io::stdout().lock();
    if json {
        return Ok(writeln!(out, "{settled}")?);
    }
    writeln!(out, "{}", settled["state"].as_str().unwrap_or(""))?;
    if let Some(question) = settled["question"]["question"].as_str() {
        writeln!(out, "asking {}: {question}", settled["question"]["id"].as_str().unwrap_or(""))?;
    }
    if let Some(last) = settled["last"].as_str() {
        writeln!(out, "{last}")?;
    }
    Ok(())
}

fn whoami(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &[], &["json"])?;
    let me = connect()?.call("caller", Value::Null)?;
    let mut out = io::stdout().lock();
    if p.has("json") {
        return Ok(writeln!(out, "{me}")?);
    }
    Ok(write!(out, "{}", render_whoami(&me))?)
}

// The kind, not `caller.kind`: a worker's caller is still a chat.
fn render_whoami(me: &Value) -> String {
    let mut text = match me["caller"]["id"].as_str() {
        Some(id) => format!("{} {id}\n", me["kind"].as_str().unwrap_or("")),
        None => "outside caller\n".to_string(),
    };
    for key in ["agent", "account", "cwd"] {
        if let Some(value) = me["identity"][key].as_str() {
            text.push_str(&format!("{key}: {value}\n"));
        }
    }
    text
}

fn steer(args: &[String]) -> Result<(), Failure> {
    // No flags, so a `--word` in the message stays part of it.
    let [id, words @ ..] = args else {
        return Err(usage("steer takes a session id and the text to send"));
    };
    if words.is_empty() {
        return Err(usage("steer needs the text to send"));
    }
    let delivered = connect()?.call("session.steer", json!({ "id": id, "text": words.join(" ") }))?;
    let how = delivered["delivered"].as_str().unwrap_or("sent");
    Ok(writeln!(io::stdout().lock(), "{how}: {id}")?)
}

fn worktree_new(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["project", "from"], &[])?;
    let [branch] = p.positional.as_slice() else {
        return Err(usage("worktree new takes one branch name"));
    };
    let project = p.value("project").map(absolute).transpose()?;
    let made = connect()?.call("worktree.new", json!({ "branch": branch, "project": project, "from": p.value("from") }))?;
    Ok(writeln!(io::stdout().lock(), "{}", made["path"].as_str().unwrap_or(""))?)
}

// The socket resolves paths in the app's cwd, not this shell's.
fn absolute(path: &str) -> Result<String, Failure> {
    Ok(std::path::absolute(path)?.to_string_lossy().into_owned())
}

fn checkpoints(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &[], &["json"])?;
    let [id] = p.positional.as_slice() else {
        return Err(usage("checkpoints takes one session id"));
    };
    let list = connect()?.call("checkpoints.list", json!({ "id": id }))?;
    let mut out = io::stdout().lock();
    if p.has("json") {
        return Ok(writeln!(out, "{list}")?);
    }
    for row in list.as_array().into_iter().flatten() {
        let number = |key: &str| row[key].as_u64().unwrap_or(0);
        let files = number("file_count");
        let noun = if files == 1 { "file" } else { "files" };
        writeln!(out, "{:>3}  {}  {files} {noun}", number("turn"), row["kind"].as_str().unwrap_or(""))?;
    }
    Ok(())
}

fn checkpoint_turn(args: &[String], switches: &[&str]) -> Result<Value, Failure> {
    let p = Parsed::new(args, &[], switches)?;
    let [id, turn] = p.positional.as_slice() else {
        return Err(usage("takes a session id and a turn number from tori checkpoints"));
    };
    let turn: usize = turn.parse().map_err(|_| usage(format!("turn must be a number, got {turn}")))?;
    Ok(json!({ "id": id, "turn": turn, "force": p.has("force").then_some(true) }))
}

fn diff_params(args: &[String]) -> Result<Value, Failure> {
    let p = Parsed::new(args, &[], &[])?;
    let (id, turn, to) = match p.positional.as_slice() {
        [id, turn] => (id, turn, None),
        [id, turn, to] => (id, turn, Some(to)),
        _ => return Err(usage("takes a session id, a turn number from tori checkpoints and an optional last turn")),
    };
    let number = |v: &String| v.parse::<usize>().map_err(|_| usage(format!("turn must be a number, got {v}")));
    Ok(json!({ "id": id, "turn": number(turn)?, "to": to.map(number).transpose()? }))
}

fn checkpoint_diff(args: &[String]) -> Result<(), Failure> {
    let params = diff_params(args)?;
    let diff = connect()?.call("checkpoint.diff", params)?;
    Ok(write!(io::stdout().lock(), "{}", diff["diff"].as_str().unwrap_or(""))?)
}

fn checkpoint_revert(args: &[String]) -> Result<(), Failure> {
    let params = checkpoint_turn(args, &["force"])?;
    let outcome = connect()?.call("checkpoint.revert", params)?;
    let mut out = io::stdout().lock();
    for (key, verb) in [("restored", "restored"), ("deleted", "deleted")] {
        for path in outcome[key].as_array().into_iter().flatten().filter_map(Value::as_str) {
            writeln!(out, "{verb} {path}")?;
        }
    }
    Ok(())
}

fn spawn(args: &[String]) -> Result<(), Failure> {
    let valued = ["agent", "account", "folder", "new-worktree", "project", "from", "prompt", "attach"];
    let p = Parsed::new(args, &valued, &["background", "json"])?;
    if !p.positional.is_empty() {
        return Err(usage("spawn takes no positional arguments: pass the prompt with --prompt"));
    }
    if p.has("folder") && p.has("new-worktree") {
        return Err(usage("pass --folder or --new-worktree, not both"));
    }
    let path = |name| p.value(name).map(absolute).transpose();
    let attach = p.flags.get("attach").into_iter().flatten().map(|a| absolute(a)).collect::<Result<Vec<_>, _>>()?;
    let params = json!({
        "agent": p.value("agent"),
        "account": p.value("account"),
        "folder": path("folder")?,
        "new_worktree": p.value("new-worktree"),
        "project": path("project")?,
        "from": p.value("from"),
        "prompt": p.value("prompt"),
        "attach": attach,
        "background": p.has("background"),
    });
    let spawned = connect()?.call("session.spawn", params)?;
    let mut out = io::stdout().lock();
    if p.has("json") {
        return Ok(writeln!(out, "{spawned}")?);
    }
    Ok(writeln!(out, "{}", spawned["id"].as_str().unwrap_or(""))?)
}

fn open(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["line"], &[])?;
    let [path] = p.positional.as_slice() else {
        return Err(usage("open takes one file path"));
    };
    connect()?.call("window.open", json!({ "path": absolute(path)?, "line": p.number("line")? }))?;
    Ok(())
}

fn budget(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["folder"], &["json"])?;
    let id = match p.positional.as_slice() {
        [] => None,
        [id] => Some(id),
        _ => return Err(usage("budget takes at most one session id")),
    };
    let folder = p.value("folder").map(absolute).transpose()?;
    let figures = connect()?.call("budget", json!({ "id": id, "folder": folder }))?;
    let mut out = io::stdout().lock();
    if p.has("json") {
        return Ok(writeln!(out, "{figures}")?);
    }
    let dollars = |v: &Value| v.as_f64().map_or("unknown".to_string(), |usd| format!("${usd:.2}"));
    let ceiling = |v: &Value| v.as_f64().map_or("no budget".to_string(), |usd| format!("of ${usd:.2}"));
    let budgets = &figures["budgets"];
    if let Some(session) = figures["session"].as_object() {
        let spent = dollars(&session["costUsd"]);
        let id = figures["id"].as_str().unwrap_or("");
        writeln!(out, "session  {spent} {}  {id}", ceiling(&budgets["sessionUsd"]))?;
    }
    let spent = dollars(&figures["project"]["costUsd"]);
    writeln!(out, "project  {spent} {}  {}", ceiling(&budgets["projectUsd"]), figures["folder"].as_str().unwrap_or(""))?;
    for window in figures["quota"].as_array().into_iter().flatten() {
        let used = window["utilization"].as_f64().map_or("?".to_string(), |u| format!("{:.0}%", u * 100.0));
        let kind = window["kind"].as_str().unwrap_or("");
        writeln!(out, "{kind}  {used}  {}", window["state"].as_str().unwrap_or(""))?;
    }
    Ok(())
}

fn ask_request(args: &[String]) -> Result<(&'static str, Value), Failure> {
    let p = Parsed::new(args, &["option", "timeout", "wait", "answer", "approval", "project"], &[])?;
    if (p.has("approval") || p.has("project")) && (p.has("wait") || p.has("answer")) {
        return Err(usage("--approval and --project go with a question, not --wait or --answer"));
    }
    let timeout = p.number("timeout")?;
    Ok(match (p.value("wait"), p.value("answer")) {
        (Some(_), Some(_)) => return Err(usage("ask takes --wait or --answer, not both")),
        (Some(id), None) if p.positional.is_empty() => ("ask.wait", json!({ "id": id, "timeout": timeout })),
        (Some(_), None) => return Err(usage("ask --wait takes only the id to poll")),
        (None, Some(_)) if p.positional.is_empty() => return Err(usage("ask --answer needs the answer text")),
        (None, Some(id)) => ("ask.answer", json!({ "id": id, "answer": p.positional.join(" ") })),
        (None, None) if p.positional.is_empty() => return Err(usage("ask needs a question")),
        (None, None) => {
            let options = p.flags.get("option").cloned().unwrap_or_default();
            let approval = p.value("approval").map(json_flag("approval")).transpose()?;
            let project = p.value("project").map(absolute).transpose()?;
            let question = p.positional.join(" ");
            ("ask.create", json!({ "question": question, "options": options, "timeout": timeout, "approval": approval, "project": project }))
        }
    })
}

fn ask(args: &[String]) -> Result<(), Failure> {
    let (method, params) = ask_request(args)?;
    let asked = connect()?.call(method, params)?;
    if method == "ask.answer" {
        return Ok(());
    }
    let Some(answer) = asked["answer"].as_str() else {
        return Err(Failure::Unanswered(asked["id"].as_str().unwrap_or("").to_string()));
    };
    let mut out = io::stdout().lock();
    writeln!(out, "{answer}")?;
    if let Some(approval_id) = asked["approval_id"].as_str() {
        writeln!(out, "approval_id: {approval_id}")?;
    }
    Ok(())
}

fn json_flag(name: &'static str) -> impl Fn(&str) -> Result<Value, Failure> {
    move |raw| serde_json::from_str(raw).map_err(|e| usage(format!("--{name} takes JSON: {e}")))
}

fn pr_request(args: &[String]) -> Result<(&'static str, Value), Failure> {
    let Some((sub, rest)) = args.split_first() else {
        return Err(usage("pr needs a subcommand: create, review or merge"));
    };
    let valued = ["head", "base", "title", "body", "event", "comments", "method", "head-sha", "project", "approval"];
    let p = Parsed::new(rest, &valued, &["draft", "json"])?;
    let project = p.value("project").map(absolute).transpose()?;
    let approval_id = p.value("approval");
    let number = || match p.positional.as_slice() {
        [n] => n.parse::<u64>().map_err(|_| usage(format!("the pull request number must be a number, got {n}"))),
        _ => Err(usage(format!("pr {sub} takes one pull request number"))),
    };
    let needed = |name: &str| p.value(name).ok_or_else(|| usage(format!("pr {sub} needs --{name}")));
    Ok(match sub.as_str() {
        "create" if p.positional.is_empty() => (
            "pr.create",
            json!({
                "head": needed("head")?,
                "base": needed("base")?,
                "title": needed("title")?,
                "body": p.value("body").unwrap_or(""),
                "draft": p.has("draft"),
                "project": project,
                "approval_id": approval_id,
            }),
        ),
        "create" => return Err(usage("pr create takes no positional arguments")),
        "review" => {
            let event = match needed("event")? {
                "approve" => "approve",
                "comment" => "comment",
                "request-changes" => "requestChanges",
                other => return Err(usage(format!("--event is approve, comment or request-changes, got {other}"))),
            };
            let comments = p.value("comments").map(json_flag("comments")).transpose()?;
            let body = p.value("body").unwrap_or("");
            let params = json!({ "number": number()?, "event": event, "body": body, "comments": comments, "project": project, "approval_id": approval_id });
            ("review.submit", params)
        }
        "merge" => {
            let params = json!({
                "number": number()?,
                "method": needed("method")?,
                "head_sha": needed("head-sha")?,
                "project": project,
                "approval_id": approval_id,
            });
            ("pr.merge", params)
        }
        other => return Err(usage(format!("unknown pr subcommand {other}: create, review or merge"))),
    })
}

fn pr(args: &[String]) -> Result<(), Failure> {
    let (method, params) = pr_request(args)?;
    let done = connect()?.call(method, params)?;
    let mut out = io::stdout().lock();
    if args.iter().any(|a| a == "--json") {
        return Ok(writeln!(out, "{done}")?);
    }
    match done["url"].as_str() {
        Some(url) => Ok(writeln!(out, "{url}")?),
        None => Ok(()),
    }
}

fn events(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["topic"], &[])?;
    let topics = p.flags.get("topic").cloned().unwrap_or_else(|| vec!["sessions".to_string(), "accounts".to_string()]);
    let mut client = connect()?;
    for topic in &topics {
        client.call("subscribe", json!({ "topic": topic }))?;
    }
    let mut out = io::stdout().lock();
    while let Some(event) = client.next_event()? {
        writeln!(out, "{event}")?;
        out.flush()?;
    }
    Err(Failure::Client(client::ClientError::Closed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(all: &[&str]) -> Vec<String> {
        all.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn session_wait_takes_an_id_a_timeout_and_json() {
        let (params, json) = wait_params(&args(&["w1", "--timeout", "30", "--json"])).ok().unwrap();
        assert_eq!(params, json!({ "id": "w1", "timeout": 30 }));
        assert!(json);
        assert!(wait_params(&args(&[])).is_err());
        assert!(USAGE.contains("session wait <id>"));
    }

    #[test]
    fn ask_answer_names_the_id_and_joins_the_text() {
        let (method, params) = ask_request(&args(&["--answer", "ask-1", "the", "second", "one"])).ok().unwrap();
        assert_eq!((method, params), ("ask.answer", json!({ "id": "ask-1", "answer": "the second one" })));
        assert!(ask_request(&args(&["--answer", "ask-1"])).is_err());
        assert!(ask_request(&args(&["--answer", "ask-1", "--wait", "ask-2", "x"])).is_err());
        let (method, _) = ask_request(&args(&["which", "one?", "--option", "a"])).ok().unwrap();
        assert_eq!(method, "ask.create");
        assert!(USAGE.contains("ask --answer <id>"));
    }

    #[test]
    fn ask_carries_an_approval_draft_as_json() {
        let (method, params) = ask_request(&args(&["open", "it?", "--approval", r#"{"action":"pr.merge","number":7}"#])).ok().unwrap();
        assert_eq!(method, "ask.create");
        assert_eq!(params["approval"], json!({ "action": "pr.merge", "number": 7 }));
        assert!(ask_request(&args(&["q", "--approval", "{not json"])).is_err());
        assert!(ask_request(&args(&["--wait", "ask-1", "--approval", "{}"])).is_err());
    }

    #[test]
    fn pr_commands_map_onto_the_outward_methods() {
        let (method, params) =
            pr_request(&args(&["create", "--head", "1-x", "--base", "main", "--title", "T", "--approval", "appr-1"])).ok().unwrap();
        assert_eq!(method, "pr.create");
        assert_eq!((params["head"].clone(), params["body"].clone(), params["draft"].clone()), (json!("1-x"), json!(""), json!(false)));
        assert_eq!(params["approval_id"], json!("appr-1"));
        assert!(pr_request(&args(&["create", "--head", "1-x"])).is_err(), "base and title are required");

        let (method, params) = pr_request(&args(&["review", "12", "--event", "request-changes", "--body", "no"])).ok().unwrap();
        assert_eq!((method, params["number"].clone(), params["event"].clone()), ("review.submit", json!(12), json!("requestChanges")));
        assert!(pr_request(&args(&["review", "12", "--event", "maybe"])).is_err());

        let (method, params) = pr_request(&args(&["merge", "12", "--method", "squash", "--head-sha", "abc"])).ok().unwrap();
        assert_eq!((method, params["head_sha"].clone()), ("pr.merge", json!("abc")));
        assert!(pr_request(&args(&["merge", "12", "--method", "squash"])).is_err(), "a merge pins its head");
        assert!(pr_request(&args(&["close", "12"])).is_err());
        assert!(USAGE.contains("tori pr merge <number>"));
    }

    #[test]
    fn checkpoint_diff_takes_an_optional_last_turn() {
        assert_eq!(diff_params(&args(&["s1", "2"])).ok(), Some(json!({ "id": "s1", "turn": 2, "to": null })));
        assert_eq!(diff_params(&args(&["s1", "2", "4"])).ok(), Some(json!({ "id": "s1", "turn": 2, "to": 4 })));
        assert!(diff_params(&args(&["s1", "2", "x"])).is_err());
        assert!(diff_params(&args(&["s1", "2", "3", "4"])).is_err());
    }

    #[test]
    fn a_refused_range_prints_the_sockets_reason() {
        let refused = crate::rpc::frame::RpcError::new(crate::rpc::frame::INVALID_PARAMS, "to 2 is before turn 3");
        let printed = Failure::Client(client::ClientError::Rpc(refused)).to_string();
        assert!(printed.contains("to 2 is before turn 3"), "{printed}");
    }

    #[test]
    fn whoami_names_the_callers_kind() {
        let worker = json!({
            "caller": { "kind": "chat", "id": "s2" },
            "kind": "worker",
            "identity": { "agent": "codex", "cwd": "/p/wt" },
        });
        assert_eq!(render_whoami(&worker), "worker s2\nagent: codex\ncwd: /p/wt\n");
        assert_eq!(render_whoami(&json!({ "caller": null, "kind": "local", "identity": {} })), "outside caller\n");
    }
}
