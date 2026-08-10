// Debug adapter registry, and the root resolution a launch config is built at.
//
// One adapter ships (js-debug), but the table is a table rather than a constant
// for the reason `lsp/registry.rs` is: the second adapter should be a row, not a
// refactor. Unlike the LSP registry there is no user-supplied TOML here yet, so
// nothing needs validating, loading, or versioning; when a second adapter is a
// real requirement this grows the same loader that one has.
//
// What the adapter *is* comes from `resources/dap/manifest.json`, the same file
// `scripts/install-dap.mjs` installs from, so the version and entry path have
// one definition rather than a Rust copy that drifts from the installer's.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// The installer's manifest, as much of it as Rust needs.
#[derive(Debug, Deserialize)]
struct Manifest {
    id: String,
    label: String,
    version: String,
    entry: String,
    expect: ManifestExpect,
}

#[derive(Debug, Deserialize)]
struct ManifestExpect {
    readiness: String,
}

/// A debug adapter Sway can start.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapAdapter {
    pub id: String,
    pub label: String,
    pub version: String,
    /// File extension (no dot, lowercase) to the DAP `type` a launch config
    /// uses. Ordered so the serialized registry is stable across runs.
    pub languages: BTreeMap<String, String>,
    /// Filenames that mark a debuggable root, most specific first.
    pub root_markers: Vec<String>,
    /// Entry script relative to the Tauri resource dir, run with the user's
    /// system `node` (the bundled-node decision the LSP host already made).
    pub entry: String,
    /// The line the adapter prints once it is listening. Logged for
    /// diagnostics only: the host retries its connect rather than waiting for
    /// this, because the string is unversioned English and a reworded one would
    /// otherwise hang every start. `install-dap.mjs` pins it so a reword is a
    /// decision rather than a silent behaviour change.
    pub readiness: String,
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../resources/dap/manifest.json"))
            .expect("resources/dap/manifest.json parses")
    })
}

/// Every adapter Sway knows how to start.
pub fn registry() -> &'static [DapAdapter] {
    static REGISTRY: OnceLock<Vec<DapAdapter>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let m = manifest();
        // js-debug drives every JS dialect through one DAP type. The map is
        // extension to `type` rather than a bare extension list so a second
        // adapter can claim `.py` with its own type without changing shape.
        let languages = ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"]
            .iter()
            .map(|ext| (ext.to_string(), "pwa-node".to_string()))
            .collect();
        vec![DapAdapter {
            id: m.id.clone(),
            label: m.label.clone(),
            version: m.version.clone(),
            languages,
            // `package.json` is the honest marker for a node target: it is what
            // decides module resolution and which scripts exist, and in a
            // monorepo it is the per-package one that matters.
            root_markers: vec!["package.json".to_string()],
            entry: m.entry.clone(),
            readiness: m.expect.readiness.clone(),
        }]
    })
}

/// The adapter registered as `id`.
pub fn find(id: &str) -> Option<&'static DapAdapter> {
    registry().iter().find(|a| a.id == id)
}

/// The adapter claiming `path`'s extension, or `None`.
///
/// `None` is the normal answer for a language with no adapter, not a degraded
/// one: the file opens and edits exactly as before, it simply cannot be
/// debugged.
pub fn adapter_for_path(path: &str) -> Option<&'static DapAdapter> {
    let ext = Path::new(path).extension()?.to_str()?.to_lowercase();
    registry().iter().find(|a| a.languages.contains_key(&ext))
}

/// The root a debug session for `file_path` should run at: the nearest ancestor
/// (at or below `project_path`) holding one of the adapter's `root_markers`,
/// else `project_path`.
///
/// This exists in Rust and is deliberately not exposed as a command, for the
/// reason `lsp::registry::root_for` is not: a second implementation in
/// TypeScript would be a second answer, and a disagreement pairs a session with
/// the wrong root silently.
///
/// It matters more here than it does for a language server. The resolved root
/// becomes the launch config's `cwd`, which decides module resolution for the
/// debuggee and where its source maps resolve from, so a monorepo package
/// debugged at the workspace root does not merely get worse answers, it fails
/// to bind breakpoints at all.
pub fn root_for(adapter: &DapAdapter, file_path: &Path, project_path: &Path) -> PathBuf {
    let start = if file_path.is_dir() {
        file_path
    } else {
        file_path.parent().unwrap_or(project_path)
    };

    // A file outside the project (the Docs tree, a worktree's `.shared/`) has no
    // ancestor chain worth searching.
    if !start.starts_with(project_path) {
        return project_path.to_path_buf();
    }

    let mut dir = Some(start);
    while let Some(current) = dir {
        for marker in &adapter.root_markers {
            if current.join(marker).exists() {
                return current.to_path_buf();
            }
        }
        if current == project_path {
            break;
        }
        dir = current.parent();
    }
    project_path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A temp dir no other test can collide with.
    ///
    /// Keying on `process::id()` alone is the documented trap: every test in one
    /// `cargo test` run shares that pid, so two tests using the same recipe race
    /// over one path and each passes alone while failing together. Nanos plus a
    /// counter, as `checkpoint.rs` and `git.rs` already do.
    fn temp_dir(label: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("sway-dap-{label}-{}-{nanos}-{seq}", std::process::id()))
    }

    #[test]
    fn the_registry_is_built_from_the_installers_manifest() {
        let js = find("js-debug").expect("js-debug is registered");
        // Not a hard-coded copy: these are the installer's own values, so a
        // version bump cannot leave Rust describing the previous bundle.
        assert!(!js.version.is_empty());
        assert!(js.entry.ends_with("dapDebugServer.js"));
        assert_eq!(js.readiness, "Debug server listening at");
    }

    #[test]
    fn an_adapter_claims_the_js_family_and_nothing_else() {
        assert_eq!(adapter_for_path("/p/src/x.ts").map(|a| a.id.as_str()), Some("js-debug"));
        assert_eq!(adapter_for_path("/p/src/x.tsx").map(|a| a.id.as_str()), Some("js-debug"));
        assert_eq!(adapter_for_path("/p/src/x.mjs").map(|a| a.id.as_str()), Some("js-debug"));

        // A language with no adapter is a normal answer, not an error.
        assert!(adapter_for_path("/p/src/main.rs").is_none());
        assert!(adapter_for_path("/p/src/main.py").is_none());
        assert!(adapter_for_path("/p/README").is_none());
    }

    #[test]
    fn extension_matching_ignores_case() {
        assert!(adapter_for_path("/p/X.TS").is_some());
    }

    /// The monorepo case this function exists for.
    #[test]
    fn a_package_resolves_to_its_own_root_not_the_workspace_root() {
        let tmp = temp_dir("root");
        let api = tmp.join("packages/api");
        fs::create_dir_all(api.join("src")).unwrap();
        fs::write(tmp.join("package.json"), "{}").unwrap();
        fs::write(api.join("package.json"), "{}").unwrap();
        let file = api.join("src/x.ts");
        fs::write(&file, "").unwrap();

        let js = find("js-debug").unwrap();
        // The workspace root also has a `package.json`, so a walk that stopped
        // at the first one from the top would answer `tmp` and hand the
        // debuggee the wrong `cwd`.
        assert_eq!(root_for(js, &file, &tmp), api);

        // A file with no `package.json` above it inside the project falls back
        // to the project root rather than escaping it.
        let loose = tmp.join("scratch/y.ts");
        fs::create_dir_all(loose.parent().unwrap()).unwrap();
        fs::write(&loose, "").unwrap();
        assert_eq!(root_for(js, &loose, &tmp.join("scratch")), tmp.join("scratch"));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_file_outside_the_project_falls_back_to_the_project_root() {
        let js = find("js-debug").unwrap();
        let root = root_for(js, Path::new("/elsewhere/x.ts"), Path::new("/project"));
        assert_eq!(root, PathBuf::from("/project"));
    }
}
