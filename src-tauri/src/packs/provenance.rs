// Where a user file came from, judged from three records: `installed.json`,
// the packs this build embeds, and the last catalog index Tori fetched.

use serde::Serialize;
use std::path::Path;

use super::installed::{Installed, Source as Recorded};
use super::Kind;

/// The tag every loaded pack carries.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Bundled,
    Catalog,
    Override,
    Custom,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub source: Source,
    pub update_available: bool,
    pub catalog_conflict: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedRow {
    pub kind: Kind,
    pub id: String,
    pub sha256: String,
}

/// The rows of the cached catalog index, or none without a cache.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cached {
    pub packs_commit: Option<String>,
    pub rows: Vec<CachedRow>,
}

impl Cached {
    fn row(&self, kind: Kind, id: &str) -> Option<&CachedRow> {
        self.rows.iter().find(|r| r.kind == kind && r.id == id)
    }
}

pub const CACHE_FILE: &str = "catalog.json";

/// The index cached in `packs/catalog.json`. The cache is only ever written
/// after its signature checked out, so it is read here without checking again.
/// A row of a kind or schema_version this build does not load is skipped: it
/// can be neither installed nor offered as an update.
pub fn read_cache(packs_dir: &Path) -> Cached {
    let Some(value) = std::fs::read_to_string(packs_dir.join(CACHE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    else {
        return Cached::default();
    };
    let index = &value["index"];
    let rows = index["rows"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let (kind, id, sha256) = super::catalog::loadable(row)?;
                    Some(CachedRow {
                        kind,
                        id: id.to_string(),
                        sha256: sha256.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Cached {
        packs_commit: index["packs_commit"].as_str().map(str::to_string),
        rows,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Catalog,
    Override,
    Modified,
    BundledId,
    Adopted,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Classified {
    pub class: Class,
    pub update_available: bool,
    pub catalog_conflict: bool,
}

/// The first rule that matches wins, in the order written here.
pub fn classify(
    kind: Kind,
    id: &str,
    sha256: &str,
    installed: &Installed,
    bundled_sha: Option<&str>,
    cached: &Cached,
) -> Classified {
    let plain = |class| Classified {
        class,
        update_available: false,
        catalog_conflict: false,
    };
    let row = cached.row(kind, id);
    if let Some(record) = installed.find(kind, id) {
        if record.sha256 != sha256 {
            return plain(Class::Modified);
        }
        return match record.source {
            Recorded::Override => plain(Class::Override),
            Recorded::Catalog => {
                // The catalog's word when there is one, else what this build
                // ships under the id.
                let newest = row.map(|r| r.sha256.as_str()).or(bundled_sha);
                Classified {
                    update_available: newest.is_some_and(|h| h != record.sha256),
                    ..plain(Class::Catalog)
                }
            }
        };
    }
    if bundled_sha.is_some() {
        return plain(Class::BundledId);
    }
    match row {
        Some(r) if r.sha256 == sha256 => plain(Class::Adopted),
        Some(_) => Classified {
            catalog_conflict: true,
            ..plain(Class::Custom)
        },
        None => plain(Class::Custom),
    }
}

#[cfg(test)]
mod tests {
    use super::super::installed::Record;
    use super::*;

    const MINE: &str = "aa";
    const OTHER: &str = "bb";

    fn recorded(source: Recorded, sha: &str) -> Installed {
        let mut installed = Installed::default();
        installed.record(Record {
            kind: Kind::Lsp,
            id: "x".into(),
            sha256: sha.into(),
            source,
            packs_commit: None,
            installed_at: 0,
            bundled_sha256: None,
        });
        installed
    }

    fn cached(sha: &str) -> Cached {
        Cached {
            packs_commit: Some("abc".into()),
            rows: vec![CachedRow {
                kind: Kind::Lsp,
                id: "x".into(),
                sha256: sha.into(),
            }],
        }
    }

    fn class(installed: &Installed, bundled: Option<&str>, cache: &Cached) -> Classified {
        classify(Kind::Lsp, "x", MINE, installed, bundled, cache)
    }

    #[test]
    fn one_outcome_per_rule() {
        let none = Installed::default();
        let no_cache = Cached::default();
        assert_eq!(
            class(&recorded(Recorded::Catalog, MINE), None, &no_cache).class,
            Class::Catalog
        );
        assert_eq!(
            class(&recorded(Recorded::Override, MINE), None, &no_cache).class,
            Class::Override
        );
        assert_eq!(
            class(&recorded(Recorded::Catalog, OTHER), None, &no_cache).class,
            Class::Modified
        );
        assert_eq!(class(&none, Some(OTHER), &no_cache).class, Class::BundledId);
        assert_eq!(class(&none, None, &cached(MINE)).class, Class::Adopted);
        assert_eq!(class(&none, None, &no_cache).class, Class::Custom);
    }

    #[test]
    fn a_catalog_pack_whose_id_became_bundled_stays_catalog_with_an_update() {
        let c = class(&recorded(Recorded::Catalog, MINE), Some(OTHER), &Cached::default());
        assert_eq!((c.class, c.update_available), (Class::Catalog, true));
    }

    #[test]
    fn a_custom_file_whose_id_became_bundled_is_a_bundled_id() {
        let c = class(&Installed::default(), Some(OTHER), &cached(OTHER));
        assert_eq!(c.class, Class::BundledId);
    }

    #[test]
    fn an_override_that_drifted_is_modified_and_never_offered_an_update() {
        assert_eq!(
            class(&recorded(Recorded::Override, OTHER), None, &Cached::default()).class,
            Class::Modified
        );
        let intact = class(&recorded(Recorded::Override, MINE), Some(OTHER), &cached(OTHER));
        assert_eq!((intact.class, intact.update_available), (Class::Override, false));
    }

    #[test]
    fn a_cache_without_the_id_flags_nothing() {
        let elsewhere = Cached {
            rows: vec![CachedRow {
                kind: Kind::Lsp,
                id: "y".into(),
                sha256: OTHER.into(),
            }],
            ..cached(OTHER)
        };
        let c = class(&Installed::default(), None, &elsewhere);
        assert_eq!((c.class, c.catalog_conflict), (Class::Custom, false));
    }

    #[test]
    fn a_custom_file_under_a_catalog_id_loads_flagged_and_without_updates() {
        let c = class(&Installed::default(), None, &cached(OTHER));
        assert_eq!(
            (c.class, c.catalog_conflict, c.update_available),
            (Class::Custom, true, false)
        );
    }

    #[test]
    fn the_cache_is_read_from_its_index_and_tolerates_absence() {
        let dir = std::env::temp_dir().join(format!("tori-provenance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_cache(&dir), Cached::default());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(CACHE_FILE),
            r#"{"etag":"e","index":{"packs_commit":"abc","rows":[
                {"kind":"lsp","id":"x","schema_version":1,"sha256":"aa","url":"u"},
                {"kind":"someday","id":"y","schema_version":1,"sha256":"bb"}]}}"#,
        )
        .unwrap();
        assert_eq!(read_cache(&dir), cached(MINE));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
