// The formatter for a file, asked in this order, first answer wins: the
// workspace's `format.byExtension`, then the project's own config found the way
// the formatter itself finds it (walking up from the file), then the user's
// `format.byExtension`. With none of those nothing runs here, and the editor
// falls back to the language server's own formatting, which is what it did
// before this module existed. A project with no config never gets a CLI
// formatter unasked: formatting with defaults puts a surprise diff in somebody's
// pull request.
//
// Formatters are data (`format/registry.rs`, FORMATTERS.md), and every one is
// driven over stdin/stdout rather than by being pointed at the file.
// Formatting on save has to act on what is in the buffer, which is by
// definition not what is on disk yet; a CLI told to fix a file in place would
// format the version the user is about to overwrite.

pub mod registry;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use registry::{DirScan, Formatter, LaunchKind};

/// Long enough for a cold `prettier` (node start plus a large file), short
/// enough that a wedged formatter cannot hold a save open forever. Deliberately
/// longer than `env::PROBE_TIMEOUT`, which sizes a `--version` probe.
const FORMAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// A formatter, and the directory whose config named it.
#[derive(Debug)]
pub struct Detected<'a> {
    pub formatter: &'a Formatter,
    /// The directory the config was found in. Both the formatter's working
    /// directory and where `node_modules/.bin` is looked for first.
    pub dir: PathBuf,
}

/// Every formatter the project's own config names for `file`, in the order
/// they are asked: nearest directory first, walking up to `project_root`
/// (inclusive). Within one directory a formatter that names the file's
/// extension comes before one that takes any file, then higher `priority`:
/// `ruff.toml` beside `biome.json` asks ruff first for Python, and `biome.json`
/// beside `.prettierrc` asks Biome first.
///
/// Stopping at the project root is what keeps a stray `~/.prettierrc` from
/// silently reformatting every file in a project that never asked for it - and
/// that floor only exists if the root is actually above the file. A file from
/// outside the project (a Shared-tree tab) or a call with no project at all
/// would otherwise never meet the stop condition and walk all the way to `/`,
/// which is the same failure by a different route.
pub fn detect<'a>(formatters: &'a [Formatter], file: &Path, project_root: &Path) -> Vec<Detected<'a>> {
    let mut found = Vec::new();
    if project_root.as_os_str().is_empty() || !file.starts_with(project_root) {
        return found;
    }
    let ext = registry::extension_of(file);
    let ext = ext.as_deref();
    let mut dir = file.parent();
    while let Some(current) = dir {
        let mut scan = DirScan::new(current);
        let mut here: Vec<&Formatter> = formatters
            .iter()
            .filter(|f| f.claims(ext) && f.is_configured_in(&mut scan))
            .collect();
        here.sort_by_key(|f| std::cmp::Reverse((f.names(ext), f.priority, std::cmp::Reverse(f.id.as_str()))));
        found.extend(here.into_iter().map(|formatter| Detected {
            formatter,
            dir: current.to_path_buf(),
        }));
        if current == project_root {
            break;
        }
        dir = current.parent();
    }
    found
}

fn config_dir(formatter: &Formatter, file: &Path, project_root: &Path) -> PathBuf {
    let start = file.parent().unwrap_or(project_root);
    let mut dir = Some(start);
    while let Some(current) = dir {
        if formatter.is_configured_in(&mut DirScan::new(current)) {
            return current.to_path_buf();
        }
        if current == project_root {
            break;
        }
        dir = current.parent();
    }
    start.to_path_buf()
}

/// The formatter binary.
///
/// For `project_bin` the project's own copy comes first and the login PATH
/// behind it. Order matters and is not a preference. A repo pins its
/// formatter's version in `package.json` precisely so everyone's output
/// matches; a globally installed Prettier one major behind would reformat the
/// whole file on the first save and put the diff in somebody's pull request.
fn resolve(formatter: &Formatter, from: &Path, project_root: &Path) -> Option<PathBuf> {
    match formatter.launch {
        LaunchKind::ProjectBin => project_bin(&formatter.program, from, project_root),
        LaunchKind::Path => crate::env::resolve_binary(&formatter.program),
    }
}

// The names uv and `python -m venv` use. Poetry and pipenv keep theirs outside
// the project by default, so their tools come from the PATH.
const PROJECT_BIN_DIRS: [&str; 3] = ["node_modules/.bin", ".venv/bin", "venv/bin"];

/// `program` from the nearest `node_modules/.bin` or Python virtualenv between
/// `from` and `project_root`, else the login PATH. The resolver behind both a
/// formatter and a `project_bin` language server.
pub fn project_bin(program: &str, from: &Path, project_root: &Path) -> Option<PathBuf> {
    let mut dir = Some(from);
    while let Some(current) = dir {
        if let Some(candidate) = PROJECT_BIN_DIRS
            .iter()
            .map(|d| current.join(d).join(program))
            .find(|c| c.is_file())
        {
            return Some(candidate);
        }
        if current == project_root {
            break;
        }
        dir = current.parent();
    }
    crate::env::resolve_binary(program)
}

#[derive(Debug)]
struct Failure {
    /// Set only when the formatter itself exited, the one case `not_applicable`
    /// can describe. A spawn error, a timeout or a signal leaves it empty.
    code: Option<i32>,
    stderr: String,
    message: String,
}

impl Failure {
    fn other(message: String) -> Self {
        Self {
            code: None,
            stderr: String::new(),
            message,
        }
    }

    fn is_decline_by(&self, formatter: &Formatter) -> bool {
        let Some(code) = self.code else { return false };
        formatter
            .not_applicable
            .as_ref()
            .is_some_and(|na| na.matches(code, &self.stderr))
    }
}

/// Run `program` over `input`, returning its stdout.
///
/// Not `env::output_with_timeout`, which nulls stdin on purpose (a probe that
/// blocks on a prompt should see EOF). Here stdin *is* the document, so this
/// writes it and closes the pipe, on a thread: a formatter whose output outruns
/// the pipe buffer blocks on write while this process blocks on the stdin
/// write, and the two would deadlock waiting on each other.
fn run(program: &Path, args: &[String], cwd: &Path, input: &str) -> Result<String, Failure> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("PATH", crate::env::augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Failure::other(format!("could not run {}: {e}", program.display())))?;
    let pid = child.id();

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| Failure::other("the formatter took no input".into()))?;
    let owned = input.to_string();
    let writer = std::thread::spawn(move || {
        use std::io::Write;
        // The error is deliberately dropped: a formatter that rejects the
        // document closes stdin early, and a broken pipe here is that refusal,
        // not a separate failure. What it actually said comes back on stderr.
        let _ = stdin.write_all(owned.as_bytes());
    });

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    let output = match rx.recv_timeout(FORMAT_TIMEOUT) {
        Ok(result) => result.map_err(|e| Failure::other(e.to_string()))?,
        Err(_) => {
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
            let _ = writer.join();
            return Err(Failure::other(format!(
                "{} did not finish within {} seconds",
                program.display(),
                FORMAT_TIMEOUT.as_secs()
            )));
        }
    };
    let _ = writer.join();

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!("{} exited with {}", program.display(), output.status)
        } else {
            stderr.clone()
        };
        return Err(Failure {
            code: output.status.code(),
            stderr,
            message,
        });
    }
    String::from_utf8(output.stdout).map_err(|_| Failure::other("the formatter returned invalid UTF-8".into()))
}

/// What a format attempt produced.
///
/// `text` is **always** something safe to write: the formatter's output when it
/// succeeded, and the caller's own input in every other case. There is no shape
/// of this struct that asks the caller to decide whether the text is usable,
/// because the failure that matters is a half-formatted file on disk.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    pub text: String,
    /// The id of the formatter that ran. `None` means none applies, which is
    /// the signal to fall back to the language server's own formatting.
    pub formatter: Option<String>,
    /// What a formatter said when it refused. The text is unchanged.
    pub error: Option<String>,
}

impl FormatResult {
    fn none(text: String) -> Self {
        Self {
            text,
            formatter: None,
            error: None,
        }
    }

    fn refused(text: String, formatter: &str, error: String) -> Self {
        Self {
            text,
            formatter: Some(formatter.to_string()),
            error: Some(error),
        }
    }
}

/// `format.byExtension` from each settings file: extension (lowercase, no dot)
/// to formatter id. `disabled` is your `format.disabled`.
#[derive(Debug, Default)]
pub struct Choices {
    pub workspace: BTreeMap<String, String>,
    pub user: BTreeMap<String, String>,
    pub disabled: Vec<String>,
}

fn by_extension(pairs: impl IntoIterator<Item = (String, String)>) -> BTreeMap<String, String> {
    pairs
        .into_iter()
        .map(|(ext, id)| (ext.trim_start_matches('.').to_lowercase(), id))
        .collect()
}

fn workspace_choices(root: &str) -> BTreeMap<String, String> {
    if root.is_empty() {
        return BTreeMap::new();
    }
    let overlay = crate::workspace_settings::get_workspace_settings(root.to_string());
    let Some(map) = overlay.pointer("/format/byExtension").and_then(|v| v.as_object()) else {
        return BTreeMap::new();
    };
    by_extension(
        map.iter()
            .filter_map(|(ext, id)| Some((ext.clone(), id.as_str()?.to_string()))),
    )
}

// Only a `not_applicable` decline moves on down the chain. Any other refusal
// stops it, since a syntax error is the same error whoever formats next.
//
// The gate is asked only once a formatter is about to run, so a project with
// nothing to format never raises the trust question. No formatter is exempt:
// one found on PATH still loads the config the project ships.
fn format_with(
    formatters: &[Formatter],
    path: &str,
    text: String,
    root: &Path,
    choices: &Choices,
    gate: impl Fn(&Path) -> Result<(), String>,
) -> FormatResult {
    let file = Path::new(path);
    if root.as_os_str().is_empty() || !file.starts_with(root) {
        return FormatResult::none(text);
    }
    let ext = registry::extension_of(file).unwrap_or_default();
    let named = |map: &BTreeMap<String, String>| {
        map.get(&ext).map(|id| match formatters.iter().find(|f| &f.id == id) {
            Some(formatter) => Ok(Detected {
                formatter,
                dir: config_dir(formatter, file, root),
            }),
            None => Err(id.clone()),
        })
    };
    let rungs = named(&choices.workspace)
        .into_iter()
        .chain(detect(formatters, file, root).into_iter().map(Ok))
        .chain(named(&choices.user));

    let mut tried: Vec<&str> = Vec::new();
    for rung in rungs {
        let Detected { formatter, dir } = match rung {
            Ok(pick) => pick,
            Err(id) => {
                let error = format!(
                    "`{id}` is set to format .{ext} files, but no formatter has that id, so nothing was formatted."
                );
                return FormatResult::refused(text, &id, error);
            }
        };
        if tried.contains(&formatter.id.as_str()) || choices.disabled.contains(&formatter.id) {
            continue;
        }
        tried.push(&formatter.id);
        let Some(program) = resolve(formatter, &dir, root) else {
            let error = format!(
                "{} formats this file here, but `{}` is not installed, so nothing was formatted.",
                formatter.label, formatter.program
            );
            return FormatResult::refused(text, &formatter.id, error);
        };
        if let Err(refusal) = gate(root) {
            return FormatResult::refused(text, &formatter.id, refusal);
        }
        match run(&program, &formatter.args_for(path), &dir, &text) {
            Ok(formatted) => {
                return FormatResult {
                    text: formatted,
                    formatter: Some(formatter.id.clone()),
                    error: None,
                }
            }
            Err(failure) if failure.is_decline_by(formatter) => continue,
            Err(failure) => return FormatResult::refused(text, &formatter.id, failure.message),
        }
    }
    FormatResult::none(text)
}

/// Format `text` as this file's formatter would, addressed as `path`.
///
/// Never fails as a command. A missing binary, a syntax error, a formatter that
/// hangs: all come back as the original text plus a sentence to show, because
/// the alternative is a save that either silently does nothing or writes half a
/// file. The caller's fallback ladder reads off `formatter`: `None` means try
/// the language server instead.
#[tauri::command(async)]
pub fn format_document(path: String, text: String, project_path: String) -> FormatResult {
    let format = crate::settings::get_settings().format;
    let choices = Choices {
        workspace: workspace_choices(&project_path),
        user: by_extension(format.by_extension),
        disabled: format.disabled,
    };
    format_with(
        &registry::registry(),
        &path,
        text,
        Path::new(&project_path),
        &choices,
        crate::trust::gate_project,
    )
}

/// A formatter's card in Settings, read the way `lsp::LspHealth` reads.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormatterHealth {
    pub id: String,
    pub label: String,
    pub program: String,
    /// Of `program` on the login PATH.
    pub status: crate::health::BinaryStatus,
    pub version: Option<String>,
    pub verified_against: Option<String>,
    pub verified_on: Option<String>,
    #[serde(flatten)]
    pub meta: crate::packs::Meta,
    /// `None` takes any file the formatter has a parser for.
    pub extensions: Option<Vec<String>>,
    /// What turns it on in a project. A prefix reads as `.prettierrc*`, a key
    /// as `package.json [prettier]`.
    pub markers: Vec<String>,
    /// Found in the project's own install before the PATH, so a probe from
    /// Settings, which has no project, cannot say it is missing.
    pub runs_per_project: bool,
    /// Named in your `format.disabled`.
    pub disabled: bool,
    pub provenance: crate::packs::provenance::Provenance,
}

/// Health for every registered formatter.
#[tauri::command(async)]
pub fn formatter_health() -> Vec<FormatterHealth> {
    let disabled = crate::settings::get_settings().format.disabled;
    registry::registry()
        .iter()
        .map(|f| {
            let path = crate::env::resolve_binary(&f.program);
            let version = path.as_deref().and_then(crate::health::run_version);
            let markers = &f.markers;
            FormatterHealth {
                id: f.id.clone(),
                label: f.label.clone(),
                program: f.program.clone(),
                status: match path {
                    None => crate::health::BinaryStatus::NotFound,
                    Some(_) => crate::health::compare(version.as_deref(), f.verified_against.as_deref()),
                },
                version,
                verified_against: f.verified_against.clone(),
                verified_on: f.verified_on.clone(),
                meta: f.meta.clone(),
                provenance: f.provenance,
                extensions: f.extensions.clone(),
                markers: markers
                    .files
                    .iter()
                    .cloned()
                    .chain(markers.prefixes.iter().map(|p| format!("{p}*")))
                    .chain(
                        markers
                            .keys
                            .iter()
                            .map(|k| format!("{} [{}]", k.file, k.path.join("."))),
                    )
                    .collect(),
                runs_per_project: f.launch == LaunchKind::ProjectBin,
                disabled: disabled.contains(&f.id),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use registry::load_formatter_str;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_tree() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori_format_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// A stand-in formatter, so the plumbing (stdin in, stdout out, stderr and
    /// exit status on refusal) is tested without needing Biome or Prettier
    /// installed. Same trick as the LSP suite's `/bin/cat` echo server.
    fn stub(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn bundled() -> Vec<Formatter> {
        registry::builtins()
            .map(|(source, text)| load_formatter_str(text, &source).unwrap())
            .collect()
    }

    fn bundled_one(id: &str) -> Formatter {
        bundled().into_iter().find(|f| f.id == id).unwrap()
    }

    fn bundled_one_text(id: &str) -> &'static str {
        crate::packs::snapshot::text("formatters", id).unwrap()
    }

    /// A formatter config run from the project's `node_modules/.bin/<id>`.
    /// `top` holds bare keys, `tables` the tables after `[launch]`.
    fn formatter(id: &str, top: &str, tables: &str) -> Formatter {
        let text = format!(
            "schema_version = 1\nid = \"{id}\"\nlabel = \"{id}\"\n{top}\n[launch]\nkind = \"project_bin\"\nprogram = \"{id}\"\n{tables}\n"
        );
        load_formatter_str(&text, "test").unwrap()
    }

    fn detected(formatters: &[Formatter], file: &Path, root: &Path) -> Option<String> {
        detect(formatters, file, root).first().map(|d| d.formatter.id.clone())
    }

    fn format(formatters: &[Formatter], file: &Path, text: &str, root: &Path, choices: &Choices) -> FormatResult {
        format_with(formatters, &file.to_string_lossy(), text.into(), root, choices, |_| {
            Ok(())
        })
    }

    fn choose(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(ext, id)| (ext.to_string(), id.to_string()))
            .collect()
    }

    const DECLINE: &str = "cat >/dev/null\necho 'No parser could be inferred' >&2\nexit 2";

    #[test]
    fn a_biome_config_names_biome() {
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("src/a.ts"), "");
        let formatters = bundled();
        let found = detect(&formatters, &root.join("src/a.ts"), &root).remove(0);
        assert_eq!(found.formatter.id, "biome");
        assert_eq!(found.dir, root);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn every_prettier_config_spelling_is_recognised() {
        // The list grows, and a spelling this missed would read as a project
        // that does not format rather than as an unrecognised file.
        for name in [
            ".prettierrc",
            ".prettierrc.json",
            ".prettierrc.yaml",
            ".prettierrc.js",
            ".prettierrc.mjs",
            "prettier.config.js",
            "prettier.config.mjs",
            "prettier.config.ts",
        ] {
            let root = tmp_tree();
            touch(&root.join(name), "{}");
            touch(&root.join("a.ts"), "");
            assert_eq!(
                detected(&bundled(), &root.join("a.ts"), &root).as_deref(),
                Some("prettier"),
                "{name} should name Prettier"
            );
            std::fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn package_json_can_carry_the_prettier_config_itself() {
        let root = tmp_tree();
        touch(&root.join("package.json"), r#"{"name":"x","prettier":{"semi":false}}"#);
        touch(&root.join("a.ts"), "");
        assert_eq!(
            detected(&bundled(), &root.join("a.ts"), &root).as_deref(),
            Some("prettier")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_package_json_without_the_key_names_nothing() {
        // Every JS project has a package.json; only the `prettier` key means
        // anything, and treating the file's presence as the signal would format
        // every repo on the machine.
        let root = tmp_tree();
        touch(&root.join("package.json"), r#"{"name":"x","scripts":{}}"#);
        touch(&root.join("a.ts"), "");
        assert_eq!(detected(&bundled(), &root.join("a.ts"), &root), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_bare_directory_has_no_formatter() {
        let root = tmp_tree();
        touch(&root.join("a.ts"), "");
        assert_eq!(detected(&bundled(), &root.join("a.ts"), &root), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_nearest_config_wins() {
        // A monorepo package that formats differently from the repo around it.
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("packages/a/.prettierrc"), "{}");
        touch(&root.join("packages/a/src/x.ts"), "");
        let formatters = bundled();
        let found = detect(&formatters, &root.join("packages/a/src/x.ts"), &root).remove(0);
        assert_eq!(found.formatter.id, "prettier");
        assert_eq!(found.dir, root.join("packages/a"));
        // And a file outside that package still gets the repo's own.
        assert_eq!(
            detected(&bundled(), &root.join("tools/y.ts"), &root).as_deref(),
            Some("biome")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn biome_wins_a_directory_holding_both() {
        // A migrated repo that left the old dotfile behind. The newer tool is
        // the one CI is running.
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join(".prettierrc"), "{}");
        touch(&root.join("a.ts"), "");
        assert_eq!(
            detected(&bundled(), &root.join("a.ts"), &root).as_deref(),
            Some("biome")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn same_directory_precedence_follows_priority_not_the_name() {
        let root = tmp_tree();
        touch(&root.join("a.cfg"), "");
        touch(&root.join("z.cfg"), "");
        let pair = |a: i32, z: i32| {
            [
                formatter("aaa", &format!("priority = {a}"), "[markers]\nfiles = [\"a.cfg\"]"),
                formatter("zzz", &format!("priority = {z}"), "[markers]\nfiles = [\"z.cfg\"]"),
            ]
        };
        assert_eq!(detected(&pair(0, 1), &root.join("x.ts"), &root).as_deref(), Some("zzz"));
        assert_eq!(detected(&pair(1, 0), &root.join("x.ts"), &root).as_deref(), Some("aaa"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_formatter_naming_the_extension_beats_one_taking_any_file() {
        // `ruff.toml` beside `biome.json`: Biome outranks ruff, and asking it
        // first would start it only to decline.
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("py.toml"), "");
        let mut formatters = bundled();
        formatters.push(formatter(
            "pyfmt",
            "extensions = [\"py\"]",
            "[markers]\nfiles = [\"py.toml\"]",
        ));
        assert_eq!(
            detected(&formatters, &root.join("a.py"), &root).as_deref(),
            Some("pyfmt")
        );
        assert_eq!(
            detected(&formatters, &root.join("a.ts"), &root).as_deref(),
            Some("biome")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_walk_stops_at_the_project_root() {
        // Otherwise a stray ~/.prettierrc reformats every file in a project
        // that never asked for one.
        let outer = tmp_tree();
        touch(&outer.join(".prettierrc"), "{}");
        let root = outer.join("repo");
        touch(&root.join("src/a.ts"), "");
        assert_eq!(detected(&bundled(), &root.join("src/a.ts"), &root), None);
        std::fs::remove_dir_all(&outer).ok();
    }

    #[test]
    fn a_file_from_outside_the_project_gets_no_formatter() {
        // A Shared-tree tab: a real file that is not under the open project. It
        // never meets the stop condition, so without the ancestry check the
        // walk runs past it to `/` and picks up whatever config lives there.
        let outer = tmp_tree();
        touch(&outer.join(".prettierrc"), "{}");
        let root = outer.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        touch(&outer.join("elsewhere/notes.ts"), "");
        assert_eq!(detected(&bundled(), &outer.join("elsewhere/notes.ts"), &root), None);
        std::fs::remove_dir_all(&outer).ok();
    }

    #[test]
    fn no_project_means_no_formatter_rather_than_a_walk_to_the_root() {
        // What the editor sends when no workspace is selected. An empty root is
        // a prefix of every path, so the walk would have no floor at all.
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("a.ts"), "");
        assert_eq!(detected(&bundled(), &root.join("a.ts"), Path::new("")), None);
        let choices = Choices {
            user: choose(&[("ts", "biome")]),
            ..Choices::default()
        };
        let out = format(&bundled(), &root.join("a.ts"), "const  x=1\n", Path::new(""), &choices);
        assert_eq!(out, FormatResult::none("const  x=1\n".into()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn each_formatter_is_told_the_file_its_own_way() {
        // One hyphen apart between the first two, and getting it wrong means the
        // formatter picks its parser off nothing and reformats a .ts file as
        // whatever it guesses. Each line was run against the real binary.
        let args = |id: &str, file: &str| bundled_one(id).args_for(file);
        assert_eq!(args("biome", "/p/a.ts"), vec!["format", "--stdin-file-path", "/p/a.ts"]);
        assert_eq!(args("prettier", "/p/a.ts"), vec!["--stdin-filepath", "/p/a.ts"]);
        assert_eq!(args("oxfmt", "/p/a.ts"), vec!["--stdin-filepath", "/p/a.ts"]);
        assert_eq!(
            args("ruff", "/p/a.py"),
            vec!["format", "--stdin-filename", "/p/a.py", "-"]
        );
        assert_eq!(
            args("black", "/p/a.py"),
            vec!["--quiet", "--stdin-filename", "/p/a.py", "-"]
        );
        assert_eq!(args("gofmt", "/p/a.go"), Vec::<String>::new());
        assert_eq!(args("shfmt", "/p/a.sh"), vec!["--filename", "/p/a.sh"]);
        assert_eq!(args("stylua", "/p/a.lua"), vec!["--stdin-filepath", "/p/a.lua", "-"]);
        assert_eq!(args("vite-plus", "/p/a.ts"), vec!["fmt", "--stdin-filepath", "/p/a.ts"]);
        assert_eq!(bundled().len(), 9, "a bundled formatter with no args line here");
    }

    #[test]
    fn a_py_file_under_ruff_toml_formats_with_ruff() {
        // What a save in a Python repo does. The stand-in checks it was called
        // the way ruff is.
        let root = tmp_tree();
        touch(&root.join("ruff.toml"), "");
        touch(&root.join(".prettierrc"), "{}");
        let fake = stub(
            &root.join("bin"),
            "ruff",
            "[ \"$1 $2 $4\" = \"format --stdin-filename -\" ] || exit 9\ntr -s ' '",
        );
        let ruff = registry::load_formatter_str(
            &bundled_one_text("ruff").replace("program = \"ruff\"", &format!("program = \"{}\"", fake.display())),
            "test",
        )
        .unwrap();
        let mut formatters: Vec<Formatter> = bundled().into_iter().filter(|f| f.id != "ruff").collect();
        formatters.push(ruff);
        let out = format(
            &formatters,
            &root.join("app/main.py"),
            "x  =  1\n",
            &root,
            &Choices::default(),
        );
        assert_eq!(
            (out.formatter.as_deref(), out.text.as_str(), out.error),
            (Some("ruff"), "x = 1\n", None)
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pyproject_counts_only_with_a_ruff_table() {
        let root = tmp_tree();
        touch(&root.join("pyproject.toml"), "[project]\nname = \"x\"\n");
        assert_eq!(detected(&bundled(), &root.join("a.py"), &root), None);
        touch(&root.join("pyproject.toml"), "[tool.ruff]\nline-length = 100\n");
        assert_eq!(detected(&bundled(), &root.join("a.py"), &root).as_deref(), Some("ruff"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn shfmt_runs_only_when_a_setting_names_it() {
        let root = tmp_tree();
        touch(&root.join(".editorconfig"), "[*.sh]\nindent_size = 2\n");
        assert_eq!(detected(&bundled(), &root.join("a.sh"), &root), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_projects_own_binary_is_preferred_over_the_login_path() {
        // A repo pins its formatter's version so everyone's output matches; a
        // global copy one major behind would reformat the whole file on the
        // first save.
        let root = tmp_tree();
        let local = stub(&root.join("node_modules/.bin"), "prettier", "cat");
        assert_eq!(resolve(&bundled_one("prettier"), &root, &root), Some(local));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_project_copy_beats_a_login_path_copy_of_the_same_program() {
        // `sh` is on every PATH, so the project copy winning is the order, not luck.
        let root = tmp_tree();
        let local = stub(&root.join("node_modules/.bin"), "sh", "exit 0");
        assert_eq!(project_bin("sh", &root, &root), Some(local));
        let bare = tmp_tree();
        assert_eq!(project_bin("sh", &bare, &bare), crate::env::resolve_binary("sh"));
        assert!(project_bin("sh", &bare, &bare).is_some());
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&bare).ok();
    }

    #[test]
    fn a_path_formatter_ignores_the_projects_node_modules() {
        let root = tmp_tree();
        stub(&root.join("node_modules/.bin"), "sh", "exit 0");
        let on_path = load_formatter_str(
            "schema_version = 1\nid = \"s\"\nlabel = \"s\"\n[launch]\nkind = \"path\"\nprogram = \"sh\"\n",
            "test",
        )
        .unwrap();
        assert_eq!(resolve(&on_path, &root, &root), crate::env::resolve_binary("sh"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_nested_package_falls_back_to_the_repos_binary() {
        // The usual monorepo layout: one hoisted install at the root.
        let root = tmp_tree();
        let hoisted = stub(&root.join("node_modules/.bin"), "biome", "cat");
        std::fs::create_dir_all(root.join("packages/a")).unwrap();
        assert_eq!(
            resolve(&bundled_one("biome"), &root.join("packages/a"), &root),
            Some(hoisted)
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_run_sends_the_buffer_in_and_takes_the_result_out() {
        let root = tmp_tree();
        let upper = stub(&root, "upper", "tr '[:lower:]' '[:upper:]'");
        assert_eq!(run(&upper, &[], &root, "hello\n").unwrap(), "HELLO\n");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_run_carries_a_document_larger_than_a_pipe_buffer() {
        // The deadlock this guards: a formatter whose output fills the pipe
        // blocks on write while the parent blocks writing stdin. 512 KB is well
        // past the 64 KB macOS gives a pipe.
        let root = tmp_tree();
        let echo = stub(&root, "echo-all", "cat");
        let big = "x".repeat(512 * 1024);
        assert_eq!(run(&echo, &[], &root, &big).unwrap().len(), big.len());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_refusal_comes_back_as_what_the_formatter_said() {
        let root = tmp_tree();
        let angry = stub(&root, "angry", "echo 'a.ts:3:1 expected }' >&2\nexit 2");
        let err = run(&angry, &[], &root, "broken").unwrap_err();
        assert!(err.message.contains("expected }"), "got {}", err.message);
        assert_eq!(err.code, Some(2));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_silent_failure_still_says_something() {
        // Nothing on stderr and a non-zero exit is still a refusal, and "" is
        // not a message anyone can act on.
        let root = tmp_tree();
        let mute = stub(&root, "mute", "exit 3");
        let err = run(&mute, &[], &root, "x").unwrap_err();
        assert!(err.message.contains("exited with"), "got {}", err.message);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_wedged_formatter_cannot_hold_a_save_open_forever() {
        let root = tmp_tree();
        let slow = stub(&root, "slow", "sleep 60");
        let start = std::time::Instant::now();
        let err = run(&slow, &[], &root, "x").unwrap_err();
        assert!(err.message.contains("did not finish"), "got {}", err.message);
        assert_eq!(err.code, None, "a timeout is never a decline");
        assert!(start.elapsed() < FORMAT_TIMEOUT * 2, "took {:?}", start.elapsed());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_project_with_no_formatter_returns_the_text_untouched() {
        let root = tmp_tree();
        touch(&root.join("a.ts"), "");
        let out = format(
            &bundled(),
            &root.join("a.ts"),
            "const  x=1\n",
            &root,
            &Choices::default(),
        );
        assert_eq!(out, FormatResult::none("const  x=1\n".into()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_configured_but_uninstalled_formatter_names_itself_and_changes_nothing() {
        // The state a fresh clone is in before `npm install`. Silently doing
        // nothing here would read as "this project has no formatter".
        let root = tmp_tree();
        touch(&root.join("biome.json"), "{}");
        touch(&root.join("a.ts"), "");
        // A `node_modules/.bin/biome` that is a directory, not a binary: the
        // shape of a broken install, and enough to keep the real (possibly
        // installed) `biome` on this machine out of the test.
        std::fs::create_dir_all(root.join("node_modules/.bin/biome")).unwrap();
        let biome = load_formatter_str(
            &bundled_one_text("biome").replace(
                "program = \"biome\"",
                &format!("program = \"{}\"", root.join("node_modules/.bin/biome").display()),
            ),
            "test",
        )
        .unwrap();
        let out = format(&[biome], &root.join("a.ts"), "const  x=1\n", &root, &Choices::default());
        assert_eq!(out.formatter.as_deref(), Some("biome"));
        assert_eq!(out.text, "const  x=1\n");
        assert!(out.error.unwrap().contains("not installed"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_detected_formatter_runs_and_its_output_comes_back() {
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        touch(&root.join("a.ts"), "");
        stub(&root.join("node_modules/.bin"), "prettier", "tr -d ' '");
        let out = format(
            &bundled(),
            &root.join("a.ts"),
            "const  x = 1\n",
            &root,
            &Choices::default(),
        );
        assert_eq!(out.formatter.as_deref(), Some("prettier"));
        assert_eq!(out.error, None);
        assert_eq!(out.text, "constx=1\n");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_untrusted_project_runs_no_formatter_not_even_one_from_path() {
        // The project-local binary and the PATH one are the same risk: the
        // second still evaluates the `prettier.config.js` the repo ships.
        let root = tmp_tree();
        touch(&root.join("prettier.config.js"), "module.exports = {}");
        touch(&root.join("a.ts"), "");
        let ran = root.join("ran");
        stub(
            &root.join("node_modules/.bin"),
            "prettier",
            &format!("touch '{}'\ntr -d ' '", ran.display()),
        );
        let markers = "[markers]\nprefixes = [\"prettier.config.\"]";
        let local = formatter("prettier", "", markers);
        let on_path = load_formatter_str(
            &format!("schema_version = 1\nid = \"onpath\"\nlabel = \"onpath\"\n{markers}\n[launch]\nkind = \"path\"\nprogram = \"tr\"\nargs = [\"-d\", \" \"]\n"),
            "test",
        )
        .unwrap();
        let file = root.join("a.ts").to_string_lossy().into_owned();
        let untrusted = |_: &Path| Err(crate::trust::UNTRUSTED.to_string());

        for one in [local, on_path] {
            let formatters = [one];
            let out = format_with(
                &formatters,
                &file,
                "const  x = 1\n".into(),
                &root,
                &Choices::default(),
                untrusted,
            );
            assert_eq!(
                out.error.as_deref(),
                Some(crate::trust::UNTRUSTED),
                "{}",
                formatters[0].id
            );
            assert_eq!(out.text, "const  x = 1\n");
            assert!(!ran.exists(), "{} ran in an untrusted project", formatters[0].id);

            let out = format_with(
                &formatters,
                &file,
                "const  x = 1\n".into(),
                &root,
                &Choices::default(),
                |_| Ok(()),
            );
            assert_eq!(out.error, None, "{}", formatters[0].id);
            assert_eq!(out.text, "constx=1\n");
            assert_eq!(ran.exists(), formatters[0].launch == LaunchKind::ProjectBin);
            std::fs::remove_file(&ran).ok();
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_formatter_that_refuses_leaves_the_text_byte_identical() {
        // The one thing this must never do is write half a file. A syntax error
        // mid-edit is the common case, not the exotic one.
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        touch(&root.join("a.ts"), "");
        stub(
            &root.join("node_modules/.bin"),
            "prettier",
            "echo 'unexpected token' >&2\nexit 2",
        );
        let original = "const x = {\n";
        let out = format(&bundled(), &root.join("a.ts"), original, &root, &Choices::default());
        assert_eq!(out.text, original);
        assert_eq!(out.error.as_deref(), Some("unexpected token"));
        std::fs::remove_dir_all(&root).ok();
    }

    fn upper(root: &Path) -> Formatter {
        stub(&root.join("node_modules/.bin"), "upper", "tr '[:lower:]' '[:upper:]'");
        formatter("upper", "", "")
    }

    #[test]
    fn the_workspace_choice_outranks_the_projects_config() {
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        stub(&root.join("node_modules/.bin"), "prettier", "tr -d ' '");
        let mut formatters = bundled();
        formatters.push(upper(&root));
        let choices = Choices {
            workspace: by_extension(choose(&[(".TS", "upper")])),
            ..Choices::default()
        };
        let out = format(&formatters, &root.join("a.ts"), "const x\n", &root, &choices);
        assert_eq!(
            (out.formatter.as_deref(), out.text.as_str()),
            (Some("upper"), "CONST X\n")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_projects_config_outranks_the_users_choice() {
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        stub(&root.join("node_modules/.bin"), "prettier", "tr -d ' '");
        let mut formatters = bundled();
        formatters.push(upper(&root));
        let choices = Choices {
            user: choose(&[("ts", "upper")]),
            ..Choices::default()
        };
        let out = format(&formatters, &root.join("a.ts"), "const x\n", &root, &choices);
        assert_eq!(
            (out.formatter.as_deref(), out.text.as_str()),
            (Some("prettier"), "constx\n")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn only_the_users_choice_formats_a_project_with_no_config() {
        let root = tmp_tree();
        let mut formatters = bundled();
        formatters.push(upper(&root));
        let file = root.join("src/a.py");
        touch(&file, "");
        let none = format(&formatters, &file, "x\n", &root, &Choices::default());
        assert_eq!(none, FormatResult::none("x\n".into()));
        let choices = Choices {
            user: choose(&[("py", "upper")]),
            ..Choices::default()
        };
        let out = format(&formatters, &file, "x\n", &root, &choices);
        assert_eq!((out.formatter.as_deref(), out.text.as_str()), (Some("upper"), "X\n"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_decline_falls_through_every_rung_to_the_language_server() {
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        let bin = root.join("node_modules/.bin");
        stub(&bin, "prettier", DECLINE);
        stub(&bin, "first", "cat >/dev/null\nexit 3");
        stub(&bin, "last", "cat >/dev/null\nexit 3");
        let mut formatters = bundled();
        formatters.push(formatter("first", "", "[not_applicable]\nexit_code = 3"));
        formatters.push(formatter("last", "", "[not_applicable]\nexit_code = 3"));
        let choices = Choices {
            workspace: choose(&[("rs", "first")]),
            user: choose(&[("rs", "last")]),
            ..Choices::default()
        };
        let out = format(&formatters, &root.join("main.rs"), "fn main(){}\n", &root, &choices);
        assert_eq!(out, FormatResult::none("fn main(){}\n".into()));

        // And a rung that does take the file is where it stops.
        stub(&bin, "last", "tr -d '{}'");
        let out = format(&formatters, &root.join("main.rs"), "fn main(){}\n", &root, &choices);
        assert_eq!(
            (out.formatter.as_deref(), out.text.as_str()),
            (Some("last"), "fn main()\n")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_rs_file_in_a_prettier_repo_is_left_to_the_language_server() {
        // `formatter: None` is what sends Format Document on to rust-analyzer.
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        stub(&root.join("node_modules/.bin"), "prettier", DECLINE);
        let out = format(
            &bundled(),
            &root.join("src/main.rs"),
            "fn main(){}\n",
            &root,
            &Choices::default(),
        );
        assert_eq!(out, FormatResult::none("fn main(){}\n".into()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_svelte_file_still_goes_to_prettier_for_its_plugin() {
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), r#"{"plugins":["prettier-plugin-svelte"]}"#);
        stub(&root.join("node_modules/.bin"), "prettier", "tr -d ' '");
        let out = format(
            &bundled(),
            &root.join("src/App.svelte"),
            "<p> x </p>\n",
            &root,
            &Choices::default(),
        );
        assert_eq!(
            (out.formatter.as_deref(), out.text.as_str()),
            (Some("prettier"), "<p>x</p>\n")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_refusal_that_is_not_a_decline_stops_the_chain() {
        // A syntax error is the same error whoever formats next.
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        stub(
            &root.join("node_modules/.bin"),
            "prettier",
            "echo \"SyntaxError: '}' expected\" >&2\nexit 2",
        );
        let mut formatters = bundled();
        formatters.push(upper(&root));
        let choices = Choices {
            user: choose(&[("ts", "upper")]),
            ..Choices::default()
        };
        let out = format(&formatters, &root.join("a.ts"), "const x = {\n", &root, &choices);
        assert_eq!(out.formatter.as_deref(), Some("prettier"));
        assert_eq!(out.text, "const x = {\n");
        assert!(out.error.unwrap().contains("SyntaxError"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_formatter_named_by_two_rungs_is_asked_once() {
        let root = tmp_tree();
        touch(&root.join(".prettierrc"), "{}");
        let log = root.join("calls");
        stub(
            &root.join("node_modules/.bin"),
            "prettier",
            &format!("echo x >> '{}'\n{DECLINE}", log.display()),
        );
        let choices = Choices {
            workspace: choose(&[("rs", "prettier")]),
            user: choose(&[("rs", "prettier")]),
            ..Choices::default()
        };
        format(&bundled(), &root.join("a.rs"), "x\n", &root, &choices);
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unknown_id_in_a_setting_is_reported_not_skipped() {
        let root = tmp_tree();
        let choices = Choices {
            user: choose(&[("py", "ruf")]),
            ..Choices::default()
        };
        let out = format(&bundled(), &root.join("a.py"), "x\n", &root, &choices);
        assert_eq!(out.formatter.as_deref(), Some("ruf"));
        assert!(out.error.unwrap().contains("`ruf`"));
        std::fs::remove_dir_all(&root).ok();
    }

    /// Prettier's decline, pinned against the real binary: the first Prettier
    /// on the login PATH, or `TORI_PRETTIER` pointing at one. Skipped when
    /// neither exists.
    #[test]
    fn prettier_declines_a_file_it_has_no_parser_for_and_nothing_else() {
        let Some(bin) = std::env::var_os("TORI_PRETTIER")
            .map(PathBuf::from)
            .or_else(|| crate::env::resolve_binary("prettier"))
        else {
            return;
        };
        let prettier = bundled_one("prettier");
        let root = tmp_tree();
        let path = |name: &str| root.join(name).to_string_lossy().into_owned();

        let rust = run(&bin, &prettier.args_for(&path("main.rs")), &root, "fn main(){}\n").unwrap_err();
        assert!(rust.is_decline_by(&prettier), "{rust:?}");

        let broken = run(&bin, &prettier.args_for(&path("a.ts")), &root, "const x = {\n").unwrap_err();
        assert!(!broken.is_decline_by(&prettier), "{broken:?}");

        assert_eq!(
            run(&bin, &prettier.args_for(&path("a.ts")), &root, "const  x=1\n").unwrap(),
            "const x = 1;\n"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
