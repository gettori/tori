//! Where command bodies run. The IPC thread must never block: a command that
//! spawns a subprocess, walks a directory, or takes a lock someone else holds
//! goes through here instead of running inline in the handler.
//!
//! `blocking` moves a body onto the runtime's blocking pool and, when tracing
//! is on, logs the body's own span with the thread that actually ran it. The
//! `trace::traced` wrapper cannot see this: for an async command the generated
//! handler returns at spawn time, so its `cmd` line measures dispatch, and the
//! `body` line written here is the real work.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use crate::trace;

/// Start a command whose result nobody reads, and reap it when it ends.
///
/// A `Child` dropped without a `wait` stays a zombie until Tori quits.
pub fn spawn_detached(cmd: &mut Command) -> std::io::Result<()> {
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// What a refused [`git_in`] prints, which is `trust::UNTRUSTED`.
const REFUSE: &str = "echo untrusted >&2; exit 128";

/// `git -C <repo>`, or a command that fails with `untrusted` when `repo` is not
/// a trusted project.
///
/// Git runs a repository's own `.git/config` (`core.fsmonitor`, filter drivers,
/// hooks), so reading one is running it. A stand-in rather than an error, so
/// each of the ninety call sites keeps reporting failure the way it already did.
pub fn git_in(repo: impl AsRef<std::ffi::OsStr>) -> Command {
    let repo = repo.as_ref();
    git_gated(repo, crate::trust::allows_git(std::path::Path::new(repo)))
}

fn git_gated(repo: &std::ffi::OsStr, allowed: bool) -> Command {
    #[cfg(test)]
    count_git(repo);
    if !allowed {
        let mut refused = Command::new("/bin/sh");
        refused.args(["-c", REFUSE, "git"]);
        return refused;
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo);
    cmd
}

// Keyed by repo path rather than thread local: the sidebar probe and the
// batched sync spawn git on worker threads, and parallel tests each read only
// the paths under their own tempdir.
#[cfg(test)]
static GIT_SPAWNS: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();

#[cfg(test)]
fn count_git(repo: &std::ffi::OsStr) {
    let spawns = GIT_SPAWNS.get_or_init(Default::default);
    *spawns
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(PathBuf::from(repo))
        .or_default() += 1;
}

/// Every git process built for a repo under `dir` so far.
#[cfg(test)]
pub(crate) fn git_spawns_under(dir: &std::path::Path) -> usize {
    let spawns = GIT_SPAWNS.get_or_init(Default::default);
    let spawns = spawns.lock().unwrap_or_else(PoisonError::into_inner);
    spawns
        .iter()
        .filter(|(repo, _)| repo.starts_with(dir))
        .map(|(_, n)| n)
        .sum()
}

/// `git` for a subcommand that opens no repository, so there is no config of
/// anyone else's to run.
pub fn git_outside_a_repo() -> Command {
    Command::new("git")
}

/// Run `f` on the blocking pool and await its result.
///
/// `spawn_blocking` rather than `#[tauri::command(async)]`: the attribute form
/// runs a sync body inside `async_runtime::spawn`, pinning a tokio worker for
/// the duration, and it leaves no seam to log the body span from.
pub async fn blocking<T: Send + 'static>(name: &'static str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let task = tauri::async_runtime::spawn_blocking(move || {
        if !trace::enabled() {
            return f();
        }
        let enter = trace::now_ms();
        let out = f();
        trace::body_span(name, enter, trace::now_ms());
        out
    });
    // Err only if `f` panicked; re-panicking here keeps the same "this command
    // is broken" loudness an inline panic had, without taking the app down.
    task.await.expect("blocking command panicked")
}

/// `blocking`, plus the repository write lock for `project_path`.
///
/// Git takes its own locks (`index.lock`, per-ref locks) but *fails* on
/// contention instead of waiting, and the single-threaded IPC dispatch that
/// used to make contention impossible is gone. Every command that writes to a
/// repository goes through here so concurrent writes queue instead of erroring.
/// A std mutex, not an async one: the wait happens on the blocking pool, where
/// blocking is the whole point.
pub async fn git_write<T: Send + 'static>(
    name: &'static str,
    project_path: String,
    f: impl FnOnce() -> T + Send + 'static,
) -> T {
    blocking(name, move || {
        let lock = repo_lock(&project_path);
        let _g = lock.lock().unwrap_or_else(PoisonError::into_inner);
        f()
    })
    .await
}

type LockMap<K> = Mutex<HashMap<K, Arc<Mutex<()>>>>;

static REPO_LOCKS: OnceLock<LockMap<PathBuf>> = OnceLock::new();
static COMMON_DIRS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

/// The write lock for the repository containing `path`. Keyed by the resolved
/// git common dir, so every worktree of one repo shares the lock its shared
/// `.git` already implies. Also used directly by commands that finish on their
/// own thread (`git_fetch`, `git_push`): they take the lock inside that thread
/// rather than through `git_write`.
pub fn repo_lock(path: &str) -> RepoLock {
    let key = common_dir(path);
    let locks = REPO_LOCKS.get_or_init(Default::default);
    let mut map = locks.lock().unwrap_or_else(PoisonError::into_inner);
    RepoLock {
        mutex: map.entry(key.clone()).or_default().clone(),
        file: key.join("HEAD").exists().then(|| key.join("tori.lock")),
    }
}

/// The app and the daemon both write to a repository, so the mutex that orders
/// one process's writes is backed by a `flock` that orders the two.
pub struct RepoLock {
    mutex: Arc<Mutex<()>>,
    file: Option<PathBuf>,
}

pub struct RepoGuard<'a> {
    _held: std::sync::MutexGuard<'a, ()>,
    _file: Option<std::fs::File>,
}

impl RepoLock {
    pub fn lock(&self) -> std::sync::LockResult<RepoGuard<'_>> {
        let (held, poisoned) = match self.mutex.lock() {
            Ok(held) => (held, false),
            Err(e) => (e.into_inner(), true),
        };
        let guard = RepoGuard {
            _held: held,
            _file: self.file.as_deref().and_then(|f| flock(f, true)),
        };
        if poisoned {
            Err(PoisonError::new(guard))
        } else {
            Ok(guard)
        }
    }

    pub fn try_lock(&self) -> Option<RepoGuard<'_>> {
        let held = self.mutex.try_lock().ok()?;
        let file = match self.file.as_deref() {
            Some(path) => Some(flock(path, false)?),
            None => None,
        };
        Some(RepoGuard {
            _held: held,
            _file: file,
        })
    }

    #[cfg(test)]
    fn same(&self, other: &RepoLock) -> bool {
        Arc::ptr_eq(&self.mutex, &other.mutex)
    }
}

// An unwritable `.git` goes unlocked, as it was.
pub(crate) fn flock(path: &std::path::Path, wait: bool) -> Option<std::fs::File> {
    use std::os::fd::AsRawFd;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .ok()?;
    let how = if wait {
        libc::LOCK_EX
    } else {
        libc::LOCK_EX | libc::LOCK_NB
    };
    // SAFETY: the fd is open for as long as `file` lives, which outlives the call.
    (unsafe { libc::flock(file.as_raw_fd(), how) } == 0).then_some(file)
}

/// Resolved once per path and cached: the switch path calls into here often,
/// and the answer only changes when a repository is created where none was.
/// `git_init`/`bare_init` call `forget_common_dir` for exactly that case.
pub(crate) fn common_dir(path: &str) -> PathBuf {
    let cache = COMMON_DIRS.get_or_init(Default::default);
    if let Some(hit) = cache.lock().unwrap_or_else(PoisonError::into_inner).get(path) {
        return hit.clone();
    }
    let resolved = crate::exec::git_in(path)
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| {
            let p = PathBuf::from(&s);
            let abs = if p.is_absolute() {
                p
            } else {
                PathBuf::from(path).join(p)
            };
            abs.canonicalize().unwrap_or(abs)
        })
        // Not a repo: key by the path itself, so the lock still exists.
        .unwrap_or_else(|| PathBuf::from(path));
    cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(path.to_string(), resolved.clone());
    resolved
}

static NAMED_LOCKS: OnceLock<LockMap<&'static str>> = OnceLock::new();

/// A process-wide lock for one load-modify-save store (`"config"`,
/// `"settings"`, ...). These read-a-file, edit, write-it-back flows were only
/// ever safe because the single IPC thread serialized them; now that commands
/// run concurrently, each store's mutators take its named lock so two of them
/// cannot interleave and drop one another's edit.
pub fn named_lock(name: &'static str) -> Arc<Mutex<()>> {
    let locks = NAMED_LOCKS.get_or_init(Default::default);
    let mut map = locks.lock().unwrap_or_else(PoisonError::into_inner);
    map.entry(name).or_default().clone()
}

static STORE_LOCKS: OnceLock<Mutex<HashMap<&'static str, &'static Mutex<()>>>> = OnceLock::new();

pub struct StoreLock {
    _file: std::fs::File,
    _held: std::sync::MutexGuard<'static, ()>,
}

/// [`named_lock`] across processes: the window and the daemon each write
/// `"config"` and `"sessions-store"`.
pub fn cross_process_store_lock(name: &'static str) -> Result<StoreLock, String> {
    store_lock_at(name, &crate::owned_state::config_dir().join(format!("{name}.lock")))
}

// The flock is on a sidecar nothing renames: a store is replaced by a rename,
// which would leave a lock on the store itself held on the old file.
fn store_lock_at(name: &'static str, path: &std::path::Path) -> Result<StoreLock, String> {
    let mutex = {
        let locks = STORE_LOCKS.get_or_init(Default::default);
        let mut map = locks.lock().unwrap_or_else(PoisonError::into_inner);
        *map.entry(name).or_insert_with(|| Box::leak(Box::default()))
    };
    let held = mutex.lock().unwrap_or_else(PoisonError::into_inner);
    let file = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(path)
        })
        .and_then(|file| file.lock().map(|()| file))
        .map_err(|e| format!("locking {name} at {}: {e}", path.display()))?;
    Ok(StoreLock {
        _file: file,
        _held: held,
    })
}

/// Drop the cached common dir for `path`. For `git_init`/`bare_init`, which
/// change the answer after the cache has already learned "not a repo".
pub fn forget_common_dir(path: &str) {
    if let Some(cache) = COMMON_DIRS.get() {
        cache.lock().unwrap_or_else(PoisonError::into_inner).remove(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn append(store: &std::path::Path, edit: &str) {
        let before = std::fs::read_to_string(store).unwrap_or_default();
        let temp = store.with_extension(format!("tmp-{edit}"));
        std::fs::write(&temp, before + edit).unwrap();
        std::fs::rename(temp, store).unwrap();
    }

    #[test]
    fn a_store_lock_keeps_another_process_out_between_a_read_and_its_write() {
        const CHILD: &str = "TORI_STORE_LOCK_CHILD";
        if let Ok(dir) = std::env::var(CHILD) {
            let dir = std::path::Path::new(&dir);
            std::fs::write(dir.join("child-ready"), "").unwrap();
            let _lock = store_lock_at("store-lock-test", &dir.join("store.lock")).unwrap();
            append(&dir.join("store"), "b");
            return;
        }
        let dir = std::env::temp_dir().join(format!("tori-store-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("store");
        std::fs::write(&store, "").unwrap();
        let held = store_lock_at("store-lock-test", &dir.join("store.lock")).unwrap();
        let before = std::fs::read_to_string(&store).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "exec::tests::a_store_lock_keeps_another_process_out_between_a_read_and_its_write",
            ])
            .env(CHILD, &dir)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let ready = std::time::Instant::now();
        while !dir.join("child-ready").exists() {
            assert!(
                ready.elapsed() < std::time::Duration::from_secs(30),
                "the second writer never started"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // The child is past its marker; give it the moment it needs to block on the lock.
        std::thread::sleep(std::time::Duration::from_millis(200));
        let temp = store.with_extension("tmp-a");
        std::fs::write(&temp, before + "a").unwrap();
        std::fs::rename(temp, &store).unwrap();
        drop(held);
        assert!(child.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(&store).unwrap(), "ab");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn git(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("git runs")
    }

    #[test]
    fn a_refused_git_never_runs_the_folders_own_config() {
        let dir = temp_repo("hostile");
        let marker = dir.join("ran");
        git(
            &dir,
            &["config", "core.fsmonitor", &format!("touch {}", marker.display())],
        );
        let _ = std::fs::remove_file(&marker);

        let refused = git_gated(dir.as_os_str(), false)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(!refused.status.success());
        assert_eq!(String::from_utf8_lossy(&refused.stderr).trim(), crate::trust::UNTRUSTED);
        assert!(!marker.exists(), "a refused git ran the folder's fsmonitor command");

        let allowed = git_gated(dir.as_os_str(), true)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(allowed.status.success());
        assert!(
            marker.exists(),
            "the fixture is not hostile: git status did not run core.fsmonitor"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_git_starts_outside_the_gate() {
        fn sources(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    sources(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&src, &mut files);
        let spawn = format!("Command::new(\"{}\")", "git");
        let mut outside = Vec::new();
        for file in files.iter().filter(|f| !f.ends_with("exec.rs")) {
            let text = std::fs::read_to_string(file).unwrap();
            let shipped = text.split("#[cfg(test)]").next().unwrap();
            if shipped.contains(&spawn) {
                outside.push(file.strip_prefix(&src).unwrap().display().to_string());
            }
        }
        assert!(
            outside.is_empty(),
            "use `exec::git_in` so the trust gate sees it: {outside:?}"
        );
    }

    fn temp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tori-exec-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(
            &dir,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "--allow-empty",
                "-q",
                "-m",
                "init",
            ],
        );
        dir
    }

    /// The lock is keyed by the common dir, so a linked worktree and the main
    /// checkout must resolve to the same mutex: their writes contend on the
    /// same `.git`.
    #[test]
    fn worktrees_of_one_repo_share_one_lock() {
        let main = temp_repo("share");
        let wt = main.with_file_name(format!("{}-wt", main.file_name().unwrap().to_string_lossy()));
        let out = git(&main, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "wt"]);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let a = repo_lock(main.to_str().unwrap());
        let b = repo_lock(wt.to_str().unwrap());
        assert!(a.same(&b), "worktrees resolved to different locks");

        let other = temp_repo("share-other");
        let c = repo_lock(other.to_str().unwrap());
        assert!(!a.same(&c), "unrelated repos must not share a lock");
    }

    #[test]
    fn the_repo_lock_shuts_out_another_opener() {
        let repo = temp_repo("flock");
        let lock = repo_lock(repo.to_str().unwrap());
        let held = lock.lock().unwrap();
        let file = repo.join(".git").join("tori.lock");
        assert!(flock(&file, false).is_none(), "a second opener got the lock");
        drop(held);
        // A child another test forks holds the fd until it execs.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while flock(&file, false).is_none() {
            assert!(std::time::Instant::now() < deadline, "the lock outlived its guard");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    /// Stage, commit and ref writes fired concurrently on one repo (the commit
    /// and the ref writes from a second worktree): git fails on lock contention
    /// rather than waiting, so zero failures means the serialization works.
    #[test]
    fn concurrent_writes_queue_instead_of_failing() {
        let main = temp_repo("stress");
        let wt = main.with_file_name(format!("{}-wt", main.file_name().unwrap().to_string_lossy()));
        let out = git(
            &main,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "stress-wt"],
        );
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        const ROUNDS: usize = 12;
        let mut handles = Vec::new();

        // Stager: change a file and `git add` it, under the repo lock.
        let dir = main.clone();
        handles.push(std::thread::spawn(move || {
            let path = dir.to_str().unwrap().to_string();
            for i in 0..ROUNDS {
                std::fs::write(dir.join("f.txt"), format!("{i}")).unwrap();
                let p = path.clone();
                let out = tauri::async_runtime::block_on(git_write("test_stage", path.clone(), move || {
                    git(std::path::Path::new(&p), &["add", "f.txt"])
                }));
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            }
        }));

        // Committer: empty commits, under the same lock.
        let dir = main.clone();
        handles.push(std::thread::spawn(move || {
            let path = dir.to_str().unwrap().to_string();
            for _ in 0..ROUNDS {
                let p = path.clone();
                let out = tauri::async_runtime::block_on(git_write("test_commit", path.clone(), move || {
                    git(
                        std::path::Path::new(&p),
                        &[
                            "-c",
                            "user.email=t@t",
                            "-c",
                            "user.name=t",
                            "commit",
                            "--allow-empty",
                            "-q",
                            "-m",
                            "x",
                        ],
                    )
                }));
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            }
        }));

        // Checkpoint-shaped ref writes from the second worktree of the repo:
        // shared ref store, so these contend with the commits above.
        let dir = wt.clone();
        handles.push(std::thread::spawn(move || {
            let path = dir.to_str().unwrap().to_string();
            for i in 0..ROUNDS {
                let refname = format!("refs/tori/test/{i}");
                let p = path.clone();
                let out = tauri::async_runtime::block_on(git_write("test_ref", path.clone(), move || {
                    git(std::path::Path::new(&p), &["update-ref", &refname, "HEAD"])
                }));
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            }
        }));

        // Readers: the real status and diff bodies, off the lock, interleaved
        // with the writes. Status is what forced `--no-optional-locks` into
        // its body (a plain status takes index.lock opportunistically and the
        // concurrent stage or commit then fails on it); diff rides along
        // because it refreshes the index the same opportunistic way.
        let dir = main.clone();
        handles.push(std::thread::spawn(move || {
            let path = dir.to_str().unwrap();
            for _ in 0..ROUNDS {
                crate::git::git_status_body(path).expect("status read failed");
                crate::git::git_diff_file_body(path.to_string(), "f.txt".into(), None).expect("diff read failed");
            }
        }));

        for h in handles {
            h.join().expect("a stress thread panicked");
        }
    }

    #[test]
    fn counts_git_spawns_from_any_thread_by_repo_path() {
        let dir = std::env::temp_dir().join(format!("tori-git-spawns-{}", std::process::id()));
        let other = std::env::temp_dir().join(format!("tori-git-spawns-other-{}", std::process::id()));
        let paths = [dir.join("proj/main"), dir.join("proj/.bare"), dir.join("proj/feature")];
        let handles: Vec<_> = paths
            .into_iter()
            .map(|p| std::thread::spawn(move || drop(git_in(&p))))
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(git_spawns_under(&dir), 3);
        assert_eq!(git_spawns_under(&other), 0);
    }
}
