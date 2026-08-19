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

/// Run `f` on the blocking pool and await its result.
///
/// `spawn_blocking` rather than `#[tauri::command(async)]`: the attribute form
/// runs a sync body inside `async_runtime::spawn`, pinning a tokio worker for
/// the duration, and it leaves no seam to log the body span from.
pub async fn blocking<T: Send + 'static>(
    name: &'static str,
    f: impl FnOnce() -> T + Send + 'static,
) -> T {
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
pub fn repo_lock(path: &str) -> Arc<Mutex<()>> {
    let key = common_dir(path);
    let locks = REPO_LOCKS.get_or_init(Default::default);
    let mut map = locks.lock().unwrap_or_else(PoisonError::into_inner);
    map.entry(key).or_default().clone()
}

/// Resolved once per path and cached: the switch path calls into here often,
/// and the answer only changes when a repository is created where none was.
/// `git_init`/`bare_init` call `forget_common_dir` for exactly that case.
fn common_dir(path: &str) -> PathBuf {
    let cache = COMMON_DIRS.get_or_init(Default::default);
    if let Some(hit) = cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(path)
    {
        return hit.clone();
    }
    let resolved = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| {
            let p = PathBuf::from(&s);
            let abs = if p.is_absolute() { p } else { PathBuf::from(path).join(p) };
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

/// Drop the cached common dir for `path`. For `git_init`/`bare_init`, which
/// change the answer after the cache has already learned "not a repo".
pub fn forget_common_dir(path: &str) {
    if let Some(cache) = COMMON_DIRS.get() {
        cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("git runs")
    }

    fn temp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sway-exec-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);
        dir
    }

    /// The lock is keyed by the common dir, so a linked worktree and the main
    /// checkout must resolve to the same mutex: their writes contend on the
    /// same `.git`.
    #[test]
    fn worktrees_of_one_repo_share_one_lock() {
        let main = temp_repo("share");
        let wt = main.with_file_name(format!(
            "{}-wt",
            main.file_name().unwrap().to_string_lossy()
        ));
        let out = git(&main, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "wt"]);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let a = repo_lock(main.to_str().unwrap());
        let b = repo_lock(wt.to_str().unwrap());
        assert!(Arc::ptr_eq(&a, &b), "worktrees resolved to different locks");

        let other = temp_repo("share-other");
        let c = repo_lock(other.to_str().unwrap());
        assert!(!Arc::ptr_eq(&a, &c), "unrelated repos must not share a lock");
    }

    /// Stage, commit and ref writes fired concurrently on one repo (the commit
    /// and the ref writes from a second worktree): git fails on lock contention
    /// rather than waiting, so zero failures means the serialization works.
    #[test]
    fn concurrent_writes_queue_instead_of_failing() {
        let main = temp_repo("stress");
        let wt = main.with_file_name(format!(
            "{}-wt",
            main.file_name().unwrap().to_string_lossy()
        ));
        let out = git(&main, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "stress-wt"]);
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
                let out = tauri::async_runtime::block_on(git_write(
                    "test_stage",
                    path.clone(),
                    move || git(std::path::Path::new(&p), &["add", "f.txt"]),
                ));
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            }
        }));

        // Committer: empty commits, under the same lock.
        let dir = main.clone();
        handles.push(std::thread::spawn(move || {
            let path = dir.to_str().unwrap().to_string();
            for _ in 0..ROUNDS {
                let p = path.clone();
                let out = tauri::async_runtime::block_on(git_write(
                    "test_commit",
                    path.clone(),
                    move || {
                        git(std::path::Path::new(&p), &[
                            "-c", "user.email=t@t", "-c", "user.name=t",
                            "commit", "--allow-empty", "-q", "-m", "x",
                        ])
                    },
                ));
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            }
        }));

        // Checkpoint-shaped ref writes from the second worktree of the repo:
        // shared ref store, so these contend with the commits above.
        let dir = wt.clone();
        handles.push(std::thread::spawn(move || {
            let path = dir.to_str().unwrap().to_string();
            for i in 0..ROUNDS {
                let refname = format!("refs/sway/test/{i}");
                let p = path.clone();
                let out = tauri::async_runtime::block_on(git_write(
                    "test_ref",
                    path.clone(),
                    move || git(std::path::Path::new(&p), &["update-ref", &refname, "HEAD"]),
                ));
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
                crate::git::git_diff_file_body(path.to_string(), "f.txt".into(), None)
                    .expect("diff read failed");
            }
        }));

        for h in handles {
            h.join().expect("a stress thread panicked");
        }
    }
}
