use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::chat::model::{ChatEvent, SubmoduleNeed, SubmoduleRef, SubmoduleTouch};

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Submodule {
    pub path: String,
    pub name: String,
    pub recorded: Option<String>,
    pub current: Option<String>,
    pub branch: Option<String>,
    pub initialized: bool,
}

#[tauri::command]
pub async fn git_submodules(root: String) -> Vec<Submodule> {
    crate::exec::blocking("git_submodules", move || list(Path::new(&root))).await
}

pub fn list(root: &Path) -> Vec<Submodule> {
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out
}

fn walk(repo: &Path, prefix: &str, out: &mut Vec<Submodule>) {
    if !repo.join(".gitmodules").is_file() {
        return;
    }
    for (name, path) in declared(repo) {
        let dir = repo.join(&path);
        let initialized = dir.join(".git").exists();
        let full = format!("{prefix}{path}");
        out.push(Submodule {
            path: full.clone(),
            name,
            recorded: recorded(repo, &path),
            current: initialized.then(|| line(&dir, &["rev-parse", "HEAD"])).flatten(),
            branch: initialized
                .then(|| line(&dir, &["symbolic-ref", "--short", "-q", "HEAD"]))
                .flatten(),
            initialized,
        });
        if initialized {
            walk(&dir, &format!("{full}/"), out);
        }
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Pointer {
    pub from: Option<String>,
    pub to: Option<String>,
    pub ahead: Vec<PointerCommit>,
    pub behind: Vec<PointerCommit>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct PointerCommit {
    pub sha: String,
    pub subject: String,
}

const POINTER_LOG_MAX: &str = "-n50";

#[tauri::command]
pub async fn git_submodule_pointer(root: String, path: String) -> Pointer {
    crate::exec::blocking("git_submodule_pointer", move || pointer(Path::new(&root), &path)).await
}

fn pointer(root: &Path, path: &str) -> Pointer {
    let sub = root.join(path);
    let from = line(root, &["rev-parse", "--verify", "-q", &format!("HEAD:{path}")]);
    let to = line(&sub, &["rev-parse", "--verify", "-q", "HEAD"]);
    let between = |a: &Option<String>, b: &Option<String>| match (a, b) {
        (Some(a), Some(b)) => commits(&sub, &format!("{a}..{b}")),
        _ => Vec::new(),
    };
    Pointer {
        ahead: between(&from, &to),
        behind: between(&to, &from),
        from,
        to,
    }
}

fn commits(repo: &Path, range: &str) -> Vec<PointerCommit> {
    output(repo, &["log", "--format=%h%x09%s", POINTER_LOG_MAX, range, "--"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(sha, subject)| PointerCommit {
            sha: sha.to_string(),
            subject: subject.to_string(),
        })
        .collect()
}

#[tauri::command]
pub async fn git_submodule_reset_pointer(root: String, path: String) -> Result<(), String> {
    crate::exec::git_write("git_submodule_reset_pointer", root.clone(), move || {
        let out = crate::exec::git_in(&root)
            .args(["submodule", "update", "--no-fetch", "--checkout", "--", &path])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    })
    .await
}

// A detached submodule gets a branch before its first commit, named like the
// parent's so the two PRs pair up. A name already used elsewhere in it is never
// checked out, since that would move HEAD off the commit under the edits.
#[tauri::command]
pub async fn git_submodule_branch_suggestion(root: String, want: String) -> String {
    crate::exec::blocking("git_submodule_branch_suggestion", move || {
        free_branch(Path::new(&root), want.trim())
    })
    .await
}

fn free_branch(sub: &Path, want: &str) -> String {
    if want.is_empty() {
        return String::new();
    }
    let head = line(sub, &["rev-parse", "--verify", "-q", "HEAD"]);
    let usable = |name: &str| match branch_tip(sub, name) {
        None => true,
        tip => tip == head,
    };
    if usable(want) {
        return want.to_string();
    }
    (2..100)
        .map(|n| format!("{want}-{n}"))
        .find(|name| usable(name))
        .unwrap_or_else(|| want.to_string())
}

fn branch_tip(repo: &Path, name: &str) -> Option<String> {
    line(repo, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")])
}

#[tauri::command]
pub async fn git_submodule_attach_branch(root: String, name: String) -> Result<(), String> {
    crate::exec::git_write("git_submodule_attach_branch", root.clone(), move || {
        attach_branch(Path::new(&root), name.trim())
    })
    .await
}

fn attach_branch(sub: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name a branch for the submodule first.".into());
    }
    let head = line(sub, &["rev-parse", "--verify", "-q", "HEAD"]);
    let args: &[&str] = match branch_tip(sub, name) {
        None => &["switch", "-q", "-c", name],
        tip if tip == head => &["switch", "-q", name],
        _ => return Err(format!("{name} already exists in this submodule at another commit.")),
    };
    let out = crate::exec::git_in(sub)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn git_submodule_init(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::askpass::AskpassState>,
    fs: tauri::State<'_, crate::fs::FsWatch>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let bridge = state.0.clone();
    let fs = fs.inner().clone();
    crate::exec::blocking("git_submodule_init", move || {
        init(&root, &paths, bridge.sock_path(), bridge.token())?;
        crate::fs::rewatch_containing(&app, &fs, Path::new(&root));
        Ok(())
    })
    .await
}

pub fn init(repo: &str, paths: &[String], sock: &Path, token: &str) -> Result<(), String> {
    update(repo, paths, sock, token)?;
    crate::forge::identity::reconcile_soon();
    Ok(())
}

// Through the askpass command, whose `GIT_SSH_COMMAND` carries the parent's
// account wrapper into each clone: a clone never reads its parent's config.
// The https bridge stays off, since it answers for the parent's account only.
fn update(repo: &str, paths: &[String], sock: &Path, token: &str) -> Result<(), String> {
    let mut cmd = crate::git::network_git(repo, sock, token);
    cmd.args(["submodule", "update", "--init", "--recursive", "--"])
        .args(paths);
    let lock = crate::exec::repo_lock(repo);
    let _held = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn declared(repo: &Path) -> Vec<(String, String)> {
    let Some(text) = output(
        repo,
        &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
    ) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| {
            let (key, path) = l.split_once(' ')?;
            let name = key.strip_prefix("submodule.")?.strip_suffix(".path")?;
            Some((name.to_string(), path.trim_end_matches('/').to_string()))
        })
        .collect()
}

fn recorded(repo: &Path, path: &str) -> Option<String> {
    let text = output(repo, &["ls-files", "--stage", "--", path])?;
    let mut fields = text.split_whitespace();
    (fields.next()? == "160000")
        .then(|| fields.next().map(str::to_string))
        .flatten()
}

fn line(repo: &Path, args: &[&str]) -> Option<String> {
    output(repo, args)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn output(repo: &Path, args: &[&str]) -> Option<String> {
    let out = crate::exec::git_in(repo).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

// A turn also counts every submodule whose HEAD or status moved across it,
// which is what catches a shell edit or a commit made inside one.
pub struct Tracker {
    cwd: PathBuf,
    root: Option<Option<PathBuf>>,
    subs: Vec<String>,
    read_at: Option<Instant>,
    turns: HashMap<String, Turn>,
}

#[derive(Default)]
struct Turn {
    before: Option<HashMap<String, Snap>>,
    touched: BTreeSet<String>,
}

#[derive(PartialEq, Eq)]
struct Snap {
    head: Option<String>,
    status: Option<String>,
}

const REREAD: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Live,
    Replay,
}

impl Tracker {
    pub fn new(cwd: PathBuf) -> Self {
        Self {
            cwd,
            root: None,
            subs: Vec::new(),
            read_at: None,
            turns: HashMap::new(),
        }
    }

    pub fn pass(&mut self, events: Vec<ChatEvent>, source: Source) -> Vec<ChatEvent> {
        let mut out = Vec::with_capacity(events.len());
        for mut event in events {
            if let Some(before) = self.observe(&mut event, source) {
                out.push(before);
            }
            out.push(event);
        }
        out
    }

    fn observe(&mut self, event: &mut ChatEvent, source: Source) -> Option<ChatEvent> {
        match event {
            ChatEvent::TurnStarted { turn_id, .. } => {
                self.refresh();
                let before = (source == Source::Live).then(|| self.snapshot());
                self.turns.insert(
                    turn_id.clone(),
                    Turn {
                        before,
                        ..Turn::default()
                    },
                );
                None
            }
            ChatEvent::FileEdit {
                turn_id,
                path,
                submodule,
                ..
            } => {
                self.refresh();
                *submodule = self.owner(path);
                let touched = submodule.as_ref().map(|s| s.path.clone());
                self.turns.entry(turn_id.clone()).or_default().touched.extend(touched);
                None
            }
            ChatEvent::ToolCallCompleted {
                turn_id,
                files,
                submodules,
                ..
            } => {
                self.refresh();
                let mut found: Vec<SubmoduleRef> = Vec::new();
                for owner in files.iter().filter_map(|f| self.owner(f)) {
                    if !found.contains(&owner) {
                        found.push(owner);
                    }
                }
                let turn = self.turns.entry(turn_id.clone()).or_default();
                turn.touched.extend(found.iter().map(|s| s.path.clone()));
                *submodules = found;
                None
            }
            ChatEvent::TurnCompleted {
                session_id, turn_id, ..
            } => {
                let turn = self.turns.remove(turn_id)?;
                if source == Source::Replay {
                    return None;
                }
                self.refresh();
                let root = self.root.clone().flatten()?;
                let mut paths = turn.touched;
                if let Some(before) = &turn.before {
                    for (path, snap) in self.snapshot() {
                        if before.get(&path) != Some(&snap) {
                            paths.insert(path);
                        }
                    }
                }
                let submodules: Vec<SubmoduleTouch> = paths
                    .into_iter()
                    .filter(|p| self.subs.contains(p))
                    .map(|path| SubmoduleTouch {
                        root: root.join(&path).to_string_lossy().into_owned(),
                        need: need(&root, &self.subs, &path),
                        path,
                    })
                    .collect();
                (!submodules.is_empty()).then(|| ChatEvent::TurnSubmodules {
                    session_id: session_id.clone(),
                    turn_id: turn_id.clone(),
                    submodules,
                })
            }
            _ => None,
        }
    }

    fn refresh(&mut self) {
        if self.read_at.is_some_and(|t| t.elapsed() < REREAD) {
            return;
        }
        self.read_at = Some(Instant::now());
        let root = self.root.get_or_insert_with(|| repo_root(&self.cwd));
        self.subs = match root {
            Some(root) if root.join(".gitmodules").is_file() => initialized(root),
            _ => Vec::new(),
        };
    }

    fn owner(&self, file: &str) -> Option<SubmoduleRef> {
        let root = self.root.as_ref()?.as_ref()?;
        let abs = self.cwd.join(file);
        let rel = abs.strip_prefix(root).ok()?;
        let sub = self
            .subs
            .iter()
            .filter(|s| rel.starts_with(s.as_str()))
            .max_by_key(|s| s.len())?;
        Some(SubmoduleRef {
            root: root.join(sub).to_string_lossy().into_owned(),
            path: sub.clone(),
        })
    }

    fn snapshot(&self) -> HashMap<String, Snap> {
        let Some(Some(root)) = &self.root else {
            return HashMap::new();
        };
        self.subs
            .iter()
            .map(|path| {
                let dir = root.join(path);
                let snap = Snap {
                    head: line(&dir, &["rev-parse", "HEAD"]),
                    status: output(&dir, &["status", "--porcelain", "--ignore-submodules=all"]),
                };
                (path.clone(), snap)
            })
            .collect()
    }
}

pub fn agent_note(cwd: &Path) -> Option<String> {
    let root = repo_root(cwd)?;
    let mut subs = initialized(&root);
    if subs.is_empty() {
        return None;
    }
    subs.sort();
    Some(format!(
        "This repo has git submodules: {}. Each is its own repo: an edit inside one is committed, pushed and \
opened as a PR there, separately, and then the parent commits the new pointer. Say so when you change one.",
        subs.join(", ")
    ))
}

// The root in the session's own spelling of its folder, not git's resolved one,
// so a symlinked cwd still prefixes the paths its agent reports.
fn repo_root(cwd: &Path) -> Option<PathBuf> {
    let prefix = output(cwd, &["rev-parse", "--show-prefix"])?;
    let depth = Path::new(prefix.trim()).components().count();
    cwd.ancestors().nth(depth).map(Path::to_path_buf)
}

pub(crate) fn initialized_here(repo: &Path) -> Vec<String> {
    if !repo.join(".gitmodules").is_file() {
        return Vec::new();
    }
    declared(repo)
        .into_iter()
        .map(|(_, path)| path)
        .filter(|path| repo.join(path).join(".git").exists())
        .collect()
}

fn initialized(root: &Path) -> Vec<String> {
    fn walk(repo: &Path, prefix: &str, out: &mut Vec<String>) {
        if !repo.join(".gitmodules").is_file() {
            return;
        }
        for (_, path) in declared(repo) {
            let dir = repo.join(&path);
            if dir.join(".git").exists() {
                let full = format!("{prefix}{path}");
                walk(&dir, &format!("{full}/"), out);
                out.push(full);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out
}

fn need(root: &Path, subs: &[String], path: &str) -> SubmoduleNeed {
    let dir = root.join(path);
    let dirty = output(&dir, &["status", "--porcelain", "--ignore-submodules=all"]).is_some_and(|s| !s.is_empty());
    if dirty {
        return SubmoduleNeed::Commit;
    }
    let Some(head) = line(&dir, &["rev-parse", "HEAD"]) else {
        return SubmoduleNeed::Commit;
    };
    let pushed = line(
        &dir,
        &["for-each-ref", "--count=1", "--contains", &head, "refs/remotes"],
    )
    .is_some();
    if !pushed {
        return SubmoduleNeed::Push;
    }
    let parent = subs
        .iter()
        .filter(|s| {
            Path::new(path)
                .strip_prefix(s.as_str())
                .is_ok_and(|r| !r.as_os_str().is_empty())
        })
        .max_by_key(|s| s.len());
    let (parent_dir, rel) = match parent {
        Some(p) => (root.join(p), &path[p.len() + 1..]),
        None => (root.to_path_buf(), path),
    };
    let recorded = line(&parent_dir, &["rev-parse", "--verify", "-q", &format!("HEAD:{rel}")]);
    if recorded.as_deref() == Some(head.as_str()) {
        SubmoduleNeed::Done
    } else {
        SubmoduleNeed::Pointer
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "protocol.file.allow=always"])
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t.test")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        std::fs::write(dir.join("f.txt"), "x").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "init"]);
    }

    fn scratch() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "tori_submodule_test_{n}_{}",
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_nested_submodules_and_reads_an_uninitialized_one_as_such() {
        let tmp = scratch();
        let (inner, outer, lone, top) = (tmp.join("inner"), tmp.join("outer"), tmp.join("lone"), tmp.join("top"));
        repo(&inner);
        repo(&outer);
        git(&outer, &["submodule", "add", "-q", inner.to_str().unwrap(), "deep"]);
        git(&outer, &["commit", "-qm", "add inner"]);
        repo(&lone);
        repo(&top);
        git(&top, &["submodule", "add", "-q", outer.to_str().unwrap(), "libs/outer"]);
        git(&top, &["submodule", "add", "-q", lone.to_str().unwrap(), "lone"]);
        git(&top, &["submodule", "update", "-q", "--init", "--recursive"]);
        git(&top, &["commit", "-qm", "add subs"]);
        git(&top, &["submodule", "deinit", "-q", "lone"]);
        git(&top.join("libs/outer"), &["checkout", "-q", "-b", "work"]);

        let subs = list(&top);
        let by = |p: &str| {
            subs.iter()
                .find(|s| s.path == p)
                .unwrap_or_else(|| panic!("missing {p}: {subs:?}"))
        };

        let outer_sub = by("libs/outer");
        assert!(outer_sub.initialized);
        assert_eq!(outer_sub.name, "libs/outer");
        assert_eq!(outer_sub.current, outer_sub.recorded);
        assert_eq!(outer_sub.branch.as_deref(), Some("work"));
        assert!(by("libs/outer/deep").branch.is_none(), "update leaves a detached HEAD");

        let nested = by("libs/outer/deep");
        assert!(nested.initialized);
        assert!(nested.recorded.is_some());

        let lone_sub = by("lone");
        assert!(!lone_sub.initialized);
        assert!(lone_sub.current.is_none() && lone_sub.branch.is_none());
        assert!(lone_sub.recorded.is_some());
        assert_eq!(subs.len(), 3);
    }

    fn turn_events(id: &str, files: Vec<String>, edit: Option<String>) -> Vec<ChatEvent> {
        use crate::chat::model::*;
        let mut out = vec![ChatEvent::ToolCallCompleted {
            session_id: "s".into(),
            turn_id: id.into(),
            tool_use_id: format!("{id}-call"),
            status: ToolStatus::Ok,
            output: None,
            files,
            duration_ms: None,
            summary: None,
            output_truncated: false,
            patch: Vec::new(),
            blind_edits: Vec::new(),
            submodules: Vec::new(),
        }];
        out.extend(edit.map(|path| ChatEvent::FileEdit {
            session_id: "s".into(),
            turn_id: id.into(),
            tool_use_id: format!("{id}-edit"),
            path,
            kind: FileEditKind::Modified,
            before_blob: None,
            submodule: None,
        }));
        out
    }

    fn turn(t: &mut Tracker, id: &str, middle: impl FnOnce() -> Vec<ChatEvent>) -> Vec<ChatEvent> {
        use crate::chat::model::*;
        let mut events = t.pass(
            vec![ChatEvent::TurnStarted {
                session_id: "s".into(),
                turn_id: id.into(),
                agent_initiated: false,
                model: "m".into(),
                permission_mode: PermissionMode::new("default"),
                extra: Default::default(),
            }],
            Source::Live,
        );
        events.extend(t.pass(middle(), Source::Live));
        events.extend(t.pass(
            vec![ChatEvent::TurnCompleted {
                session_id: "s".into(),
                turn_id: id.into(),
                outcome: TurnOutcome::Completed,
                stop_reason: None,
                usage: Default::default(),
                cost_usd: None,
                permission_denials: Vec::new(),
                extra: Default::default(),
            }],
            Source::Live,
        ));
        events
    }

    fn touches(events: &[ChatEvent]) -> Vec<(String, SubmoduleNeed)> {
        events
            .iter()
            .flat_map(|e| match e {
                ChatEvent::TurnSubmodules { submodules, .. } => {
                    submodules.iter().map(|s| (s.path.clone(), s.need)).collect()
                }
                _ => Vec::new(),
            })
            .collect()
    }

    #[test]
    fn a_turn_names_each_submodule_it_changed_and_what_it_still_needs() {
        let tmp = scratch();
        let (a, b, top) = (tmp.join("a"), tmp.join("b"), tmp.join("top"));
        repo(&a);
        repo(&b);
        repo(&top);
        git(&top, &["submodule", "add", "-q", a.to_str().unwrap(), "libs/a"]);
        git(&top, &["submodule", "add", "-q", b.to_str().unwrap(), "b"]);
        git(&top, &["commit", "-qm", "add subs"]);
        let mut t = Tracker::new(top.clone());

        let in_a = top.join("libs/a/f.txt").to_string_lossy().into_owned();
        let in_top = top.join("f.txt").to_string_lossy().into_owned();
        let events = turn(&mut t, "t1", || {
            std::fs::write(&in_a, "y").unwrap();
            std::fs::write(top.join("b/f.txt"), "y").unwrap();
            std::fs::write(&in_top, "y").unwrap();
            turn_events("t1", vec![in_a.clone(), in_top.clone()], Some("libs/a/f.txt".into()))
        });
        let tagged = events.iter().find_map(|e| match e {
            ChatEvent::ToolCallCompleted { submodules, .. } => Some(submodules.clone()),
            _ => None,
        });
        assert_eq!(
            tagged.unwrap().iter().map(|s| s.path.as_str()).collect::<Vec<_>>(),
            ["libs/a"],
            "the parent's own file is not tagged"
        );
        let edit = events.iter().find_map(|e| match e {
            ChatEvent::FileEdit { submodule, .. } => Some(submodule.clone()),
            _ => None,
        });
        assert_eq!(
            edit.flatten().map(|s| s.root),
            Some(top.join("libs/a").to_string_lossy().into_owned())
        );
        assert_eq!(
            touches(&events),
            [
                ("b".to_string(), SubmoduleNeed::Commit),
                ("libs/a".to_string(), SubmoduleNeed::Commit)
            ],
            "b changed only on disk and still counts"
        );
        assert!(
            matches!(events.last(), Some(ChatEvent::TurnCompleted { .. })),
            "the note goes before the turn ends"
        );

        t.read_at = None;
        let events = turn(&mut t, "t2", || {
            git(&top.join("b"), &["commit", "-qam", "edit"]);
            Vec::new()
        });
        assert_eq!(touches(&events), [("b".to_string(), SubmoduleNeed::Push)]);

        let events = turn(&mut t, "t3", Vec::new);
        assert!(touches(&events).is_empty(), "a turn that changed nothing says nothing");
    }

    #[test]
    fn the_agent_note_names_the_submodules_of_the_folder_it_runs_in() {
        let tmp = scratch();
        let (a, top, plain) = (tmp.join("a"), tmp.join("top"), tmp.join("plain"));
        repo(&a);
        repo(&top);
        repo(&plain);
        git(&top, &["submodule", "add", "-q", a.to_str().unwrap(), "libs/a"]);
        std::fs::create_dir_all(top.join("src")).unwrap();

        let note = agent_note(&top.join("src")).expect("a repo with a submodule gets the note");
        assert!(note.contains("libs/a"), "{note}");
        assert!(agent_note(&plain).is_none());
    }

    #[test]
    fn a_clone_goes_through_the_parents_ssh_wrapper() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = scratch();
        let top = tmp.join("top");
        repo(&top);
        let bin = tmp.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let wrapper = bin.join("ssh");
        let marker = tmp.join("called");
        std::fs::write(
            &wrapper,
            format!("#!/bin/sh\necho \"$@\" > '{}'\nexit 1\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&top, &["config", "core.sshCommand", wrapper.to_str().unwrap()]);
        std::fs::write(
            top.join(".gitmodules"),
            "[submodule \"lib\"]\n\tpath = lib\n\turl = ssh://git@example.invalid/lib.git\n",
        )
        .unwrap();
        let sha = "1111111111111111111111111111111111111111";
        git(
            &top,
            &["update-index", "--add", "--cacheinfo", &format!("160000,{sha},lib")],
        );

        let err = update(top.to_str().unwrap(), &[], Path::new("/nonexistent/sock"), "t").unwrap_err();
        assert!(!err.is_empty());
        let args = std::fs::read_to_string(&marker).expect("the clone ran the parent's wrapper");
        assert!(args.contains("example.invalid"), "{args}");
    }
}
