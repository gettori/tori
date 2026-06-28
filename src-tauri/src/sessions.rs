// Claude session discovery. Sessions live at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. The encoded dir name is
// lossy (both '/' and '.' collapse to '-'), so we read `cwd` and `gitBranch`
// from inside each file rather than decoding the folder name.
//
// Scanning reads only the head of each file (cwd/branch/first prompt appear
// early) and caches by mtime, so repeat scans are cheap.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
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
}

struct CacheEntry {
    mtime: SystemTime,
    meta: Option<SessionMeta>,
}

#[derive(Default)]
pub struct SessionIndex(Mutex<HashMap<PathBuf, CacheEntry>>);

#[derive(Default)]
pub struct SessionWatch(pub Mutex<Option<RecommendedWatcher>>);

fn projects_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/projects")
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

#[tauri::command]
pub fn list_sessions(
    index: State<SessionIndex>,
    project_path: String,
    branch: String,
) -> Result<Vec<SessionMeta>, String> {
    let target_cwd = norm(&project_path);
    let overlay = load_overlay();
    let mut sessions: Vec<SessionMeta> = ensure_index(&index)
        .into_iter()
        .filter(|s| norm(&s.cwd) == target_cwd && s.branch == branch)
        .map(|mut s| {
            if let Some(o) = overlay.get(&s.id) {
                s.name = o.name.clone();
                s.archived = o.archived;
            }
            s
        })
        .collect();
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(sessions)
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
    let out = Command::new("pgrep")
        .args(["-f", &format!("--resume {id}")])
        .output();
    Ok(out
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false))
}

#[derive(Serialize)]
pub struct SessionDetail {
    pub message_count: u32,
    pub output_tokens: u64,
    pub context_tokens: u64,
    pub model: Option<String>,
}

/// Read the full transcript once (only on selection) for counts and tokens.
#[tauri::command]
pub fn session_detail(path: String) -> Result<SessionDetail, String> {
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut message_count = 0u32;
    let mut output_tokens = 0u64;
    let mut context_tokens = 0u64;
    let mut model: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = v.get("type").and_then(|t| t.as_str());
        if kind == Some("user") || kind == Some("assistant") {
            if v.get("isMeta").and_then(|m| m.as_bool()) != Some(true) {
                message_count += 1;
            }
        }
        if kind == Some("assistant") {
            if let Some(msg) = v.get("message") {
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

    Ok(SessionDetail {
        message_count,
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
