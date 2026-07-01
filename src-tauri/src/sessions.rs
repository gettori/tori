// Session discovery for two agents, merged by folder.
//
// Claude sessions live at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl;
// pi sessions live at ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl. Both
// encoded dir names are lossy, so we read `cwd` (and Claude's `gitBranch`) from
// inside each file rather than decoding the folder name. Pi has no branch.
//
// Scanning reads only the head of each file (cwd/branch/first prompt appear
// early) and caches by mtime, so repeat scans are cheap. `list_sessions(folder)`
// returns both agents whose recorded cwd is the folder or nested under it.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

const HEAD_LINES: usize = 60;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub path: String,
    pub cwd: String,
    pub branch: String,
    pub title: String,
    pub last_active: u64,
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
pub struct PiIndex(Mutex<HashMap<PathBuf, CacheEntry>>);

#[derive(Default)]
pub struct SessionWatch(pub Mutex<Option<RecommendedWatcher>>);

fn projects_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/projects")
}

fn pi_sessions_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".pi/agent/sessions")
}

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
fn is_human_prompt(content: &serde_json::Value) -> bool {
    match extract_text(content) {
        Some(t) => {
            let t = t.trim();
            !t.is_empty() && !t.starts_with('<') && !t.starts_with("[Context]")
        }
        None => false,
    }
}

fn clean_title(raw: &str) -> String {
    let one_line: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 90 {
        let truncated: String = one_line.chars().take(90).collect();
        format!("{truncated}…")
    } else {
        one_line
    }
}

fn parse_session(path: &PathBuf, mtime: SystemTime) -> Option<SessionMeta> {
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
        name: None,
        archived: false,
        agent: "claude".into(),
    })
}

/// Walk all project dirs, refreshing the cache for changed/new files.
fn ensure_index(index: &SessionIndex) -> Vec<SessionMeta> {
    let mut cache = match index.0.lock() {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut seen: Vec<PathBuf> = Vec::new();
    let root = projects_dir();

    if let Ok(dirs) = std::fs::read_dir(&root) {
        for dir in dirs.flatten() {
            let p = dir.path();
            if !p.is_dir() {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(&p) {
                for f in files.flatten() {
                    let fp = f.path();
                    if fp.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let mtime = f
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(SystemTime::UNIX_EPOCH);
                    seen.push(fp.clone());

                    let fresh = cache.get(&fp).map(|e| e.mtime == mtime).unwrap_or(false);
                    if !fresh {
                        let meta = parse_session(&fp, mtime);
                        cache.insert(fp.clone(), CacheEntry { mtime, meta });
                    }
                }
            }
        }
    }

    // Drop entries whose files disappeared.
    cache.retain(|k, _| seen.contains(k));

    cache.values().filter_map(|e| e.meta.clone()).collect()
}

/// Parse a pi session: head line carries `id`/`cwd`/`timestamp`; the title comes
/// from the first real user message in a bounded window, falling back to an
/// id-slice for an empty session. last_active uses the file mtime (a better
/// "last activity" signal than the head timestamp, and no ISO parse needed).
fn parse_pi_session(path: &PathBuf, mtime: SystemTime) -> Option<SessionMeta> {
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
        name: None,
        archived: false,
        agent: "pi".into(),
    })
}

/// Walk all pi session dirs, refreshing the cache for changed/new files.
fn ensure_pi_index(index: &PiIndex) -> Vec<SessionMeta> {
    let mut cache = match index.0.lock() {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut seen: Vec<PathBuf> = Vec::new();
    let root = pi_sessions_dir();

    if let Ok(dirs) = std::fs::read_dir(&root) {
        for dir in dirs.flatten() {
            let p = dir.path();
            if !p.is_dir() {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(&p) {
                for f in files.flatten() {
                    let fp = f.path();
                    if fp.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let mtime = f
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(SystemTime::UNIX_EPOCH);
                    seen.push(fp.clone());

                    let fresh = cache.get(&fp).map(|e| e.mtime == mtime).unwrap_or(false);
                    if !fresh {
                        let meta = parse_pi_session(&fp, mtime);
                        cache.insert(fp.clone(), CacheEntry { mtime, meta });
                    }
                }
            }
        }
    }

    cache.retain(|k, _| seen.contains(k));
    cache.values().filter_map(|e| e.meta.clone()).collect()
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

/// Sessions (both agents) anchored at `folder` or nested under it, newest first.
#[tauri::command]
pub fn list_sessions(
    index: State<SessionIndex>,
    pi_index: State<PiIndex>,
    folder: String,
) -> Result<Vec<SessionMeta>, String> {
    let overlay = load_overlay();
    let merged: Vec<SessionMeta> = ensure_index(&index)
        .into_iter()
        .chain(ensure_pi_index(&pi_index))
        .collect();
    let sessions = filter_sort(merged, &folder)
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
    pi_index: State<PiIndex>,
    folder: String,
) -> Result<bool, String> {
    let state = load_adopted();
    let merged: Vec<SessionMeta> = ensure_index(&index)
        .into_iter()
        .chain(ensure_pi_index(&pi_index))
        .collect();
    let times: Vec<u64> = filter_sort(merged, &folder)
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
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Is a `claude --resume <id>` process currently running?
#[tauri::command]
pub fn session_running(id: String) -> Result<bool, String> {
    // The session id appears in both agents' live command lines: Claude as
    // `claude --resume <id>`, pi as `pi --session <…/<ts>_<id>.jsonl>`. Matching
    // the bare id (a uuid, so no realistic collision) detects either.
    let out = Command::new("pgrep").args(["-f", &id]).output();
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
}

/// Read the full transcript once (only on selection) for counts and tokens.
/// Handles both transcript shapes: Claude tags user/assistant at the top level
/// with a `{output,input,cache_*}_tokens` usage; pi wraps each turn in a
/// `type:"message"` envelope with `message.role` and a `{input,output,cacheRead,
/// cacheWrite}` usage. Each line is dispatched by shape so one pass covers both.
#[tauri::command]
pub fn session_detail(path: String) -> Result<SessionDetail, String> {
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

    Ok(SessionDetail {
        prompt_count,
        turn_count,
        tool_count,
        output_tokens,
        context_tokens,
        model,
    })
}

#[tauri::command]
pub fn sessions_watch_start(
    app: AppHandle,
    state: State<SessionWatch>,
) -> Result<(), String> {
    let root = projects_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

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

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
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
        let s = parse_pi_session(&p, SystemTime::now()).expect("parsed");
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
        let s = parse_pi_session(&p, SystemTime::now()).expect("parsed");
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
}
