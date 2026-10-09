// The catalog gettori.app serves: `index.json` and the signature over it,
// checked against keys this build carries and cached in `packs/catalog.json`.
// The site only passes the bytes along, so owning it is not enough to change
// what Tori installs.

use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::installed::{self, Installed, Source as Recorded};
use super::provenance::CACHE_FILE;
use super::publish::rfc3339;
use super::Kind;

const INDEX_URL: &str = "https://gettori.app/packs/index.json";
const SIG_URL: &str = "https://gettori.app/packs/index.json.sig";

// Opening the catalog always asks, so this only paces the checks nobody is
// waiting on.
const TTL: Duration = Duration::from_secs(6 * 60 * 60);

const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The keys an index may be signed with, by `key_id`. A new key ships here a
/// release before the packs repo signs with it, so no Tori sees it unknown.
pub const TRUSTED_KEYS: &[(&str, [u8; 32])] = &[(
    "k1",
    [
        0x7e, 0xb3, 0x52, 0xaf, 0x97, 0x6f, 0x9d, 0x75, 0xa4, 0x86, 0x44, 0x15, 0x3b, 0x01, 0x29, 0x12, 0x0a, 0x98,
        0x1d, 0xf8, 0x8f, 0x47, 0x13, 0x9f, 0x1f, 0x0a, 0xef, 0x87, 0x48, 0xb4, 0x9f, 0xd5,
    ],
)];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct CacheFile {
    etag: Option<String>,
    fetched_at: u64,
    index: Value,
    sig: Value,
}

pub enum Response {
    NotModified,
    Body {
        etag: Option<String>,
        index: Vec<u8>,
        sig: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "lowercase")]
pub enum Problem {
    Offline(String),
    Unverified(String),
    Record(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Served {
    pub index: Option<Value>,
    pub stale: bool,
    pub problem: Option<Problem>,
    pub changed: bool,
}

fn verify(index: &[u8], sig: &[u8], keys: &[(&str, [u8; 32])]) -> Result<(Value, Value), String> {
    let sig: Value = serde_json::from_slice(sig).map_err(|e| format!("index.json.sig: {e}"))?;
    let key_id = sig["key_id"].as_str().ok_or("index.json.sig has no key_id")?;
    let (_, key) = keys
        .iter()
        .find(|(id, _)| *id == key_id)
        .ok_or_else(|| format!("index.json is signed with key `{key_id}`, which this Tori does not trust"))?;
    let key = VerifyingKey::from_bytes(key).map_err(|e| format!("trusted key `{key_id}`: {e}"))?;
    let signature = sig["signature"]
        .as_str()
        .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or("index.json.sig carries no Ed25519 signature")?;
    key.verify_strict(index, &signature)
        .map_err(|_| "index.json does not match its signature".to_string())?;
    let index = serde_json::from_slice(index).map_err(|e| format!("index.json: {e}"))?;
    Ok((index, sig))
}

fn accept(
    cached: Option<&CacheFile>,
    etag: Option<String>,
    index: &[u8],
    sig: &[u8],
    now: u64,
    keys: &[(&str, [u8; 32])],
) -> Result<CacheFile, String> {
    let (index, sig) = verify(index, sig, keys)?;
    let generated = index["generated_at"].as_str().ok_or("index.json has no generated_at")?;
    if let Some(had) = cached.and_then(|c| c.index["generated_at"].as_str()) {
        // A correctly signed old index is how a since-fixed pack comes back.
        if generated < had {
            return Err(format!(
                "the index served was generated at {generated}, before the {had} one Tori already has"
            ));
        }
    }
    Ok(CacheFile {
        etag,
        fetched_at: now,
        index,
        sig,
    })
}

fn serve(cache: Option<CacheFile>, now: u64, problem: Option<Problem>) -> Served {
    let index = cache.map(|c| c.index);
    let stale = index
        .as_ref()
        .is_some_and(|i| i["expires"].as_str().is_none_or(|e| e < rfc3339(now).as_str()));
    Served {
        index,
        stale,
        problem,
        changed: false,
    }
}

/// The cached index while it is inside the TTL and `force` is off, else what
/// `request` brings back once it verifies, else the cached copy with the
/// reason. The cache is only ever replaced by an index that verified.
pub fn refresh(
    packs_dir: &Path,
    now: u64,
    force: bool,
    keys: &[(&str, [u8; 32])],
    request: impl FnOnce(Option<&str>) -> Result<Response, String>,
) -> Served {
    let path = packs_dir.join(CACHE_FILE);
    let cached: Option<CacheFile> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    let fresh = cached
        .as_ref()
        .is_some_and(|c| c.fetched_at <= now && now - c.fetched_at < TTL.as_secs());
    if fresh && !force {
        return serve(cached, now, None);
    }
    let next = match request(cached.as_ref().and_then(|c| c.etag.as_deref())) {
        Err(e) => Err(Problem::Offline(e)),
        Ok(Response::NotModified) => match &cached {
            Some(c) => Ok(CacheFile {
                fetched_at: now,
                ..c.clone()
            }),
            None => Err(Problem::Offline("gettori.app answered 304 with nothing cached".into())),
        },
        Ok(Response::Body { etag, index, sig }) => {
            accept(cached.as_ref(), etag, &index, &sig, now, keys).map_err(Problem::Unverified)
        }
    };
    match next {
        Ok(next) => {
            let written = std::fs::create_dir_all(packs_dir)
                .map_err(|e| e.to_string())
                .and_then(|()| {
                    let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
                    crate::owned_state::write_atomically(&path, &text)
                });
            if let Err(e) = written {
                eprintln!("[packs] could not cache the catalog at {}: {e}", path.display());
            }
            let changed = cached.is_none_or(|c| c.index["generated_at"] != next.index["generated_at"]);
            Served {
                changed,
                ..serve(Some(next), now, None)
            }
        }
        Err(problem) => serve(cached, now, Some(problem)),
    }
}

fn read_body(response: ureq::Response) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn request(etag: Option<&str>) -> Result<Response, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .user_agent("tori-packs")
        .build();
    let mut get = agent.get(INDEX_URL);
    if let Some(etag) = etag {
        get = get.set("If-None-Match", etag);
    }
    let response = get.call().map_err(|e| e.to_string())?;
    if response.status() == 304 {
        return Ok(Response::NotModified);
    }
    let etag = response.header("ETag").map(str::to_string);
    let index = read_body(response)?;
    let sig = read_body(agent.get(SIG_URL).call().map_err(|e| e.to_string())?)?;
    Ok(Response::Body { etag, index, sig })
}

static FETCHING: Mutex<()> = Mutex::new(());

pub fn fetch(force: bool) -> Served {
    let _held = FETCHING.lock().unwrap_or_else(PoisonError::into_inner);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    refresh(&super::dir(), now, force, TRUSTED_KEYS, request)
}

/// The kind, id and hash of an index row this build can load, or nothing for
/// a row of an unknown kind or a schema_version newer than its loader reads.
pub(super) fn loadable(row: &Value) -> Option<(Kind, &str, &str)> {
    let kind: Kind = serde_json::from_value(row["kind"].clone()).ok()?;
    if !kind.supports(row["schema_version"].as_u64()?) {
        return None;
    }
    Some((kind, row["id"].as_str()?, row["sha256"].as_str()?))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRow {
    pub pack: Value,
    pub installed: bool,
    pub bundled: bool,
    pub update_available: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub rows: Vec<CatalogRow>,
    pub generated_at: Option<String>,
    pub stale: bool,
    pub problem: Option<Problem>,
}

/// The rows of `index` this build can load. An update is the catalog's hash
/// differing from the recorded one, or from the embedded one when nothing is
/// recorded. An override is never offered one.
pub fn rows(
    index: &Value,
    installed: &Installed,
    bundled_sha: impl Fn(Kind, &str) -> Option<String>,
) -> Vec<CatalogRow> {
    let Some(all) = index["rows"].as_array() else {
        return Vec::new();
    };
    all.iter()
        .filter_map(|row| {
            let (kind, id, sha) = loadable(row)?;
            let record = installed.find(kind, id);
            let bundled = bundled_sha(kind, id);
            let update_available = match record {
                Some(r) => r.source == Recorded::Catalog && r.sha256 != sha,
                None => bundled.as_deref().is_some_and(|b| b != sha),
            };
            Some(CatalogRow {
                pack: row.clone(),
                installed: record.is_some(),
                bundled: bundled.is_some(),
                update_available,
            })
        })
        .collect()
}

/// The catalog for the add dialogs. `force_revalidate` skips the TTL and
/// still sends the ETag, so an unchanged index costs a 304. A new index
/// changes what every loaded pack is offered, so each kind reloads.
#[tauri::command(async)]
pub fn packs_catalog(app: tauri::AppHandle, force_revalidate: bool) -> Catalog {
    use tauri::Emitter;
    let served = fetch(force_revalidate);
    if served.changed {
        for kind in Kind::ALL {
            super::reload(kind);
            let _ = app.emit(super::CHANGED, kind);
        }
    }
    let index = served.index.unwrap_or(Value::Null);
    let (rows, problem) = match installed::read_at(&super::dir().join(installed::FILE)) {
        Ok(installed) => (rows(&index, &installed, super::bundled_sha), served.problem),
        Err(e) => (Vec::new(), Some(Problem::Record(e))),
    };
    Catalog {
        rows,
        generated_at: index["generated_at"].as_str().map(str::to_string),
        stale: served.stale,
        problem,
    }
}

#[cfg(test)]
mod tests {
    use super::super::installed::Record;
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    const DAY: u64 = 86_400;
    const NOW: u64 = 1_791_500_000;

    fn signer() -> SigningKey {
        SigningKey::from_bytes(&[7; 32])
    }

    fn keys() -> Vec<(&'static str, [u8; 32])> {
        vec![("t1", signer().verifying_key().to_bytes())]
    }

    fn index_at(generated: u64) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "generated_at": rfc3339(generated),
            "expires": rfc3339(generated + 30 * DAY),
            "packs_commit": "abc",
            "rows": [],
        }))
        .unwrap()
    }

    fn sig_for(index: &[u8], key_id: &str) -> Vec<u8> {
        let signature = base64::engine::general_purpose::STANDARD.encode(signer().sign(index).to_bytes());
        serde_json::to_vec(&json!({ "key_id": key_id, "signature": signature })).unwrap()
    }

    fn body(index: Vec<u8>, sig: Vec<u8>) -> Result<Response, String> {
        Ok(Response::Body {
            etag: Some("\"e1\"".into()),
            index,
            sig,
        })
    }

    fn dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-catalog-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn signed(dir: &Path, generated: u64, now: u64) -> Served {
        let index = index_at(generated);
        let sig = sig_for(&index, "t1");
        refresh(dir, now, true, &keys(), |_| body(index, sig))
    }

    fn generated_at(served: &Served) -> &str {
        served.index.as_ref().unwrap()["generated_at"].as_str().unwrap()
    }

    #[test]
    fn every_trusted_key_is_an_ed25519_public_key() {
        for (id, bytes) in TRUSTED_KEYS {
            assert!(VerifyingKey::from_bytes(bytes).is_ok(), "{id}");
        }
    }

    #[test]
    fn a_signed_index_is_served_and_cached() {
        let dir = dir("ok");
        let served = signed(&dir, NOW, NOW);
        assert_eq!((served.problem, served.stale), (None, false));
        let served = refresh(&dir, NOW + 60, false, &keys(), |_| panic!("inside the TTL"));
        assert_eq!(generated_at(&served), rfc3339(NOW));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tampered_body_sig_or_unknown_key_is_refused_and_the_cache_kept() {
        let dir = dir("tamper");
        signed(&dir, NOW, NOW);
        let index = index_at(NOW + DAY);
        let sig = sig_for(&index, "t1");
        let mut tampered = index.clone();
        tampered[2] ^= 1;
        let mut bad_sig: Value = serde_json::from_slice(&sig).unwrap();
        bad_sig["signature"] = json!(base64::engine::general_purpose::STANDARD.encode([1u8; 64]));
        let attempts = [
            (tampered, sig.clone()),
            (index.clone(), serde_json::to_vec(&bad_sig).unwrap()),
            (index.clone(), sig_for(&index, "k9")),
        ];
        for (index, sig) in attempts {
            let served = refresh(&dir, NOW + DAY, true, &keys(), |_| body(index, sig));
            assert!(matches!(served.problem, Some(Problem::Unverified(_))), "{served:?}");
            assert_eq!(generated_at(&served), rfc3339(NOW));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_index_is_refused() {
        let dir = dir("older");
        signed(&dir, NOW, NOW);
        let served = signed(&dir, NOW - DAY, NOW + DAY);
        assert!(matches!(served.problem, Some(Problem::Unverified(_))));
        assert_eq!(generated_at(&served), rfc3339(NOW));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_index_is_served_stale() {
        let dir = dir("expired");
        let served = signed(&dir, NOW - 40 * DAY, NOW);
        assert_eq!((served.problem, served.stale), (None, true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_304_keeps_the_cache_and_sends_its_etag() {
        let dir = dir("304");
        signed(&dir, NOW, NOW);
        let served = refresh(&dir, NOW + DAY, true, &keys(), |etag| {
            assert_eq!(etag, Some("\"e1\""));
            Ok(Response::NotModified)
        });
        assert_eq!(served.problem, None);
        assert_eq!(generated_at(&served), rfc3339(NOW));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn offline_serves_the_cache_or_nothing() {
        let dir = dir("offline");
        let served = refresh(&dir, NOW, true, &keys(), |_| Err("no network".into()));
        assert_eq!(served.index, None);
        assert!(matches!(served.problem, Some(Problem::Offline(_))));
        signed(&dir, NOW, NOW);
        let served = refresh(&dir, NOW + DAY, false, &keys(), |_| Err("no network".into()));
        assert!(matches!(served.problem, Some(Problem::Offline(_))));
        assert_eq!(generated_at(&served), rfc3339(NOW));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn row(id: &str, schema_version: u32, sha: &str) -> Value {
        json!({ "kind": "lsp", "id": id, "schema_version": schema_version, "sha256": sha })
    }

    fn installed_override(id: &str, sha: &str) -> Installed {
        let mut installed = Installed::default();
        installed.record(Record {
            kind: Kind::Lsp,
            id: id.into(),
            sha256: sha.into(),
            source: Recorded::Override,
            packs_commit: None,
            installed_at: 0,
            bundled_sha256: None,
        });
        installed
    }

    #[test]
    fn rows_a_newer_schema_or_unknown_kind_are_hidden() {
        let index = json!({ "rows": [
            row("x", 1, "aa"),
            row("y", 99, "aa"),
            { "kind": "someday", "id": "z", "schema_version": 1, "sha256": "aa" },
        ]});
        let ids: Vec<_> = rows(&index, &Installed::default(), |_, _| None)
            .into_iter()
            .map(|r| r.pack["id"].clone())
            .collect();
        assert_eq!(ids, [json!("x")]);
    }

    #[test]
    fn a_bundled_id_with_a_new_hash_has_an_update_and_an_override_never_does() {
        let index = json!({ "rows": [row("x", 1, "new")] });
        let bundled = |_: Kind, _: &str| Some("old".to_string());
        let r = &rows(&index, &Installed::default(), bundled)[0];
        assert_eq!((r.bundled, r.installed, r.update_available), (true, false, true));
        let r = &rows(&index, &installed_override("x", "old"), bundled)[0];
        assert_eq!((r.installed, r.update_available), (true, false));
    }
}
