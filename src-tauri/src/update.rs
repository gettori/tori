// Every build is signed with the Developer ID and notarized, so an update is
// trusted the way Apple trusts it: it must verify, carry our team id and pass
// Gatekeeper. That spares a second signing key and a manifest to publish.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

const RELEASES_API: &str = "https://api.github.com/repos/gettori/tori/releases";
const PAGE: usize = 30;
const PAGES: u32 = 5;
const RELEASES_PAGE: &str = "https://github.com/gettori/tori/releases";

const TEAM_ID: &str = "C328TXY8Q3";

const ASSET_ARCH: &str = if cfg!(target_arch = "aarch64") {
    "aarch64"
} else {
    "x64"
};

const PROGRESS_EVENT: &str = "update://progress";

static FOUND: Mutex<Option<Found>> = Mutex::new(None);

static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Gap after a check that actually reached GitHub.
const CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// Gap after a check that failed (offline, rate-limited, GitHub down).
///
/// Shorter than the success interval: launching while offline is ordinary - a
/// laptop opened before the wifi connects - and should not cost the whole
/// interval of silence.
const RETRY_INTERVAL_SECS: u64 = 60 * 60;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// The newer version, without the `v` prefix.
    pub version: String,
    /// `None` when this copy can replace itself; otherwise why not, for the pill
    /// to say instead of offering Install.
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Found {
    tag: String,
    version: String,
    url: String,
    #[serde(default)]
    size: u64,
}

impl Found {
    fn info(&self) -> UpdateInfo {
        UpdateInfo {
            version: self.version.clone(),
            blocked: replaceable_bundle().err(),
        }
    }
}

/// Open the found release's page in the user's browser, or the releases list
/// when no check in this process has found one.
///
/// Deliberately not a general `open_url(url)` command: the frontend hands in
/// no URL, the backend builds it from a tag GitHub returned, so the frontend
/// cannot be talked into opening something arbitrary. Matches `launch.rs`'s
/// "spawn the real tool" convention.
#[tauri::command(async)]
pub fn open_releases_page() -> Result<(), String> {
    let found = FOUND.lock().ok().and_then(|f| f.as_ref().map(|f| f.tag.clone()));
    let url = found.map_or_else(|| RELEASES_PAGE.to_string(), |tag| format!("{RELEASES_PAGE}/tag/{tag}"));
    crate::exec::spawn_detached(Command::new("open").arg(url)).map_err(|e| e.to_string())
}

/// Start this app's bundle again and quit this process.
///
/// The new instance is opened only once this pid is gone. `open -n` straight
/// away would run two Tori processes over one config dir and RPC socket for
/// as long as this one takes to shut down.
#[tauri::command]
pub fn relaunch(app: tauri::AppHandle) -> Result<(), String> {
    let bundle = running_bundle().unwrap_or_else(|| PathBuf::from("/Applications/Tori.app"));
    crate::exec::spawn_detached(
        Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec open "$2""#)
            .arg("sh")
            .arg(std::process::id().to_string())
            .arg(&bundle),
    )
    .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

/// The `.app` folder the running binary sits in, or `None` outside a bundle
/// (a dev build runs from `target/`).
fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

fn replaceable_bundle() -> Result<PathBuf, String> {
    let bundle = running_bundle()
        .filter(|_| !cfg!(debug_assertions))
        .ok_or_else(|| "A dev build does not update itself.".to_string())?;
    may_replace(&bundle)?;
    Ok(bundle)
}

// macOS runs an app opened straight from a DMG or a quarantined download from
// a read-only translocated copy, which an update could never replace.
fn may_replace(bundle: &Path) -> Result<(), String> {
    let path = bundle.to_string_lossy();
    if path.contains("/AppTranslocation/") || path.starts_with("/Volumes/") {
        return Err("Move Tori to Applications to update it in place.".to_string());
    }
    let dir = bundle.parent().ok_or_else(|| "Tori is not in a folder.".to_string())?;
    if !writable(dir) {
        return Err(format!("Tori cannot write to {}.", dir.display()));
    }
    Ok(())
}

fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a valid NUL-terminated path; access only reads it.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

/// Parse a semver-ish string into comparable parts, tolerating a `v` prefix and
/// any pre-release/build suffix (`1.2.3-beta.1` -> `[1,2,3]`).
///
/// Returns `None` for anything unparseable, and an unparseable version can
/// never produce an update notice: a garbage tag should be ignored, not
/// treated as newer than everything.
fn parse_semver(raw: &str) -> Option<[u64; 3]> {
    let cleaned = raw.trim().trim_start_matches('v');
    let core = cleaned.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    // Missing minor/patch default to 0, so "2" reads as 2.0.0.
    let minor = parts.next().map_or(Some(0), |p| p.parse().ok())?;
    let patch = parts.next().map_or(Some(0), |p| p.parse().ok())?;
    Some([major, minor, patch])
}

/// Is `candidate` strictly newer than `current`? False whenever either side
/// fails to parse, so an odd tag is ignored rather than guessed at.
fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_semver(candidate), parse_semver(current)) {
        (Some(new), Some(old)) => new > old,
        _ => false,
    }
}

/// When the next check becomes due, and what the last one found. Storing the
/// *deadline* rather than the last-check time is what lets a failed check
/// schedule a short retry and a successful one the full interval.
#[derive(Serialize, Deserialize, Default)]
struct Throttle {
    next_check_secs: u64,
    #[serde(default)]
    found: Option<Found>,
}

fn throttle_path() -> PathBuf {
    crate::owned_state::config_dir().join("update-check.json")
}

fn read_throttle(path: &Path) -> Throttle {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Persist the next deadline and what was found. Best-effort: an unwritable
/// config dir degrades to checking once per launch.
fn write_throttle(path: &Path, interval: u64, found: Option<&Found>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let throttle = Throttle {
        next_check_secs: now_secs().saturating_add(interval),
        found: found.cloned(),
    };
    if let Ok(json) = serde_json::to_string(&throttle) {
        let _ = std::fs::write(path, json);
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Is a check due at `now`, given a stored deadline of `next`?
///
/// A deadline further out than the longest interval we would ever schedule
/// means the clock jumped backwards (or the file was hand-edited), so treat it
/// as due rather than wedging checks until the wall clock catches up.
fn is_due(next: u64, now: u64) -> bool {
    now >= next || next > now.saturating_add(CHECK_INTERVAL_SECS)
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

// Releases were tagged `v<version>` before each platform got its own prefix.
fn macos_version(tag: &str) -> Option<&str> {
    let tag = tag.trim();
    tag.strip_prefix("macos-v").or_else(|| tag.strip_prefix('v'))
}

fn found_in(release: &GithubRelease, current: &str, arch: &str) -> Option<Found> {
    let version = macos_version(&release.tag_name)?;
    if !is_newer(version, current) {
        return None;
    }
    let name = format!("Tori_{version}_{arch}.app.tar.gz");
    let asset = release.assets.iter().find(|a| a.name == name)?;
    Some(Found {
        tag: release.tag_name.clone(),
        version: version.to_string(),
        url: asset.browser_download_url.clone(),
        size: asset.size,
    })
}

fn newest(releases: &[GithubRelease], current: &str, arch: &str) -> Option<Found> {
    releases
        .iter()
        .filter_map(|release| found_in(release, current, arch))
        .max_by_key(|found| parse_semver(&found.version))
}

// GitHub lists newest first, so the first page with a macOS tag holds the
// newest macOS release.
fn fetch_releases() -> Option<Vec<GithubRelease>> {
    let mut releases = Vec::new();
    for page in 1..=PAGES {
        let mut response = ureq::get(format!("{RELEASES_API}?per_page={PAGE}&page={page}"))
            .header("User-Agent", "tori-update-check")
            .header("Accept", "application/vnd.github+json")
            .config()
            .timeout_global(Some(Duration::from_secs(10)))
            .build()
            .call()
            .ok()?;
        let mut got: Vec<GithubRelease> = response.body_mut().read_json().ok()?;
        let last = got.len() < PAGE || got.iter().any(|r| macos_version(&r.tag_name).is_some());
        releases.append(&mut got);
        if last {
            break;
        }
    }
    Some(releases)
}

fn remember(found: Option<Found>) -> Option<Found> {
    if let Ok(mut held) = FOUND.lock() {
        *held = found.clone();
    }
    found
}

/// Check for a newer release, or return `None`.
///
/// `None` covers every uninteresting case identically - up to date, offline,
/// rate-limited, malformed response - because the frontend's response to all
/// of them is the same: show nothing. A throttled call answers what the last
/// check found, so a known update never disappears on a relaunch.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Option<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let path = throttle_path();
    let held = read_throttle(&path);
    let still_newer = |found: Option<Found>| found.filter(|f| is_newer(&f.version, &current));
    if !is_due(held.next_check_secs, now_secs()) {
        return remember(still_newer(held.found)).map(|f| f.info());
    }
    // Schedule the *failure* retry before the request goes out, so a crash or
    // a hang mid-check still leaves a deadline behind and cannot turn into a
    // request on every launch. A success upgrades it to the full interval below.
    write_throttle(&path, RETRY_INTERVAL_SECS, held.found.as_ref());
    match fetch_releases() {
        None => remember(still_newer(held.found)).map(|f| f.info()),
        Some(releases) => {
            let found = newest(&releases, &current, ASSET_ARCH);
            write_throttle(&path, CHECK_INTERVAL_SECS, found.as_ref());
            remember(found).map(|f| f.info())
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ManualCheck {
    Newer(UpdateInfo),
    Current,
    Failed,
}

/// Check now, past the throttle. A check that reaches GitHub still pushes the
/// background one out, since it has nothing left to tell.
#[tauri::command]
pub async fn check_for_update_now(app: tauri::AppHandle) -> ManualCheck {
    let current = app.package_info().version.to_string();
    let Some(releases) = fetch_releases() else {
        return ManualCheck::Failed;
    };
    let found = newest(&releases, &current, ASSET_ARCH);
    write_throttle(&throttle_path(), CHECK_INTERVAL_SECS, found.as_ref());
    match remember(found) {
        Some(found) => ManualCheck::Newer(found.info()),
        None => ManualCheck::Current,
    }
}

#[derive(Clone, Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

/// Download the found update, verify it, and put it in place of the running
/// bundle. The running process keeps its own files open, so it carries on
/// until the user restarts; the daemon follows once no session is working.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let found = FOUND
        .lock()
        .ok()
        .and_then(|f| f.clone())
        .ok_or_else(|| "No update to install.".to_string())?;
    let bundle = replaceable_bundle()?;
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("An update is already installing.".to_string());
    }
    let done = crate::exec::blocking("install_update", move || {
        let mut last = 0;
        install(&found.url, found.size, &found.version, &bundle, |received, total| {
            let percent = received * 100 / total.max(1);
            if percent != last {
                last = percent;
                let _ = app.emit(PROGRESS_EVENT, Progress { received, total });
            }
        })
    })
    .await;
    INSTALLING.store(false, Ordering::SeqCst);
    done
}

fn install(url: &str, size: u64, version: &str, bundle: &Path, progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let dir = bundle.parent().ok_or_else(|| "Tori is not in a folder.".to_string())?;
    // Beside the bundle, so the swap is a rename on one volume.
    let staging = dir.join(format!(".Tori-update-{version}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("could not stage the update: {e}"))?;
    let result = (|| {
        let tarball = staging.join("Tori.app.tar.gz");
        download(url, size, &tarball, progress)?;
        run(Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(&tarball)
            .arg("-C")
            .arg(&staging))?;
        let new_app = staging.join("Tori.app");
        verify(&new_app, version)?;
        swap(bundle, &new_app, &staging.join("Tori.app.old"))
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn download(url: &str, size: u64, to: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let mut response = ureq::get(url)
        .header("User-Agent", "tori-update")
        .config()
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .timeout_recv_body(Some(Duration::from_secs(30 * 60)))
        .build()
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(size);
    let mut reader = response.body_mut().as_reader();
    let mut file = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let mut buf = vec![0; 64 * 1024];
    let mut received = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        progress(received, total);
    }
    if total > 0 && received != total {
        return Err(format!("download stopped at {received} of {total} bytes"));
    }
    Ok(())
}

fn verify(app: &Path, version: &str) -> Result<(), String> {
    run(Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app))
    .map_err(|e| format!("the update's signature does not verify: {e}"))?;
    let shown = Command::new("/usr/bin/codesign")
        .arg("-dv")
        .arg(app)
        .output()
        .map_err(|e| e.to_string())?;
    let team = team_of(&String::from_utf8_lossy(&shown.stderr)).map(str::to_string);
    if team.as_deref() != Some(TEAM_ID) {
        return Err(format!(
            "the update is signed by {}, not Tori's team",
            team.as_deref().unwrap_or("nobody")
        ));
    }
    run(Command::new("/usr/sbin/spctl")
        .args(["--assess", "--type", "execute"])
        .arg(app))
    .map_err(|e| format!("Gatekeeper refuses the update: {e}"))?;
    let plist = app.join("Contents/Info.plist");
    let read = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
        .arg(&plist)
        .output()
        .map_err(|e| e.to_string())?;
    let found = String::from_utf8_lossy(&read.stdout).trim().to_string();
    if found != version {
        return Err(format!("the update says it is {found}, not {version}"));
    }
    Ok(())
}

fn team_of(codesign_dv: &str) -> Option<&str> {
    codesign_dv
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|team| !team.is_empty() && *team != "not set")
}

fn swap(current: &Path, new: &Path, aside: &Path) -> Result<(), String> {
    std::fs::rename(current, aside).map_err(|e| format!("could not move the old Tori aside: {e}"))?;
    if let Err(e) = std::fs::rename(new, current) {
        return match std::fs::rename(aside, current) {
            Ok(()) => Err(format!("could not put the update in place: {e}")),
            Err(back) => Err(format!(
                "could not put the update in place ({e}), nor the old Tori back ({back}); it is at {}",
                aside.display()
            )),
        };
    }
    Ok(())
}

fn run(cmd: &mut Command) -> Result<(), String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    Err(said.lines().last().unwrap_or("failed").trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions_with_and_without_adornment() {
        assert_eq!(parse_semver("0.1.0"), Some([0, 1, 0]));
        assert_eq!(parse_semver("v1.2.3"), Some([1, 2, 3]));
        assert_eq!(parse_semver("v1.2.3-beta.1"), Some([1, 2, 3]));
        assert_eq!(parse_semver("2.0.0+build7"), Some([2, 0, 0]));
        assert_eq!(parse_semver(" v0.1.0 "), Some([0, 1, 0]));
        assert_eq!(parse_semver("2"), Some([2, 0, 0]));
        assert_eq!(parse_semver("2.1"), Some([2, 1, 0]));
    }

    #[test]
    fn rejects_unparseable_versions() {
        assert_eq!(parse_semver("nightly"), None);
        assert_eq!(parse_semver(""), None);
        assert_eq!(parse_semver("v"), None);
        assert_eq!(parse_semver("1.x.3"), None);
    }

    #[test]
    fn only_a_strictly_greater_version_is_an_update() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("v0.1.1", "0.1.0"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        // The overwhelmingly common case: same version, no notice.
        assert!(!is_newer("v0.1.0", "0.1.0"));
        // Never advertise a downgrade.
        assert!(!is_newer("v0.1.0", "0.2.0"));
    }

    #[test]
    fn an_unparseable_tag_never_claims_to_be_newer() {
        assert!(!is_newer("nightly", "0.1.0"));
        assert!(!is_newer("v0.2.0", "not-a-version"));
    }

    #[test]
    fn double_digit_segments_compare_numerically_not_lexically() {
        // The classic string-compare bug: "0.10.0" < "0.9.0" as text.
        assert!(is_newer("v0.10.0", "0.9.0"));
        assert!(!is_newer("v0.9.0", "0.10.0"));
        assert!(is_newer("v1.0.0", "0.100.0"));
    }

    fn release(tag: &str, assets: &[&str]) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            assets: assets
                .iter()
                .map(|name| GithubAsset {
                    name: name.to_string(),
                    browser_download_url: format!("https://example.test/{name}"),
                    size: 7,
                })
                .collect(),
        }
    }

    #[test]
    fn a_newer_release_offers_this_macs_asset_and_only_that() {
        let latest = release(
            "v26.1030.0-beta",
            &[
                "Tori_26.1030.0-beta_aarch64.app.tar.gz",
                "Tori_26.1030.0-beta_x64.app.tar.gz",
                "Tori_26.1030.0-beta_aarch64.dmg",
            ],
        );
        let found = found_in(&latest, "26.1022.0-alpha", "x64").unwrap();
        assert_eq!(found.version, "26.1030.0-beta");
        assert_eq!(found.url, "https://example.test/Tori_26.1030.0-beta_x64.app.tar.gz");
        assert_eq!(
            found_in(&latest, "26.1030.0-beta", "x64"),
            None,
            "the same version is no update"
        );
    }

    #[test]
    fn a_tag_names_a_macos_release_with_or_without_the_prefix() {
        assert_eq!(macos_version("v26.1030.0-beta"), Some("26.1030.0-beta"));
        assert_eq!(macos_version("macos-v26.1101.0"), Some("26.1101.0"));
        assert_eq!(macos_version("android-v26.1101.0"), None);
        assert_eq!(macos_version("extension-v26.1101.0"), None);
    }

    #[test]
    fn the_newest_macos_release_wins_over_a_newer_release_of_another_platform() {
        let releases = [
            release("android-v26.1103.0", &["Tori_26.1103.0.apk"]),
            release("extension-v26.1103.0", &["tori-extension-26.1103.0.zip"]),
            release("v26.1030.0-beta", &["Tori_26.1030.0-beta_aarch64.app.tar.gz"]),
            release("macos-v26.1102.0", &["Tori_26.1102.0_aarch64.app.tar.gz"]),
        ];
        let found = newest(&releases, "26.1030.0-beta", "aarch64").unwrap();
        assert_eq!(found.tag, "macos-v26.1102.0");
        assert_eq!(found.version, "26.1102.0");
        assert_eq!(found.url, "https://example.test/Tori_26.1102.0_aarch64.app.tar.gz");
    }

    #[test]
    fn a_release_without_this_macs_asset_is_passed_over() {
        let releases = [
            release(
                "v26.1030.0-beta",
                &[
                    "Tori_26.1030.0-beta_aarch64.app.tar.gz",
                    "Tori_26.1030.0-beta_x64.app.tar.gz",
                ],
            ),
            release("macos-v26.1102.0", &["Tori_26.1102.0_aarch64.app.tar.gz"]),
        ];
        assert_eq!(
            newest(&releases, "26.1022.0-alpha", "x64").unwrap().tag,
            "v26.1030.0-beta"
        );
        assert_eq!(
            newest(&releases, "26.1022.0-alpha", "aarch64").unwrap().tag,
            "macos-v26.1102.0"
        );
        assert_eq!(newest(&releases, "26.1030.0-beta", "x64"), None);
    }

    #[test]
    fn the_team_comes_from_codesigns_description() {
        let dv = "Executable=/Applications/Tori.app/Contents/MacOS/tori\nIdentifier=app.gettori.tori\nTeamIdentifier=C328TXY8Q3\nSealed Resources version=2\n";
        assert_eq!(team_of(dv), Some(TEAM_ID));
        assert_eq!(team_of("Identifier=x\nTeamIdentifier=not set\n"), None);
        assert_eq!(team_of("Identifier=x\n"), None);
    }

    #[test]
    fn an_app_run_from_a_disk_image_or_translocated_cannot_replace_itself() {
        let refused = |p: &str| may_replace(Path::new(p)).is_err();
        assert!(refused("/Volumes/Tori/Tori.app"));
        assert!(refused("/private/var/folders/x/AppTranslocation/ABC/d/Tori.app"));
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-update-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_swap_puts_the_new_bundle_in_and_keeps_the_old_one_aside() {
        let dir = temp("swap");
        let (current, new, aside) = (dir.join("Tori.app"), dir.join("new/Tori.app"), dir.join("Tori.app.old"));
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("v"), "old").unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("v"), "new").unwrap();
        swap(&current, &new, &aside).unwrap();
        assert_eq!(std::fs::read_to_string(current.join("v")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(aside.join("v")).unwrap(), "old");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_swap_that_cannot_place_the_new_bundle_puts_the_old_one_back() {
        let dir = temp("rollback");
        let (current, aside) = (dir.join("Tori.app"), dir.join("Tori.app.old"));
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("v"), "old").unwrap();
        let missing = dir.join("never-unpacked/Tori.app");
        assert!(swap(&current, &missing, &aside).is_err());
        assert_eq!(std::fs::read_to_string(current.join("v")).unwrap(), "old");
        assert!(!aside.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn throttle_allows_the_first_check_then_blocks_until_the_deadline() {
        let now = 1_000_000;
        assert!(is_due(0, now));
        assert!(!is_due(now + 1, now));
        assert!(!is_due(now + CHECK_INTERVAL_SECS, now));
        assert!(is_due(now, now));
        assert!(is_due(now - 1, now));
    }

    #[test]
    fn a_failed_check_retries_sooner_than_a_successful_one() {
        let now = 1_000_000;
        assert!(is_due(now + RETRY_INTERVAL_SECS, now + RETRY_INTERVAL_SECS));
        assert!(!is_due(now + CHECK_INTERVAL_SECS, now + RETRY_INTERVAL_SECS));
        const {
            assert!(
                RETRY_INTERVAL_SECS < CHECK_INTERVAL_SECS,
                "a failure must never delay the next check longer than a success"
            )
        };
    }

    #[test]
    fn a_backwards_clock_does_not_wedge_the_check() {
        assert!(is_due(u64::MAX, 1_000_000));
        assert!(is_due(1_000_000 + CHECK_INTERVAL_SECS + 1, 1_000_000));
        assert!(!is_due(1_000_000 + CHECK_INTERVAL_SECS, 1_000_000));
    }

    #[test]
    fn a_found_update_outlives_the_throttle() {
        let dir = temp("throttle");
        let path = dir.join("update-check.json");
        let found = Found {
            tag: "v26.1030.0-beta".into(),
            version: "26.1030.0-beta".into(),
            url: "https://example.test/a".into(),
            size: 7,
        };
        write_throttle(&path, CHECK_INTERVAL_SECS, Some(&found));
        let held = read_throttle(&path);
        assert!(!is_due(held.next_check_secs, now_secs()));
        assert_eq!(held.found, Some(found));
        let old_file = dir.join("old.json");
        std::fs::write(&old_file, r#"{"next_check_secs":5}"#).unwrap();
        assert_eq!(
            read_throttle(&old_file).next_check_secs,
            5,
            "a file from before reads with nothing found"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
