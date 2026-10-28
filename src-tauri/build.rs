#[path = "src/packs/index_rows.rs"]
mod index_rows;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    embed_packs();
    embed_commit();
    link_compiler_runtime();
    tauri_build::build()
}

// The static ONNX Runtime (read aloud) calls `__isPlatformVersionAtLeast`,
// which lives in clang's runtime, and rustc does not link that on its own.
fn link_compiler_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let dir = Command::new("clang")
        .arg("--print-resource-dir")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("clang --print-resource-dir");
    println!("cargo:rustc-link-arg={dir}/lib/darwin/libclang_rt.osx.a");
}

/// Sets `TORI_COMMIT` to the short SHA of HEAD, or to nothing outside a git
/// checkout (a source tarball), which the About dialog then leaves out.
fn embed_commit() {
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    // A path that does not exist (a packed ref) would rerun the script on every
    // build, so only the files that are there are watched.
    let mut watched = vec![git(&["rev-parse", "--git-path", "HEAD"])];
    if let Some(branch) = git(&["symbolic-ref", "-q", "HEAD"]) {
        watched.push(git(&["rev-parse", "--git-path", &branch]));
    }
    for path in watched.into_iter().flatten() {
        if Path::new(&path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    let sha = git(&["rev-parse", "--short=7", "HEAD"]).unwrap_or_default();
    println!("cargo:rustc-env=TORI_COMMIT={sha}");
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
