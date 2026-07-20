// Session discovery for every registered agent adapter, merged by folder.
//
// Claude sessions live at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl;
// pi sessions live at ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl. Both
// encoded dir names are lossy, so we read `cwd` (and Claude's `gitBranch`) from
// inside each file rather than decoding the folder name. Pi has no branch.
// These paths, and the claude/pi split itself, are now `agents::registry()`
// data rather than hardcoded here - see agents.rs.
//
// Scanning reads only the head of each file (cwd/branch/first prompt appear
// early) and caches by mtime, so repeat scans are cheap. `list_sessions(folder)`
// returns every adapter's sessions whose recorded cwd is the folder or nested
// under it.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::agents;

const HEAD_LINES: usize = 60;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub path: String,
    pub cwd: String,
    pub branch: String,
    pub title: String,
    pub last_active: u64,
    /// File creation time (btime, falling back to mtime), epoch seconds. Lets
    /// the frontend attribute a just-spawned tab to the session that appeared
    /// after it (`created_at >= tab spawn time`), not merely one that shares
    /// its cwd (an older session's mtime would also satisfy a bare freshness
    /// check, since mtime updates on every turn).
    pub created_at: u64,
    pub name: Option<String>,
    pub archived: bool,
    /// Which agent produced the session: "claude" or "pi".
    pub agent: String,
}

struct CacheEntry {
    mtime: SystemTime,
    meta: Option<SessionMeta>,
}

#[derive(Default)]
pub struct SessionIndex(Mutex<HashMap<PathBuf, CacheEntry>>);

#[derive(Default)]
pub struct SessionWatch(pub Mutex<Option<RecommendedWatcher>>);

fn norm(path: &str) -> String {
    path.trim_end_matches('/').to_string()
}

fn epoch_secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Pull a human title from a user message's content (string or text blocks).
fn extract_text(content: &serde_json::Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

/// True only for a message a human actually typed: it has visible text (so
/// tool-result and tool-use-only turns, whose content carries no text block,
/// are excluded) and isn't a slash-command/tag envelope (`<...>`) or pi's
/// `[Context]` block. Used to count prompts, not raw transcript turns.
pub(crate) fn is_human_prompt(content: &serde_json::Value) -> bool {
    match extract_text(content) {
        Some(t) => {
            let t = t.trim();
            !t.is_empty() && !t.starts_with('<') && !t.starts_with("[Context]")
        }
        None => false,
    }
}

pub(crate) fn clean_title(raw: &str) -> String {
    let one_line: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 90 {
        let truncated: String = one_line.chars().take(90).collect();
        format!("{truncated}…")
    } else {
        one_line
    }
}

fn parse_session(path: &PathBuf, mtime: SystemTime, created: SystemTime, agent_id: &str) -> Option<SessionMeta> {
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut cwd: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut title: Option<String> = None;

    for line in reader.lines().take(HEAD_LINES).map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = Some(c.to_string());
            }
        }
        if branch.is_none() {
            if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
                if !b.is_empty() {
                    branch = Some(b.to_string());
                }
            }
        }
        if title.is_none()
            && v.get("type").and_then(|t| t.as_str()) == Some("user")
            && v.get("isMeta").and_then(|m| m.as_bool()) != Some(true)
        {
            if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                if let Some(text) = extract_text(content) {
                    let trimmed = text.trim();
                    // Skip slash-command envelopes and tool-result noise.
                    if !trimmed.is_empty() && !trimmed.starts_with('<') {
                        title = Some(clean_title(trimmed));
                    }
                }
            }
        }

        if cwd.is_some() && branch.is_some() && title.is_some() {
            break;
        }
    }

    let cwd = cwd?;
    Some(SessionMeta {
        id,
        path: path.to_string_lossy().into_owned(),
        cwd,
        branch: branch.unwrap_or_default(),
        title: title.unwrap_or_else(|| "(untitled session)".into()),
        last_active: epoch_secs(mtime),
        created_at: epoch_secs(created),
        name: None,
        archived: false,
        agent: agent_id.to_string(),
    })
}

/// Dispatch to the parser this adapter's `parser_kind` implements, stamping
/// the resulting session with the adapter's own id (not a hardcoded literal),
/// so a user-added adapter reusing an existing parser kind still shows under
/// its own agent id.
fn parse_by_adapter(
    adapter: &agents::AgentAdapter,
    path: &PathBuf,
    mtime: SystemTime,
    created: SystemTime,
) -> Option<SessionMeta> {
    match adapter.parser_kind {
        agents::ParserKind::ClaudeJsonl => parse_session(path, mtime, created, &adapter.id),
        agents::ParserKind::PiJsonl => parse_pi_session(path, mtime, created, &adapter.id),
        // Never actually reached: a `Discovery::Sqlite` adapter's sessions
        // are enumerated straight from the DB in `ensure_index`, not via a
        // file-tree walk that would call this function. Kept only so the
        // match stays exhaustive for a hypothetical direct caller.
        agents::ParserKind::OpencodeSqlite => None,
    }
}

/// Walk every registered adapter's discovery dir, refreshing the (shared,
/// path-keyed) cache for changed/new files. One cache serves every adapter:
/// their discovery dirs never overlap, so paths stay unique.
fn ensure_index(index: &SessionIndex) -> Vec<SessionMeta> {
    let mut cache = match index.0.lock() {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut seen: Vec<PathBuf> = Vec::new();

    for adapter in agents::registry() {
        match &adapter.discovery {
            agents::Discovery::File { dir, filename_regex } => {
                if let Ok(dirs) = std::fs::read_dir(dir) {
                    for dir in dirs.flatten() {
                        let p = dir.path();
                        if !p.is_dir() {
                            continue;
                        }
                        if let Ok(files) = std::fs::read_dir(&p) {
                            for f in files.flatten() {
                                let fp = f.path();
                                let matches_pattern = fp
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .map(|n| filename_regex.is_match(n))
                                    .unwrap_or(false);
                                if !matches_pattern {
                                    continue;
                                }
                                let metadata = f.metadata().ok();
                                let mtime = metadata
                                    .as_ref()
                                    .and_then(|m| m.modified().ok())
                                    .unwrap_or(SystemTime::UNIX_EPOCH);
                                let created =
                                    metadata.as_ref().and_then(|m| m.created().ok()).unwrap_or(mtime);
                                seen.push(fp.clone());

                                let fresh = cache.get(&fp).map(|e| e.mtime == mtime).unwrap_or(false);
                                if !fresh {
                                    let meta = parse_by_adapter(adapter, &fp, mtime, created);
                                    cache.insert(fp.clone(), CacheEntry { mtime, meta });
                                }
                            }
                        }
                    }
                }
            }
            agents::Discovery::Sqlite { db_path } => {
                // One shared DB across every project - list every session,
                // not a directory tree, and filter by cwd at the caller
                // (`filter_sort`) the same way file-backed adapters already do.
                for row in crate::opencode::list_sessions(db_path) {
                    let key = PathBuf::from(crate::opencode::make_locator(db_path, &row.id));
                    let mtime = crate::opencode::epoch_ms_to_system_time(row.time_updated);
                    seen.push(key.clone());

                    let fresh = cache.get(&key).map(|e| e.mtime == mtime).unwrap_or(false);
                    if !fresh {
                        let meta = Some(crate::opencode::to_session_meta(&row, &adapter.id, db_path));
                        cache.insert(key, CacheEntry { mtime, meta });
                    }
                }
            }
        }
    }

    // Drop entries whose files (or opencode rows) disappeared.
    cache.retain(|k, _| seen.contains(k));

    cache.values().filter_map(|e| e.meta.clone()).collect()
}

/// Parse a pi session: head line carries `id`/`cwd`/`timestamp`; the title comes
/// from the first real user message in a bounded window, falling back to an
/// id-slice for an empty session. last_active uses the file mtime (a better
/// "last activity" signal than the head timestamp, and no ISO parse needed).
fn parse_pi_session(path: &PathBuf, mtime: SystemTime, created: SystemTime, agent_id: &str) -> Option<SessionMeta> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut cwd: Option<String> = None;
    let mut id: Option<String> = None;
    let mut title: Option<String> = None;

    for line in reader.lines().take(HEAD_LINES).map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session") => {
                if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                    cwd = Some(c.to_string());
                }
                if let Some(i) = v.get("id").and_then(|i| i.as_str()) {
                    id = Some(i.to_string());
                }
            }
            Some("message") if title.is_none() => {
                let msg = v.get("message");
                if msg.and_then(|m| m.get("role")).and_then(|r| r.as_str()) == Some("user") {
                    if let Some(content) = msg.and_then(|m| m.get("content")) {
                        if let Some(text) = extract_text(content) {
                            let trimmed = text.trim();
                            // Skip skill/tool envelopes and pi's [Context] blocks.
                            if !trimmed.is_empty()
                                && !trimmed.starts_with('<')
                                && !trimmed.starts_with("[Context]")
                            {
                                title = Some(clean_title(trimmed));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        if cwd.is_some() && id.is_some() && title.is_some() {
            break;
        }
    }

    let cwd = cwd?;
    // Prefer the head id; fall back to the `<ts>_<id>` filename stem.
    let id = id.or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))?;
    let title = title.unwrap_or_else(|| {
        let slice: String = id.chars().take(8).collect();
        format!("pi session {slice}")
    });

    Some(SessionMeta {
        id,
        path: path.to_string_lossy().into_owned(),
        cwd,
        branch: String::new(),
        title,
        last_active: epoch_secs(mtime),
        created_at: epoch_secs(created),
        name: None,
        archived: false,
        agent: agent_id.to_string(),
    })
}

/// Does a session's recorded `cwd` belong to `folder` (the folder itself or a
/// nested subdir)? This is the cwd-anchored, prefix-matching rule.
fn cwd_matches(cwd: &str, folder: &str) -> bool {
    let c = norm(cwd);
    let f = norm(folder);
    c == f || c.starts_with(&format!("{f}/"))
}

/// Filter to sessions under `folder` and sort most-recently-active first.
fn filter_sort(all: Vec<SessionMeta>, folder: &str) -> Vec<SessionMeta> {
    let mut v: Vec<SessionMeta> = all
        .into_iter()
        .filter(|s| cwd_matches(&s.cwd, folder))
        .collect();
    v.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    v
}

/// Every session across every registered agent, unfiltered by folder.
/// `crate::hooks::prune_stale`'s only caller - not a `#[tauri::command]`,
/// the frontend has no use for an unscoped list.
pub(crate) fn all_sessions(index: &SessionIndex) -> Vec<SessionMeta> {
    ensure_index(index)
}

/// Sessions (every registered agent) anchored at `folder` or nested under it,
/// newest first.
#[tauri::command]
pub fn list_sessions(
    index: State<SessionIndex>,
    folder: String,
) -> Result<Vec<SessionMeta>, String> {
    let overlay = load_overlay();
    let sessions = filter_sort(ensure_index(&index), &folder)
        .into_iter()
        .map(|mut s| {
            if let Some(o) = overlay.get(&s.id) {
                s.name = o.name.clone();
                s.archived = o.archived;
            }
            s
        })
        .collect();
    Ok(sessions)
}

// --- adopted-paths state (recreated-folder / "Historical" sessions) ---
//
// A folder recreated at a path where old sessions still live would otherwise
// surface those ghosts as if they belonged to it. `adopted_paths` is the set of
// folders whose sessions are "ours". It is stored SEPARATELY from the watched
// sway.toml (writing the toml would loop the config watcher). A folder not in the
// set whose sessions predate its own creation is "historical" until adopted.

#[derive(Serialize, Deserialize, Default)]
struct AdoptedState {
    /// Seeded once, on the first discovery that yields >=1 folder, so a fresh
    /// install does not flag the user's pre-existing folders as historical.
    seeded: bool,
    /// Normalized folder paths whose sessions are adopted (shown normally).
    paths: HashSet<String>,
}

fn adopted_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/adopted.json")
}

fn load_adopted() -> AdoptedState {
    std::fs::read_to_string(adopted_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_adopted(state: &AdoptedState) -> Result<(), String> {
    let path = adopted_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Pure seed step: adopt all `folders` exactly once, and never against an empty
/// discovery. Returns whether the state changed (so the caller persists).
fn do_seed(state: &mut AdoptedState, folders: &[String]) -> bool {
    if state.seeded || folders.is_empty() {
        return false;
    }
    for f in folders {
        state.paths.insert(norm(f));
    }
    state.seeded = true;
    true
}

enum FolderVerdict {
    /// Already adopted, or nothing to hide: show normally.
    Adopted,
    /// Sessions all postdate the folder: they are ours, adopt and show normally.
    AutoAdopt,
    /// Not adopted, with sessions predating the folder: hide under "Historical".
    Historical,
}

/// Decide a folder's status from the adopted set, its sessions' activity times,
/// and the folder's own creation time. Pure, so it is unit-tested directly.
fn folder_verdict(
    adopted: &HashSet<String>,
    folder: &str,
    session_times: &[u64],
    folder_created: u64,
) -> FolderVerdict {
    if adopted.contains(&norm(folder)) {
        return FolderVerdict::Adopted;
    }
    if session_times.is_empty() {
        return FolderVerdict::Adopted; // no ghosts to hide
    }
    if session_times.iter().all(|&t| t >= folder_created) {
        return FolderVerdict::AutoAdopt;
    }
    FolderVerdict::Historical
}

/// Folder creation time (btime, falling back to mtime), in epoch seconds.
fn folder_created(p: &Path) -> u64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.created().ok().or_else(|| m.modified().ok()))
        .map(epoch_secs)
        .unwrap_or(0)
}

/// Adopt a folder's sessions (idempotent). Called by the UI "Adopt" action and
/// whenever Sway itself creates a folder (new folder / worktree / clone / bootstrap).
pub fn adopt(path: &str) -> Result<(), String> {
    let mut state = load_adopted();
    if state.paths.insert(norm(path)) {
        save_adopted(&state)?;
    }
    Ok(())
}

#[tauri::command]
pub fn adopt_path(path: String) -> Result<(), String> {
    adopt(&path)
}

/// Seed the adopted set from the current discovery (idempotent; no-op once seeded
/// or when discovery is empty). The UI calls this after each `get_config`.
#[tauri::command]
pub fn seed_adopted(folders: Vec<String>) -> Result<(), String> {
    let mut state = load_adopted();
    if do_seed(&mut state, &folders) {
        save_adopted(&state)?;
    }
    Ok(())
}

/// Is `folder` historical (a recreated folder whose sessions predate it)? Adopts
/// it in passing when its sessions clearly belong to it (all postdate creation).
#[tauri::command]
pub fn folder_historical(
    index: State<SessionIndex>,
    folder: String,
) -> Result<bool, String> {
    let state = load_adopted();
    let times: Vec<u64> = filter_sort(ensure_index(&index), &folder)
        .iter()
        .map(|s| s.last_active)
        .collect();
    let created = folder_created(Path::new(&folder));
    match folder_verdict(&state.paths, &folder, &times, created) {
        FolderVerdict::Historical => Ok(true),
        FolderVerdict::AutoAdopt => {
            adopt(&folder)?;
            Ok(false)
        }
        FolderVerdict::Adopted => Ok(false),
    }
}

// --- rename/archive overlay (Claude has no native rename) ---

#[derive(Serialize, Deserialize, Clone, Default)]
struct Overlay {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    archived: bool,
}

fn overlay_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/sessions.json")
}

fn load_overlay() -> HashMap<String, Overlay> {
    std::fs::read_to_string(overlay_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_overlay(map: &HashMap<String, Overlay>) -> Result<(), String> {
    let path = overlay_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_session_name(id: String, name: Option<String>) -> Result<(), String> {
    let mut map = load_overlay();
    map.entry(id).or_default().name = name.filter(|n| !n.trim().is_empty());
    save_overlay(&map)
}

#[tauri::command]
pub fn set_session_archived(id: String, archived: bool) -> Result<(), String> {
    let mut map = load_overlay();
    map.entry(id).or_default().archived = archived;
    save_overlay(&map)
}

/// Delete a session's transcript. Destructive (removes Claude history); the
/// frontend confirms first.
#[tauri::command]
pub fn delete_session(path: String) -> Result<(), String> {
    if let Some((_db_path, session_id)) = crate::opencode::parse_locator(&path) {
        // Shells out to opencode's own `session delete`, mirroring
        // `session_running`'s pgrep approach - never writes to the shared
        // DB directly, so opencode's own cascade/consistency rules apply.
        let program =
            agents::find("opencode").map(|a| a.program.clone()).unwrap_or_else(|| "opencode".to_string());
        return crate::opencode::delete_session_via_cli(&program, session_id);
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Extended-regex pattern for `pgrep -f` (BSD pgrep treats the pattern as ERE
/// natively, no `-E` needed) that matches only a live `agent` process actually
/// resuming session `id` - not merely any process whose command line contains
/// the id, which is what a bare `pgrep -f <uuid>` would also catch (a `less`/
/// `tail`/editor with the transcript file open). The template itself is now
/// adapter data (`agents::session_pattern`); this stays as the call site's
/// entry point so callers/tests are unaffected by the registry underneath.
fn session_pattern(agent: &str, id: &str) -> String {
    agents::session_pattern(agent, id)
}

/// Is a live `agent` process currently resuming session `id`?
#[tauri::command]
pub fn session_running(id: String, agent: String) -> Result<bool, String> {
    let pattern = session_pattern(&agent, &id);
    let out = Command::new("pgrep").args(["-f", &pattern]).output();
    Ok(out
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false))
}

#[derive(Serialize)]
pub struct SessionDetail {
    /// Messages the human actually typed (see `is_human_prompt`).
    pub prompt_count: u32,
    /// Agent replies (assistant messages).
    pub turn_count: u32,
    /// Tool invocations across the session.
    pub tool_count: u32,
    pub output_tokens: u64,
    pub context_tokens: u64,
    pub model: Option<String>,
    /// Distinct files this session wrote, created, or deleted (reads excluded).
    pub touched_count: u32,
}

/// Read the full transcript once (only on selection) for counts and tokens.
/// Handles both transcript shapes: Claude tags user/assistant at the top level
/// with a `{output,input,cache_*}_tokens` usage; pi wraps each turn in a
/// `type:"message"` envelope with `message.role` and a `{input,output,cacheRead,
/// cacheWrite}` usage. Each line is dispatched by shape so one pass covers both.
#[tauri::command]
pub fn session_detail(
    touched: State<TouchedIndex>,
    path: String,
    agent: String,
) -> Result<SessionDetail, String> {
    if let Some((db_path, session_id)) = crate::opencode::parse_locator(&path) {
        return Ok(crate::opencode::session_counts(&db_path, session_id));
    }
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut prompt_count = 0u32;
    let mut turn_count = 0u32;
    let mut tool_count = 0u32;
    let mut output_tokens = 0u64;
    let mut context_tokens = 0u64;
    let mut model: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // Claude: the turn is the top-level record.
            Some(kind @ ("user" | "assistant")) => {
                if kind == "user" && v.get("isMeta").and_then(|m| m.as_bool()) != Some(true) {
                    if let Some(c) = v.get("message").and_then(|m| m.get("content")) {
                        if is_human_prompt(c) {
                            prompt_count += 1;
                        }
                    }
                }
                if kind == "assistant" {
                    turn_count += 1;
                    if let Some(msg) = v.get("message") {
                        // Each tool_use block in the reply is one tool call.
                        if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
                            tool_count += arr
                                .iter()
                                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                                .count() as u32;
                        }
                        if let Some(m) = msg.get("model").and_then(|m| m.as_str()) {
                            model = Some(m.to_string());
                        }
                        if let Some(u) = msg.get("usage") {
                            let get = |k: &str| u.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                            output_tokens += get("output_tokens");
                            // Last assistant turn's input reflects current context size.
                            context_tokens = get("input_tokens")
                                + get("cache_read_input_tokens")
                                + get("cache_creation_input_tokens");
                        }
                    }
                }
            }
            // pi: the turn lives under a `message` envelope.
            Some("message") => {
                let msg = match v.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                let role = msg.get("role").and_then(|r| r.as_str());
                if role == Some("user") {
                    if let Some(c) = msg.get("content") {
                        if is_human_prompt(c) {
                            prompt_count += 1;
                        }
                    }
                }
                // pi logs one toolResult per tool call (mirrors the assistant's
                // toolCall blocks); counting these is the tool-call total.
                if role == Some("toolResult") {
                    tool_count += 1;
                }
                if role == Some("assistant") {
                    turn_count += 1;
                    if let Some(m) = msg.get("model").and_then(|m| m.as_str()) {
                        model = Some(m.to_string());
                    }
                    if let Some(u) = msg.get("usage") {
                        let get = |k: &str| u.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                        output_tokens += get("output");
                        // Last assistant turn's input reflects current context size.
                        context_tokens = get("input") + get("cacheRead") + get("cacheWrite");
                    }
                }
            }
            // pi: an explicit mid-session model switch. It can land after the
            // last assistant turn, so this (in file order) is the current model.
            Some("model_change") => {
                if let Some(m) = v.get("modelId").and_then(|m| m.as_str()) {
                    model = Some(m.to_string());
                }
            }
            _ => {}
        }
    }

    let touched_count = touched_files_cached(&touched, &path, &agent)
        .iter()
        .filter(|f| f.op != TouchOp::Read)
        .count() as u32;

    Ok(SessionDetail {
        prompt_count,
        turn_count,
        tool_count,
        output_tokens,
        context_tokens,
        model,
        touched_count,
    })
}

// --- Touched-files extraction ---
//
// Every tool call in a transcript that reads/writes/deletes a file is
// classified into an op, path-normalized against the session's own recorded
// cwd, and deduped by final absolute path: `op` is the latest *write-class*
// touch (Read never downgrades a prior Create/Edit/Delete, so a file that was
// created then merely re-read still shows as created); `first_ts`/`last_ts`
// span every touch including reads; `count` is the total touch count.
// Bash/bash commands only cover three common shapes (`sed -i`, a trailing
// `>`/`>>` redirect, `rm`) - anything else is invisible here, with git's diff
// as the backstop (findings.md Finding B caveats).

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TouchOp {
    Read,
    Create,
    Edit,
    Delete,
}

#[derive(Serialize, Clone)]
pub struct TouchedFile {
    pub path: String,
    pub op: TouchOp,
    pub first_ts: u64,
    pub last_ts: u64,
    pub count: u32,
}

pub(crate) struct TouchAcc {
    pub(crate) op: TouchOp,
    pub(crate) has_write: bool,
    pub(crate) first_ts: u64,
    pub(crate) last_ts: u64,
    pub(crate) count: u32,
}

/// Resolve a tool-reported path against the session's cwd: an absolute path
/// passes through, a relative one (always true of a Bash-inferred touch) is
/// joined onto cwd after stripping a leading `./`. No `..`/canonicalization is
/// attempted beyond that (best-effort, matching the Bash inference it mostly
/// serves).
pub(crate) fn normalize_touch_path(path: &str, cwd: &str) -> String {
    let p = path.trim();
    if p.starts_with('/') {
        p.to_string()
    } else {
        let p = p.strip_prefix("./").unwrap_or(p);
        format!("{}/{}", cwd.trim_end_matches('/'), p)
    }
}

pub(crate) fn record_touch(acc: &mut HashMap<String, TouchAcc>, path: String, op: TouchOp, ts: u64) {
    acc.entry(path)
        .and_modify(|e| {
            // A later write-class touch replaces the shown op; a later Read
            // never downgrades an already-recorded write.
            if op != TouchOp::Read || !e.has_write {
                e.op = op;
            }
            e.has_write |= op != TouchOp::Read;
            e.first_ts = e.first_ts.min(ts);
            e.last_ts = e.last_ts.max(ts);
            e.count += 1;
        })
        .or_insert(TouchAcc {
            op,
            has_write: op != TouchOp::Read,
            first_ts: ts,
            last_ts: ts,
            count: 1,
        });
}

fn strip_quotes(s: &str) -> &str {
    s.trim_matches(|c| c == '\'' || c == '"')
}

/// Best-effort file touch inference from a raw shell command string: `sed -i`
/// (edit, the last token), a trailing `>`/`>>` redirect (create/edit, the
/// token right after it), `rm` (delete, the last non-flag token). Only covers
/// the common spaced-token forms; anything else yields None.
pub(crate) fn infer_bash_touch(cmd: &str) -> Option<(String, TouchOp)> {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    let first = *tokens.first()?;

    if first == "sed" && tokens.iter().any(|t| *t == "-i" || t.starts_with("-i")) {
        let last = strip_quotes(tokens.last()?);
        if !last.is_empty() {
            return Some((last.to_string(), TouchOp::Edit));
        }
    }
    if let Some(pos) = tokens.iter().rposition(|t| *t == ">>") {
        if let Some(target) = tokens.get(pos + 1) {
            return Some((strip_quotes(target).to_string(), TouchOp::Edit));
        }
    }
    if let Some(pos) = tokens.iter().rposition(|t| *t == ">") {
        if let Some(target) = tokens.get(pos + 1) {
            return Some((strip_quotes(target).to_string(), TouchOp::Create));
        }
    }
    if first == "rm" {
        if let Some(target) = tokens.iter().skip(1).rev().find(|t| !t.starts_with('-')) {
            return Some((strip_quotes(target).to_string(), TouchOp::Delete));
        }
    }
    None
}

fn claude_tool_path(input: &serde_json::Value) -> Option<String> {
    input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Claude `tool_use` -> (path, op). Grounded in real local transcripts: Write/
/// Edit/Read all carry `input.file_path`. MultiEdit/NotebookEdit have no local
/// sample to confirm against; assumed to match per findings.md Finding B.
fn classify_claude_tool(name: &str, input: Option<&serde_json::Value>) -> Option<(String, TouchOp)> {
    match name {
        "Write" => claude_tool_path(input?).map(|p| (p, TouchOp::Create)),
        "Edit" | "MultiEdit" | "NotebookEdit" => claude_tool_path(input?).map(|p| (p, TouchOp::Edit)),
        "Read" => claude_tool_path(input?).map(|p| (p, TouchOp::Read)),
        "Bash" => infer_bash_touch(input?.get("command")?.as_str()?),
        _ => None,
    }
}

fn pi_tool_path(args: &serde_json::Value) -> Option<String> {
    args.get("path").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// pi `toolCall` -> (path, op). Grounded in real local transcripts: tool names
/// are lowercase (unlike Claude's), and write/edit/read all carry
/// `arguments.path`.
fn classify_pi_tool(name: &str, args: Option<&serde_json::Value>) -> Option<(String, TouchOp)> {
    match name {
        "write" => pi_tool_path(args?).map(|p| (p, TouchOp::Create)),
        "edit" => pi_tool_path(args?).map(|p| (p, TouchOp::Edit)),
        "read" => pi_tool_path(args?).map(|p| (p, TouchOp::Read)),
        "bash" => infer_bash_touch(args?.get("command")?.as_str()?),
        _ => None,
    }
}

/// Parse a `timestamp` field (RFC3339, always `Z`-suffixed in both agents'
/// transcripts) into epoch seconds. No chrono/time dependency: a minimal
/// fixed-format parser using the standard civil-to-days-since-epoch algorithm
/// (Howard Hinnant's `days_from_civil`).
fn parse_rfc3339_secs(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;

    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (month + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + day - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    let days = era * 146097 + doe - 719468; // days since 1970-01-01

    let secs = days * 86400 + hour * 3600 + min * 60 + sec;
    if secs < 0 {
        None
    } else {
        Some(secs as u64)
    }
}

/// Read a full transcript and extract every touched file. Returns an empty
/// list (not an error) when the file can't be opened - touched data is
/// supplementary, so a session that vanished mid-read just shows nothing.
fn extract_touched_files(path: &str, agent: &str) -> Vec<TouchedFile> {
    if let Some((db_path, session_id)) = crate::opencode::parse_locator(path) {
        return crate::opencode::touched_files(&db_path, session_id);
    }
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    let kind = agents::parser_kind_for(agent);

    let mut cwd: Option<String> = None;
    let mut acc: HashMap<String, TouchAcc> = HashMap::new();

    for line in reader.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = Some(c.to_string());
            }
        }
        let Some(cwd_str) = cwd.as_deref() else { continue }; // no touches before cwd is known
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_rfc3339_secs)
            .unwrap_or(0);

        if kind == agents::ParserKind::PiJsonl {
            if v.get("type").and_then(|t| t.as_str()) != Some("message") {
                continue;
            }
            let Some(msg) = v.get("message") else { continue };
            if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
                continue;
            }
            let Some(arr) = msg.get("content").and_then(|c| c.as_array()) else { continue };
            for block in arr {
                if block.get("type").and_then(|t| t.as_str()) != Some("toolCall") {
                    continue;
                }
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if let Some((raw_path, op)) = classify_pi_tool(name, block.get("arguments")) {
                    record_touch(&mut acc, normalize_touch_path(&raw_path, cwd_str), op, ts);
                }
            }
        } else {
            if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            let Some(arr) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            else {
                continue;
            };
            for block in arr {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                    continue;
                }
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if let Some((raw_path, op)) = classify_claude_tool(name, block.get("input")) {
                    record_touch(&mut acc, normalize_touch_path(&raw_path, cwd_str), op, ts);
                }
            }
        }
    }

    let mut files: Vec<TouchedFile> = acc
        .into_iter()
        .map(|(path, a)| TouchedFile {
            path,
            op: a.op,
            first_ts: a.first_ts,
            last_ts: a.last_ts,
            count: a.count,
        })
        .collect();
    files.sort_by(|a, b| b.last_ts.cmp(&a.last_ts));
    files
}

struct TouchedCacheEntry {
    mtime: SystemTime,
    files: Vec<TouchedFile>,
}

#[derive(Default)]
pub struct TouchedIndex(Mutex<HashMap<PathBuf, TouchedCacheEntry>>);

/// Mtime-cached wrapper around `extract_touched_files`, shared by the
/// `session_touched_files` command and `session_detail`'s `touched_count` -
/// so selecting a session doesn't force a second full transcript read if the
/// touched panel (phase 3) already warmed the cache, or vice versa.
fn touched_files_cached(index: &TouchedIndex, path: &str, agent: &str) -> Vec<TouchedFile> {
    let p = PathBuf::from(path);
    // A sqlite locator isn't a real file - `std::fs::metadata` would always
    // fail and freeze the cache at UNIX_EPOCH, never invalidating. Use the
    // session's own `time_updated` instead.
    let mtime = if let Some((db_path, session_id)) = crate::opencode::parse_locator(path) {
        crate::opencode::mtime_for(&db_path, session_id)
    } else {
        std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)
    };

    let mut cache = match index.0.lock() {
        Ok(c) => c,
        Err(_) => return extract_touched_files(path, agent),
    };
    if let Some(entry) = cache.get(&p) {
        if entry.mtime == mtime {
            return entry.files.clone();
        }
    }
    let files = extract_touched_files(path, agent);
    cache.insert(
        p,
        TouchedCacheEntry {
            mtime,
            files: files.clone(),
        },
    );
    files
}

#[tauri::command]
pub fn session_touched_files(
    index: State<TouchedIndex>,
    path: String,
    agent: String,
) -> Result<Vec<TouchedFile>, String> {
    Ok(touched_files_cached(&index, &path, &agent))
}

/// The most recently *written* file in a touched set, ignoring reads. Reads are
/// excluded for the same reason the tree markers exclude them: an agent reads
/// far more than it writes, so the newest read says nothing about what it is
/// changing. Does not assume `extract_touched_files`' sort order - it picks the
/// max explicitly, so a caller that filtered or reordered still gets the right
/// answer.
fn latest_written(files: &[TouchedFile]) -> Option<&TouchedFile> {
    files
        .iter()
        .filter(|f| f.op != TouchOp::Read)
        .max_by_key(|f| f.last_ts)
}

/// The file this session wrote most recently, for the live "editing now"
/// indicator. Attribution only: this answers "which file did the transcript
/// last name", never "is the session busy" - liveness is composed in the
/// frontend (PTY activity + tail state), which the backend cannot see.
///
/// Rides the same mtime cache as `session_touched_files`, so polling it while a
/// turn runs costs a full parse only when the transcript actually grew. An
/// adapter whose transcript shape `extract_touched_files` cannot parse yields
/// `None`, so the indicator no-ops rather than misreporting.
#[tauri::command]
pub fn session_editing_now(
    index: State<TouchedIndex>,
    path: String,
    agent: String,
) -> Result<Option<TouchedFile>, String> {
    let files = touched_files_cached(&index, &path, &agent);
    Ok(latest_written(&files).cloned())
}

/// Directories the session watcher covers - every registered adapter's
/// discovery dir, so a newly added agent's transcripts also fire
/// `sessions://changed` with no watcher-side wiring of its own.
fn watch_dirs() -> Vec<PathBuf> {
    agents::registry()
        .iter()
        .map(|a| match &a.discovery {
            agents::Discovery::File { dir, .. } => dir.clone(),
            // No per-session file to watch - watch the DB's parent dir, so a
            // write to `opencode.db`/`opencode.db-wal` still fires the
            // debounced `sessions://changed` refetch.
            agents::Discovery::Sqlite { db_path } => {
                db_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| db_path.clone())
            }
        })
        .collect()
}

#[tauri::command]
pub fn sessions_watch_start(
    app: AppHandle,
    state: State<SessionWatch>,
) -> Result<(), String> {
    let dirs = watch_dirs();
    for dir in &dirs {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let app_handle = app.clone();
    let last_emit = std::sync::Arc::new(Mutex::new(Instant::now()));
    let debounce = last_emit.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_err() {
            return;
        }
        // Coalesce bursts: Claude writes a session line on every turn.
        if let Ok(mut last) = debounce.lock() {
            if last.elapsed().as_millis() < 600 {
                return;
            }
            *last = Instant::now();
        }
        let _ = app_handle.emit("sessions://changed", ());
    })
    .map_err(|e| e.to_string())?;

    for dir in &dirs {
        watcher
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
    }

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

// --- Transcript viewer ---
//
// A per-agent-agnostic turn list for the read-only transcript viewer. Reuses
// `extract_text` (title/prompt extraction) and `parse_rfc3339_secs` (touched-
// files timestamps) rather than re-deriving either, and mirrors the same
// per-line, per-agent dispatch shape as `session_detail`/`extract_touched_files`.
// Grounded in real local transcripts (see block-shape doc comments below), the
// same practice phase 2 used for the touched-files tool mapping.

const TRANSCRIPT_PAGE: usize = 40;

#[derive(Serialize, Clone)]
pub struct TranscriptBlock {
    /// "text" | "thinking" | "tool_call" | "tool_result"
    pub kind: String,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    pub is_error: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct TranscriptTurn {
    /// "user" | "assistant" | "tool" (pi's standalone toolResult message)
    pub role: String,
    pub ts: u64,
    pub blocks: Vec<TranscriptBlock>,
}

#[derive(Serialize)]
pub struct TranscriptPage {
    /// Newest-first within this page.
    pub turns: Vec<TranscriptTurn>,
    /// Pass back to `session_transcript` to fetch the preceding (older) window;
    /// `None` once the oldest turn has been returned.
    pub next_cursor: Option<usize>,
}

pub(crate) fn text_block(kind: &str, text: String) -> TranscriptBlock {
    TranscriptBlock { kind: kind.into(), text: Some(text), tool_name: None, tool_input: None, is_error: None }
}

pub(crate) fn tool_call_block(name: String, input: serde_json::Value) -> TranscriptBlock {
    TranscriptBlock { kind: "tool_call".into(), text: None, tool_name: Some(name), tool_input: Some(input), is_error: None }
}

pub(crate) fn tool_result_block(name: Option<String>, text: String, is_error: bool) -> TranscriptBlock {
    TranscriptBlock { kind: "tool_result".into(), text: Some(text), tool_name: name, tool_input: None, is_error: Some(is_error) }
}

/// A tool_result's `content` is either a bare string or an array of text
/// blocks (`[{"type":"text","text":...}]`), same shape `extract_text` handles
/// for prompts; this joins every text block instead of stopping at the first.
fn stringify_content(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

/// Parse a full transcript into a chronological (oldest-first) turn list.
/// Claude: `type:"user"/"assistant"` at the top level, `message.content` an
/// array of `text`/`thinking`/`tool_use` blocks (a `tool_result` block rides
/// inside the *next* user turn's content). Grounded in this session's own live
/// transcript: also confirmed `tool_use` keys (`name`,`input`) and `tool_result`
/// keys (`content`,`is_error`). pi: `type:"message"`, `message.role` of
/// `user`/`assistant`/`toolResult`; an assistant's `toolCall` blocks carry
/// `name`/`arguments` (lowercase names, matching phase 2's touched-files
/// finding), and a `toolResult` role is its own top-level message (`content`,
/// `isError`, `toolName`), not nested in the next turn - mapped to its own
/// `"tool"`-role turn here.
fn parse_transcript_turns(path: &str, agent: &str) -> Vec<TranscriptTurn> {
    if let Some((db_path, session_id)) = crate::opencode::parse_locator(path) {
        return crate::opencode::transcript_turns(&db_path, session_id);
    }
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    let kind = agents::parser_kind_for(agent);
    let mut turns = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_rfc3339_secs)
            .unwrap_or(0);

        if kind == agents::ParserKind::PiJsonl {
            if v.get("type").and_then(|t| t.as_str()) != Some("message") {
                continue;
            }
            let Some(msg) = v.get("message") else { continue };
            match msg.get("role").and_then(|r| r.as_str()) {
                Some("user") => {
                    if let Some(content) = msg.get("content") {
                        if let Some(text) = extract_text(content) {
                            turns.push(TranscriptTurn { role: "user".into(), ts, blocks: vec![text_block("text", text)] });
                        }
                    }
                }
                Some("assistant") => {
                    let mut blocks = Vec::new();
                    if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
                        for b in arr {
                            match b.get("type").and_then(|t| t.as_str()) {
                                Some("text") => {
                                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                        blocks.push(text_block("text", t.to_string()));
                                    }
                                }
                                Some("thinking") => {
                                    if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                                        blocks.push(text_block("thinking", t.to_string()));
                                    }
                                }
                                Some("toolCall") => {
                                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                                    let input = b.get("arguments").cloned().unwrap_or(serde_json::Value::Null);
                                    blocks.push(tool_call_block(name, input));
                                }
                                _ => {}
                            }
                        }
                    }
                    if !blocks.is_empty() {
                        turns.push(TranscriptTurn { role: "assistant".into(), ts, blocks });
                    }
                }
                Some("toolResult") => {
                    let name = msg.get("toolName").and_then(|n| n.as_str()).map(|s| s.to_string());
                    let text = msg.get("content").map(stringify_content).unwrap_or_default();
                    let is_error = msg.get("isError").and_then(|e| e.as_bool()).unwrap_or(false);
                    turns.push(TranscriptTurn { role: "tool".into(), ts, blocks: vec![tool_result_block(name, text, is_error)] });
                }
                _ => {}
            }
        } else {
            match v.get("type").and_then(|t| t.as_str()) {
                Some("user") => {
                    if v.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
                        continue;
                    }
                    let mut blocks = Vec::new();
                    if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                        if let Some(s) = content.as_str() {
                            if !s.trim().is_empty() {
                                blocks.push(text_block("text", s.to_string()));
                            }
                        } else if let Some(arr) = content.as_array() {
                            for b in arr {
                                match b.get("type").and_then(|t| t.as_str()) {
                                    Some("text") => {
                                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                            blocks.push(text_block("text", t.to_string()));
                                        }
                                    }
                                    Some("tool_result") => {
                                        let text = b.get("content").map(stringify_content).unwrap_or_default();
                                        let is_error = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                                        blocks.push(tool_result_block(None, text, is_error));
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    if !blocks.is_empty() {
                        turns.push(TranscriptTurn { role: "user".into(), ts, blocks });
                    }
                }
                Some("assistant") => {
                    let mut blocks = Vec::new();
                    if let Some(arr) = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                    {
                        for b in arr {
                            match b.get("type").and_then(|t| t.as_str()) {
                                Some("text") => {
                                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                        blocks.push(text_block("text", t.to_string()));
                                    }
                                }
                                Some("thinking") => {
                                    if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                                        blocks.push(text_block("thinking", t.to_string()));
                                    }
                                }
                                Some("tool_use") => {
                                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                                    let input = b.get("input").cloned().unwrap_or(serde_json::Value::Null);
                                    blocks.push(tool_call_block(name, input));
                                }
                                _ => {}
                            }
                        }
                    }
                    if !blocks.is_empty() {
                        turns.push(TranscriptTurn { role: "assistant".into(), ts, blocks });
                    }
                }
                _ => {}
            }
        }
    }

    turns
}

/// Tail-first pagination over `parse_transcript_turns`: `cursor` is the index
/// (into the chronological array) of the oldest turn already returned; the
/// first call (`cursor: None`) starts at the end. Re-parses the full file on
/// every call (no cache) - the viewer opens deliberately, unlike the touched
/// panel/row count which fire on every selection.
#[tauri::command]
pub fn session_transcript(
    path: String,
    agent: String,
    cursor: Option<usize>,
) -> Result<TranscriptPage, String> {
    let all = parse_transcript_turns(&path, &agent);
    let end = cursor.unwrap_or(all.len()).min(all.len());
    let start = end.saturating_sub(TRANSCRIPT_PAGE);
    let mut turns: Vec<TranscriptTurn> = all[start..end].to_vec();
    turns.reverse();
    let next_cursor = if start > 0 { Some(start) } else { None };
    Ok(TranscriptPage { turns, next_cursor })
}

// --- Needs-you floor: transcript-tail state (Finding A, Tier 3 floor) ---
//
// Joined with PTY quiet (pty.rs's Activity) in the frontend (phase 2 task 4):
// quiet + BlockedCandidate -> needs-you; quiet + Done -> idle; an active PTY
// reads as Working regardless of tail state. This command answers only "what
// does the transcript's tail look like", agent-agnostic (reuses
// `parse_transcript_turns`, so it inherits both agents' parsers for free).

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TailState {
    #[serde(rename = "working")]
    Working,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "blocked-candidate")]
    BlockedCandidate,
}

/// Classify the last turn's shape: a trailing pending tool call (no result
/// turn after it) is a blocked-candidate; a trailing final assistant text is
/// done; anything else (no turns yet, a fresh human prompt, thinking cut
/// short, or a tool result awaiting the agent's next reply) is working - the
/// agent hasn't reached a resting state either way.
fn classify_tail(turns: &[TranscriptTurn]) -> TailState {
    let Some(last) = turns.last() else { return TailState::Working };
    if last.role != "assistant" {
        return TailState::Working;
    }
    match last.blocks.last().map(|b| b.kind.as_str()) {
        Some("tool_call") => TailState::BlockedCandidate,
        Some("text") => TailState::Done,
        _ => TailState::Working,
    }
}

/// `working` | `done` | `blocked-candidate`, capability-gated per adapter.
/// An agent whose `hooks` capability is on (claude - see `crate::hooks`)
/// gets its status from the injected hook's status file when one exists,
/// overriding the transcript-tail guess with claude's own ground-truth
/// signal; falls back to the tail join when no hook file exists yet (a
/// session just launched) or names an event with no mapped status.
/// Otherwise, an agent whose `needs_you` capability is off (its
/// blocked-quiet join was never verified, e.g. pi - see ADAPTERS.md) never
/// reports `blocked-candidate` from the tail join, collapsing to `working`
/// instead, so its dot caps at working rather than risking a false amber.
#[tauri::command]
pub fn session_tail_state(id: String, path: String, agent: String) -> Result<TailState, String> {
    let hooks_capable = agents::find(&agent).map(|a| a.hooks).unwrap_or(false);
    if hooks_capable {
        if let Some(state) = crate::hooks::status_for(&id) {
            return Ok(state);
        }
    }
    let turns = parse_transcript_turns(&path, &agent);
    let tail = classify_tail(&turns);
    let needs_you_capable = agents::find(&agent).map(|a| a.needs_you).unwrap_or(true);
    if tail == TailState::BlockedCandidate && !needs_you_capable {
        Ok(TailState::Working)
    } else {
        Ok(tail)
    }
}

// --- Checkpoint prompt-boundary detection (Finding E) ---
//
// Genuine human prompts only (reuses `is_human_prompt`, the same filter
// `session_detail`'s prompt_count uses), agent-agnostic via the same
// claude/pi branch other transcript readers use. The count lets a caller
// detect a rising edge (a *new* prompt arrived) without re-deriving it from
// raw turns; `last_ts` is the transcript timestamp a checkpoint snapshot is
// keyed by.

#[derive(Serialize)]
pub struct PromptTail {
    pub count: u32,
    pub last_ts: u64,
}

/// Count of genuine human prompts and the transcript timestamp of the most
/// recent one, agent-agnostic. Checkpoint boundaries are keyed by `last_ts`
/// (see checkpoint.rs); `count` lets a caller detect a new prompt without
/// tracking timestamps itself.
#[tauri::command]
pub fn session_prompt_tail(path: String, agent: String) -> Result<PromptTail, String> {
    if let Some((db_path, session_id)) = crate::opencode::parse_locator(&path) {
        return Ok(crate::opencode::prompt_tail(&db_path, session_id));
    }
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let kind = agents::parser_kind_for(&agent);
    let mut count = 0u32;
    let mut last_ts = 0u64;

    for line in reader.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_rfc3339_secs)
            .unwrap_or(0);

        let content = if kind == agents::ParserKind::PiJsonl {
            (v.get("type").and_then(|t| t.as_str()) == Some("message")
                && v.get("message").and_then(|m| m.get("role")).and_then(|r| r.as_str()) == Some("user"))
            .then(|| v.get("message").and_then(|m| m.get("content")).cloned())
            .flatten()
        } else {
            (v.get("type").and_then(|t| t.as_str()) == Some("user")
                && v.get("isMeta").and_then(|m| m.as_bool()) != Some(true))
            .then(|| v.get("message").and_then(|m| m.get("content")).cloned())
            .flatten()
        };

        if content.map(|c| is_human_prompt(&c)).unwrap_or(false) {
            count += 1;
            last_ts = ts;
        }
    }

    Ok(PromptTail { count, last_ts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn tmp_file(name: &str, contents: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_pi_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, contents).unwrap();
        p
    }

    fn meta(id: &str, cwd: &str, agent: &str, last_active: u64) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            path: format!("/sessions/{id}.jsonl"),
            cwd: cwd.into(),
            branch: String::new(),
            title: "t".into(),
            last_active,
            created_at: last_active,
            name: None,
            archived: false,
            agent: agent.into(),
        }
    }

    #[test]
    fn pi_session_parses_head_skips_envelopes_and_titles() {
        let body = r#"{"type":"session","version":3,"id":"abc123def456","timestamp":"2026-05-07T14:50:04.610Z","cwd":"/Users/x/proj/wt"}
{"type":"model_change","modelId":"m"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"<skill name=\"foo\">noise</skill>"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"[Context] file:///x/proj/wt/a.ts"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"  Fix the parser bug  "}]}}
"#;
        let p = tmp_file("2026-05-07T14-50-04_abc123def456.jsonl", body);
        let s = parse_pi_session(&p, SystemTime::now(), SystemTime::now(), "pi").expect("parsed");
        assert_eq!(s.agent, "pi");
        assert_eq!(s.id, "abc123def456");
        assert_eq!(s.cwd, "/Users/x/proj/wt");
        // Envelope + [Context] skipped; first real user message wins, trimmed.
        assert_eq!(s.title, "Fix the parser bug");
        // sessionFile path is carried.
        assert!(s.path.ends_with("abc123def456.jsonl"));
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn pi_empty_session_falls_back_to_id_slice() {
        let body =
            "{\"type\":\"session\",\"id\":\"0123456789abcdef\",\"cwd\":\"/Users/x/proj\"}\n";
        let p = tmp_file("ts_0123456789abcdef.jsonl", body);
        let s = parse_pi_session(&p, SystemTime::now(), SystemTime::now(), "pi").expect("parsed");
        assert_eq!(s.cwd, "/Users/x/proj");
        assert_eq!(s.title, "pi session 01234567"); // first 8 chars of the id
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn cwd_matches_exact_and_nested_only() {
        assert!(cwd_matches("/a/b", "/a/b")); // exact
        assert!(cwd_matches("/a/b/", "/a/b")); // trailing slash normalized
        assert!(cwd_matches("/a/b/c/d", "/a/b")); // nested
        assert!(!cwd_matches("/a/bc", "/a/b")); // sibling sharing a prefix
        assert!(!cwd_matches("/a", "/a/b")); // parent is not under child
    }

    #[test]
    fn filter_sort_merges_agents_under_folder_newest_first() {
        let all = vec![
            meta("claude-root", "/p/wt", "claude", 100),
            meta("pi-nested", "/p/wt/src", "pi", 300),
            meta("claude-old", "/p/wt", "claude", 50),
            meta("other", "/p/elsewhere", "claude", 999), // excluded
        ];
        let got = filter_sort(all, "/p/wt");
        let ids: Vec<&str> = got.iter().map(|s| s.id.as_str()).collect();
        // Excludes the non-matching folder; sorted newest-first.
        assert_eq!(ids, vec!["pi-nested", "claude-root", "claude-old"]);
        // Both agents are merged under the one folder.
        assert!(got.iter().any(|s| s.agent == "pi"));
        assert!(got.iter().any(|s| s.agent == "claude"));
    }

    #[test]
    fn seed_is_once_and_skips_empty() {
        let mut st = AdoptedState::default();
        // Empty discovery never seeds (so a forced empty resolve cannot lock in).
        assert!(!do_seed(&mut st, &[]));
        assert!(!st.seeded);
        // First real discovery seeds every folder.
        let folders = vec!["/p/a".to_string(), "/p/b/".to_string()];
        assert!(do_seed(&mut st, &folders));
        assert!(st.seeded);
        assert!(st.paths.contains("/p/a"));
        assert!(st.paths.contains("/p/b")); // trailing slash normalized
        // Idempotent: a later discovery does not re-seed (a new folder added then
        // is judged on its own, not blanket-adopted).
        assert!(!do_seed(&mut st, &["/p/c".to_string()]));
        assert!(!st.paths.contains("/p/c"));
    }

    #[test]
    fn verdict_adopted_when_in_set_or_no_sessions() {
        let mut set = HashSet::new();
        set.insert("/p/a".to_string());
        assert!(matches!(folder_verdict(&set, "/p/a", &[50], 100), FolderVerdict::Adopted));
        // Not in the set but no sessions: nothing to hide.
        assert!(matches!(folder_verdict(&set, "/p/b", &[], 100), FolderVerdict::Adopted));
    }

    #[test]
    fn verdict_autoadopt_when_all_postdate_else_historical() {
        let set = HashSet::new();
        // All sessions postdate the folder's creation: they are ours.
        assert!(matches!(folder_verdict(&set, "/p/a", &[150, 200], 100), FolderVerdict::AutoAdopt));
        // A session predating creation: a recreated folder with ghosts.
        assert!(matches!(folder_verdict(&set, "/p/a", &[50, 200], 100), FolderVerdict::Historical));
    }

    /// Does `pattern` (an extended regex passed to `pgrep -f`) match `cmdline`?
    /// Verified via the system's own ERE engine (`grep -E`), the same dialect
    /// BSD `pgrep -f` uses natively, so the test exercises real matching
    /// behavior without a Rust regex dependency.
    fn ere_matches(pattern: &str, cmdline: &str) -> bool {
        Command::new("sh")
            .arg("-c")
            .arg(format!("printf '%s' '{cmdline}' | grep -Eq -- '{pattern}'"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[test]
    fn session_pattern_claude_matches_resume_and_alias_not_transcript_view() {
        let id = "abc-123-def";
        let pat = session_pattern("claude", id);
        assert!(ere_matches(&pat, "claude --resume abc-123-def"));
        assert!(ere_matches(&pat, "claude -r abc-123-def")); // -r alias
        // Trailing flags after the id still match (no end anchor).
        assert!(ere_matches(&pat, "claude --resume abc-123-def --dangerously-skip-permissions"));
        // A transcript merely opened in `less` must NOT match - the bare-uuid
        // pgrep collision this pattern replaces.
        assert!(!ere_matches(&pat, "less /Users/x/.claude/projects/-Users-x-proj/abc-123-def.jsonl"));
    }

    #[test]
    fn session_pattern_pi_matches_session_file_not_transcript_view() {
        let id = "0123456789abcdef";
        let pat = session_pattern("pi", id);
        assert!(ere_matches(
            &pat,
            "pi --session /Users/x/.pi/agent/sessions/-Users-x-proj/2026-05-07T14-50-04_0123456789abcdef.jsonl"
        ));
        assert!(!ere_matches(
            &pat,
            "less /Users/x/.pi/agent/sessions/-Users-x-proj/2026-05-07T14-50-04_0123456789abcdef.jsonl"
        ));
    }

    #[test]
    fn watch_dirs_covers_both_agent_roots() {
        let dirs = watch_dirs();
        assert!(dirs.iter().any(|p| p.ends_with(".claude/projects")));
        assert!(dirs.iter().any(|p| p.ends_with(".pi/agent/sessions")));
    }

    #[test]
    fn parse_rfc3339_secs_matches_known_values() {
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_secs("2026-07-12T21:30:57.357Z"), Some(1783891857));
        assert_eq!(parse_rfc3339_secs("2000-02-29T00:00:00Z"), Some(951782400)); // leap day
        assert_eq!(parse_rfc3339_secs("2026-01-01T00:00:00Z"), Some(1767225600));
        assert_eq!(parse_rfc3339_secs("not-a-timestamp"), None);
        assert_eq!(parse_rfc3339_secs("2026-07-12"), None); // too short
    }

    #[test]
    fn infer_bash_touch_covers_sed_redirect_and_rm_only() {
        assert_eq!(
            infer_bash_touch("sed -i '' 's/a/b/' src/app.rs"),
            Some(("src/app.rs".to_string(), TouchOp::Edit))
        );
        // GNU form (no backup-extension arg after -i).
        assert_eq!(
            infer_bash_touch("sed -i 's/a/b/' file.txt"),
            Some(("file.txt".to_string(), TouchOp::Edit))
        );
        assert_eq!(
            infer_bash_touch("echo hi > out.txt"),
            Some(("out.txt".to_string(), TouchOp::Create))
        );
        assert_eq!(
            infer_bash_touch("echo hi >> out.txt"),
            Some(("out.txt".to_string(), TouchOp::Edit))
        );
        assert_eq!(
            infer_bash_touch("rm -f stale.log"),
            Some(("stale.log".to_string(), TouchOp::Delete))
        );
        // Not one of the three covered shapes: no touch inferred.
        assert_eq!(infer_bash_touch("npm install"), None);
        assert_eq!(infer_bash_touch("mv a.txt b.txt"), None);
    }

    #[test]
    fn normalize_touch_path_resolves_relative_against_cwd_leaves_absolute() {
        assert_eq!(normalize_touch_path("src/app.rs", "/Users/x/proj"), "/Users/x/proj/src/app.rs");
        assert_eq!(normalize_touch_path("./src/app.rs", "/Users/x/proj"), "/Users/x/proj/src/app.rs");
        assert_eq!(
            normalize_touch_path("/Users/x/proj/src/app.rs", "/Users/x/proj"),
            "/Users/x/proj/src/app.rs"
        );
        // Trailing slash on cwd doesn't double up.
        assert_eq!(normalize_touch_path("src/app.rs", "/Users/x/proj/"), "/Users/x/proj/src/app.rs");
    }

    #[test]
    fn extract_touched_files_claude_dedupes_bash_sed_against_absolute_edit() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:00.000Z","message":{"content":[{"type":"text","text":"go"}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/Users/x/proj/new.txt","content":"hi"}}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:10.000Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"sed -i '' 's/a/b/' src/app.rs"}}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:15.000Z","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/Users/x/proj/src/app.rs","old_string":"a","new_string":"b"}}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:20.000Z","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/x/proj/README.md"}}]}}
"#;
        let p = tmp_file("claude_touch.jsonl", body);
        let files = extract_touched_files(p.to_str().unwrap(), "claude");

        // The Bash sed (relative `src/app.rs`) and the absolute Edit dedupe onto
        // the same normalized path, not two entries.
        let app_rs = files
            .iter()
            .find(|f| f.path == "/Users/x/proj/src/app.rs")
            .expect("bash sed + absolute edit dedupe onto one path");
        assert_eq!(app_rs.op, TouchOp::Edit);
        assert_eq!(app_rs.count, 2);

        let new_txt = files.iter().find(|f| f.path == "/Users/x/proj/new.txt").expect("write recorded");
        assert_eq!(new_txt.op, TouchOp::Create);

        let readme = files.iter().find(|f| f.path == "/Users/x/proj/README.md").expect("read recorded");
        assert_eq!(readme.op, TouchOp::Read);

        // touched_count's own filter: reads excluded.
        assert_eq!(files.iter().filter(|f| f.op != TouchOp::Read).count(), 2);

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    fn touched(path: &str, op: TouchOp, last_ts: u64) -> TouchedFile {
        TouchedFile {
            path: path.into(),
            op,
            first_ts: last_ts,
            last_ts,
            count: 1,
        }
    }

    #[test]
    fn latest_written_picks_the_newest_write_and_ignores_a_newer_read() {
        // The read is the newest touch overall, but the indicator must name the
        // file being *changed*, not the one being looked at.
        let files = vec![
            touched("/p/old.rs", TouchOp::Edit, 100),
            touched("/p/new.rs", TouchOp::Create, 200),
            touched("/p/looked-at.rs", TouchOp::Read, 300),
        ];
        assert_eq!(latest_written(&files).unwrap().path, "/p/new.rs");
    }

    #[test]
    fn latest_written_is_none_when_the_session_only_read() {
        let files = vec![
            touched("/p/a.rs", TouchOp::Read, 100),
            touched("/p/b.rs", TouchOp::Read, 200),
        ];
        assert!(latest_written(&files).is_none());
        assert!(latest_written(&[]).is_none());
    }

    #[test]
    fn latest_written_does_not_depend_on_input_order() {
        // extract_touched_files sorts newest-first, but the helper must not rely
        // on that - a caller that filtered or reordered still gets the max.
        let files = vec![
            touched("/p/newest.rs", TouchOp::Edit, 300),
            touched("/p/mid.rs", TouchOp::Delete, 200),
        ];
        let reversed: Vec<TouchedFile> = files.iter().rev().cloned().collect();
        assert_eq!(latest_written(&files).unwrap().path, "/p/newest.rs");
        assert_eq!(latest_written(&reversed).unwrap().path, "/p/newest.rs");
    }

    #[test]
    fn extract_touched_files_pi_maps_lowercase_tools_and_keeps_write_over_later_read() {
        let body = r#"{"type":"session","id":"pi1","cwd":"/Users/y/proj","timestamp":"2026-07-12T10:00:00.000Z"}
{"type":"message","timestamp":"2026-07-12T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"1","name":"write","arguments":{"path":"/Users/y/proj/out.txt","content":"hi"}}]}}
{"type":"message","timestamp":"2026-07-12T10:00:10.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"2","name":"read","arguments":{"path":"/Users/y/proj/out.txt"}}]}}
"#;
        let p = tmp_file("pi_touch.jsonl", body);
        let files = extract_touched_files(p.to_str().unwrap(), "pi");

        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "/Users/y/proj/out.txt");
        // A later Read never downgrades the earlier write - still shows Create.
        assert_eq!(f.op, TouchOp::Create);
        assert_eq!(f.count, 2);
        assert!(f.last_ts > f.first_ts);

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn touched_files_cached_returns_cached_entry_when_mtime_matches() {
        let body = "{\"type\":\"session\",\"id\":\"real\",\"cwd\":\"/x\"}\n";
        let p = tmp_file("cache_hit.jsonl", body);
        let mtime = std::fs::metadata(&p).unwrap().modified().unwrap();

        let index = TouchedIndex::default();
        // Prime the cache with a fake entry at the file's real (current) mtime.
        {
            let mut cache = index.0.lock().unwrap();
            cache.insert(
                p.clone(),
                TouchedCacheEntry {
                    mtime,
                    files: vec![TouchedFile {
                        path: "/fake/cached.txt".to_string(),
                        op: TouchOp::Edit,
                        first_ts: 1,
                        last_ts: 1,
                        count: 9,
                    }],
                },
            );
        }

        let files = touched_files_cached(&index, p.to_str().unwrap(), "pi");
        // The fake cached entry came back untouched - a re-parse would have
        // returned nothing (the fixture has no tool calls at all).
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "/fake/cached.txt");
        assert_eq!(files[0].count, 9);

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn touched_files_cached_reparses_when_mtime_is_stale() {
        let body = r#"{"type":"session","id":"real","cwd":"/y","timestamp":"2026-07-12T10:00:00.000Z"}
{"type":"message","timestamp":"2026-07-12T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"1","name":"write","arguments":{"path":"/y/real.txt"}}]}}
"#;
        let p = tmp_file("cache_stale.jsonl", body);

        let index = TouchedIndex::default();
        {
            let mut cache = index.0.lock().unwrap();
            cache.insert(
                p.clone(),
                TouchedCacheEntry {
                    mtime: SystemTime::UNIX_EPOCH, // deliberately stale
                    files: vec![TouchedFile {
                        path: "/fake/cached.txt".to_string(),
                        op: TouchOp::Edit,
                        first_ts: 1,
                        last_ts: 1,
                        count: 9,
                    }],
                },
            );
        }

        let files = touched_files_cached(&index, p.to_str().unwrap(), "pi");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "/y/real.txt"); // re-parsed the real fixture, not the stale cache

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn parse_transcript_turns_claude_orders_text_thinking_tool_use_and_result() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:00.000Z","message":{"content":"fix the bug"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:05.000Z","message":{"content":[{"type":"thinking","thinking":"let me look"},{"type":"text","text":"looking now"},{"type":"tool_use","name":"Read","input":{"file_path":"/Users/x/proj/a.rs"}}]}}
{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:10.000Z","isMeta":false,"message":{"content":[{"type":"tool_result","content":"file contents","is_error":false}]}}
{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:12.000Z","isMeta":true,"message":{"content":"skipped: meta noise"}}
"#;
        let p = tmp_file("claude_transcript.jsonl", body);
        let turns = parse_transcript_turns(p.to_str().unwrap(), "claude");

        // isMeta is dropped; the other 3 lines parse, chronological (oldest-first).
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[0].blocks[0].kind, "text");
        assert_eq!(turns[0].blocks[0].text.as_deref(), Some("fix the bug"));

        assert_eq!(turns[1].role, "assistant");
        let kinds: Vec<&str> = turns[1].blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["thinking", "text", "tool_call"]);
        assert_eq!(turns[1].blocks[2].tool_name.as_deref(), Some("Read"));

        assert_eq!(turns[2].role, "user");
        assert_eq!(turns[2].blocks[0].kind, "tool_result");
        assert_eq!(turns[2].blocks[0].text.as_deref(), Some("file contents"));
        assert_eq!(turns[2].blocks[0].is_error, Some(false));

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn parse_transcript_turns_pi_maps_toolcall_and_standalone_toolresult() {
        let body = r#"{"type":"session","id":"pi1","cwd":"/Users/y/proj","timestamp":"2026-07-12T10:00:00.000Z"}
{"type":"message","timestamp":"2026-07-12T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"add a test"}]}}
{"type":"message","timestamp":"2026-07-12T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"on it"},{"type":"toolCall","id":"1","name":"write","arguments":{"path":"/Users/y/proj/t.rs"}}]}}
{"type":"message","timestamp":"2026-07-12T10:00:08.000Z","message":{"role":"toolResult","toolCallId":"1","toolName":"write","content":"ok","isError":false}}
"#;
        let p = tmp_file("pi_transcript.jsonl", body);
        let turns = parse_transcript_turns(p.to_str().unwrap(), "pi");

        // The `session` line carries no turn; the 3 message lines parse in order.
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[1].role, "assistant");
        assert_eq!(turns[1].blocks[1].kind, "tool_call");
        assert_eq!(turns[1].blocks[1].tool_name.as_deref(), Some("write"));

        // pi's toolResult is a standalone message, mapped to its own "tool" turn.
        assert_eq!(turns[2].role, "tool");
        assert_eq!(turns[2].blocks[0].kind, "tool_result");
        assert_eq!(turns[2].blocks[0].tool_name.as_deref(), Some("write"));
        assert_eq!(turns[2].blocks[0].text.as_deref(), Some("ok"));

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_claude_pending_tool_use_is_blocked_candidate() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"run the tests"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":[{"type":"text","text":"On it."},{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}
"#;
        let p = tmp_file("claude_tail_pending.jsonl", body);
        // claude's needs_you capability is on, so the join surfaces directly.
        // No hook status file exists for this id, so the hooks capability
        // falls through to the tail join too.
        assert_eq!(session_tail_state("no-hook-file-1".into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(), TailState::BlockedCandidate);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_claude_final_text_is_done() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"what does main.rs do?"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/x/proj/main.rs"}}]}}
{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:06.000Z","isMeta":false,"message":{"content":[{"type":"tool_result","content":"fn main() {}","is_error":false}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:08.000Z","message":{"content":[{"type":"text","text":"It's an empty entry point."}]}}
"#;
        let p = tmp_file("claude_tail_done.jsonl", body);
        assert_eq!(session_tail_state("no-hook-file-2".into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(), TailState::Done);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_pi_pending_tool_use_is_capability_gated_to_working() {
        let body = r#"{"type":"session","id":"pi1","cwd":"/Users/y/proj","timestamp":"2026-07-18T10:00:00.000Z"}
{"type":"message","timestamp":"2026-07-18T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"run the tests"}]}}
{"type":"message","timestamp":"2026-07-18T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"On it."},{"type":"toolCall","id":"1","name":"bash","arguments":{"command":"npm test"}}]}}
"#;
        let p = tmp_file("pi_tail_pending.jsonl", body);
        // The raw transcript shape is identical to claude's blocked-candidate case,
        // but pi's needs_you capability is off (findings.md: pi's built-in tools
        // never observably block), so the join collapses to working instead of
        // risking a false amber.
        assert_eq!(session_tail_state("no-hook-file-3".into(), p.to_str().unwrap().to_string(), "pi".into()).unwrap(), TailState::Working);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_pi_final_text_is_done() {
        let body = r#"{"type":"session","id":"pi1","cwd":"/Users/y/proj","timestamp":"2026-07-18T10:00:00.000Z"}
{"type":"message","timestamp":"2026-07-18T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"what does main.rs do?"}]}}
{"type":"message","timestamp":"2026-07-18T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"1","name":"read","arguments":{"path":"/Users/y/proj/main.rs"}}]}}
{"type":"message","timestamp":"2026-07-18T10:00:06.000Z","message":{"role":"toolResult","toolCallId":"1","toolName":"read","content":"fn main() {}","isError":false}}
{"type":"message","timestamp":"2026-07-18T10:00:08.000Z","message":{"role":"assistant","content":[{"type":"text","text":"It's an empty entry point."}]}}
"#;
        let p = tmp_file("pi_tail_done.jsonl", body);
        // Done doesn't depend on the needs_you capability at all.
        assert_eq!(session_tail_state("no-hook-file-4".into(), p.to_str().unwrap().to_string(), "pi".into()).unwrap(), TailState::Done);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_fresh_prompt_with_no_reply_yet_is_working() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"hello"}}
"#;
        let p = tmp_file("claude_tail_fresh.jsonl", body);
        assert_eq!(session_tail_state("no-hook-file-5".into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(), TailState::Working);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_claude_hook_file_overrides_the_tail_join() {
        // A transcript tail that would classify as Done...
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"go"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":[{"type":"text","text":"Done."}]}}
"#;
        let p = tmp_file("claude_tail_hook_override.jsonl", body);
        let id = "sess-hook-override-test";
        std::fs::create_dir_all(dirs::home_dir().unwrap().join(".config/sway/hooks-status")).unwrap();
        std::fs::write(
            dirs::home_dir().unwrap().join(format!(".config/sway/hooks-status/{id}.json")),
            r#"{"event":"Notification","at":1}"#,
        )
        .unwrap();

        // ...but claude's `hooks` capability makes the injected Notification
        // event authoritative instead: BlockedCandidate, not Done.
        assert_eq!(
            session_tail_state(id.into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(),
            TailState::BlockedCandidate
        );
        // pi has no `hooks` capability: the same hook file (if one somehow
        // existed under pi's id) would never be consulted, it stays on the
        // tail join - covered already by the pi tests above.

        std::fs::remove_file(dirs::home_dir().unwrap().join(format!(".config/sway/hooks-status/{id}.json"))).ok();
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_transcript_cursor_returns_preceding_window() {
        // 3 user turns, one per line, oldest-first.
        let body = (0..3)
            .map(|i| {
                format!(
                    r#"{{"type":"user","cwd":"/p","timestamp":"2026-07-12T10:00:0{i}.000Z","message":{{"content":"turn {i}"}}}}"#
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let p = tmp_file("cursor.jsonl", &body);
        let path = p.to_str().unwrap();

        // First page (no cursor) is capped by TRANSCRIPT_PAGE (3 turns fit in
        // one page), so it returns everything newest-first with no next cursor.
        let page = session_transcript(path.to_string(), "claude".to_string(), None).unwrap();
        assert_eq!(page.turns.len(), 3);
        assert_eq!(page.turns[0].blocks[0].text.as_deref(), Some("turn 2")); // newest first
        assert_eq!(page.next_cursor, None);

        // A cursor mid-way returns exactly the preceding window, oldest turn
        // excluded from the next page's tail (start == 0 => no further cursor).
        let page2 = session_transcript(path.to_string(), "claude".to_string(), Some(2)).unwrap();
        assert_eq!(page2.turns.len(), 2);
        assert_eq!(page2.turns[0].blocks[0].text.as_deref(), Some("turn 1"));
        assert_eq!(page2.turns[1].blocks[0].text.as_deref(), Some("turn 0"));
        assert_eq!(page2.next_cursor, None);

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn prompt_tail_counts_only_genuine_human_text_claude() {
        let body = r#"{"type":"user","cwd":"/p","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"first prompt"}}
{"type":"assistant","cwd":"/p","timestamp":"2026-07-18T10:00:02.000Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","cwd":"/p","timestamp":"2026-07-18T10:00:03.000Z","isMeta":false,"message":{"content":[{"type":"tool_result","content":"a.txt","is_error":false}]}}
{"type":"user","cwd":"/p","timestamp":"2026-07-18T10:00:04.000Z","message":{"content":"[Context] file:///p/a.txt"}}
{"type":"user","cwd":"/p","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":"second prompt"}}
"#;
        let p = tmp_file("prompt_tail_claude.jsonl", body);
        let tail = session_prompt_tail(p.to_str().unwrap().to_string(), "claude".into()).unwrap();
        // A tool_result envelope and a [Context] block are not human prompts.
        assert_eq!(tail.count, 2);
        assert_eq!(tail.last_ts, parse_rfc3339_secs("2026-07-18T10:00:05.000Z").unwrap());
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn prompt_tail_counts_only_genuine_human_text_pi() {
        let body = r#"{"type":"message","timestamp":"2026-07-18T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"first prompt"}]}}
{"type":"message","timestamp":"2026-07-18T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"1","name":"read","arguments":{"path":"/p/a.txt"}}]}}
{"type":"message","timestamp":"2026-07-18T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"1","toolName":"read","content":"a","isError":false}}
{"type":"message","timestamp":"2026-07-18T10:00:04.000Z","message":{"role":"user","content":[{"type":"text","text":"second prompt"}]}}
"#;
        let p = tmp_file("prompt_tail_pi.jsonl", body);
        let tail = session_prompt_tail(p.to_str().unwrap().to_string(), "pi".into()).unwrap();
        assert_eq!(tail.count, 2);
        assert_eq!(tail.last_ts, parse_rfc3339_secs("2026-07-18T10:00:04.000Z").unwrap());
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }
}
