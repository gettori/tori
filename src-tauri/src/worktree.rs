// Git worktree management, so a branch can get its own working directory.

use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
}

#[tauri::command]
pub fn list_worktrees(repo_path: String) -> Result<Vec<Worktree>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(vec![]);
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut result = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch = String::new();
    let mut first = true;

    let flush = |path: &mut Option<String>, branch: &mut String, first: &mut bool, out: &mut Vec<Worktree>| {
        if let Some(p) = path.take() {
            out.push(Worktree {
                path: p,
                branch: std::mem::take(branch),
                is_main: *first,
            });
            *first = false;
        }
    };

    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // New record begins; flush the previous.
            flush(&mut cur_path, &mut cur_branch, &mut first, &mut result);
            cur_path = Some(p.to_string());
            cur_branch = String::new();
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = b.trim_start_matches("refs/heads/").to_string();
        } else if line == "detached" {
            cur_branch = "(detached)".to_string();
        }
    }
    flush(&mut cur_path, &mut cur_branch, &mut first, &mut result);
    Ok(result)
}

/// Add a worktree for `branch` at `worktree_path`. Uses an existing branch if
/// it exists, otherwise creates it.
#[tauri::command]
pub fn add_worktree(
    repo_path: String,
    branch: String,
    worktree_path: String,
) -> Result<(), String> {
    // Does the branch already exist?
    let exists = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&repo_path).arg("worktree").arg("add");
    if exists {
        cmd.arg(&worktree_path).arg(&branch);
    } else {
        cmd.arg("-b").arg(&branch).arg(&worktree_path);
    }

    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn remove_worktree(repo_path: String, worktree_path: String) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["worktree", "remove", &worktree_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}
