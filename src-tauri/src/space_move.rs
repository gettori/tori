// Git's worktree links are rewritten as files rather than by `git worktree
// repair`: a folder from outside the base is not trusted, and running git in
// it would run its config.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::base_layout::worktree_of_another_repo;
use crate::config::ProjectIndex;
use crate::topics::Store;

const CONVERT_JOURNAL: &str = "tori-convert.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Planned {
    pub from: String,
    pub to: String,
    // The resolved source, kept because it cannot be worked out once the
    // folder has moved, and links git wrote may use either spelling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub real: Option<String>,
    #[serde(default)]
    pub done: bool,
}

impl Planned {
    fn olds(&self) -> Vec<PathBuf> {
        let mut olds = vec![PathBuf::from(&self.from)];
        olds.extend(self.real.iter().filter(|r| **r != self.from).map(PathBuf::from));
        olds
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Journal {
    pub moves: Vec<Planned>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    pub space: String,
    pub name: String,
    pub path: String,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn canon(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn under(path: &Path, folder: &Path) -> bool {
    path.starts_with(folder) || canon(path).starts_with(canon(folder))
}

fn rebase(path: &Path, olds: &[PathBuf], new: &Path) -> Option<PathBuf> {
    olds.iter()
        .find_map(|old| path.strip_prefix(old).ok())
        .map(|rest| match rest.as_os_str().is_empty() {
            true => new.to_path_buf(),
            false => new.join(rest),
        })
}

fn git_dir(folder: &Path) -> Option<PathBuf> {
    let dotgit = folder.join(".git");
    if dotgit.is_dir() {
        return Some(dotgit);
    }
    if let Some(target) = std::fs::read_to_string(&dotgit)
        .ok()
        .and_then(|t| t.trim().strip_prefix("gitdir:").map(|g| folder.join(g.trim())))
    {
        return Some(target);
    }
    let bare = folder.join(".bare");
    if bare.is_dir() {
        return Some(bare);
    }
    (folder.join("HEAD").is_file() && folder.join("objects").is_dir()).then(|| folder.to_path_buf())
}

fn converting(folder: &Path) -> bool {
    [".git", ".bare"]
        .iter()
        .any(|d| folder.join(d).join(CONVERT_JOURNAL).is_file())
}

fn rewrite_gitdir_line(file: &Path, olds: &[PathBuf], new: &Path) -> Result<(), String> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Ok(());
    };
    let Some(target) = text.trim().strip_prefix("gitdir:").map(str::trim) else {
        return Ok(());
    };
    if let Some(moved) = rebase(Path::new(target), olds, new) {
        std::fs::write(file, format!("gitdir: {}\n", moved.display()))
            .map_err(|e| format!("{}: {e}", file.display()))?;
    }
    Ok(())
}

fn relink_worktrees(olds: &[PathBuf], new: &Path) -> Result<(), String> {
    let Some(gitdir) = git_dir(new) else {
        return Ok(());
    };
    let Ok(admins) = std::fs::read_dir(gitdir.join("worktrees")) else {
        return Ok(());
    };
    for admin in admins.flatten().map(|e| e.path()) {
        let backlink = admin.join("gitdir");
        let Ok(text) = std::fs::read_to_string(&backlink) else {
            continue;
        };
        let checkout = PathBuf::from(text.trim());
        if !checkout.is_absolute() {
            continue;
        }
        let checkout = match rebase(&checkout, olds, new) {
            Some(moved) => {
                std::fs::write(&backlink, format!("{}\n", moved.display()))
                    .map_err(|e| format!("{}: {e}", backlink.display()))?;
                moved
            }
            None => checkout,
        };
        rewrite_gitdir_line(&checkout, olds, new)?;
    }
    Ok(())
}

fn same_volume(a: &Path, b: &Path) -> bool {
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

fn taken(space: &Path, name: &str) -> bool {
    let want = name.to_lowercase();
    std::fs::read_dir(space).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|e| e.file_name().to_string_lossy().to_lowercase() == want)
    })
}

fn target_of(base: &Path, space: &str, name: &str) -> Result<PathBuf, String> {
    for part in [space, name] {
        let p = part.trim();
        if p.is_empty() || p.contains('/') || p.starts_with('.') {
            return Err(format!("\"{part}\" is not a folder name"));
        }
    }
    Ok(base.join(space.trim()).join(name.trim()))
}

fn refusal(path: &Path, target: &Path, busy: &[String]) -> Option<String> {
    if !path.is_dir() {
        return Some(format!("{} is not a folder.", path.display()));
    }
    let space = target.parent()?;
    if !space.is_dir() {
        return Some(format!("There is no space folder at {}.", space.display()));
    }
    if under(space, path) {
        return Some("A folder can't move into itself.".into());
    }
    if taken(space, &target.file_name()?.to_string_lossy()) {
        return Some(format!(
            "{} already has a folder named {}.",
            space.file_name()?.to_string_lossy(),
            target.file_name()?.to_string_lossy()
        ));
    }
    if worktree_of_another_repo(path) {
        return Some("This is a worktree of another repository. Move that repository instead.".into());
    }
    if converting(path) {
        return Some("This project is halfway through a layout conversion. Finish or undo it first.".into());
    }
    if !same_volume(path, space) {
        return Some("This folder is on a different disk. Attach it to Home instead.".into());
    }
    busy_refusal(path, busy)
}

// Every step after the rename reports rather than stops: the folder has
// already moved, and a store left behind is worth telling, not undoing.
fn settle(olds: &[PathBuf], to: &Path, topics: &Store) -> Vec<String> {
    let mut failed = Vec::new();
    let new = s(to);
    let store = crate::exec::cross_process_store_lock("config");
    for old in olds.iter().map(|o| s(o)) {
        let mut steps: Vec<(&str, Result<(), String>)> = vec![
            ("sessions", crate::sessions::rekey_adopted(&old, &new)),
            ("issues", crate::issues::store::rekey(&old, &new)),
            ("issue repos", crate::issues::repos::rekey(&old, &new)),
            ("origins", crate::unit_origins::rekey(&old, &new)),
            ("trust", crate::trust::rekey(&old, &new)),
            ("settings", crate::settings::rekey_project(&old, &new)),
        ];
        if let Ok(store) = &store {
            steps.push(("branches", crate::config::rekey_attached_branches(store, &old, &new)));
            steps.push(("config", crate::config::settle_moved_entry(store, &old, &new)));
        }
        failed.extend(
            steps
                .into_iter()
                .filter_map(|(what, r)| r.err().map(|e| format!("{what}: {e}"))),
        );
    }
    if let Err(e) = &store {
        failed.push(format!("config: {e}"));
    }
    drop(store);
    let olds: Vec<String> = olds.iter().map(|o| s(o)).collect();
    if let Err(e) = crate::topics::move_repo(topics, &olds, &new) {
        failed.push(format!("topics: {e}"));
    }
    failed
}

// Safe to run again on a move a crash cut short: the rename happens only while
// the source is still there, and relinking an already-moved folder finds
// nothing under the old path.
fn relocate(planned: &Planned) -> Result<Vec<PathBuf>, String> {
    let (from, to) = (Path::new(&planned.from), Path::new(&planned.to));
    if from.exists() {
        std::fs::rename(from, to).map_err(|e| format!("Couldn't move {}: {e}", from.display()))?;
    } else if !to.exists() {
        return Err(format!("{} is gone, and nothing is at {}.", planned.from, planned.to));
    }
    let olds = planned.olds();
    relink_worktrees(&olds, to).map_err(|e| format!("Moved, but its worktrees still point at the old path: {e}"))?;
    Ok(olds)
}

fn move_one(planned: &Planned) -> Result<Vec<String>, String> {
    let olds = relocate(planned)?;
    Ok(settle(&olds, Path::new(&planned.to), &Store::default_location()))
}

type Step<'a> = &'a mut dyn FnMut(&Planned) -> Result<Vec<String>, String>;

fn journal_path() -> PathBuf {
    crate::owned_state::config_dir().join("move-journal.json")
}

fn load_journal(file: &Path) -> Result<Option<Journal>, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Tori can't read {}: {e}", file.display())),
    };
    serde_json::from_str(&text).map(Some).map_err(|e| {
        format!(
            "{} is damaged ({e}). Check the folders it names, then delete it.",
            file.display()
        )
    })
}

fn save_journal(file: &Path, journal: &Journal) -> Result<(), String> {
    let text = serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(file, &text)
}

fn run_journal(file: &Path, mut journal: Journal, step: Step) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    for i in 0..journal.moves.len() {
        if journal.moves[i].done {
            continue;
        }
        warnings.extend(step(&journal.moves[i])?);
        journal.moves[i].done = true;
        save_journal(file, &journal)?;
    }
    std::fs::remove_file(file).map_err(|e| format!("journal: {e}"))?;
    Ok(warnings)
}

fn plan(base: &Path, requests: &[MoveRequest], busy: &[String]) -> Result<Journal, String> {
    let mut moves = Vec::new();
    let mut targets: Vec<String> = Vec::new();
    for r in requests {
        let from = PathBuf::from(r.path.trim().trim_end_matches('/'));
        let to = target_of(base, &r.space, &r.name)?;
        if let Some(why) = refusal(&from, &to, busy) {
            return Err(format!("{}: {why}", r.name));
        }
        let key = s(&to).to_lowercase();
        if targets.contains(&key) {
            return Err(format!("Two projects would both be {}.", to.display()));
        }
        targets.push(key);
        moves.push(Planned {
            real: Some(s(&canon(&from))),
            from: s(&from),
            to: s(&to),
            done: false,
        });
    }
    Ok(Journal { moves })
}

fn daemon_pty_cwds() -> Result<Vec<String>, String> {
    let ptys = crate::rpc::daemon_request("pty.list", serde_json::json!({}))
        .map_err(|e| format!("Tori can't check for running sessions: {e}"))?;
    Ok(ptys
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["cwd"].as_str().map(str::to_string))
        .collect())
}

fn chat_cwds(app: &AppHandle) -> Result<Vec<String>, String> {
    let chats: Vec<(String, String)> = app
        .state::<crate::chat::client::ChatState>()
        .0
        .call_as("live_sessions", serde_json::json!({}))?;
    Ok(chats.into_iter().map(|(_, cwd)| cwd).collect())
}

fn live_session_cwds(app: &AppHandle) -> Result<Vec<String>, String> {
    let mut cwds = daemon_pty_cwds()?;
    cwds.extend(chat_cwds(app)?);
    Ok(cwds)
}

fn finish(app: &AppHandle, index: &ProjectIndex, journal: &Journal, warnings: Vec<String>) -> Result<Moved, String> {
    for m in &journal.moves {
        index.evict(Path::new(&m.from));
        index.evict(Path::new(&m.to));
    }
    let _ = app.emit("config://changed", ());
    for topic in crate::topics::list_topics(&Store::default_location()) {
        let _ = app.emit("topics://changed", &topic);
    }
    Ok(Moved {
        moves: journal.moves.clone(),
        warning: (!warnings.is_empty()).then(|| {
            format!(
                "Moved, but some settings stayed at the old path ({})",
                warnings.join("; ")
            )
        }),
    })
}

#[derive(Serialize, Debug)]
pub struct Moved {
    pub moves: Vec<Planned>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[tauri::command(async)]
pub fn move_into_space(
    app: AppHandle,
    index: State<ProjectIndex>,
    base: String,
    moves: Vec<MoveRequest>,
) -> Result<Moved, String> {
    let file = journal_path();
    if file.exists() {
        return Err("An earlier move didn't finish. Resume it first.".into());
    }
    let journal = plan(Path::new(base.trim()), &moves, &live_session_cwds(&app)?)?;
    save_journal(&file, &journal)?;
    let warnings = run_journal(&file, journal.clone(), &mut move_one)?;
    finish(&app, &index, &journal, warnings)
}

#[tauri::command(async)]
pub fn move_journal() -> Result<Option<Journal>, String> {
    load_journal(&journal_path())
}

#[tauri::command(async)]
pub fn resume_moves(app: AppHandle, index: State<ProjectIndex>) -> Result<Moved, String> {
    let file = journal_path();
    let journal = load_journal(&file)?.ok_or("There is no unfinished move.")?;
    let busy = live_session_cwds(&app)?;
    for m in journal.moves.iter().filter(|m| !m.done && Path::new(&m.from).exists()) {
        if let Some(why) = busy_refusal(Path::new(&m.from), &busy) {
            return Err(why);
        }
    }
    let warnings = run_journal(&file, journal.clone(), &mut move_one)?;
    finish(&app, &index, &journal, warnings)
}

fn busy_refusal(path: &Path, busy: &[String]) -> Option<String> {
    busy.iter().any(|cwd| under(Path::new(cwd), path)).then(|| {
        format!(
            "A terminal or agent session is running in {}. Stop it first.",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-space-move-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        canon(&dir)
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        fs::write(dir.join("README.md"), "hi").unwrap();
        git(dir, &["add", "."]);
        git(
            dir,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        );
    }

    fn planned(from: &Path, to: &Path) -> Planned {
        Planned {
            from: s(from),
            to: s(to),
            real: Some(s(&canon(from))),
            done: false,
        }
    }

    fn healthy(repo: &Path) {
        let list = git(repo, &["worktree", "list", "--porcelain"]);
        assert!(!list.contains("prunable"), "{list}");
    }

    #[test]
    fn each_refusal_names_its_reason() {
        let tmp = tmp();
        let base = tmp.join("P");
        fs::create_dir_all(base.join("work/api")).unwrap();
        let folder = tmp.join("API");
        fs::create_dir_all(&folder).unwrap();
        let to = |name: &str| target_of(&base, "work", name).unwrap();
        assert!(refusal(&folder, &to("API"), &[])
            .unwrap()
            .contains("already has a folder named API"));
        assert!(refusal(&tmp.join("gone"), &to("gone"), &[])
            .unwrap()
            .contains("not a folder"));
        assert!(refusal(&folder, &base.join("none/API"), &[])
            .unwrap()
            .contains("no space folder"));
        assert!(refusal(&tmp, &to("x"), &[]).unwrap().contains("into itself"));
        let busy = [s(&folder.join("src"))];
        assert!(refusal(&folder, &to("site"), &busy)
            .unwrap()
            .contains("session is running"));
        assert_eq!(refusal(&folder, &to("site"), &[]), None);

        fs::create_dir_all(folder.join(".git")).unwrap();
        fs::write(folder.join(".git").join(CONVERT_JOURNAL), "{}").unwrap();
        assert!(refusal(&folder, &to("site"), &[])
            .unwrap()
            .contains("layout conversion"));

        let linked = tmp.join("linked");
        fs::create_dir_all(&linked).unwrap();
        fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", tmp.join("elsewhere/.git/worktrees/l").display()),
        )
        .unwrap();
        assert!(refusal(&linked, &to("linked"), &[])
            .unwrap()
            .contains("worktree of another"));
        assert!(target_of(&base, "work", "../x").is_err());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_plain_clone_keeps_its_worktrees_inside_and_outside() {
        let tmp = tmp();
        let from = tmp.join("loose/app");
        repo(&from);
        git(
            &from,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "inner",
                &s(&from.join(".tori/worktrees/inner")),
            ],
        );
        let outside = tmp.join("elsewhere/app-feature");
        git(&from, &["worktree", "add", "-q", "-b", "feature", &s(&outside)]);
        let to = tmp.join("P/work/app");
        fs::create_dir_all(to.parent().unwrap()).unwrap();

        relocate(&planned(&from, &to)).unwrap();

        healthy(&to);
        assert_eq!(
            git(&to.join(".tori/worktrees/inner"), &["branch", "--show-current"]).trim(),
            "inner"
        );
        assert_eq!(git(&outside, &["branch", "--show-current"]).trim(), "feature");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_bare_container_keeps_its_worktrees_inside_and_outside() {
        let tmp = tmp();
        let site = tmp.join("site");
        repo(&site);
        let from = tmp.join("loose/lib");
        fs::create_dir_all(&from).unwrap();
        git(&tmp, &["clone", "-q", "--bare", &s(&site), &s(&from.join(".bare"))]);
        fs::write(from.join(".git"), "gitdir: ./.bare\n").unwrap();
        git(&from, &["worktree", "add", "-q", &s(&from.join("main")), "main"]);
        let outside = tmp.join("elsewhere/lib-next");
        git(&from, &["worktree", "add", "-q", "-b", "next", &s(&outside)]);
        let to = tmp.join("P/work/lib");
        fs::create_dir_all(to.parent().unwrap()).unwrap();

        relocate(&planned(&from, &to)).unwrap();

        healthy(&to);
        assert_eq!(git(&to.join("main"), &["branch", "--show-current"]).trim(), "main");
        assert_eq!(git(&outside, &["branch", "--show-current"]).trim(), "next");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_failed_batch_leaves_its_journal_and_resume_finishes_it() {
        let tmp = tmp();
        let base = tmp.join("P");
        fs::create_dir_all(base.join("work")).unwrap();
        let requests: Vec<MoveRequest> = ["a", "b", "c"]
            .iter()
            .map(|n| {
                fs::create_dir_all(tmp.join(n)).unwrap();
                MoveRequest {
                    space: "work".into(),
                    name: n.to_string(),
                    path: s(&tmp.join(n)),
                }
            })
            .collect();
        let journal = plan(&base, &requests, &[]).unwrap();
        let file = tmp.join("move-journal.json");
        save_journal(&file, &journal).unwrap();

        let mut calls = 0;
        let mut failing = |m: &Planned| {
            calls += 1;
            if calls == 3 {
                return Err("disk full".to_string());
            }
            relocate(m).map(|_| Vec::new())
        };
        assert!(run_journal(&file, journal, &mut failing).is_err());
        let left = load_journal(&file).unwrap().unwrap();
        assert_eq!(
            left.moves.iter().map(|m| m.done).collect::<Vec<_>>(),
            [true, true, false]
        );

        run_journal(&file, left, &mut |m: &Planned| relocate(m).map(|_| Vec::new())).unwrap();
        assert!(!file.exists());
        for n in ["a", "b", "c"] {
            assert!(base.join("work").join(n).is_dir() && !tmp.join(n).exists());
        }
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_batch_cannot_land_two_projects_on_one_name() {
        let tmp = tmp();
        let base = tmp.join("P");
        fs::create_dir_all(base.join("work")).unwrap();
        let request = |dir: &str, name: &str| {
            fs::create_dir_all(tmp.join(dir)).unwrap();
            MoveRequest {
                space: "work".into(),
                name: name.into(),
                path: s(&tmp.join(dir)),
            }
        };
        let err = plan(&base, &[request("one/api", "api"), request("two/api", "API")], &[]).unwrap_err();
        assert!(err.contains("both be"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }
}
