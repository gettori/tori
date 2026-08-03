// Language-server registry: what used to be one hard-coded
// `typescript-language-server` in lsp.rs is now data. Two servers ship bundled
// (`lsp/typescript.toml`, `lsp/rust.toml`, embedded at compile time); a user
// can add or whole-replace one by dropping a `schema_version = 1` TOML file
// into `~/.config/sway/lsp/`. See LSP-SERVERS.md for the schema.
//
// Modelled on `crate::agents`, deliberately: same bundled-then-user merge, same
// whole-replace override semantics, same loud-log-keep-previous handling of a
// broken file. The one thing that stays code rather than config is the launch
// kind (a closed enum, not a config string): a TOML naming a kind with no
// implementation is a load error, never a silent no-op, because a server that
// fails to spawn looks exactly like a language with no support at all.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The newest schema this build writes and documents. Asserted against
/// LSP-SERVERS.md by `the_doc_documents_every_schema_field`.
pub const SCHEMA_VERSION: u32 = 1;

/// Every schema version this build still loads. Only one exists so far; when a
/// v2 lands, the older entries stay here so someone's working config in
/// `~/.config/sway/lsp/` keeps loading, the way `agents.rs` keeps v1.
const SUPPORTED_SCHEMA_VERSIONS: [u32; 1] = [SCHEMA_VERSION];

/// How a server process is started.
///
/// A closed enum on purpose (the `ParserKind`/`ChatTransport` precedent in
/// `agents.rs`): the two kinds differ in where the executable comes from, and
/// each needs real code. A user TOML may only name one that exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Launch {
    /// Shipped inside the app bundle and run with the user's system `node`.
    /// `entry` is relative to the Tauri resource dir, with a dev-tree fallback.
    BundledNode { entry: String, args: Vec<String> },
    /// A binary resolved on the login-shell PATH (`crate::env::resolve_binary`),
    /// never the GUI process PATH: a server installed via rustup/mise/asdf is
    /// invisible to a naive lookup from a Finder-launched app.
    Path { program: String, args: Vec<String> },
}

impl Launch {
    /// The name to show and to probe for health. For a bundled server this is
    /// the interpreter, since that is the thing that has to exist on the user's
    /// machine; the entry script ships with the app.
    pub fn program(&self) -> &str {
        match self {
            Launch::BundledNode { .. } => "node",
            Launch::Path { program, .. } => program,
        }
    }
}

/// A resolved, validated language server config.
#[derive(Debug, Clone, Serialize)]
pub struct LspServer {
    pub id: String,
    pub label: String,
    /// File extension (no dot, lowercase) to LSP language id. Ordered so the
    /// registry's serialized form is stable across runs.
    pub languages: BTreeMap<String, String>,
    /// Filenames that mark a project root, most specific first.
    pub root_markers: Vec<String>,
    /// Per-server request timeout for the frontend's `LSPClient`. The library
    /// defaults to 3s, which is wrong for a server that indexes on startup.
    pub request_timeout_ms: u64,
    pub launch: Launch,
    /// Free-form `initializationOptions`, passed through to the server as-is.
    pub initialization_options: Option<serde_json::Value>,
    /// The server version this config's conventions were captured against.
    /// `None` is normal and renders neutral, never as drift.
    pub verified_against: Option<String>,
    /// `"bundled:<id>"` for a built-in, or the absolute path of the user TOML
    /// that defined (or whole-replaced) it, so a forgotten override is visible.
    pub source: String,
}

impl LspServer {
    /// True when this config came from a user TOML rather than a built-in.
    pub fn is_override(&self) -> bool {
        !self.source.starts_with("bundled:")
    }

    /// The LSP language id for a path's extension, or `None` when this server
    /// does not claim it.
    ///
    /// No production caller yet: the frontend's `lspPluginFor` starts asking in
    /// the next phase. Built and tested here so that phase is only wiring,
    /// following `backstop.rs`'s precedent for staged machinery.
    #[allow(dead_code)]
    pub fn language_id_for(&self, path: &str) -> Option<&str> {
        let file = path.rsplit('/').next()?;
        let ext = file.rsplit_once('.')?.1.to_lowercase();
        self.languages.get(&ext).map(String::as_str)
    }
}

// --- raw TOML shape (kept separate from `LspServer`: validation has to happen
// before the typed struct is trusted, and the launch table is a tagged union
// whose invalid variants must produce a named error, not a serde blob) ---

#[derive(Debug, Deserialize)]
struct ServerToml {
    schema_version: u32,
    id: String,
    label: String,
    languages: BTreeMap<String, String>,
    root_markers: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    request_timeout_ms: u64,
    launch: LaunchToml,
    #[serde(default)]
    initialization_options: Option<toml::Value>,
    #[serde(default)]
    verified_against: Option<String>,
}

fn default_timeout_ms() -> u64 {
    20_000
}

#[derive(Debug, Deserialize)]
struct LaunchToml {
    kind: String,
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    program: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

const KNOWN_TOP_LEVEL: &[&str] = &[
    "schema_version",
    "id",
    "label",
    "languages",
    "root_markers",
    "request_timeout_ms",
    "launch",
    "initialization_options",
    "verified_against",
];

const REQUIRED_TOP_LEVEL: &[&str] = &["schema_version", "id", "label", "languages", "root_markers", "launch"];

/// Parse + validate one server TOML source. `source` labels the origin for
/// error messages (a file path, or a fixed name for a built-in). Rejects an
/// unsupported `schema_version`, names every missing required field in one
/// message rather than just the first, warns on an unrecognized top-level
/// field, and rejects a `launch.kind` outside the closed set.
pub fn load_server_str(text: &str, source: &str) -> Result<LspServer, String> {
    let value: toml::Value = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if let Some(table) = value.as_table() {
        for key in table.keys() {
            if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
                eprintln!("sway: lsp server {source}: unknown field `{key}`, ignoring");
            }
        }
        let missing: Vec<&str> =
            REQUIRED_TOP_LEVEL.iter().filter(|k| !table.contains_key(**k)).copied().collect();
        if !missing.is_empty() {
            return Err(format!("{source}: missing required field(s): {}", missing.join(", ")));
        }
    }

    let raw: ServerToml = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if !SUPPORTED_SCHEMA_VERSIONS.contains(&raw.schema_version) {
        let supported = SUPPORTED_SCHEMA_VERSIONS.map(|v| v.to_string()).join(", ");
        return Err(format!(
            "{source}: unsupported schema_version {} (sway supports {supported})",
            raw.schema_version
        ));
    }

    if raw.languages.is_empty() {
        return Err(format!("{source}: [languages] must map at least one extension"));
    }
    if raw.root_markers.is_empty() {
        return Err(format!("{source}: root_markers must list at least one filename"));
    }

    // The closed set. An unimplemented kind is an error rather than a warning:
    // a server that never spawns is indistinguishable from a language Sway
    // simply does not support, which is the wrong thing to leave a user
    // debugging.
    let launch = match raw.launch.kind.as_str() {
        "bundled_node" => {
            let entry = raw.launch.entry.ok_or_else(|| {
                format!("{source}: launch.kind = \"bundled_node\" requires `entry`")
            })?;
            Launch::BundledNode { entry, args: raw.launch.args }
        }
        "path" => {
            let program = raw
                .launch
                .program
                .ok_or_else(|| format!("{source}: launch.kind = \"path\" requires `program`"))?;
            Launch::Path { program, args: raw.launch.args }
        }
        other => {
            return Err(format!(
                "{source}: unknown launch.kind `{other}` (sway implements: bundled_node, path)"
            ))
        }
    };

    // Extensions are matched lowercase and without a dot, so normalise here
    // rather than at every lookup.
    let languages = raw
        .languages
        .into_iter()
        .map(|(ext, id)| (ext.trim_start_matches('.').to_lowercase(), id))
        .collect();

    // toml::Value -> serde_json::Value so the frontend can pass it straight
    // through as `initializationOptions` without a second conversion.
    let initialization_options = match raw.initialization_options {
        Some(v) => Some(
            serde_json::to_value(v)
                .map_err(|e| format!("{source}: initialization_options is not representable: {e}"))?,
        ),
        None => None,
    };

    Ok(LspServer {
        id: raw.id,
        label: raw.label,
        languages,
        root_markers: raw.root_markers,
        request_timeout_ms: raw.request_timeout_ms,
        launch,
        initialization_options,
        verified_against: raw.verified_against,
        source: source.to_string(),
    })
}

const BUILTIN_TYPESCRIPT: &str = include_str!("../../lsp/typescript.toml");
const BUILTIN_RUST: &str = include_str!("../../lsp/rust.toml");

fn user_lsp_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/lsp")
}

/// Bundled built-ins, then every `*.toml` in `user_dir`. A user file whose id
/// matches a built-in whole-replaces it (the entire struct, never a
/// field-by-field merge). A user file that fails validation is logged loudly
/// and the id it would have overridden keeps its previous entry, so one broken
/// file can never make a language silently lose its server.
fn build_registry_from(user_dir: &Path) -> Vec<LspServer> {
    let mut by_id: HashMap<String, LspServer> = HashMap::new();

    for (source, text) in
        [("bundled:typescript", BUILTIN_TYPESCRIPT), ("bundled:rust", BUILTIN_RUST)]
    {
        match load_server_str(text, source) {
            Ok(s) => {
                by_id.insert(s.id.clone(), s);
            }
            Err(e) => eprintln!("sway: ERROR loading built-in lsp server {source}: {e}"),
        }
    }

    if let Ok(entries) = std::fs::read_dir(user_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            let source = path.to_string_lossy().into_owned();
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("sway: ERROR reading lsp server {source}: {e}");
                    continue;
                }
            };
            match load_server_str(&text, &source) {
                Ok(s) => {
                    by_id.insert(s.id.clone(), s);
                }
                Err(e) => eprintln!(
                    "sway: ERROR loading lsp server {source}: {e} (keeping the previous server for this id)"
                ),
            }
        }
    }

    let mut list: Vec<LspServer> = by_id.into_values().collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

fn build_registry() -> Vec<LspServer> {
    build_registry_from(&user_lsp_dir())
}

static REGISTRY: OnceLock<Vec<LspServer>> = OnceLock::new();

/// The process-wide server registry, loaded once on first use (bundled +
/// `~/.config/sway/lsp/*.toml`; not live-watched, restart to pick up edits,
/// same as every other loaded-at-startup config in Sway).
pub fn registry() -> &'static [LspServer] {
    REGISTRY.get_or_init(build_registry)
}

pub fn find(id: &str) -> Option<&'static LspServer> {
    registry().iter().find(|s| s.id == id)
}

/// The server claiming `path`'s extension, or `None`.
///
/// An unregistered extension yielding `None` is the normal, supported state,
/// not a degraded one: a language with a grammar but no server opens and edits
/// exactly as before, it just gets no plugin.
///
/// Staged like `language_id_for`: the frontend picks a server per file in the
/// next phase, and this is the lookup it will call.
#[allow(dead_code)]
pub fn server_for_path(path: &str) -> Option<&'static LspServer> {
    registry().iter().find(|s| s.language_id_for(path).is_some())
}

/// The project root a server should be started at for `file_path`: the nearest
/// ancestor directory (at or below `project_path`) holding one of the server's
/// `root_markers`, else `project_path` itself.
///
/// The walk never rises above `project_path`. A `tsconfig.json` in the user's
/// home directory must not become the root for a file inside a project, and
/// stopping at the project boundary is also what keeps the resolved root
/// inside the tree the editor already scopes to.
pub fn root_for(server: &LspServer, file_path: &Path, project_path: &Path) -> PathBuf {
    let start = if file_path.is_dir() { file_path } else { file_path.parent().unwrap_or(project_path) };

    // Only walk within the project. A file outside it (the Docs tree, a
    // worktree's `.shared/`) has no ancestor chain worth searching, so it
    // falls straight back to the project root.
    if !start.starts_with(project_path) {
        return project_path.to_path_buf();
    }

    let mut dir = Some(start);
    while let Some(current) = dir {
        for marker in &server.root_markers {
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    const VALID: &str = r#"
schema_version = 1
id = "demo"
label = "Demo"
root_markers = ["demo.json"]
[languages]
demo = "demo"
[launch]
kind = "path"
program = "demo-server"
"#;

    fn temp_dir(name: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("sway_lsp_registry_{}_{name}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- P1.1: the bundled configs parse, and an unknown launch kind does not ---

    #[test]
    fn both_bundled_configs_parse() {
        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        assert_eq!(ts.id, "typescript");
        assert_eq!(ts.language_id_for("/p/a.tsx"), Some("typescriptreact"));
        assert_eq!(ts.language_id_for("/p/a.mjs"), Some("javascript"));
        assert!(ts.root_markers.contains(&"tsconfig.json".to_string()));

        let rs = load_server_str(BUILTIN_RUST, "bundled:rust").unwrap();
        assert_eq!(rs.id, "rust");
        assert_eq!(rs.language_id_for("/p/a.rs"), Some("rust"));
        // The two bundled servers must not both claim an extension, or
        // `server_for_path` would depend on registry order.
        for ext in ts.languages.keys() {
            assert!(!rs.languages.contains_key(ext), "both servers claim .{ext}");
        }
    }

    #[test]
    fn an_unknown_launch_kind_is_rejected_by_name() {
        let text = VALID.replace("kind = \"path\"", "kind = \"docker\"");
        let err = load_server_str(&text, "test").unwrap_err();
        assert!(err.contains("docker"), "error should name the bad kind: {err}");
        assert!(err.contains("bundled_node"), "error should list what is implemented: {err}");
    }

    #[test]
    fn each_launch_kind_requires_its_own_field() {
        let no_program = VALID.replace("program = \"demo-server\"", "");
        assert!(load_server_str(&no_program, "test").unwrap_err().contains("requires `program`"));

        let node = VALID.replace("kind = \"path\"", "kind = \"bundled_node\"");
        assert!(load_server_str(&node, "test").unwrap_err().contains("requires `entry`"));
    }

    // --- P1.3: the two launch kinds resolve to distinct shapes ---

    #[test]
    fn bundled_typescript_launches_the_bundled_entry_and_rust_a_path_binary() {
        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        match &ts.launch {
            Launch::BundledNode { entry, args } => {
                assert!(entry.ends_with("typescript-language-server/lib/cli.mjs"), "{entry}");
                assert_eq!(args, &["--stdio"]);
                // The thing that must exist on the user's machine is node.
                assert_eq!(ts.launch.program(), "node");
            }
            other => panic!("typescript should be bundled_node, got {other:?}"),
        }

        let rs = load_server_str(BUILTIN_RUST, "bundled:rust").unwrap();
        match &rs.launch {
            Launch::Path { program, .. } => assert_eq!(program, "rust-analyzer"),
            other => panic!("rust should be path, got {other:?}"),
        }
        assert_eq!(rs.launch.program(), "rust-analyzer");
    }

    #[test]
    fn a_path_server_carries_a_generous_timeout_not_the_library_default() {
        let rs = load_server_str(BUILTIN_RUST, "bundled:rust").unwrap();
        // The point of the field: 3000 (the @codemirror/lsp-client default)
        // rejects nearly every first request against a cold rust-analyzer.
        assert!(rs.request_timeout_ms > 3000, "got {}", rs.request_timeout_ms);
    }

    // --- P1.2: loading, override, and broken-override semantics ---

    #[test]
    fn bundled_servers_load_with_no_user_dir() {
        let list = build_registry_from(Path::new("/nonexistent/sway/lsp"));
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["rust", "typescript"]);
        assert!(list.iter().all(|s| !s.is_override()));
    }

    #[test]
    fn a_user_file_whole_replaces_a_builtin_by_id() {
        let dir = temp_dir("override");
        std::fs::write(
            dir.join("typescript.toml"),
            VALID.replace("\"demo\"", "\"typescript\"").replace("Demo", "Mine"),
        )
        .unwrap();

        let list = build_registry_from(&dir);
        let ts = list.iter().find(|s| s.id == "typescript").unwrap();
        assert_eq!(ts.label, "Mine");
        assert!(ts.is_override());
        // Whole-replace, not a merge: the built-in's extensions are gone.
        assert_eq!(ts.language_id_for("/p/a.ts"), None);
        // And the untouched built-in is unaffected.
        assert_eq!(list.iter().find(|s| s.id == "rust").unwrap().label, "Rust");
    }

    #[test]
    fn a_broken_override_keeps_the_previous_entry() {
        let dir = temp_dir("broken");
        std::fs::write(dir.join("typescript.toml"), "schema_version = 1\nid = \"typescript\"\n")
            .unwrap();

        let list = build_registry_from(&dir);
        let ts = list.iter().find(|s| s.id == "typescript").expect("must not disappear");
        assert_eq!(ts.label, "TypeScript / JavaScript");
        assert!(!ts.is_override(), "the built-in should still be the one in effect");
    }

    #[test]
    fn a_missing_field_is_reported_all_at_once() {
        let err = load_server_str("schema_version = 1\nid = \"x\"\n", "test").unwrap_err();
        assert!(err.contains("label"), "{err}");
        assert!(err.contains("languages"), "{err}");
        assert!(err.contains("launch"), "{err}");
    }

    #[test]
    fn an_unsupported_schema_version_is_rejected() {
        let text = VALID.replace("schema_version = 1", "schema_version = 99");
        let err = load_server_str(&text, "test").unwrap_err();
        assert!(err.contains("99"), "{err}");
    }

    #[test]
    fn an_unknown_top_level_field_is_ignored_not_fatal() {
        let text = format!("{VALID}\nfuture_field = true\n");
        assert!(load_server_str(&text, "test").is_ok());
    }

    #[test]
    fn a_non_toml_file_in_the_user_dir_is_skipped() {
        let dir = temp_dir("notoml");
        std::fs::write(dir.join("README.md"), "not a config").unwrap();
        assert_eq!(build_registry_from(&dir).len(), 2);
    }

    #[test]
    fn extensions_normalise_to_dotless_lowercase() {
        let text = VALID.replace("demo = \"demo\"", "\".TS\" = \"typescript\"");
        let s = load_server_str(&text, "test").unwrap();
        assert_eq!(s.language_id_for("/p/x.ts"), Some("typescript"));
        assert_eq!(s.language_id_for("/p/x.TS"), Some("typescript"));
    }

    #[test]
    fn a_dotted_directory_cannot_fake_an_extension() {
        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        assert_eq!(ts.language_id_for("/p/some.ts/README"), None);
        assert_eq!(ts.language_id_for("/p/no-extension"), None);
    }

    // --- P1.4: root resolution ---

    #[test]
    fn a_nested_package_resolves_to_its_own_marker_dir() {
        let dir = temp_dir("roots");
        let pkg = dir.join("packages/a");
        std::fs::create_dir_all(pkg.join("src")).unwrap();
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();
        std::fs::write(pkg.join("tsconfig.json"), "{}").unwrap();

        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &pkg.join("src/index.ts"), &dir), pkg);
    }

    #[test]
    fn a_marker_less_file_falls_back_to_the_project_root() {
        let dir = temp_dir("nomarker");
        std::fs::create_dir_all(dir.join("src")).unwrap();

        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &dir.join("src/index.ts"), &dir), dir);
    }

    #[test]
    fn the_walk_never_rises_above_the_project_root() {
        let dir = temp_dir("boundary");
        let project = dir.join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        // A marker *outside* the project must not be picked up.
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();

        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &project.join("src/index.ts"), &project), project);
    }

    #[test]
    fn a_file_outside_the_project_falls_back_rather_than_searching() {
        let dir = temp_dir("outside");
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let elsewhere = dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("tsconfig.json"), "{}").unwrap();

        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &elsewhere.join("a.ts"), &project), project);
    }

    #[test]
    fn two_files_under_one_root_resolve_to_the_same_root() {
        let dir = temp_dir("reuse");
        let pkg = dir.join("packages/a");
        std::fs::create_dir_all(pkg.join("src/deep")).unwrap();
        std::fs::write(pkg.join("tsconfig.json"), "{}").unwrap();

        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        // This is what makes `lsp_start` reuse rather than respawn: two files
        // in the same package produce the same root, so the same handle, so
        // the running session is found already in the map.
        let a = root_for(&ts, &pkg.join("src/index.ts"), &dir);
        let b = root_for(&ts, &pkg.join("src/deep/other.ts"), &dir);
        assert_eq!(a, b);
        assert_eq!(a, pkg);
    }

    #[test]
    fn sibling_packages_resolve_to_different_roots() {
        let dir = temp_dir("siblings");
        for name in ["a", "b"] {
            let pkg = dir.join("packages").join(name);
            std::fs::create_dir_all(&pkg).unwrap();
            std::fs::write(pkg.join("tsconfig.json"), "{}").unwrap();
        }
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();

        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        let a = root_for(&ts, &dir.join("packages/a/index.ts"), &dir);
        let b = root_for(&ts, &dir.join("packages/b/index.ts"), &dir);
        // The whole reason sessions are keyed by (id, root): one shared
        // session here would answer b's requests from a's tsconfig.
        assert_ne!(a, b);
    }

    // --- P1.8: the doc cannot drift from the loader ---

    /// LSP-SERVERS.md's complete example (a from-scratch `python` server) is
    /// not just illustrative prose: it must actually validate, so the doc
    /// can't silently drift from what the loader accepts.
    #[test]
    fn lsp_servers_md_example_parses() {
        let doc = include_str!("../../../LSP-SERVERS.md");
        let heading = "## Example: a from-scratch third-party server";
        let after =
            doc.find(heading).expect("LSP-SERVERS.md must document a complete example") + heading.len();
        let rest = &doc[after..];
        let start =
            rest.find("```toml").expect("the example section must have a ```toml block") + "```toml".len();
        let end = rest[start..].find("```").expect("unterminated ```toml fence") + start;

        let s = load_server_str(rest[start..end].trim(), "LSP-SERVERS.md example")
            .expect("the example TOML should parse");
        assert_eq!(s.id, "python");
        assert_eq!(s.language_id_for("/p/a.py"), Some("python"));
        assert_eq!(s.launch.program(), "pyright-langserver");
    }

    /// Every schema field the loader knows must appear in the doc, so adding
    /// one without documenting it fails here rather than shipping undocumented.
    #[test]
    fn the_doc_documents_every_schema_field() {
        let doc = include_str!("../../../LSP-SERVERS.md");
        for field in KNOWN_TOP_LEVEL {
            assert!(doc.contains(field), "LSP-SERVERS.md does not document `{field}`");
        }
        // Both launch kinds, and the supported schema version, are part of the
        // contract a config author reads.
        assert!(doc.contains("bundled_node"), "the doc must describe the bundled_node kind");
        assert!(doc.contains("`path`"), "the doc must describe the path kind");
        assert!(
            doc.contains(&format!("schema_version = {SCHEMA_VERSION}")),
            "the doc must show the current schema_version"
        );
    }

    /// The override example in the doc has to keep working too: it is the
    /// instruction someone follows when the bundled server is not what they want.
    #[test]
    fn lsp_servers_md_override_example_parses() {
        let doc = include_str!("../../../LSP-SERVERS.md");
        let heading = "## Whole-replacing a bundled server";
        let after = doc.find(heading).expect("the doc must show how to override") + heading.len();
        let rest = &doc[after..];
        let start = rest.find("```toml").unwrap() + "```toml".len();
        let end = rest[start..].find("```").unwrap() + start;

        let s = load_server_str(rest[start..end].trim(), "LSP-SERVERS.md override")
            .expect("the override example should parse");
        // It must use a bundled id, or it would not override anything.
        assert_eq!(s.id, "typescript");
    }

    #[test]
    fn markers_are_tried_most_specific_first() {
        let dir = temp_dir("specific");
        let pkg = dir.join("pkg");
        std::fs::create_dir_all(&pkg).unwrap();
        // The package has only a package.json; the repo root has a tsconfig.
        // The nearest ancestor with *any* marker wins, which is the package.
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();
        std::fs::write(pkg.join("package.json"), "{}").unwrap();

        let ts = load_server_str(BUILTIN_TYPESCRIPT, "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &pkg.join("a.ts"), &dir), pkg);
    }
}
