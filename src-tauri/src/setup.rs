// Rust owns the run rather than a command tab, because `worktree.new` and
// `session.spawn` need its verdict and only the webview knows a tab's exit.
// Status lives in memory: after a restart every folder reads none.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, LazyLock, Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::rpc::events::same_folder;
use crate::settings::WorktreePrefs;

/// Longest a setup may run before it is killed and reported failed.
pub const LIMIT: Duration = Duration::from_secs(30 * 60);

/// How long a socket caller waits for a setup, under the 300 s at which
/// codex-acp kills a tool call ([[concept_blocking_tool_call_ceiling]]).
pub const WAIT_CAP: Duration = Duration::from_secs(240);

const POLL: Duration = Duration::from_millis(100);
const KILL_GRACE: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Running,
    Done,
    Failed,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Report {
    pub worktree: String,
    pub state: State,
    pub code: Option<i32>,
    pub log: String,
}

pub type Publish = Arc<dyn Fn(&Report) + Send + Sync>;

pub struct Spec<'a> {
    pub command: &'a str,
    pub project: &'a str,
    pub worktree: &'a Path,
    pub path_env: &'a str,
    pub log_dir: &'a Path,
    pub limit: Duration,
}

struct Entry {
    report: Report,
    pid: u32,
}

#[derive(Default)]
pub struct Runs {
    entries: Mutex<Vec<Entry>>,
    changed: Condvar,
}

static RUNS: LazyLock<Runs> = LazyLock::new(Runs::default);
static PUBLISH: OnceLock<Publish> = OnceLock::new();

// Git lists worktrees by canonical path and a caller may not, so both sides of
// every lookup are canonicalized ([[gotcha_git_worktree_list_reports_canonical_paths]]).
fn canonical(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn kill_group(pid: u32) {
    // SAFETY: killpg only sends a signal. The pid is a child spawned with
    // process_group(0), so it names that child's own group.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
}

fn note(log: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().append(true).create(true).open(log) {
        let _ = writeln!(f, "\ntori: {line}");
    }
}

impl Runs {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Start `spec.command` in `spec.worktree` and return at once. A command
    /// that cannot be spawned is reported failed, with the reason in its log.
    pub fn start(&'static self, spec: Spec, publish: Publish) -> Report {
        let worktree = canonical(spec.worktree);
        let _ = std::fs::create_dir_all(spec.log_dir);
        let stem = spec
            .worktree
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let log = spec.log_dir.join(format!("{stem}-{nanos}.log"));

        let spawned = File::create(&log).and_then(|out| {
            let err = out.try_clone()?;
            Command::new("sh")
                .arg("-c")
                .arg(spec.command)
                .current_dir(spec.worktree)
                .env("TORI_PROJECT_ROOT", spec.project)
                .env("TORI_WORKTREE_PATH", &worktree)
                .env("PATH", spec.path_env)
                .stdin(Stdio::null())
                .stdout(out)
                .stderr(err)
                .process_group(0)
                .spawn()
        });
        let log_str = log.to_string_lossy().into_owned();
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                note(&log, &format!("setup did not start: {e}"));
                let report = Report {
                    worktree,
                    state: State::Failed,
                    code: None,
                    log: log_str,
                };
                self.put(Entry {
                    report: report.clone(),
                    pid: 0,
                });
                publish(&report);
                return report;
            }
        };
        let pid = child.id();
        let report = Report {
            worktree: worktree.clone(),
            state: State::Running,
            code: None,
            log: log_str,
        };
        self.put(Entry {
            report: report.clone(),
            pid,
        });
        publish(&report);

        let limit = spec.limit;
        thread::spawn(move || {
            let deadline = Instant::now() + limit;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) if Instant::now() >= deadline => {
                        kill_group(pid);
                        note(&log, &format!("setup killed after {} minutes", limit.as_secs() / 60));
                        let _ = child.wait();
                        break None;
                    }
                    Ok(None) => thread::sleep(POLL),
                    Err(_) => break None,
                }
            };
            let code = status.and_then(|s| s.code());
            let state = if code == Some(0) { State::Done } else { State::Failed };
            if let Some(report) = self.finish(pid, state, code) {
                publish(&report);
            }
        });
        report
    }

    fn put(&self, entry: Entry) {
        let mut entries = self.lock();
        entries.retain(|e| !same_folder(&e.report.worktree, &entry.report.worktree));
        entries.push(entry);
        self.changed.notify_all();
    }

    fn finish(&self, pid: u32, state: State, code: Option<i32>) -> Option<Report> {
        let mut entries = self.lock();
        let entry = entries
            .iter_mut()
            .find(|e| e.pid == pid && e.report.state == State::Running)?;
        entry.report.state = state;
        entry.report.code = code;
        let report = entry.report.clone();
        self.changed.notify_all();
        Some(report)
    }

    pub fn status(&self, worktree: &Path) -> Option<Report> {
        let key = canonical(worktree);
        self.lock()
            .iter()
            .find(|e| same_folder(&e.report.worktree, &key))
            .map(|e| e.report.clone())
    }

    /// The folder's report once its run has exited, or still running at `cap`.
    pub fn wait(&self, worktree: &Path, cap: Duration) -> Option<Report> {
        let key = canonical(worktree);
        let running = |entries: &mut Vec<Entry>| {
            entries
                .iter()
                .any(|e| same_folder(&e.report.worktree, &key) && e.report.state == State::Running)
        };
        let entries = self.lock();
        let (entries, _) = self
            .changed
            .wait_timeout_while(entries, cap, running)
            .unwrap_or_else(PoisonError::into_inner);
        entries
            .iter()
            .find(|e| same_folder(&e.report.worktree, &key))
            .map(|e| e.report.clone())
    }

    /// Kill the folder's run, if one is running, and wait briefly for it to
    /// end so nothing is still writing into the folder.
    pub fn kill(&self, worktree: &Path) {
        let key = canonical(worktree);
        let pid = self
            .lock()
            .iter()
            .find(|e| same_folder(&e.report.worktree, &key) && e.report.state == State::Running)
            .map(|e| e.pid);
        let Some(pid) = pid else { return };
        if let Some(log) = self.status(worktree).map(|r| r.log) {
            note(Path::new(&log), "setup killed because the worktree was removed");
        }
        kill_group(pid);
        self.wait(worktree, KILL_GRACE);
    }
}

#[cfg(test)]
thread_local! {
    static TEST_SEAM: std::cell::RefCell<Option<(HashMap<String, WorktreePrefs>, PathBuf)>> = const { std::cell::RefCell::new(None) };
}

/// Stand in for the settings file and the log folder on this thread, so a test
/// of a creation path never reads or writes the real config folder.
#[cfg(test)]
pub(crate) fn seam(prefs: HashMap<String, WorktreePrefs>, log_dir: PathBuf) {
    TEST_SEAM.with(|s| *s.borrow_mut() = Some((prefs, log_dir)));
}

fn settings_and_logs() -> (HashMap<String, WorktreePrefs>, PathBuf) {
    #[cfg(test)]
    if let Some(seam) = TEST_SEAM.with(|s| s.borrow().clone()) {
        return seam;
    }
    (
        crate::settings::get_settings().worktree,
        crate::owned_state::config_dir().join("setup"),
    )
}

/// The project's setup, when it has a command.
pub fn configured(project: &str) -> Option<WorktreePrefs> {
    settings_and_logs()
        .0
        .into_iter()
        .find(|(key, _)| same_folder(key, project))
        .map(|(_, prefs)| prefs)
        .filter(|prefs| !prefs.setup_command.trim().is_empty())
}

pub fn set_publisher(app: AppHandle) {
    let _ = PUBLISH.set(Arc::new(move |report| {
        let _ = app.emit("setup://changed", report);
    }));
}

/// Run the project's setup in a worktree Tori has just created for it.
pub fn on_created(project: &str, worktree: &Path) -> Option<Report> {
    let (prefs, log_dir) = settings_and_logs();
    let prefs = prefs
        .into_iter()
        .find(|(key, _)| same_folder(key, project))
        .map(|(_, p)| p)?;
    if prefs.setup_command.trim().is_empty() {
        return None;
    }
    let path_env = crate::env::login_path().map_or_else(crate::env::augmented_path, str::to_string);
    let publish = PUBLISH.get().cloned().unwrap_or_else(|| Arc::new(|_: &Report| {}));
    let spec = Spec {
        command: &prefs.setup_command,
        project,
        worktree,
        path_env: &path_env,
        log_dir: &log_dir,
        limit: LIMIT,
    };
    Some(RUNS.start(spec, publish))
}

pub fn status(worktree: &Path) -> Option<Report> {
    RUNS.status(worktree)
}

pub fn wait(worktree: &Path, cap: Duration) -> Option<Report> {
    RUNS.wait(worktree, cap)
}

pub fn kill(worktree: &Path) {
    RUNS.kill(worktree)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori-setup-test-{n}-{}", SEQ.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(dir.join("wt")).unwrap();
        dir
    }

    fn runs() -> &'static Runs {
        Box::leak(Box::default())
    }

    fn run(runs: &'static Runs, dir: &Path, command: &str, limit: Duration) -> Report {
        let spec = Spec {
            command,
            project: "/the/project",
            worktree: &dir.join("wt"),
            path_env: "/usr/bin:/bin",
            log_dir: &dir.join("logs"),
            limit,
        };
        runs.start(spec, Arc::new(|_: &Report| {}))
    }

    fn settled(runs: &Runs, dir: &Path) -> Report {
        runs.wait(&dir.join("wt"), Duration::from_secs(10)).unwrap()
    }

    #[test]
    fn exit_0_ends_done_and_the_log_holds_the_output_and_both_vars() {
        let dir = tmp();
        let runs = runs();
        let started = run(
            runs,
            &dir,
            r#"echo "root=$TORI_PROJECT_ROOT wt=$TORI_WORKTREE_PATH""#,
            LIMIT,
        );
        assert_eq!(started.state, State::Running);
        let done = settled(runs, &dir);
        assert_eq!((done.state, done.code), (State::Done, Some(0)));
        let log = std::fs::read_to_string(&done.log).unwrap();
        assert!(log.contains("root=/the/project"), "{log}");
        assert!(log.contains(&format!("wt={}", canonical(&dir.join("wt")))), "{log}");
    }

    #[test]
    fn exit_3_ends_failed_with_code_3() {
        let dir = tmp();
        let runs = runs();
        run(runs, &dir, "echo nope >&2; exit 3", LIMIT);
        let failed = settled(runs, &dir);
        assert_eq!((failed.state, failed.code), (State::Failed, Some(3)));
        assert!(std::fs::read_to_string(&failed.log).unwrap().contains("nope"));
    }

    #[test]
    fn a_command_reading_stdin_ends_instead_of_hanging() {
        let dir = tmp();
        let runs = runs();
        run(runs, &dir, "read answer; echo got=$answer", LIMIT);
        assert_ne!(settled(runs, &dir).state, State::Running);
    }

    #[test]
    fn a_run_past_its_limit_is_killed_with_its_children() {
        let dir = tmp();
        let runs = runs();
        let marker = dir.join("survived");
        run(
            runs,
            &dir,
            &format!("(sleep 2; touch '{}') & sleep 30", marker.display()),
            Duration::from_millis(300),
        );
        let report = settled(runs, &dir);
        assert_eq!(report.state, State::Failed);
        assert!(std::fs::read_to_string(&report.log)
            .unwrap()
            .contains("setup killed after"));
        thread::sleep(Duration::from_secs(3));
        assert!(!marker.exists(), "a child of the killed setup kept running");
    }

    #[test]
    fn kill_ends_a_running_setup() {
        let dir = tmp();
        let runs = runs();
        run(runs, &dir, "sleep 30", LIMIT);
        runs.kill(&dir.join("wt"));
        assert_eq!(runs.status(&dir.join("wt")).unwrap().state, State::Failed);
    }

    #[test]
    fn an_empty_command_starts_nothing() {
        let dir = tmp();
        let mut prefs = HashMap::new();
        prefs.insert(
            "/the/project".to_string(),
            WorktreePrefs {
                setup_command: "  ".into(),
                setup_wait: true,
            },
        );
        seam(prefs, dir.join("logs"));
        assert!(on_created("/the/project", &dir.join("wt")).is_none());
        assert!(configured("/the/project").is_none());
        assert!(!dir.join("logs").exists());
    }
}
