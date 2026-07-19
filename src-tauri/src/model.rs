// Accurate per-model context windows, sourced from OpenRouter. pi routes to
// many providers and its model ids are OpenRouter-format (`provider/model`),
// and OpenRouter publishes `context_length` per model. We fetch that list once
// a day, cache it to disk, and serve it to the toolbar so the "ctx X/cap (%)"
// readout reflects the real window of whatever model a session is on.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

fn cache_path() -> Option<PathBuf> {
    let dir = dirs::cache_dir()?.join("sway");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("openrouter-models.json"))
}

/// Pull `id -> context_length` from OpenRouter's public model list.
fn fetch_caps() -> Result<HashMap<String, u64>, String> {
    let body = ureq::get(MODELS_URL)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "unexpected OpenRouter response".to_string())?;

    let mut map = HashMap::new();
    for m in arr {
        if let (Some(id), Some(cl)) = (
            m.get("id").and_then(|i| i.as_str()),
            m.get("context_length").and_then(|c| c.as_u64()),
        ) {
            if cl > 0 {
                map.insert(id.to_string(), cl);
            }
        }
    }
    Ok(map)
}

fn read_cache(path: &PathBuf) -> Option<HashMap<String, u64>> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn cache_is_fresh(path: &PathBuf) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|age| age < MAX_AGE)
        .unwrap_or(false)
}

/// `model id -> context window`. Served from a <24h disk cache when fresh;
/// otherwise refreshed from OpenRouter (falling back to a stale cache, then an
/// empty map, so a network failure never blocks the UI; the frontend applies
/// its own defaults for anything missing).
///
/// `async` is load-bearing: a Tauri command without it runs on the **main
/// thread**, so the cold-cache fetch below would freeze the window while the
/// toolbar mounts. Same reason `check_for_update` is async, and like that one
/// the request itself is blocking, so it carries an explicit timeout rather
/// than relying on the caller to give up.
#[tauri::command]
pub async fn model_context_caps() -> Result<HashMap<String, u64>, String> {
    let path = match cache_path() {
        Some(p) => p,
        None => return fetch_caps().or_else(|_| Ok(HashMap::new())),
    };

    if cache_is_fresh(&path) {
        if let Some(map) = read_cache(&path) {
            return Ok(map);
        }
    }

    match fetch_caps() {
        Ok(map) => {
            if let Ok(bytes) = serde_json::to_vec(&map) {
                let _ = std::fs::write(&path, bytes);
            }
            Ok(map)
        }
        // Network failed: serve whatever we cached before, even if stale.
        Err(_) => Ok(read_cache(&path).unwrap_or_default()),
    }
}
