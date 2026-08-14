// Installing an agent the ACP Registry describes.
//
// THE TRUST MODEL, stated before anything below is read.
//
// **Installing an agent is trusting the registry.** The registry publishes, per
// agent and per platform, an archive URL and sometimes a `sha256`. Both live in
// the same `agent.json`, so the checksum is a **transport control**: it proves
// the bytes that arrived are the bytes the registry named, and it proves nothing
// at all about who named them. Anyone who can change `agent.json` can change the
// URL and the checksum in one commit, and every check below still passes. That
// is not a flaw to be engineered around here; it is the property of a registry
// with no publisher signatures, and the only honest response is to say so where
// the user presses the button.
//
// Measured 2026-08-14: of the 17 agents shipping binary distributions, 9 publish
// a `sha256` for darwin and 8 publish none. So more than half of these downloads
// have no checksum to check, and the difference between the two cases is carried
// all the way to the UI rather than smoothed over.
//
// WHAT THE CHECKS ACTUALLY BUY, each stated as the one thing it stops:
//
//   * **The redirect policy** stops a hop from moving the download onto plain
//     HTTP. Following https -> http would hand the archive to anyone on the path
//     even though the user started at a URL that looked safe.
//   * **The checksum** stops the bytes being swapped in flight, when there is
//     one to check. It does not stop a compromised registry.
//   * **Containment** stops the archive from writing outside the directory it is
//     being unpacked into. That threat is not hypothetical for an archive Sway
//     did not build: one `../../../` entry is a write anywhere the user can
//     write.
//   * **Refusing symlinks** stops an archive from planting a link that redirects
//     a later write, and from being the reason a `..` check passes lexically and
//     escapes anyway.
//   * **The Gatekeeper choice** stops the quarantine flag being cleared behind
//     the user's back. Clearing it is what makes an unnotarized binary runnable,
//     which is exactly the check macOS was doing on their behalf.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not put anything on the user's
// PATH: an installed agent is a path under Sway's own data directory, and the
// only way it reaches a session is a user writing the adapter TOML that names
// it. Downloading a binary is not the same act as deciding to run it, and
// keeping them apart is what stops an install from quietly becoming a supported
// harness. `crate::catalog`'s header is the other half of that boundary.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How many redirects to follow before giving up.
///
/// The measured downloads land in one or two hops (GitHub releases redirect to
/// an object store). Five is slack for a publisher that adds a vanity domain,
/// and a bound so a redirect loop ends as a refusal rather than a hang.
const MAX_REDIRECTS: usize = 5;

/// Refuse an archive larger than this before reading it into memory.
///
/// The largest darwin build measured is well under 200 MB. The bound exists so a
/// URL that turns into an endless stream is a refusal rather than a machine with
/// no memory left.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

/// What Sway installed, written beside the binary it installed.
///
/// A manifest rather than an inference from the directory contents: removal has
/// to be able to say "these are the files Sway put here", and a user's own
/// `cursor-agent` living somewhere else on their machine must not be reachable
/// from anything in here.
///
/// `camelCase` in both directions, unlike the catalog's types: this file is
/// Sway's own, written and read by this module, so the wire shape and the
/// on-disk shape are the same shape and a manifest cannot be written in a form
/// it cannot be read back in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub id: String,
    /// The version the **registry** pinned at install time. Not a version Sway
    /// measured anything against, and it keeps that name all the way to the UI.
    pub registry_version: Option<String>,
    pub platform: String,
    pub archive: String,
    /// The checksum that was verified, or `None` when the registry published
    /// none. `None` is the fact "this download was never checked", and it stays
    /// on the record for as long as the install does.
    pub sha256: Option<String>,
    /// Absolute path to the installed binary. This is what a user pastes into an
    /// adapter TOML, and it is not on any PATH.
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// Whether `com.apple.quarantine` was cleared, and therefore whether the
    /// user was asked. Recorded because it is the one step here that turns a
    /// macOS refusal into a running binary.
    pub quarantine_cleared: bool,
    /// Unix seconds. Ordinary provenance: an install with no date is the thing
    /// nobody can reason about a year later.
    pub installed_at: u64,
}

/// Where installed agents live: the platform data dir, never `~/.config/sway`
/// and never a PATH entry.
///
/// macOS resolves this to `~/Library/Application Support/sway/installed-agents`.
/// Beside `profiles/` for the same reason accounts chose it: this is state Sway
/// owns rather than configuration a user edits, and `~/.config` is commonly
/// version-controlled in a dotfile repo.
///
/// `installed-agents` rather than `agents`, because `~/.config/sway/agents/` is
/// already where a user's adapter TOMLs go. Two directories with one name, one
/// holding files the user writes and one holding binaries Sway downloaded, is a
/// confusion worth a longer word.
pub fn install_root() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join("sway/installed-agents")
}

/// Reduce an id to a bare path segment. The id comes from a JSON Sway does not
/// author, and it is about to be concatenated into a path.
fn sanitize_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// `0700`, on unix. A no-op elsewhere, where the mode has no meaning.
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("cannot restrict {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// --- download ---

/// Fetch `url`, following redirects only while they stay on HTTPS.
///
/// `ureq`'s own redirect following is turned off and the hops are walked here,
/// because the thing worth refusing is a *downgrade*, and a client that follows
/// redirects for you cannot be asked about the scheme of the hop it took. The
/// first hop is checked too: a catalog entry naming an `http://` archive is the
/// same exposure arriving by a shorter route.
fn download(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let mut current = url.to_string();

    for _ in 0..=MAX_REDIRECTS {
        if !current.starts_with("https://") {
            return Err(format!(
                "refusing to download over an insecure connection: {current} is not https"
            ));
        }
        let response = match agent.get(&current).call() {
            Ok(r) => r,
            // A redirect arrives as an error once following is off.
            Err(ureq::Error::Status(code, r)) if (300..400).contains(&code) => r,
            Err(e) => return Err(format!("downloading {current} failed: {e}")),
        };
        if (300..400).contains(&response.status()) {
            let location = response
                .header("location")
                .ok_or_else(|| format!("{current} redirected without saying where"))?;
            current = resolve_redirect(&current, location)?;
            continue;
        }
        let declared: Option<u64> =
            response.header("content-length").and_then(|v| v.parse().ok());
        if declared.is_some_and(|n| n > MAX_ARCHIVE_BYTES) {
            return Err(format!(
                "refusing an archive of {} bytes, over the {MAX_ARCHIVE_BYTES} byte ceiling",
                declared.unwrap_or_default()
            ));
        }
        let mut body = Vec::new();
        response
            .into_reader()
            .take(MAX_ARCHIVE_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|e| format!("reading {current} failed: {e}"))?;
        if body.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err(format!("refusing an archive over the {MAX_ARCHIVE_BYTES} byte ceiling"));
        }
        return Ok(body);
    }
    Err(format!("{url} redirected more than {MAX_REDIRECTS} times"))
}

/// Resolve a `Location` against the URL it came from.
///
/// Relative locations are legal and GitHub's object store has used them, so a
/// naive "the location is the next URL" would turn `/path` into a refusal for
/// not being https. Anything that resolves is still re-checked by the caller.
fn resolve_redirect(from: &str, location: &str) -> Result<String, String> {
    if location.starts_with("http://") || location.starts_with("https://") {
        return Ok(location.to_string());
    }
    let origin_end = from["https://".len()..]
        .find('/')
        .map(|i| i + "https://".len())
        .unwrap_or(from.len());
    let origin = &from[..origin_end];
    if let Some(path) = location.strip_prefix('/') {
        return Ok(format!("{origin}/{path}"));
    }
    let base = from.rfind('/').map(|i| &from[..i]).unwrap_or(origin);
    Ok(format!("{base}/{location}"))
}

/// The archive's checksum against the one the registry published.
///
/// Returns whether a check happened, so "verified" and "there was nothing to
/// verify against" stay two answers rather than one silent success.
fn verify_checksum(bytes: &[u8], expected: Option<&str>) -> Result<bool, String> {
    let Some(expected) = expected else { return Ok(false) };
    let actual: String =
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(true)
    } else {
        Err(format!(
            "checksum mismatch, so nothing was unpacked. The registry published \
             {expected} and the download hashes to {actual}"
        ))
    }
}

// --- extraction ---

/// The archive formats the registry's darwin builds actually use.
///
/// Measured 2026-08-14 across the 17 binary agents: 13 `tar.gz`, 3 `zip`, 1
/// `tar.bz2`. Anything else is named and refused rather than guessed at, because
/// a format sniffed wrong is an archive written somewhere by accident.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    TarGz,
    TarBz2,
    Zip,
}

fn format_of(url: &str) -> Result<Format, String> {
    let path = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        Ok(Format::TarGz)
    } else if path.ends_with(".tar.bz2") || path.ends_with(".tbz2") {
        Ok(Format::TarBz2)
    } else if path.ends_with(".zip") {
        Ok(Format::Zip)
    } else {
        Err(format!(
            "Sway cannot unpack {url}: it is not a .tar.gz, .tar.bz2 or .zip archive"
        ))
    }
}

/// Decide where one archive entry may be written, or refuse it.
///
/// Two refusals with two reasons, because they are two different attacks. A path
/// that resolves outside `root` is an archive writing where it likes; a symlink
/// is an archive arranging for a *later* write to go somewhere else, which a
/// per-entry path check would never see. `ensure_inside_named` is what does the
/// resolving, and it is used rather than a `starts_with` because a lexically
/// clean path under a symlinked ancestor still escapes.
fn destination(root: &Path, entry_path: &Path, is_link: bool) -> Result<PathBuf, String> {
    let shown = entry_path.display().to_string();
    if is_link {
        return Err(format!(
            "refusing {shown}: the archive contains a link, and Sway unpacks files only"
        ));
    }
    if entry_path.is_absolute() {
        return Err(format!("refusing {shown}: an absolute path in an archive"));
    }
    let target = root.join(entry_path);
    let root_str = root.to_str().ok_or("the install directory is not valid UTF-8")?;
    let target_str = target.to_str().ok_or_else(|| format!("{shown} is not valid UTF-8"))?;
    // The gotcha this obeys: the returned path is the caller's unresolved one.
    // Containment is the answer being asked for, and rewriting the path would
    // relocate every install under `/private` on macOS.
    crate::fs::ensure_inside_named(root_str, target_str, "install directory")
        .map(|_| target)
        .map_err(|e| format!("refusing {shown}: {e}"))
}

/// Write one entry's bytes, creating the directories above it.
fn write_entry(dest: &Path, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(dest, bytes).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        // Owner read/write, plus the execute bit only when the archive set one.
        // Group and world are dropped rather than passed through: a
        // world-writable entry in somebody else's archive would be a binary
        // anyone on the machine can replace between installing it and running
        // it. The execute bit is kept because a package can carry more than one
        // executable, and only the entry point is chmod'd by name later.
        let owner_only = 0o600 | (mode & 0o100);
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(owner_only));
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

fn extract_tar<R: std::io::Read>(reader: R, root: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    for entry in archive.entries().map_err(|e| format!("unreadable archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("unreadable archive entry: {e}"))?;
        let kind = entry.header().entry_type();
        let path = entry
            .path()
            .map_err(|e| format!("unreadable archive entry path: {e}"))?
            .into_owned();
        if kind.is_dir() {
            destination(root, &path, false)?;
            continue;
        }
        // Everything that is not a plain file is refused, and the link case gets
        // its own sentence: a tar can legally carry device and fifo entries too,
        // and a refusal that misdescribes what it refused is a refusal nobody
        // can act on.
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(destination(root, &path, true).unwrap_err());
        }
        if !kind.is_file() {
            return Err(format!(
                "refusing {}: the archive contains an entry that is not a file",
                path.display()
            ));
        }
        let dest = destination(root, &path, false)?;
        let mode = entry.header().mode().ok();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| format!("unreadable archive entry: {e}"))?;
        write_entry(&dest, &bytes, mode)?;
    }
    Ok(())
}

fn extract_zip(bytes: &[u8], root: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("unreadable archive: {e}"))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("unreadable archive entry: {e}"))?;
        let path = PathBuf::from(file.name());
        if file.is_dir() {
            destination(root, &path, false)?;
            continue;
        }
        // Zip encodes a symlink in the unix mode bits of the external
        // attributes, so the type has to be read there rather than from a
        // per-entry flag.
        let mode = file.unix_mode();
        let is_link = mode.is_some_and(|m| m & 0o170000 == 0o120000);
        let dest = destination(root, &path, is_link)?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| format!("unreadable archive entry: {e}"))?;
        write_entry(&dest, &buf, mode)?;
    }
    Ok(())
}

fn extract(bytes: &[u8], format: Format, root: &Path) -> Result<(), String> {
    match format {
        Format::TarGz => extract_tar(flate2::read::GzDecoder::new(bytes), root),
        Format::TarBz2 => extract_tar(bzip2::read::BzDecoder::new(bytes), root),
        Format::Zip => extract_zip(bytes, root),
    }
}

// --- Gatekeeper ---

/// Whether macOS marked `path` as downloaded, and would therefore refuse to run
/// it unnotarized.
///
/// Read rather than assumed: a notarized binary that runs perfectly well is not
/// stripped, because stripping it would disable a check that was about to pass.
#[cfg(target_os = "macos")]
pub fn is_quarantined(path: &Path) -> bool {
    xattr::get(path, "com.apple.quarantine").is_ok_and(|v| v.is_some())
}

#[cfg(not(target_os = "macos"))]
pub fn is_quarantined(_path: &Path) -> bool {
    false
}

/// Clear `com.apple.quarantine`, and say so on stderr.
///
/// Only ever called with the user's explicit consent. The log line is not
/// decoration: this is the one step in an install that removes a protection the
/// operating system was applying, and an action like that leaves a trace.
#[cfg(target_os = "macos")]
fn clear_quarantine(path: &Path) -> Result<(), String> {
    xattr::remove(path, "com.apple.quarantine")
        .map_err(|e| format!("cannot clear the quarantine flag on {}: {e}", path.display()))?;
    eprintln!(
        "sway: cleared com.apple.quarantine on {} at the user's request, \
         so Gatekeeper will not check this binary",
        path.display()
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn clear_quarantine(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Whether to clear the quarantine flag: only when the user consented **and**
/// the flag is actually there.
///
/// Two conditions rather than one, because they refuse two different mistakes. A
/// notarized binary that would run perfectly well is not stripped, since
/// stripping it disables a check that was about to pass; and consent to a step
/// that never happened is not recorded as a step that did.
fn should_clear_quarantine(consented: bool, flagged: bool) -> bool {
    consented && flagged
}

// --- install and remove ---

/// The manifest file inside an installed agent's directory.
fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("sway-install.json")
}

/// What Sway installed for `id`, or `None`.
///
/// Reads the manifest rather than testing for the directory: a directory with no
/// manifest is not something Sway can claim to have installed, and removal
/// refuses to touch it.
pub fn installed_in(root: &Path, id: &str) -> Option<Installed> {
    let raw = std::fs::read_to_string(manifest_path(&root.join(sanitize_segment(id)))).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Install `entry`'s build for `platform` under `root`.
///
/// The pure core: it takes the root and the platform so a test can install into
/// a temp directory for an architecture the test machine is not, and so nothing
/// here reaches for the running user's Application Support.
///
/// `allow_quarantine_bypass` is the user's answer to a question the UI asked in
/// full. `false` installs anyway and leaves the flag on, which is a working
/// install of a binary macOS may refuse to start: the refusal is then macOS's,
/// visible, and reversible, which is a better place to be than silently past it.
pub fn install_into(
    root: &Path,
    entry: &crate::catalog::CatalogEntry,
    platform: &str,
    allow_quarantine_bypass: bool,
) -> Result<Installed, String> {
    let build = match crate::catalog::build_for(entry, Some(platform)) {
        crate::catalog::HostBuild::Ready(b) => b,
        crate::catalog::HostBuild::NoBuildHere => {
            return Err(format!(
                "{} publishes no build for {platform}, so there is nothing to install here",
                entry.label
            ))
        }
        crate::catalog::HostBuild::NotInstallable => {
            return Err(format!("{} is not an agent Sway can download", entry.label))
        }
    };

    let format = format_of(&build.archive)?;
    let bytes = download(&build.archive)?;
    // Before extraction, deliberately: a mismatched archive is never unpacked,
    // so a failed check leaves nothing on disk to clean up or to run by accident.
    let verified = verify_checksum(&bytes, build.sha256.as_deref())?;

    let dir = root.join(sanitize_segment(&entry.id));
    // A fresh directory every time, so an install never merges with the remains
    // of an older one and inherits a file the new archive does not carry.
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("cannot replace {}: {e}", dir.display()))?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // `0700` on the root as well as the leaf, and before anything is written
    // into it: an agent binary that arrives world-writable is a binary anyone on
    // the machine can replace between installing it and running it.
    restrict_to_owner(root)?;
    restrict_to_owner(&dir)?;

    if let Err(e) = extract(&bytes, format, &dir) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }

    // The registry writes the command as a path inside the archive
    // (`./dist-package/cursor-agent`), so it is resolved the same way every other
    // entry was, which is also what stops a `cmd` of `../../bin/sh`.
    let relative = PathBuf::from(build.cmd.trim_start_matches("./").replace('\\', "/"));
    let program = destination(&dir, &relative, false)?;
    if !program.is_file() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!(
            "the archive does not contain {}, which is the command the registry named",
            build.cmd
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("cannot make {} executable: {e}", program.display()))?;
    }

    let quarantine_cleared =
        should_clear_quarantine(allow_quarantine_bypass, is_quarantined(&program));
    if quarantine_cleared {
        clear_quarantine(&program)?;
    }

    let installed = Installed {
        id: entry.id.clone(),
        registry_version: entry.registry_version.clone(),
        platform: platform.to_string(),
        archive: build.archive.clone(),
        sha256: verified.then(|| build.sha256.clone().unwrap_or_default()),
        program: program.to_string_lossy().into_owned(),
        args: build.args.clone(),
        env: build.env.clone(),
        quarantine_cleared,
        installed_at: now_secs(),
    };
    let manifest = serde_json::to_string_pretty(&installed)
        .map_err(|e| format!("cannot record the install: {e}"))?;
    std::fs::write(manifest_path(&dir), manifest)
        .map_err(|e| format!("cannot record the install: {e}"))?;
    Ok(installed)
}

/// Remove what Sway installed for `id` under `root`, and nothing else.
///
/// Refuses a directory with no manifest. The rule that matters: this deletes a
/// path Sway wrote inside its own data directory, and a user's own binary of the
/// same name is not reachable from here at all, because nothing in an install
/// ever recorded a path outside `root`.
pub fn remove_from(root: &Path, id: &str) -> Result<(), String> {
    let dir = root.join(sanitize_segment(id));
    if !dir.exists() {
        return Ok(());
    }
    if installed_in(root, id).is_none() {
        return Err(format!(
            "{} holds no record of a Sway install, so Sway will not delete it",
            dir.display()
        ));
    }
    let root_str = root.to_str().ok_or("the install directory is not valid UTF-8")?;
    let dir_str = dir.to_str().ok_or("the install directory is not valid UTF-8")?;
    crate::fs::ensure_inside_named(root_str, dir_str, "install directory")?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("cannot remove {}: {e}", dir.display()))
}

// --- commands: the thin wrappers ---

#[tauri::command]
pub fn installed_agents() -> Vec<Installed> {
    let root = install_root();
    let Ok(dir) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out: Vec<Installed> = dir
        .filter_map(|e| e.ok())
        .filter_map(|e| installed_in(&root, e.file_name().to_str()?))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Install the catalog entry called `id` for this machine.
///
/// `allow_quarantine_bypass` is collected before the call rather than raised
/// during it, so the consent is consent to a step the UI described in full, not
/// a dialog that appears halfway through something already running.
#[tauri::command]
pub fn install_agent(id: String, allow_quarantine_bypass: bool) -> Result<Installed, String> {
    let entry = crate::catalog::catalog()
        .entries
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("the catalog has no entry called {id}"))?;
    let platform = crate::catalog::host_platform()
        .ok_or("Sway does not know how the registry names this machine's platform")?;
    install_into(&install_root(), &entry, platform, allow_quarantine_bypass)
}

#[tauri::command]
pub fn remove_installed_agent(id: String) -> Result<(), String> {
    remove_from(&install_root(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{Build, CatalogEntry};

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sway-install-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry_with(builds: &[(&str, Build)]) -> CatalogEntry {
        CatalogEntry {
            id: "test-agent".into(),
            label: "Test Agent".into(),
            description: String::new(),
            registry_version: Some("1.0.0".into()),
            website: None,
            program: "test-agent".into(),
            args: vec!["acp".into()],
            needs: "install".into(),
            builds: builds.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            published_capabilities: None,
        }
    }

    fn build(archive: &str, sha256: Option<&str>) -> Build {
        Build {
            archive: archive.into(),
            sha256: sha256.map(str::to_string),
            cmd: "./test-agent".into(),
            args: vec!["acp".into()],
            env: BTreeMap::new(),
        }
    }

    fn gzip(tar: &[u8]) -> Vec<u8> {
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, tar).unwrap();
        encoder.finish().unwrap()
    }

    /// One tar entry, with `name` written straight into the header's own bytes.
    ///
    /// `tar::Builder` refuses to write a `..` path at all, which is a fine
    /// default and useless here: the archives worth defending against are the
    /// ones nobody built with this library. So the fixture writes the header
    /// itself, and the extractor meets the entry a hostile publisher would send.
    fn tar_entry(name: &str, kind: tar::EntryType, body: &[u8], link: Option<&str>) -> Vec<u8> {
        tar_entry_mode(name, kind, body, link, 0o755)
    }

    fn tar_entry_mode(
        name: &str,
        kind: tar::EntryType,
        body: &[u8],
        link: Option<&str>,
        mode: u32,
    ) -> Vec<u8> {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(mode);
        header.set_entry_type(kind);
        {
            let gnu = header.as_gnu_mut().expect("a gnu header");
            gnu.name[..name.len()].copy_from_slice(name.as_bytes());
            if let Some(target) = link {
                gnu.linkname[..target.len()].copy_from_slice(target.as_bytes());
            }
        }
        header.set_cksum();
        let mut out = header.as_bytes().to_vec();
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(512) * 512, 0);
        out
    }

    /// A `.tar.gz` built in memory, so the extraction tests never need the
    /// network. The two trailing zero blocks are the end-of-archive marker.
    fn tar_gz(entries: Vec<Vec<u8>>) -> Vec<u8> {
        let mut tar: Vec<u8> = entries.concat();
        tar.extend_from_slice(&[0u8; 1024]);
        gzip(&tar)
    }

    fn file_entry(name: &str, body: &[u8]) -> Vec<u8> {
        tar_entry(name, tar::EntryType::Regular, body, None)
    }

    /// **The trust model is written down where a user reads it, not only in this
    /// header.** The three claims that decide whether somebody should press the
    /// button are the ones asserted: that the checksum and the URL travel
    /// together, that this bounds transport tampering and not registry
    /// compromise, and that installing is trusting the registry. A doc can drift
    /// from the code it describes; this is what makes that drift fail a test.
    #[test]
    fn the_trust_model_is_stated_where_the_user_will_look() {
        // Whitespace-normalised, so a reflow of the paragraph is not a failure.
        // What must not change is the sentence.
        let doc: String = include_str!("../../ADAPTERS.md").split_whitespace().collect::<Vec<_>>().join(" ");
        for claim in [
            "Both sit in the same `agent.json`",
            "the checksum is a **transport control**",
            "proves nothing about who named them",
            "Installing an agent is trusting the registry",
            "over half of these downloads have no checksum at all",
            "nothing installed becomes a supported harness",
            "Removal deletes only what Sway installed",
        ] {
            let doc = doc.to_lowercase();
            let claim = claim.to_lowercase();
            assert!(doc.contains(&claim), "ADAPTERS.md no longer says: {claim}");
        }
    }

    // --- the download's two refusals ---

    /// **An https to http downgrade aborts.** The URL the user pressed was
    /// secure; a hop that leaves it plain hands the archive to the network, and
    /// following it silently is the whole exposure.
    #[test]
    fn a_redirect_off_https_is_refused_rather_than_followed() {
        let e = download("http://example.invalid/agent.tar.gz").unwrap_err();
        assert!(e.contains("not https"), "{e}");
        // And the same check is what a mid-chain hop meets, since every hop goes
        // through the head of the loop.
        assert_eq!(
            resolve_redirect("https://a.example/x/y", "http://b.example/z").unwrap(),
            "http://b.example/z",
            "the resolver reports the hop as it is; refusing it is the loop's job"
        );
    }

    /// A relative `Location` still resolves, because refusing one for "not being
    /// https" would be refusing a legal redirect for the wrong reason.
    #[test]
    fn a_relative_redirect_resolves_against_the_url_it_came_from() {
        assert_eq!(
            resolve_redirect("https://a.example/x/y", "/z").unwrap(),
            "https://a.example/z"
        );
        assert_eq!(
            resolve_redirect("https://a.example/x/y", "z").unwrap(),
            "https://a.example/x/z"
        );
        assert_eq!(
            resolve_redirect("https://a.example/x/y", "https://b.example/z").unwrap(),
            "https://b.example/z"
        );
    }

    /// **A checksum mismatch aborts, and says both hashes.** "Something went
    /// wrong" would leave a user unable to tell a corrupted download from a
    /// swapped one.
    #[test]
    fn a_checksum_mismatch_names_what_was_expected_and_what_arrived() {
        let published = "00".repeat(32);
        let e = verify_checksum(b"hello", Some(&published)).unwrap_err();
        assert!(e.contains("nothing was unpacked"), "{e}");
        assert!(e.contains(&published), "the published hash: {e}");
        assert!(
            e.contains("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"),
            "and the one that arrived: {e}"
        );
    }

    /// A matching checksum passes and reports that a check happened; a missing
    /// one passes and reports that none did. Two answers, because "unverified"
    /// is a fact the user is told rather than a quiet success.
    #[test]
    fn an_unpublished_checksum_is_not_the_same_answer_as_a_verified_one() {
        let sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_checksum(b"hello", Some(sha)).unwrap(), "verified");
        assert!(verify_checksum(b"hello", Some(&sha.to_uppercase())).unwrap(), "case-insensitive");
        assert!(!verify_checksum(b"hello", None).unwrap(), "nothing to verify against");
    }

    // --- containment ---

    /// **An entry resolving outside the target directory is rejected.** One
    /// `../../../` in an archive Sway did not build is a write anywhere the user
    /// can write.
    #[test]
    fn an_archive_entry_that_escapes_the_install_directory_is_rejected() {
        let root = tmp("escape");
        let dir = root.join("agent");
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = tar_gz(vec![file_entry("../../escaped", b"x")]);
        let e = extract(&bytes, Format::TarGz, &dir).unwrap_err();
        assert!(e.contains("escapes the install directory"), "{e}");
        assert!(!root.parent().unwrap().join("escaped").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_absolute_path_in_an_archive_is_rejected() {
        let root = tmp("absolute");
        let e = destination(&root, Path::new("/etc/passwd"), false).unwrap_err();
        assert!(e.contains("absolute path"), "{e}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **Symlinks are refused rather than followed.** A link is how an archive
    /// arranges for a *later* write to land somewhere else, which no per-entry
    /// path check would ever see.
    #[test]
    fn a_symlink_in_an_archive_is_refused_rather_than_created() {
        let root = tmp("symlink");
        let bytes =
            tar_gz(vec![tar_entry("link", tar::EntryType::Symlink, b"", Some("/etc/passwd"))]);
        let e = extract(&bytes, Format::TarGz, &root).unwrap_err();
        assert!(e.contains("contains a link"), "{e}");
        assert!(!root.join("link").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The containment check resolves the path rather than comparing it
    /// lexically, and hands back the caller's unresolved form. Both halves of
    /// `[[gotchas#ensure_inside returns the caller's unresolved path]]`: on macOS
    /// every temp dir is under the `/var` symlink, so a check that resolved and
    /// then returned the resolved path would relocate every install.
    #[test]
    fn containment_resolves_the_path_but_returns_the_one_it_was_given() {
        let root = tmp("resolve");
        let dest = destination(&root, Path::new("bin/agent"), false).unwrap();
        assert_eq!(dest, root.join("bin/agent"), "the caller's path, not the resolved one");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A tar can carry device and fifo entries. They are not files, so they are
    /// refused with a sentence that says what they are rather than the link one.
    #[test]
    fn an_archive_entry_that_is_not_a_file_is_refused_by_name() {
        let root = tmp("fifo");
        let bytes = tar_gz(vec![tar_entry("pipe", tar::EntryType::Fifo, b"", None)]);
        let e = extract(&bytes, Format::TarGz, &root).unwrap_err();
        assert!(e.contains("not a file"), "{e}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The three formats the registry's darwin builds use are recognised, and
    /// anything else is named rather than sniffed.
    #[test]
    fn only_the_measured_archive_formats_are_accepted() {
        assert_eq!(format_of("https://x/y.tar.gz").unwrap(), Format::TarGz);
        assert_eq!(format_of("https://x/y.tgz").unwrap(), Format::TarGz);
        assert_eq!(format_of("https://x/y.tar.bz2").unwrap(), Format::TarBz2);
        assert_eq!(format_of("https://x/y.zip").unwrap(), Format::Zip);
        assert_eq!(format_of("https://x/y.zip?token=1").unwrap(), Format::Zip);
        // Some registry entries point straight at a bare binary. Refused with a
        // sentence rather than unpacked as whatever it happens to look like.
        let e = format_of("https://x/sigit-linux-arm64").unwrap_err();
        assert!(e.contains("cannot unpack"), "{e}");
    }

    // --- install and remove, against a temp root ---

    /// The permissions rule, end to end: the directory is `0700`, the binary is
    /// executable, and nothing was written outside the root.
    #[test]
    fn an_install_is_owner_only_and_the_binary_is_executable() {
        let root = tmp("perms");
        let dir = root.join("agent");
        std::fs::create_dir_all(&dir).unwrap();
        extract(&tar_gz(vec![file_entry("test-agent", b"#!/bin/sh\n")]), Format::TarGz, &dir)
            .unwrap();
        restrict_to_owner(&dir).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "the agent directory is owner-only");
            let bin = std::fs::metadata(dir.join("test-agent")).unwrap().permissions().mode();
            assert_eq!(bin & 0o077, 0, "and the binary is not group or world readable");
            assert_ne!(bin & 0o100, 0, "and it is executable by its owner");
        }
        // A world-writable data file beside the binary loses the group and world
        // bits, and does not pick up an execute bit the archive never gave it.
        let data = tar_entry_mode("data", tar::EntryType::Regular, b"x", None, 0o666);
        extract(&tar_gz(vec![data]), Format::TarGz, &dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("data")).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "group and world are dropped");
            assert_eq!(mode & 0o111, 0, "and nothing became executable on the way in");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **An install is never placed on the user's PATH.** The recorded program
    /// is an absolute path under Sway's own data directory, and no directory
    /// Sway created is a PATH entry, so the only way this agent reaches a session
    /// is somebody writing the adapter TOML that names it.
    #[test]
    fn an_installed_agent_is_not_on_the_path() {
        let root = install_root();
        let path = std::env::var("PATH").unwrap_or_default();
        for dir in path.split(':') {
            assert!(
                !Path::new(dir).starts_with(&root),
                "{dir} is on PATH and inside the install root"
            );
        }
        assert!(root.ends_with("sway/installed-agents"), "{}", root.display());
    }

    /// **Removal deletes only what Sway installed.** The manifest is the record
    /// of that, and a directory without one is refused, which is what keeps a
    /// user's own binary that happens to sit under this root out of reach.
    #[test]
    fn removal_refuses_a_directory_sway_did_not_install() {
        let root = tmp("remove-foreign");
        let dir = root.join("cursor");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cursor-agent"), b"the user's own").unwrap();

        let e = remove_from(&root, "cursor").unwrap_err();
        assert!(e.contains("no record of a Sway install"), "{e}");
        assert!(dir.join("cursor-agent").exists(), "and it is still there");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// And with a manifest, removal takes the directory and returns the entry to
    /// not-installed, without a second call being an error.
    #[test]
    fn removal_takes_the_install_and_leaves_no_trace_of_it() {
        let root = tmp("remove");
        let dir = root.join("test-agent");
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = Installed {
            id: "test-agent".into(),
            registry_version: None,
            platform: "darwin-aarch64".into(),
            archive: "https://x/y.tar.gz".into(),
            sha256: None,
            program: dir.join("test-agent").to_string_lossy().into_owned(),
            args: vec![],
            env: BTreeMap::new(),
            quarantine_cleared: false,
            installed_at: 1,
        };
        std::fs::write(manifest_path(&dir), serde_json::to_string(&manifest).unwrap()).unwrap();
        std::fs::write(dir.join("test-agent"), b"x").unwrap();

        assert!(installed_in(&root, "test-agent").is_some());
        remove_from(&root, "test-agent").unwrap();
        assert!(!dir.exists());
        assert!(installed_in(&root, "test-agent").is_none(), "back to not-installed");
        // Removing what is already gone is not an error, so a double press is a
        // no-op rather than a message about a directory nobody has.
        remove_from(&root, "test-agent").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An entry with no build for this machine refuses before touching the
    /// network, and names the platform it means.
    #[test]
    fn an_agent_with_no_build_for_this_platform_is_not_installed() {
        let root = tmp("no-build");
        let entry = entry_with(&[("darwin-aarch64", build("https://x/y.tar.gz", None))]);
        let e = install_into(&root, &entry, "darwin-x86_64", false).unwrap_err();
        assert!(e.contains("no build for darwin-x86_64"), "{e}");
        assert!(!root.join("test-agent").exists(), "and nothing was created");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **The whole path, against the real registry, once per archive format.**
    /// Redirect policy, checksum, extraction, permissions, manifest and removal,
    /// on archives nobody in this repo built. One agent per format the registry
    /// actually ships for darwin, because the three decompressors are three
    /// separate pieces of code and a fixture only proves the tar one.
    ///
    /// `#[ignore]` because it downloads about 150 MB: a test that needs the
    /// network is not one that runs on every save, and everything that can be
    /// pinned without it is pinned above. Run it after touching the download or
    /// extraction path:
    /// `cargo test --lib -- --ignored the_whole_install_path`.
    #[test]
    #[ignore]
    fn the_whole_install_path_works_against_a_real_registry_archive() {
        // tar.gz, zip, tar.bz2. `opencode` is covered by an adapter and so never
        // offered in the UI; it is here because it is the registry's zip.
        for id in ["amp-acp", "opencode", "goose"] {
            let root = tmp(&format!("end-to-end-{id}"));
            let entry = crate::catalog::catalog()
                .entries
                .into_iter()
                .find(|e| e.id == id)
                .unwrap_or_else(|| panic!("the registry lists {id}"));

            let it = install_into(&root, &entry, "darwin-aarch64", false)
                .unwrap_or_else(|e| panic!("{id}: {e}"));
            assert!(Path::new(&it.program).is_file(), "{id}: {}", it.program);
            assert!(it.sha256.is_some(), "{id} publishes one, so it was checked");
            assert!(it.program.starts_with(root.to_str().unwrap()), "{id}: inside the root");

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&it.program).unwrap().permissions().mode();
                assert_ne!(mode & 0o100, 0, "{id}: executable");
                assert_eq!(mode & 0o077, 0, "{id}: and owner-only");
            }
            assert_eq!(installed_in(&root, id).as_ref(), Some(&it));

            remove_from(&root, id).unwrap();
            assert!(installed_in(&root, id).is_none(), "{id}: back to not-installed");
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    /// **The Gatekeeper bypass is an explicit, informed choice, and it is also
    /// not taken when there is nothing to take.** Consent alone strips nothing:
    /// a binary that is not quarantined runs as it is, and stripping it would
    /// disable a check that was about to pass. Consent is also necessary, so the
    /// flag never comes off on its own.
    #[test]
    fn the_quarantine_flag_comes_off_only_when_asked_for_and_only_when_it_is_there() {
        assert!(should_clear_quarantine(true, true), "asked for, and there to clear");
        assert!(!should_clear_quarantine(true, false), "asked for, but nothing to clear");
        assert!(!should_clear_quarantine(false, true), "there, but nobody asked");
        assert!(!should_clear_quarantine(false, false));
    }

    /// And a file Sway wrote itself carries no quarantine flag, which is what
    /// makes the second condition above mean something on this platform.
    #[test]
    fn a_file_sway_wrote_is_not_treated_as_a_download() {
        let root = tmp("quarantine");
        let file = root.join("agent");
        std::fs::write(&file, b"x").unwrap();
        assert!(!is_quarantined(&file));
        let _ = std::fs::remove_dir_all(&root);
    }
}
