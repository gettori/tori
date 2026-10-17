// A project's run command, a dev server usually, started and stopped by hand.
// It shares setup's core, so removal and quit stop it from Rust, and a record
// of live groups on disk lets the next launch stop what a crash left behind.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::rpc::events::same_folder;
use crate::setup::{self, Kind, Publish, Report, Spec, State};

const GRACE: Duration = setup::KILL_GRACE;
const LOG_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

static STARTING: Mutex<()> = Mutex::new(());
static RECORD: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Live {
    pgid: u32,
    worktree: String,
}

fn record_path() -> PathBuf {
    #[cfg(test)]
    return setup::settings_and_logs().1.join("runs.json");
    #[cfg(not(test))]
    crate::owned_state::config_dir().join("runs.json")
}

fn read(path: &Path) -> Vec<Live> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write(path: &Path, live: &[Live]) {
    if let Ok(text) = serde_json::to_string(live) {
        let _ = std::fs::write(path, text);
    }
}

fn remember(path: &Path, pgid: u32, worktree: &str) {
    let _held = RECORD.lock().unwrap_or_else(PoisonError::into_inner);
    let mut live = read(path);
    live.retain(|l| !same_folder(&l.worktree, worktree));
    live.push(Live {
        pgid,
        worktree: worktree.to_string(),
    });
    write(path, &live);
}

fn forget(path: &Path, worktree: &str) {
    let _held = RECORD.lock().unwrap_or_else(PoisonError::into_inner);
    let mut live = read(path);
    live.retain(|l| !same_folder(&l.worktree, worktree));
    write(path, &live);
}

fn publisher(record: PathBuf) -> Publish {
    let base = setup::publisher();
    Arc::new(move |report: &Report| {
        if !matches!(report.state, State::Running | State::Stopping) {
            forget(&record, &report.worktree);
        }
        base(report);
    })
}

/// Start the project's run command in `worktree`, or answer the one already
/// running there. A run still stopping is waited out first, so a restart never
/// races the old server for its port.
pub fn start(project: &str, worktree: &Path) -> Result<Report, String> {
    let (prefs, log_dir) = setup::settings_and_logs();
    let command = prefs
        .into_iter()
        .find(|(key, _)| same_folder(key, project))
        .map(|(_, p)| p.run_command)
        .unwrap_or_default();
    if command.trim().is_empty() {
        return Err("This project has no run command.".into());
    }
    if !crate::worktree::not_a_fork(worktree) {
        return Err("This worktree is a fork's pull request, or git cannot read it.".into());
    }
    let runs = setup::shared();
    runs.wait_out(worktree, Kind::Run, State::Stopping, GRACE * 2);
    let _held = STARTING.lock().unwrap_or_else(PoisonError::into_inner);
    match runs.status(worktree, Kind::Run) {
        Some(live) if live.state == State::Running => return Ok(live),
        Some(old) if old.state == State::Stopping => return Err("The last run is still stopping.".into()),
        _ => {}
    }
    let path_env = crate::env::login_path().map_or_else(crate::env::augmented_path, str::to_string);
    let record = record_path();
    let spec = Spec {
        kind: Kind::Run,
        command: &command,
        project,
        worktree,
        path_env: &path_env,
        log_dir: &log_dir,
        limit: None,
    };
    let report = runs.start(spec, publisher(record.clone()));
    if let Some(pgid) = runs.pid(worktree, Kind::Run) {
        remember(&record, pgid, &report.worktree);
    }
    Ok(report)
}

pub fn stop(worktree: &Path) {
    setup::shared().stop(worktree, Kind::Run, GRACE, &publisher(record_path()));
}

pub fn stop_all() {
    setup::shared().stop_all(Kind::Run, GRACE, &publisher(record_path()));
}

pub fn live() -> Vec<Report> {
    setup::shared().live(Kind::Run)
}

fn members(pgid: u32) -> Vec<u32> {
    Command::new("pgrep")
        .args(["-g", &pgid.to_string()])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn cwd_of(pid: u32) -> Option<PathBuf> {
    let out = Command::new("lsof")
        .args(["-a", "-w", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(PathBuf::from))
}

/// A recorded pgid may have been reused by now, so a group is only ours when
/// one of its members still sits in the worktree it was started in.
fn still_ours(live: &Live) -> bool {
    let root = std::fs::canonicalize(&live.worktree).unwrap_or_else(|_| PathBuf::from(&live.worktree));
    members(live.pgid)
        .into_iter()
        .any(|pid| cwd_of(pid).is_some_and(|cwd| cwd.starts_with(&root)))
}

fn reap(path: &Path, grace: Duration) {
    let doomed: Vec<u32> = read(path).iter().filter(|l| still_ours(l)).map(|l| l.pgid).collect();
    let _ = std::fs::remove_file(path);
    for pgid in &doomed {
        setup::signal_group(*pgid, libc::SIGTERM);
    }
    let deadline = Instant::now() + grace;
    while doomed.iter().any(|pgid| setup::signal_group(*pgid, 0)) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    for pgid in &doomed {
        setup::signal_group(*pgid, libc::SIGKILL);
    }
}

fn prune_logs(dir: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().contains("-run-") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|at| now.duration_since(at).is_ok_and(|d| d > age));
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Stop what the last session left running and drop old run logs, off the
/// launch path since a stubborn group holds it for the whole grace.
pub fn at_launch() {
    thread::spawn(|| {
        reap(&record_path(), GRACE);
        prune_logs(&setup::settings_and_logs().1, LOG_AGE);
    });
}

#[tauri::command(async)]
pub fn run_start(project_path: String, worktree_path: String) -> Result<Report, String> {
    start(&project_path, Path::new(&worktree_path))
}

#[tauri::command(async)]
pub fn run_stop(worktree_path: String) {
    stop(Path::new(&worktree_path));
}

#[tauri::command]
pub fn run_list() -> Vec<Report> {
    live()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::UNIX_EPOCH;

    fn tmp() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori-run-test-{n}-{}", SEQ.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(dir.join("wt")).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn runs() -> &'static setup::Runs {
        Box::leak(Box::default())
    }

    fn quiet() -> Publish {
        Arc::new(|_: &Report| {})
    }

    fn start_in(runs: &'static setup::Runs, dir: &Path, command: &str) -> Report {
        let spec = Spec {
            kind: Kind::Run,
            command,
            project: "/the/project",
            worktree: &dir.join("wt"),
            path_env: "/usr/bin:/bin",
            log_dir: &dir.join("logs"),
            limit: None,
        };
        runs.start(spec, quiet())
    }

    #[test]
    fn stop_ends_stopped_after_term_and_a_self_exit_ends_failed() {
        let dir = tmp();
        let runs = runs();
        let marker = dir.join("cleaned");
        start_in(
            runs,
            &dir,
            &format!(
                "trap \"touch '{}'; exit 0\" TERM; while true; do sleep 0.1; done",
                marker.display()
            ),
        );
        thread::sleep(Duration::from_millis(300));
        runs.stop(&dir.join("wt"), Kind::Run, GRACE, &quiet());
        let report = runs.status(&dir.join("wt"), Kind::Run).unwrap();
        assert_eq!(report.state, State::Stopped);
        assert!(marker.exists(), "TERM reached the run before anything harder");

        let other = tmp();
        start_in(runs, &other, "exit 1");
        let failed = runs
            .wait(&other.join("wt"), Kind::Run, Duration::from_secs(10))
            .unwrap();
        assert_eq!((failed.state, failed.code), (State::Failed, Some(1)));
    }

    #[test]
    fn a_run_ignoring_term_is_killed_after_the_grace() {
        let dir = tmp();
        let runs = runs();
        start_in(runs, &dir, "trap '' TERM; while true; do sleep 0.1; done");
        thread::sleep(Duration::from_millis(300));
        let pgid = runs.pid(&dir.join("wt"), Kind::Run).unwrap();
        let began = Instant::now();
        runs.stop(&dir.join("wt"), Kind::Run, Duration::from_millis(500), &quiet());
        assert!(began.elapsed() < Duration::from_secs(4));
        assert_eq!(runs.status(&dir.join("wt"), Kind::Run).unwrap().state, State::Stopped);
        assert!(!setup::signal_group(pgid, 0), "the group outlived the kill");
    }

    #[test]
    fn stop_all_shares_one_grace() {
        let runs = runs();
        let dirs: Vec<PathBuf> = (0..3).map(|_| tmp()).collect();
        for dir in &dirs {
            start_in(runs, dir, "trap '' TERM; while true; do sleep 0.1; done");
        }
        thread::sleep(Duration::from_millis(300));
        assert_eq!(runs.live(Kind::Run).len(), 3);
        runs.stop(&dirs[0].join("wt"), Kind::Run, Duration::from_millis(200), &quiet());
        assert_eq!(runs.live(Kind::Run).len(), 2, "a stopped run is no longer listed");
        let began = Instant::now();
        runs.stop_all(Kind::Run, Duration::from_millis(500), &quiet());
        assert!(began.elapsed() < Duration::from_secs(2), "{:?}", began.elapsed());
        assert!(runs.live(Kind::Run).is_empty());
    }

    #[test]
    fn a_run_past_the_log_cap_is_cut_back() {
        let dir = tmp();
        let runs = runs();
        let report = start_in(runs, &dir, "head -c 6000000 /dev/zero | tr '\\0' a; sleep 30");
        thread::sleep(Duration::from_secs(2));
        let len = std::fs::metadata(&report.log).unwrap().len();
        runs.stop(&dir.join("wt"), Kind::Run, GRACE, &quiet());
        assert!(len <= 5 * 1024 * 1024, "log is {len} bytes");
        assert!(len > 0);
    }

    #[test]
    fn launch_reaps_an_orphan_group_and_leaves_a_reused_pgid_alone() {
        let dir = tmp();
        let ours = Command::new("sh")
            .args(["-c", "sleep 30 & exit 0"])
            .current_dir(dir.join("wt"))
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = ours.id();
        let mut ours = ours;
        ours.wait().unwrap();
        assert!(
            setup::signal_group(pgid, 0),
            "the orphan's group is alive with its leader gone"
        );

        let elsewhere = tmp();
        let mut stranger = Command::new("sleep")
            .arg("30")
            .current_dir(&elsewhere)
            .process_group(0)
            .spawn()
            .unwrap();

        let record = dir.join("runs.json");
        write(
            &record,
            &[
                Live {
                    pgid,
                    worktree: dir.join("wt").to_string_lossy().into_owned(),
                },
                Live {
                    pgid: stranger.id(),
                    worktree: dir.join("wt").to_string_lossy().into_owned(),
                },
            ],
        );
        reap(&record, Duration::from_secs(2));
        thread::sleep(Duration::from_millis(200));
        assert!(!setup::signal_group(pgid, 0), "the orphan survived");
        assert!(stranger.try_wait().unwrap().is_none(), "a stranger's group was stopped");
        assert!(!record.exists());
        let _ = stranger.kill();
    }

    #[test]
    fn launch_drops_run_logs_older_than_a_week_and_keeps_the_rest() {
        let dir = tmp();
        let logs = dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let old_run = logs.join("wt-run-1.log");
        let new_run = logs.join("wt-run-2.log");
        let old_setup = logs.join("wt-setup-1.log");
        for f in [&old_run, &new_run, &old_setup] {
            std::fs::write(f, "x").unwrap();
        }
        let long_ago = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
        for f in [&old_run, &old_setup] {
            std::fs::File::options()
                .write(true)
                .open(f)
                .unwrap()
                .set_modified(long_ago)
                .unwrap();
        }
        prune_logs(&logs, LOG_AGE);
        assert!(!old_run.exists());
        assert!(new_run.exists());
        assert!(old_setup.exists(), "setup logs are not a run's to prune");
    }

    #[test]
    fn start_during_a_stop_waits_and_leaves_one_process() {
        let dir = tmp();
        let wt = dir.join("wt");
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&wt)
            .status()
            .unwrap()
            .success());
        let mut prefs = std::collections::HashMap::new();
        prefs.insert(
            "/the/project".to_string(),
            crate::settings::WorktreePrefs {
                run_command: "trap '' TERM; while true; do sleep 0.1; done".into(),
                ..Default::default()
            },
        );
        setup::seam(prefs, dir.join("logs"));
        start("/the/project", &wt).unwrap();
        thread::sleep(Duration::from_millis(300));
        let first = setup::shared().pid(&wt, Kind::Run).unwrap();
        assert_eq!(start("/the/project", &wt).unwrap().state, State::Running);
        assert_eq!(
            setup::shared().pid(&wt, Kind::Run),
            Some(first),
            "a second start reuses the live run"
        );

        let stopper = {
            let wt = wt.clone();
            thread::spawn(move || setup::shared().stop(&wt, Kind::Run, GRACE, &setup::publisher()))
        };
        thread::sleep(Duration::from_millis(200));
        let again = start("/the/project", &wt).unwrap();
        stopper.join().unwrap();
        assert_eq!(again.state, State::Running);
        assert!(!setup::signal_group(first, 0), "the old run outlived its stop");
        assert_eq!(
            setup::shared()
                .live(Kind::Run)
                .iter()
                .filter(|r| r.worktree == again.worktree)
                .count(),
            1
        );
        assert!(read(&dir.join("logs").join("runs.json"))
            .iter()
            .any(|l| l.worktree == again.worktree));
        stop(&wt);
        let gone = Instant::now() + Duration::from_secs(2);
        while !read(&dir.join("logs").join("runs.json")).is_empty() && Instant::now() < gone {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            read(&dir.join("logs").join("runs.json")).is_empty(),
            "a stopped run leaves the record"
        );
    }

    #[test]
    fn start_refuses_an_empty_command_and_a_fork() {
        let dir = tmp();
        let mut prefs = std::collections::HashMap::new();
        prefs.insert(
            "/the/project".to_string(),
            crate::settings::WorktreePrefs {
                run_command: " ".into(),
                ..Default::default()
            },
        );
        setup::seam(prefs, dir.join("logs"));
        assert!(start("/the/project", &dir.join("wt")).is_err());

        let mut prefs = std::collections::HashMap::new();
        prefs.insert(
            "/the/project".to_string(),
            crate::settings::WorktreePrefs {
                run_command: "sleep 30".into(),
                ..Default::default()
            },
        );
        setup::seam(prefs, dir.join("logs"));
        let err = start("/the/project", &dir.join("wt")).unwrap_err();
        assert!(
            err.contains("fork"),
            "a folder git cannot read is treated as a fork: {err}"
        );
    }
}
