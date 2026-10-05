// Update check: is there a newer release than the running build?
//
// Check-only, by design. Tori ships unsigned, so replacing the bundle in place
// would re-trigger quarantine and the user would have to walk the Gatekeeper
// steps again anyway - an auto-updater would buy nothing and could leave a
// half-replaced app. So this fetches a tag, compares it, and at most shows a
// notice linking to that release. When Homebrew owns the install the notice
// also offers `brew upgrade --cask tori`, run in a terminal tab the user
// watches; the cask clears quarantine, which is what makes that one safe.
//
// Three rules keep it from becoming a nuisance:
//
// 1. Throttled to once a day, persisted, so relaunching all morning does not
//    hammer the API (unauthenticated GitHub allows 60 requests/hour/IP).
// 2. Silent on failure. Offline, rate-limited, DNS down, GitHub 500 - all
//    produce no update and no error surface. A user who cannot reach GitHub
//    has nothing to act on.
// 3. Never downgrades or nags sideways: only a strictly greater semver counts.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// The list rather than `/releases/latest`, which never returns a prerelease:
// while every release is an alpha, that endpoint has nothing to say.
const RELEASES_API: &str = "https://api.github.com/repos/gettori/tori/releases?per_page=10";
const RELEASES_PAGE: &str = "https://github.com/gettori/tori/releases";

/// Where the cask lives on Apple Silicon and on Intel.
const CASKROOMS: [&str; 2] = ["/opt/homebrew/Caskroom/tori", "/usr/local/Caskroom/tori"];

/// The tag the last successful check found, for the pill's click to open.
static FOUND_TAG: Mutex<Option<String>> = Mutex::new(None);

/// Gap after a check that actually reached GitHub.
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Gap after a check that failed (offline, rate-limited, GitHub down).
///
/// Deliberately much shorter than the success interval. Launching while
/// offline is ordinary - a laptop opened before the wifi connects - and
/// charging that a full day of silence would mean a user who is briefly
/// offline each morning never gets told about a release at all. An hour is
/// still far too sparse to hammer anyone during an outage.
const RETRY_INTERVAL_SECS: u64 = 60 * 60;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// The newer version, without the `v` prefix.
    pub version: String,
    /// Homebrew owns this install, so `brew upgrade --cask tori` can update it.
    pub brew: bool,
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
    let found = FOUND_TAG.lock().ok().and_then(|t| t.clone());
    let url = found.map_or_else(|| RELEASES_PAGE.to_string(), |tag| format!("{RELEASES_PAGE}/tag/{tag}"));
    crate::exec::spawn_detached(std::process::Command::new("open").arg(url)).map_err(|e| e.to_string())
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
        std::process::Command::new("/bin/sh")
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

/// `brew` on the login PATH and a Caskroom folder for tori: the same rule
/// agent health uses to call a tool installed, plus proof the cask is what
/// put this copy here rather than a hand-dragged download.
fn brew_owns_install() -> bool {
    CASKROOMS.iter().any(|p| Path::new(p).is_dir()) && crate::env::resolve_binary("brew").is_some()
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

/// When the next check becomes due. Storing the *deadline* rather than the
/// last-check time is what lets a failed check schedule a short retry and a
/// successful one schedule a full day, without a second field recording which
/// kind it was.
#[derive(Serialize, Deserialize, Default)]
struct Throttle {
    next_check_secs: u64,
}

fn throttle_path() -> std::path::PathBuf {
    crate::owned_state::config_dir().join("update-check.json")
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
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// Does the running version carry a stage suffix (`26.1002.1-alpha`)?
fn is_prerelease(version: &str) -> bool {
    version
        .trim()
        .trim_start_matches('v')
        .split('+')
        .next()
        .is_some_and(|core| core.contains('-'))
}

/// The newest tag strictly newer than `current`, skipping drafts, and skipping
/// prereleases unless `current` is one: an alpha hears about the next alpha, a
/// stable build only about stable ones. On a tie the earlier entry wins, which
/// is the more recently published one in GitHub's ordering.
fn pick_update(releases: &[GithubRelease], current: &str) -> Option<String> {
    let allow_pre = is_prerelease(current);
    releases
        .iter()
        .filter(|r| !r.draft && (allow_pre || !r.prerelease) && is_newer(&r.tag_name, current))
        .fold(None::<&GithubRelease>, |best, r| match best {
            Some(b) if !is_newer(&r.tag_name, &b.tag_name) => Some(b),
            _ => Some(r),
        })
        .map(|r| r.tag_name.clone())
}

fn fetch_releases() -> Option<Vec<GithubRelease>> {
    let response = ureq::get(RELEASES_API)
        .set("User-Agent", "tori-update-check")
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .ok()?;
    response.into_json().ok()
}

/// Check for a newer release, or return `None`.
///
/// `None` covers every uninteresting case identically - up to date, throttled,
/// offline, rate-limited, malformed response - because the frontend's response
/// to all of them is the same: show nothing.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Option<UpdateInfo> {
    let path = throttle_path();
    let next = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Throttle>(&t).ok())
        .map(|t| t.next_check_secs)
        .unwrap_or(0);

    if !is_due(next, now_secs()) {
        return None;
    }

    // Schedule the *failure* retry before the request goes out, so a crash or
    // a hang mid-check still leaves a deadline behind and cannot turn into a
    // request on every launch. A success upgrades it to the full day below.
    write_deadline(&path, RETRY_INTERVAL_SECS);

    let current = app.package_info().version.to_string();
    let releases = fetch_releases()?;
    write_deadline(&path, CHECK_INTERVAL_SECS);

    let tag = pick_update(&releases, &current)?;
    let version = tag.trim_start_matches('v').to_string();
    if let Ok(mut found) = FOUND_TAG.lock() {
        *found = Some(tag);
    }
    Some(UpdateInfo {
        version,
        brew: brew_owns_install(),
    })
}

/// Persist "do not check again until `now + interval`". Best-effort: an
/// unwritable config dir degrades to checking once per launch, which is
/// noisier than intended but never a failure the user should see.
fn write_deadline(path: &std::path::Path, interval: u64) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let next = now_secs().saturating_add(interval);
    if let Ok(json) = serde_json::to_string(&Throttle { next_check_secs: next }) {
        let _ = std::fs::write(path, json);
    }
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

    fn release(tag: &str, prerelease: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            draft: false,
            prerelease,
        }
    }

    #[test]
    fn an_alpha_hears_of_the_next_alpha_and_a_stable_build_only_of_stable() {
        let list = [
            release("v26.1010.0-alpha", true),
            release("v26.1005.0", false),
            release("v26.1002.1-alpha", true),
        ];
        assert_eq!(pick_update(&list, "26.1002.1-alpha"), Some("v26.1010.0-alpha".into()));
        assert_eq!(pick_update(&list, "26.1001.0"), Some("v26.1005.0".into()));
        assert_eq!(pick_update(&list, "26.1005.0"), None);
    }

    #[test]
    fn the_pick_skips_drafts_and_takes_the_highest_version_not_the_first() {
        let mut draft = release("v27.0.0-alpha", true);
        draft.draft = true;
        let list = [
            draft,
            release("v26.1003.0-alpha", true),
            release("v26.1004.0-alpha", true),
        ];
        assert_eq!(pick_update(&list, "26.1002.1-alpha"), Some("v26.1004.0-alpha".into()));
        assert_eq!(pick_update(&[], "26.1002.1-alpha"), None);
    }

    #[test]
    fn a_build_suffix_alone_is_not_a_prerelease() {
        assert!(is_prerelease("26.1002.1-alpha"));
        assert!(is_prerelease("v1.0.0-rc.1+build7"));
        assert!(!is_prerelease("27.101.0"));
        assert!(!is_prerelease("1.0.0+build-7"));
    }

    #[test]
    fn throttle_allows_the_first_check_then_blocks_until_the_deadline() {
        let now = 1_000_000;
        // No deadline stored yet: never checked.
        assert!(is_due(0, now));
        // Deadline still ahead.
        assert!(!is_due(now + 1, now));
        assert!(!is_due(now + CHECK_INTERVAL_SECS, now));
        // Deadline reached.
        assert!(is_due(now, now));
        assert!(is_due(now - 1, now));
    }

    #[test]
    fn a_failed_check_retries_sooner_than_a_successful_one() {
        let now = 1_000_000;
        // The deadline a failure writes has passed an hour later...
        assert!(is_due(now + RETRY_INTERVAL_SECS, now + RETRY_INTERVAL_SECS));
        // ...while the one a success writes has not.
        assert!(!is_due(now + CHECK_INTERVAL_SECS, now + RETRY_INTERVAL_SECS));
        assert!(
            RETRY_INTERVAL_SECS < CHECK_INTERVAL_SECS,
            "a failure must never delay the next check longer than a success"
        );
    }

    #[test]
    fn a_backwards_clock_does_not_wedge_the_check() {
        // A deadline further out than any interval we would ever schedule means
        // the clock moved, not that a check is genuinely pending: due now,
        // rather than blocked until the wall clock catches up.
        assert!(is_due(u64::MAX, 1_000_000));
        assert!(is_due(1_000_000 + CHECK_INTERVAL_SECS + 1, 1_000_000));
        // A deadline inside the normal window is still honoured.
        assert!(!is_due(1_000_000 + CHECK_INTERVAL_SECS, 1_000_000));
    }
}
