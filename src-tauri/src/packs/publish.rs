// `tori packs-index`: the index gettori.app serves, written beside the packs it
// lists and signed when a key is given. The rows come from index_rows.rs, the
// generator build.rs embeds with, so the catalog and the snapshot cannot
// disagree about what a row is.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};

use super::index_rows::{self, extension};

const FILES_URL: &str = "https://gettori.app/packs/files";

/// How long a signed index stays current. Re-signed weekly, so a client sees
/// an expired one only when publishing has stopped.
const LIFETIME_SECS: u64 = 30 * 24 * 60 * 60;

/// The key `index.json.sig` is made with.
pub struct Signing {
    pub key_pem: String,
    pub key_id: String,
}

/// The index for the packs under `dir`. `support` is `tori-support.json`:
/// per kind, the first Tori release that loads each schema_version.
pub fn build(dir: &Path, support: &Value, packs_commit: &str, now: u64) -> Result<Value, String> {
    let mut rows = Vec::new();
    for pack in index_rows::read_packs(dir)? {
        let mut row = pack.row;
        let version = row["schema_version"].as_u64().unwrap_or(0);
        let min_tori = support
            .get(pack.kind)
            .and_then(|k| k.get(version.to_string()))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!(
                    "tori-support.json names no Tori release for {} schema_version {version} ({})",
                    pack.kind,
                    pack.path.display()
                )
            })?;
        row["url"] = json!(format!(
            "{FILES_URL}/{}/{}.{}",
            pack.kind,
            pack.id,
            extension(pack.kind)
        ));
        row["min_tori"] = json!(min_tori);
        rows.push(row);
    }
    Ok(json!({
        "generated_at": rfc3339(now),
        "expires": rfc3339(now + LIFETIME_SECS),
        "packs_commit": packs_commit,
        "rows": rows,
    }))
}

/// The bytes written to disk, and so the bytes a signature covers.
pub fn render(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(value).expect("a JSON value serializes");
    bytes.push(b'\n');
    bytes
}

/// `index.json.sig`: `{ key_id, signature }`, the signature base64 over
/// exactly `bytes`.
pub fn sign(bytes: &[u8], signing: &Signing) -> Result<Vec<u8>, String> {
    let key = SigningKey::from_pkcs8_pem(&signing.key_pem)
        .map_err(|e| format!("the signing key is not an Ed25519 private key in PKCS#8 PEM: {e}"))?;
    let signature = base64::engine::general_purpose::STANDARD.encode(key.sign(bytes).to_bytes());
    Ok(render(&json!({ "key_id": signing.key_id, "signature": signature })))
}

/// Writes `index.json` into `dir`, and `index.json.sig` beside it when
/// signing. An unsigned run removes an old signature, which would no longer
/// match. Returns the row count.
pub fn write(dir: &Path, signing: Option<&Signing>) -> Result<usize, String> {
    let support_path = dir.join("tori-support.json");
    let support: Value = std::fs::read_to_string(&support_path)
        .map_err(|e| format!("{}: {e}", support_path.display()))
        .and_then(|text| serde_json::from_str(&text).map_err(|e| format!("{}: {e}", support_path.display())))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let index = build(dir, &support, &head_commit(dir)?, now)?;
    let rows = index["rows"].as_array().map_or(0, Vec::len);

    let bytes = render(&index);
    let sig_path = dir.join("index.json.sig");
    std::fs::write(dir.join("index.json"), &bytes).map_err(|e| e.to_string())?;
    match signing {
        Some(signing) => std::fs::write(&sig_path, sign(&bytes, signing)?).map_err(|e| e.to_string())?,
        None if sig_path.exists() => std::fs::remove_file(&sig_path).map_err(|e| e.to_string())?,
        None => {}
    }
    Ok(rows)
}

/// The commit checked out at `dir`, read from the git files rather than by
/// running git: `exec::git_in` refuses a folder Tori was never told to trust,
/// which is every CI checkout, and reading files runs none of the repo's config.
fn head_commit(dir: &Path) -> Result<String, String> {
    let not_git = || format!("{} is not inside a git checkout", dir.display());
    let start = dir.canonicalize().map_err(|_| not_git())?;
    let dot_git = start
        .ancestors()
        .map(|d| d.join(".git"))
        .find(|p| p.exists())
        .ok_or_else(not_git)?;
    let git_dir = if dot_git.is_file() {
        let text = std::fs::read_to_string(&dot_git).map_err(|e| e.to_string())?;
        let pointer = text.trim().strip_prefix("gitdir: ").ok_or_else(not_git)?;
        dot_git.parent().unwrap_or(Path::new("/")).join(pointer)
    } else {
        dot_git
    };
    // A linked worktree keeps HEAD to itself and its refs in the main checkout.
    let common_dir = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(rel) => git_dir.join(rel.trim()),
        Err(_) => git_dir.clone(),
    };

    let head = std::fs::read_to_string(git_dir.join("HEAD")).map_err(|e| e.to_string())?;
    let head = head.trim();
    let commit = match head.strip_prefix("ref: ") {
        None => head.to_string(),
        Some(name) => [&git_dir, &common_dir]
            .iter()
            .find_map(|d| std::fs::read_to_string(d.join(name)).ok())
            .map(|sha| sha.trim().to_string())
            .or_else(|| {
                let packed = std::fs::read_to_string(common_dir.join("packed-refs")).ok()?;
                packed.lines().find_map(|line| {
                    let (sha, refname) = line.split_once(' ')?;
                    (refname == name).then(|| sha.to_string())
                })
            })
            .ok_or_else(|| format!("{name} has no commit yet"))?,
    };
    if matches!(commit.len(), 40 | 64) && commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(commit)
    } else {
        Err(format!("HEAD at {} is not a commit", dir.display()))
    }
}

/// `secs` since the epoch as `YYYY-MM-DDTHH:MM:SSZ`, a fixed width so two of
/// them compare as strings.
fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_rows() -> Vec<Value> {
        let index: Value = serde_json::from_str(crate::packs::snapshot::INDEX).unwrap();
        index["rows"].as_array().unwrap().clone()
    }

    /// Every kind and schema_version the snapshot carries, mapped to one release.
    fn support_for_snapshot() -> Value {
        let mut support = json!({});
        for row in snapshot_rows() {
            let kind = row["kind"].as_str().unwrap().to_string();
            let version = row["schema_version"].to_string();
            support[&kind][&version] = json!("26.1008.0");
        }
        support
    }

    #[test]
    fn the_rows_are_the_embedded_rows_plus_url_and_min_tori() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("packs");
        let index = build(&dir, &support_for_snapshot(), "abc123", 0).unwrap();
        let rows = index["rows"].as_array().unwrap();
        let first = &rows[0];
        assert_eq!(
            first["url"],
            format!(
                "{FILES_URL}/{}/{}.{}",
                first["kind"].as_str().unwrap(),
                first["id"].as_str().unwrap(),
                extension(first["kind"].as_str().unwrap())
            )
        );
        assert_eq!(first["min_tori"], "26.1008.0");
        let stripped: Vec<Value> = rows
            .iter()
            .cloned()
            .map(|mut row| {
                let row_map = row.as_object_mut().unwrap();
                row_map.remove("url");
                row_map.remove("min_tori");
                row
            })
            .collect();
        assert_eq!(stripped, snapshot_rows());
        assert_eq!(index["packs_commit"], "abc123");
    }
}
