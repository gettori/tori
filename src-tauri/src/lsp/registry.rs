// Language-server registry: what used to be one hard-coded
// `typescript-language-server` in lsp.rs is now data. Every `lsp/*.toml` ships
// bundled (embedded at compile time); a user
// can add or whole-replace one by dropping a `schema_version = 1` TOML file
// into `~/.config/tori/packs/lsp/`. See LSP-SERVERS.md for the schema.
//
// Modelled on `crate::agents`, deliberately: same bundled-then-user merge, same
// whole-replace override semantics, same loud-log-keep-previous handling of a
// broken file. The one thing that stays code rather than config is the launch
// kind (a closed enum, not a config string): a TOML naming a kind with no
// implementation is a load error, never a silent no-op, because a server that
// fails to spawn looks exactly like a language with no support at all.

use crate::format::registry::{DirScan, KeyMarker, KeyMarkerToml};
use crate::packs::{self, Kind, LoadError, Meta};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The newest schema this build writes and documents. Asserted against
/// LSP-SERVERS.md by `the_doc_documents_every_schema_field`.
pub const SCHEMA_VERSION: u32 = 1;

/// Every schema version this build still loads. Only one exists so far; when a
/// v2 lands, the older entries stay here so someone's working config in
/// `~/.config/tori/packs/lsp/` keeps loading, the way `agents.rs` keeps v1.
pub(crate) const SUPPORTED_SCHEMA_VERSIONS: [u32; 1] = [SCHEMA_VERSION];

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
    /// The project's own copy from `node_modules/.bin`, nearest the session
    /// root first, then the login PATH. Always runs project code.
    ProjectBin { program: String, args: Vec<String> },
    /// The user's own copy on the login PATH, else the one Tori installed from
    /// `[install]` under `~/.config/tori/servers/<id>/`.
    Managed {
        program: String,
        args: Vec<String>,
        runtime: Runtime,
    },
}

impl Launch {
    /// The name to show and to probe for health. For a bundled server this is
    /// the interpreter, since that is the thing that has to exist on the user's
    /// machine; the entry script ships with the app.
    pub fn program(&self) -> &str {
        match self {
            Launch::BundledNode { .. } => "node",
            Launch::Path { program, .. } | Launch::ProjectBin { program, .. } | Launch::Managed { program, .. } => {
                program
            }
        }
    }
}

/// What Tori's own copy of a `managed` server is run with: `node` for a script,
/// nothing for a native binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Runtime {
    Node,
    Native,
}

/// How a server gets onto the machine. A closed set like the launch kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Install {
    /// `npm install --ignore-scripts <package>@<version>`, at an exact version.
    Npm { package: String, version: String },
    /// One release asset per platform, checked against its sha256 before it
    /// is unpacked. `version` is the release tag.
    GithubRelease {
        repo: String,
        version: String,
        assets: BTreeMap<String, Asset>,
    },
    /// Text only, for a server its own toolchain installs. `update` and
    /// `uninstall` are that toolchain's commands for the other two jobs.
    Hint {
        text: String,
        update: Option<String>,
        uninstall: Option<String>,
    },
}

impl Install {
    /// The version Tori would install on this machine, or `None` when it
    /// installs nothing here: a hint, or a release with no build for it.
    pub fn available_version(&self) -> Option<&str> {
        match self {
            Install::Npm { version, .. } => Some(version),
            Install::GithubRelease { version, assets, .. } => assets.contains_key(&platform()).then_some(version),
            Install::Hint { .. } => None,
        }
    }
}

/// One platform's release asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Asset {
    /// The asset's filename in the release. A `.zip` or `.tar*` is unpacked,
    /// anything else is the binary itself.
    pub file: String,
    pub sha256: String,
    /// The server binary, relative to the install directory.
    pub bin: String,
}

/// The key a release asset is filed under for this machine, e.g.
/// `macos-aarch64`.
pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Whether a server owns a file or runs beside the one that does. A file gets
/// at most one primary and any number of secondaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Primary,
    Secondary,
}

/// What `features` and `except_features` can name. A closed set, like the
/// launch kind, so a misspelt feature is a load error instead of a filter that
/// silently matches nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    Diagnostics,
    CodeAction,
    Format,
}

const FEATURES: [(&str, Feature); 3] = [
    ("diagnostics", Feature::Diagnostics),
    ("code_action", Feature::CodeAction),
    ("format", Feature::Format),
];

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
    /// Free-form server configuration. Reaches the server two ways, because
    /// servers differ in which one they read: pushed once as
    /// `workspace/didChangeConfiguration`, and answered section by section
    /// whenever the server pulls with `workspace/configuration`.
    pub settings: Option<serde_json::Value>,
    /// Send this server the SchemaStore catalog as `json/schemaAssociations`
    /// after initialize. Only `vscode-json-languageserver` understands that
    /// notification, which is why this is a flag a config opts into rather than
    /// something every server gets.
    pub schema_associations: bool,
    /// The server version this config's conventions were captured against.
    /// `None` is normal and renders neutral, never as drift.
    pub verified_against: Option<String>,
    /// When `verified_against` was measured, `YYYY-MM-DD`.
    pub verified_on: Option<String>,
    #[serde(flatten)]
    pub meta: Meta,
    /// Whether this server executes code from the project it serves, which is
    /// what makes `lsp_start` refuse it in a project the user has not trusted.
    pub runs_project_code: bool,
    pub role: Role,
    /// Decides between primaries that are both active for one file. Higher wins.
    pub priority: i32,
    /// The features this server is asked for, with `features` or
    /// `except_features` already applied.
    pub features: Vec<Feature>,
    /// Filenames one of which must sit between the file and the project root
    /// for this server to start there. Empty means it always starts.
    pub activation_markers: Vec<String>,
    /// Keys inside a `.json` or `.toml` file that start it the same way, such as
    /// `tool.ruff` in `pyproject.toml`.
    pub activation_keys: Vec<KeyMarker>,
    pub install: Option<Install>,
    /// `"bundled:<id>"` for a built-in, or the absolute path of the user TOML
    /// that defined (or whole-replaced) it, so a forgotten override is visible.
    pub source: String,
    pub provenance: crate::packs::provenance::Provenance,
}

impl LspServer {
    /// True when this config came from a user TOML rather than a built-in.
    pub fn is_override(&self) -> bool {
        !self.source.starts_with("bundled:")
    }

    /// True when it starts only where one of its activation markers or keys is.
    pub fn needs_activation(&self) -> bool {
        !self.activation_markers.is_empty() || !self.activation_keys.is_empty()
    }

    /// The LSP language id for a path's extension, or `None` when this server
    /// does not claim it.
    pub fn language_id_for(&self, path: &str) -> Option<&str> {
        let file = path.rsplit('/').next()?;
        let dot = file.rfind('.')?;
        // A dotfile is its own name, not an extension: `.zshrc` must not read
        // as extension `zshrc`. `rsplit_once` would say it does, and the
        // frontend's `extensionOf` in utils/lspServers.ts must agree with this
        // exactly, since a disagreement means one side asks a server about a
        // file the other never claimed.
        if dot == 0 {
            return None;
        }
        let ext = file[dot + 1..].to_lowercase();
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
    settings: Option<toml::Value>,
    #[serde(default)]
    schema_associations: bool,
    #[serde(default)]
    verified_against: Option<String>,
    #[serde(default)]
    verified_on: Option<String>,
    #[serde(flatten)]
    meta: Meta,
    #[serde(default = "default_runs_project_code")]
    runs_project_code: bool,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    priority: i32,
    #[serde(default)]
    features: Option<Vec<String>>,
    #[serde(default)]
    except_features: Option<Vec<String>>,
    #[serde(default)]
    activation_markers: Vec<String>,
    #[serde(default)]
    activation_keys: Vec<KeyMarkerToml>,
    #[serde(default)]
    install: Option<InstallToml>,
}

fn default_timeout_ms() -> u64 {
    20_000
}

// A config that does not say is assumed to run project code: a wrongly gated
// server costs one trust click, a wrongly ungated one runs a stranger's code.
fn default_runs_project_code() -> bool {
    true
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
    #[serde(default)]
    runtime: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstallToml {
    kind: String,
    #[serde(default)]
    package: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    assets: BTreeMap<String, AssetToml>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    update: Option<String>,
    #[serde(default)]
    uninstall: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AssetToml {
    file: String,
    sha256: String,
    #[serde(default)]
    bin: Option<String>,
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
    "settings",
    "schema_associations",
    "verified_against",
    "verified_on",
    "description",
    "contributor",
    "license",
    "runs_project_code",
    "role",
    "priority",
    "features",
    "except_features",
    "activation_markers",
    "activation_keys",
    "install",
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
                eprintln!("tori: lsp server {source}: unknown field `{key}`, ignoring");
            }
        }
        let missing: Vec<&str> = REQUIRED_TOP_LEVEL
            .iter()
            .filter(|k| !table.contains_key(**k))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(format!("{source}: missing required field(s): {}", missing.join(", ")));
        }
    }

    let raw: ServerToml = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if !SUPPORTED_SCHEMA_VERSIONS.contains(&raw.schema_version) {
        let supported = SUPPORTED_SCHEMA_VERSIONS.map(|v| v.to_string()).join(", ");
        return Err(format!(
            "{source}: unsupported schema_version {} (tori supports {supported})",
            raw.schema_version
        ));
    }
    packs::check_id(&raw.id, source)?;
    if let Some(date) = &raw.verified_on {
        packs::check_date(date, "verified_on", source)?;
    }

    if raw.languages.is_empty() {
        return Err(format!("{source}: [languages] must map at least one extension"));
    }
    if raw.root_markers.is_empty() {
        return Err(format!("{source}: root_markers must list at least one filename"));
    }

    // The closed set. An unimplemented kind is an error rather than a warning:
    // a server that never spawns is indistinguishable from a language Tori
    // simply does not support, which is the wrong thing to leave a user
    // debugging.
    let launch = match raw.launch.kind.as_str() {
        "bundled_node" => {
            let entry = raw
                .launch
                .entry
                .ok_or_else(|| format!("{source}: launch.kind = \"bundled_node\" requires `entry`"))?;
            Launch::BundledNode {
                entry,
                args: raw.launch.args,
            }
        }
        kind @ ("path" | "project_bin" | "managed") => {
            let program = raw
                .launch
                .program
                .ok_or_else(|| format!("{source}: launch.kind = \"{kind}\" requires `program`"))?;
            match kind {
                "path" => Launch::Path {
                    program,
                    args: raw.launch.args,
                },
                "project_bin" => Launch::ProjectBin {
                    program,
                    args: raw.launch.args,
                },
                _ => {
                    let runtime = match raw.launch.runtime.as_deref() {
                        Some("node") => Runtime::Node,
                        Some("native") => Runtime::Native,
                        Some(other) => {
                            return Err(format!(
                                "{source}: unknown launch.runtime `{other}` (tori implements: node, native)"
                            ))
                        }
                        None => return Err(format!("{source}: launch.kind = \"managed\" requires `runtime`")),
                    };
                    Launch::Managed {
                        program,
                        args: raw.launch.args,
                        runtime,
                    }
                }
            }
        }
        other => {
            return Err(format!(
                "{source}: unknown launch.kind `{other}` (tori implements: bundled_node, path, project_bin, managed)"
            ))
        }
    };

    let install = raw
        .install
        .map(|table| load_install(table, launch.program(), source))
        .transpose()?;
    // Tori installs into `~/.config/tori/servers/<id>/`, and only `managed`
    // looks there, so either one without the other is a server that can never
    // run what was installed for it.
    let installs = matches!(install, Some(Install::Npm { .. } | Install::GithubRelease { .. }));
    let managed = matches!(launch, Launch::Managed { .. });
    if managed && !installs {
        return Err(format!(
            "{source}: launch.kind = \"managed\" needs an [install] of kind npm or github_release"
        ));
    }
    if installs && !managed {
        return Err(format!(
            "{source}: [install] of kind npm or github_release needs launch.kind = \"managed\""
        ));
    }

    let runs_project_code = raw.runs_project_code || matches!(launch, Launch::ProjectBin { .. });

    let role = match raw.role.as_deref() {
        None | Some("primary") => Role::Primary,
        Some("secondary") => Role::Secondary,
        Some(other) => {
            return Err(format!(
                "{source}: unknown role `{other}` (tori implements: primary, secondary)"
            ))
        }
    };

    let feature = |name: &String| {
        FEATURES
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, f)| *f)
            .ok_or_else(|| {
                let known = FEATURES.map(|(n, _)| n).join(", ");
                format!("{source}: unknown feature `{name}` (tori implements: {known})")
            })
    };
    let features = match (&raw.features, &raw.except_features) {
        (Some(_), Some(_)) => return Err(format!("{source}: set `features` or `except_features`, not both")),
        (Some(only), None) => only.iter().map(feature).collect::<Result<Vec<_>, _>>()?,
        (None, Some(except)) => {
            let except = except.iter().map(feature).collect::<Result<Vec<_>, _>>()?;
            FEATURES
                .iter()
                .map(|(_, f)| *f)
                .filter(|f| !except.contains(f))
                .collect()
        }
        (None, None) => FEATURES.iter().map(|(_, f)| *f).collect(),
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

    // Same conversion, same reason: what the frontend sends as the
    // `didChangeConfiguration` payload and as each `workspace/configuration`
    // section is this value verbatim.
    let activation_keys = raw
        .activation_keys
        .into_iter()
        .map(|k| k.validate("activation_keys", source))
        .collect::<Result<Vec<_>, _>>()?;

    let settings = match raw.settings {
        Some(v) => Some(serde_json::to_value(v).map_err(|e| format!("{source}: settings is not representable: {e}"))?),
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
        settings,
        schema_associations: raw.schema_associations,
        verified_against: raw.verified_against,
        verified_on: raw.verified_on,
        meta: raw.meta,
        runs_project_code,
        role,
        priority: raw.priority,
        features,
        activation_markers: raw.activation_markers,
        activation_keys,
        install,
        source: source.to_string(),
        provenance: Default::default(),
    })
}

fn load_install(raw: InstallToml, program: &str, source: &str) -> Result<Install, String> {
    let required = |value: Option<String>, field: &str| {
        value.ok_or_else(|| format!("{source}: [install] kind = \"{}\" requires `{field}`", raw.kind))
    };
    if raw.kind != "hint" && (raw.update.is_some() || raw.uninstall.is_some()) {
        return Err(format!(
            "{source}: [install] `update` and `uninstall` are only for kind = \"hint\"; Tori updates and removes its own installs"
        ));
    }
    match raw.kind.as_str() {
        "npm" => {
            let package = required(raw.package, "package")?;
            let version = pinned(required(raw.version, "version")?, source)?;
            Ok(Install::Npm { package, version })
        }
        "github_release" => {
            let repo = required(raw.repo, "repo")?;
            let version = required(raw.version, "version")?;
            if raw.assets.is_empty() {
                return Err(format!(
                    "{source}: [install] kind = \"github_release\" requires [install.assets]"
                ));
            }
            let mut assets = BTreeMap::new();
            for (platform, asset) in raw.assets {
                if asset.file.contains('/') {
                    return Err(format!(
                        "{source}: asset `{platform}`: `file` is a filename, not a path"
                    ));
                }
                if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(format!("{source}: asset `{platform}`: `sha256` must be 64 hex digits"));
                }
                let bin = asset.bin.unwrap_or_else(|| program.to_string());
                if !inside(Path::new(&bin)) {
                    return Err(format!(
                        "{source}: asset `{platform}`: `bin` must be a relative path inside the install"
                    ));
                }
                assets.insert(
                    platform,
                    Asset {
                        file: asset.file,
                        sha256: asset.sha256.to_lowercase(),
                        bin,
                    },
                );
            }
            Ok(Install::GithubRelease { repo, version, assets })
        }
        "hint" => Ok(Install::Hint {
            text: required(raw.text, "text")?,
            update: raw.update,
            uninstall: raw.uninstall,
        }),
        other => Err(format!(
            "{source}: unknown [install] kind `{other}` (tori implements: npm, github_release, hint)"
        )),
    }
}

fn pinned(version: String, source: &str) -> Result<String, String> {
    if packs::is_exact_version(&version) {
        Ok(version)
    } else {
        Err(format!(
            "{source}: [install] version `{version}` is not one exact version"
        ))
    }
}

/// True when `path` is relative and never climbs out with `..`.
pub fn inside(path: &Path) -> bool {
    path.components()
        .all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir))
        && path.components().next().is_some()
}

fn builtins() -> impl Iterator<Item = (String, &'static str)> {
    packs::snapshot::bundled("lsp")
}

/// Bundled built-ins, then every `*.toml` in `user_dir`, with an error for each
/// user file refused. A user file whose id matches a built-in whole-replaces
/// it (the entire struct, never a field-by-field merge), and may only do so as
/// a recorded install. A refused file leaves the id it would have replaced
/// with its previous entry, so one broken file can never make a language
/// silently lose its server.
pub(crate) fn build_registry_from(user_dir: &Path) -> (Vec<LspServer>, Vec<LoadError>) {
    let mut list: Vec<LspServer> = Vec::new();
    let mut errors = Vec::new();

    for (source, text) in builtins() {
        if let Err(e) = load_server_file(text, &source).and_then(|s| admit(&mut list, s)) {
            eprintln!("tori: ERROR loading built-in lsp server {source}: {e}");
        }
    }

    let mut user = packs::UserDir::open(Kind::Lsp, user_dir);
    for path in packs::user_files(user_dir, Kind::Lsp) {
        let loaded = user.load(&path, load_server_str, |s| &s.id);
        let admitted = loaded.and_then(|(s, provenance)| {
            let s = LspServer { provenance, ..s };
            admit(&mut list, s).map_err(|e| LoadError::new(Some(Kind::Lsp), &path.to_string_lossy(), &e, None))
        });
        if let Err(e) = admitted {
            errors.push(e);
        }
    }

    errors.extend(user.finish());
    list.sort_by(|a, b| a.id.cmp(&b.id));
    (list, errors)
}

fn load_server_file(text: &str, source: &str) -> Result<LspServer, String> {
    let server = load_server_str(text, source)?;
    packs::check_stem(source, &server.id)?;
    Ok(server)
}

/// Add `server`, whole-replacing any entry with its id, unless it and another
/// server would both be the unconditional primary for the same files.
fn admit(list: &mut Vec<LspServer>, server: LspServer) -> Result<(), String> {
    let unconditional = |s: &LspServer| s.role == Role::Primary && !s.needs_activation();
    if unconditional(&server) {
        for other in list
            .iter()
            .filter(|o| o.id != server.id && unconditional(o) && o.priority == server.priority)
        {
            if let Some(ext) = server.languages.keys().find(|ext| other.languages.contains_key(*ext)) {
                return Err(format!(
                    "{}: `{}` is already the primary for .{ext} at priority {}; give one of them a different \
                     priority or activation_markers",
                    server.source, other.id, other.priority
                ));
            }
        }
    }
    list.retain(|o| o.id != server.id);
    list.push(server);
    Ok(())
}

fn build_registry() -> Vec<LspServer> {
    let (list, errors) = build_registry_from(&packs::kind_dir(Kind::Lsp));
    packs::report(Kind::Lsp, errors);
    list
}

static REGISTRY: packs::Registry<LspServer> = packs::Registry::new();

/// The process-wide server registry: bundled, then
/// `~/.config/tori/packs/lsp/*.toml`, as of the last load or `reload`.
pub fn registry() -> Arc<Vec<LspServer>> {
    REGISTRY.get(build_registry)
}

pub fn reload() {
    REGISTRY.set(build_registry());
}

pub fn find(id: &str) -> Option<LspServer> {
    registry().iter().find(|s| s.id == id).cloned()
}

/// The servers that should run for `file`: the winning primary, and every
/// secondary. A server qualifies when it claims the extension, is not in
/// `disabled`, and, if it names activation markers or keys, finds one between the
/// file and `project`.
///
/// No primary is the normal, supported state, not a degraded one: a language
/// with a grammar but no server opens and edits exactly as before.
pub fn resolve<'a>(
    servers: &'a [LspServer],
    file: &Path,
    project: &Path,
    disabled: &HashSet<String>,
) -> (Option<&'a LspServer>, Vec<&'a LspServer>) {
    let path = file.to_string_lossy();
    let active: Vec<&LspServer> = servers
        .iter()
        .filter(|s| s.language_id_for(&path).is_some() && !disabled.contains(&s.id))
        .filter(|s| activated(s, file, project))
        .collect();
    // On equal priority a primary that needed a marker is the more specific
    // answer, so it beats one that is always on; the id only keeps it stable.
    let primary = active
        .iter()
        .copied()
        .filter(|s| s.role == Role::Primary)
        .max_by_key(|s| (s.priority, s.needs_activation(), std::cmp::Reverse(s.id.as_str())));
    let secondaries = active.into_iter().filter(|s| s.role == Role::Secondary).collect();
    (primary, secondaries)
}

// The same walk as `format::detect`, including its refusal to search for a file
// outside the project: a marker above the project must not switch a server on.
fn activated(server: &LspServer, file: &Path, project: &Path) -> bool {
    !server.needs_activation()
        || (!project.as_os_str().is_empty()
            && nearest_marker_dir(&server.activation_markers, &server.activation_keys, file, project).is_some())
}

/// The nearest directory from `file` up to `project` (inclusive) holding one of
/// `markers` or `keys`. `None` for a file outside the project, which has no
/// ancestor chain worth searching (a shared file, a worktree's `.shared/`).
fn nearest_marker_dir(markers: &[String], keys: &[KeyMarker], file: &Path, project: &Path) -> Option<PathBuf> {
    let start = if file.is_dir() {
        file
    } else {
        file.parent().unwrap_or(project)
    };
    if !start.starts_with(project) {
        return None;
    }
    let mut dir = Some(start);
    while let Some(current) = dir {
        let mut scan = DirScan::new(current);
        if markers.iter().any(|m| current.join(m).exists()) || keys.iter().any(|k| scan.has_key(k)) {
            return Some(current.to_path_buf());
        }
        if current == project {
            break;
        }
        dir = current.parent();
    }
    None
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
    nearest_marker_dir(&server.root_markers, &[], file_path, project_path).unwrap_or_else(|| project_path.to_path_buf())
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

    fn bundled(id: &str) -> &'static str {
        packs::snapshot::text("lsp", id).unwrap()
    }

    fn temp_dir(name: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("tori_lsp_registry_{}_{name}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("lsp");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_bundled_pack_is_measured() {
        for (source, text) in builtins() {
            let pack = load_server_str(text, &source).unwrap();
            assert!(pack.verified_against.is_some(), "{source} has no verified_against");
            assert!(pack.verified_on.is_some(), "{source} has no verified_on");
        }
    }

    #[test]
    fn every_bundled_pack_carries_metadata() {
        for (source, text) in builtins() {
            let meta = load_server_str(text, &source).unwrap().meta;
            assert!(meta.description.is_some(), "{source} has no description");
            assert!(meta.contributor.is_some(), "{source} has no contributor");
            assert!(meta.license.is_some(), "{source} has no license");
        }
    }

    #[test]
    fn the_catalog_fields_load_and_stay_optional() {
        let with = load_server_str(&format!("{}{}", packs::TEST_CATALOG_TOML, VALID), "test").unwrap();
        assert_eq!(with.meta, packs::test_meta());
        assert_eq!(with.verified_on.as_deref(), Some("2026-10-09"));
        let without = load_server_str(VALID, "test").unwrap();
        assert_eq!(without.meta, packs::Meta::default());
        assert_eq!(without.verified_on, None);
    }

    #[test]
    fn a_malformed_verified_on_is_refused_naming_the_file() {
        let text = format!("verified_on = \"2026-13-01\"\n{}", VALID);
        let err = load_server_str(&text, "/x/demo.toml").unwrap_err();
        assert!(err.contains("/x/demo.toml") && err.contains("verified_on"), "{err}");
    }

    #[test]
    fn a_file_named_other_than_its_id_is_refused_naming_both() {
        let err = load_server_file(VALID, "/x/other.toml").unwrap_err();
        assert!(err.contains("`other`") && err.contains("`demo`"), "{err}");
        assert!(load_server_file(VALID, "/x/demo.toml").is_ok());
    }

    #[test]
    fn an_id_that_could_climb_out_of_its_folder_is_refused() {
        let text = VALID.replace("id = \"demo\"", "id = \"../x\"");
        assert!(load_server_str(&text, "test").unwrap_err().contains("../x"));
    }

    // --- P1.1: the bundled configs parse, and an unknown launch kind does not ---

    #[test]
    fn both_bundled_configs_parse() {
        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
        assert_eq!(ts.id, "typescript");
        assert_eq!(ts.language_id_for("/p/a.tsx"), Some("typescriptreact"));
        assert_eq!(ts.language_id_for("/p/a.mjs"), Some("javascript"));
        assert!(ts.root_markers.contains(&"tsconfig.json".to_string()));

        let rs = load_server_str(bundled("rust"), "bundled:rust").unwrap();
        assert_eq!(rs.id, "rust");
        assert_eq!(rs.language_id_for("/p/a.rs"), Some("rust"));
        // The two bundled servers must not both claim an extension: as
        // unconditional primaries at one priority, `admit` would refuse one.
        for ext in ts.languages.keys() {
            assert!(!rs.languages.contains_key(ext), "both servers claim .{ext}");
        }
    }

    #[test]
    fn an_unknown_launch_kind_is_rejected_by_name() {
        let text = VALID.replace("kind = \"path\"", "kind = \"docker\"");
        let err = load_server_str(&text, "test").unwrap_err();
        assert!(err.contains("docker"), "error should name the bad kind: {err}");
        assert!(
            err.contains("bundled_node"),
            "error should list what is implemented: {err}"
        );
    }

    #[test]
    fn each_launch_kind_requires_its_own_field() {
        let no_program = VALID.replace("program = \"demo-server\"", "");
        assert!(load_server_str(&no_program, "test")
            .unwrap_err()
            .contains("requires `program`"));

        let node = VALID.replace("kind = \"path\"", "kind = \"bundled_node\"");
        assert!(load_server_str(&node, "test").unwrap_err().contains("requires `entry`"));
    }

    // --- P1.3: the two launch kinds resolve to distinct shapes ---

    #[test]
    fn bundled_typescript_launches_the_bundled_entry_and_rust_a_path_binary() {
        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
        match &ts.launch {
            Launch::BundledNode { entry, args } => {
                assert!(entry.ends_with("typescript-language-server/lib/cli.mjs"), "{entry}");
                assert_eq!(args, &["--stdio"]);
                // The thing that must exist on the user's machine is node.
                assert_eq!(ts.launch.program(), "node");
            }
            other => panic!("typescript should be bundled_node, got {other:?}"),
        }

        let rs = load_server_str(bundled("rust"), "bundled:rust").unwrap();
        match &rs.launch {
            Launch::Path { program, .. } => assert_eq!(program, "rust-analyzer"),
            other => panic!("rust should be path, got {other:?}"),
        }
        assert_eq!(rs.launch.program(), "rust-analyzer");
    }

    #[test]
    fn a_path_server_carries_a_generous_timeout_not_the_library_default() {
        let rs = load_server_str(bundled("rust"), "bundled:rust").unwrap();
        // The point of the field: 3000 (the @codemirror/lsp-client default)
        // rejects nearly every first request against a cold rust-analyzer.
        assert!(rs.request_timeout_ms > 3000, "got {}", rs.request_timeout_ms);
    }

    // --- P1.2: loading, override, and broken-override semantics ---

    #[test]
    fn bundled_servers_load_with_no_user_dir() {
        let (list, _) = build_registry_from(Path::new("/nonexistent/tori/lsp"));
        // Equal lengths mean `admit` refused none of them.
        assert_eq!(list.len(), builtins().count());
        for id in [
            "biome",
            "eslint",
            "json",
            "oxlint",
            "python",
            "rust",
            "typescript",
            "yaml",
        ] {
            assert!(list.iter().any(|s| s.id == id), "{id} is missing");
        }
        assert!(list.iter().all(|s| !s.is_override()));
    }

    // Elixir starts only inside a Mix project (elixir.toml), so outside one
    // these have no primary on purpose.
    const MARKER_ONLY: &[&str] = &["ex", "exs"];

    #[test]
    fn every_claimed_extension_has_one_primary() {
        let (list, _) = build_registry_from(Path::new("/nonexistent/tori/lsp"));
        let primaries: Vec<&LspServer> = list.iter().filter(|s| s.role == Role::Primary).collect();
        let extensions: HashSet<&String> = primaries.iter().flat_map(|s| s.languages.keys()).collect();
        for ext in extensions {
            let always_on: Vec<&&LspServer> = primaries
                .iter()
                .filter(|s| s.languages.contains_key(ext) && !s.needs_activation())
                .collect();
            let top = always_on.iter().map(|s| s.priority).max().unwrap_or_default();
            let winners: Vec<&str> = always_on
                .iter()
                .filter(|s| s.priority == top)
                .map(|s| s.id.as_str())
                .collect();
            let expected = if MARKER_ONLY.contains(&ext.as_str()) { 0 } else { 1 };
            assert_eq!(winners.len(), expected, ".{ext} has no single primary: {winners:?}");
        }
    }

    // --- [install] and the managed launch kind ---

    const MANAGED: &str = r#"
schema_version = 1
id = "demo"
label = "Demo"
root_markers = [".git"]
[languages]
demo = "demo"
[launch]
kind = "managed"
runtime = "node"
program = "demo-server"
[install]
kind = "npm"
package = "demo-server"
version = "1.2.3"
"#;

    #[test]
    fn an_npm_install_is_one_exact_version() {
        let s = load_server_str(MANAGED, "test").unwrap();
        assert_eq!(
            s.install,
            Some(Install::Npm {
                package: "demo-server".into(),
                version: "1.2.3".into()
            })
        );
        assert_eq!(
            s.launch,
            Launch::Managed {
                program: "demo-server".into(),
                args: vec![],
                runtime: Runtime::Node
            }
        );

        for loose in ["latest", "^1.2.3", "1.x", ">=1.0.0", "1.2"] {
            let text = MANAGED.replace("\"1.2.3\"", &format!("\"{loose}\""));
            let err = load_server_str(&text, "test").unwrap_err();
            assert!(err.contains("exact version"), "{loose}: {err}");
        }
        assert!(load_server_str(&MANAGED.replace("\"1.2.3\"", "\"1.2.3-beta.1\""), "test").is_ok());
        let no_package = MANAGED.replace("package = \"demo-server\"", "");
        assert!(load_server_str(&no_package, "test")
            .unwrap_err()
            .contains("requires `package`"));
    }

    #[test]
    fn a_github_release_checks_each_asset() {
        let release = |asset: &str| {
            MANAGED.replace("runtime = \"node\"", "runtime = \"native\"").replace(
                "kind = \"npm\"\npackage = \"demo-server\"\nversion = \"1.2.3\"",
                &format!("kind = \"github_release\"\nrepo = \"o/demo\"\nversion = \"v1\"\n[install.assets.macos-aarch64]\n{asset}"),
            )
        };
        let sha = "A".repeat(64);
        let s = load_server_str(&release(&format!("file = \"demo.tar.gz\"\nsha256 = \"{sha}\"")), "test").unwrap();
        let Some(Install::GithubRelease { assets, version, .. }) = &s.install else {
            panic!("{:?}", s.install)
        };
        assert_eq!(version, "v1");
        // `bin` defaults to the program, and the checksum is compared lowercase.
        assert_eq!(
            assets["macos-aarch64"],
            Asset {
                file: "demo.tar.gz".into(),
                sha256: "a".repeat(64),
                bin: "demo-server".into()
            }
        );

        let short = release("file = \"demo.tar.gz\"\nsha256 = \"abc\"");
        assert!(load_server_str(&short, "test").unwrap_err().contains("64 hex digits"));
        let escapes = release(&format!(
            "file = \"demo.tar.gz\"\nsha256 = \"{sha}\"\nbin = \"../../bin/sh\""
        ));
        assert!(load_server_str(&escapes, "test")
            .unwrap_err()
            .contains("inside the install"));
        let absolute = release(&format!(
            "file = \"demo.tar.gz\"\nsha256 = \"{sha}\"\nbin = \"/bin/sh\""
        ));
        assert!(load_server_str(&absolute, "test")
            .unwrap_err()
            .contains("inside the install"));
        let path = release(&format!("file = \"a/demo.tar.gz\"\nsha256 = \"{sha}\""));
        assert!(load_server_str(&path, "test").unwrap_err().contains("filename"));
    }

    #[test]
    fn a_hint_is_text_for_any_launch_kind() {
        let text = format!("{VALID}[install]\nkind = \"hint\"\ntext = \"brew install demo\"\n");
        let s = load_server_str(&text, "test").unwrap();
        assert_eq!(
            s.install,
            Some(Install::Hint {
                text: "brew install demo".into(),
                update: None,
                uninstall: None
            })
        );
        assert_eq!(s.install.unwrap().available_version(), None);

        let empty = format!("{VALID}[install]\nkind = \"hint\"\n");
        assert!(load_server_str(&empty, "test").unwrap_err().contains("requires `text`"));
    }

    #[test]
    fn an_unknown_install_kind_is_rejected_by_name() {
        let text = MANAGED.replace("kind = \"npm\"", "kind = \"pip\"");
        let err = load_server_str(&text, "test").unwrap_err();
        assert!(err.contains("pip") && err.contains("github_release"), "{err}");
    }

    #[test]
    fn managed_and_an_install_come_together() {
        let bare = MANAGED.split("[install]").next().unwrap();
        assert!(load_server_str(bare, "test")
            .unwrap_err()
            .contains("needs an [install]"));

        let hinted = format!("{bare}[install]\nkind = \"hint\"\ntext = \"x\"\n");
        assert!(load_server_str(&hinted, "test")
            .unwrap_err()
            .contains("needs an [install]"));

        let on_path = MANAGED.replace("kind = \"managed\"", "kind = \"path\"");
        assert!(load_server_str(&on_path, "test")
            .unwrap_err()
            .contains("needs launch.kind"));
    }

    #[test]
    fn managed_names_its_runtime() {
        let none = MANAGED.replace("runtime = \"node\"\n", "");
        assert!(load_server_str(&none, "test")
            .unwrap_err()
            .contains("requires `runtime`"));
        let odd = MANAGED.replace("runtime = \"node\"", "runtime = \"python\"");
        assert!(load_server_str(&odd, "test").unwrap_err().contains("python"));
    }

    #[test]
    fn a_hand_written_file_with_a_bundled_id_is_refused() {
        let dir = temp_dir("bundled-id");
        std::fs::write(
            dir.join("typescript.toml"),
            VALID.replace("\"demo\"", "\"typescript\"").replace("Demo", "Mine"),
        )
        .unwrap();

        let (list, errors) = build_registry_from(&dir);
        assert_eq!(
            list.iter().find(|s| s.id == "typescript").unwrap().label,
            "TypeScript / JavaScript"
        );
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].file.ends_with("typescript.toml"));
        assert_eq!(errors[0].fix.as_deref(), Some(packs::FIX_NEW_ID));
    }

    #[test]
    fn a_reload_picks_up_a_file_written_after_the_first_load() {
        let dir = temp_dir("reload");
        let registry = packs::Registry::new();
        let first = registry.get(|| build_registry_from(&dir).0);
        std::fs::write(dir.join("demo.toml"), VALID).unwrap();
        assert!(
            registry.get(|| unreachable!()).iter().all(|s| s.id != "demo"),
            "kept until a reload"
        );

        registry.set(build_registry_from(&dir).0);
        assert!(registry.get(|| unreachable!()).iter().any(|s| s.id == "demo"));
        assert!(
            first.iter().all(|s| s.id != "demo"),
            "a list already handed out never changes"
        );
    }

    #[test]
    fn every_loaded_server_says_where_it_came_from_and_an_edited_catalog_file_is_refused() {
        use crate::packs::provenance::Source;
        let dir = temp_dir("provenance");
        let mine = VALID.replace("\"demo\"", "\"mine\"");
        let theirs = VALID.replace("\"demo\"", "\"theirs\"").replace("demo = ", "theirs = ");
        std::fs::write(dir.join("mine.toml"), &mine).unwrap();
        std::fs::write(dir.join("theirs.toml"), &theirs).unwrap();
        packs::record_override(&dir, Kind::Lsp, "theirs", &theirs);
        let (list, errors) = build_registry_from(&dir);
        let source = |id: &str| list.iter().find(|s| s.id == id).map(|s| s.provenance.source);
        assert_eq!(source("mine"), Some(Source::Custom));
        assert_eq!(source("theirs"), Some(Source::Override));
        assert_eq!(source("rust"), Some(Source::Bundled));
        assert!(errors.is_empty(), "{errors:?}");

        std::fs::write(dir.join("theirs.toml"), theirs.replace("Demo", "Edited")).unwrap();
        let (list, errors) = build_registry_from(&dir);
        assert!(list.iter().all(|s| s.id != "theirs"), "a modified file is not loaded");
        assert_eq!(errors[0].fix.as_deref(), Some(packs::FIX_MODIFIED));
    }

    #[test]
    fn a_file_matching_a_cached_catalog_row_is_recorded_and_a_different_one_is_flagged() {
        use crate::packs::provenance::Source;
        let dir = temp_dir("adopt");
        let root = dir.parent().unwrap();
        let adopted = VALID.replace("\"demo\"", "\"fresh\"");
        let clash = VALID.replace("\"demo\"", "\"clash\"").replace("demo = ", "clash = ");
        std::fs::write(dir.join("fresh.toml"), &adopted).unwrap();
        std::fs::write(dir.join("clash.toml"), &clash).unwrap();
        let row =
            |id: &str, sha: String| serde_json::json!({ "kind": "lsp", "id": id, "schema_version": 1, "sha256": sha });
        let cache = serde_json::json!({ "index": { "packs_commit": "abc", "rows": [
            row("fresh", packs::sha256(&adopted)),
            row("clash", packs::sha256("something else")),
        ]}});
        std::fs::write(root.join("catalog.json"), cache.to_string()).unwrap();

        let (list, errors) = build_registry_from(&dir);
        assert!(errors.is_empty(), "{errors:?}");
        let fresh = list.iter().find(|s| s.id == "fresh").unwrap();
        assert_eq!(fresh.provenance.source, Source::Catalog);
        let record = packs::installed::read_at(&root.join("installed.json")).unwrap();
        assert_eq!(
            record.find(Kind::Lsp, "fresh").unwrap().packs_commit.as_deref(),
            Some("abc")
        );
        let clash = list.iter().find(|s| s.id == "clash").unwrap();
        assert_eq!(clash.provenance.source, Source::Custom);
        assert!(clash.provenance.catalog_conflict && !clash.provenance.update_available);
    }

    #[test]
    fn a_broken_file_is_one_load_error_naming_it() {
        let dir = temp_dir("broken-toml");
        std::fs::write(dir.join("mine.toml"), "not = [toml").unwrap();
        let (_, errors) = build_registry_from(&dir);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].file.ends_with("mine.toml") && errors[0].kind == Some(Kind::Lsp));
    }

    #[test]
    fn a_user_file_whose_name_is_not_its_id_is_refused() {
        let dir = temp_dir("stem");
        std::fs::write(dir.join("other.toml"), VALID).unwrap();
        let (list, errors) = build_registry_from(&dir);
        assert!(list.iter().all(|s| s.id != "demo"));
        assert!(
            errors[0].message.contains("`other`") && errors[0].message.contains("`demo`"),
            "{errors:?}"
        );
    }

    #[test]
    fn a_recorded_override_whole_replaces_a_builtin_by_id() {
        let dir = temp_dir("override");
        let text = VALID.replace("\"demo\"", "\"typescript\"").replace("Demo", "Mine");
        std::fs::write(dir.join("typescript.toml"), &text).unwrap();
        packs::record_override(&dir, Kind::Lsp, "typescript", &text);

        let (list, _) = build_registry_from(&dir);
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
        std::fs::write(dir.join("typescript.toml"), "schema_version = 1\nid = \"typescript\"\n").unwrap();

        let (list, _) = build_registry_from(&dir);
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
        assert_eq!(build_registry_from(&dir).0.len(), builtins().count());
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
        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
        assert_eq!(ts.language_id_for("/p/some.ts/README"), None);
        assert_eq!(ts.language_id_for("/p/no-extension"), None);
    }

    #[test]
    fn a_dotfile_is_its_name_not_an_extension() {
        let text = VALID.replace("demo = \"demo\"", "zshrc = \"shellscript\"");
        let s = load_server_str(&text, "test").unwrap();
        // Must agree with `extensionOf` in utils/lspServers.ts, which uses
        // `lastIndexOf(".") > 0`. A split-on-last-dot rule would claim this.
        assert_eq!(s.language_id_for("/home/me/.zshrc"), None);
        // A real extension on a dotted name still resolves.
        assert_eq!(s.language_id_for("/home/me/.config.zshrc"), Some("shellscript"));
    }

    // --- P1.4: root resolution ---

    #[test]
    fn a_nested_package_resolves_to_its_own_marker_dir() {
        let dir = temp_dir("roots");
        let pkg = dir.join("packages/a");
        std::fs::create_dir_all(pkg.join("src")).unwrap();
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();
        std::fs::write(pkg.join("tsconfig.json"), "{}").unwrap();

        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &pkg.join("src/index.ts"), &dir), pkg);
    }

    #[test]
    fn a_marker_less_file_falls_back_to_the_project_root() {
        let dir = temp_dir("nomarker");
        std::fs::create_dir_all(dir.join("src")).unwrap();

        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &dir.join("src/index.ts"), &dir), dir);
    }

    #[test]
    fn the_walk_never_rises_above_the_project_root() {
        let dir = temp_dir("boundary");
        let project = dir.join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        // A marker *outside* the project must not be picked up.
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();

        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
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

        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &elsewhere.join("a.ts"), &project), project);
    }

    #[test]
    fn two_files_under_one_root_resolve_to_the_same_root() {
        let dir = temp_dir("reuse");
        let pkg = dir.join("packages/a");
        std::fs::create_dir_all(pkg.join("src/deep")).unwrap();
        std::fs::write(pkg.join("tsconfig.json"), "{}").unwrap();

        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
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

        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
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
        let doc = include_str!("../../../docs/LSP-SERVERS.md");
        let heading = "## Example: a from-scratch third-party server";
        let after = doc
            .find(heading)
            .expect("LSP-SERVERS.md must document a complete example")
            + heading.len();
        let rest = &doc[after..];
        let start = rest
            .find("```toml")
            .expect("the example section must have a ```toml block")
            + "```toml".len();
        let end = rest[start..].find("```").expect("unterminated ```toml fence") + start;

        let s =
            load_server_str(rest[start..end].trim(), "LSP-SERVERS.md example").expect("the example TOML should parse");
        assert_eq!(s.id, "pyright");
        assert_eq!(s.language_id_for("/p/a.py"), Some("python"));
        assert_eq!(s.launch.program(), "pyright-langserver");
    }

    // --- wave 7: the JSON and YAML servers, and the `[settings]` table ---

    /// The monorepo the JSON server's `root_markers` exist for.
    fn monorepo(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        for pkg in ["a", "b", "c"] {
            let path = dir.join("packages").join(pkg);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("package.json"), "{}").unwrap();
        }
        dir
    }

    #[test]
    fn json_resolves_one_root_for_a_whole_monorepo() {
        // Every package has a `package.json`, and none of them means anything
        // to this server: it has no per-package configuration to be right
        // about, so a session per package would differ in nothing but cost.
        let dir = monorepo("json_roots");
        let json = load_server_str(bundled("json"), "bundled:json").unwrap();

        let roots: Vec<PathBuf> = ["a", "b", "c"]
            .iter()
            .map(|p| root_for(&json, &dir.join("packages").join(p).join("tsconfig.json"), &dir))
            .collect();

        assert_eq!(roots, vec![dir.clone(), dir.clone(), dir.clone()]);
    }

    #[test]
    fn adding_package_json_back_is_what_splits_the_monorepo() {
        // The reason `root_markers` omits `package.json` rather than merely
        // ordering `.git` first: `root_for` returns the first ancestor holding
        // *any* marker, so while `package.json` is in the list at all, the
        // order changes nothing. Pinned here so the omission cannot be
        // "tidied" back into an ordering.
        let dir = monorepo("json_roots_split");
        let split = load_server_str(
            &bundled("json").replace(
                r#"root_markers = [".git"]"#,
                r#"root_markers = [".git", "package.json"]"#,
            ),
            "test",
        )
        .unwrap();

        let pkg = dir.join("packages/a");
        assert_eq!(root_for(&split, &pkg.join("tsconfig.json"), &dir), pkg);
    }

    #[test]
    fn yaml_roots_the_same_way() {
        let dir = monorepo("yaml_roots");
        let yaml = load_server_str(bundled("yaml"), "bundled:yaml").unwrap();
        assert_eq!(root_for(&yaml, &dir.join("packages/a/ci.yml"), &dir), dir);
    }

    #[test]
    fn the_yaml_config_turns_the_schema_store_on() {
        // The exact payload, because every one of these keys is read by name
        // and a typo is a setting that silently keeps its default. The server
        // defaults `schemaStore.enable` to true, but only builds the store
        // inside its configuration handler, so a config that never arrives is
        // a store that never loads.
        let yaml = load_server_str(bundled("yaml"), "bundled:yaml").unwrap();
        let settings = yaml.settings.expect("yaml.toml must carry a [settings] table");

        assert_eq!(
            settings,
            serde_json::json!({
                "yaml": {
                    "validate": true,
                    "completion": true,
                    "hover": true,
                    "schemaStore": {
                        "enable": true,
                        // The same catalog Tori fetches for the JSON server.
                        // Two servers reading two different catalogs would be
                        // a difference nobody could see from the outside.
                        "url": crate::lsp::schemastore::CATALOG_URL
                    }
                }
            })
        );
    }

    #[test]
    fn only_the_json_server_asks_for_schema_associations() {
        // A flag rather than something every server gets: `json/schemaAssociations`
        // is one server's protocol extension, and sending it to another draws a
        // warning at best.
        let by_id = |text, source| load_server_str(text, source).unwrap();
        assert!(by_id(bundled("json"), "bundled:json").schema_associations);
        assert!(!by_id(bundled("yaml"), "bundled:yaml").schema_associations);
        assert!(!by_id(bundled("typescript"), "bundled:typescript").schema_associations);
        assert!(!by_id(bundled("rust"), "bundled:rust").schema_associations);
    }

    #[test]
    fn a_config_with_no_settings_behaves_exactly_as_before() {
        // The whole point of the table being optional. rust-analyzer carries
        // none and is unaffected by the feature's existence; the TypeScript
        // config gained one in wave 7 (see below), which is why it is no longer
        // one of the two named here.
        let server = load_server_str(bundled("rust"), "bundled:rust").unwrap();
        assert!(server.settings.is_none(), "rust should carry no settings");
        assert!(!server.schema_associations, "rust should not ask for associations");
    }

    #[test]
    fn the_typescript_config_turns_the_servers_own_code_lens_on() {
        // Tori's `codeLens` setting decides whether it *asks*;
        // `typescript-language-server` decides whether it has anything to
        // answer, and its answer is an empty array until a workspace
        // configuration says otherwise (`cli.mjs:21364`). Verified against the
        // bundled 4.4.1: without this table, 0 lenses on a file with three
        // exported symbols; with it, 3.
        //
        // Asserted here rather than left to the TOML, because the failure is
        // silent in both directions: the setting toggles, the request goes out,
        // the server answers `[]`, and nothing anywhere says why.
        let server = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
        let settings = server.settings.expect("typescript should carry a settings table");
        for language in ["typescript", "javascript"] {
            assert_eq!(
                settings[language]["referencesCodeLens"]["enabled"],
                serde_json::json!(true),
                "{language} reference lenses"
            );
            assert_eq!(
                settings[language]["implementationsCodeLens"]["enabled"],
                serde_json::json!(true),
                "{language} implementation lenses"
            );
            // Deliberately absent: on, every inner helper gets a lens and most
            // of them read "0 references".
            assert!(
                settings[language]["referencesCodeLens"]["showOnAllFunctions"].is_null(),
                "{language} should keep lenses to exported and class members"
            );
        }
        assert!(
            !server.schema_associations,
            "typescript should not ask for associations"
        );
    }

    #[test]
    fn a_settings_table_is_carried_through_verbatim() {
        let text = format!("{VALID}\n[settings.some]\nnested = {{ deep = [1, 2] }}\n");
        let server = load_server_str(&text, "test").unwrap();
        assert_eq!(
            server.settings.unwrap(),
            serde_json::json!({ "some": { "nested": { "deep": [1, 2] } } })
        );
    }

    /// The block in LSP-SERVERS.md is what a config author copies, so it has to
    /// be TOML that parses, and it has to parse into the shape it claims.
    #[test]
    fn the_documented_schema_block_parses_and_keeps_its_keys_top_level() {
        let doc = include_str!("../../../docs/LSP-SERVERS.md");
        // The heading, exactly. A bare `"## Schema"` also matches inside
        // `### Schemas for JSON and YAML`, which is a different section and
        // has no block to find.
        let after = doc
            .split("\n## Schema\n")
            .nth(1)
            .expect("the doc must have a Schema section");
        let start = after
            .find("```toml")
            .expect("the Schema section must show a toml block")
            + 7;
        let block = &after[start..][..after[start..].find("```").expect("unterminated toml block")];

        let value: toml::Value = toml::from_str(block).expect("the documented schema block must parse");
        let table = value.as_table().unwrap();

        // In TOML a bare key written after a table header belongs to that
        // table. Every one of these sat below `[languages]` or
        // `[initialization_options]` at some point in this file's life, and
        // nothing said so: `verified_against` really was a member of
        // `initialization_options` until wave 7.
        for key in [
            "schema_version",
            "id",
            "label",
            "root_markers",
            "request_timeout_ms",
            "schema_associations",
            "verified_against",
        ] {
            assert!(
                table.contains_key(key),
                "`{key}` is not top-level in the documented block"
            );
        }
        for table_key in ["languages", "launch", "initialization_options", "settings"] {
            assert!(
                table.get(table_key).is_some_and(|v| v.is_table()),
                "`{table_key}` should be a table"
            );
        }
    }

    /// Every schema field the loader knows must appear in the doc, so adding
    /// one without documenting it fails here rather than shipping undocumented.
    #[test]
    fn the_doc_documents_every_schema_field() {
        let doc = include_str!("../../../docs/LSP-SERVERS.md");
        for field in KNOWN_TOP_LEVEL {
            assert!(doc.contains(field), "LSP-SERVERS.md does not document `{field}`");
        }
        // Both launch kinds, and the supported schema version, are part of the
        // contract a config author reads.
        assert!(
            doc.contains("bundled_node"),
            "the doc must describe the bundled_node kind"
        );
        assert!(doc.contains("`path`"), "the doc must describe the path kind");
        assert!(
            doc.contains(&format!("schema_version = {SCHEMA_VERSION}")),
            "the doc must show the current schema_version"
        );
    }

    /// The replacement example in the doc has to keep working too: it is the
    /// instruction someone follows when the bundled server is not what they want.
    #[test]
    fn lsp_servers_md_override_example_parses() {
        let doc = include_str!("../../../docs/LSP-SERVERS.md");
        let heading = "## Replacing a bundled server";
        let after = doc.find(heading).expect("the doc must show how to replace one") + heading.len();
        let rest = &doc[after..];
        let start = rest.find("```toml").unwrap() + "```toml".len();
        let end = rest[start..].find("```").unwrap() + start;

        let s = load_server_str(rest[start..end].trim(), "LSP-SERVERS.md override")
            .expect("the override example should parse");
        // Its own id: a user file carrying a bundled one is refused.
        assert!(!packs::is_bundled(Kind::Lsp, &s.id), "{}", s.id);
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

        let ts = load_server_str(bundled("typescript"), "bundled:typescript").unwrap();
        assert_eq!(root_for(&ts, &pkg.join("a.ts"), &dir), pkg);
    }

    const ESLINT: &str = r#"
schema_version = 1
id = "eslint"
label = "ESLint"
role = "secondary"
root_markers = ["package.json"]
activation_markers = ["eslint.config.js"]
[languages]
ts = "typescript"
[launch]
kind = "path"
program = "eslint-lsp"
"#;

    const DENO: &str = r#"
schema_version = 1
id = "deno"
label = "Deno"
root_markers = ["deno.json"]
activation_markers = ["deno.json"]
[languages]
ts = "typescript"
[launch]
kind = "path"
program = "deno"
"#;

    fn resolved_ids(servers: &[LspServer], file: &Path, project: &Path) -> (Option<String>, Vec<String>) {
        let (primary, secondaries) = resolve(servers, file, project, &HashSet::new());
        (
            primary.map(|s| s.id.clone()),
            secondaries.iter().map(|s| s.id.clone()).collect(),
        )
    }

    #[test]
    fn a_ts_file_gets_typescript_alone_until_a_secondary_activates() {
        let project = temp_dir("resolve_secondary");
        let file = project.join("src/a.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let servers = [
            load_server_str(bundled("typescript"), "bundled:typescript").unwrap(),
            load_server_str(ESLINT, "eslint").unwrap(),
        ];

        assert_eq!(
            resolved_ids(&servers, &file, &project),
            (Some("typescript".into()), vec![])
        );

        std::fs::write(project.join("eslint.config.js"), "").unwrap();
        assert_eq!(
            resolved_ids(&servers, &file, &project),
            (Some("typescript".into()), vec!["eslint".to_string()])
        );
    }

    #[test]
    fn the_bundled_eslint_runs_beside_typescript_only_under_a_config() {
        let eslint = load_server_str(bundled("eslint"), "bundled:eslint").unwrap();
        assert_eq!(eslint.role, Role::Secondary);
        assert!(
            eslint.runs_project_code,
            "it loads the project's own eslint, so an untrusted project refuses it"
        );
        let project = temp_dir("bundled_eslint");
        let file = project.join("src/a.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let servers = [
            load_server_str(bundled("typescript"), "bundled:typescript").unwrap(),
            eslint,
        ];

        assert_eq!(
            resolved_ids(&servers, &file, &project),
            (Some("typescript".into()), vec![])
        );

        std::fs::write(project.join("eslint.config.mjs"), "").unwrap();
        assert_eq!(
            resolved_ids(&servers, &file, &project),
            (Some("typescript".into()), vec!["eslint".to_string()])
        );
    }

    #[test]
    fn the_bundled_biome_and_oxlint_run_from_the_project_each_under_its_own_config() {
        let project = temp_dir("bundled_linters");
        let file = project.join("src/a.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let servers = [
            load_server_str(bundled("typescript"), "bundled:typescript").unwrap(),
            load_server_str(bundled("eslint"), "bundled:eslint").unwrap(),
            load_server_str(bundled("biome"), "bundled:biome").unwrap(),
            load_server_str(bundled("oxlint"), "bundled:oxlint").unwrap(),
        ];
        for linter in &servers[2..] {
            assert_eq!(linter.role, Role::Secondary, "{}", linter.id);
            assert!(matches!(linter.launch, Launch::ProjectBin { .. }), "{}", linter.id);
            assert!(linter.runs_project_code, "{}", linter.id);
        }
        assert_eq!(
            resolved_ids(&servers, &file, &project),
            (Some("typescript".into()), vec![])
        );

        std::fs::write(project.join("biome.json"), "{}").unwrap();
        assert_eq!(
            resolved_ids(&servers, &file, &project),
            (Some("typescript".into()), vec!["biome".to_string()])
        );

        std::fs::write(project.join("eslint.config.js"), "").unwrap();
        std::fs::write(project.join(".oxlintrc.json"), "{}").unwrap();
        assert_eq!(
            resolved_ids(&servers, &file, &project),
            (
                Some("typescript".into()),
                vec!["eslint".to_string(), "biome".to_string(), "oxlint".to_string()]
            )
        );
    }

    #[test]
    fn a_marker_activated_primary_wins_in_its_package_and_not_in_a_sibling() {
        let project = temp_dir("resolve_sibling");
        let edge = project.join("packages/edge/src/a.ts");
        let web = project.join("packages/web/src/a.ts");
        std::fs::create_dir_all(edge.parent().unwrap()).unwrap();
        std::fs::create_dir_all(web.parent().unwrap()).unwrap();
        std::fs::write(project.join("packages/edge/deno.json"), "{}").unwrap();
        let servers = [
            load_server_str(bundled("typescript"), "bundled:typescript").unwrap(),
            load_server_str(DENO, "deno").unwrap(),
        ];

        assert_eq!(resolved_ids(&servers, &edge, &project).0.as_deref(), Some("deno"));
        assert_eq!(resolved_ids(&servers, &web, &project).0.as_deref(), Some("typescript"));
    }

    #[test]
    fn activation_needs_a_marker_between_the_file_and_the_project_root() {
        let outer = temp_dir("activation_walk");
        let project = outer.join("repo");
        let file = project.join("src/deep/a.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let eslint = load_server_str(ESLINT, "eslint").unwrap();

        assert!(!activated(&eslint, &file, &project));

        std::fs::write(outer.join("eslint.config.js"), "").unwrap();
        assert!(
            !activated(&eslint, &file, &project),
            "a marker above the project must not count"
        );

        std::fs::write(project.join("src/eslint.config.js"), "").unwrap();
        assert!(activated(&eslint, &file, &project));
    }
}
