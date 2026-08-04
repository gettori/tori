// Filesystem access for the in-webview editor: directory listing, read/write,
// existence checks, plus a per-project recursive watcher that emits a single
// debounced `fs://changed { paths }` for genuine source edits (churn dirs and
// Sway's own write echo are filtered out elsewhere).

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    // Matched by the repo's .gitignore (nested rules, negations and the global
    // gitignore included). The tree dims these, VS Code-style. False when the
    // directory is not inside a git repo.
    ignored: bool,
}

#[tauri::command]
pub fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
            ignored: false,
        });
    }
    // Dirs first, then case-insensitive name — typical file-tree ordering.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let ignored = gitignored_paths(&path, &entries);
    for e in entries.iter_mut() {
        e.ignored = ignored.contains(&e.path);
    }
    Ok(entries)
}

// Ask git which of these entries are gitignore-matched, in one batch. Uses
// `git check-ignore --stdin` from within `dir`, so the repo's full ignore rules
// apply (already-tracked files are correctly not reported). Any failure (not a
// repo, git missing) yields an empty set, so nothing is dimmed.
fn gitignored_paths(dir: &str, entries: &[DirEntry]) -> std::collections::HashSet<String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut set = std::collections::HashSet::new();
    if entries.is_empty() {
        return set;
    }
    let mut child = match Command::new("git")
        .current_dir(dir)
        .args(["check-ignore", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return set,
    };
    if let Some(mut stdin) = child.stdin.take() {
        for e in entries {
            let _ = writeln!(stdin, "{}", e.path);
        }
        // stdin dropped here -> EOF, so git finishes and we can read stdout
        // without deadlocking on a full pipe.
    }
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(_) => return set,
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let p = line.trim();
        if !p.is_empty() {
            set.insert(p.to_string());
        }
    }
    set
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// One file in a batched write.
#[derive(Deserialize)]
pub struct FileWrite {
    pub path: String,
    pub contents: String,
}

/// Write a whole set of files as one operation, all or nothing.
///
/// A cross-file rename is the caller: it rewrites N files that only mean
/// anything together, and N separate `fs_write_file` calls would fail halfway
/// and leave the tree in a state no one asked for and nothing describes. Every
/// target is checked for writability *before* the first byte is written, so a
/// read-only file or a missing parent directory is an error that changed
/// nothing rather than a half-applied rewrite.
///
/// The check is not a guarantee: another process can revoke a permission
/// between the pre-flight and the write. It removes the failure that actually
/// happens (one unwritable file in a set) rather than pretending to remove all
/// of them, and a write that fails anyway still reports which path it was.
#[tauri::command]
pub fn fs_write_files(files: Vec<FileWrite>) -> Result<Vec<String>, String> {
    for f in &files {
        let path = Path::new(&f.path);
        match std::fs::metadata(path) {
            Ok(meta) => {
                if meta.is_dir() {
                    return Err(format!("{} is a directory, so it can't be written.", f.path));
                }
                if meta.permissions().readonly() {
                    return Err(format!("{} is read-only, so nothing was changed.", f.path));
                }
            }
            Err(_) => {
                // A file the rename would create. Its directory has to exist:
                // this command deliberately does not make directories, because
                // every caller is rewriting files that are already there.
                let parent = path.parent().ok_or_else(|| format!("{} has no parent directory.", f.path))?;
                if !parent.is_dir() {
                    return Err(format!("{} does not exist, so {} can't be written.", parent.display(), f.path));
                }
            }
        }
    }
    let mut written = Vec::with_capacity(files.len());
    for f in &files {
        std::fs::write(&f.path, &f.contents)
            .map_err(|e| format!("Writing {} failed: {e}", f.path))?;
        written.push(f.path.clone());
    }
    Ok(written)
}

// --- containment-scoped mutation commands ---
//
// The editable file trees (the Shared tab's `.shared` root, and the project tree
// rooted at the workspace) create/rename/delete through these commands. They are
// the only write surface for that, and each one is fail-closed: it resolves the
// target and refuses anything that is not inside the passed `root`, so a
// recursive delete can never escape the folder.
//
// The boundary is the caller's `root`, never a name baked in here; `noun` only
// picks the word the refusal uses, so a project-tree refusal reads "outside the
// project folder" and a Shared-tab one reads "outside the shared folder".

/// Canonicalize the deepest existing ancestor of `p`, then re-append the trailing
/// components that do not exist yet. This yields a symlink-resolved absolute path
/// even for a target that has not been created (plain `canonicalize` fails on a
/// missing path, which is exactly the mkdir / rename-destination case).
fn resolve_existing_prefix(p: &Path) -> PathBuf {
    let mut cur = p;
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Ok(c) = std::fs::canonicalize(cur) {
            let mut out = c;
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return out;
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                cur = parent;
            }
            // Nothing along the path canonicalizes: fall back to the lexical
            // form so the caller's containment check still decides (and, with the
            // `..`-rejection below, stays fail-closed).
            _ => return p.to_path_buf(),
        }
    }
}

/// Resolve `path` and confirm it stays within `root` (same-or-nested), returning
/// the resolved target. Fail-closed: rejects any `..` component up front (a
/// not-yet-created target cannot be canonicalized, so a parent-dir escape must be
/// caught lexically) and then compares symlink-resolved absolute forms so a
/// symlink cannot redirect out of `root`. Mirrors `config::is_inside`.
///
/// `noun` names the boundary in the error text, since this now guards two of
/// them: the Shared tab's folder and, for replace-in-files, the project root.
pub(crate) fn ensure_inside_named(root: &str, path: &str, noun: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    if target.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("Refusing a path that escapes the {noun}."));
    }
    let root_real = resolve_existing_prefix(Path::new(root));
    let target_real = resolve_existing_prefix(&target);
    if target_real == root_real || target_real.starts_with(&root_real) {
        Ok(target)
    } else {
        Err(format!("Refusing a path outside the {noun}."))
    }
}

/// The word a refusal names the boundary with. Cosmetic only: containment is
/// decided by `root`, so an unnamed caller still gets the same fail-closed
/// answer, just a vaguer sentence.
fn ensure_inside(root: &str, path: &str, noun: Option<&str>) -> Result<PathBuf, String> {
    ensure_inside_named(root, path, noun.unwrap_or("workspace folder"))
}

/// `mkdir -p` a directory inside `root` (used to create `.shared` on first add).
#[tauri::command]
pub fn fs_mkdir(root: String, path: String, noun: Option<String>) -> Result<(), String> {
    let p = ensure_inside(&root, &path, noun.as_deref())?;
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())
}

/// How a delete disposes of its target, so the suite can watch a delete happen
/// without a test ever reaching the developer's real Trash.
///
/// This exists because the interesting assertion is negative: *nothing here
/// unlinks*. A recording disposer leaves the file on disk, so a stray
/// `remove_file`/`remove_dir_all` creeping back into the command would fail the
/// test by making the file disappear.
pub(crate) trait Disposer {
    fn dispose(&self, p: &Path) -> Result<(), String>;
}

/// The only disposer production uses: the macOS Trash, never `rm`.
pub(crate) struct TrashDisposer;

impl Disposer for TrashDisposer {
    fn dispose(&self, p: &Path) -> Result<(), String> {
        trash::delete(p).map_err(|e| format!("Moving {} to the Trash failed: {e}", p.display()))
    }
}

/// Move a file or directory inside `root` to the Trash. `symlink_metadata` does
/// not follow, so a symlink is checked as a link and trashed as one, never
/// followed into. A missing target is an error, as it was when this unlinked.
fn fs_delete_with(
    root: &str,
    path: &str,
    noun: Option<&str>,
    disposer: &dyn Disposer,
) -> Result<(), String> {
    let p = ensure_inside(root, path, noun)?;
    std::fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
    disposer.dispose(&p)
}

#[tauri::command]
pub fn fs_delete(root: String, path: String, noun: Option<String>) -> Result<(), String> {
    fs_delete_with(&root, &path, noun.as_deref(), &TrashDisposer)
}

/// Rename `from` to `to`, both required to stay inside `root`. Refuses to
/// overwrite: `std::fs::rename` would silently replace an existing destination
/// file, so an existing `to` is rejected up front (no clobber, no data loss).
#[tauri::command]
pub fn fs_rename(root: String, from: String, to: String, noun: Option<String>) -> Result<(), String> {
    let f = ensure_inside(&root, &from, noun.as_deref())?;
    let t = ensure_inside(&root, &to, noun.as_deref())?;
    if t.symlink_metadata().is_ok() {
        return Err("A file or folder with that name already exists.".into());
    }
    std::fs::rename(&f, &t).map_err(|e| e.to_string())
}

/// All project files (paths relative to `project_path`) for the quick-open
/// finder. Prefers `git ls-files` (respects .gitignore, lists tracked +
/// untracked-not-ignored); falls back to a recursive walk skipping the churn
/// dirs for a non-git project.
#[tauri::command]
pub fn list_project_files(project_path: String) -> Result<Vec<String>, String> {
    if let Ok(out) = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            return Ok(text.lines().filter(|l| !l.is_empty()).map(String::from).collect());
        }
    }
    let root = PathBuf::from(&project_path);
    let mut files = Vec::new();
    walk_files(&root, &root, &mut files);
    Ok(files)
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if IGNORED_DIRS.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            walk_files(root, &path, out);
        } else if ft.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().into_owned());
            }
        }
    }
}

pub struct FsWatch(pub Mutex<Option<RecommendedWatcher>>);

impl Default for FsWatch {
    fn default() -> Self {
        FsWatch(Mutex::new(None))
    }
}

/// Directories whose churn must never reach the editor panes: VCS internals and
/// build output. Terminal-driven git/build/install touch these constantly and a
/// match here means "skip" so follow-mode and the git gutter only react to real
/// source edits. (Best-effort gitignore beyond this explicit list is deferred.)
/// `.sway-attempts` is here for a different reason than the rest: it is not
/// build output, it is several whole worktrees. Creating three attempts writes
/// three checkouts plus three cloned dependency trees inside the project, and
/// without this the watcher would report every one of those files as a change
/// to the project the user is actually looking at.
const IGNORED_DIRS: &[&str] =
    &[".git", "node_modules", "dist", "target", crate::attempts::ATTEMPTS_DIR];

fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        matches!(c, std::path::Component::Normal(os)
            if os.to_str().map(|s| IGNORED_DIRS.contains(&s)).unwrap_or(false))
    })
}

#[derive(Clone, Serialize)]
struct FsChanged {
    paths: Vec<String>,
}

/// Install a recursive watcher on the open project dir. Filtered events flow
/// through a channel into a trailing-edge debounce thread that emits one
/// `fs://changed { paths }` per burst. Idempotent: re-installing replaces the
/// previous watcher (dropping it tears down its debounce thread via the closed
/// channel). Mirrors `config_watch_start` / `sessions_watch_start`.
#[tauri::command]
pub fn fs_watch_start(
    app: AppHandle,
    state: State<FsWatch>,
    project_path: String,
) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }

    // notify handler -> channel -> debounce thread -> single batched emit.
    let (tx, rx) = mpsc::channel::<PathBuf>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for p in event.paths {
                if !is_ignored(&p) {
                    let _ = tx.send(p);
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Trailing-edge debounce: collect a burst, emit once it goes quiet for
    // 250ms. recv() returns Err when the watcher (and its sender) is dropped,
    // which is how a replaced watcher cleanly ends this thread.
    let app_handle = app.clone();
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch: BTreeSet<PathBuf> = BTreeSet::new();
            batch.insert(first);
            while let Ok(next) = rx.recv_timeout(Duration::from_millis(250)) {
                batch.insert(next);
            }
            let paths: Vec<String> = batch
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                let _ = app_handle.emit("fs://changed", FsChanged { paths });
            }
        }
    });

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records what would have been trashed and disposes of nothing, so the
    /// suite never touches the developer's real Trash. Because it leaves the
    /// file on disk, every delete test doubles as a check that the command body
    /// itself does not unlink.
    #[derive(Default)]
    struct Recorder(Mutex<Vec<PathBuf>>);

    impl Disposer for Recorder {
        fn dispose(&self, p: &Path) -> Result<(), String> {
            self.0.lock().unwrap().push(p.to_path_buf());
            Ok(())
        }
    }

    impl Recorder {
        fn taken(&self) -> Vec<PathBuf> {
            self.0.lock().unwrap().clone()
        }
    }

    #[test]
    fn ignored_dirs_filtered_anywhere_in_path() {
        assert!(is_ignored(Path::new("/p/.git/index")));
        // An attempt is a whole second checkout inside the project, so its churn
        // must not read as a change to the project the user is looking at.
        assert!(is_ignored(Path::new("/p/.sway-attempts/try-1/src/main.rs")));
        assert!(is_ignored(Path::new("/p/node_modules/x/y.js")));
        assert!(is_ignored(Path::new("/p/dist/bundle.js")));
        assert!(is_ignored(Path::new("/p/src-tauri/target/debug/foo")));
        assert!(!is_ignored(Path::new("/p/src/App.tsx")));
        // A substring of an ignored name must not match.
        assert!(!is_ignored(Path::new("/p/src/distance.ts")));
    }

    #[test]
    fn fs_commands_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sway-fs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hello.txt");
        let fp = file.to_string_lossy().into_owned();

        assert!(!file_exists(fp.clone()));
        fs_write_file(fp.clone(), "hi".into()).unwrap();
        assert!(file_exists(fp.clone()));
        assert_eq!(fs_read_file(fp.clone()).unwrap(), "hi");

        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let entries = fs_read_dir(dir.to_string_lossy().into_owned()).unwrap();
        // Dir sorts before file.
        assert_eq!(entries[0].name, "sub");
        assert!(entries[0].is_dir);
        assert!(entries.iter().any(|e| e.name == "hello.txt" && !e.is_dir));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn write(path: &Path, contents: &str) -> FileWrite {
        FileWrite {
            path: path.to_string_lossy().into_owned(),
            contents: contents.into(),
        }
    }

    #[test]
    fn a_batched_write_is_all_or_nothing() {
        // The failure this exists to prevent: a cross-file rename that rewrites
        // four files and dies on the fifth, leaving a tree that compiles nowhere
        // and that nothing describes.
        let dir = std::env::temp_dir().join(format!("sway-fs-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.ts");
        let b = dir.join("b.ts");
        std::fs::write(&a, "old a").unwrap();
        std::fs::write(&b, "old b").unwrap();

        let written = fs_write_files(vec![write(&a, "new a"), write(&b, "new b")]).unwrap();
        assert_eq!(written.len(), 2);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "new a");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "new b");

        // One unwritable target aborts the whole set, and the writable file it
        // was listed *after* is untouched: the pre-flight runs before any write,
        // not per file as it goes.
        let ro = dir.join("locked.ts");
        std::fs::write(&ro, "locked").unwrap();
        let mut perms = std::fs::metadata(&ro).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&ro, perms).unwrap();

        let err = fs_write_files(vec![write(&a, "should not land"), write(&ro, "nor this")])
            .unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        assert!(err.contains("locked.ts"), "{err}");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "new a");

        // A target whose directory does not exist is the same kind of refusal.
        let orphan = dir.join("nope").join("c.ts");
        let err = fs_write_files(vec![write(&a, "should not land"), write(&orphan, "x")]).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "new a");

        let mut perms = std::fs::metadata(&ro).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&ro, perms).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_batched_write_creates_a_file_whose_directory_exists() {
        // A rename can introduce a file only in theory, but the command must not
        // refuse a target that simply is not there yet.
        let dir = std::env::temp_dir().join(format!("sway-fs-batch-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fresh = dir.join("fresh.ts");

        fs_write_files(vec![write(&fresh, "hello")]).unwrap();
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "hello");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scoped_mutations_stay_inside_root() {
        let base = std::env::temp_dir().join(format!("sway-fs-scope-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join(".shared");
        let root_s = root.to_string_lossy().into_owned();

        // mkdir auto-creates the root and a nested dir.
        let nested = root.join("cfg");
        fs_mkdir(root_s.clone(), nested.to_string_lossy().into_owned(), None).unwrap();
        assert!(nested.is_dir());

        // A file created and then renamed inside the root.
        let f = root.join("a.txt");
        fs_write_file(f.to_string_lossy().into_owned(), "hi".into()).unwrap();
        let f2 = root.join("b.txt");
        fs_rename(
            root_s.clone(),
            f.to_string_lossy().into_owned(),
            f2.to_string_lossy().into_owned(),
            None,
        )
        .unwrap();
        assert!(!f.exists() && f2.exists());

        // Rename never clobbers: an existing destination is refused.
        let occupied = root.join("occupied.txt");
        std::fs::write(&occupied, "keep").unwrap();
        assert!(fs_rename(
            root_s.clone(),
            f2.to_string_lossy().into_owned(),
            occupied.to_string_lossy().into_owned(),
            None,
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&occupied).unwrap(), "keep");

        // A directory inside the root is handed to the disposer, not unlinked.
        // The disposer gets the caller's path, not a resolved one: containment
        // resolves symlinks to *decide*, then hands back what was asked for.
        let rec = Recorder::default();
        fs_delete_with(&root_s, &nested.to_string_lossy(), None, &rec).unwrap();
        assert_eq!(rec.taken(), vec![nested.clone()]);
        assert!(nested.exists(), "the command itself must never unlink");

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scoped_mutations_refuse_outside_root() {
        let base = std::env::temp_dir().join(format!("sway-fs-escape-{}", std::process::id()));
        let root = base.join(".shared");
        std::fs::create_dir_all(&root).unwrap();
        let root_s = root.to_string_lossy().into_owned();

        // A `..` escape is rejected up front, before anything reaches a disposer.
        let rec = Recorder::default();
        let via_parent = root.join("../secret.txt");
        assert!(fs_delete_with(&root_s, &via_parent.to_string_lossy(), None, &rec).is_err());
        assert!(fs_mkdir(root_s.clone(), via_parent.to_string_lossy().into_owned(), None).is_err());

        // A sibling absolute path outside the root is rejected too.
        let sibling = base.join("outside.txt");
        std::fs::write(&sibling, "x").unwrap();
        assert!(fs_delete_with(&root_s, &sibling.to_string_lossy(), None, &rec).is_err());
        assert!(sibling.exists(), "the outside file must be untouched");
        assert!(rec.taken().is_empty(), "containment must refuse before disposal");

        // A rename whose destination escapes the root is refused.
        let inside = root.join("keep.txt");
        std::fs::write(&inside, "y").unwrap();
        assert!(fs_rename(
            root_s.clone(),
            inside.to_string_lossy().into_owned(),
            sibling.to_string_lossy().into_owned(),
            None,
        )
        .is_err());

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_project_root_is_contained_the_same_way_a_shared_folder_is() {
        // The boundary was hard-wired to `.shared` in name only; the project tree
        // passes its workspace as `root` and must be fenced identically. A repo
        // checkout is the realistic shape: a dotfile-free root with real siblings
        // next to it, where an escape lands on someone else's worktree.
        let base = std::env::temp_dir().join(format!("sway-fs-project-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("my-repo");
        std::fs::create_dir_all(project.join("src")).unwrap();
        let project_s = project.to_string_lossy().into_owned();

        // A sibling worktree is what an escape would reach.
        let sibling = base.join("other-worktree");
        std::fs::create_dir_all(&sibling).unwrap();
        let secret = sibling.join("secret.txt");
        std::fs::write(&secret, "not yours").unwrap();

        // `..` out of the project is refused, and the refusal names the project.
        let rec = Recorder::default();
        let escape = project.join("../other-worktree/secret.txt");
        let err = fs_delete_with(&project_s, &escape.to_string_lossy(), Some("project folder"), &rec)
            .unwrap_err();
        assert!(err.contains("project folder"), "{err}");
        assert!(secret.exists(), "the sibling worktree must be untouched");

        // So is an absolute path that never mentions `..`.
        assert!(
            fs_delete_with(&project_s, &secret.to_string_lossy(), Some("project folder"), &rec).is_err()
        );
        assert!(secret.exists());
        assert!(rec.taken().is_empty(), "no refused path may reach the Trash");

        // A rename that would carry a file out of the project is refused.
        let inside = project.join("src").join("main.rs");
        std::fs::write(&inside, "fn main() {}").unwrap();
        assert!(fs_rename(
            project_s.clone(),
            inside.to_string_lossy().into_owned(),
            sibling.join("stolen.rs").to_string_lossy().into_owned(),
            Some("project folder".into()),
        )
        .is_err());
        assert!(inside.exists(), "a refused rename must not move the source");

        // And the ordinary in-project case still works, so the fence is a fence
        // and not a wall: nested create, then rename within the project.
        let nested = project.join("src").join("utils");
        fs_mkdir(project_s.clone(), nested.to_string_lossy().into_owned(), Some("project folder".into()))
            .unwrap();
        assert!(nested.is_dir());
        fs_rename(
            project_s.clone(),
            inside.to_string_lossy().into_owned(),
            project.join("src").join("lib.rs").to_string_lossy().into_owned(),
            Some("project folder".into()),
        )
        .unwrap();
        assert!(project.join("src").join("lib.rs").exists());

        // An unnamed caller is fenced identically, only the wording is vaguer.
        let err = fs_delete_with(&project_s, &secret.to_string_lossy(), None, &rec).unwrap_err();
        assert!(err.contains("workspace folder"), "{err}");

        // A file inside the project does reach the disposer, so the fence is not
        // what makes the earlier refusals pass.
        let doomed = project.join("src").join("lib.rs");
        fs_delete_with(&project_s, &doomed.to_string_lossy(), Some("project folder"), &rec).unwrap();
        assert_eq!(rec.taken(), vec![doomed.clone()]);

        std::fs::remove_dir_all(&base).unwrap();
    }
}
