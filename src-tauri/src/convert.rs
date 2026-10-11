// Files move before git is told anything: `git worktree add` refuses the
// branch while the repo still has its checkout. A journal in the git dir makes
// a crash undoable, and keeps the project probing as `converting` meanwhile.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

use crate::config::ProjectIndex;
use crate::topics::{MemberMode, Store};

const JOURNAL: &str = "tori-convert.json";
const STAGING_PREFIX: &str = "tori-converting-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    pub from: String,
    pub to: String,
}

/// What a conversion would do, for the dialog to say before it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub branch: String,
    /// The checkout folder's name, the branch's last segment.
    pub leaf: String,
    /// Where the checkout lands.
    pub target: String,
    /// Tori's own worktrees under `.tori/worktrees`, moving out to siblings.
    pub tori: Vec<Move>,
    /// Other linked worktrees inside the checkout, moving with it.
    pub nested: Vec<Move>,
    /// Linked worktrees outside the project, repaired where they are.
    pub outside: Vec<String>,
    /// Topics with a reference to this repo that will need its default branch
    /// checked out, since the container will not have one.
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Step {
    Journal,
    Stage,
    Bare,
    Add,
    Swap,
    Index,
    Linked,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    step: Step,
    branch: String,
    leaf: String,
    had_head_log: bool,
    tori: Vec<String>,
    /// Every linked worktree where it stood before, for the closing repair.
    linked: Vec<String>,
    #[serde(default)]
    repointed: bool,
}

/// Is a conversion of `project` unfinished? Asked by every probe, so two stats.
pub(crate) fn interrupted(project: &Path) -> bool {
    journal_file(project).is_some()
}

fn journal_file(project: &Path) -> Option<PathBuf> {
    [".bare", ".git"]
        .iter()
        .map(|d| project.join(d).join(JOURNAL))
        .find(|p| p.is_file())
}

fn git_dir(project: &Path) -> PathBuf {
    let bare = project.join(".bare");
    if bare.is_dir() {
        bare
    } else {
        project.join(".git")
    }
}

fn save_journal(project: &Path, j: &Journal) -> Result<(), String> {
    let text = serde_json::to_string_pretty(j).map_err(|e| e.to_string())?;
    std::fs::write(git_dir(project).join(JOURNAL), text).map_err(|e| format!("journal: {e}"))
}

fn load_journal(project: &Path) -> Result<Journal, String> {
    let path = journal_file(project).ok_or("No conversion to undo here.")?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("journal: {e}"))
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::exec::git_in(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn config_true(project: &Path, key: &str) -> bool {
    git(project, &["config", "--bool", key]).is_ok_and(|v| v == "true")
}

fn rename(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| format!("{} -> {}: {e}", from.display(), to.display()))
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Every linked worktree git lists, main checkout excluded. Read raw rather
/// than through `list_worktrees_body`, which hides worktrees in dot folders,
/// and those need repairing just the same.
fn linked_worktrees(project: &Path) -> Vec<PathBuf> {
    let Ok(text) = git(project, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect()
}

fn tori_root(base: &Path) -> PathBuf {
    let (tori, worktrees) = crate::fs::TOPIC_WORKTREES;
    base.join(tori).join(worktrees)
}

fn relocated(base: &Path, leaf: &str, slugs: &[String], path: &Path) -> Option<PathBuf> {
    if let Ok(rest) = path.strip_prefix(tori_root(base)) {
        let mut parts = rest.components();
        if let Some(slug) = parts.next().map(|c| c.as_os_str().to_string_lossy().into_owned()) {
            if slugs.contains(&slug) {
                return Some(joined(&base.join(slug), parts.as_path()));
            }
        }
    }
    let rest = path.strip_prefix(base).ok()?;
    if rest.as_os_str().is_empty() {
        return None;
    }
    Some(joined(&base.join(leaf), rest))
}

// `Path::join("")` appends a separator, and these paths are compared as strings.
fn joined(base: &Path, rest: &Path) -> PathBuf {
    if rest.as_os_str().is_empty() {
        base.to_path_buf()
    } else {
        base.join(rest)
    }
}

fn restored(base: &Path, leaf: &str, slugs: &[String], path: &Path) -> Option<PathBuf> {
    if let Ok(rest) = path.strip_prefix(base.join(leaf)) {
        return Some(joined(base, rest));
    }
    let rest = path.strip_prefix(base).ok()?;
    let mut parts = rest.components();
    let slug = parts.next()?.as_os_str().to_string_lossy().into_owned();
    slugs
        .contains(&slug)
        .then(|| joined(&tori_root(base).join(slug), parts.as_path()))
}

pub fn preview(project: &Path, store: &Store) -> Result<Preview, String> {
    let proj = std::fs::canonicalize(project).map_err(|_| format!("{} does not exist", project.display()))?;
    if interrupted(&proj) {
        return Err("A conversion was interrupted here. Undo it first.".into());
    }
    let dot_git = proj.join(".git");
    if !dot_git.is_dir() {
        return Err("Only a plain clone converts, and this folder has no .git directory.".into());
    }
    if proj.join(".bare").exists() {
        return Err("A .bare folder already exists here.".into());
    }
    if !crate::worktree::repo_readable(&s(&proj)) {
        return Err(format!("{} is not a git repository", proj.display()));
    }
    if config_true(&proj, "core.bare") {
        return Err("The repository is already bare.".into());
    }
    for (marker, what) in [
        ("rebase-merge", "A rebase"),
        ("rebase-apply", "A rebase"),
        ("MERGE_HEAD", "A merge"),
        ("CHERRY_PICK_HEAD", "A cherry-pick"),
        ("REVERT_HEAD", "A revert"),
        ("BISECT_LOG", "A bisect"),
    ] {
        if dot_git.join(marker).exists() {
            return Err(format!("{what} is in progress. Finish or abort it first."));
        }
    }
    if proj.join(".gitmodules").exists() || dot_git.join("modules").exists() {
        return Err("The repository has submodules, which this conversion does not move.".into());
    }
    if config_true(&proj, "core.sparseCheckout") {
        return Err("The checkout is sparse, which this conversion does not carry over.".into());
    }
    if config_true(&proj, "extensions.worktreeConfig") {
        return Err("The repository uses per-worktree config, which this conversion does not carry over.".into());
    }
    if git(&proj, &["config", "core.worktree"]).is_ok() {
        return Err("core.worktree is set, which a bare repository cannot keep.".into());
    }
    let branch = git(&proj, &["symbolic-ref", "-q", "--short", "HEAD"])
        .map_err(|_| "HEAD is detached. Check out a branch first.".to_string())?;
    if git(&proj, &["rev-parse", "-q", "--verify", "HEAD"]).is_err() {
        return Err(format!("{branch} has no commits yet."));
    }
    let leaf = branch.rsplit('/').next().unwrap_or(&branch).to_string();
    if proj.join(format!("{STAGING_PREFIX}{leaf}")).exists() {
        return Err(format!("{STAGING_PREFIX}{leaf} already exists here."));
    }

    let linked = linked_worktrees(&proj);
    let tori_dir = tori_root(&proj);
    let slugs: Vec<String> = linked
        .iter()
        .filter(|p| p.parent() == Some(tori_dir.as_path()))
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    if slugs.contains(&leaf) {
        return Err(format!(
            "The Topic worktree {leaf} would land where the {branch} checkout goes."
        ));
    }
    let (mut tori, mut nested, mut outside) = (Vec::new(), Vec::new(), Vec::new());
    for p in &linked {
        match relocated(&proj, &leaf, &slugs, p) {
            Some(to) if p.parent() == Some(tori_dir.as_path()) => tori.push(Move { from: s(p), to: s(&to) }),
            Some(to) => nested.push(Move { from: s(p), to: s(&to) }),
            None => outside.push(s(p)),
        }
    }

    let needs_default = match crate::worktree::origin_default(&s(&proj)) {
        Some(d) => d != branch,
        None => branch != "main" && branch != "master",
    };
    let topics = if needs_default {
        crate::topics::recorded(store)
            .into_iter()
            .filter(|t| {
                t.members.iter().any(|m| {
                    m.mode == MemberMode::Reference && std::fs::canonicalize(&m.repo_path).is_ok_and(|r| r == proj)
                })
            })
            .map(|t| t.name)
            .collect()
    } else {
        Vec::new()
    };

    Ok(Preview {
        branch,
        target: s(&proj.join(&leaf)),
        leaf,
        tori,
        nested,
        outside,
        topics,
    })
}

pub fn convert(project: &Path, store: &Store) -> Result<Preview, String> {
    let preview = preview(project, store)?;
    let proj = std::fs::canonicalize(project).map_err(|e| e.to_string())?;
    let mut j = Journal {
        step: Step::Journal,
        leaf: preview.leaf.clone(),
        branch: preview.branch.clone(),
        had_head_log: proj.join(".git/logs/HEAD").is_file(),
        tori: preview
            .tori
            .iter()
            .filter_map(|m| m.from.rsplit('/').next().map(str::to_string))
            .collect(),
        linked: preview
            .tori
            .iter()
            .chain(&preview.nested)
            .map(|m| m.from.clone())
            .chain(preview.outside.iter().cloned())
            .collect(),
        repointed: false,
    };
    save_journal(&proj, &j)?;
    match forward(&proj, project, &mut j, store) {
        Ok(()) => Ok(preview),
        Err(e) => {
            #[cfg(test)]
            if test_stop::crashed() {
                return Err(e);
            }
            match undo(project, store) {
                Ok(()) => Err(e),
                Err(u) => Err(format!("{e}. Undoing it also failed: {u}")),
            }
        }
    }
}

fn forward(proj: &Path, given: &Path, j: &mut Journal, store: &Store) -> Result<(), String> {
    let staging = proj.join(format!("{STAGING_PREFIX}{}", j.leaf));
    let checkout = proj.join(&j.leaf);
    let staging_name = staging.file_name().unwrap_or_default().to_owned();

    j.step = Step::Stage;
    save_journal(proj, j)?;
    std::fs::create_dir(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    let mut names: Vec<_> = std::fs::read_dir(proj)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name())
        .filter(|n| n != ".git" && *n != staging_name)
        .collect();
    names.sort();
    for name in &names {
        rename(&proj.join(name), &staging.join(name))?;
        checkpoint("stage-one")?;
    }

    j.step = Step::Bare;
    save_journal(proj, j)?;
    rename(&proj.join(".git"), &proj.join(".bare"))?;
    let bare = s(&proj.join(".bare"));
    git(proj, &["--git-dir", &bare, "config", "core.bare", "true"])?;
    std::fs::write(proj.join(".git"), "gitdir: ./.bare\n").map_err(|e| e.to_string())?;
    checkpoint("bared")?;

    j.step = Step::Add;
    save_journal(proj, j)?;
    git(proj, &["worktree", "add", "--no-checkout", &s(&checkout), &j.branch])?;

    j.step = Step::Swap;
    save_journal(proj, j)?;
    rename(&checkout.join(".git"), &staging.join(".git"))?;
    std::fs::remove_dir(&checkout).map_err(|e| format!("{}: {e}", checkout.display()))?;
    rename(&staging, &checkout)?;
    checkpoint("swapped")?;

    j.step = Step::Index;
    save_journal(proj, j)?;
    let admin = admin_dir(proj, &checkout).ok_or("git did not register the new worktree")?;
    let bare = proj.join(".bare");
    if bare.join("index").is_file() {
        rename(&bare.join("index"), &admin.join("index"))?;
    }
    if j.had_head_log {
        std::fs::create_dir_all(admin.join("logs")).map_err(|e| e.to_string())?;
        rename(&bare.join("logs/HEAD"), &admin.join("logs/HEAD"))?;
    }

    j.step = Step::Linked;
    save_journal(proj, j)?;
    for slug in &j.tori {
        rename(&tori_root(&checkout).join(slug), &proj.join(slug))?;
    }
    let moved: Vec<PathBuf> = j
        .linked
        .iter()
        .map(|p| relocated(proj, &j.leaf, &j.tori, Path::new(p)).unwrap_or_else(|| PathBuf::from(p)))
        .collect();
    repair_then_prune(proj, &moved);
    repoint(store, proj, given, |base, p| relocated(base, &j.leaf, &j.tori, p))?;
    j.repointed = true;
    save_journal(proj, j)?;

    std::fs::remove_file(git_dir(proj).join(JOURNAL)).map_err(|e| format!("journal: {e}"))
}

/// The admin dir git keeps for the worktree at `checkout`, found by its
/// backlink, so it is found whatever suffix git gave the id.
fn admin_dir(proj: &Path, checkout: &Path) -> Option<PathBuf> {
    let want = s(&checkout.join(".git"));
    std::fs::read_dir(proj.join(".bare/worktrees"))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|d| std::fs::read_to_string(d.join("gitdir")).is_ok_and(|g| g.trim() == want))
}

// Repair before prune: a prune first would drop the admin entry of every
// worktree that moved, while it still holds the user's work.
fn repair_then_prune(proj: &Path, worktrees: &[PathBuf]) {
    let present: Vec<String> = worktrees.iter().filter(|p| p.is_dir()).map(|p| s(p)).collect();
    if !present.is_empty() {
        let mut args = vec!["worktree", "repair"];
        args.extend(present.iter().map(String::as_str));
        let _ = git(proj, &args);
    }
    crate::worktree::prune_worktrees(&s(proj));
}

/// Topic records name worktree paths the way they were given, which need not
/// be canonical, so both spellings of the project are tried.
fn repoint(
    store: &Store,
    proj: &Path,
    given: &Path,
    map: impl Fn(&Path, &Path) -> Option<PathBuf>,
) -> Result<(), String> {
    crate::topics::repoint_worktrees(store, &s(proj), |wt| {
        [given, proj]
            .iter()
            .find_map(|base| map(base, Path::new(wt)))
            .map(|p| s(&p))
    })
}

pub fn undo(project: &Path, store: &Store) -> Result<(), String> {
    let proj = std::fs::canonicalize(project).map_err(|e| e.to_string())?;
    let j = load_journal(&proj)?;
    let staging = proj.join(format!("{STAGING_PREFIX}{}", j.leaf));
    let checkout = proj.join(&j.leaf);
    let bare = proj.join(".bare");

    if j.repointed {
        repoint(store, &proj, project, |base, p| restored(base, &j.leaf, &j.tori, p))?;
    }
    if j.step >= Step::Linked {
        for slug in &j.tori {
            let (out, back) = (proj.join(slug), tori_root(&checkout).join(slug));
            if out.is_dir() && !back.exists() {
                rename(&out, &back)?;
            }
        }
    }
    if j.step >= Step::Index {
        if let Some(admin) = admin_dir(&proj, &checkout) {
            if admin.join("index").is_file() && !bare.join("index").exists() {
                rename(&admin.join("index"), &bare.join("index"))?;
            }
            if j.had_head_log && !bare.join("logs/HEAD").exists() && admin.join("logs/HEAD").is_file() {
                rename(&admin.join("logs/HEAD"), &bare.join("logs/HEAD"))?;
            }
        }
    }
    if j.step >= Step::Swap {
        if checkout.is_dir() && !staging.exists() {
            rename(&checkout, &staging)?;
        }
        if staging.join(".git").is_file() {
            std::fs::create_dir_all(&checkout).map_err(|e| e.to_string())?;
            rename(&staging.join(".git"), &checkout.join(".git"))?;
        }
    }
    if j.step >= Step::Add {
        if let Some(admin) = admin_dir(&proj, &checkout) {
            std::fs::remove_dir_all(&admin).map_err(|e| format!("{}: {e}", admin.display()))?;
        }
        if checkout.join(".git").is_file() {
            std::fs::remove_file(checkout.join(".git")).map_err(|e| e.to_string())?;
        }
        if checkout.is_dir() {
            std::fs::remove_dir(&checkout).map_err(|e| format!("{}: {e}", checkout.display()))?;
        }
    }
    if j.step >= Step::Bare {
        let dot_git = proj.join(".git");
        if dot_git.is_file() {
            std::fs::remove_file(&dot_git).map_err(|e| e.to_string())?;
        }
        if bare.is_dir() && !dot_git.exists() {
            git(&proj, &["--git-dir", &s(&bare), "config", "core.bare", "false"])?;
            rename(&bare, &dot_git)?;
        }
    }
    if staging.is_dir() {
        for entry in std::fs::read_dir(&staging).map_err(|e| e.to_string())?.flatten() {
            let back = proj.join(entry.file_name());
            if back.exists() {
                return Err(format!("{} is in the way of restoring it", back.display()));
            }
            rename(&entry.path(), &back)?;
        }
        std::fs::remove_dir(&staging).map_err(|e| e.to_string())?;
    }
    std::fs::remove_file(proj.join(".git").join(JOURNAL)).map_err(|e| format!("journal: {e}"))?;
    let linked: Vec<PathBuf> = j.linked.iter().map(PathBuf::from).collect();
    repair_then_prune(&proj, &linked);
    Ok(())
}

#[cfg(not(test))]
fn checkpoint(_: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn checkpoint(name: &str) -> Result<(), String> {
    test_stop::hit(name)
}

/// Stops a conversion at a named point: an error, which undoes, or a crash,
/// which leaves the disk as it stands.
#[cfg(test)]
mod test_stop {
    use std::cell::RefCell;

    thread_local! {
        static STOP: RefCell<Option<(&'static str, bool)>> = const { RefCell::new(None) };
        static CRASHED: RefCell<bool> = const { RefCell::new(false) };
    }

    pub fn set(name: &'static str, crash: bool) {
        STOP.with(|s| *s.borrow_mut() = Some((name, crash)));
        CRASHED.with(|c| *c.borrow_mut() = false);
    }

    pub fn hit(name: &str) -> Result<(), String> {
        let Some((at, crash)) = STOP.with(|s| *s.borrow()) else {
            return Ok(());
        };
        if at != name {
            return Ok(());
        }
        STOP.with(|s| *s.borrow_mut() = None);
        CRASHED.with(|c| *c.borrow_mut() = crash);
        Err(format!("stopped at {name}"))
    }

    pub fn crashed() -> bool {
        CRASHED.with(|c| *c.borrow())
    }
}

fn settle(app: &AppHandle, index: &ProjectIndex, project: &str, linked: &[String]) {
    index.evict(Path::new(project));
    crate::exec::forget_common_dir(project);
    for p in linked {
        crate::exec::forget_common_dir(p);
    }
    let _ = app.emit("config://changed", ());
    let canon = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    let proj = canon(project);
    for topic in crate::topics::list_topics(&Store::default_location()) {
        if topic.members.iter().any(|m| canon(&m.repo_path) == proj) {
            let _ = app.emit("topics://changed", &topic);
        }
    }
}

pub mod commands {
    use super::*;

    #[tauri::command]
    pub async fn conversion_preview(project_path: String) -> Result<Preview, String> {
        crate::exec::blocking("conversion_preview", move || {
            preview(Path::new(&project_path), &Store::default_location())
        })
        .await
    }

    #[tauri::command]
    pub async fn convert_to_worktree_layout(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        project_path: String,
    ) -> Result<Preview, String> {
        let index = index.inner().clone();
        let path = project_path.clone();
        let out = crate::exec::git_write("convert_to_worktree_layout", project_path.clone(), move || {
            let out = convert(Path::new(&project_path), &Store::default_location());
            let linked: Vec<String> = out
                .as_ref()
                .map(|p| {
                    p.tori
                        .iter()
                        .chain(&p.nested)
                        .flat_map(|m| [m.from.clone(), m.to.clone()])
                        .chain(p.outside.iter().cloned())
                        .collect()
                })
                .unwrap_or_default();
            settle(&app, &index, &project_path, &linked);
            out
        })
        .await;
        // Outside the repo lock: the attached store's own writers take the
        // config lock first and the repo lock second.
        if out.is_ok() {
            crate::exec::blocking("forget_attached", move || {
                crate::config::forget_attached(Path::new(&path))
            })
            .await;
        }
        out
    }

    #[tauri::command]
    pub async fn undo_conversion(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        project_path: String,
    ) -> Result<(), String> {
        let index = index.inner().clone();
        crate::exec::git_write("undo_conversion", project_path.clone(), move || {
            let out = undo(Path::new(&project_path), &Store::default_location());
            settle(&app, &index, &project_path, &[]);
            out
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::topics::{Member, MemberState, Promotion, Topic};
    use std::process::Command;

    fn tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori-convert-{}-{seq}", crate::owned_state::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
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
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A plain clone on `main` with one commit.
    fn repo(tmp: &Path) -> PathBuf {
        let dir = tmp.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q", "-b", "main"]);
        write(&dir.join("a.txt"), "one\n");
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-qm", "first"]);
        dir
    }

    fn store(tmp: &Path) -> Store {
        Store::at(tmp.join("topics.json"))
    }

    fn store_with(tmp: &Path, topics: Vec<Topic>) -> Store {
        let path = tmp.join("topics.json");
        std::fs::write(&path, serde_json::json!({ "topics": topics }).to_string()).unwrap();
        Store::at(path)
    }

    fn topic(id: &str, member: Member) -> Topic {
        Topic {
            id: id.into(),
            name: id.into(),
            branch: format!("feat/{id}"),
            members: vec![member],
            created_at: 1,
            promotion: Promotion::default(),
            home: None,
        }
    }

    fn member(repo: &Path, mode: MemberMode, worktree: Option<&Path>) -> Member {
        Member {
            repo_path: s(repo),
            display_name: "proj".into(),
            mode,
            worktree_path: worktree.map(s),
            checkout: None,
            state: MemberState::Present,
            order: 0,
            keeps_branch: false,
            branch: None,
        }
    }

    /// What the user would check after: the same from wherever the checkout is.
    fn state(checkout: &Path) -> Vec<String> {
        [
            &["status", "--porcelain=v2", "--ignored"][..],
            &["stash", "list"],
            &["branch", "-vv"],
            &["reflog", "-1"],
        ]
        .iter()
        .map(|args| run(checkout, args))
        .collect()
    }

    /// Staged, unstaged, untracked and ignored changes, a stash, two branches.
    fn busy(dir: &Path) {
        run(dir, &["branch", "feature"]);
        write(&dir.join(".gitignore"), "target/\n");
        run(dir, &["add", ".gitignore"]);
        run(dir, &["commit", "-qm", "ignore"]);
        write(&dir.join("a.txt"), "stashed\n");
        run(dir, &["stash", "-q"]);
        write(&dir.join("a.txt"), "unstaged\n");
        write(&dir.join("b.txt"), "staged\n");
        run(dir, &["add", "b.txt"]);
        write(&dir.join("c.txt"), "untracked\n");
        write(&dir.join("target/out"), "ignored\n");
    }

    fn refusal(dir: &Path, tmp: &Path) -> String {
        preview(dir, &store(tmp)).unwrap_err()
    }

    #[test]
    fn a_busy_clone_converts_with_git_reading_the_same() {
        let tmp = tmp();
        let dir = repo(&tmp);
        busy(&dir);
        let before = state(&dir);

        let p = convert(&dir, &store(&tmp)).unwrap();

        let checkout = dir.join("main");
        assert_eq!(p.target, s(&checkout));
        assert_eq!(state(&checkout), before);
        assert!(checkout.join("target/out").is_file());
        assert!(dir.join(".bare").is_dir() && dir.join(".git").is_file());
        assert!(dir.join(".bare/worktrees/main").is_dir(), "admin id is the leaf");
        assert!(!interrupted(&dir));
        assert_eq!(run(&dir, &["config", "--bool", "core.bare"]).trim(), "true");
    }

    #[test]
    fn a_top_level_folder_named_like_the_branch_still_converts() {
        let tmp = tmp();
        let dir = repo(&tmp);
        write(&dir.join("main/x.txt"), "x\n");
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-qm", "main dir"]);
        let before = state(&dir);

        convert(&dir, &store(&tmp)).unwrap();

        assert_eq!(state(&dir.join("main")), before);
        assert!(dir.join("main/main/x.txt").is_file());
    }

    #[test]
    fn a_failure_after_the_repo_went_bare_restores_the_clone() {
        let tmp = tmp();
        let dir = repo(&tmp);
        busy(&dir);
        let before = state(&dir);

        test_stop::set("bared", false);
        assert!(convert(&dir, &store(&tmp)).is_err());

        assert!(dir.join(".git").is_dir() && !dir.join(".bare").exists());
        assert!(!interrupted(&dir));
        assert_eq!(state(&dir), before);
        assert!(dir.join("target/out").is_file());
    }

    #[test]
    fn each_refusal_names_its_reason() {
        let tmp = tmp();
        let dir = repo(&tmp);
        let git_dir = dir.join(".git");
        for (marker, what) in [
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("MERGE_HEAD", "merge"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
            ("BISECT_LOG", "bisect"),
        ] {
            write(&git_dir.join(marker), "");
            assert!(refusal(&dir, &tmp).contains(what), "{marker}");
            let _ = std::fs::remove_file(git_dir.join(marker));
        }
        write(&dir.join(".gitmodules"), "");
        assert!(refusal(&dir, &tmp).contains("submodules"));
        std::fs::remove_file(dir.join(".gitmodules")).unwrap();

        for (key, what) in [
            ("core.sparseCheckout", "sparse"),
            ("extensions.worktreeConfig", "per-worktree config"),
            ("core.worktree", "core.worktree"),
        ] {
            let value = if key == "core.worktree" { s(&dir) } else { "true".into() };
            run(&dir, &["config", key, &value]);
            assert!(refusal(&dir, &tmp).contains(what), "{key}");
            run(&dir, &["config", "--unset", key]);
        }

        run(&dir, &["checkout", "-q", "--detach"]);
        assert!(refusal(&dir, &tmp).contains("detached"));
        run(&dir, &["checkout", "-q", "main"]);

        let unborn = tmp.join("unborn");
        std::fs::create_dir_all(&unborn).unwrap();
        run(&unborn, &["init", "-q", "-b", "main"]);
        assert!(refusal(&unborn, &tmp).contains("no commits"));

        let plain_dir = tmp.join("folder");
        std::fs::create_dir_all(&plain_dir).unwrap();
        assert!(refusal(&plain_dir, &tmp).contains("no .git directory"));

        run(&dir, &["worktree", "add", "-q", ".tori/worktrees/main", "-b", "t"]);
        assert!(refusal(&dir, &tmp).contains("would land where"));
    }

    #[test]
    fn a_repo_mid_rebase_is_refused() {
        let tmp = tmp();
        let dir = repo(&tmp);
        run(&dir, &["checkout", "-qb", "other"]);
        write(&dir.join("a.txt"), "theirs\n");
        run(&dir, &["commit", "-qam", "theirs"]);
        run(&dir, &["checkout", "-q", "main"]);
        write(&dir.join("a.txt"), "ours\n");
        run(&dir, &["commit", "-qam", "ours"]);
        let rebase = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["rebase", "other"])
            .output()
            .unwrap();
        assert!(!rebase.status.success(), "the rebase stops on its conflict");

        assert!(refusal(&dir, &tmp).starts_with("A rebase is in progress"));
    }

    #[test]
    fn the_preview_groups_linked_worktrees_and_warns_a_reference() {
        let tmp = tmp();
        let dir = repo(&tmp);
        run(&dir, &["checkout", "-qb", "work"]);
        run(&dir, &["worktree", "add", "-q", ".tori/worktrees/t", "-b", "feat/t"]);
        run(&dir, &["worktree", "add", "-q", "wt/n", "-b", "n"]);
        let outside = tmp.join("outside");
        run(&dir, &["worktree", "add", "-q", &s(&outside), "-b", "o"]);
        let store = store_with(&tmp, vec![topic("r", member(&dir, MemberMode::Reference, None))]);

        let p = preview(&dir, &store).unwrap();

        assert_eq!(p.target, s(&dir.join("work")));
        assert_eq!(
            p.tori,
            vec![Move {
                from: s(&dir.join(".tori/worktrees/t")),
                to: s(&dir.join("t"))
            }]
        );
        assert_eq!(
            p.nested,
            vec![Move {
                from: s(&dir.join("wt/n")),
                to: s(&dir.join("work/wt/n"))
            }]
        );
        assert_eq!(p.outside, vec![s(&outside)]);
        assert_eq!(p.topics, vec!["r".to_string()]);
    }

    #[test]
    fn every_linked_worktree_survives_and_the_topic_member_follows() {
        let tmp = tmp();
        let dir = repo(&tmp);
        let tori = dir.join(".tori/worktrees/t");
        run(&dir, &["worktree", "add", "-q", &s(&tori), "-b", "feat/t"]);
        write(&tori.join("dirty.txt"), "x\n");
        run(&dir, &["worktree", "add", "-q", "wt/n", "-b", "n"]);
        let outside = tmp.join("outside");
        run(&dir, &["worktree", "add", "-q", &s(&outside), "-b", "o"]);
        let store = store_with(&tmp, vec![topic("t", member(&dir, MemberMode::Worktree, Some(&tori)))]);

        convert(&dir, &store).unwrap();

        let moved = [dir.join("t"), dir.join("main/wt/n"), outside.clone()];
        for wt in &moved {
            run(wt, &["status"]);
        }
        assert!(dir.join("t/dirty.txt").is_file());
        let listed = run(&dir, &["worktree", "list", "--porcelain"]);
        for wt in &moved {
            assert!(
                listed.contains(&format!("worktree {}\n", s(wt))),
                "{} in {listed}",
                wt.display()
            );
        }
        let t = crate::topics::list_topics(&store);
        assert_eq!(
            t[0].members[0].worktree_path.as_deref(),
            Some(s(&dir.join("t")).as_str())
        );
        assert_eq!(t[0].members[0].state, MemberState::Present);
    }

    fn assert_undo_restores(stop: &'static str) {
        let tmp = tmp();
        let dir = repo(&tmp);
        busy(&dir);
        let tori = dir.join(".tori/worktrees/t");
        run(&dir, &["worktree", "add", "-q", &s(&tori), "-b", "feat/t"]);
        let store = store_with(&tmp, vec![topic("t", member(&dir, MemberMode::Worktree, Some(&tori)))]);
        let before = state(&dir);

        test_stop::set(stop, true);
        assert!(convert(&dir, &store).is_err());

        assert!(interrupted(&dir), "{stop}");
        assert!(crate::config::removable_stub(&dir).is_err(), "{stop}");

        undo(&dir, &store).unwrap();

        assert!(!interrupted(&dir), "{stop}");
        assert!(dir.join(".git").is_dir() && !dir.join(".bare").exists(), "{stop}");
        assert_eq!(state(&dir), before, "{stop}");
        run(&tori, &["status"]);
        let t = crate::topics::list_topics(&store);
        assert_eq!(
            t[0].members[0].worktree_path.as_deref(),
            Some(s(&tori).as_str()),
            "{stop}"
        );
    }

    #[test]
    fn a_crash_partway_through_staging_undoes() {
        assert_undo_restores("stage-one");
    }

    #[test]
    fn a_crash_after_the_repo_went_bare_undoes() {
        assert_undo_restores("bared");
    }

    #[test]
    fn a_crash_after_the_swap_undoes() {
        assert_undo_restores("swapped");
    }
}
