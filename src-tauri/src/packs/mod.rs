// One place for the catalog fields and the id rules, so the five pack kinds
// cannot drift apart on what a pack is.

pub mod catalog;
pub mod index_rows;
pub mod installed;
pub mod manage;
pub mod migrate;
pub mod provenance;
pub mod publish;
pub mod snapshot;
pub mod validate;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, RwLock};

/// The five kinds of pack, each a folder under `packs/` named as its loader
/// names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Lsp,
    Dap,
    Formatters,
    Themes,
    Agents,
}

impl Kind {
    pub const ALL: [Kind; 5] = [Kind::Lsp, Kind::Dap, Kind::Formatters, Kind::Themes, Kind::Agents];

    pub fn folder(self) -> &'static str {
        match self {
            Kind::Lsp => "lsp",
            Kind::Dap => "dap",
            Kind::Formatters => "formatters",
            Kind::Themes => "themes",
            Kind::Agents => "agents",
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Kind::Themes => "json",
            _ => "toml",
        }
    }

    /// Whether this build's loader reads a pack of `schema_version`.
    pub fn supports(self, schema_version: u64) -> bool {
        let supported: &[u32] = match self {
            Kind::Lsp => &crate::lsp::registry::SUPPORTED_SCHEMA_VERSIONS,
            Kind::Dap => &crate::dap::registry::SUPPORTED_SCHEMA_VERSIONS,
            Kind::Formatters => &crate::format::registry::SUPPORTED_SCHEMA_VERSIONS,
            Kind::Themes => &[crate::palette::PALETTE_SCHEMA_VERSION],
            Kind::Agents => &crate::agents::SUPPORTED_SCHEMA_VERSIONS,
        };
        supported.iter().any(|&v| u64::from(v) == schema_version)
    }
}

/// One kind's loaded packs, built on first use and replaced whole by a reload.
/// A caller holds the `Arc` it was handed, so a reload never changes a list
/// under someone mid-iteration.
pub struct Registry<T>(RwLock<Option<Arc<Vec<T>>>>);

impl<T> Default for Registry<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Registry<T> {
    pub const fn new() -> Self {
        Registry(RwLock::new(None))
    }

    pub fn get(&self, build: impl FnOnce() -> Vec<T>) -> Arc<Vec<T>> {
        if let Some(list) = self.0.read().unwrap_or_else(PoisonError::into_inner).as_ref() {
            return list.clone();
        }
        self.set(build())
    }

    pub fn set(&self, list: Vec<T>) -> Arc<Vec<T>> {
        let list = Arc::new(list);
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = Some(list.clone());
        list
    }
}

/// `~/.config/tori/packs`, the one folder every kind loads from.
pub fn dir() -> PathBuf {
    crate::owned_state::config_dir().join("packs")
}

pub fn kind_dir(kind: Kind) -> PathBuf {
    dir().join(kind.folder())
}

/// The hash of the pack this build ships under `id`, if it ships one.
pub fn bundled_sha(kind: Kind, id: &str) -> Option<String> {
    match kind {
        Kind::Dap => crate::dap::registry::bundled_text(id).map(sha256),
        _ => snapshot::sha256(kind.folder(), id).map(str::to_string),
    }
}

pub fn is_bundled(kind: Kind, id: &str) -> bool {
    bundled_sha(kind, id).is_some()
}

/// Where an agent's icon lives: `icons/<id>.svg` beside the kind folders. It
/// belongs to the agent pack of that id, so install, update and remove carry it.
pub fn icon_path(packs: &Path, id: &str) -> PathBuf {
    packs.join(index_rows::ICONS).join(format!("{id}.svg"))
}

pub fn sha256(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// What a file carrying a bundled id is told to do instead.
pub const FIX_NEW_ID: &str = "copy it under your own id and switch the bundled one off";

/// What a recorded file that was edited since is told to do.
pub const FIX_MODIFIED: &str = "restore it from the catalog or delete it";

/// A file Tori read and would not load, with what to do about it. `kind` is
/// `None` for `installed.json`, which belongs to no one kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadError {
    pub kind: Option<Kind>,
    pub file: String,
    pub message: String,
    pub fix: Option<String>,
    /// The id `packs_remove` takes, for a recorded file edited since.
    pub removable: Option<String>,
    /// Whether `packs_update` can put it back: it came from the catalog.
    pub restorable: bool,
}

impl LoadError {
    /// `message` may lead with `file`, as the loaders' errors do; it is said
    /// once, in `file`.
    pub fn new(kind: Option<Kind>, file: &str, message: &str, fix: Option<&str>) -> Self {
        let message = message.strip_prefix(&format!("{file}: ")).unwrap_or(message);
        LoadError {
            kind,
            file: file.to_string(),
            message: message.to_string(),
            fix: fix.map(str::to_string),
            removable: None,
            restorable: false,
        }
    }
}

static ERRORS: Mutex<BTreeMap<Kind, Vec<LoadError>>> = Mutex::new(BTreeMap::new());

/// Replace one kind's errors with what its latest load found.
pub fn report(kind: Kind, errors: Vec<LoadError>) {
    for e in &errors {
        eprintln!("tori: ERROR loading {} {}: {}", kind.folder(), e.file, e.message);
    }
    ERRORS.lock().unwrap_or_else(|e| e.into_inner()).insert(kind, errors);
}

/// The files in one kind's folder, in name order so which of two conflicting
/// files is refused never depends on how the filesystem lists them.
pub fn user_files(dir: &Path, kind: Kind) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| p.extension().and_then(|e| e.to_str()) == Some(kind.ext()));
    files.sort();
    files
}

/// One kind folder's user files, judged against what Tori recorded installing
/// and the last catalog index it fetched.
pub struct UserDir {
    kind: Kind,
    record_path: PathBuf,
    /// Empty when the record cannot be read, which refuses every file with a
    /// bundled id: the safe side. `packs_load_errors` says why.
    pub installed: installed::Installed,
    readable: bool,
    cached: provenance::Cached,
    adopted: Vec<installed::Record>,
    now: u64,
}

impl UserDir {
    pub fn open(kind: Kind, kind_dir: &Path) -> Self {
        let packs = kind_dir.parent().unwrap_or(kind_dir);
        let record_path = packs.join(installed::FILE);
        let read = installed::read_at(&record_path);
        UserDir {
            kind,
            readable: read.is_ok(),
            installed: read.unwrap_or_default(),
            cached: provenance::read_cache(packs),
            record_path,
            adopted: Vec::new(),
            now: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default(),
        }
    }

    /// One file through its kind's string loader and the rules every user file
    /// meets: named after its id, no bundled id unless recorded, and no
    /// recorded file edited since.
    pub fn load<T>(
        &mut self,
        path: &Path,
        load: impl Fn(&str, &str) -> Result<T, String>,
        id: impl Fn(&T) -> &str,
    ) -> Result<(T, provenance::Provenance), LoadError> {
        use provenance::{Class, Provenance, Source};
        let kind = self.kind;
        let source = path.to_string_lossy().into_owned();
        let fail = |message: String, fix: Option<&str>| LoadError::new(Some(kind), &source, &message, fix);
        let text = std::fs::read_to_string(path).map_err(|e| fail(e.to_string(), None))?;
        let pack = load(&text, &source).map_err(|e| fail(e, None))?;
        let pack_id = id(&pack).to_string();
        check_stem(&source, &pack_id).map_err(|e| fail(e, None))?;
        let sha = sha256(&text);
        let bundled = bundled_sha(kind, &pack_id);
        let c = provenance::classify(kind, &pack_id, &sha, &self.installed, bundled.as_deref(), &self.cached);
        let source_tag = match c.class {
            Class::Modified => {
                let restorable = self
                    .installed
                    .find(kind, &pack_id)
                    .is_some_and(|r| r.source == installed::Source::Catalog);
                return Err(LoadError {
                    removable: Some(pack_id),
                    restorable,
                    ..fail(
                        format!("{source}: this file was changed after Tori recorded it"),
                        Some(FIX_MODIFIED),
                    )
                });
            }
            Class::BundledId => {
                return Err(fail(
                    format!("{source}: `{pack_id}` is the id of a bundled pack"),
                    Some(FIX_NEW_ID),
                ))
            }
            Class::Adopted if !self.readable => Source::Custom,
            Class::Adopted => {
                let record = installed::Record {
                    kind,
                    id: pack_id,
                    sha256: sha,
                    source: installed::Source::Catalog,
                    packs_commit: self.cached.packs_commit.clone(),
                    installed_at: self.now,
                    bundled_sha256: None,
                };
                self.installed.record(record.clone());
                self.adopted.push(record);
                Source::Catalog
            }
            Class::Catalog => Source::Catalog,
            Class::Override => Source::Override,
            Class::Custom => Source::Custom,
        };
        let provenance = Provenance {
            source: source_tag,
            update_available: c.update_available,
            catalog_conflict: c.catalog_conflict,
        };
        Ok((pack, provenance))
    }

    /// Write the files adopted along the way into the record, or say why not.
    pub fn finish(self) -> Option<LoadError> {
        if self.adopted.is_empty() {
            return None;
        }
        let adopted = self.adopted;
        installed::update(&self.record_path, |record| {
            adopted.into_iter().for_each(|r| record.record(r))
        })
        .err()
        .map(|e| LoadError::new(None, &self.record_path.to_string_lossy(), &e, None))
    }
}

/// Every load error, each registry built first so its errors are in.
#[tauri::command(async)]
pub fn packs_load_errors() -> Vec<LoadError> {
    let _ = crate::lsp::registry::registry();
    let _ = crate::dap::registry::registry();
    let _ = crate::format::registry::registry();
    let _ = crate::agents::registry();
    let _ = crate::themes::list_user_themes();
    let path = dir().join(installed::FILE);
    let mut out: Vec<LoadError> = installed::read_at(&path)
        .err()
        .map(|e| LoadError::new(None, &path.to_string_lossy(), &e, None))
        .into_iter()
        .collect();
    out.extend(
        ERRORS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .flatten()
            .cloned(),
    );
    out
}

/// Rebuild one kind from its folder, and its load errors with it. Themes are
/// read fresh on every ask, so for them this only refreshes the errors.
pub fn reload(kind: Kind) {
    match kind {
        Kind::Lsp => crate::lsp::registry::reload(),
        Kind::Dap => crate::dap::registry::reload(),
        Kind::Formatters => crate::format::registry::reload(),
        Kind::Agents => crate::agents::reload(),
        Kind::Themes => {
            let _ = crate::themes::list_user_themes();
        }
    }
}

pub const CHANGED: &str = "packs:changed";

/// Reload one kind and tell the frontend, which asks again for what it shows.
/// A running language server or debugger keeps the config it started with.
#[tauri::command(async)]
pub fn packs_reload(app: tauri::AppHandle, kind: Kind) {
    use tauri::Emitter;
    reload(kind);
    let _ = app.emit(CHANGED, kind);
}

/// Delete a pack Tori recorded and the record with it, then reload its kind.
/// A file Tori never recorded is the user's own, and is theirs to delete.
#[tauri::command(async)]
pub fn packs_remove(
    app: tauri::AppHandle,
    lsp: tauri::State<'_, crate::lsp::LspState>,
    kind: Kind,
    id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    manage::check_idle(kind, &id, |id| lsp.runs(id))?;
    remove_at(&dir(), kind, &id)?;
    reload(kind);
    let _ = app.emit(CHANGED, kind);
    Ok(())
}

fn remove_at(packs: &Path, kind: Kind, id: &str) -> Result<(), String> {
    check_id(id, "packs_remove")?;
    let record_path = packs.join(installed::FILE);
    if installed::read_at(&record_path)?.find(kind, id).is_none() {
        return Err(format!(
            "`{id}` is not a pack Tori installed, so it is yours to delete by hand"
        ));
    }
    let mut files = vec![packs.join(kind.folder()).join(format!("{id}.{}", kind.ext()))];
    if kind == Kind::Agents {
        files.push(icon_path(packs, id));
    }
    for file in files {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", file.display())),
        }
    }
    installed::update(&record_path, |record| {
        record.packs.retain(|r| !(r.kind == kind && r.id == id))
    })
}

/// What this launch's migration moved, for the notice.
#[tauri::command(async)]
pub fn packs_migration_report() -> Option<migrate::Report> {
    migrate::last_report()
}

/// Who wrote a pack, credited on its card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contributor {
    pub name: String,
    pub github: String,
}

/// The catalog fields. Optional to load; the validator and the bundled-pack
/// tests are what require them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub contributor: Option<Contributor>,
    #[serde(default)]
    pub license: Option<String>,
}

/// An id is a file name and a folder name on every machine it reaches, so it
/// cannot carry a separator, a leading dot or anything a shell would expand.
pub fn check_id(id: &str, source: &str) -> Result<(), String> {
    static ID: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = ID.get_or_init(|| regex::Regex::new(r"^[a-z0-9][a-z0-9._-]*$").unwrap());
    if pattern.is_match(id) {
        Ok(())
    } else {
        Err(format!(
            "{source}: id `{id}` must be lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit"
        ))
    }
}

/// The file a pack lives in is named after its id. `source` is a path, or
/// `bundled:<name>` for a built-in.
pub fn check_stem(source: &str, id: &str) -> Result<(), String> {
    let stem = match source.strip_prefix("bundled:") {
        Some(name) => name,
        None => Path::new(source)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default(),
    };
    if stem == id {
        Ok(())
    } else {
        Err(format!(
            "{source}: the file is named `{stem}` but its id is `{id}`; rename the file or change the id so they match"
        ))
    }
}

/// One exact version, `1.2.3` or `1.2.3-rc.1`. A range or a tag like `latest`
/// would install whatever the registry says today, which nobody has checked.
pub fn is_exact_version(version: &str) -> bool {
    static EXACT: OnceLock<regex::Regex> = OnceLock::new();
    EXACT
        .get_or_init(|| regex::Regex::new(r"^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$").unwrap())
        .is_match(version)
}

/// A calendar date written `YYYY-MM-DD`.
pub fn check_date(value: &str, field: &str, source: &str) -> Result<(), String> {
    let invalid = || format!("{source}: {field} `{value}` is not a date written YYYY-MM-DD");
    let parts: Vec<&str> = value.split('-').collect();
    let [y, m, d] = parts.as_slice() else {
        return Err(invalid());
    };
    if y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return Err(invalid());
    }
    let (Ok(year), Ok(month), Ok(day)) = (y.parse::<u32>(), m.parse::<u32>(), d.parse::<u32>()) else {
        return Err(invalid());
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(invalid()),
    };
    if (1..=days).contains(&day) {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// The catalog fields and `verified_on` as TOML, for each loader's tests to
/// prepend.
#[cfg(test)]
pub(crate) const TEST_CATALOG_TOML: &str = r#"description = "One line for the card"
license = "MIT"
contributor = { name = "Ada", github = "ada" }
verified_on = "2026-10-09"
"#;

/// Record `text` in `installed.json` beside `kind_dir` as an override of the
/// bundled `id`, as the migration does.
#[cfg(test)]
pub(crate) fn record_override(kind_dir: &Path, kind: Kind, id: &str, text: &str) {
    let path = kind_dir.parent().unwrap().join(installed::FILE);
    let mut record = installed::read_at(&path).unwrap();
    record.record(installed::Record {
        kind,
        id: id.into(),
        sha256: sha256(text),
        source: installed::Source::Override,
        packs_commit: None,
        installed_at: 0,
        bundled_sha256: None,
    });
    installed::write_at(&path, &record).unwrap();
}

#[cfg(test)]
pub(crate) fn test_meta() -> Meta {
    Meta {
        description: Some("One line for the card".into()),
        contributor: Some(Contributor {
            name: "Ada".into(),
            github: "ada".into(),
        }),
        license: Some("MIT".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_that_are_safe_file_names_pass() {
        for id in ["typescript", "vite-plus", "js-debug", "rose-pine.dawn", "c_cpp", "0x"] {
            assert!(check_id(id, "t").is_ok(), "{id}");
        }
    }

    #[test]
    fn ids_that_could_escape_or_surprise_are_refused() {
        for id in ["../x", "a/b", ".hidden", "-flag", "Upper", "", "with space", "a\\b"] {
            assert!(check_id(id, "t").is_err(), "{id}");
        }
    }

    #[test]
    fn a_stem_that_differs_from_the_id_names_both() {
        let err = check_stem("/x/packs/lsp/foo.toml", "bar").unwrap_err();
        assert!(err.contains("`foo`") && err.contains("`bar`"), "{err}");
        assert!(check_stem("/x/packs/lsp/bar.toml", "bar").is_ok());
        assert!(check_stem("bundled:bar", "bar").is_ok());
        assert!(check_stem("bundled:foo", "bar").is_err());
    }

    #[test]
    fn only_real_calendar_dates_pass() {
        for ok in ["2026-10-09", "2024-02-29", "2000-02-29"] {
            assert!(check_date(ok, "verified_on", "t").is_ok(), "{ok}");
        }
        for bad in [
            "2026-10-9",
            "2026/10/09",
            "2026-13-01",
            "2026-02-29",
            "1900-02-29",
            "2026-04-31",
            "26-10-09",
            "x",
        ] {
            assert!(check_date(bad, "verified_on", "t").is_err(), "{bad}");
        }
    }
}
