// Update check: is there a newer release than the running build?
//
// Check-only, by design. Tori ships unsigned, so replacing the bundle in place
// would re-trigger quarantine and the user would have to walk the Gatekeeper
// steps again anyway - an auto-updater would buy nothing and could leave a
// half-replaced app. So this fetches a tag, compares it, and at most shows a
// notice linking to the releases page.
//
// Three rules keep it from becoming a nuisance:
//
// 1. Throttled to once a day, persisted, so relaunching all morning does not
//    hammer the API (unauthenticated GitHub allows 60 requests/hour/IP).
// 2. Silent on failure. Offline, rate-limited, DNS down, GitHub 500 - all
//    produce no update and no error surface. A user who cannot reach GitHub
//    has nothing to act on.
// 3. Never downgrades or nags sideways: only a strictly greater semver counts.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const RELEASES_API: &str = "https://api.github.com/repos/gettori/tori/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/gettori/tori/releases/latest";

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
}

/// Open the releases page in the user's browser.
///
/// Deliberately not a general `open_url(url)` command: the destination is a
/// constant here, so the frontend cannot be talked into opening something
/// arbitrary. Matches `launch.rs`'s "spawn the real tool" convention.
#[tauri::command(async)]
pub fn open_releases_page() -> Result<(), String> {
    crate::exec::spawn_detached(std::process::Command::new("open").arg(RELEASES_PAGE)).map_err(|e| e.to_string())
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
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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

fn fetch_latest_tag() -> Option<String> {
    let response = ureq::get(RELEASES_API)
        .set("User-Agent", "tori-update-check")
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .ok()?;
    let release: GithubRelease = response.into_json().ok()?;
    // `/releases/latest` already excludes drafts and prereleases, but the
    // fields are cheap to honour and this stays correct if the endpoint ever
    // changes underneath us.
    (!release.draft && !release.prerelease).then_some(release.tag_name)
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
    let tag = fetch_latest_tag()?;
    write_deadline(&path, CHECK_INTERVAL_SECS);

    is_newer(&tag, &current)
        .then(|| UpdateInfo { version: tag.trim_start_matches('v').to_string() })
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
