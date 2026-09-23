//! `tori <command>`: the CLI front on the app socket, run from the same binary
//! as the app and before any Tauri init. See [[adr_one_protocol_several_fronts]].

use std::collections::HashMap;
use std::io::{self, Write};

use serde_json::{json, Value};

use crate::rpc::client::{self, Client, Found};

const COMMANDS: [&str; 4] = ["sessions", "session", "events", "whoami"];

const USAGE: &str = "usage:
  tori sessions [--live] [--cwd <path>] [--limit <n>] [--json]
  tori session tail <id> [--lines <n>] [--agent <id>] [--json]
  tori events [--topic <topic>]...
  tori whoami [--json]";

pub fn is_cli() -> bool {
    std::env::args().nth(1).is_some_and(|arg| COMMANDS.contains(&arg.as_str()))
}

pub fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match dispatch(&args) {
        Ok(()) => 0,
        // A reader that went away (`tori events | head`) is a normal end.
        Err(Failure::Io(e)) if e.kind() == io::ErrorKind::BrokenPipe => 0,
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
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Usage(message) => write!(f, "{message}\n{USAGE}"),
            Failure::Client(e) => write!(f, "{e}"),
            Failure::Io(e) => write!(f, "{e}"),
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
            _ => Err(usage("session needs a subcommand: tail")),
        },
        "events" => events(rest),
        "whoami" => whoami(rest),
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

fn whoami(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &[], &["json"])?;
    let me = connect()?.call("caller", Value::Null)?;
    let mut out = io::stdout().lock();
    if p.has("json") {
        return Ok(writeln!(out, "{me}")?);
    }
    let caller = &me["caller"];
    let who = match caller["kind"].as_str() {
        Some(kind) => format!("{kind} {}", caller["id"].as_str().unwrap_or("")),
        None => "outside caller".to_string(),
    };
    writeln!(out, "{who}")?;
    for key in ["agent", "account", "cwd"] {
        if let Some(value) = me["identity"][key].as_str() {
            writeln!(out, "{key}: {value}")?;
        }
    }
    Ok(())
}

fn events(args: &[String]) -> Result<(), Failure> {
    let p = Parsed::new(args, &["topic"], &[])?;
    let topics = p.flags.get("topic").cloned().unwrap_or_else(|| vec!["sessions".to_string()]);
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

