// Filesystem access for the in-webview editor: directory listing, read/write,
// existence checks, plus an LRU of per-root recursive watchers that emit a
// single debounced `fs://changed { root, paths }` for genuine source edits in
// the selected root (churn dirs and Sway's own write echo are filtered out
// elsewhere; background roots keep their watcher but stay silent).

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
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
pub async fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    crate::exec::blocking("fs_read_dir", move || fs_read_dir_body(&path)).await
}

pub(crate) fn fs_read_dir_body(path: &str) -> Result<Vec<DirEntry>, String> {
    let mut entries = read_sorted(path)?;
    let ignored = gitignored_paths(path, entries.iter().map(|e| e.path.as_str()));
    for e in entries.iter_mut() {
        e.ignored = ignored.contains(&e.path);
    }
    Ok(entries)
}

/// A directory's entries, dirs first then case-insensitive name (typical
/// file-tree ordering), with `ignored` not yet filled in.
fn read_sorted(path: &str) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
            ignored: false,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// One row of a compacted listing: the entry the row acts on (the deepest
/// element of a collapsed single-child chain) plus the label that names the
/// whole chain (`src/utils/helpers`).
#[derive(Serialize)]
pub struct CompactRow {
    name: String,
    path: String,
    is_dir: bool,
    ignored: bool,
    label: String,
}

/// A chain longer than this is not a package layout, it is something
/// generated, and walking it would turn one listing into a subtree walk.
const MAX_COMPACT_DEPTH: usize = 8;

/// The file tree's listing, compacted backend-side.
///
/// This used to be a frontend loop: list the dir, then list every child dir to
/// see whether it is a single-child chain, each listing paying its own
/// `git check-ignore` spawn. One switch cost ~33 `fs_read_dir` invokes. Here
/// the walk is local reads, and every candidate the chain walk touched is
/// tested in one batched `check-ignore --stdin` spawn at the end.
///
/// `hidden` is the frontend's hidden-name set, passed in so the chain rule
/// ("exactly one visible child, and it is a directory") stays owned by the
/// caller that filters those names out of what it draws.
#[tauri::command]
pub async fn fs_read_dir_compact(
    path: String,
    compact: bool,
    hidden: Vec<String>,
) -> Result<Vec<CompactRow>, String> {
    crate::exec::blocking("fs_read_dir_compact", move || {
        fs_read_dir_compact_body(&path, compact, &hidden)
    })
    .await
}

fn fs_read_dir_compact_body(
    path: &str,
    compact: bool,
    hidden: &[String],
) -> Result<Vec<CompactRow>, String> {
    let visible = |es: Vec<DirEntry>| -> Vec<DirEntry> {
        es.into_iter().filter(|e| !hidden.iter().any(|h| h == &e.name)).collect()
    };
    let base = visible(read_sorted(path)?);

    // Walk each directory's single-child chain first, unconditionally, and
    // test ignores after: a chain breaks at the first dir with two children,
    // so walking before knowing what is ignored costs a few extra `read_dir`s
    // and buys the single batched spawn.
    let mut chains: Vec<Vec<DirEntry>> = Vec::with_capacity(base.len());
    for e in &base {
        let mut chain: Vec<DirEntry> = Vec::new();
        if compact && e.is_dir {
            let mut cur = e.path.clone();
            for _ in 0..MAX_COMPACT_DEPTH {
                let Ok(kids) = read_sorted(&cur) else { break };
                let mut kids = visible(kids);
                if kids.len() != 1 || !kids[0].is_dir {
                    break;
                }
                let link = kids.remove(0);
                cur = link.path.clone();
                chain.push(link);
            }
        }
        chains.push(chain);
    }

    let candidates = base
        .iter()
        .map(|e| e.path.as_str())
        .chain(chains.iter().flatten().map(|e| e.path.as_str()));
    let ignored = gitignored_paths(path, candidates);

    Ok(base
        .iter()
        .zip(&chains)
        .map(|(e, chain)| {
            let mut label = e.name.clone();
            let mut deep = e;
            if !ignored.contains(&e.path) {
                // The chain stops where the frontend's loop did: at the first
                // element check-ignore matched.
                for link in chain {
                    if ignored.contains(&link.path) {
                        break;
                    }
                    label = format!("{label}/{}", link.name);
                    deep = link;
                }
            }
            CompactRow {
                name: deep.name.clone(),
                path: deep.path.clone(),
                is_dir: e.is_dir,
                ignored: ignored.contains(&e.path),
                label,
            }
        })
        .collect())
}

// Ask git which of these entries are gitignore-matched, in one batch. Uses
// `git check-ignore --stdin` from within `dir`, so the repo's full ignore rules
// apply (already-tracked files are correctly not reported). Any failure (not a
// repo, git missing) yields an empty set, so nothing is dimmed.
fn gitignored_paths<'a>(
    dir: &str,
    paths: impl Iterator<Item = &'a str>,
) -> std::collections::HashSet<String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut set = std::collections::HashSet::new();
    let paths: Vec<&str> = paths.collect();
    if paths.is_empty() {
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
        for p in paths {
            let _ = writeln!(stdin, "{p}");
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

#[tauri::command(async)]
pub fn fs_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn fs_write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn fs_delete(root: String, path: String, noun: Option<String>) -> Result<(), String> {
    fs_delete_with(&root, &path, noun.as_deref(), &TrashDisposer)
}

/// Rename `from` to `to`, both required to stay inside `root`. Refuses to
/// overwrite: `std::fs::rename` would silently replace an existing destination
/// file, so an existing `to` is rejected up front (no clobber, no data loss).
#[tauri::command(async)]
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
pub async fn list_project_files(project_path: String) -> Result<Vec<String>, String> {
    crate::exec::blocking("list_project_files", move || list_project_files_body(project_path)).await
}

pub(crate) fn list_project_files_body(project_path: String) -> Result<Vec<String>, String> {
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
        if name == FEATURE_WORKTREES.1 && dir.file_name().is_some_and(|d| d == FEATURE_WORKTREES.0) {
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

/// How many roots keep a live watcher. Mirrors the language-server LRU: the
/// working set is the last few worktrees visited, and a switch back to one of
/// them must not pay a watcher rebuild.
const MAX_WATCHED_ROOTS: usize = 3;

/// One watched root. `muted` is shared with the watcher's event handler and
/// its debounce thread: a background root keeps its watcher installed but
/// emits nothing until it is selected again (a switch refreshes tree and git
/// state anyway, so no catch-up event is needed).
pub(crate) struct WatchEntry {
    root: String,
    muted: Arc<std::sync::atomic::AtomicBool>,
    watcher: Option<RecommendedWatcher>,
}

#[derive(Default, Clone)]
pub struct FsWatch(pub Arc<Mutex<Vec<WatchEntry>>>);

/// LRU bookkeeping for a (re)selected root: moves it to the warm end, unmutes
/// it, mutes the rest, evicts past `cap` (dropping an entry drops its watcher,
/// whose closed channel ends the debounce thread). Answers whether the caller
/// must install a watcher (true only for a root not already in the set).
fn touch_root(entries: &mut Vec<WatchEntry>, root: &str, cap: usize) -> bool {
    use std::sync::atomic::Ordering;
    let existing = entries.iter().position(|e| e.root == root);
    let is_new = existing.is_none();
    let entry = match existing {
        Some(i) => entries.remove(i),
        None => WatchEntry { root: root.to_string(), muted: Arc::default(), watcher: None },
    };
    entries.push(entry);
    if entries.len() > cap {
        entries.drain(..entries.len() - cap);
    }
    for e in entries.iter() {
        e.muted.store(e.root != root, Ordering::Relaxed);
    }
    is_new
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

/// Feature worktrees of a plain repo live under `.sway/worktrees`: whole
/// checkouts, like `.sway-attempts`. A parent-child pair rather than a name in
/// `IGNORED_DIRS`, because `.sway` itself holds the settings overlay.
pub(crate) const FEATURE_WORKTREES: (&str, &str) = (".sway", "worktrees");

fn is_ignored(path: &Path) -> bool {
    let mut prev: Option<&str> = None;
    for c in path.components() {
        let Component::Normal(os) = c else {
            prev = None;
            continue;
        };
        let name = os.to_str();
        if name.is_some_and(|s| IGNORED_DIRS.contains(&s)) {
            return true;
        }
        if prev == Some(FEATURE_WORKTREES.0) && name == Some(FEATURE_WORKTREES.1) {
            return true;
        }
        prev = name;
    }
    false
}

#[derive(Clone, Serialize)]
struct FsChanged {
    /// The watched root the burst came from, so a listener showing another
    /// worktree can drop it instead of refreshing against the wrong tree.
    root: String,
    paths: Vec<String>,
}

/// Install (or re-select) the recursive watcher for a project dir. Watchers
/// live in an LRU of `MAX_WATCHED_ROOTS`: re-selecting a warm root only moves
/// mute flags, so a switch back costs no rebuild; background roots keep their
/// watcher installed and emit nothing. Filtered events flow through a channel
/// into a trailing-edge debounce thread that emits one
/// `fs://changed { root, paths }` per burst.
#[tauri::command]
pub async fn fs_watch_start(
    app: AppHandle,
    state: State<'_, FsWatch>,
    project_path: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    crate::exec::blocking("fs_watch_start", move || {
        fs_watch_start_body(app, &state, project_path)
    })
    .await
}

fn fs_watch_start_body(app: AppHandle, state: &FsWatch, project_path: String) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }

    let mut entries = state.0.lock().map_err(|e| e.to_string())?;
    if !touch_root(&mut entries, &project_path, MAX_WATCHED_ROOTS) {
        // Warm revisit: the watcher is already installed and just got unmuted.
        return Ok(());
    }
    let muted = entries.last().expect("just pushed").muted.clone();

    // notify handler -> channel -> debounce thread -> single batched emit.
    // Muted is checked at the handler too, not only at emit, so a churning
    // background root cannot pile paths into the channel while silent.
    let (tx, rx) = mpsc::channel::<PathBuf>();

    let handler_muted = muted.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if handler_muted.load(Ordering::Relaxed) {
            return;
        }
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
    // 250ms. recv() returns Err when the watcher (and its sender) is dropped
    // on eviction, which is how this thread cleanly ends.
    let app_handle = app.clone();
    let emit_root = project_path.clone();
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch: BTreeSet<PathBuf> = BTreeSet::new();
            batch.insert(first);
            while let Ok(next) = rx.recv_timeout(Duration::from_millis(250)) {
                batch.insert(next);
            }
            // A burst can straddle the moment its root went to the background;
            // dropped here so a muted root emits nothing at all.
            if muted.load(Ordering::Relaxed) {
                continue;
            }
            let paths: Vec<String> = batch
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                let _ = app_handle
                    .emit("fs://changed", FsChanged { root: emit_root.clone(), paths });
            }
        }
    });

    entries.last_mut().expect("just pushed").watcher = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn temp_tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sway-fs-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The watcher LRU: re-selecting a warm root asks for no new watcher and
    /// leaves only that root unmuted; a fourth root evicts the coldest.
    #[test]
    fn watcher_lru_mutes_background_roots_and_evicts_past_cap() {
        use std::sync::atomic::Ordering;
        let mut entries: Vec<WatchEntry> = Vec::new();
        assert!(touch_root(&mut entries, "/a", 3), "first visit installs");
        assert!(touch_root(&mut entries, "/b", 3));
        assert!(touch_root(&mut entries, "/c", 3));

        assert!(!touch_root(&mut entries, "/a", 3), "warm revisit must not rebuild");
        let muted: Vec<(&str, bool)> = entries
            .iter()
            .map(|e| (e.root.as_str(), e.muted.load(Ordering::Relaxed)))
            .collect();
        assert_eq!(muted, vec![("/b", true), ("/c", true), ("/a", false)]);

        assert!(touch_root(&mut entries, "/d", 3), "a fourth root installs");
        let roots: Vec<&str> = entries.iter().map(|e| e.root.as_str()).collect();
        assert_eq!(roots, vec!["/c", "/a", "/d"], "the coldest root is evicted");
        assert!(entries.iter().all(|e| e.muted.load(Ordering::Relaxed) == (e.root != "/d")));
    }

    /// The compacted listing mirrors what the frontend's per-dir loop drew: a
    /// single-child run collapses into one row that acts on the deepest dir, a
    /// dir with two children does not collapse, and files pass through.
    #[test]
    fn compact_listing_collapses_single_child_chains() {
        let root = temp_tree("compact");
        std::fs::create_dir_all(root.join("src/utils/helpers")).unwrap();
        std::fs::write(root.join("src/utils/helpers/a.ts"), "").unwrap();
        std::fs::create_dir_all(root.join("busy/one")).unwrap();
        std::fs::create_dir_all(root.join("busy/two")).unwrap();
        std::fs::write(root.join("readme.md"), "").unwrap();

        let rows =
            fs_read_dir_compact_body(&root.to_string_lossy(), true, &[".git".into()]).unwrap();
        let by_label: Vec<(&str, bool)> =
            rows.iter().map(|r| (r.label.as_str(), r.is_dir)).collect();
        assert_eq!(
            by_label,
            vec![("busy", true), ("src/utils/helpers", true), ("readme.md", false)]
        );
        let chain = rows.iter().find(|r| r.label == "src/utils/helpers").unwrap();
        assert!(chain.path.ends_with("src/utils/helpers"), "acts on the deepest dir");
        assert_eq!(chain.name, "helpers");
    }

    /// A chain never compacts into a gitignored dir: `dist` holding only
    /// `assets` stays a plain `dist` row when `dist` is ignored, and the hidden
    /// set keeps `.git` out of the child count so a chain still collapses past
    /// a directory that contains one.
    #[test]
    fn compact_listing_respects_gitignore_and_hidden() {
        let root = temp_tree("compact-ign");
        let git = |args: &[&str]| {
            let out = Command::new("git").current_dir(&root).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        std::fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        std::fs::create_dir_all(root.join("dist/assets")).unwrap();
        std::fs::create_dir_all(root.join("src/only")).unwrap();
        std::fs::write(root.join("src/only/f.ts"), "").unwrap();

        let rows =
            fs_read_dir_compact_body(&root.to_string_lossy(), true, &[".git".into()]).unwrap();
        let dist = rows.iter().find(|r| r.name == "dist").expect("dist listed");
        assert!(dist.ignored, "dist is gitignored");
        assert_eq!(dist.label, "dist", "no compaction into an ignored dir");
        let src = rows.iter().find(|r| r.label == "src/only").expect("src compacts");
        assert!(!src.ignored);
    }

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
        // Feature worktrees are checkouts too, but `.sway` itself stays visible.
        assert!(is_ignored(Path::new("/p/.sway/worktrees/x/a.rs")));
        assert!(!is_ignored(Path::new("/p/.sway/settings.json")));
        assert!(!is_ignored(Path::new("/p/worktrees/a.rs")));
    }

    #[test]
    fn walk_files_skips_feature_worktrees_but_not_the_sway_dir() {
        let root = std::env::temp_dir().join(format!(
            "sway-walk-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(root.join(".sway/worktrees/x")).unwrap();
        std::fs::write(root.join(".sway/worktrees/x/a.rs"), "").unwrap();
        std::fs::write(root.join(".sway/settings.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("worktrees")).unwrap();
        std::fs::write(root.join("worktrees/b.rs"), "").unwrap();
        std::fs::write(root.join("main.rs"), "").unwrap();

        let mut out = Vec::new();
        walk_files(&root, &root, &mut out);
        out.sort();
        assert_eq!(out, [".sway/settings.json", "main.rs", "worktrees/b.rs"]);
        std::fs::remove_dir_all(&root).ok();
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
        let entries = fs_read_dir_body(&dir.to_string_lossy()).unwrap();
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
