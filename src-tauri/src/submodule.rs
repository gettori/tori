use std::path::Path;

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
