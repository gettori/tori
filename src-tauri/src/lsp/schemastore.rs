// SchemaStore's catalog, turned into `json/schemaAssociations`.
//
// `vscode-json-languageserver` validates a JSON file against a schema, and has
// no idea which schema. VS Code tells it, out of a catalog it ships and
// refreshes; the server itself has no catalog logic at all. So a bundled JSON
// server with nothing feeding it is a server that never validates anything,
// which looks exactly like a server that is not running.
//
// This is the feeding. Three pieces, split so the interesting one needs no
// network to test:
//
//   1. `associations_from_catalog`, pure. Catalog JSON in, associations out.
//   2. `catalog_text`, the cache. Disk first, network only past the TTL, and a
//      stale copy in preference to nothing at all.
//   3. `associations`, the process-wide once. The catalog is the same for every
//      project, so fetching it per session (or per file) would be the same
//      answer bought repeatedly.
//
// Offline is a supported state, not a failure: no catalog means no
// associations, which means JSON files edit exactly as they did before any of
// this existed. It is logged once, because a line per file is how a log stops
// being read.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

/// SchemaStore's catalog. The same URL `yaml-language-server` defaults to, so
/// both servers agree about where schemas come from.
pub const CATALOG_URL: &str = "https://www.schemastore.org/api/json/catalog.json";

/// How long a cached catalog is used without asking again. A day: the catalog
/// gains a handful of entries a week, and nobody's afternoon depends on one
/// landing sooner.
pub const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// One entry of what `json/schemaAssociations` carries. The server accepts two
/// shapes; this is the array one, whose entries it pushes straight onto its
/// schema list (`vscode-json-languageserver/out/jsonServer.js:214-217`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaAssociation {
    pub uri: String,
    pub file_match: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    #[serde(default)]
    schemas: Vec<CatalogEntry>,
}

#[derive(Debug, Deserialize)]
struct CatalogEntry {
    #[serde(default)]
    url: Option<String>,
    #[serde(default, rename = "fileMatch")]
    file_match: Vec<String>,
}

/// Every association a catalog yields, in catalog order.
///
/// Returns an empty list rather than an error for anything malformed: this
/// feeds a convenience, and there is no caller for whom "the catalog was
/// broken" and "the catalog was missing" mean different things.
///
/// Entries without a `url` or without a `fileMatch` are skipped, since neither
/// half is useful alone. So are non-http URLs: the server fetches these itself
/// over the network, and a `file:` URL out of a document nobody here wrote
/// would be asking it to read a local path of someone else's choosing.
pub fn associations_from_catalog(text: &str) -> Vec<SchemaAssociation> {
    let catalog: Catalog = match serde_json::from_str(text) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    catalog
        .schemas
        .into_iter()
        .filter_map(|entry| {
            let uri = entry.url?;
            if !uri.starts_with("https://") && !uri.starts_with("http://") {
                return None;
            }
            if entry.file_match.is_empty() {
                return None;
            }
            Some(SchemaAssociation { uri, file_match: entry.file_match })
        })
        .collect()
}

fn cache_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/cache/schemastore-catalog.json")
}

fn fetch_catalog() -> Result<String, String> {
    ureq::get(CATALOG_URL)
        .set("User-Agent", "sway-lsp-schemastore")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

fn age_of(path: &Path, now: SystemTime) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    now.duration_since(modified).ok()
}

/// The catalog text: the cached copy while it is inside `ttl`, else a fresh
/// fetch, else whatever is on disk however old.
///
/// The fetch is a parameter so the whole policy is testable without a network,
/// including the case that matters most: a cache hit must not call it at all.
///
/// The last fallback is deliberate. A catalog from last month is very nearly
/// the catalog from today, and it is certainly better than a JSON file that
/// stops validating because someone opened their laptop on a train.
pub fn catalog_text(
    cache: &Path,
    ttl: Duration,
    now: SystemTime,
    fetch: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    let fresh = age_of(cache, now).is_some_and(|age| age < ttl);
    if fresh {
        if let Ok(text) = std::fs::read_to_string(cache) {
            return Ok(text);
        }
    }

    match fetch() {
        Ok(text) => {
            if let Some(parent) = cache.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(cache, &text);
            Ok(text)
        }
        Err(e) => std::fs::read_to_string(cache)
            .map_err(|_| format!("could not fetch the SchemaStore catalog and no cached copy exists: {e}")),
    }
}

static ASSOCIATIONS: OnceLock<Vec<SchemaAssociation>> = OnceLock::new();

/// The associations to hand a JSON server, computed at most once per process.
///
/// Once, not per session: the catalog does not vary by project, so a monorepo
/// with several roots would otherwise pay for the same answer repeatedly. This
/// is also what makes the failure log a single line rather than one per server
/// that starts.
pub fn associations() -> &'static [SchemaAssociation] {
    ASSOCIATIONS.get_or_init(|| match catalog_text(&cache_path(), CACHE_TTL, SystemTime::now(), fetch_catalog) {
        Ok(text) => associations_from_catalog(&text),
        Err(e) => {
            eprintln!("sway: no JSON schema associations ({e}); JSON files will edit without validation");
            Vec::new()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const CATALOG: &str = r#"{
      "version": 1.0,
      "schemas": [
        {
          "name": "package.json",
          "description": "npm package manifest",
          "fileMatch": ["package.json"],
          "url": "https://json.schemastore.org/package.json"
        },
        {
          "name": "GitHub Workflow",
          "fileMatch": [".github/workflows/*.yml", ".github/workflows/*.yaml"],
          "url": "https://json.schemastore.org/github-workflow.json"
        }
      ]
    }"#;

    fn temp_dir(name: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("sway_schemastore_{}_{name}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- the pure half ---

    #[test]
    fn a_catalog_becomes_one_association_per_entry() {
        let out = associations_from_catalog(CATALOG);
        assert_eq!(
            out,
            vec![
                SchemaAssociation {
                    uri: "https://json.schemastore.org/package.json".into(),
                    file_match: vec!["package.json".into()],
                },
                SchemaAssociation {
                    uri: "https://json.schemastore.org/github-workflow.json".into(),
                    file_match: vec![
                        ".github/workflows/*.yml".into(),
                        ".github/workflows/*.yaml".into()
                    ],
                },
            ]
        );
    }

    #[test]
    fn the_wire_form_is_the_one_the_server_reads() {
        // `fileMatch`, not `file_match`. The server pushes these entries
        // straight onto its schema list, so a snake_case key would arrive as an
        // association matching nothing, silently.
        let json = serde_json::to_string(&associations_from_catalog(CATALOG)).unwrap();
        assert!(json.contains(r#""fileMatch":["package.json"]"#), "{json}");
        assert!(!json.contains("file_match"), "{json}");
    }

    #[test]
    fn a_malformed_catalog_yields_none_rather_than_panicking() {
        for text in ["", "not json at all", "{}", r#"{"schemas": "wrong type"}"#, "[]"] {
            assert!(associations_from_catalog(text).is_empty(), "{text:?} should yield nothing");
        }
    }

    #[test]
    fn an_entry_missing_either_half_is_skipped() {
        // Neither half is useful alone: a URL with nothing to match never
        // applies, and patterns with no schema have nothing to validate against.
        let text = r#"{"schemas":[
          {"name":"no url","fileMatch":["a.json"]},
          {"name":"no match","url":"https://example.com/s.json"},
          {"name":"empty match","url":"https://example.com/s.json","fileMatch":[]},
          {"name":"good","url":"https://example.com/ok.json","fileMatch":["ok.json"]}
        ]}"#;
        let out = associations_from_catalog(text);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].uri, "https://example.com/ok.json");
    }

    #[test]
    fn a_non_http_url_is_refused() {
        // The server fetches these itself. A `file:` URL out of a document
        // nobody here wrote is a request to read a local path of someone
        // else's choosing.
        let text = r#"{"schemas":[
          {"url":"file:///etc/passwd","fileMatch":["*.json"]},
          {"url":"https://example.com/ok.json","fileMatch":["ok.json"]}
        ]}"#;
        let out = associations_from_catalog(text);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].uri, "https://example.com/ok.json");
    }

    // --- the cache ---

    #[test]
    fn a_fresh_cache_is_used_and_nothing_is_fetched() {
        let dir = temp_dir("hit");
        let cache = dir.join("catalog.json");
        std::fs::write(&cache, CATALOG).unwrap();

        let text = catalog_text(&cache, CACHE_TTL, SystemTime::now(), || {
            panic!("a cache hit must not reach the network")
        })
        .unwrap();

        assert_eq!(associations_from_catalog(&text).len(), 2);
    }

    #[test]
    fn an_empty_cache_dir_fetches_and_writes_one() {
        let dir = temp_dir("miss");
        let cache = dir.join("nested/catalog.json");

        let text = catalog_text(&cache, CACHE_TTL, SystemTime::now(), || Ok(CATALOG.to_string())).unwrap();

        assert_eq!(text, CATALOG);
        // Written, including the directory, so the next run is a hit.
        assert_eq!(std::fs::read_to_string(&cache).unwrap(), CATALOG);
    }

    #[test]
    fn a_cache_past_its_ttl_is_refetched() {
        let dir = temp_dir("stale");
        let cache = dir.join("catalog.json");
        std::fs::write(&cache, "{\"schemas\":[]}").unwrap();

        // Ask as if a week had passed, rather than waiting a week.
        let later = SystemTime::now() + Duration::from_secs(7 * 24 * 60 * 60);
        let text = catalog_text(&cache, CACHE_TTL, later, || Ok(CATALOG.to_string())).unwrap();

        assert_eq!(associations_from_catalog(&text).len(), 2);
        assert_eq!(std::fs::read_to_string(&cache).unwrap(), CATALOG);
    }

    #[test]
    fn a_stale_cache_beats_a_failed_fetch() {
        // The train case. A catalog from last month is very nearly this
        // month's, and certainly better than JSON files that stop validating.
        let dir = temp_dir("offline_stale");
        let cache = dir.join("catalog.json");
        std::fs::write(&cache, CATALOG).unwrap();

        let later = SystemTime::now() + Duration::from_secs(7 * 24 * 60 * 60);
        let text = catalog_text(&cache, CACHE_TTL, later, || Err("offline".into())).unwrap();

        assert_eq!(associations_from_catalog(&text).len(), 2);
    }

    #[test]
    fn offline_with_no_cache_yields_no_associations_rather_than_an_editor_that_fails() {
        let dir = temp_dir("offline_cold");
        let cache = dir.join("catalog.json");

        let err = catalog_text(&cache, CACHE_TTL, SystemTime::now(), || Err("offline".into()))
            .unwrap_err();

        assert!(err.contains("offline"), "the reason survives into the log line: {err}");
        // And the association step yields an empty set rather than throwing,
        // which is what leaves `.json` files editable with no validation.
        assert!(associations_from_catalog("").is_empty());
    }
}
