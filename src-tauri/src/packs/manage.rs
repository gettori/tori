// Installing, updating and restoring a pack from the signed catalog. Every
// file is checked against the hash in its signed row before it is written,
// and a file Tori did not write is never written over.

use std::io::Read;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::catalog;
use super::installed::{self, Record, Source as Recorded};
use super::Kind;

pub const FIX_RENAME: &str = "rename yours to install this one";

const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Install,
    Replace,
}

pub fn put(
    packs: &Path,
    kind: Kind,
    id: &str,
    mode: Mode,
    index: &Value,
    mut download: impl FnMut(&str) -> Result<Vec<u8>, String>,
    now: u64,
) -> Result<(), String> {
    super::check_id(id, "packs_install")?;
    let (row, sha) = index["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|row| match catalog::loadable(row) {
            Some((k, i, sha)) if k == kind && i == id => Some((row, sha)),
            _ => None,
        })
        .ok_or_else(|| format!("the catalog has no {} pack `{id}` this Tori can load", kind.folder()))?;
    let url = row["url"]
        .as_str()
        .ok_or_else(|| format!("the catalog row for `{id}` has no url"))?;
    let icon = match (row["icon_sha256"].as_str(), row["icon_url"].as_str()) {
        (Some(sha), Some(url)) if kind == Kind::Agents => Some((sha, url)),
        (Some(_), None) => return Err(format!("the catalog row for `{id}` has an icon hash but no icon url")),
        _ => None,
    };

    let record_path = packs.join(installed::FILE);
    let recorded = installed::read_at(&record_path)?.find(kind, id).map(|r| r.source);
    let target = packs.join(kind.folder()).join(format!("{id}.{}", kind.ext()));
    let occupied = target.symlink_metadata().is_ok();
    match (mode, recorded) {
        (_, Some(Recorded::Override)) => {
            return Err(format!(
                "{} is your own copy of `{id}`; delete it to use the catalog's",
                target.display()
            ))
        }
        (Mode::Install, None) if occupied => {
            return Err(format!("{} already uses the id `{id}`; {FIX_RENAME}", target.display()))
        }
        (Mode::Replace, None) => return Err(format!("`{id}` is not a pack Tori installed")),
        _ => {}
    }

    let text = fetch_checked(&mut download, url, sha)?;
    let icon_text = icon
        .map(|(sha, url)| fetch_checked(&mut download, url, sha))
        .transpose()?;
    std::fs::create_dir_all(packs.join(kind.folder())).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(&target, &text)?;
    if kind == Kind::Agents {
        put_icon(&super::icon_path(packs, id), icon_text.as_deref())?;
    }
    let record = Record {
        kind,
        id: id.to_string(),
        sha256: sha.to_string(),
        source: Recorded::Catalog,
        packs_commit: index["packs_commit"].as_str().map(str::to_string),
        installed_at: now,
        bundled_sha256: None,
    };
    let recorded_now = installed::update(&record_path, |r| r.record(record));
    if recorded_now.is_err() && !occupied {
        let _ = std::fs::remove_file(&target);
        if kind == Kind::Agents {
            let _ = std::fs::remove_file(super::icon_path(packs, id));
        }
    }
    recorded_now
}

fn fetch_checked(
    download: &mut impl FnMut(&str) -> Result<Vec<u8>, String>,
    url: &str,
    sha: &str,
) -> Result<String, String> {
    let text = String::from_utf8(download(url)?).map_err(|_| format!("{url} is not a text file"))?;
    let got = super::sha256(&text);
    if got != sha {
        return Err(format!(
            "{url} does not match the signed catalog (sha256 {got}, expected {sha})"
        ));
    }
    Ok(text)
}

fn put_icon(path: &Path, text: Option<&str>) -> Result<(), String> {
    match text {
        Some(text) => {
            std::fs::create_dir_all(path.parent().unwrap_or(path)).map_err(|e| e.to_string())?;
            crate::owned_state::write_atomically(path, text)
        }
        None => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        },
    }
}

pub fn check_idle(kind: Kind, id: &str, runs: impl Fn(&str) -> bool) -> Result<(), String> {
    if kind == Kind::Lsp && runs(id) {
        return Err(format!("`{id}` is running; close the files using it first"));
    }
    Ok(())
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .https_only(true)
        .redirects(5)
        .timeout(Duration::from_secs(60))
        .user_agent("tori-packs")
        .build();
    let response = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{url}: {e}"))?;
    Ok(bytes)
}

fn run(app: &tauri::AppHandle, lsp: &crate::lsp::LspState, kind: Kind, id: &str, mode: Mode) -> Result<(), String> {
    use tauri::Emitter;
    check_idle(kind, id, |id| lsp.runs(id))?;
    let served = catalog::fetch(false);
    let index = served.index.ok_or_else(|| match served.problem {
        Some(catalog::Problem::Offline(e) | catalog::Problem::Unverified(e) | catalog::Problem::Record(e)) => e,
        None => "the catalog is not available".to_string(),
    })?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    put(&super::dir(), kind, id, mode, &index, download, now)?;
    super::reload(kind);
    let _ = app.emit(super::CHANGED, kind);
    Ok(())
}

#[tauri::command(async)]
pub fn packs_install(
    app: tauri::AppHandle,
    lsp: tauri::State<'_, crate::lsp::LspState>,
    kind: Kind,
    id: String,
) -> Result<(), String> {
    run(&app, &lsp, kind, &id, Mode::Install)
}

#[tauri::command(async)]
pub fn packs_update(
    app: tauri::AppHandle,
    lsp: tauri::State<'_, crate::lsp::LspState>,
    kind: Kind,
    id: String,
) -> Result<(), String> {
    run(&app, &lsp, kind, &id, Mode::Replace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const URL: &str = "https://gettori.app/packs/files/lsp/rust.toml";

    fn text() -> &'static str {
        super::super::snapshot::text("lsp", "rust").unwrap()
    }

    fn index() -> Value {
        let snapshot: Value = serde_json::from_str(super::super::snapshot::INDEX).unwrap();
        let mut row = snapshot["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "lsp" && r["id"] == "rust")
            .unwrap()
            .clone();
        row["url"] = json!(URL);
        json!({ "packs_commit": "abc", "rows": [row] })
    }

    fn packs(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-manage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("lsp")).unwrap();
        dir
    }

    fn serve(body: &str) -> impl FnMut(&str) -> Result<Vec<u8>, String> + '_ {
        move |url| {
            assert_eq!(url, URL);
            Ok(body.as_bytes().to_vec())
        }
    }

    fn rust_source(packs: &Path) -> Option<super::super::provenance::Source> {
        let (list, _) = crate::lsp::registry::build_registry_from(&packs.join("lsp"));
        list.iter().find(|s| s.id == "rust").map(|s| s.provenance.source)
    }

    #[test]
    fn an_install_is_recorded_and_loads_as_a_catalog_pack() {
        let dir = packs("install");
        put(&dir, Kind::Lsp, "rust", Mode::Install, &index(), serve(text()), 1).unwrap();
        assert_eq!(rust_source(&dir), Some(super::super::provenance::Source::Catalog));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_body_that_does_not_match_the_signed_hash_is_refused_and_not_written() {
        let dir = packs("mismatch");
        let err = put(&dir, Kind::Lsp, "rust", Mode::Install, &index(), serve("tampered"), 1).unwrap_err();
        assert!(err.contains("does not match"), "{err}");
        assert!(!dir.join("lsp/rust.toml").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_install_never_writes_over_a_file_tori_did_not_record() {
        let dir = packs("occupied");
        std::fs::write(dir.join("lsp/rust.toml"), "mine").unwrap();
        let err = put(
            &dir,
            Kind::Lsp,
            "rust",
            Mode::Install,
            &index(),
            |_| panic!("no download"),
            1,
        )
        .unwrap_err();
        assert!(err.contains(FIX_RENAME), "{err}");
        assert_eq!(std::fs::read_to_string(dir.join("lsp/rust.toml")).unwrap(), "mine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_refuses_a_file_tori_did_not_record() {
        let dir = packs("remove");
        std::fs::write(dir.join("lsp/mine.toml"), "mine").unwrap();
        assert!(super::super::remove_at(&dir, Kind::Lsp, "mine").is_err());
        assert!(dir.join("lsp/mine.toml").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_running_language_server_is_not_changed() {
        assert!(check_idle(Kind::Lsp, "rust", |id| id == "rust").is_err());
        assert!(check_idle(Kind::Themes, "rust", |_| true).is_ok());
    }

    #[test]
    fn restore_puts_an_edited_pack_back_to_the_catalog_bytes() {
        let dir = packs("restore");
        put(&dir, Kind::Lsp, "rust", Mode::Install, &index(), serve(text()), 1).unwrap();
        std::fs::write(dir.join("lsp/rust.toml"), format!("{}\n# edited", text())).unwrap();
        assert_eq!(rust_source(&dir), Some(super::super::provenance::Source::Bundled));
        put(&dir, Kind::Lsp, "rust", Mode::Replace, &index(), serve(text()), 2).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("lsp/rust.toml")).unwrap(), text());
        assert_eq!(rust_source(&dir), Some(super::super::provenance::Source::Catalog));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_cached_index_still_installs() {
        let dir = packs("expired");
        let mut index = index();
        index["generated_at"] = json!("2020-01-01T00:00:00Z");
        index["expires"] = json!("2020-01-31T00:00:00Z");
        let cache = json!({ "etag": null, "fetched_at": 0, "index": index, "sig": {} });
        std::fs::write(dir.join("catalog.json"), cache.to_string()).unwrap();
        let served = catalog::refresh(&dir, 1_791_500_000, false, &[], |_| Err("offline".into()));
        assert!(served.stale);
        put(
            &dir,
            Kind::Lsp,
            "rust",
            Mode::Install,
            &served.index.unwrap(),
            serve(text()),
            1,
        )
        .unwrap();
        assert_eq!(rust_source(&dir), Some(super::super::provenance::Source::Catalog));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
