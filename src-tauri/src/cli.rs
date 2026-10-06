//! `tori <command>`: the CLI front on the app socket, run from the same binary
//! as the app and before any Tauri init. See [[adr_one_protocol_several_fronts]].

use std::collections::HashMap;
use std::io::{self, Write};

use serde_json::{json, Value};

use crate::rpc::client::{self, Client, Found};

const COMMANDS: [&str; 17] = [
    "sessions",
    "projects",
    "session",
    "events",
    "whoami",
    "steer",
    "interrupt",
    "worktree",
    "checkpoints",
    "checkpoint",
    "spawn",
    "open",
    "budget",
    "ask",
    "pr",
    "autopilot",
    "mcp",
];

const USAGE: &str = "usage:
  tori sessions [--live] [--cwd <path>] [--limit <n>] [--json]
  tori projects [--json]
  tori session tail <id> [--lines <n>] [--agent <id>] [--json]
  tori session wait <id> [--timeout <secs>] [--json]
  tori session pending <id> [--json]
  tori session answer <session> <id> <text>...
  tori session answer <session> <id> --each <text>...
  tori events [--topic <topic>]...
  tori whoami [--json]
  tori steer <id> <text>...
  tori interrupt <id>
  tori worktree new <branch> [--project <path>] [--from <ref>]
  tori checkpoints <id> [--json]
  tori checkpoint diff <id> <n> [<m>]
  tori checkpoint revert <id> <n> [--force]
  tori spawn [--agent <id>] [--account <id>] [--model <id>] [--mode <id>] [--effort <level>] [--folder <path> | --new-worktree <branch> [--project <path>] [--from <ref>]]
             [--prompt <text>] [--attach <path>]... [--background] [--json]
  tori open <path> [--line <n>]
  tori budget [<id>] [--folder <path>] [--json]
  tori ask <question>... [--option <text>]... [--timeout <secs>] [--approval <json> [--project <path>]]
  tori ask --wait <id> [--timeout <secs>]
  tori ask --answer <id> <text>...
  tori pr create --head <branch> --head-sha <sha> --base <branch> --title <text> [--body <text>] [--draft] [--project <path>] [--approval <id>] [--json]
  tori pr review <number> --event approve|comment|request-changes --head-sha <sha> [--body <text>] [--comments <json>] [--project <path>] [--approval <id>]
  tori pr merge <number> --method merge|squash|rebase --head-sha <sha> [--project <path>] [--approval <id>]
  tori autopilot state [--json]
  tori autopilot start|stop [--json]
  tori autopilot item [<id>] [--kind ship|review --issue <key> | --pr <number> --repo <owner/name>] [--project <path>]
                      [--state <state>] [--worktree <path>] [--session <id>] [--pr-url <url>] [--note <text>]
                      [--title <text>] [--contract <text>] [--json]
  tori autopilot project [--project <path>] [--ships pr|local] [--autonomy ask-everything|auto-until-outward]
                         [--pickup ask|auto] [--agent <id>] [--account <id>] [--model <id>] [--json]
  tori autopilot hold resolve <id> [--json]
  tori mcp";

pub fn is_cli() -> bool {
    std::env::args()
        .nth(1)
        .is_some_and(|arg| COMMANDS.contains(&arg.as_str()))
}

pub fn print_usage() -> i32 {
    eprintln!("{USAGE}");
    2
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
        "projects" => projects(rest),
        "session" => match rest.first().map(String::as_str) {
            Some("tail") => session_tail(&rest[1..]),
            Some("wait") => session_wait(&rest[1..]),
            Some("pending") => session_pending(&rest[1..]),
            Some("answer") => session_answer(&rest[1..]),
            _ => Err(usage("session needs a subcommand: tail, wait, pending or answer")),
        },
        "events" => events(rest),
        "whoami" => whoami(rest),
        "steer" => steer(rest),
        "interrupt" => interrupt(rest),
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
        "autopilot" => autopilot(rest),
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
        let mut parsed = Parsed {
            positional: Vec::new(),
            flags: HashMap::new(),
        };
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
            .map(|v| {
                v.parse()
                    .map_err(|_| usage(format!("--{name} takes a number, got {v}")))
            })
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
        Err(client::ClientError::Io(e))
            if endpoint.found == Found::File && e.kind() == io::ErrorKind::ConnectionRefused =>
        {
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
    write_table(
        &mut out,
        ["ID", "AGENT", "ACCOUNT", "STATE", "BRANCH", "FOLDER", "TITLE"],
        &table,
    )
}

fn projects(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &[], &["json"])?;
    let tree = connect()?.call("projects.list", json!({}))?;
    let mut out = io::stdout().lock();
    if p.has("json") {
        return Ok(writeln!(out, "{tree}")?);
    }
    for line in project_lines(&tree) {
        writeln!(out, "{line}")?;
    }
    Ok(())
}

fn project_lines(tree: &Value) -> Vec<String> {
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let list = |v: &Value, key: &str| v.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let join = |cells: Vec<String>| {
        cells
            .into_iter()
            .filter(|c| !c.is_empty())
            .collect::<Vec<_>>()
            .join("  ")
    };
    let mut lines = Vec::new();
    for space in list(tree, "spaces") {
        lines.push(join(vec![
            "space".into(),
            text(&space, "name"),
            home_relative(&text(&space, "path")),
        ]));
        for project in list(&space, "projects") {
            lines.push(format!(
                "  {}",
                join(vec![text(&project, "name"), home_relative(&text(&project, "path"))])
            ));
            for unit in list(&project, "units") {
                let current = if unit["isCurrent"] == true {
                    "current".to_string()
                } else {
                    String::new()
                };
                let cells = vec![text(&unit, "label"), text(&unit, "kind"), current, text(&unit, "issue")];
                lines.push(format!("    {}", join(cells)));
            }
        }
    }
    for topic in list(tree, "topics") {
        lines.push(join(vec!["topic".into(), text(&topic, "name"), text(&topic, "branch")]));
        for member in list(&topic, "members") {
            let at = member.get("worktreePath").and_then(Value::as_str).unwrap_or("");
            let cells = vec![
                text(&member, "displayName"),
                home_relative(at),
                text(&member["state"], "kind"),
            ];
            lines.push(format!("  {}", join(cells)));
        }
    }
    lines
}

fn write_table<const N: usize>(out: &mut impl Write, header: [&str; N], table: &[[String; N]]) -> Result<(), Failure> {
    let header = header.map(String::from);
    let mut widths = header.clone().map(|h| h.len());
    for row in table {
        for (w, cell) in widths.iter_mut().zip(row) {
            *w = (*w).max(cell.chars().count());
        }
    }
    for row in std::iter::once(&header).chain(table) {
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
    let title = row
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| text("title"));
    [
        text("id"),
        text("agent"),
        account,
        state,
        text("branch"),
        home_relative(&text("cwd")),
        clip(&title, 60),
    ]
}

fn home_relative(path: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return path.to_string();
    };
    let (path, home) = (
        crate::platform::fs::normalize(path),
        crate::platform::fs::display(&home),
    );
    match path.strip_prefix(&home) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => path,
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
    let limit = if json {
        lines
    } else {
        lines.map(|n| n.saturating_mul(20))
    };
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
                lines.push(
                    format!("  [{}] {}", field("name").unwrap_or("tool"), clip(what, 100))
                        .trim_end()
                        .to_string(),
                );
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
        writeln!(
            out,
            "asking {}: {question}",
            settled["question"]["id"].as_str().unwrap_or("")
        )?;
    }
    if let Some(last) = settled["last"].as_str() {
        writeln!(out, "{last}")?;
    }
    Ok(())
}

fn session_pending(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &[], &["json"])?;
    let [id] = p.positional.as_slice() else {
        return Err(usage("session pending takes one session id"));
    };
    let rows = connect()?.call("session.pending", json!({ "id": id }))?;
    let mut out = io::stdout().lock();
    if p.has("json") {
        return Ok(writeln!(out, "{rows}")?);
    }
    for row in rows.as_array().into_iter().flatten() {
        let text = match row["kind"].as_str() {
            Some("permission") => format!(
                "{} {}",
                row["tool"].as_str().unwrap_or(""),
                row["detail"].as_str().unwrap_or("")
            ),
            Some("question") => {
                let questions = row["questions"].as_array().into_iter().flatten();
                questions
                    .filter_map(|q| q["question"].as_str())
                    .collect::<Vec<_>>()
                    .join(" | ")
            }
            _ => row["text"].as_str().unwrap_or("").to_string(),
        };
        writeln!(
            out,
            "{} {}: {}",
            row["kind"].as_str().unwrap_or(""),
            row["id"].as_str().unwrap_or(""),
            text.trim_end()
        )?;
    }
    Ok(())
}

fn answer_params(args: &[String]) -> Result<Value, Failure> {
    let p = Parsed::new(args, &["each"], &[])?;
    let [session, id, words @ ..] = p.positional.as_slice() else {
        return Err(usage(
            "session answer takes a session id, the id to answer and the answer",
        ));
    };
    let answer = match (p.flags.get("each"), words) {
        (Some(each), []) => json!(each),
        (None, words) if !words.is_empty() => json!(words.join(" ")),
        _ => {
            return Err(usage(
                "session answer takes the answer as words or as --each, one per question, not both",
            ))
        }
    };
    Ok(json!({ "session": session, "id": id, "answer": answer }))
}

fn session_answer(args: &[String]) -> Result<(), Failure> {
    let params = answer_params(args)?;
    connect()?.call("session.answer", params)?;
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

fn interrupt_params(args: &[String]) -> Result<Value, Failure> {
    match args {
        [id] => Ok(json!({ "id": id })),
        _ => Err(usage("interrupt takes one session id")),
    }
}

fn interrupt(args: &[String]) -> Result<(), Failure> {
    let params = interrupt_params(args)?;
    connect()?.call("session.interrupt", params.clone())?;
    Ok(writeln!(
        io::stdout().lock(),
        "interrupted: {}",
        params["id"].as_str().unwrap_or_default()
    )?)
}

fn worktree_new(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["project", "from"], &[])?;
    let [branch] = p.positional.as_slice() else {
        return Err(usage("worktree new takes one branch name"));
    };
    let project = p.value("project").map(absolute).transpose()?;
    let made = connect()?.call(
        "worktree.new",
        json!({ "branch": branch, "project": project, "from": p.value("from") }),
    )?;
    // On stderr, so a script reading the path from stdout reads only the path.
    if let Some(setup) = made["setup"].as_str().filter(|s| *s != "none") {
        let log = made["setup_log"]
            .as_str()
            .map(|log| format!(", log {log}"))
            .unwrap_or_default();
        writeln!(io::stderr().lock(), "setup {setup}{log}")?;
    }
    Ok(writeln!(
        io::stdout().lock(),
        "{}",
        made["path"].as_str().unwrap_or("")
    )?)
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
        writeln!(
            out,
            "{:>3}  {}  {files} {noun}",
            number("turn"),
            row["kind"].as_str().unwrap_or("")
        )?;
    }
    Ok(())
}

fn checkpoint_turn(args: &[String], switches: &[&str]) -> Result<Value, Failure> {
    let p = Parsed::new(args, &[], switches)?;
    let [id, turn] = p.positional.as_slice() else {
        return Err(usage("takes a session id and a turn number from tori checkpoints"));
    };
    let turn: usize = turn
        .parse()
        .map_err(|_| usage(format!("turn must be a number, got {turn}")))?;
    Ok(json!({ "id": id, "turn": turn, "force": p.has("force").then_some(true) }))
}

fn diff_params(args: &[String]) -> Result<Value, Failure> {
    let p = Parsed::new(args, &[], &[])?;
    let (id, turn, to) = match p.positional.as_slice() {
        [id, turn] => (id, turn, None),
        [id, turn, to] => (id, turn, Some(to)),
        _ => {
            return Err(usage(
                "takes a session id, a turn number from tori checkpoints and an optional last turn",
            ))
        }
    };
    let number = |v: &String| {
        v.parse::<usize>()
            .map_err(|_| usage(format!("turn must be a number, got {v}")))
    };
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
    let valued = [
        "agent",
        "account",
        "model",
        "mode",
        "effort",
        "folder",
        "new-worktree",
        "project",
        "from",
        "prompt",
        "attach",
    ];
    let p = Parsed::new(args, &valued, &["background", "json"])?;
    if !p.positional.is_empty() {
        return Err(usage(
            "spawn takes no positional arguments: pass the prompt with --prompt",
        ));
    }
    if p.has("folder") && p.has("new-worktree") {
        return Err(usage("pass --folder or --new-worktree, not both"));
    }
    let path = |name| p.value(name).map(absolute).transpose();
    let attach = p
        .flags
        .get("attach")
        .into_iter()
        .flatten()
        .map(|a| absolute(a))
        .collect::<Result<Vec<_>, _>>()?;
    let params = json!({
        "agent": p.value("agent"),
        "account": p.value("account"),
        "model": p.value("model"),
        "mode": p.value("mode"),
        "effort": p.value("effort"),
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
    connect()?.call(
        "window.open",
        json!({ "path": absolute(path)?, "line": p.number("line")? }),
    )?;
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
    let ceiling = |v: &Value| {
        v.as_f64()
            .map_or("no budget".to_string(), |usd| format!("of ${usd:.2}"))
    };
    let budgets = &figures["budgets"];
    if let Some(session) = figures["session"].as_object() {
        let spent = dollars(&session["costUsd"]);
        let id = figures["id"].as_str().unwrap_or("");
        writeln!(out, "session  {spent} {}  {id}", ceiling(&budgets["sessionUsd"]))?;
    }
    let spent = dollars(&figures["project"]["costUsd"]);
    writeln!(
        out,
        "project  {spent} {}  {}",
        ceiling(&budgets["projectUsd"]),
        figures["folder"].as_str().unwrap_or("")
    )?;
    for window in figures["quota"].as_array().into_iter().flatten() {
        let used = window["utilization"]
            .as_f64()
            .map_or("?".to_string(), |u| format!("{:.0}%", u * 100.0));
        let kind = window["kind"].as_str().unwrap_or("");
        writeln!(out, "{kind}  {used}  {}", window["state"].as_str().unwrap_or(""))?;
    }
    Ok(())
}

fn ask_request(args: &[String]) -> Result<(&'static str, Value), Failure> {
    let p = Parsed::new(
        args,
        &["option", "timeout", "wait", "answer", "approval", "project"],
        &[],
    )?;
    if (p.has("approval") || p.has("project")) && (p.has("wait") || p.has("answer")) {
        return Err(usage(
            "--approval and --project go with a question, not --wait or --answer",
        ));
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
            (
                "ask.create",
                json!({ "question": question, "options": options, "timeout": timeout, "approval": approval, "project": project }),
            )
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
    let valued = [
        "head", "base", "title", "body", "event", "comments", "method", "head-sha", "project", "approval",
    ];
    let p = Parsed::new(rest, &valued, &["draft", "json"])?;
    let project = p.value("project").map(absolute).transpose()?;
    let approval_id = p.value("approval");
    let number = || match p.positional.as_slice() {
        [n] => n
            .parse::<u64>()
            .map_err(|_| usage(format!("the pull request number must be a number, got {n}"))),
        _ => Err(usage(format!("pr {sub} takes one pull request number"))),
    };
    let needed = |name: &str| p.value(name).ok_or_else(|| usage(format!("pr {sub} needs --{name}")));
    Ok(match sub.as_str() {
        "create" if p.positional.is_empty() => (
            "pr.create",
            json!({
                "head": needed("head")?,
                "head_sha": needed("head-sha")?,
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
                other => {
                    return Err(usage(format!(
                        "--event is approve, comment or request-changes, got {other}"
                    )))
                }
            };
            let comments = p.value("comments").map(json_flag("comments")).transpose()?;
            let body = p.value("body").unwrap_or("");
            let params = json!({
                "number": number()?,
                "event": event,
                "head_sha": needed("head-sha")?,
                "body": body,
                "comments": comments,
                "project": project,
                "approval_id": approval_id,
            });
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

fn autopilot_request(args: &[String]) -> Result<(&'static str, Value), Failure> {
    let Some((sub, rest)) = args.split_first() else {
        return Err(usage(
            "autopilot needs a subcommand: state, start, stop, item, project or hold",
        ));
    };
    match sub.as_str() {
        "state" => {
            let p = Parsed::new(rest, &[], &["json"])?;
            if !p.positional.is_empty() {
                return Err(usage("autopilot state takes no arguments"));
            }
            Ok(("autopilot.state", json!({})))
        }
        "start" | "stop" => {
            let p = Parsed::new(rest, &[], &["json"])?;
            if !p.positional.is_empty() {
                return Err(usage(format!("autopilot {sub} takes no arguments")));
            }
            Ok((
                if sub == "start" {
                    "autopilot.start"
                } else {
                    "autopilot.stop"
                },
                json!({}),
            ))
        }
        "item" => {
            let valued = [
                "kind", "issue", "pr", "repo", "project", "state", "worktree", "session", "pr-url", "note", "title",
                "contract",
            ];
            let p = Parsed::new(rest, &valued, &["json"])?;
            let id = match p.positional.as_slice() {
                [] => None,
                [id] => Some(id),
                _ => return Err(usage("autopilot item takes at most one item id")),
            };
            let project = p.value("project").map(absolute).transpose()?;
            let source = match (p.value("issue"), p.value("pr"), p.value("repo")) {
                (None, None, None) => None,
                (Some(key), None, None) => {
                    let project = project
                        .as_ref()
                        .ok_or_else(|| usage("--issue needs --project, the project the issue is in"))?;
                    Some(json!({ "type": "issue", "key": key, "project": project }))
                }
                (None, Some(number), Some(repo)) => {
                    let number: u64 = number
                        .parse()
                        .map_err(|_| usage(format!("--pr takes a pull request number, got {number}")))?;
                    Some(json!({ "type": "pr", "number": number, "repo": repo }))
                }
                (None, Some(_), None) => return Err(usage("--pr needs --repo <owner/name>")),
                _ => return Err(usage("pass --issue <key>, or --pr <number> with --repo <owner/name>")),
            };
            let params = json!({
                "id": id,
                "kind": p.value("kind"),
                "source": source,
                "project": project,
                "state": p.value("state").map(|s| s.replace('-', "_")),
                "worktree": p.value("worktree").map(absolute).transpose()?,
                "session": p.value("session"),
                "pr_url": p.value("pr-url"),
                "note": p.value("note"),
                "title": p.value("title"),
                "contract": p.value("contract"),
            });
            Ok(("autopilot.item.update", params))
        }
        "project" => {
            let valued = ["project", "ships", "autonomy", "pickup", "agent", "account", "model"];
            let p = Parsed::new(rest, &valued, &["json"])?;
            if !p.positional.is_empty() {
                return Err(usage(
                    "autopilot project takes only flags: name the project with --project",
                ));
            }
            let choice = |name: &str| p.value(name).map(|v| v.replace('-', "_"));
            let params = json!({
                "project": p.value("project").map(absolute).transpose()?,
                "ships": choice("ships"),
                "autonomy": choice("autonomy"),
                "pickup": choice("pickup"),
                "agent": p.value("agent"),
                "account": p.value("account"),
                "model": p.value("model"),
            });
            Ok(("autopilot.project.set", params))
        }
        "hold" => {
            let p = Parsed::new(rest, &[], &["json"])?;
            match p.positional.as_slice() {
                [verb, id] if verb == "resolve" => Ok(("autopilot.hold.resolve", json!({ "id": id }))),
                _ => Err(usage("autopilot hold takes: resolve <id>")),
            }
        }
        other => Err(usage(format!(
            "unknown autopilot subcommand {other}: state, start, stop, item, project or hold"
        ))),
    }
}

fn runner_line(runner: &Value) -> String {
    let state = runner["state"].as_str().unwrap_or("off");
    match (runner["session"].as_str(), runner["error"]["title"].as_str()) {
        (_, Some(title)) => format!("{state}: {title}"),
        (Some(session), None) => format!("{state} {session}"),
        (None, None) => state.to_string(),
    }
}

fn autopilot(args: &[String]) -> Result<(), Failure> {
    let (method, params) = autopilot_request(args)?;
    let done = connect()?.call(method, params)?;
    let mut out = io::stdout().lock();
    if args.iter().any(|a| a == "--json") {
        return Ok(writeln!(out, "{done}")?);
    }
    match method {
        "autopilot.item.update" => return Ok(writeln!(out, "{}", done["id"].as_str().unwrap_or(""))?),
        "autopilot.project.set" => return Ok(write!(out, "{}", render_contract(&done))?),
        "autopilot.hold.resolve" => return Ok(writeln!(out, "withdrawn: {}", done["id"].as_str().unwrap_or(""))?),
        "autopilot.start" | "autopilot.stop" => return Ok(writeln!(out, "{}", runner_line(&done))?),
        _ => {}
    }
    writeln!(out, "autopilot: {}", runner_line(&done["runner"]))?;
    let table: Vec<[String; 6]> = done["items"].as_array().into_iter().flatten().map(item_cells).collect();
    write_table(&mut out, ["ID", "KIND", "STATE", "SOURCE", "SESSION", "NOTE"], &table)?;
    let projects = done["projects"].as_object().cloned().unwrap_or_default();
    if !projects.is_empty() {
        let table: Vec<[String; 5]> = projects
            .iter()
            .map(|(path, contract)| project_cells(path, contract))
            .collect();
        writeln!(out)?;
        write_table(&mut out, ["PROJECT", "SHIPS", "AUTONOMY", "PICKUP", "AGENT"], &table)?;
    }
    let holds = done["holds"].as_array().cloned().unwrap_or_default();
    if !holds.is_empty() {
        let table: Vec<[String; 4]> = holds.iter().map(hold_cells).collect();
        writeln!(out)?;
        write_table(&mut out, ["HOLD", "ITEM", "ACTION", "ANSWER"], &table)?;
    }
    Ok(())
}

fn hold_cells(hold: &Value) -> [String; 4] {
    let text = |key: &str| hold[key].as_str().unwrap_or("").to_string();
    let answer = hold["answer"].as_str().unwrap_or("waiting").to_string();
    [
        text("ask"),
        text("item"),
        hold["draft"]["action"].as_str().unwrap_or("").to_string(),
        answer,
    ]
}

fn render_contract(contract: &Value) -> String {
    let mut text = String::new();
    for key in ["ships", "autonomy", "pickup", "agent", "account", "model"] {
        if let Some(value) = contract[key].as_str() {
            text.push_str(&format!("{key}: {}\n", value.replace('_', " ")));
        }
    }
    text
}

fn project_cells(path: &str, contract: &Value) -> [String; 5] {
    let text = |key: &str| contract[key].as_str().unwrap_or("").replace('_', " ");
    let agent = match (contract["agent"].as_str(), contract["model"].as_str()) {
        (Some(agent), Some(model)) => format!("{agent} {model}"),
        (agent, model) => agent.or(model).unwrap_or("").to_string(),
    };
    [
        home_relative(path),
        text("ships"),
        text("autonomy"),
        text("pickup"),
        agent,
    ]
}

fn item_cells(row: &Value) -> [String; 6] {
    let text = |key: &str| row[key].as_str().unwrap_or("").to_string();
    let source = &row["source"];
    let source = match source["type"].as_str() {
        Some("issue") => format!("issue {}", source["key"].as_str().unwrap_or("")),
        Some("pr") => format!("{}#{}", source["repo"].as_str().unwrap_or(""), source["number"]),
        _ => String::new(),
    };
    let session = match row["session_live"].as_bool() {
        Some(true) => "live",
        Some(false) => "ended",
        None => "",
    };
    let state = match row["worktree_gone"].as_bool() {
        Some(true) => format!("{} (worktree gone)", text("state").replace('_', " ")),
        _ => text("state").replace('_', " "),
    };
    [
        text("id"),
        text("kind"),
        state,
        source,
        session.to_string(),
        clip(&text("note"), 60),
    ]
}

fn events(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["topic"], &[])?;
    let topics = p
        .flags
        .get("topic")
        .cloned()
        .unwrap_or_else(|| vec!["sessions".to_string(), "accounts".to_string()]);
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
        let (method, params) = ask_request(&args(&["--answer", "ask-1", "the", "second", "one"]))
            .ok()
            .unwrap();
        assert_eq!(
            (method, params),
            ("ask.answer", json!({ "id": "ask-1", "answer": "the second one" }))
        );
        assert!(ask_request(&args(&["--answer", "ask-1"])).is_err());
        assert!(ask_request(&args(&["--answer", "ask-1", "--wait", "ask-2", "x"])).is_err());
        let (method, _) = ask_request(&args(&["which", "one?", "--option", "a"])).ok().unwrap();
        assert_eq!(method, "ask.create");
        assert!(USAGE.contains("ask --answer <id>"));
    }

    #[test]
    fn ask_carries_an_approval_draft_as_json() {
        let (method, params) = ask_request(&args(&[
            "open",
            "it?",
            "--approval",
            r#"{"action":"pr.merge","number":7}"#,
        ]))
        .ok()
        .unwrap();
        assert_eq!(method, "ask.create");
        assert_eq!(params["approval"], json!({ "action": "pr.merge", "number": 7 }));
        assert!(ask_request(&args(&["q", "--approval", "{not json"])).is_err());
        assert!(ask_request(&args(&["--wait", "ask-1", "--approval", "{}"])).is_err());
    }

    #[test]
    fn pr_commands_map_onto_the_outward_methods() {
        let (method, params) = pr_request(&args(&[
            "create",
            "--head",
            "1-x",
            "--head-sha",
            "abc",
            "--base",
            "main",
            "--title",
            "T",
            "--approval",
            "appr-1",
        ]))
        .ok()
        .unwrap();
        assert_eq!(method, "pr.create");
        assert_eq!(
            (params["head"].clone(), params["body"].clone(), params["draft"].clone()),
            (json!("1-x"), json!(""), json!(false))
        );
        assert_eq!(params["approval_id"], json!("appr-1"));
        assert!(
            pr_request(&args(&["create", "--head", "1-x"])).is_err(),
            "base and title are required"
        );

        let (method, params) = pr_request(&args(&[
            "review",
            "12",
            "--event",
            "request-changes",
            "--head-sha",
            "abc",
            "--body",
            "no",
        ]))
        .ok()
        .unwrap();
        assert_eq!(
            (method, params["number"].clone(), params["event"].clone()),
            ("review.submit", json!(12), json!("requestChanges"))
        );
        assert!(pr_request(&args(&["review", "12", "--event", "maybe"])).is_err());

        let (method, params) = pr_request(&args(&["merge", "12", "--method", "squash", "--head-sha", "abc"]))
            .ok()
            .unwrap();
        assert_eq!((method, params["head_sha"].clone()), ("pr.merge", json!("abc")));
        assert!(
            pr_request(&args(&["merge", "12", "--method", "squash"])).is_err(),
            "a merge pins its head"
        );
        assert!(pr_request(&args(&["close", "12"])).is_err());
        assert!(USAGE.contains("tori pr merge <number>"));
    }

    #[test]
    fn autopilot_commands_map_onto_the_autopilot_methods() {
        assert_eq!(
            autopilot_request(&args(&["state", "--json"])).ok(),
            Some(("autopilot.state", json!({})))
        );
        assert!(autopilot_request(&args(&["state", "x"])).is_err());

        let (method, params) = autopilot_request(&args(&[
            "item",
            "--kind",
            "review",
            "--pr",
            "7",
            "--repo",
            "o/r",
            "--project",
            "/p",
            "--state",
            "waiting-on-you",
        ]))
        .ok()
        .unwrap();
        assert_eq!(method, "autopilot.item.update");
        assert_eq!(params["source"], json!({ "type": "pr", "number": 7, "repo": "o/r" }));
        assert_eq!(
            (params["id"].clone(), params["state"].clone()),
            (json!(null), json!("waiting_on_you"))
        );

        let (_, params) = autopilot_request(&args(&["item", "--kind", "ship", "--issue", "12", "--project", "/p"]))
            .ok()
            .unwrap();
        assert_eq!(
            params["source"],
            json!({ "type": "issue", "key": "12", "project": "/p" })
        );
        assert!(
            autopilot_request(&args(&["item", "--issue", "12"])).is_err(),
            "an issue source names its project"
        );
        assert!(
            autopilot_request(&args(&["item", "--pr", "7"])).is_err(),
            "a pull request source names its repo"
        );
        assert!(autopilot_request(&args(&["item", "--pr", "x", "--repo", "o/r"])).is_err());

        let (_, params) = autopilot_request(&args(&["item", "item-1", "--note", "blocked on CI"]))
            .ok()
            .unwrap();
        assert_eq!(
            (params["id"].clone(), params["note"].clone()),
            (json!("item-1"), json!("blocked on CI"))
        );
        assert!(autopilot_request(&args(&["item", "a", "b"])).is_err());
        assert!(autopilot_request(&args(&["hold"])).is_err());

        let (method, params) = autopilot_request(&args(&[
            "project",
            "--project",
            "/p",
            "--autonomy",
            "auto-until-outward",
            "--model",
            "opus",
        ]))
        .ok()
        .unwrap();
        assert_eq!(method, "autopilot.project.set");
        assert_eq!(params["autonomy"], json!("auto_until_outward"));
        assert_eq!(
            (params["project"].clone(), params["ships"].clone()),
            (json!("/p"), json!(null)),
            "a flag left out keeps its value"
        );
        assert!(autopilot_request(&args(&["project", "/p"])).is_err());
        assert!(USAGE.contains("tori autopilot project"));

        assert_eq!(
            autopilot_request(&args(&["hold", "resolve", "ask-1"])).ok(),
            Some(("autopilot.hold.resolve", json!({ "id": "ask-1" })))
        );
        assert!(
            autopilot_request(&args(&["hold", "approve", "ask-1"])).is_err(),
            "a hold is approved on its card, never here"
        );
        assert!(autopilot_request(&args(&["hold", "resolve"])).is_err());
        assert!(USAGE.contains("tori autopilot hold resolve <id>"));
        assert!(USAGE.contains("tori autopilot state"));
    }

    #[test]
    fn a_state_row_says_when_its_session_ended_or_its_worktree_is_gone() {
        let row = json!({
            "id": "item-1", "kind": "ship", "state": "running", "source": { "type": "pr", "number": 7, "repo": "o/r" },
            "session_live": false, "worktree_gone": true, "note": null,
        });
        assert_eq!(
            item_cells(&row),
            ["item-1", "ship", "running (worktree gone)", "o/r#7", "ended", ""].map(String::from)
        );
    }

    #[test]
    fn checkpoint_diff_takes_an_optional_last_turn() {
        assert_eq!(
            diff_params(&args(&["s1", "2"])).ok(),
            Some(json!({ "id": "s1", "turn": 2, "to": null }))
        );
        assert_eq!(
            diff_params(&args(&["s1", "2", "4"])).ok(),
            Some(json!({ "id": "s1", "turn": 2, "to": 4 }))
        );
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
    fn projects_print_the_tree_in_the_order_it_came() {
        let tree = json!({
            "spaces": [{ "name": "work", "path": "/w", "projects": [{ "name": "repo", "path": "/w/repo", "units": [
                { "label": "main", "kind": "plain", "isCurrent": true, "issue": "ABC-1" },
                { "label": "feat", "kind": "plain", "isCurrent": false, "issue": null },
            ]}]}],
            "topics": [{ "name": "auth", "branch": "auth", "members": [
                { "displayName": "repo", "worktreePath": "/w/repo/.tori/worktrees/auth", "state": { "kind": "present" } },
            ]}],
        });
        assert_eq!(
            project_lines(&tree),
            [
                "space  work  /w",
                "  repo  /w/repo",
                "    main  plain  current  ABC-1",
                "    feat  plain",
                "topic  auth  auth",
                "  repo  /w/repo/.tori/worktrees/auth  present",
            ]
        );
    }

    #[test]
    fn interrupt_takes_exactly_one_session_id() {
        assert!(matches!(interrupt_params(&args(&["s1"])), Ok(v) if v == json!({ "id": "s1" })));
        assert!(matches!(interrupt_params(&args(&[])), Err(Failure::Usage(_))));
        assert!(matches!(interrupt_params(&args(&["s1", "s2"])), Err(Failure::Usage(_))));
    }

    #[test]
    fn whoami_names_the_callers_kind() {
        let worker = json!({
            "caller": { "kind": "chat", "id": "s2" },
            "kind": "worker",
            "identity": { "agent": "codex", "cwd": "/p/wt" },
        });
        assert_eq!(render_whoami(&worker), "worker s2\nagent: codex\ncwd: /p/wt\n");
        assert_eq!(
            render_whoami(&json!({ "caller": null, "kind": "local", "identity": {} })),
            "outside caller\n"
        );
    }
}
