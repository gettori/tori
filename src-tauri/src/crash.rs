// Crash files: what a bug report needs when Tori simply closed.
//
// A Rust panic in a Tauri app takes the whole process with it, and the stderr
// a Finder-launched app writes to goes nowhere, so without this the only
// evidence is "it closed". The hook here writes one file per panic under
// `~/.config/tori/crashes/` with the version, the thread, the message and a
// backtrace, then hands over to the default hook so a terminal launch still
// prints what it always did.
//
// Two rules, both about the hook running at the worst possible moment:
//
// 1. Nothing in it can panic or block. Every write is best effort and every
//    error is dropped: a hook that panics aborts the process with no file at
//    all, which is the one outcome worse than the panic it was recording.
// 2. Nothing leaves the machine. The file sits on disk until the user clicks
//    Reveal or Report in Settings; the report is a prefilled issue form in the
//    browser, where the user sees what it says before submitting.
//
// The webview's uncaught errors and rejections land in the same folder through
// `record_webview_error`, capped per launch so a render loop cannot write a
// thousand files, and deduplicated by message so one bug is one file.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Files kept, newest first; older ones go on the next write.
const KEEP: usize = 50;
/// Webview reports accepted per launch. A panic is one per process by nature.
const WEBVIEW_CAP: usize = 20;

const BUG_FORM: &str = "https://github.com/gettori/tori/issues/new";

pub fn dir() -> PathBuf {
    crate::owned_state::config_dir().join("crashes")
}

/// Install the panic hook. Called once, before Tauri starts, so a panic during
/// setup is recorded too. Helper re-execs (askpass, the approval hook) exit
/// before this runs and keep the default hook: they are short-lived children
/// of another program and a crash file from them would read as Tori's.
pub fn install() {
    // Asked now, not in the hook: a subprocess from a panicking process is one
    // more thing that can go wrong at the moment nothing else may.
    let _ = os_version();
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let report = Report {
            kind: "panic",
            headline: info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic with a non-string payload".into()),
            location: info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())),
            thread: thread.name().unwrap_or("unnamed").to_string(),
            detail: std::backtrace::Backtrace::force_capture().to_string(),
        };
        let _ = write(&dir(), &report, SystemTime::now());
        default(info);
    }));
}

struct Report {
    kind: &'static str,
    headline: String,
    location: Option<String>,
    thread: String,
    detail: String,
}

/// One file, named by its UTC time so the folder sorts by age. Returns the
/// path for the toast to name. Pure over `dir` so tests write to a temp folder.
fn write(dir: &Path, report: &Report, at: SystemTime) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let secs = at.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = dir.join(format!("{}-{}.txt", stamp(secs), report.kind));
    let body = format!(
        "Tori {VERSION}\n{os}\n{kind} at {when} UTC\nthread: {thread}\n{location}\n\n{headline}\n\n{detail}\n",
        os = os_version(),
        kind = report.kind,
        when = stamp(secs).replace('T', " "),
        thread = report.thread,
        location = report.location.as_deref().map(|l| format!("at {l}")).unwrap_or_default(),
        headline = report.headline.trim(),
        detail = report.detail.trim(),
    );
    fs::write(&path, body)?;
    prune(dir);
    Ok(path)
}

/// `20261003T0912Z`-style, no separators that a filename would mind. Hand
/// rolled from the epoch so the hook pulls in nothing that could allocate
/// surprisingly; the civil-date arithmetic is the standard days-to-ymd one.
fn stamp(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's days_from_civil, inverted.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}{mo:02}{d:02}T{h:02}{m:02}{s:02}Z")
}

fn os_version() -> &'static str {
    static OS: OnceLock<String> = OnceLock::new();
    OS.get_or_init(|| {
        let out = std::process::Command::new("sw_vers").arg("-productVersion").output();
        let version = out
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".into());
        format!("macOS {version} {}", std::env::consts::ARCH)
    })
}

/// Keep the newest `KEEP` files. Best effort, like everything here.
fn prune(dir: &Path) {
    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "txt"))
            .collect(),
        Err(_) => return,
    };
    files.sort();
    let extra = files.len().saturating_sub(KEEP);
    for old in &files[..extra] {
        let _ = fs::remove_file(old);
    }
}

// --- the webview's half ---------------------------------------------------

struct WebviewLog {
    seen: HashSet<String>,
    written: usize,
}

static WEBVIEW: Mutex<Option<WebviewLog>> = Mutex::new(None);

/// An uncaught error or rejection from the frontend. Returns the file, or
/// `None` when it was a repeat or the launch's cap is spent, which the caller
/// does not act on either way.
#[tauri::command(async)]
pub fn record_webview_error(kind: String, message: String, stack: Option<String>, url: Option<String>) -> Option<String> {
    let headline = message.trim().to_string();
    if headline.is_empty() {
        return None;
    }
    {
        let mut slot = WEBVIEW.lock().ok()?;
        let log = slot.get_or_insert_with(|| WebviewLog { seen: HashSet::new(), written: 0 });
        if log.written >= WEBVIEW_CAP || !log.seen.insert(headline.clone()) {
            return None;
        }
        log.written += 1;
    }
    let report = Report {
        kind: if kind == "rejection" { "rejection" } else { "webview" },
        headline,
        location: url,
        thread: "webview".into(),
        detail: stack.unwrap_or_default(),
    };
    write(&dir(), &report, SystemTime::now())
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

// --- what Settings and the launch toast read ------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashFile {
    pub path: String,
    /// `panic`, `webview` or `rejection`.
    pub kind: String,
    pub headline: String,
    /// Seconds since the epoch, from the filename.
    pub at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashLogs {
    pub version: String,
    pub dir: String,
    /// Newest first.
    pub files: Vec<CrashFile>,
}

#[tauri::command(async)]
pub fn crash_logs() -> CrashLogs {
    let d = dir();
    let mut files = list(&d);
    files.reverse();
    CrashLogs { version: VERSION.into(), dir: d.to_string_lossy().into_owned(), files }
}

fn list(dir: &Path) -> Vec<CrashFile> {
    let mut names: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "txt"))
            .collect(),
        Err(_) => return Vec::new(),
    };
    names.sort();
    names.into_iter().filter_map(|p| parse_file(&p)).collect()
}

fn parse_file(path: &Path) -> Option<CrashFile> {
    let name = path.file_stem()?.to_str()?;
    let (when, kind) = name.split_once('-')?;
    let at = unstamp(when)?;
    let text = fs::read_to_string(path).ok()?;
    // Line 7 is the headline, after the five-line header and a blank.
    let headline = text.lines().nth(6).unwrap_or("").trim().to_string();
    Some(CrashFile {
        path: path.to_string_lossy().into_owned(),
        kind: kind.to_string(),
        headline,
        at,
    })
}

/// The inverse of `stamp`, for the newest-first sort and the toast's "when".
fn unstamp(s: &str) -> Option<u64> {
    if s.len() != 16 || !s.ends_with('Z') || s.as_bytes()[8] != b'T' {
        return None;
    }
    let num = |a: usize, b: usize| s[a..b].parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(4, 6)?, num(6, 8)?);
    let (h, mi, se) = (num(9, 11)?, num(11, 13)?, num(13, 15)?);
    // days_from_civil.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + se).ok()
}

/// The bug form, prefilled from the newest crash file when there is one. A
/// fixed destination built here, not a URL the frontend hands in, the same
/// rule as `update::open_releases_page`.
#[tauri::command(async)]
pub fn open_crash_issue() -> Result<(), String> {
    let url = issue_url(list(&dir()).last());
    crate::exec::spawn_detached(std::process::Command::new("open").arg(url)).map_err(|e| e.to_string())
}

fn issue_url(newest: Option<&CrashFile>) -> String {
    let mut what = String::new();
    if let Some(f) = newest {
        what = format!(
            "Tori closed on its own. The crash file says:\n\n{}\n\n(Full file: {}. Attach it here.)\n\nWhat I was doing:\n",
            f.headline, f.path
        );
    }
    format!(
        "{BUG_FORM}?template=bug_report.yml&tori-version={}&macos-version={}&what-happened={}",
        encode(VERSION),
        encode(os_version()),
        encode(&what)
    )
}

/// Percent-encode for a query value. Small on purpose: the inputs are a
/// version, an OS string and a paragraph of our own text.
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("tori_crash_test_{n}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn stamp_round_trips_and_sorts_by_time() {
        for secs in [0u64, 951_782_400, 1_790_000_000, 4_102_444_799] {
            let s = stamp(secs);
            assert_eq!(unstamp(&s), Some(secs), "{s}");
        }
        assert_eq!(stamp(951_782_400), "20000229T000000Z");
        assert!(stamp(1_790_000_000) < stamp(1_790_000_001));
    }

    #[test]
    fn a_report_is_written_listed_and_pruned() {
        let d = tmp();
        let report = Report {
            kind: "panic",
            headline: "index out of bounds".into(),
            location: Some("src/x.rs:1:2".into()),
            thread: "main".into(),
            detail: "   0: frame".into(),
        };
        let base = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_790_000_000);
        for i in 0..(KEEP as u64 + 3) {
            write(&d, &report, base + std::time::Duration::from_secs(i)).unwrap();
        }
        let files = list(&d);
        assert_eq!(files.len(), KEEP, "older files are pruned");
        assert_eq!(files.last().unwrap().at, 1_790_000_000 + KEEP as u64 + 2, "the newest survives");
        assert_eq!(files[0].headline, "index out of bounds");
        assert_eq!(files[0].kind, "panic");
        let text = fs::read_to_string(&files[0].path).unwrap();
        assert!(text.starts_with(&format!("Tori {VERSION}\n")));
        assert!(text.contains("at src/x.rs:1:2"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_issue_url_carries_the_version_and_the_headline() {
        let newest = CrashFile {
            path: "/tmp/x/20261003T000000Z-panic.txt".into(),
            kind: "panic".into(),
            headline: "called `Option::unwrap()` on a `None` value".into(),
            at: 0,
        };
        let url = issue_url(Some(&newest));
        assert!(url.starts_with("https://github.com/gettori/tori/issues/new?template=bug_report.yml&tori-version="));
        assert!(url.contains(&format!("tori-version={}", encode(VERSION))));
        assert!(url.contains("Option%3A%3Aunwrap"), "{url}");
        assert!(url.contains("what-happened=Tori%20closed"), "{url}");
        assert!(issue_url(None).ends_with("&what-happened="));
    }
}
