#[path = "src/packs/index_rows.rs"]
mod index_rows;

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
    embed_packs();
    tauri_build::build()
}

/// Writes `$OUT_DIR/packs_snapshot.rs`: every file under `packs/` as
/// `(kind, id, text, sha256)`, and the index those files make.
fn embed_packs() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("packs");
    println!("cargo:rerun-if-changed={}", dir.display());

    let packs = index_rows::read_packs(&dir).unwrap_or_else(|e| panic!("bundled packs: {e}"));
    let mut out = String::from("pub static FILES: &[(&str, &str, &str, &str)] = &[\n");
    for p in &packs {
        writeln!(
            out,
            "    ({:?}, {:?}, include_str!({:?}), {:?}),",
            p.kind,
            p.id,
            p.path.display().to_string(),
            p.sha256
        )
        .unwrap();
    }
    out.push_str("];\n");
    writeln!(
        out,
        "pub static INDEX: &str = {:?};",
        index_rows::index(&packs).to_string()
    )
    .unwrap();

    let target = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("packs_snapshot.rs");
    std::fs::write(target, out).unwrap();
}
