// Debug adapter registry, and the root resolution a launch config is built at.
//
// Every `dap/*.toml` ships embedded at compile time, and a user can add or
// whole-replace one by dropping a `schema_version = 1` TOML file into
// `~/.config/tori/dap/`. The rules are `lsp/registry.rs`'s on purpose: the same
// bundled-then-user merge, the same whole-replace by id, the same loud log that
// keeps the previous entry when a file is broken, and a launch kind from a
// closed set, so a TOML naming one with no implementation is a load error
// rather than a debugger that silently never starts.
//
// What the bundled adapter *is* (version, entry script) comes from
// `resources/dap/manifest.json`, the same file `scripts/install-dap.mjs`
// installs from, so those have one definition rather than a TOML copy that
// drifts from the installer's.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// The newest schema this build writes and documents.
pub const SCHEMA_VERSION: u32 = 1;

/// Every schema version this build still loads, kept for the reason
/// `lsp::registry` keeps its list: a working file in `~/.config/tori/dap/`
/// should survive a v2.
const SUPPORTED_SCHEMA_VERSIONS: [u32; 1] = [SCHEMA_VERSION];

/// The installer's manifest, as much of it as Rust needs.
#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    entry: String,
    expect: ManifestExpect,
}

#[derive(Debug, Deserialize)]
struct ManifestExpect {
    readiness: String,
}

/// How an adapter process is started and reached. A closed enum, like
/// `lsp::registry::Launch`: each kind needs real transport code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Launch {
    /// The bundled script, run with the user's system `node` (the bundled-node
    /// decision the LSP host already made). It binds a unix socket and Tori
    /// dials in. Every field comes from the installer's manifest, never from
    /// the TOML.
    BundledNodeSocket {
        /// Relative to the Tauri resource dir.
        entry: String,
        version: String,
        /// The line the adapter prints once it is listening. Logged for
        /// diagnostics only: the host retries its connect rather than waiting
        /// for this, because the string is unversioned English and a reworded
        /// one would otherwise hang every start. `install-dap.mjs` pins it so a
        /// reword is a decision rather than a silent behaviour change.
        readiness: String,
    },
    /// DAP over the adapter's own stdin and stdout, like a language server.
    Stdio { program: String, args: Vec<String>, resolve: Resolve },
    /// The adapter listens on the port Tori passes as `{port}` in `args`, and
    /// Tori dials in.
    Tcp { program: String, args: Vec<String>, resolve: Resolve },
}

impl Launch {
    /// The binary that has to exist on this machine. For the bundled adapter
    /// that is the interpreter; the script ships with the app.
    pub fn program(&self) -> &str {
        match self {
            Launch::BundledNodeSocket { .. } => "node",
            Launch::Stdio { program, .. } | Launch::Tcp { program, .. } => program,
        }
    }

    /// Where `program` is looked up.
    pub fn resolve(&self) -> Resolve {
        match self {
            Launch::BundledNodeSocket { .. } => Resolve::Path,
            Launch::Stdio { resolve, .. } | Launch::Tcp { resolve, .. } => *resolve,
        }
    }
}

/// Where a launch program is found. A closed set like the launch kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolve {
    /// The login-shell PATH.
    Path,
    /// `xcrun -f <program>`, else the login-shell PATH, for a tool Xcode ships
    /// outside the PATH.
    Xcrun,
}

/// How an adapter gets onto the machine. The LSP registry's `hint` shape, so
/// a Settings card can read the same for a debugger as for a language server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Install {
    /// Text only, for an adapter its own toolchain installs. `update` and
    /// `uninstall` are that toolchain's commands for the other two jobs.
    Hint { text: String, update: Option<String>, uninstall: Option<String> },
}

/// A debug adapter Tori can start.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapAdapter {
    pub id: String,
    pub label: String,
    /// File extension (no dot, lowercase) to the DAP `type` a launch config
    /// uses. Ordered so the serialized registry is stable across runs.
    pub languages: BTreeMap<String, String>,
    /// Filenames that mark a debuggable root, most specific first.
    pub root_markers: Vec<String>,
    pub launch: Launch,
    /// The adapter asks for a child session per target (`startDebugging`) and
    /// expects each as another connection to the same process. Only these get
    /// `dap_connect`.
    pub child_sessions: bool,
    pub install: Option<Install>,
    /// The adapter version this config was captured against. `None` is normal
    /// and renders neutral, never as drift.
    pub verified_against: Option<String>,
}

// --- raw TOML shape, kept apart from `DapAdapter` for `lsp::registry`'s
// reason: the launch table is a tagged union whose invalid variants must fail
// with a named error, not a serde blob ---

#[derive(Debug, Deserialize)]
struct AdapterToml {
    schema_version: u32,
    id: String,
    label: String,
    languages: BTreeMap<String, String>,
    root_markers: Vec<String>,
    launch: LaunchToml,
    #[serde(default)]
    child_sessions: bool,
    #[serde(default)]
    install: Option<InstallToml>,
    #[serde(default)]
    verified_against: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LaunchToml {
    kind: String,
    #[serde(default)]
    program: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    resolve: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstallToml {
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    update: Option<String>,
    #[serde(default)]
    uninstall: Option<String>,
}

const KNOWN_TOP_LEVEL: &[&str] = &[
    "schema_version",
    "id",
    "label",
    "languages",
    "root_markers",
    "launch",
    "child_sessions",
    "install",
    "verified_against",
];

const REQUIRED_TOP_LEVEL: &[&str] = &["schema_version", "id", "label", "languages", "root_markers", "launch"];

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../resources/dap/manifest.json"))
            .expect("resources/dap/manifest.json parses")
    })
}

/// Parse and validate one adapter TOML. `source` labels the origin in error
/// messages. The same checks as `lsp::registry::load_server_str`: an
/// unsupported `schema_version` is refused, every missing required field is
/// named in one message, an unknown top-level field is a warning, and a
/// `launch.kind` outside the closed set is an error.
pub fn load_adapter_str(text: &str, source: &str) -> Result<DapAdapter, String> {
    let value: toml::Value = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if let Some(table) = value.as_table() {
        for key in table.keys() {
            if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
                eprintln!("tori: debug adapter {source}: unknown field `{key}`, ignoring");
            }
        }
        let missing: Vec<&str> =
            REQUIRED_TOP_LEVEL.iter().filter(|k| !table.contains_key(**k)).copied().collect();
        if !missing.is_empty() {
            return Err(format!("{source}: missing required field(s): {}", missing.join(", ")));
        }
    }

    let raw: AdapterToml = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if !SUPPORTED_SCHEMA_VERSIONS.contains(&raw.schema_version) {
        let supported = SUPPORTED_SCHEMA_VERSIONS.map(|v| v.to_string()).join(", ");
        return Err(format!(
            "{source}: unsupported schema_version {} (tori supports {supported})",
            raw.schema_version
        ));
    }
    if raw.languages.is_empty() {
        return Err(format!("{source}: [languages] must map at least one extension"));
    }
    if raw.root_markers.is_empty() {
        return Err(format!("{source}: root_markers must list at least one filename"));
    }

    let launch = match raw.launch.kind.as_str() {
        "bundled_node_socket" => {
            let m = manifest();
            Launch::BundledNodeSocket {
                entry: m.entry.clone(),
                version: m.version.clone(),
                readiness: m.expect.readiness.clone(),
            }
        }
        kind @ ("stdio" | "tcp") => {
            let program = raw
                .launch
                .program
                .ok_or_else(|| format!("{source}: launch.kind = \"{kind}\" requires `program`"))?;
            let resolve = match raw.launch.resolve.as_deref() {
                None | Some("path") => Resolve::Path,
                Some("xcrun") => Resolve::Xcrun,
                Some(other) => {
                    return Err(format!("{source}: unknown launch.resolve `{other}` (tori implements: path, xcrun)"))
                }
            };
            let args = raw.launch.args;
            if kind == "stdio" {
                Launch::Stdio { program, args, resolve }
            } else {
                // Tori picks the port, so an adapter never told it listens
                // somewhere Tori will not dial.
                if !args.iter().any(|a| a.contains("{port}")) {
                    return Err(format!("{source}: launch.kind = \"tcp\" needs `{{port}}` in `args`"));
                }
                Launch::Tcp { program, args, resolve }
            }
        }
        other => {
            return Err(format!(
                "{source}: unknown launch.kind `{other}` (tori implements: bundled_node_socket, stdio, tcp)"
            ))
        }
    };

    // `dap_connect` dials the socket a bundled adapter listens on. A stdio
    // adapter has one pipe pair and a TCP one is dialled once, so neither can
    // take the second connection a child session is.
    if raw.child_sessions && !matches!(launch, Launch::BundledNodeSocket { .. }) {
        return Err(format!("{source}: child_sessions = true needs launch.kind = \"bundled_node_socket\""));
    }

    let install = raw
        .install
        .map(|table| match table.kind.as_str() {
            "hint" => Ok(Install::Hint {
                text: table.text.ok_or_else(|| format!("{source}: [install] kind = \"hint\" requires `text`"))?,
                update: table.update,
                uninstall: table.uninstall,
            }),
            other => Err(format!("{source}: unknown [install] kind `{other}` (tori implements: hint)")),
        })
        .transpose()?;

    // Matched lowercase and without a dot, so normalise once here.
    let languages = raw
        .languages
        .into_iter()
        .map(|(ext, ty)| (ext.trim_start_matches('.').to_lowercase(), ty))
        .collect();

    Ok(DapAdapter {
        id: raw.id,
        label: raw.label,
        languages,
        root_markers: raw.root_markers,
        launch,
        child_sessions: raw.child_sessions,
        install,
        verified_against: raw.verified_against,
    })
}

const BUILTIN_JS_DEBUG: &str = include_str!("../../dap/js-debug.toml");

/// Every bundled config.
const BUILTINS: &[(&str, &str)] = &[("bundled:js-debug", BUILTIN_JS_DEBUG)];

fn user_dap_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/tori/dap")
}

/// Bundled built-ins, then every `*.toml` in `user_dir`. A user file whose id
/// matches an earlier entry whole-replaces it, never field by field. A user
/// file that fails validation is logged and the id keeps its previous entry, so
/// one broken file cannot take a language's debugger away.
fn build_registry_from(user_dir: &Path) -> Vec<DapAdapter> {
    let mut list: Vec<DapAdapter> = Vec::new();
    let mut admit = |adapter: DapAdapter| {
        list.retain(|a| a.id != adapter.id);
        list.push(adapter);
    };

    for &(source, text) in BUILTINS {
        match load_adapter_str(text, source) {
            Ok(adapter) => admit(adapter),
            Err(e) => eprintln!("tori: ERROR loading built-in debug adapter {source}: {e}"),
        }
    }

    // Sorted so which of two conflicting user files wins does not depend on
    // the order the filesystem lists them in.
    let mut files: Vec<PathBuf> = std::fs::read_dir(user_dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| p.extension().and_then(|e| e.to_str()) == Some("toml"));
    files.sort();

    for path in files {
        let source = path.to_string_lossy().into_owned();
        match std::fs::read_to_string(&path).map_err(|e| format!("{source}: {e}")) {
            Ok(text) => match load_adapter_str(&text, &source) {
                Ok(adapter) => admit(adapter),
                Err(e) => eprintln!("tori: ERROR loading debug adapter {e} (keeping the previous adapter for this id)"),
            },
            Err(e) => eprintln!("tori: ERROR reading debug adapter {e}"),
        }
    }

    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

/// Every adapter Tori knows how to start: bundled, then
/// `~/.config/tori/dap/*.toml`. Loaded once; restart to pick up an edit, as
/// with every other loaded-at-startup config in Tori.
pub fn registry() -> &'static [DapAdapter] {
    static REGISTRY: OnceLock<Vec<DapAdapter>> = OnceLock::new();
    REGISTRY.get_or_init(|| build_registry_from(&user_dap_dir()))
}

/// The adapter registered as `id`.
pub fn find(id: &str) -> Option<&'static DapAdapter> {
    registry().iter().find(|a| a.id == id)
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

    // A file outside the project (a worktree's `.shared/`, say) has no
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
        std::env::temp_dir().join(format!("tori-dap-{label}-{}-{nanos}-{seq}", std::process::id()))
    }

    #[test]
    fn the_registry_is_built_from_the_installers_manifest() {
        let js = find("js-debug").expect("js-debug is registered");
        let Launch::BundledNodeSocket { entry, version, readiness } = &js.launch else {
            panic!("js-debug should be bundled_node_socket, got {:?}", js.launch);
        };
        // Not a hard-coded copy: these are the installer's own values, so a
        // version bump cannot leave Rust describing the previous bundle.
        assert!(!version.is_empty());
        assert!(entry.ends_with("dapDebugServer.js"));
        assert_eq!(readiness, "Debug server listening at");
    }

    /// The id lives in the TOML now, and the manifest still names the bundle it
    /// pins. Two ids for one adapter is the drift this catches.
    #[test]
    fn the_bundled_toml_and_the_installers_manifest_name_the_same_adapter() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../resources/dap/manifest.json")).unwrap();
        let js = load_adapter_str(BUILTIN_JS_DEBUG, "bundled:js-debug").unwrap();
        assert_eq!(manifest["id"], js.id.as_str());
    }

    #[test]
    fn a_hint_adapter_loads_its_install_commands_and_verified_version() {
        let text = r#"
schema_version = 1
id = "delve"
label = "Go (Delve)"
root_markers = ["go.mod"]
verified_against = "1.25.0"
[languages]
go = "go"
[launch]
kind = "tcp"
program = "dlv"
args = ["dap", "--listen=127.0.0.1:{port}"]
[install]
kind = "hint"
text = "Install it with `go install github.com/go-delve/delve/cmd/dlv@latest`."
update = "go install github.com/go-delve/delve/cmd/dlv@latest"
uninstall = "rm \"$(go env GOPATH)/bin/dlv\""
"#;
        let adapter = load_adapter_str(text, "test").unwrap();
        assert_eq!(
            adapter.install,
            Some(Install::Hint {
                text: "Install it with `go install github.com/go-delve/delve/cmd/dlv@latest`.".into(),
                update: Some("go install github.com/go-delve/delve/cmd/dlv@latest".into()),
                uninstall: Some("rm \"$(go env GOPATH)/bin/dlv\"".into()),
            })
        );
        assert_eq!(adapter.verified_against.as_deref(), Some("1.25.0"));
        assert!(!adapter.child_sessions);
    }

    /// The extension -> adapter mapping these two tests covered went with
    /// `adapter_for_path`, the unused path-to-adapter lookup: nothing asked the
    /// registry which adapter claims a file, so there was no behaviour left for
    /// them to describe. The `languages` map they read is still exercised through
    /// the manifest test above. Restore both alongside the caller, if a
    /// debug-this-file entry point ever needs the lookup back.

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
