// Formatter registry: the two-variant `Formatter` enum format.rs used to carry
// is now data, one TOML per formatter. Bundled ones live in `formatters/*.toml`,
// embedded at compile time; a user adds or whole-replaces one by dropping a
// `schema_version = 1` file into `~/.config/tori/formatters/`. See FORMATTERS.md.
//
// Loading follows `lsp::registry` rule for rule: bundled first, user files in
// filename order, whole-replace by id, a broken user file logged loudly while
// the id keeps its previous entry, and a closed `launch.kind`.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The newest schema this build writes and documents.
pub const SCHEMA_VERSION: u32 = 1;

const SUPPORTED_SCHEMA_VERSIONS: [u32; 1] = [SCHEMA_VERSION];

/// Where the formatter binary is looked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchKind {
    /// The nearest `node_modules/.bin` or Python virtualenv from the config's
    /// directory up to the project, then the login PATH.
    ProjectBin,
    /// The login PATH only.
    Path,
}

/// A key inside a structured file, such as `prettier` in `package.json` or
/// `tool.ruff` in `pyproject.toml`.
#[derive(Debug, Clone, Serialize)]
pub struct KeyMarker {
    pub file: String,
    pub path: Vec<String>,
}

/// What marks a directory as configured for this formatter. Any one match is
/// enough.
#[derive(Debug, Clone, Default)]
pub struct Markers {
    pub files: Vec<String>,
    /// Matched against the start of each filename, for tools that accept a
    /// config under many extensions.
    pub prefixes: Vec<String>,
    pub keys: Vec<KeyMarker>,
}

/// How a formatter says "not my kind of file", as opposed to "your file is
/// broken". Both are a failed exit, and only the first should hand the file on.
#[derive(Debug, Clone)]
pub struct NotApplicable {
    pub exit_code: Option<i32>,
    pub stderr: Option<Regex>,
}

impl NotApplicable {
    /// Whether a run that exited with `code` and printed `stderr` was this
    /// formatter declining the file. Every condition given must hold.
    pub fn matches(&self, code: i32, stderr: &str) -> bool {
        self.exit_code.is_none_or(|c| c == code) && self.stderr.as_ref().is_none_or(|r| r.is_match(stderr))
    }
}

/// A resolved, validated formatter config.
#[derive(Debug, Clone)]
pub struct Formatter {
    pub id: String,
    pub label: String,
    /// Decides between formatters configured in one directory. Higher wins.
    pub priority: i32,
    /// Lowercase, dotless. `None` means any file: the formatter is asked, and
    /// `not_applicable` is how it says no.
    pub extensions: Option<Vec<String>>,
    pub markers: Markers,
    pub launch: LaunchKind,
    pub program: String,
    /// With `{file}` still in place; see `args_for`.
    pub args: Vec<String>,
    pub not_applicable: Option<NotApplicable>,
    pub verified_against: Option<String>,
}

impl Formatter {
    pub fn args_for(&self, path: &str) -> Vec<String> {
        self.args.iter().map(|a| a.replace("{file}", path)).collect()
    }

    /// Whether this formatter will be asked about a file with extension `ext`.
    pub fn claims(&self, ext: Option<&str>) -> bool {
        match &self.extensions {
            None => true,
            Some(list) => ext.is_some_and(|e| list.iter().any(|x| x == e)),
        }
    }

    /// Whether it names `ext` outright, rather than taking any file.
    pub fn names(&self, ext: Option<&str>) -> bool {
        self.extensions.is_some() && self.claims(ext)
    }

    pub fn is_configured_in(&self, dir: &mut DirScan) -> bool {
        let markers = &self.markers;
        markers.files.iter().any(|f| dir.has(f))
            || markers.prefixes.iter().any(|p| dir.has_prefix(p))
            || markers.keys.iter().any(|k| dir.has_key(k))
    }
}

/// The lowercase extension of `path`, the way `LspServer::language_id_for`
/// reads it: a dotfile is its own name, so `.zshrc` has none.
pub fn extension_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let dot = name.rfind('.')?;
    (dot > 0).then(|| name[dot + 1..].to_lowercase())
}

/// One directory, listed and parsed at most once however many formatters ask.
pub struct DirScan {
    dir: PathBuf,
    names: Option<Vec<String>>,
    parsed: HashMap<String, Option<serde_json::Value>>,
}

impl DirScan {
    pub fn new(dir: &Path) -> Self {
        Self { dir: dir.to_path_buf(), names: None, parsed: HashMap::new() }
    }

    fn names(&mut self) -> &[String] {
        let dir = &self.dir;
        self.names.get_or_insert_with(|| {
            std::fs::read_dir(dir)
                .map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
                .unwrap_or_default()
        })
    }

    fn has(&self, name: &str) -> bool {
        self.dir.join(name).is_file()
    }

    fn has_prefix(&mut self, prefix: &str) -> bool {
        self.names().iter().any(|n| n.starts_with(prefix))
    }

    pub fn has_key(&mut self, marker: &KeyMarker) -> bool {
        let dir = &self.dir;
        let doc = self.parsed.entry(marker.file.clone()).or_insert_with(|| {
            let text = std::fs::read_to_string(dir.join(&marker.file)).ok()?;
            if marker.file.ends_with(".toml") {
                toml::from_str::<toml::Value>(&text).ok().and_then(|v| serde_json::to_value(v).ok())
            } else {
                serde_json::from_str(&text).ok()
            }
        });
        let Some(mut node) = doc.as_ref() else { return false };
        for segment in &marker.path {
            match node.get(segment) {
                Some(next) => node = next,
                None => return false,
            }
        }
        true
    }
}

// --- raw TOML shape, validated before the typed struct is trusted ---

#[derive(Debug, Deserialize)]
struct FormatterToml {
    schema_version: u32,
    id: String,
    label: String,
    #[serde(default)]
    priority: i32,
    #[serde(default)]
    extensions: Option<Vec<String>>,
    #[serde(default)]
    markers: MarkersToml,
    launch: LaunchToml,
    #[serde(default)]
    not_applicable: Option<NotApplicableToml>,
    #[serde(default)]
    verified_against: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct MarkersToml {
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    prefixes: Vec<String>,
    #[serde(default)]
    keys: Vec<KeyMarkerToml>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct KeyMarkerToml {
    file: String,
    key: String,
}

impl KeyMarkerToml {
    pub(crate) fn validate(self, field: &str, source: &str) -> Result<KeyMarker, String> {
        if !(self.file.ends_with(".json") || self.file.ends_with(".toml")) {
            return Err(format!("{source}: {field} can only read a .json or .toml file, not `{}`", self.file));
        }
        Ok(KeyMarker { file: self.file, path: self.key.split('.').map(str::to_string).collect() })
    }
}

#[derive(Debug, Deserialize)]
struct LaunchToml {
    kind: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct NotApplicableToml {
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    stderr: Option<String>,
}

const KNOWN_TOP_LEVEL: &[&str] = &[
    "schema_version",
    "id",
    "label",
    "priority",
    "extensions",
    "verified_against",
    "markers",
    "launch",
    "not_applicable",
];

const REQUIRED_TOP_LEVEL: &[&str] = &["schema_version", "id", "label", "launch"];

/// Parse and validate one formatter TOML. `source` labels the origin in errors.
pub fn load_formatter_str(text: &str, source: &str) -> Result<Formatter, String> {
    let value: toml::Value = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if let Some(table) = value.as_table() {
        for key in table.keys() {
            if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
                eprintln!("tori: formatter {source}: unknown field `{key}`, ignoring");
            }
        }
        let missing: Vec<&str> =
            REQUIRED_TOP_LEVEL.iter().filter(|k| !table.contains_key(**k)).copied().collect();
        if !missing.is_empty() {
            return Err(format!("{source}: missing required field(s): {}", missing.join(", ")));
        }
    }

    let raw: FormatterToml = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if !SUPPORTED_SCHEMA_VERSIONS.contains(&raw.schema_version) {
        let supported = SUPPORTED_SCHEMA_VERSIONS.map(|v| v.to_string()).join(", ");
        return Err(format!(
            "{source}: unsupported schema_version {} (tori supports {supported})",
            raw.schema_version
        ));
    }

    let launch = match raw.launch.kind.as_str() {
        "project_bin" => LaunchKind::ProjectBin,
        "path" => LaunchKind::Path,
        other => {
            return Err(format!("{source}: unknown launch.kind `{other}` (tori implements: project_bin, path)"))
        }
    };

    let extensions = match raw.extensions {
        Some(list) if list.is_empty() => {
            return Err(format!("{source}: `extensions` is empty; leave it out to take any file"))
        }
        Some(list) => Some(list.into_iter().map(|e| e.trim_start_matches('.').to_lowercase()).collect()),
        None => None,
    };

    let keys = raw
        .markers
        .keys
        .into_iter()
        .map(|k| k.validate("markers.keys", source))
        .collect::<Result<Vec<_>, _>>()?;
    let markers = Markers { files: raw.markers.files, prefixes: raw.markers.prefixes, keys };

    // An empty table would match every failure, which would hand a file with a
    // syntax error on to the next formatter instead of saying what is wrong.
    let not_applicable = match raw.not_applicable {
        None => None,
        Some(NotApplicableToml { exit_code: None, stderr: None }) => {
            return Err(format!("{source}: not_applicable needs `exit_code`, `stderr`, or both"))
        }
        Some(NotApplicableToml { exit_code, stderr }) => Some(NotApplicable {
            exit_code,
            stderr: stderr
                .map(|p| Regex::new(&p).map_err(|e| format!("{source}: not_applicable.stderr is not a valid pattern: {e}")))
                .transpose()?,
        }),
    };

    Ok(Formatter {
        id: raw.id,
        label: raw.label,
        priority: raw.priority,
        extensions,
        markers,
        launch,
        program: raw.launch.program,
        args: raw.launch.args,
        not_applicable,
        verified_against: raw.verified_against,
    })
}

pub(crate) const BUILTINS: &[(&str, &str)] = &[
    ("bundled:biome", include_str!("../../formatters/biome.toml")),
    ("bundled:prettier", include_str!("../../formatters/prettier.toml")),
    ("bundled:oxfmt", include_str!("../../formatters/oxfmt.toml")),
    ("bundled:ruff", include_str!("../../formatters/ruff.toml")),
    ("bundled:black", include_str!("../../formatters/black.toml")),
    ("bundled:gofmt", include_str!("../../formatters/gofmt.toml")),
    ("bundled:shfmt", include_str!("../../formatters/shfmt.toml")),
    ("bundled:stylua", include_str!("../../formatters/stylua.toml")),
    ("bundled:vite-plus", include_str!("../../formatters/vite-plus.toml")),
];

fn user_formatters_dir() -> PathBuf {
    crate::owned_state::config_dir().join("formatters")
}

/// Bundled built-ins, then every `*.toml` in `user_dir`, whole-replacing by id.
fn build_registry_from(user_dir: &Path) -> Vec<Formatter> {
    let mut by_id: BTreeMap<String, Formatter> = BTreeMap::new();

    for (source, text) in BUILTINS {
        match load_formatter_str(text, source) {
            Ok(f) => {
                by_id.insert(f.id.clone(), f);
            }
            Err(e) => eprintln!("tori: ERROR loading built-in formatter {source}: {e}"),
        }
    }

    let mut files: Vec<PathBuf> = std::fs::read_dir(user_dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| p.extension().and_then(|e| e.to_str()) == Some("toml"));
    files.sort();

    for path in files {
        let source = path.to_string_lossy().into_owned();
        let loaded = std::fs::read_to_string(&path)
            .map_err(|e| format!("{source}: {e}"))
            .and_then(|text| load_formatter_str(&text, &source));
        match loaded {
            Ok(f) => {
                by_id.insert(f.id.clone(), f);
            }
            Err(e) => eprintln!("tori: ERROR loading formatter {e} (keeping the previous formatter for this id)"),
        }
    }

    by_id.into_values().collect()
}

static REGISTRY: OnceLock<Vec<Formatter>> = OnceLock::new();

/// Every formatter, loaded once on first use. Restart to pick up an edit.
pub fn registry() -> &'static [Formatter] {
    REGISTRY.get_or_init(|| build_registry_from(&user_formatters_dir()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const VALID: &str = r#"
schema_version = 1
id = "demo"
label = "Demo"
[launch]
kind = "path"
program = "demo-fmt"
args = ["--stdin", "{file}"]
"#;

    fn temp_dir(name: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tori_fmt_registry_{}_{name}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_bundled_formatter_parses() {
        for (source, text) in BUILTINS {
            load_formatter_str(text, source).unwrap_or_else(|e| panic!("{e}"));
        }
    }

    #[test]
    fn biome_outranks_prettier() {
        let bundled = build_registry_from(Path::new("/nonexistent"));
        let priority = |id: &str| bundled.iter().find(|f| f.id == id).unwrap().priority;
        assert!(priority("biome") > priority("prettier"));
    }

    #[test]
    fn file_is_substituted_wherever_it_appears_in_an_argument() {
        let f = load_formatter_str(&VALID.replace("\"{file}\"", "\"--path={file}\""), "test").unwrap();
        assert_eq!(f.args_for("/p/a.ts"), vec!["--stdin", "--path=/p/a.ts"]);
    }

    #[test]
    fn an_unknown_launch_kind_is_rejected_by_name() {
        let err = load_formatter_str(&VALID.replace("\"path\"", "\"bundled_node\""), "test").unwrap_err();
        assert!(err.contains("bundled_node") && err.contains("project_bin"), "{err}");
    }

    #[test]
    fn a_missing_field_is_reported_all_at_once() {
        let err = load_formatter_str("schema_version = 1\nid = \"x\"\n", "test").unwrap_err();
        assert!(err.contains("label") && err.contains("launch"), "{err}");
    }

    #[test]
    fn an_unsupported_schema_version_is_rejected() {
        let err = load_formatter_str(&VALID.replace("schema_version = 1", "schema_version = 7"), "test").unwrap_err();
        assert!(err.contains('7'), "{err}");
    }

    #[test]
    fn an_empty_not_applicable_table_is_rejected() {
        let err = load_formatter_str(&format!("{VALID}\n[not_applicable]\n"), "test").unwrap_err();
        assert!(err.contains("exit_code"), "{err}");
    }

    #[test]
    fn a_bad_stderr_pattern_is_a_load_error() {
        let err = load_formatter_str(&format!("{VALID}\n[not_applicable]\nstderr = \"(\"\n"), "test").unwrap_err();
        assert!(err.contains("not_applicable.stderr"), "{err}");
    }

    #[test]
    fn not_applicable_needs_every_condition_it_names() {
        let f = load_formatter_str(&format!("{VALID}\n[not_applicable]\nexit_code = 2\nstderr = \"No parser\"\n"), "test")
            .unwrap();
        let na = f.not_applicable.unwrap();
        assert!(na.matches(2, "[error] No parser could be inferred"));
        assert!(!na.matches(2, "SyntaxError: '}' expected"));
        assert!(!na.matches(1, "No parser could be inferred"));
    }

    #[test]
    fn a_key_marker_must_read_a_file_it_can_parse() {
        let text = format!("{VALID}\n[markers]\nkeys = [{{ file = \"setup.cfg\", key = \"x\" }}]\n");
        assert!(load_formatter_str(&text, "test").unwrap_err().contains("setup.cfg"));
    }

    #[test]
    fn extensions_normalise_and_absent_means_any_file() {
        let any = load_formatter_str(VALID, "test").unwrap();
        assert!(any.claims(Some("rs")) && any.claims(None));
        assert!(!any.names(Some("rs")));

        let some = load_formatter_str(&VALID.replace("[launch]", "extensions = [\".PY\"]\n[launch]"), "test").unwrap();
        assert!(some.claims(Some("py")) && some.names(Some("py")));
        assert!(!some.claims(Some("rs")) && !some.claims(None));
    }

    #[test]
    fn a_dotfile_has_no_extension() {
        assert_eq!(extension_of(Path::new("/p/.prettierrc")), None);
        assert_eq!(extension_of(Path::new("/p/Makefile")), None);
        assert_eq!(extension_of(Path::new("/p/a.PY")), Some("py".into()));
    }

    #[test]
    fn key_markers_read_json_and_toml_by_dotted_path() {
        let dir = temp_dir("keys");
        std::fs::write(dir.join("pyproject.toml"), "[tool.ruff]\nline-length = 100\n").unwrap();
        std::fs::write(dir.join("package.json"), r#"{"devDependencies":{"vite-plus":"1"}}"#).unwrap();
        let key = |file: &str, key: &str| KeyMarker { file: file.into(), path: key.split('.').map(Into::into).collect() };
        let mut scan = DirScan::new(&dir);
        assert!(scan.has_key(&key("pyproject.toml", "tool.ruff")));
        assert!(!scan.has_key(&key("pyproject.toml", "tool.black")));
        assert!(scan.has_key(&key("package.json", "devDependencies.vite-plus")));
        assert!(!scan.has_key(&key("package.json", "prettier")));
        assert!(!scan.has_key(&key("missing.json", "x")));
    }

    /// FORMATTERS.md is what a config author copies from, so every TOML block
    /// in it has to load.
    #[test]
    fn every_toml_block_in_formatters_md_loads() {
        let doc = include_str!("../../../docs/FORMATTERS.md");
        let blocks: Vec<&str> =
            doc.split("```toml").skip(1).map(|rest| rest.split("```").next().unwrap()).collect();
        assert_eq!(blocks.len(), 3, "the schema, the from-scratch example and the override");
        let ids: Vec<String> = blocks
            .iter()
            .map(|b| load_formatter_str(b, "FORMATTERS.md").unwrap_or_else(|e| panic!("{e}")).id)
            .collect();
        assert_eq!(ids, vec!["prettier", "clang-format", "prettier"]);
    }

    #[test]
    fn a_user_file_whole_replaces_a_builtin_by_id() {
        let dir = temp_dir("override");
        std::fs::write(dir.join("prettier.toml"), VALID.replace("\"demo\"", "\"prettier\"").replace("Demo", "Mine"))
            .unwrap();
        let list = build_registry_from(&dir);
        let prettier = list.iter().find(|f| f.id == "prettier").unwrap();
        assert_eq!(prettier.label, "Mine");
        assert!(prettier.markers.prefixes.is_empty(), "whole-replace, not a merge");
        assert!(list.iter().any(|f| f.id == "biome"));
    }

    #[test]
    fn a_broken_user_file_keeps_the_previous_entry() {
        let dir = temp_dir("broken");
        std::fs::write(dir.join("biome.toml"), "schema_version = 1\nid = \"biome\"\n").unwrap();
        std::fs::write(dir.join("notes.md"), "not a config").unwrap();
        let list = build_registry_from(&dir);
        let biome = list.iter().find(|f| f.id == "biome").expect("must not disappear");
        assert_eq!(biome.label, "Biome");
        assert_eq!(list.len(), BUILTINS.len());
    }
}
