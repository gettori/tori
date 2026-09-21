// Which projects may run their own code through a language server. Kept in
// Tori's config directory and never in the project, because a flag the repo
// could ship would let the repo answer for itself.

use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::lsp::registry::LspServer;

/// What `lsp_start` refuses a gated server with. `utils/projectTrust.ts`
/// matches it exactly.
pub const UNTRUSTED: &str = "untrusted";

#[derive(Serialize, Deserialize, Default)]
struct TrustStore {
    trusted: Vec<String>,
}

// Every read of the store can write it (the first one seeds), so a trust and a
// seed landing together would otherwise drop one of them.
static STORE: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    STORE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn store_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/tori/trusted.json")
}

fn save(file: &Path, store: &TrustStore) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(file, &text)
}

fn load_or_seed(file: &Path, discover: impl FnOnce() -> Vec<PathBuf>) -> TrustStore {
    match std::fs::read_to_string(file) {
        // Damaged is not the same as absent: re-seeding would trust every
        // project, and a file that no longer parses is nobody's consent.
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        // No store means trust is new in this build. The projects already here
        // have been running these servers ungated all along, so they keep them.
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let store = TrustStore {
                trusted: discover().iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            };
            if let Err(e) = save(file, &store) {
                eprintln!("tori: could not write {}: {e}", file.display());
            }
            store
        }
        Err(_) => TrustStore::default(),
    }
}

fn covers(store: &TrustStore, project: &Path) -> bool {
    // `starts_with` compares components without resolving `..`, so
    // `/trusted/../other` would otherwise read as inside `/trusted`.
    if project.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    // An empty entry is a prefix of every path, so a hand-edited one must not
    // trust the whole disk.
    store.trusted.iter().filter(|t| !t.is_empty()).any(|t| project.starts_with(t))
}

// Trust goes to the discovered `<root>/<space>/<project>`, not to the worktree a
// file was opened from, so one answer covers every worktree of that project.
fn scope(path: &Path, root: Option<&Path>) -> PathBuf {
    if let Some(root) = root {
        if let Ok(rest) = path.strip_prefix(root) {
            let mut parts = rest.components();
            if let (Some(space), Some(project)) = (parts.next(), parts.next()) {
                return root.join(space).join(project);
            }
        }
    }
    path.to_path_buf()
}

fn gate_at(
    file: &Path,
    discover: impl FnOnce() -> Vec<PathBuf>,
    server: &LspServer,
    project: &Path,
) -> Result<(), String> {
    if !server.runs_project_code {
        return Ok(());
    }
    let _guard = lock();
    if covers(&load_or_seed(file, discover), project) {
        Ok(())
    } else {
        Err(UNTRUSTED.to_string())
    }
}

fn trust_at(
    file: &Path,
    discover: impl FnOnce() -> Vec<PathBuf>,
    root: Option<&Path>,
    path: &Path,
) -> Result<String, String> {
    let scope = scope(path, root).to_string_lossy().into_owned();
    let _guard = lock();
    let mut store = load_or_seed(file, discover);
    if !store.trusted.contains(&scope) {
        store.trusted.push(scope.clone());
        save(file, &store)?;
    }
    Ok(scope)
}

fn revoke_at(file: &Path, discover: impl FnOnce() -> Vec<PathBuf>, path: &str) -> Result<(), String> {
    let _guard = lock();
    let mut store = load_or_seed(file, discover);
    store.trusted.retain(|t| t != path);
    save(file, &store)
}

/// Create the store if it does not exist yet, trusting every project already
/// discovered.
pub fn seed() {
    let _guard = lock();
    load_or_seed(&store_path(), crate::config::discovered_project_dirs);
}

/// Refuse a server that runs project code in a project the user has not
/// trusted. Called before anything is spawned.
pub fn gate(server: &LspServer, project: &Path) -> Result<(), String> {
    gate_at(&store_path(), crate::config::discovered_project_dirs, server, project)
}

/// Every trusted project, as stored.
#[tauri::command(async)]
pub fn trusted_projects() -> Vec<String> {
    let _guard = lock();
    load_or_seed(&store_path(), crate::config::discovered_project_dirs).trusted
}

/// Trust the project `path` belongs to, returning the path that was trusted.
#[tauri::command(async)]
pub fn trust_project(path: String) -> Result<String, String> {
    trust_at(
        &store_path(),
        crate::config::discovered_project_dirs,
        crate::config::discovery_root().as_deref(),
        Path::new(&path),
    )
}

/// Stop trusting a project, by the path `trusted_projects` listed it under.
#[tauri::command(async)]
pub fn revoke_project(path: String) -> Result<(), String> {
    revoke_at(&store_path(), crate::config::discovered_project_dirs, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::registry::load_server_str;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(name: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tori_trust_{}_{name}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bundled(text: &str, id: &str) -> LspServer {
        load_server_str(text, &format!("bundled:{id}")).unwrap()
    }

    fn typescript() -> LspServer {
        bundled(include_str!("../lsp/typescript.toml"), "typescript")
    }

    #[test]
    fn an_untrusted_project_refuses_only_the_servers_that_run_its_code() {
        let dir = temp_dir("gate");
        let store = dir.join("trusted.json");
        let root = dir.join("projects");
        let worktree = root.join("work/repo/feature");
        std::fs::create_dir_all(&worktree).unwrap();

        for (text, id, gated) in [
            (include_str!("../lsp/typescript.toml"), "typescript", true),
            (include_str!("../lsp/rust.toml"), "rust", true),
            (include_str!("../lsp/json.toml"), "json", false),
            (include_str!("../lsp/yaml.toml"), "yaml", false),
        ] {
            let expected = if gated { Err(UNTRUSTED.to_string()) } else { Ok(()) };
            assert_eq!(gate_at(&store, Vec::new, &bundled(text, id), &worktree), expected, "{id}");
        }

        let trusted = trust_at(&store, Vec::new, Some(&root), &worktree).unwrap();
        assert_eq!(trusted, root.join("work/repo").to_string_lossy());
        assert_eq!(gate_at(&store, Vec::new, &typescript(), &worktree), Ok(()));
        assert_eq!(gate_at(&store, Vec::new, &typescript(), &root.join("work/repo/main")), Ok(()));
        assert_eq!(
            gate_at(&store, Vec::new, &typescript(), &root.join("work/repo-two")),
            Err(UNTRUSTED.to_string())
        );

        revoke_at(&store, Vec::new, &trusted).unwrap();
        assert_eq!(gate_at(&store, Vec::new, &typescript(), &worktree), Err(UNTRUSTED.to_string()));
    }

    #[test]
    fn a_trust_claim_shipped_inside_the_project_changes_nothing() {
        let dir = temp_dir("claim");
        let store = dir.join("trusted.json");
        let project = dir.join("projects/work/repo");
        std::fs::create_dir_all(project.join(".tori")).unwrap();
        std::fs::write(project.join(".tori/settings.json"), r#"{ "trusted": true, "lsp": { "trusted": true } }"#)
            .unwrap();
        let claim = serde_json::json!({ "trusted": [project.to_string_lossy()] });
        std::fs::write(project.join(".tori/trusted.json"), claim.to_string()).unwrap();

        assert_eq!(gate_at(&store, Vec::new, &typescript(), &project), Err(UNTRUSTED.to_string()));
    }

    #[test]
    fn projects_present_at_the_first_trust_check_start_trusted_and_later_ones_do_not() {
        let dir = temp_dir("migrate");
        let store = dir.join("trusted.json");
        let root = dir.join("projects");
        std::fs::create_dir_all(root.join("work/old")).unwrap();
        let discover = || crate::config::project_dirs_under(&root, &[]);

        assert_eq!(gate_at(&store, discover, &typescript(), &root.join("work/old")), Ok(()));

        std::fs::create_dir_all(root.join("work/new")).unwrap();
        assert_eq!(
            gate_at(&store, discover, &typescript(), &root.join("work/new")),
            Err(UNTRUSTED.to_string())
        );
        assert_eq!(gate_at(&store, discover, &typescript(), &root.join("work/old")), Ok(()));
    }
}
