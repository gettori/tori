// Turns a packs directory into index rows. Shared by build.rs, which includes
// this file by `#[path]`, and the packs-index subcommand, so it may use only
// what build.rs depends on: toml, serde_json and sha2.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// The kind folders, named as the loaders name them.
pub const KINDS: [&str; 5] = ["lsp", "dap", "formatters", "themes", "agents"];

/// A pack with no `[install.assets]` runs wherever its tool does.
const ALL_PLATFORMS: [&str; 3] = ["linux", "macos", "windows"];

/// One file of a packs directory, with the index row that describes it.
pub struct PackFile {
    pub kind: &'static str,
    pub id: String,
    pub path: std::path::PathBuf,
    pub sha256: String,
    pub row: Value,
}

/// The file extension a kind's packs carry.
pub fn extension(kind: &str) -> &'static str {
    if kind == "themes" {
        "json"
    } else {
        "toml"
    }
}

/// Every pack under `dir`, kind by kind, each kind sorted by file name. Files
/// without the kind's extension are skipped; a kind folder may be absent.
pub fn read_packs(dir: &Path) -> Result<Vec<PackFile>, String> {
    let mut packs = Vec::new();
    for kind in KINDS {
        let Ok(entries) = std::fs::read_dir(dir.join(kind)) else {
            continue;
        };
        let mut paths: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some(extension(kind)))
            .collect();
        paths.sort();
        for path in paths {
            let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            packs.push(pack_file(kind, path, text)?);
        }
    }
    Ok(packs)
}

fn pack_file(kind: &'static str, path: std::path::PathBuf, text: String) -> Result<PackFile, String> {
    let source = path.display().to_string();
    let doc: Value = if kind == "themes" {
        serde_json::from_str(&text).map_err(|e| format!("{source}: {e}"))?
    } else {
        let value: toml::Value = toml::from_str(&text).map_err(|e| format!("{source}: {e}"))?;
        serde_json::to_value(value).map_err(|e| format!("{source}: {e}"))?
    };
    let str_field = |name: &str| doc.get(name).and_then(Value::as_str);

    let id = str_field("id").ok_or_else(|| format!("{source}: no `id`"))?.to_string();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    if stem != id {
        return Err(format!("{source}: the file is named `{stem}` but its id is `{id}`"));
    }

    let sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    let role = (kind == "lsp").then(|| str_field("role").unwrap_or("primary"));
    let schema_version = doc.get("schema_version").or_else(|| doc.get("schemaVersion")).cloned();

    let mut row = Map::new();
    row.insert("kind".into(), json!(kind));
    row.insert("id".into(), json!(id));
    row.insert("role".into(), json!(role));
    row.insert("schema_version".into(), schema_version.unwrap_or(Value::Null));
    row.insert("sha256".into(), json!(sha256));
    for field in [
        "label",
        "description",
        "contributor",
        "license",
        "verified_against",
        "verified_on",
    ] {
        row.insert(field.into(), doc.get(field).cloned().unwrap_or(Value::Null));
    }
    row.insert("platforms".into(), json!(platforms(&doc)));

    Ok(PackFile {
        kind,
        id,
        path,
        sha256,
        row: Value::Object(row),
    })
}

fn platforms(doc: &Value) -> Vec<String> {
    let Some(assets) = doc.pointer("/install/assets").and_then(Value::as_object) else {
        return ALL_PLATFORMS.iter().map(|p| p.to_string()).collect();
    };
    let mut found: Vec<String> = assets
        .keys()
        .map(|key| key.split('-').next().unwrap_or(key).to_string())
        .collect();
    found.sort();
    found.dedup();
    found
}

/// The index document for `packs`, without the `url` and `min_tori` that only
/// the published index carries.
pub fn index(packs: &[PackFile]) -> Value {
    json!({ "rows": packs.iter().map(|p| p.row.clone()).collect::<Vec<_>>() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tori_index_rows_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let write = |rel: &str, text: &str| {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            "lsp/zed.toml",
            "schema_version = 1\nid = \"zed\"\nlabel = \"Zed\"\nrole = \"secondary\"\n\
             license = \"MIT\"\ncontributor = { name = \"Ada\", github = \"ada\" }\n\
             verified_against = \"zed 1.0\"\nverified_on = \"2026-10-09\"\n\
             [install.assets.macos-aarch64]\nfile = \"z\"\n[install.assets.linux-x86_64]\nfile = \"z\"\n\
             [install.assets.macos-x86_64]\nfile = \"z\"\n",
        );
        write(
            "lsp/alpha.toml",
            "schema_version = 1\nid = \"alpha\"\nlabel = \"Alpha\"\n",
        );
        write("lsp/README.md", "not a pack");
        write(
            "themes/moss.json",
            r#"{ "schemaVersion": 1, "id": "moss", "label": "Moss", "description": "Green" }"#,
        );
        dir
    }

    #[test]
    fn rows_come_out_kind_by_kind_in_file_order_and_skip_other_files() {
        let dir = fixture("order");
        let packs = read_packs(&dir).unwrap();
        let ids: Vec<(&str, &str)> = packs.iter().map(|p| (p.kind, p.id.as_str())).collect();
        assert_eq!(ids, [("lsp", "alpha"), ("lsp", "zed"), ("themes", "moss")]);
    }

    #[test]
    fn a_row_carries_the_catalog_fields_and_the_hash_of_the_bytes() {
        let dir = fixture("row");
        let packs = read_packs(&dir).unwrap();
        let zed = &packs[1];
        let bytes = std::fs::read(dir.join("lsp/zed.toml")).unwrap();
        assert_eq!(zed.sha256, format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(
            zed.row,
            json!({
                "kind": "lsp",
                "id": "zed",
                "role": "secondary",
                "schema_version": 1,
                "sha256": zed.sha256,
                "label": "Zed",
                "description": null,
                "contributor": { "name": "Ada", "github": "ada" },
                "license": "MIT",
                "verified_against": "zed 1.0",
                "verified_on": "2026-10-09",
                "platforms": ["linux", "macos"],
            })
        );
    }

    #[test]
    fn defaults_fill_what_a_pack_leaves_out() {
        let dir = fixture("defaults");
        let packs = read_packs(&dir).unwrap();
        assert_eq!(packs[0].row["role"], "primary");
        assert_eq!(packs[0].row["platforms"], json!(["linux", "macos", "windows"]));
        assert_eq!(packs[2].row["role"], Value::Null);
        assert_eq!(packs[2].row["schema_version"], 1);
        assert_eq!(packs[2].row["description"], "Green");
    }

    #[test]
    fn a_file_named_other_than_its_id_is_refused() {
        let dir = fixture("stem");
        std::fs::write(dir.join("lsp/beta.toml"), "id = \"gamma\"\n").unwrap();
        let err = read_packs(&dir).err().unwrap();
        assert!(err.contains("`beta`") && err.contains("`gamma`"), "{err}");
    }

    #[test]
    fn the_index_lists_every_row() {
        let dir = fixture("index");
        let packs = read_packs(&dir).unwrap();
        assert_eq!(index(&packs)["rows"].as_array().unwrap().len(), 3);
    }
}
