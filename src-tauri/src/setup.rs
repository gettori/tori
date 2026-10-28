// Rust owns the run rather than a command tab, because `worktree.new` and
// `session.spawn` need its verdict and only the webview knows a tab's exit.
// Status lives in memory: after a restart every folder reads none.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, LazyLock, Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::project_config::Values;
use crate::rpc::events::same_folder;
use crate::settings::WorktreePrefs;

/// Longest a setup may run before it is killed and reported failed.
pub const LIMIT: Duration = Duration::from_secs(30 * 60);

/// Longest a teardown may hold up a removal before it is killed.
pub const TEARDOWN_LIMIT: Duration = Duration::from_secs(2 * 60);

/// How long a socket caller waits for a setup, under the 300 s at which
/// codex-acp kills a tool call ([[concept_blocking_tool_call_ceiling]]).
pub const WAIT_CAP: Duration = Duration::from_secs(240);

const POLL: Duration = Duration::from_millis(100);
pub(crate) const KILL_GRACE: Duration = Duration::from_secs(5);

/// A run's log is cut back to its last `LOG_KEEP` bytes once it passes `LOG_CAP`,
/// since a dev server left running for days writes without end.
const LOG_CAP: u64 = 5 * 1024 * 1024;
const LOG_KEEP: u64 = 1024 * 1024;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Running,
    Stopping,
    Stopped,
    Done,
    Failed,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Setup,
    Run,
    Teardown,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    User,
    Repo,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Setup => "setup",
            Kind::Run => "run",
            Kind::Teardown => "teardown",
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Report {
    pub kind: Kind,
    pub worktree: String,
    pub state: State,
    pub code: Option<i32>,
    pub log: String,
    pub source: Source,
}

pub type Publish = Arc<dyn Fn(&Report) + Send + Sync>;

pub struct Spec<'a> {
    pub kind: Kind,
    pub command: &'a str,
    pub source: Source,
    pub project: &'a str,
    pub worktree: &'a Path,
    pub path_env: &'a str,
    pub log_dir: &'a Path,
    /// None runs until it exits or is stopped.
    pub limit: Option<Duration>,
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

pub(crate) fn signal_group(pgid: u32, signal: libc::c_int) -> bool {
    // SAFETY: killpg only sends a signal. Callers pass the pid of a child
    // spawned with process_group(0), which names that child's own group.
    unsafe { libc::killpg(pgid as libc::pid_t, signal) == 0 }
}

fn kill_group(pid: u32) {
    signal_group(pid, libc::SIGKILL);
}

fn trim_log(log: &Path, cap: u64, keep: u64) {
    let Ok(len) = std::fs::metadata(log).map(|m| m.len()) else {
        return;
    };
    if len <= cap {
        return;
    }
    let Ok(mut f) = OpenOptions::new().read(true).write(true).open(log) else {
        return;
    };
    let mut tail = Vec::new();
    if f.seek(SeekFrom::Start(len - keep)).is_err() || (&mut f).take(keep).read_to_end(&mut tail).is_err() {
        return;
    }
    // The child holds the log in append mode, so its next write lands after
    // this tail rather than at its old offset.
    let _ = f.set_len(0);
    let _ = f.seek(SeekFrom::Start(0));
    let _ = f.write_all(&tail);
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
        let log = spec.log_dir.join(format!("{stem}-{}-{nanos}.log", spec.kind.word()));

        let spawned = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .and_then(|out: File| {
                let err = out.try_clone()?;
                Command::new("sh")
                    .arg("-c")
                    .arg(spec.command)
                    .current_dir(spec.worktree)
                    .env("TORI_PROJECT_ROOT", spec.project)
                    .env("TORI_WORKTREE_PATH", &worktree)
                    .envs(crate::ports::env_for(spec.worktree))
                    .env("PATH", spec.path_env)
                    .stdin(Stdio::null())
                    .stdout(out)
                    .stderr(err)
                    .process_group(0)
                    .spawn()
            });
        let log_str = log.to_string_lossy().into_owned();
        let kind = spec.kind;
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                note(&log, &format!("{} did not start: {e}", kind.word()));
                let report = Report {
                    kind,
                    worktree,
                    state: State::Failed,
                    code: None,
                    log: log_str,
                    source: spec.source,
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
            kind,
            worktree: worktree.clone(),
            state: State::Running,
            code: None,
            log: log_str,
            source: spec.source,
        };
        self.put(Entry {
            report: report.clone(),
            pid,
        });
        publish(&report);

        let limit = spec.limit;
        thread::spawn(move || {
            let deadline = limit.map(|limit| Instant::now() + limit);
            let status = loop {
                if kind == Kind::Run {
                    trim_log(&log, LOG_CAP, LOG_KEEP);
                }
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) if deadline.is_some_and(|d| Instant::now() >= d) => {
                        let limit = limit.unwrap_or_default();
                        kill_group(pid);
                        note(
                            &log,
                            &format!("{} killed after {} minutes", kind.word(), limit.as_secs() / 60),
                        );
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
        entries
            .retain(|e| e.report.kind != entry.report.kind || !same_folder(&e.report.worktree, &entry.report.worktree));
        entries.push(entry);
        self.changed.notify_all();
    }

    fn finish(&self, pid: u32, state: State, code: Option<i32>) -> Option<Report> {
        let mut entries = self.lock();
        let entry = entries
            .iter_mut()
            .find(|e| e.pid == pid && matches!(e.report.state, State::Running | State::Stopping))?;
        // A stop asked for is a stop, whatever the signal made of the exit code.
        entry.report.state = if entry.report.state == State::Stopping {
            State::Stopped
        } else {
            state
        };
        entry.report.code = code;
        let report = entry.report.clone();
        self.changed.notify_all();
        Some(report)
    }

    pub fn status(&self, worktree: &Path, kind: Kind) -> Option<Report> {
        let key = canonical(worktree);
        self.lock()
            .iter()
            .find(|e| e.report.kind == kind && same_folder(&e.report.worktree, &key))
            .map(|e| e.report.clone())
    }

    /// The folder's report once its run has exited, or still running at `cap`.
    pub fn wait(&self, worktree: &Path, kind: Kind, cap: Duration) -> Option<Report> {
        self.wait_out(worktree, kind, State::Running, cap)
    }

    pub fn wait_out(&self, worktree: &Path, kind: Kind, state: State, cap: Duration) -> Option<Report> {
        let key = canonical(worktree);
        let mine = |e: &Entry| e.report.kind == kind && same_folder(&e.report.worktree, &key);
        let running = |entries: &mut Vec<Entry>| entries.iter().any(|e| mine(e) && e.report.state == state);
        let entries = self.lock();
        let (entries, _) = self
            .changed
            .wait_timeout_while(entries, cap, running)
            .unwrap_or_else(PoisonError::into_inner);
        entries.iter().find(|e| mine(e)).map(|e| e.report.clone())
    }

    /// Kill the folder's run, if one is running, and wait briefly for it to
    /// end so nothing is still writing into the folder.
    pub fn kill(&self, worktree: &Path, kind: Kind) {
        let key = canonical(worktree);
        let pid = self
            .lock()
            .iter()
            .find(|e| {
                e.report.kind == kind && same_folder(&e.report.worktree, &key) && e.report.state == State::Running
            })
            .map(|e| e.pid);
        let Some(pid) = pid else { return };
        if let Some(log) = self.status(worktree, kind).map(|r| r.log) {
            note(
                Path::new(&log),
                &format!("{} killed because the worktree was removed", kind.word()),
            );
        }
        kill_group(pid);
        self.wait(worktree, kind, KILL_GRACE);
    }

    pub fn live(&self, kind: Kind) -> Vec<Report> {
        self.lock()
            .iter()
            .filter(|e| e.report.kind == kind && matches!(e.report.state, State::Running | State::Stopping))
            .map(|e| e.report.clone())
            .collect()
    }

    pub fn pid(&self, worktree: &Path, kind: Kind) -> Option<u32> {
        let key = canonical(worktree);
        self.lock()
            .iter()
            .find(|e| {
                e.report.kind == kind && same_folder(&e.report.worktree, &key) && e.report.state == State::Running
            })
            .map(|e| e.pid)
    }

    pub fn stop(&self, worktree: &Path, kind: Kind, grace: Duration, publish: &Publish) {
        let key = canonical(worktree);
        self.stop_where(
            |e| e.report.kind == kind && same_folder(&e.report.worktree, &key),
            grace,
            publish,
        );
    }

    pub fn stop_all(&self, kind: Kind, grace: Duration, publish: &Publish) {
        self.stop_where(|e| e.report.kind == kind, grace, publish);
    }

    fn stop_where(&self, pick: impl Fn(&Entry) -> bool, grace: Duration, publish: &Publish) {
        let mut stopping = Vec::new();
        {
            let mut entries = self.lock();
            for e in entries
                .iter_mut()
                .filter(|e| e.report.state == State::Running && pick(e))
            {
                e.report.state = State::Stopping;
                stopping.push((e.pid, e.report.clone()));
            }
            self.changed.notify_all();
        }
        if stopping.is_empty() {
            return;
        }
        for (pid, report) in &stopping {
            publish(report);
            signal_group(*pid, libc::SIGTERM);
        }
        let pids: Vec<u32> = stopping.iter().map(|(pid, _)| *pid).collect();
        let held = |entries: &mut Vec<Entry>| {
            entries
                .iter()
                .any(|e| pids.contains(&e.pid) && e.report.state == State::Stopping)
        };
        let (entries, waited) = self
            .changed
            .wait_timeout_while(self.lock(), grace, held)
            .unwrap_or_else(PoisonError::into_inner);
        drop(entries);
        if waited.timed_out() {
            for pid in &pids {
                kill_group(*pid);
            }
            let _ = self
                .changed
                .wait_timeout_while(self.lock(), KILL_GRACE, held)
                .unwrap_or_else(PoisonError::into_inner);
        }
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

pub(crate) fn settings_and_logs() -> (HashMap<String, WorktreePrefs>, PathBuf) {
    #[cfg(test)]
    if let Some(seam) = TEST_SEAM.with(|s| s.borrow().clone()) {
        return seam;
    }
    (worktree_settings(), crate::owned_state::config_dir().join("setup"))
}

// Every spawn asks for its port width, so the file is read again only once it changed.
fn worktree_settings() -> HashMap<String, WorktreePrefs> {
    static CACHE: Mutex<Option<(SystemTime, HashMap<String, WorktreePrefs>)>> = Mutex::new(None);
    let stamp = crate::settings::modified();
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let (Some(stamp), Some((at, prefs))) = (stamp, &*cache) {
        if *at == stamp {
            return prefs.clone();
        }
    }
    let prefs = crate::settings::get_settings().worktree;
    *cache = stamp.map(|stamp| (stamp, prefs.clone()));
    prefs
}

fn prefs_for(project: &str) -> WorktreePrefs {
    settings_and_logs()
        .0
        .into_iter()
        .find(|(key, _)| same_folder(key, project))
        .map(|(_, prefs)| prefs)
        .unwrap_or_default()
}

fn pick(kind: Kind, user: &WorktreePrefs, repo: Option<&Values>) -> Option<(String, Source)> {
    let (mine, theirs) = match kind {
        Kind::Setup => (&user.setup_command, repo.and_then(|r| r.setup_command.as_ref())),
        Kind::Run => (&user.run_command, repo.and_then(|r| r.run_command.as_ref())),
        Kind::Teardown => (&user.teardown_command, repo.and_then(|r| r.teardown_command.as_ref())),
    };
    if !mine.trim().is_empty() {
        return Some((mine.clone(), Source::User));
    }
    theirs.map(|c| (c.clone(), Source::Repo))
}

pub fn command_for(kind: Kind, project: &str, worktree: &Path) -> Option<(String, Source)> {
    pick(
        kind,
        &prefs_for(project),
        crate::project_config::accepted(worktree).as_ref(),
    )
}

/// The project's prefs, when `worktree` has a setup command to run.
pub fn setup_prefs(project: &str, worktree: &Path) -> Option<WorktreePrefs> {
    command_for(Kind::Setup, project, worktree).map(|_| prefs_for(project))
}

pub(crate) fn shared() -> &'static Runs {
    &RUNS
}

pub(crate) fn publisher() -> Publish {
    PUBLISH.get().cloned().unwrap_or_else(|| Arc::new(|_: &Report| {}))
}

pub fn set_publisher(app: AppHandle) {
    let _ = PUBLISH.set(Arc::new(move |report| {
        let _ = app.emit("setup://changed", report);
    }));
}

/// Run the project's setup in a worktree Tori has just created for it.
pub fn on_created(project: &str, worktree: &Path) -> Option<Report> {
    let (command, source) = command_for(Kind::Setup, project, worktree)?;
    let log_dir = settings_and_logs().1;
    let path_env = crate::env::login_path().map_or_else(crate::env::augmented_path, str::to_string);
    let spec = Spec {
        kind: Kind::Setup,
        command: &command,
        source,
        project,
        worktree,
        path_env: &path_env,
        log_dir: &log_dir,
        limit: Some(LIMIT),
    };
    Some(RUNS.start(spec, publisher()))
}

/// Run the teardown in a worktree about to be removed, and return once it has
/// exited or been killed at `TEARDOWN_LIMIT`.
pub fn teardown(project: &str, worktree: &Path) -> Option<Report> {
    let (command, source) = command_for(Kind::Teardown, project, worktree)?;
    let log_dir = settings_and_logs().1;
    let path_env = crate::env::login_path().map_or_else(crate::env::augmented_path, str::to_string);
    let spec = Spec {
        kind: Kind::Teardown,
        command: &command,
        source,
        project,
        worktree,
        path_env: &path_env,
        log_dir: &log_dir,
        limit: Some(TEARDOWN_LIMIT),
    };
    RUNS.start(spec, publisher());
    RUNS.wait(worktree, Kind::Teardown, TEARDOWN_LIMIT + KILL_GRACE)
}

pub fn status(worktree: &Path) -> Option<Report> {
    RUNS.status(worktree, Kind::Setup)
}

pub fn wait(worktree: &Path, cap: Duration) -> Option<Report> {
    RUNS.wait(worktree, Kind::Setup, cap)
}

pub fn kill(worktree: &Path) {
    RUNS.kill(worktree, Kind::Setup)
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
            kind: Kind::Setup,
            command,
            source: Source::User,
            project: "/the/project",
            worktree: &dir.join("wt"),
            path_env: "/usr/bin:/bin",
            log_dir: &dir.join("logs"),
            limit: Some(limit),
        };
        runs.start(spec, Arc::new(|_: &Report| {}))
    }

    fn settled(runs: &Runs, dir: &Path) -> Report {
        runs.wait(&dir.join("wt"), Kind::Setup, Duration::from_secs(10))
            .unwrap()
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
        runs.kill(&dir.join("wt"), Kind::Setup);
        assert_eq!(runs.status(&dir.join("wt"), Kind::Setup).unwrap().state, State::Failed);
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
                ..Default::default()
            },
        );
        seam(prefs, dir.join("logs"));
        assert!(on_created("/the/project", &dir.join("wt")).is_none());
        assert!(setup_prefs("/the/project", &dir.join("wt")).is_none());
        assert!(!dir.join("logs").exists());
    }

    fn user_setup(dir: &Path, command: &str) {
        let mut prefs = HashMap::new();
        prefs.insert(
            "/the/project".to_string(),
            WorktreePrefs {
                setup_command: command.into(),
                ..Default::default()
            },
        );
        seam(prefs, dir.join("logs"));
    }

    fn repo(setup: &str, run: &str) -> Values {
        Values {
            setup_command: Some(setup.into()),
            run_command: Some(run.into()),
            ..Default::default()
        }
    }

    #[test]
    fn the_users_command_beats_the_repos_and_the_repos_fills_an_empty_one() {
        let dir = tmp();
        let wt = dir.join("wt");
        user_setup(&dir, "mine");
        crate::project_config::seam_accepted(&wt, repo("theirs", "pnpm dev"));
        assert_eq!(
            command_for(Kind::Setup, "/the/project", &wt),
            Some(("mine".to_string(), Source::User))
        );
        assert_eq!(
            command_for(Kind::Run, "/the/project", &wt),
            Some(("pnpm dev".to_string(), Source::Repo))
        );
        assert_eq!(command_for(Kind::Teardown, "/the/project", &wt), None);
    }

    #[test]
    fn a_repo_setup_runs_where_the_user_has_none_and_says_so() {
        let dir = tmp();
        let wt = dir.join("wt");
        let marker = dir.join("ran");
        user_setup(&dir, " ");
        crate::project_config::seam_accepted(&wt, repo(&format!("touch '{}'", marker.display()), "x"));
        assert_eq!(on_created("/the/project", &wt).unwrap().source, Source::Repo);
        let report = wait(&wt, Duration::from_secs(10)).unwrap();
        assert_eq!((report.state, report.source), (State::Done, Source::Repo));
        assert!(marker.exists());
    }

    #[test]
    fn an_unaccepted_proposal_runs_only_the_users_command() {
        let dir = tmp();
        let wt = dir.join("wt");
        user_setup(&dir, "mine");
        crate::project_config::seam(
            &wt,
            crate::project_config::Proposal::Unaccepted {
                digest: "d".into(),
                content: String::new(),
                values: repo("theirs", "pnpm dev"),
                previous: None,
            },
        );
        assert_eq!(
            command_for(Kind::Setup, "/the/project", &wt),
            Some(("mine".to_string(), Source::User))
        );
        assert_eq!(command_for(Kind::Run, "/the/project", &wt), None);
    }

    fn teardown_seam(dir: &Path, command: &str) {
        let mut prefs = HashMap::new();
        prefs.insert(
            "/the/project".to_string(),
            WorktreePrefs {
                teardown_command: command.into(),
                ..Default::default()
            },
        );
        seam(prefs, dir.join("logs"));
    }

    #[test]
    fn teardown_returns_only_once_its_command_has_exited() {
        let dir = tmp();
        let marker = dir.join("dropped");
        teardown_seam(&dir, &format!("sleep 0.3; touch '{}'", marker.display()));
        let report = teardown("/the/project", &dir.join("wt")).unwrap();
        assert_eq!(
            (report.kind, report.state, report.code),
            (Kind::Teardown, State::Done, Some(0))
        );
        assert!(marker.exists(), "teardown returned before its command finished");
        assert!(
            status(&dir.join("wt")).is_none(),
            "a teardown is not the folder's setup"
        );
    }

    #[test]
    fn a_failing_teardown_reports_failed_and_an_empty_one_runs_nothing() {
        let dir = tmp();
        teardown_seam(&dir, "exit 4");
        let report = teardown("/the/project", &dir.join("wt")).unwrap();
        assert_eq!((report.state, report.code), (State::Failed, Some(4)));

        let other = tmp();
        teardown_seam(&other, " ");
        assert!(teardown("/the/project", &other.join("wt")).is_none());
        assert!(!other.join("logs").exists());
    }

    #[test]
    fn a_setup_and_a_teardown_in_one_folder_keep_their_own_reports() {
        let dir = tmp();
        let runs = runs();
        run(runs, &dir, "sleep 30", LIMIT);
        let spec = Spec {
            kind: Kind::Teardown,
            command: "true",
            source: Source::User,
            project: "/the/project",
            worktree: &dir.join("wt"),
            path_env: "/usr/bin:/bin",
            log_dir: &dir.join("logs"),
            limit: Some(LIMIT),
        };
        runs.start(spec, Arc::new(|_: &Report| {}));
        let torn = runs
            .wait(&dir.join("wt"), Kind::Teardown, Duration::from_secs(10))
            .unwrap();
        assert_eq!(torn.state, State::Done);
        assert_eq!(runs.status(&dir.join("wt"), Kind::Setup).unwrap().state, State::Running);
        runs.kill(&dir.join("wt"), Kind::Setup);
    }
}
