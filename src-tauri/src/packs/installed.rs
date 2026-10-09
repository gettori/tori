// `packs/installed.json`: the packs Tori itself wrote into the packs folder,
// so a file there can be told apart from one dropped in by hand.

use serde::{Deserialize, Serialize};
use std::path::Path;

use super::Kind;

pub const FILE: &str = "installed.json";

const VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Catalog,
    Override,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub kind: Kind,
    pub id: String,
    pub sha256: String,
    pub source: Source,
    #[serde(default)]
    pub packs_commit: Option<String>,
    pub installed_at: u64,
    // An override's card says when the bundled pack has moved on since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Installed {
    pub version: u32,
    pub packs: Vec<Record>,
}

impl Default for Installed {
    fn default() -> Self {
        Installed {
            version: VERSION,
            packs: Vec::new(),
        }
    }
}

impl Installed {
    pub fn find(&self, kind: Kind, id: &str) -> Option<&Record> {
        self.packs.iter().find(|r| r.kind == kind && r.id == id)
    }

    /// Add `record`, replacing any record for the same pack.
    pub fn record(&mut self, record: Record) {
        self.packs.retain(|r| !(r.kind == record.kind && r.id == record.id));
        self.packs.push(record);
    }
}

/// Read the record from its text. A version this build does not know is
/// refused rather than guessed at: reading it as empty would refuse every pack
/// it vouches for, and writing it back would lose them.
pub fn parse(text: &str, source: &str) -> Result<Installed, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("{source}: {e}"))?;
    match value.get("version").and_then(|v| v.as_u64()) {
        Some(v) if v == u64::from(VERSION) => serde_json::from_value(value).map_err(|e| format!("{source}: {e}")),
        Some(v) => Err(format!(
            "{source}: version {v} is not one this Tori reads (it reads {VERSION}); update Tori"
        )),
        None => Err(format!("{source}: no `version`")),
    }
}

pub fn render(installed: &Installed) -> String {
    serde_json::to_string_pretty(installed).unwrap_or_default()
}

/// The record at `path`, or an empty one when there is no file yet.
pub fn read_at(path: &Path) -> Result<Installed, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text, &path.to_string_lossy()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Installed::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

static STORE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Read, change and write the record as one step, so two writers never each
/// save a copy missing the other's change. A record that cannot be read is
/// never written over.
pub fn update(path: &Path, change: impl FnOnce(&mut Installed)) -> Result<(), String> {
    let _held = STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut installed = read_at(path)?;
    change(&mut installed);
    write_at(path, &installed)
}

pub fn write_at(path: &Path, installed: &Installed) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::owned_state::write_atomically(path, &render(installed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: Kind, id: &str, source: Source) -> Record {
        Record {
            kind,
            id: id.into(),
            sha256: "ab".repeat(32),
            source,
            packs_commit: Some("0123abc".into()),
            installed_at: 1_791_500_000,
            bundled_sha256: None,
        }
    }

    #[test]
    fn a_record_round_trips() {
        let mut installed = Installed::default();
        installed.record(record(Kind::Lsp, "astro", Source::Catalog));
        installed.record(Record {
            packs_commit: None,
            bundled_sha256: Some("cd".repeat(32)),
            ..record(Kind::Agents, "claude", Source::Override)
        });
        let back = parse(&render(&installed), "t").unwrap();
        assert_eq!(back, installed);
        assert_eq!(back.find(Kind::Agents, "claude").unwrap().source, Source::Override);
        assert!(back.find(Kind::Lsp, "claude").is_none());
    }

    #[test]
    fn an_unknown_version_is_refused_naming_the_file() {
        let err = parse(r#"{"version":2,"packs":[]}"#, "/x/packs/installed.json").unwrap_err();
        assert!(
            err.contains("/x/packs/installed.json") && err.contains("version 2"),
            "{err}"
        );
        assert!(parse(r#"{"packs":[]}"#, "/x/installed.json").is_err());
    }

    #[test]
    fn no_file_is_an_empty_record() {
        let dir = std::env::temp_dir().join(format!("tori-installed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_at(&dir.join(FILE)).unwrap(), Installed::default());
        let mut installed = Installed::default();
        installed.record(record(Kind::Themes, "moss", Source::Catalog));
        write_at(&dir.join(FILE), &installed).unwrap();
        assert_eq!(read_at(&dir.join(FILE)).unwrap(), installed);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
