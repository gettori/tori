// Servers Tori installs itself, for `launch.kind = "managed"`. Each lives in
// `~/.config/tori/servers/<id>/` with a manifest naming the version and the
// binary, so an app update that pins a newer version can still run the old
// install and offer the update.
//
// An install is built in a staging directory beside the real one and moved into
// place only once it is complete, so a failure at any step leaves the previous
// install, or nothing, never half of one.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::registry::{inside, platform, Install, Launch, LspServer, Runtime};

const MANIFEST: &str = "tori-install.json";

/// What `lsp_start` rejects a server with when Tori could install it, and
/// `dap_start` an adapter with an `[install]`, so the editor can offer to.
/// `utils/serverInstall.ts` matches it exactly.
pub const NOT_INSTALLED: &str = "not_installed";

// The largest bundled asset (clangd) is under 100 MB; the bound turns a URL
// that never ends into a refusal instead of a machine out of memory.
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

// Two clicks on Install must not share one staging directory.
static INSTALLING: Mutex<()> = Mutex::new(());

/// Where Tori's own copies live, one directory per server id.
pub fn servers_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/tori/servers")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installed {
    pub version: String,
    /// The server binary, relative to the install directory.
    pub bin: String,
}

/// Tori's own copy of `id`, when one is installed and its binary is there.
pub fn installed(dir: &Path, id: &str) -> Option<(PathBuf, Installed)> {
    let root = dir.join(id);
    let text = std::fs::read_to_string(root.join(MANIFEST)).ok()?;
    let manifest: Installed = serde_json::from_str(&text).ok()?;
    let bin = root.join(&manifest.bin);
    (inside(Path::new(&manifest.bin)) && bin.is_file()).then_some((bin, manifest))
}

/// The command for a `managed` server: the user's own copy on the login PATH
/// first, then Tori's.
pub fn command(server: &LspServer, dir: &Path) -> Result<Command, String> {
    let Launch::Managed { program, args, runtime } = &server.launch else {
        return Err(format!("{}: not a managed server", server.id));
    };
    let mut cmd = if let Some(path) = crate::env::resolve_binary(program) {
        Command::new(path)
    } else if let Some((bin, _)) = installed(dir, &server.id) {
        match runtime {
            Runtime::Node => {
                let mut cmd = Command::new("node");
                cmd.arg(bin);
                cmd
            }
            Runtime::Native => Command::new(bin),
        }
    } else if server.install.as_ref().is_some_and(|i| i.available_version().is_some()) {
        return Err(NOT_INSTALLED.to_string());
    } else {
        return Err(format!("{}: `{program}` is not on your PATH, and Tori has no build of it for {}", server.id, platform()));
    };
    cmd.args(args);
    Ok(cmd)
}

/// Install (or replace) Tori's copy of `server`.
pub fn install(server: &LspServer, dir: &Path) -> Result<Installed, String> {
    install_with(server, dir, download)
}

fn install_with(
    server: &LspServer,
    dir: &Path,
    fetch: impl Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<Installed, String> {
    install_staged(dir, &server.id, |staging| fill(server, staging, fetch))
}

/// Build `id`'s install with `fill` in a staging directory beside `dir/<id>`,
/// then move it into place whole. Shared with the debuggers Tori installs.
pub(crate) fn install_staged(
    dir: &Path,
    id: &str,
    fill: impl FnOnce(&Path) -> Result<Installed, String>,
) -> Result<Installed, String> {
    let _guard = INSTALLING.lock().unwrap_or_else(|e| e.into_inner());
    let staging = dir.join(format!(".{id}.partial"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("cannot create {}: {e}", staging.display()))?;

    let result = fill(&staging).and_then(|manifest| {
        if !staging.join(&manifest.bin).is_file() {
            return Err(format!("{id}: the install has no `{}`", manifest.bin));
        }
        let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        std::fs::write(staging.join(MANIFEST), text).map_err(|e| e.to_string())?;
        swap_in(dir, id, &staging)?;
        Ok(manifest)
    });
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn fill(
    server: &LspServer,
    staging: &Path,
    fetch: impl Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<Installed, String> {
    let program = server.launch.program();
    let manifest = match &server.install {
        Some(Install::Npm { package, version }) => {
            let npm = crate::env::resolve_binary("npm").ok_or("npm was not found on your PATH")?;
            // `--ignore-scripts`: an install script is arbitrary code, and a
            // server that needs one to run is not one Tori can ship.
            let out = Command::new(npm)
                .arg("install")
                .arg("--prefix")
                .arg(staging)
                .args(["--ignore-scripts", "--no-audit", "--no-fund"])
                .arg(format!("{package}@{version}"))
                .env("PATH", crate::env::augmented_path())
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("could not run npm: {e}"))?;
            if !out.status.success() {
                return Err(format!("npm install {package}@{version} failed: {}", last_line(&out.stderr)));
            }
            Installed { version: version.clone(), bin: format!("node_modules/.bin/{program}") }
        }
        Some(Install::GithubRelease { repo, version, assets }) => {
            let key = platform();
            let asset = assets.get(&key).ok_or_else(|| format!("{} has no build for {key}", server.label))?;
            let bytes = fetch(&format!("https://github.com/{repo}/releases/download/{version}/{}", asset.file))?;
            let digest = format!("{:x}", Sha256::digest(&bytes));
            if digest != asset.sha256 {
                return Err(format!("{}: checksum mismatch (expected {}, got {digest})", asset.file, asset.sha256));
            }
            if is_archive(&asset.file) {
                let archive = staging.join(&asset.file);
                std::fs::write(&archive, &bytes).map_err(|e| e.to_string())?;
                unpack(&archive, staging)?;
                let _ = std::fs::remove_file(&archive);
            } else {
                let bin = staging.join(&asset.bin);
                if let Some(parent) = bin.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(bin, &bytes).map_err(|e| e.to_string())?;
            }
            make_executable(&staging.join(&asset.bin))?;
            Installed { version: version.clone(), bin: asset.bin.clone() }
        }
        Some(Install::Hint { .. }) | None => return Err(format!("{}: Tori has nothing to install", server.id)),
    };
    Ok(manifest)
}

fn swap_in(dir: &Path, id: &str, staging: &Path) -> Result<(), String> {
    let target = dir.join(id);
    let old = dir.join(format!(".{id}.old"));
    let _ = std::fs::remove_dir_all(&old);
    if target.exists() {
        std::fs::rename(&target, &old).map_err(|e| format!("cannot replace {}: {e}", target.display()))?;
    }
    if let Err(e) = std::fs::rename(staging, &target) {
        let _ = std::fs::rename(&old, &target);
        return Err(format!("cannot move the install into {}: {e}", target.display()));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Remove Tori's copy of `id`. Removing one that is not there is not an error.
pub fn remove(dir: &Path, id: &str) -> Result<(), String> {
    match std::fs::remove_dir_all(dir.join(id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn is_archive(file: &str) -> bool {
    file.ends_with(".zip") || file.ends_with(".tgz") || file.contains(".tar")
}

// The system `tar`, which on macOS is bsdtar: it reads zip and every tar
// compression, and refuses an entry with `..` in its path or one that writes
// through a symlink, the containment an archive Tori did not build needs.
fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let out = Command::new("tar")
        .arg("-xf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run tar: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("could not unpack {}: {}", archive.display(), last_line(&out.stderr)))
    }
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot make {} executable: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    // GitHub redirects a release download to its object store. HTTPS only, so
    // no hop can move the download onto plain HTTP.
    let agent = ureq::AgentBuilder::new()
        .https_only(true)
        .redirects(5)
        .timeout(Duration::from_secs(300))
        .build();
    let response = agent.get(url).set("User-Agent", "tori-lsp-install").call().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_DOWNLOAD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("download failed: {e}"))?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err(format!("{url} is larger than {MAX_DOWNLOAD_BYTES} bytes"));
    }
    Ok(bytes)
}

pub(crate) fn last_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::registry::load_server_str;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(name: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tori_lsp_managed_{}_{name}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn release_server(program: &str, file: &str, sha256: &str, bin: &str) -> LspServer {
        let text = format!(
            "schema_version = 1\nid = \"demo\"\nlabel = \"Demo\"\nroot_markers = [\".git\"]\n\
             [languages]\ndemo = \"demo\"\n\
             [launch]\nkind = \"managed\"\nruntime = \"native\"\nprogram = \"{program}\"\n\
             [install]\nkind = \"github_release\"\nrepo = \"owner/demo\"\nversion = \"v1.0.0\"\n\
             [install.assets.{}]\nfile = \"{file}\"\nsha256 = \"{sha256}\"\nbin = \"{bin}\"\n",
            platform()
        );
        load_server_str(&text, "test").unwrap()
    }

    /// A tar.gz holding `bin/<program>`, and its sha256.
    fn archive(program: &str) -> (Vec<u8>, String) {
        let src = temp_dir("archive_src");
        std::fs::create_dir_all(src.join("bin")).unwrap();
        std::fs::write(src.join("bin").join(program), "#!/bin/sh\necho demo\n").unwrap();
        let out = src.join("demo.tar.gz");
        let status = Command::new("tar").arg("-czf").arg(&out).arg("-C").arg(&src).arg("bin").status().unwrap();
        assert!(status.success());
        let bytes = std::fs::read(out).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        (bytes, digest)
    }

    #[test]
    fn a_checksum_mismatch_aborts_and_leaves_no_partial_directory() {
        let (bytes, _) = archive("tori-demo-server");
        let server = release_server("tori-demo-server", "demo.tar.gz", &"0".repeat(64), "bin/tori-demo-server");
        let dir = temp_dir("install_mismatch");

        let err = install_with(&server, &dir, |_| Ok(bytes.clone())).unwrap_err();

        assert!(err.contains("checksum mismatch"), "{err}");
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(left.is_empty(), "nothing may be left behind: {left:?}");
    }

    #[test]
    fn a_missing_server_tori_can_install_is_not_installed() {
        let server = release_server("tori-not-on-any-path", "demo.tar.gz", &"0".repeat(64), "bin/x");
        assert_eq!(command(&server, &temp_dir("missing")).unwrap_err(), NOT_INSTALLED);
    }

    #[test]
    fn a_path_copy_beats_an_installed_copy() {
        let (bytes, digest) = archive("sh");
        let dir = temp_dir("path_first");
        let server = release_server("sh", "demo.tar.gz", &digest, "bin/sh");
        install_with(&server, &dir, |_| Ok(bytes.clone())).unwrap();

        let on_path = crate::env::resolve_binary("sh").expect("sh is on every PATH");
        assert_eq!(Path::new(command(&server, &dir).unwrap().get_program()), on_path);

        let (bytes, digest) = archive("tori-not-on-any-path");
        let server = release_server("tori-not-on-any-path", "demo.tar.gz", &digest, "bin/tori-not-on-any-path");
        install_with(&server, &dir, |_| Ok(bytes.clone())).unwrap();
        assert_eq!(
            Path::new(command(&server, &dir).unwrap().get_program()),
            dir.join("demo/bin/tori-not-on-any-path")
        );
    }

}
