// The bundled packs, embedded by build.rs from src-tauri/packs/.

include!(concat!(env!("OUT_DIR"), "/packs_snapshot.rs"));

/// The bundled packs of one kind as `(source, text)`, the source written
/// `bundled:<id>` as the loaders expect.
pub fn bundled(kind: &'static str) -> impl Iterator<Item = (String, &'static str)> {
    FILES
        .iter()
        .filter(move |(k, ..)| *k == kind)
        .map(|(_, id, text, _)| (format!("bundled:{id}"), *text))
}

/// The text of one bundled pack.
pub fn text(kind: &str, id: &str) -> Option<&'static str> {
    FILES
        .iter()
        .find(|(k, i, ..)| *k == kind && *i == id)
        .map(|(_, _, text, _)| *text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn every_file_on_disk_is_embedded_with_its_hash() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("packs");
        let on_disk: Vec<(&str, String, String)> = super::super::index_rows::read_packs(&dir)
            .unwrap()
            .into_iter()
            .map(|p| (p.kind, p.id, p.sha256))
            .collect();
        let embedded: Vec<(&str, String, String)> = FILES
            .iter()
            .map(|(k, id, _, sha)| (*k, id.to_string(), sha.to_string()))
            .collect();
        assert_eq!(embedded, on_disk);
    }

    #[test]
    fn the_index_has_a_row_per_file() {
        let index: serde_json::Value = serde_json::from_str(INDEX).unwrap();
        let rows = index["rows"].as_array().unwrap();
        assert_eq!(rows.len(), FILES.len());
        for (row, (kind, id, _, sha)) in rows.iter().zip(FILES) {
            assert_eq!((row["kind"].as_str(), row["id"].as_str()), (Some(*kind), Some(*id)));
            assert_eq!(row["sha256"].as_str(), Some(*sha));
            assert!(row.get("url").is_none() && row.get("min_tori").is_none());
        }
    }
}
