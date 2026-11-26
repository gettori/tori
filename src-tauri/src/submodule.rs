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

#[tauri::command]
pub async fn git_submodule_init(
    state: tauri::State<'_, crate::askpass::AskpassState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let bridge = state.0.clone();
    crate::exec::blocking("git_submodule_init", move || {
        init(&root, &paths, bridge.sock_path(), bridge.token())
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
