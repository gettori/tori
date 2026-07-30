// opencode's session-storage backend: one shared SQLite DB
// (`~/.local/share/opencode/opencode.db`, WAL mode) covering every project
// on the machine, not a per-session file. Opened strictly read-only - Sway
// never writes to this DB; a delete goes through opencode's own `session
// delete` CLI instead (see `delete_session_via_cli`), never a raw SQL DELETE.
//
// Schema (captured empirically, phase 1 spike, opencode 1.18.3):
//   session(id, directory, title, time_created, time_updated, time_archived, ...)
//   message(id, session_id, time_created, time_updated, data JSON)
//     data.role = "user" | "assistant"; assistant also carries modelID, tokens.
//   part(id, message_id, session_id, time_created, data JSON)
//     data.type = "text" | "tool" | "step-start" | "step-finish"
//
// A session's transcript is `message` rows joined to their `part` rows, both
// ordered by `time_created`. Every extraction function here re-queries from
// scratch on each call (no cache) - the DB is local and fast, matching the
// existing "no cache" precedent already used for the file-backed transcript
// viewer (see `sessions::parse_transcript_turns`'s doc comment).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::sessions::{
    self, PromptTail, SessionDetail, SessionMeta, TouchAcc, TouchOp, TouchedFile, TranscriptTurn,
};

/// Locator scheme stashed in `SessionMeta.path` for an opencode session,
/// since there is no real file to point at: `opencode-sqlite:<db path>#<id>`.
const LOCATOR_PREFIX: &str = "opencode-sqlite:";

pub fn make_locator(db_path: &Path, session_id: &str) -> String {
    format!("{LOCATOR_PREFIX}{}#{session_id}", db_path.display())
}

/// Parse a locator produced by `make_locator` back into (db_path, session_id).
/// Returns `None` for any ordinary file path, which is how every other call
/// site tells an opencode session apart from a claude/pi one.
pub fn parse_locator(path: &str) -> Option<(PathBuf, &str)> {
    let rest = path.strip_prefix(LOCATOR_PREFIX)?;
    let (db, id) = rest.rsplit_once('#')?;
    Some((PathBuf::from(db), id))
}

pub fn epoch_ms_to_system_time(ms: i64) -> SystemTime {
    if ms <= 0 {
        return UNIX_EPOCH;
    }
    UNIX_EPOCH + Duration::from_millis(ms as u64)
}

fn open_ro(db_path: &Path) -> Option<Connection> {
    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

// --- discovery: list every session in the DB ---

pub struct RawSession {
    pub id: String,
    pub directory: String,
    pub title: String,
    pub time_created: i64,
    pub time_updated: i64,
}

/// Every non-archived session across every project - the caller
/// (`sessions::ensure_index`) filters by cwd the same way a file-backed
/// adapter's directory listing already narrows to one project.
pub fn list_sessions(db_path: &Path) -> Vec<RawSession> {
    let Some(conn) = open_ro(db_path) else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, directory, title, time_created, time_updated \
         FROM session WHERE time_archived IS NULL",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |row| {
        Ok(RawSession {
            id: row.get(0)?,
            directory: row.get(1)?,
            title: row.get(2)?,
            time_created: row.get(3)?,
            time_updated: row.get(4)?,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn to_session_meta(row: &RawSession, agent_id: &str, db_path: &Path) -> SessionMeta {
    let title = row.title.trim();
    SessionMeta {
        id: row.id.clone(),
        path: make_locator(db_path, &row.id),
        cwd: row.directory.clone(),
        // opencode doesn't record a git branch on the session row.
        branch: String::new(),
        title: if title.is_empty() { "(untitled session)".to_string() } else { sessions::clean_title(title) },
        last_active: (row.time_updated.max(0) / 1000) as u64,
        created_at: (row.time_created.max(0) / 1000) as u64,
        name: None,
        agent: agent_id.to_string(),
    }
}

/// `session.time_updated` as a `SystemTime`, for `touched_files_cached`'s
/// mtime-based invalidation (a sqlite locator has no real file to `stat`).
pub fn mtime_for(db_path: &Path, session_id: &str) -> SystemTime {
    let Some(conn) = open_ro(db_path) else { return UNIX_EPOCH };
    conn.query_row("SELECT time_updated FROM session WHERE id = ?1", [session_id], |r| r.get::<_, i64>(0))
        .map(epoch_ms_to_system_time)
        .unwrap_or(UNIX_EPOCH)
}

fn session_directory(conn: &Connection, session_id: &str) -> Option<String> {
    conn.query_row("SELECT directory FROM session WHERE id = ?1", [session_id], |r| r.get(0)).ok()
}

// --- shared transcript loader: message rows + their part rows, ordered ---

struct MessageRow {
    id: String,
    time_created: i64,
    data: Value,
}

struct PartRow {
    time_created: i64,
    data: Value,
}

fn load_session(conn: &Connection, session_id: &str) -> Vec<(MessageRow, Vec<PartRow>)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, time_created, data FROM message WHERE session_id = ?1 ORDER BY time_created ASC, id ASC",
    ) else {
        return Vec::new();
    };
    let messages: Vec<MessageRow> = match stmt.query_map([session_id], |r| {
        let id: String = r.get(0)?;
        let time_created: i64 = r.get(1)?;
        let raw: String = r.get(2)?;
        Ok((id, time_created, raw))
    }) {
        Ok(iter) => iter
            .filter_map(Result::ok)
            .filter_map(|(id, time_created, raw)| {
                serde_json::from_str::<Value>(&raw).ok().map(|data| MessageRow { id, time_created, data })
            })
            .collect(),
        Err(_) => return Vec::new(),
    };

    let mut parts_by_msg: HashMap<String, Vec<PartRow>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT message_id, time_created, data FROM part WHERE session_id = ?1 ORDER BY message_id ASC, id ASC",
    ) {
        if let Ok(iter) = stmt.query_map([session_id], |r| {
            let mid: String = r.get(0)?;
            let time_created: i64 = r.get(1)?;
            let raw: String = r.get(2)?;
            Ok((mid, time_created, raw))
        }) {
            for (mid, time_created, raw) in iter.filter_map(Result::ok) {
                if let Ok(data) = serde_json::from_str::<Value>(&raw) {
                    parts_by_msg.entry(mid).or_default().push(PartRow { time_created, data });
                }
            }
        }
    }

    messages
        .into_iter()
        .map(|m| {
            let parts = parts_by_msg.remove(&m.id).unwrap_or_default();
            (m, parts)
        })
        .collect()
}

/// A user message's prompt text is a separate `part` row (`type: "text"`),
/// not inline on the message itself - this pulls the first one.
fn user_text(parts: &[PartRow]) -> Option<String> {
    parts.iter().find_map(|p| {
        if p.data.get("type").and_then(|t| t.as_str()) != Some("text") {
            return None;
        }
        p.data.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
    })
}

// --- session_detail counts ---

pub fn session_counts(db_path: &Path, session_id: &str) -> SessionDetail {
    let empty = || SessionDetail {
        prompt_count: 0,
        turn_count: 0,
        tool_count: 0,
        output_tokens: 0,
        context_tokens: 0,
        model: None,
        compaction_count: 0,
        compaction_reclaimed: 0,
        touched_count: 0,
    };
    let Some(conn) = open_ro(db_path) else { return empty() };
    let rows = load_session(&conn, session_id);

    let mut prompt_count = 0u32;
    let mut turn_count = 0u32;
    let mut tool_count = 0u32;
    let mut output_tokens = 0u64;
    let mut context_tokens = 0u64;
    let mut model: Option<String> = None;

    for (msg, parts) in &rows {
        match msg.data.get("role").and_then(|r| r.as_str()) {
            Some("user") => {
                if let Some(text) = user_text(parts) {
                    if sessions::is_human_prompt(&Value::String(text)) {
                        prompt_count += 1;
                    }
                }
            }
            Some("assistant") => {
                turn_count += 1;
                if let Some(m) = msg.data.get("modelID").and_then(|m| m.as_str()) {
                    model = Some(m.to_string());
                }
                if let Some(tok) = msg.data.get("tokens") {
                    let get = |k: &str| tok.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                    output_tokens += get("output");
                    let cache_read =
                        tok.get("cache").and_then(|c| c.get("read")).and_then(|n| n.as_u64()).unwrap_or(0);
                    // Last assistant turn's input reflects current context size.
                    context_tokens = get("input") + cache_read;
                }
                tool_count += parts
                    .iter()
                    .filter(|p| p.data.get("type").and_then(|t| t.as_str()) == Some("tool"))
                    .count() as u32;
            }
            _ => {}
        }
    }

    drop(rows);
    let touched_count = touched_files(db_path, session_id).iter().filter(|f| f.op != TouchOp::Read).count() as u32;

    // opencode has no compaction concept, so it reports 0 (unknown reclaimed).
    SessionDetail { prompt_count, turn_count, tool_count, output_tokens, context_tokens, model, compaction_count: 0, compaction_reclaimed: 0, touched_count }
}

// --- touched files ---

fn opencode_tool_path(input: Option<&Value>) -> Option<String> {
    let input = input?;
    input.get("filePath").or_else(|| input.get("path")).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// opencode `tool` part -> (path, op). Only `bash` was empirically captured
/// (phase 2 spike, real pty session): confirmed name + `input.command` shape.
/// write/edit/read are inferred from opencode's lowercase tool-naming
/// convention (mirrors pi) and a `path`/`filePath` input field - NOT verified
/// against a real transcript, same caveat style as Claude's MultiEdit/
/// NotebookEdit assumption in `sessions::classify_claude_tool`.
fn classify_opencode_tool(name: &str, input: Option<&Value>) -> Option<(String, TouchOp)> {
    match name {
        "write" => opencode_tool_path(input).map(|p| (p, TouchOp::Create)),
        "edit" => opencode_tool_path(input).map(|p| (p, TouchOp::Edit)),
        "read" => opencode_tool_path(input).map(|p| (p, TouchOp::Read)),
        "bash" => sessions::infer_bash_touch(input?.get("command")?.as_str()?),
        _ => None,
    }
}

pub fn touched_files(db_path: &Path, session_id: &str) -> Vec<TouchedFile> {
    let Some(conn) = open_ro(db_path) else { return Vec::new() };
    let Some(cwd) = session_directory(&conn, session_id) else { return Vec::new() };
    let rows = load_session(&conn, session_id);

    let mut acc: HashMap<String, TouchAcc> = HashMap::new();
    for (_msg, parts) in &rows {
        for part in parts {
            if part.data.get("type").and_then(|t| t.as_str()) != Some("tool") {
                continue;
            }
            let tool_name = part.data.get("tool").and_then(|t| t.as_str()).unwrap_or("");
            let input = part.data.get("state").and_then(|s| s.get("input"));
            let ts = (part.time_created.max(0) / 1000) as u64;
            if let Some((raw_path, op)) = classify_opencode_tool(tool_name, input) {
                sessions::record_touch(&mut acc, sessions::normalize_touch_path(&raw_path, &cwd), op, ts);
            }
        }
    }

    let mut files: Vec<TouchedFile> = acc
        .into_iter()
        .map(|(path, a)| TouchedFile { path, op: a.op, first_ts: a.first_ts, last_ts: a.last_ts, count: a.count })
        .collect();
    files.sort_by(|a, b| b.last_ts.cmp(&a.last_ts));
    files
}

// --- transcript turns ---

pub fn transcript_turns(db_path: &Path, session_id: &str) -> Vec<TranscriptTurn> {
    let Some(conn) = open_ro(db_path) else { return Vec::new() };
    let rows = load_session(&conn, session_id);
    let mut turns = Vec::new();

    for (msg, parts) in &rows {
        let ts = (msg.time_created.max(0) / 1000) as u64;
        match msg.data.get("role").and_then(|r| r.as_str()) {
            Some("user") => {
                if let Some(text) = user_text(&parts) {
                    if !text.trim().is_empty() {
                        turns.push(TranscriptTurn {
                            role: "user".into(),
                            ts,
                            blocks: vec![sessions::text_block("text", text)],
                        });
                    }
                }
            }
            Some("assistant") => {
                // opencode folds a whole tool round-trip (call + result) into
                // one message's part sequence, unlike Claude's separate
                // tool_use/tool_result turns - both blocks land in this one
                // assistant turn, in part order.
                let mut blocks = Vec::new();
                for part in parts {
                    match part.data.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = part.data.get("text").and_then(|t| t.as_str()) {
                                if !t.trim().is_empty() {
                                    blocks.push(sessions::text_block("text", t.to_string()));
                                }
                            }
                        }
                        Some("tool") => {
                            let name = part.data.get("tool").and_then(|n| n.as_str()).unwrap_or("").to_string();
                            let input =
                                part.data.get("state").and_then(|s| s.get("input")).cloned().unwrap_or(Value::Null);
                            blocks.push(sessions::tool_call_block(name.clone(), input, None));
                            if let Some(state) = part.data.get("state") {
                                if let Some(output) = state.get("output").and_then(|o| o.as_str()) {
                                    let is_error = state.get("status").and_then(|s| s.as_str()) == Some("error");
                                    blocks.push(sessions::tool_result_block(Some(name), output.to_string(), is_error, None));
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if !blocks.is_empty() {
                    turns.push(TranscriptTurn { role: "assistant".into(), ts, blocks });
                }
            }
            _ => {}
        }
    }

    turns
}

// --- checkpoint prompt-boundary detection ---

pub fn prompt_tail(db_path: &Path, session_id: &str) -> PromptTail {
    let Some(conn) = open_ro(db_path) else { return PromptTail { count: 0, last_ts: 0 } };
    let rows = load_session(&conn, session_id);

    let mut count = 0u32;
    let mut last_ts = 0u64;
    for (msg, parts) in &rows {
        if msg.data.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        if let Some(text) = user_text(parts) {
            if sessions::is_human_prompt(&Value::String(text)) {
                count += 1;
                last_ts = (msg.time_created.max(0) / 1000) as u64;
            }
        }
    }
    PromptTail { count, last_ts }
}

// --- delete ---

/// Delete via opencode's own CLI, never a raw SQL DELETE against its shared
/// DB - respects whatever cascade/consistency rules opencode itself applies,
/// and keeps Sway from ever writing to data it doesn't own.
pub fn delete_session_via_cli(program: &str, session_id: &str) -> Result<(), String> {
    let out = std::process::Command::new(program)
        .args(["session", "delete", session_id])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Build a throwaway sqlite DB with the same three tables/columns real
    /// opencode uses (see the module doc comment), populated with synthetic
    /// data shaped like the phase 1 spike's captures - never a raw capture,
    /// no real path/prompt/token from this machine.
    fn synthetic_db() -> (PathBuf, Connection) {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_opencode_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("opencode.db");
        let conn = Connection::open(&db_path).unwrap();

        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER
             );
             CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
                time_updated INTEGER, data TEXT
             );
             CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
                time_created INTEGER, time_updated INTEGER, data TEXT
             );",
        )
        .unwrap();

        conn.execute(
            "INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) \
             VALUES ('ses_test1', '/tmp/synthetic-project', 'Fix a parser bug', 1000000, 2000000, NULL)",
            [],
        )
        .unwrap();

        // A genuine human prompt...
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) \
             VALUES ('msg_u1', 'ses_test1', 1000000, 1000000, '{\"role\":\"user\"}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) \
             VALUES ('prt_u1', 'msg_u1', 'ses_test1', 1000000, 1000000, \
             '{\"type\":\"text\",\"text\":\"Fix the bug in parse.rs\"}')",
            [],
        )
        .unwrap();

        // ...and a slash-command envelope, which `is_human_prompt` excludes.
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) \
             VALUES ('msg_u2', 'ses_test1', 1000050, 1000050, '{\"role\":\"user\"}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) \
             VALUES ('prt_u2', 'msg_u2', 'ses_test1', 1000050, 1000050, \
             '{\"type\":\"text\",\"text\":\"<command>/review</command>\"}')",
            [],
        )
        .unwrap();

        // An assistant turn: text, a bash tool call/result, then closing text.
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) \
             VALUES ('msg_a1', 'ses_test1', 1000100, 1000200, \
             '{\"role\":\"assistant\",\"modelID\":\"claude-sonnet-4.6\",\
             \"tokens\":{\"input\":50,\"output\":120,\"cache\":{\"read\":10,\"write\":5}}}')",
            [],
        )
        .unwrap();
        for (id, ts, data) in [
            ("prt_a1", 1000101, r#"{"type":"text","text":"I'll fix that now."}"#.to_string()),
            (
                "prt_a2",
                1000110,
                r#"{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"sed -i 's/foo/bar/' parse.rs"},"output":"done\n"}}"#
                    .to_string(),
            ),
            ("prt_a3", 1000190, r#"{"type":"text","text":"Fixed."}"#.to_string()),
        ] {
            conn.execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) \
                 VALUES (?1, 'msg_a1', 'ses_test1', ?2, ?2, ?3)",
                rusqlite::params![id, ts, data],
            )
            .unwrap();
        }

        (db_path, conn)
    }

    #[test]
    fn locator_round_trips() {
        let db = PathBuf::from("/tmp/fake/opencode.db");
        let loc = make_locator(&db, "ses_abc");
        assert_eq!(loc, "opencode-sqlite:/tmp/fake/opencode.db#ses_abc");
        let (parsed_db, parsed_id) = parse_locator(&loc).expect("locator parses");
        assert_eq!(parsed_db, db);
        assert_eq!(parsed_id, "ses_abc");
        // An ordinary file path is not a locator.
        assert!(parse_locator("/Users/me/.claude/projects/x/abc.jsonl").is_none());
    }

    #[test]
    fn list_sessions_and_to_session_meta_round_trip() {
        let (db_path, _conn) = synthetic_db();
        let sessions = list_sessions(&db_path);
        assert_eq!(sessions.len(), 1);
        let meta = to_session_meta(&sessions[0], "opencode", &db_path);
        assert_eq!(meta.id, "ses_test1");
        assert_eq!(meta.cwd, "/tmp/synthetic-project");
        assert_eq!(meta.title, "Fix a parser bug");
        assert_eq!(meta.agent, "opencode");
        assert_eq!(meta.path, make_locator(&db_path, "ses_test1"));
        std::fs::remove_dir_all(db_path.parent().unwrap()).ok();
    }

    #[test]
    fn session_counts_matches_synthetic_transcript() {
        let (db_path, _conn) = synthetic_db();
        let detail = session_counts(&db_path, "ses_test1");
        // Only the genuine prompt counts, not the slash-command envelope.
        assert_eq!(detail.prompt_count, 1);
        assert_eq!(detail.turn_count, 1);
        assert_eq!(detail.tool_count, 1);
        assert_eq!(detail.output_tokens, 120);
        assert_eq!(detail.context_tokens, 60); // input(50) + cache.read(10)
        assert_eq!(detail.model.as_deref(), Some("claude-sonnet-4.6"));
        assert_eq!(detail.touched_count, 1);
        std::fs::remove_dir_all(db_path.parent().unwrap()).ok();
    }

    #[test]
    fn touched_files_infers_bash_edit_normalized_against_cwd() {
        let (db_path, _conn) = synthetic_db();
        let files = touched_files(&db_path, "ses_test1");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "/tmp/synthetic-project/parse.rs");
        assert_eq!(files[0].op, TouchOp::Edit);
        std::fs::remove_dir_all(db_path.parent().unwrap()).ok();
    }

    #[test]
    fn transcript_turns_folds_tool_call_and_result_into_one_assistant_turn() {
        let (db_path, _conn) = synthetic_db();
        let turns = transcript_turns(&db_path, "ses_test1");
        // 2 user turns (the genuine prompt and the slash-command envelope -
        // the transcript viewer shows everything verbatim; only prompt
        // *counting* filters envelopes) + 1 assistant turn.
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[0].blocks[0].text.as_deref(), Some("Fix the bug in parse.rs"));

        let assistant = &turns[2];
        assert_eq!(assistant.role, "assistant");
        assert_eq!(assistant.blocks.len(), 4); // text, tool_call, tool_result, text
        assert_eq!(assistant.blocks[0].kind, "text");
        assert_eq!(assistant.blocks[1].kind, "tool_call");
        assert_eq!(assistant.blocks[1].tool_name.as_deref(), Some("bash"));
        assert_eq!(assistant.blocks[2].kind, "tool_result");
        assert_eq!(assistant.blocks[2].text.as_deref(), Some("done\n"));
        assert_eq!(assistant.blocks[2].is_error, Some(false));
        assert_eq!(assistant.blocks[3].kind, "text");
        assert_eq!(assistant.blocks[3].text.as_deref(), Some("Fixed."));
        std::fs::remove_dir_all(db_path.parent().unwrap()).ok();
    }

    #[test]
    fn prompt_tail_counts_only_the_genuine_human_prompt() {
        let (db_path, _conn) = synthetic_db();
        let tail = prompt_tail(&db_path, "ses_test1");
        assert_eq!(tail.count, 1);
        assert_eq!(tail.last_ts, 1000); // 1000000ms -> 1000s
        std::fs::remove_dir_all(db_path.parent().unwrap()).ok();
    }

    #[test]
    fn mtime_for_reflects_time_updated() {
        let (db_path, _conn) = synthetic_db();
        let mtime = mtime_for(&db_path, "ses_test1");
        assert_eq!(mtime, epoch_ms_to_system_time(2000000));
        std::fs::remove_dir_all(db_path.parent().unwrap()).ok();
    }

    /// Manual verification against a real opencode installation (phase 2,
    /// see the plan's Notes): confirms the schema assumptions captured in
    /// the phase 1 spike still hold against actual opencode-written rows,
    /// not just this file's synthetic fixtures. Ignored by default since it
    /// needs a real `~/.local/share/opencode/opencode.db` with at least one
    /// session - run explicitly with `cargo test -- --ignored`.
    #[test]
    #[ignore = "requires a local opencode installation with a real session"]
    fn real_opencode_db_smoke_test() {
        let db_path =
            dirs::home_dir().unwrap().join(".local/share/opencode/opencode.db");
        let sessions = list_sessions(&db_path);
        assert!(!sessions.is_empty(), "expected at least one real opencode session");
        let s = &sessions[0];
        let detail = session_counts(&db_path, &s.id);
        println!("real session {}: {} prompts, {} turns, model={:?}", s.id, detail.prompt_count, detail.turn_count, detail.model);
        let turns = transcript_turns(&db_path, &s.id);
        assert!(!turns.is_empty(), "expected at least one real transcript turn");
    }
}
