// Git queries for the editor: the changed-file list (for a review surface) and
// per-file diff hunks in new-file coordinates (for the CM6 gutter). Both shell
// out to git, like `list_branches` in config.rs. Diffs are taken against HEAD so
// the gutter reflects all uncommitted work (staged + unstaged), matching the
// "uncommitted changes" review surface, not just unstaged edits.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::askpass::{AskpassState, ENV_OP, ENV_SOCK, ENV_TOKEN};
use crate::env::augmented_path;

#[derive(Serialize)]
pub struct GitFileStatus {
    /// Porcelain XY status code, e.g. " M", "??", "A ", "MM".
    status: String,
    path: String,
    /// X (index) column is neither ' ' nor '?': this file has staged changes.
    staged: bool,
    /// Y (worktree) column is not ' ', or the file is untracked ("??"):
    /// this file has unstaged changes. A file can be both (e.g. "MM").
    unstaged: bool,
}

#[tauri::command]
pub fn git_status(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // Not a git repo (or no commits): no changes, not an error.
        return Ok(vec![]);
    }

    Ok(parse_status(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_status(text: &str) -> Vec<GitFileStatus> {
    let mut files = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let code = &line[..2];
        let mut chars = code.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        files.push(GitFileStatus {
            status: code.to_string(),
            path: line[3..].to_string(),
            staged: x != ' ' && x != '?',
            unstaged: y != ' ',
        });
    }
    files
}

/// Stage `paths` (`git add --`). A no-op on an empty list.
#[tauri::command]
pub fn git_stage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_run(&project_path, &args)
}

/// Unstage `paths` back to the working tree (`git restore --staged --`),
/// leaving worktree edits untouched. A no-op on an empty list.
#[tauri::command]
pub fn git_unstage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_run(&project_path, &args)
}

/// The 1-based line range `start..=end` of a file, as the given diff mode's
/// "new" side sees it. Backs the review panel's "n unchanged lines" expander:
/// the diff itself carries only a few lines of context, so revealing the gap
/// between two hunks means reading the file.
///
/// The mode matters. A partially-staged file's Staged section compares
/// index-vs-HEAD, so its unchanged lines are the *index's*, not the working
/// tree's; reading the worktree there would show lines the user has not staged.
#[tauri::command]
pub fn git_file_slice(
    project_path: String,
    file: String,
    mode: Option<DiffMode>,
    start: usize,
    end: usize,
) -> Result<Vec<String>, String> {
    if start == 0 || end < start {
        return Ok(vec![]);
    }

    let content = if mode.unwrap_or_default() == DiffMode::Staged {
        let output = Command::new("git")
            .arg("-C")
            .arg(&project_path)
            .args(["show", &format!(":{}", file)])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Ok(vec![]);
        }
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        let full = Path::new(&project_path).join(&file);
        std::fs::read_to_string(full).map_err(|e| e.to_string())?
    };

    // Clamp rather than error: the file can legitimately be shorter than the
    // range the panel computed if it changed since the diff was taken.
    Ok(content
        .lines()
        .skip(start - 1)
        .take(end - start + 1)
        .map(str::to_string)
        .collect())
}

/// Stage or unstage a subset of a file's hunks, never touching the working
/// tree (`git apply --cached`).
///
/// The two directions read different diffs and must never mix: staging takes
/// hunks from worktree-vs-index and applies forward, unstaging takes them from
/// index-vs-HEAD and applies in reverse. `reverse` picks both at once so a
/// caller cannot pair the wrong source with the wrong direction.
///
/// `fingerprints` is the content hash the UI rendered for each selected hunk.
/// The diff is re-read here and every fingerprint re-checked before anything is
/// applied, because indices alone are not stable: an agent writing to the file
/// between render and click renumbers the hunks, and a positional apply would
/// then stage the wrong one. A mismatch applies nothing and says so.
///
/// `context` must be the `-U<n>` the UI rendered with: hunk boundaries (and so
/// fingerprints) depend on it, since a wider context merges nearby changes into
/// one hunk.
#[tauri::command]
pub fn git_apply_hunks(
    project_path: String,
    file: String,
    hunk_indices: Vec<usize>,
    fingerprints: Vec<String>,
    reverse: bool,
    context: Option<u32>,
) -> Result<(), String> {
    if hunk_indices.len() != fingerprints.len() {
        return Err("Hunk selection is malformed".into());
    }
    if hunk_indices.is_empty() {
        return Ok(());
    }

    // An untracked file has no index entry, so worktree-vs-index shows nothing
    // to build a patch from. Intent-to-add creates the empty entry; the hunk
    // header and body come out identical to the --no-index diff the panel
    // displayed, so the fingerprints still match.
    if reverse {
        // Unstaging only ever touches files already in the index.
    } else if is_untracked(&project_path, &file)? {
        git_run(&project_path, &["add", "-N", "--", &file])?;
    }

    let mode = if reverse { DiffMode::Staged } else { DiffMode::Unstaged };
    let text = git_diff_text(project_path.clone(), file.clone(), context, Some(mode))?;
    let parsed = crate::patch::parse_patch(&text);

    for (&i, expected) in hunk_indices.iter().zip(&fingerprints) {
        let actual = parsed
            .hunks
            .get(i)
            .ok_or_else(|| "The diff changed, refreshed. Nothing was staged.".to_string())?;
        if &actual.fingerprint != expected {
            return Err("The diff changed, refreshed. Nothing was staged.".into());
        }
    }

    let patch = crate::patch::build_patch(&parsed, &hunk_indices, reverse)?;
    apply_cached(&project_path, &patch, reverse)
}

/// True when git does not track `file` at all (no index entry).
fn is_untracked(project_path: &str, file: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project_path)
        .args(["ls-files", "--", file])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

/// Feed `patch` to `git apply --cached` on stdin. Index-only: `--cached`
/// deliberately leaves the working tree alone, so a failed apply can never
/// leave the user's edits half-rewritten.
fn apply_cached(project_path: &str, patch: &str, reverse: bool) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = Command::new("git");
    // No --unidiff-zero: the panel always diffs with real context, and that
    // flag exists to disable the context checks a zero-context patch cannot
    // satisfy. Keeping them on means a patch that no longer fits is rejected
    // rather than applied somewhere plausible-looking.
    cmd.arg("-C").arg(project_path).args(["apply", "--cached"]);
    if reverse {
        cmd.arg("--reverse");
    }
    let mut child = cmd
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    child
        .stdin
        .as_mut()
        .ok_or("Could not write the patch to git")?
        .write_all(patch.as_bytes())
        .map_err(|e| e.to_string())?;

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if err.is_empty() {
        "git could not apply the selected hunks; nothing was staged.".into()
    } else {
        err
    })
}

/// Commit whatever is currently staged with `message`. Refuses an empty
/// message locally rather than letting git reject it (clearer error text).
///
/// `amend` rewrites HEAD instead of adding a commit, so it is the one path here
/// that needs nothing staged: amending only the message is a normal thing to
/// want. Whether that rewrite is safe (has HEAD been pushed?) is the caller's
/// question, not this one's - see `amendRewritesPushed` in
/// `src/utils/commitMessage.ts`.
#[tauri::command]
pub fn git_commit(project_path: String, message: String, amend: Option<bool>) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message is empty".into());
    }
    let mut args = vec!["commit"];
    if amend.unwrap_or(false) {
        args.push("--amend");
    }
    args.extend(["-m", message]);
    git_run(&project_path, &args)
}

/// HEAD's full commit message, for prefilling the editor when amend is toggled
/// on. An unborn HEAD has no message to read, and that is not an error here:
/// the toggle simply has nothing to prefill, so failure reads as empty.
#[tauri::command]
pub fn git_head_message(project_path: String) -> Result<String, String> {
    Ok(git_capture(&project_path, &["log", "-1", "--format=%B"]).unwrap_or_default())
}

/// Which two trees a diff compares. A partially-staged ("MM") file has a row in
/// both the Staged and Changes sections, and one comparison cannot describe
/// both: the Staged row needs index-vs-HEAD, the Changes row worktree-vs-index.
#[derive(Deserialize, Default, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    /// Worktree vs HEAD: all uncommitted work, staged or not. The default,
    /// because it is what the gutter and the session diff both want (see the
    /// module header) - staging a file must not blank its gutter marks.
    #[default]
    Head,
    /// Index vs HEAD: exactly what a commit would contain right now.
    Staged,
    /// Worktree vs index: what is still unstaged.
    Unstaged,
}

impl DiffMode {
    /// The revision selector for this comparison. Everything else about the
    /// command (paths, --no-color, -U) is shared.
    fn args(self) -> &'static [&'static str] {
        match self {
            DiffMode::Head => &["HEAD"],
            DiffMode::Staged => &["--cached", "HEAD"],
            DiffMode::Unstaged => &[],
        }
    }

    /// Whether an empty result should fall back to showing an untracked file as
    /// all-additions. Meaningless for `Staged`: an untracked file is by
    /// definition absent from the index, so "nothing staged" is the true answer.
    fn shows_untracked(self) -> bool {
        self != DiffMode::Staged
    }
}

#[derive(Serialize)]
pub struct DiffHunk {
    /// "added" | "modified" | "deleted".
    kind: String,
    /// 1-based first affected line in the new file. For a pure deletion this is
    /// the line after which content was removed (git's convention).
    start: u32,
    /// New-file lines affected; 0 for a pure deletion.
    count: u32,
}

/// Parse a unified-diff range token like "12,3" or "12" (count defaults to 1).
fn parse_range(s: &str) -> (u32, u32) {
    let mut parts = s.splitn(2, ',');
    let start = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let count = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
    (start, count)
}

#[tauri::command]
pub fn git_diff_file(project_path: String, file: String, mode: Option<DiffMode>) -> Result<Vec<DiffHunk>, String> {
    let mode = mode.unwrap_or_default();
    // -U0: hunk headers carry exact ranges, no surrounding context to walk.
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff"])
        .args(mode.args())
        .args(["--no-color", "-U0", "--", &file])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // No HEAD yet, untracked file, or not a repo: no hunks.
        return Ok(vec![]);
    }

    Ok(parse_hunks(&String::from_utf8_lossy(&output.stdout)))
}

/// Raw unified diff text for a single file, for the inline review view.
/// Untracked files have no diff against a tree, so fall back to showing the
/// whole file as additions (`git diff --no-index /dev/null <file>`).
///
/// `context` sets `-U<n>`; the review panel asks for more than git's default 3
/// so its "n unchanged lines" collapse has something real to hide and to reveal
/// on expand. Omitted means git's default. `mode` picks which two trees are
/// compared, defaulting to worktree-vs-HEAD.
#[tauri::command]
pub fn git_diff_text(
    project_path: String,
    file: String,
    context: Option<u32>,
    mode: Option<DiffMode>,
) -> Result<String, String> {
    let mode = mode.unwrap_or_default();
    let unified: Vec<String> = context.map(|n| format!("-U{}", n)).into_iter().collect();

    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff"])
        .args(mode.args())
        .args(["--no-color"])
        .args(&unified)
        .args(["--", &file])
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if (output.status.success() && !text.trim().is_empty()) || !mode.shows_untracked() {
        return Ok(text);
    }

    // Untracked (or no HEAD): diff against an empty tree so new files still show.
    let untracked = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "--no-color", "--no-index"])
        .args(&unified)
        .args(["--", "/dev/null", &file])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&untracked.stdout).into_owned())
}

fn parse_hunks(text: &str) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    for line in text.lines() {
        // Hunk header: @@ -old_start,old_count +new_start,new_count @@
        let Some(rest) = line.strip_prefix("@@ ") else {
            continue;
        };
        let mut tokens = rest.split_whitespace();
        let (Some(minus), Some(plus)) = (tokens.next(), tokens.next()) else {
            continue;
        };
        if !minus.starts_with('-') || !plus.starts_with('+') {
            continue;
        }
        let (_, old_count) = parse_range(&minus[1..]);
        let (new_start, new_count) = parse_range(&plus[1..]);
        let kind = if old_count == 0 {
            "added"
        } else if new_count == 0 {
            "deleted"
        } else {
            "modified"
        };
        hunks.push(DiffHunk {
            kind: kind.to_string(),
            start: new_start,
            count: new_count,
        });
    }
    hunks
}

/// Switch the shared working tree to `branch` (plain repos only; the frontend
/// gates this). git checkout is atomic: on a dirty/conflicting tree it fails and
/// leaves the tree untouched, so surfacing stderr is enough to never half-switch.
#[tauri::command]
pub fn git_checkout(repo_path: String, branch: String) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["checkout", &branch])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

// --- plain-dir git lifecycle (init / remote / origin) ---

fn git_run(repo: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// A default .gitignore scaffolded on `git init`, excluding the common junk that
/// must never enter the first commit.
const DEFAULT_GITIGNORE: &str = "\
# Dependencies
node_modules/

# Build output
dist/
build/
target/

# Logs
*.log

# Environment
.env
.env.local

# OS / editor cruft
.DS_Store
Thumbs.db
";

/// Whether git has a usable author identity (both `user.name` and `user.email`, any
/// scope), so an initial commit won't fail with "Author identity unknown".
fn has_git_identity(repo: &str) -> bool {
    let set = |key: &str| {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["config", "--get", key])
            .output()
            .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
            .unwrap_or(false)
    };
    set("user.name") && set("user.email")
}

/// Core of `git_init` without the app event, so it is unit-testable: `git init`
/// (optional initial branch via symbolic-ref, portable across git versions) and
/// a scaffolded .gitignore when none exists. Refuses an existing repo. Returns
/// whether an initial commit was made (false when git has no identity).
fn do_init(dir: &Path, branch: Option<&str>) -> Result<bool, String> {
    if dir.join(".git").exists() {
        return Err("This folder is already a git repository.".into());
    }
    let path = dir.to_string_lossy();
    git_run(&path, &["init", "-q"])?;
    if let Some(b) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        if b.contains('/') || b.contains(char::is_whitespace) || b.starts_with('-') {
            return Err("Invalid branch name".into());
        }
        git_run(&path, &["symbolic-ref", "HEAD", &format!("refs/heads/{b}")])?;
    }
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, DEFAULT_GITIGNORE).map_err(|e| e.to_string())?;
    }
    // Born the branch with an empty root commit so the repo is immediately usable:
    // the branch shows by name (not a nameless folder unit) and new branches can be
    // created off it. Skipped when git has no author identity, so init never
    // hard-fails; discovery still shows the unborn branch by name, and the UI warns.
    if !has_git_identity(&path) {
        return Ok(false);
    }
    git_run(&path, &["commit", "--allow-empty", "-q", "-m", "Initial commit"])?;
    Ok(true)
}

/// Initialize a git repo in a plain-dir project (optional initial branch),
/// scaffolding a default .gitignore. Re-discovers (plain-dir becomes plain).
/// Returns whether an initial commit was made, so the UI can warn when a missing
/// git identity left the repo unborn.
#[tauri::command]
pub fn git_init(app: AppHandle, project_path: String, branch: Option<String>) -> Result<bool, String> {
    let committed = do_init(Path::new(&project_path), branch.as_deref())?;
    let _ = app.emit("config://changed", ());
    Ok(committed)
}

/// Capture the trimmed stdout of `git -C <repo> <args>`, or an error with stderr.
fn git_capture(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Core of `bare_init` without the app event, so it is unit-testable. Turns an
/// existing plain-dir folder into a bare+worktree layout *in place* (no clone): a
/// `.bare` bare repo, a `.git` pointer file, and one initial worktree on an unborn
/// `<branch>` (blank = git's default). The result is a usable worktree container
/// with no commits yet, so a remote can be added and fetched later (like `git init`
/// then "Add Origin"). Existing files in the folder are untouched. Refuses a folder
/// that is already a git repo.
fn do_bare_init(dir: &Path, branch: Option<&str>) -> Result<(), String> {
    if dir.join(".git").exists() || dir.join(".bare").exists() {
        return Err("This folder is already a git repository.".into());
    }
    let path = dir.to_string_lossy().into_owned();
    let branch = branch.map(str::trim).filter(|b| !b.is_empty());
    if let Some(b) = branch {
        if b.contains('/') || b.contains(char::is_whitespace) || b.starts_with('-') {
            return Err("Invalid branch name".into());
        }
    }

    // 1. A bare repo under `.bare` (relative to the folder, created by init).
    match branch {
        Some(b) => git_run(&path, &["init", "--bare", "-q", "-b", b, ".bare"])?,
        None => git_run(&path, &["init", "--bare", "-q", ".bare"])?,
    }
    // 2. The `.git` pointer so the folder resolves to `.bare` as its git dir.
    std::fs::write(dir.join(".git"), "gitdir: ./.bare\n").map_err(|e| e.to_string())?;
    // 3. The initial worktree on the default branch, unborn (--orphan needs no
    //    commit), named after the branch. Read the default when none was given.
    let def = match branch {
        Some(b) => b.to_string(),
        None => git_capture(&path, &["symbolic-ref", "--short", "HEAD"])?,
    };
    git_run(&path, &["worktree", "add", "--orphan", "-b", &def, &def])?;
    Ok(())
}

/// Bootstrap a bare+worktree layout in an existing plain-dir folder (optional
/// initial branch). Re-discovers (plain-dir becomes a worktree container).
#[tauri::command]
pub fn bare_init(app: AppHandle, project_path: String, branch: Option<String>) -> Result<(), String> {
    do_bare_init(Path::new(&project_path), branch.as_deref())?;
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Add the `origin` remote, or update its URL if it already exists.
#[tauri::command]
pub fn git_remote_add(app: AppHandle, project_path: String, url: String) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Remote URL is empty".into());
    }
    let exists = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["remote", "get-url", "origin"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if exists {
        git_run(&project_path, &["remote", "set-url", "origin", url])?;
    } else {
        git_run(&project_path, &["remote", "add", "origin", url])?;
    }
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Origin's URL if configured, else None. Lets the UI gate push on a remote.
#[tauri::command]
pub fn git_origin(project_path: String) -> Result<Option<String>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["remote", "get-url", "origin"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!url.is_empty()).then_some(url))
}

// --- auth'd / network git via the askpass bridge ---

/// A fresh per-op id. Each network op gets one so its sibling username/password
/// prompts (separate git askpass processes) share a single cancel latch.
fn next_op_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("op-{}-{}", std::process::id(), n)
}

/// Build a `git -C <repo>` command wired to the askpass credential bridge:
/// `GIT_ASKPASS`/`SSH_ASKPASS` point at Sway's own binary (re-exec'd as the
/// helper), `SSH_ASKPASS_REQUIRE=force` makes ssh use it without a TTY (OpenSSH
/// >= 8.4), `GIT_TERMINAL_PROMPT=0` forbids any terminal fallback (fail closed),
/// `LC_ALL=C` keeps prompt wording stable for `kind` parsing, and
/// `StrictHostKeyChecking=accept-new` handles first-contact SSH host keys (TOFU:
/// auto-add an unknown host, still reject a *changed* key). The op id and socket
/// coordinates ride through the env into the helper.
fn git_command(repo: &str, op_id: &str, sock: &Path, token: &str) -> Command {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("git"));
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo);
    cmd.env("GIT_ASKPASS", &exe);
    cmd.env("SSH_ASKPASS", &exe);
    cmd.env("SSH_ASKPASS_REQUIRE", "force");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    cmd.env("GIT_SSH_COMMAND", "ssh -o StrictHostKeyChecking=accept-new");
    cmd.env(ENV_SOCK, sock);
    cmd.env(ENV_TOKEN, token);
    cmd.env(ENV_OP, op_id);
    cmd.env("PATH", augmented_path());
    cmd
}

/// Payload for the background-fetch result events.
#[derive(Clone, Serialize)]
pub struct FetchResult {
    repo: String,
    ok: bool,
    error: String,
}

/// Background `git fetch` through the askpass bridge: runs on its own thread with
/// a fresh op id, so credential prompts pop the in-app dialog (no terminal tab)
/// and a cancel aborts the whole op. Emits `git://fetch-done` on success and
/// `git://fetch-error` on failure; both carry the repo path so the UI can
/// correlate. `remote` defaults to `--all`.
#[tauri::command]
pub fn git_fetch(
    app: AppHandle,
    state: State<AskpassState>,
    repo: String,
    remote: Option<String>,
) -> Result<(), String> {
    let inner = state.0.clone();
    let op_id = next_op_id();
    thread::spawn(move || {
        let mut cmd = git_command(&repo, &op_id, inner.sock_path(), inner.token());
        cmd.arg("fetch");
        match remote.as_deref() {
            Some(r) if !r.trim().is_empty() => {
                cmd.arg(r);
            }
            _ => {
                cmd.arg("--all");
            }
        }
        let (ok, error) = match cmd.output() {
            Ok(o) if o.status.success() => (true, String::new()),
            Ok(o) => (false, String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => (false, e.to_string()),
        };
        let event = if ok { "git://fetch-done" } else { "git://fetch-error" };
        let _ = app.emit(event, FetchResult { repo, ok, error });
    });
    Ok(())
}

/// Whether `branch` already tracks an upstream in `repo`, so `git_push` knows
/// whether to pass `--set-upstream` on its first push.
fn has_upstream(repo: &str, branch: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", &format!("{branch}@{{u}}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Payload for the background-push result events.
#[derive(Clone, Serialize)]
pub struct PushResult {
    repo: String,
    ok: bool,
    error: String,
}

/// Background `git push` through the askpass bridge, a sibling of `git_fetch`:
/// runs on its own thread with a fresh op id, so credential prompts pop the
/// in-app dialog. Passes `--set-upstream` when `branch` tracks nothing yet
/// (its first push). Emits `git://push-done` on success and `git://push-error`
/// on failure; both carry the repo path so the UI can correlate.
#[tauri::command]
pub fn git_push(
    app: AppHandle,
    state: State<AskpassState>,
    repo: String,
    remote: String,
    branch: String,
) -> Result<(), String> {
    let inner = state.0.clone();
    let op_id = next_op_id();
    thread::spawn(move || {
        let set_upstream = !has_upstream(&repo, &branch);
        let mut cmd = git_command(&repo, &op_id, inner.sock_path(), inner.token());
        cmd.arg("push");
        if set_upstream {
            cmd.arg("--set-upstream");
        }
        cmd.arg(&remote).arg(&branch);
        let (ok, error) = match cmd.output() {
            Ok(o) if o.status.success() => (true, String::new()),
            Ok(o) => (false, String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => (false, e.to_string()),
        };
        let event = if ok { "git://push-done" } else { "git://push-error" };
        let _ = app.emit(event, PushResult { repo, ok, error });
    });
    Ok(())
}

/// Ahead/behind counts of the current branch against its upstream, for the
/// Changes panel header. `has_upstream: false` (branch tracks nothing yet)
/// renders as an "unpushed branch" state rather than 0/0.
#[derive(Serialize)]
pub struct AheadBehind {
    ahead: u32,
    behind: u32,
    has_upstream: bool,
}

#[tauri::command]
pub fn git_ahead_behind(project_path: String) -> Result<AheadBehind, String> {
    // Unborn HEAD or detached: `rev-parse --abbrev-ref HEAD` reports "HEAD"
    // itself rather than erroring, which then simply fails `has_upstream`
    // below - reported as the same "unpushed branch" state.
    let branch = git_capture(&project_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !has_upstream(&project_path, &branch) {
        return Ok(AheadBehind { ahead: 0, behind: 0, has_upstream: false });
    }
    let counts = git_capture(
        &project_path,
        &["rev-list", "--left-right", "--count", &format!("{branch}...{branch}@{{u}}")],
    )?;
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(AheadBehind { ahead, behind, has_upstream: true })
}

/// The PR base branch: `origin/HEAD` when set, else a probe for `origin/main`
/// then `origin/master` (in that order), else None (no origin, or neither
/// conventional branch exists - the UI hides "Open PR" without a base).
#[tauri::command]
pub fn git_default_base_branch(project_path: String) -> Result<Option<String>, String> {
    if let Ok(text) = git_capture(&project_path, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        if let Some(b) = text.strip_prefix("refs/remotes/origin/") {
            return Ok(Some(b.to_string()));
        }
    }
    for candidate in ["main", "master"] {
        let refname = format!("refs/remotes/origin/{candidate}");
        if Command::new("git")
            .arg("-C")
            .arg(&project_path)
            .args(["rev-parse", "--verify", "--quiet", &refname])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

/// Delete a branch on its remote (`git push <remote> --delete <ref>`) through the
/// askpass bridge, so credential prompts pop the in-app dialog. The remote and the
/// remote-side ref are resolved from the *local* branch's tracking config, so a
/// branch pushed under a different name still deletes the right ref; a branch that
/// tracks nothing errors. Synchronous: the caller (the worktree-remove dialog)
/// awaits the result to report success or failure. Emits `config://changed`.
#[tauri::command]
pub fn delete_remote_branch(
    app: AppHandle,
    state: State<AskpassState>,
    repo: String,
    branch: String,
) -> Result<(), String> {
    let (remote, refname) = crate::worktree::resolve_remote_branch(Path::new(&repo), &branch)
        .ok_or("This branch has no remote branch to delete.")?;
    let inner = state.0.clone();
    let op_id = next_op_id();
    let mut cmd = git_command(&repo, &op_id, inner.sock_path(), inner.token());
    cmd.args(["push", &remote, "--delete", &refname]);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// Whether a `credential.helper` is configured for this repo (any scope). With
/// none, git re-prompts every op (nothing is cached), so the UI warns once.
#[tauri::command]
pub fn git_has_credential_helper(repo: String) -> Result<bool, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["config", "--get", "credential.helper"])
        .output()
        .map_err(|e| e.to_string())?;
    let value = String::from_utf8_lossy(&out.stdout);
    Ok(out.status.success() && !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_splits_code_and_path() {
        let out = " M src/App.tsx\n?? new.txt\nA  staged.rs\n";
        let files = parse_status(out);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, " M");
        assert_eq!(files[0].path, "src/App.tsx");
        assert_eq!(files[1].status, "??");
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[2].status, "A ");
        assert_eq!(files[2].path, "staged.rs");
    }

    #[test]
    fn hunks_classify_added_modified_deleted() {
        // -U0 headers: added (old count 0), modified, pure deletion (new count 0).
        let diff = "\
diff --git a/f b/f
--- a/f
+++ b/f
@@ -0,0 +1,3 @@
@@ -10,2 +11,2 @@
@@ -20,3 +20,0 @@
";
        let hunks = parse_hunks(diff);
        assert_eq!(hunks.len(), 3);
        assert_eq!((hunks[0].kind.as_str(), hunks[0].start, hunks[0].count), ("added", 1, 3));
        assert_eq!((hunks[1].kind.as_str(), hunks[1].start, hunks[1].count), ("modified", 11, 2));
        assert_eq!((hunks[2].kind.as_str(), hunks[2].start, hunks[2].count), ("deleted", 20, 0));
    }

    #[test]
    fn range_defaults_count_to_one() {
        assert_eq!(parse_range("42"), (42, 1));
        assert_eq!(parse_range("42,3"), (42, 3));
    }

    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(dir: &Path, args: &[&str]) {
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
        assert!(out.status.success(), "git {:?}", args);
    }

    fn repo_with_two_branches() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_checkout_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        std::fs::write(dir.join("f.txt"), "v1").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        git(&dir, &["branch", "feature"]);
        dir
    }

    /// A local repo (on `main`, one commit) with `origin` set to a bare repo,
    /// nothing pushed yet. Returns (local, remote).
    fn repo_with_remote() -> (PathBuf, PathBuf) {
        let remote = empty_tmp();
        git(&remote, &["init", "--bare", "-q"]);
        let local = repo_with_two_branches();
        git(&local, &["checkout", "-q", "main"]);
        git(&local, &["remote", "add", "origin", &remote.to_string_lossy()]);
        (local, remote)
    }

    #[test]
    fn has_upstream_reflects_push_state() {
        let (local, remote) = repo_with_remote();
        let p = local.to_string_lossy().into_owned();
        assert!(!has_upstream(&p, "main"));
        git(&local, &["push", "-u", "origin", "main"]);
        assert!(has_upstream(&p, "main"));
        std::fs::remove_dir_all(&local).ok();
        std::fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn ahead_behind_tracks_unpushed_then_pushed_commits() {
        let (local, remote) = repo_with_remote();
        let p = local.to_string_lossy().into_owned();

        let before = git_ahead_behind(p.clone()).unwrap();
        assert!(!before.has_upstream);

        git(&local, &["push", "-u", "origin", "main"]);
        let synced = git_ahead_behind(p.clone()).unwrap();
        assert!(synced.has_upstream);
        assert_eq!((synced.ahead, synced.behind), (0, 0));

        std::fs::write(local.join("f.txt"), "v2").unwrap();
        git(&local, &["commit", "-aqm", "more"]);
        let ahead = git_ahead_behind(p).unwrap();
        assert_eq!((ahead.ahead, ahead.behind), (1, 0));

        std::fs::remove_dir_all(&local).ok();
        std::fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn default_base_branch_falls_back_to_probing_origin_main() {
        let (local, remote) = repo_with_remote();
        let p = local.to_string_lossy().into_owned();
        git(&local, &["push", "-u", "origin", "main"]);

        // No origin/HEAD symref set yet - falls back to the origin/main probe.
        assert_eq!(git_default_base_branch(p.clone()).unwrap().as_deref(), Some("main"));

        // An explicit origin/HEAD symref is read directly.
        git(&local, &["remote", "set-head", "origin", "main"]);
        assert_eq!(git_default_base_branch(p).unwrap().as_deref(), Some("main"));

        std::fs::remove_dir_all(&local).ok();
        std::fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn default_base_branch_none_without_origin() {
        let dir = repo_with_two_branches();
        let p = dir.to_string_lossy().into_owned();
        assert_eq!(git_default_base_branch(p).unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn current_branch(dir: &Path) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn status_reports_staged_and_unstaged_flags() {
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("f.txt"), "v2").unwrap(); // unstaged edit
        std::fs::write(dir.join("new.txt"), "x").unwrap(); // untracked
        let p = dir.to_string_lossy().into_owned();
        let files = git_status(p).unwrap();

        let f = files.iter().find(|f| f.path == "f.txt").unwrap();
        assert!(!f.staged && f.unstaged);
        let n = files.iter().find(|f| f.path == "new.txt").unwrap();
        assert!(!n.staged && n.unstaged);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn partially_staged_file_reports_both_flags() {
        // Stage an edit, then edit again on top: git's "MM" - staged AND
        // unstaged at once, the case the Staged/Changes sections must both
        // list this file for.
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("f.txt"), "v2").unwrap();
        let p = dir.to_string_lossy().into_owned();
        git_stage(p.clone(), vec!["f.txt".into()]).unwrap();
        std::fs::write(dir.join("f.txt"), "v3").unwrap();

        let files = git_status(p).unwrap();
        let f = files.iter().find(|f| f.path == "f.txt").unwrap();
        assert!(f.staged && f.unstaged);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_without_identity_surfaces_stderr() {
        // No local `user.name`/`user.email` configured, and this repo's
        // ambient env carries none either (git() only sets it per-invocation
        // via process env, not persisted to config): the commit fails and
        // git's stderr is surfaced rather than a blank error.
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        let p = dir.to_string_lossy().into_owned();
        git_stage(p.clone(), vec!["new.txt".into()]).unwrap();

        let _ = Command::new("git")
            .arg("-C")
            .arg(&p)
            .args(["config", "--local", "--unset-all", "user.name"])
            .output();
        let _ = Command::new("git")
            .arg("-C")
            .arg(&p)
            .args(["config", "--local", "--unset-all", "user.email"])
            .output();

        if has_git_identity(&p) {
            // Ambient global identity is configured on this machine/CI - the
            // no-identity case can't be exercised without touching global
            // config, so skip rather than assert a false failure.
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        let err = git_commit(p, "won't work".into(), None).expect_err("commit without identity must fail");
        assert!(!err.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stage_then_unstage_flips_the_split() {
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        let p = dir.to_string_lossy().into_owned();

        git_stage(p.clone(), vec!["new.txt".into()]).unwrap();
        let staged = git_status(p.clone()).unwrap();
        let f = staged.iter().find(|f| f.path == "new.txt").unwrap();
        assert!(f.staged && !f.unstaged);

        git_unstage(p.clone(), vec!["new.txt".into()]).unwrap();
        let unstaged = git_status(p.clone()).unwrap();
        let f = unstaged.iter().find(|f| f.path == "new.txt").unwrap();
        assert!(!f.staged && f.unstaged);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stage_accepts_a_dash_prefixed_filename() {
        // `--` before paths (D4): a filename starting with '-' must not be
        // parsed as a git flag.
        let dir = repo_with_two_branches();
        std::fs::write(dir.join("-weird.txt"), "x").unwrap();
        let p = dir.to_string_lossy().into_owned();

        git_stage(p.clone(), vec!["-weird.txt".into()]).unwrap();
        let files = git_status(p).unwrap();
        let f = files.iter().find(|f| f.path == "-weird.txt").unwrap();
        assert!(f.staged);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_requires_a_message_and_clears_the_stage() {
        let dir = repo_with_two_branches();
        git(&dir, &["config", "user.name", "t"]);
        git(&dir, &["config", "user.email", "t@t.test"]);
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        let p = dir.to_string_lossy().into_owned();
        git_stage(p.clone(), vec!["new.txt".into()]).unwrap();

        let err = git_commit(p.clone(), "   ".into(), None).expect_err("empty message must be refused");
        assert!(!err.is_empty());

        git_commit(p.clone(), "add new.txt".into(), None).unwrap();
        let files = git_status(p).unwrap();
        assert!(files.iter().all(|f| f.path != "new.txt"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn amend_replaces_head_and_keeps_a_multi_paragraph_body() {
        let dir = repo_with_two_branches();
        git(&dir, &["config", "user.name", "t"]);
        git(&dir, &["config", "user.email", "t@t.test"]);
        let p = dir.to_string_lossy().into_owned();
        let count = |d: &Path| {
            let out = Command::new("git")
                .arg("-C")
                .arg(d)
                .args(["rev-list", "--count", "HEAD"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        std::fs::write(dir.join("new.txt"), "x").unwrap();
        git_stage(p.clone(), vec!["new.txt".into()]).unwrap();
        git_commit(p.clone(), "add new.txt".into(), None).unwrap();
        let before = count(&dir);

        // A subject, a blank line, and a body that itself contains a blank line:
        // the shape `composeCommitMessage` produces and `%B` must give back.
        let msg = "add new.txt\n\nwhy this was needed\n\nand a second paragraph";
        git_commit(p.clone(), msg.into(), Some(true)).unwrap();

        assert_eq!(count(&dir), before, "amend must rewrite HEAD, not add a commit");
        assert_eq!(git_head_message(p).unwrap().trim(), msg);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn head_message_is_empty_on_an_unborn_head() {
        let dir = empty_tmp();
        git(&dir, &["init", "-q"]);
        assert_eq!(git_head_message(dir.to_string_lossy().into_owned()).unwrap(), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkout_switches_branch_on_clean_tree() {
        let dir = repo_with_two_branches();
        assert_eq!(current_branch(&dir), "main");
        git_checkout(dir.to_string_lossy().into_owned(), "feature".into()).unwrap();
        assert_eq!(current_branch(&dir), "feature");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkout_surfaces_error_and_does_not_switch() {
        let dir = repo_with_two_branches();
        let err = git_checkout(dir.to_string_lossy().into_owned(), "nope".into())
            .expect_err("checkout of a missing branch must fail");
        assert!(!err.is_empty(), "stderr should be surfaced");
        // Never half-switch: the tree stays on the original branch.
        assert_eq!(current_branch(&dir), "main");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn empty_tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sway_init_test_{n}_{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_makes_repo_sets_branch_and_scaffolds_gitignore() {
        let dir = empty_tmp();
        do_init(&dir, Some("main")).unwrap();

        // It is now a repo whose unborn HEAD points at the requested branch
        // (rev-parse --abbrev-ref reports "HEAD" before the first commit, so read
        // the symbolic ref directly).
        assert!(dir.join(".git").exists());
        let head = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["symbolic-ref", "--short", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");

        // The scaffolded .gitignore excludes common junk.
        let ignore = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(ignore.contains("node_modules"));

        // Re-initializing is refused (already a repo).
        assert!(do_init(&dir, None).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn init_preserves_an_existing_gitignore() {
        let dir = empty_tmp();
        std::fs::write(dir.join(".gitignore"), "custom-only\n").unwrap();
        do_init(&dir, None).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".gitignore")).unwrap(), "custom-only\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scaffolded_gitignore_keeps_junk_out_of_the_commit() {
        let dir = empty_tmp();
        do_init(&dir, Some("main")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules/pkg.js"), "x").unwrap();
        std::fs::write(dir.join("real.txt"), "code").unwrap();
        git(&dir, &["add", "-A"]);

        // Only the real file is staged; node_modules is ignored.
        let out = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["diff", "--cached", "--name-only"])
            .output()
            .unwrap();
        let staged = String::from_utf8_lossy(&out.stdout);
        assert!(staged.contains("real.txt"));
        assert!(!staged.contains("node_modules"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bare_init_makes_worktree_container_in_place() {
        let dir = empty_tmp();
        // A pre-existing file must survive the in-place bootstrap.
        std::fs::write(dir.join("README.txt"), "hi").unwrap();
        do_bare_init(&dir, Some("main")).unwrap();

        // The layout: a `.bare` repo, a `.git` pointer, and a `main` worktree.
        assert!(dir.join(".bare").is_dir());
        assert_eq!(std::fs::read_to_string(dir.join(".git")).unwrap(), "gitdir: ./.bare\n");
        assert!(dir.join("main").is_dir());
        assert_eq!(std::fs::read_to_string(dir.join("README.txt")).unwrap(), "hi");

        // Discovery sees a bare container with exactly one (non-bare) worktree on an
        // unborn `main`, and no remote yet (add origin later).
        let list = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&list.stdout);
        assert!(text.contains("bare"));
        assert!(text.contains("branch refs/heads/main"));
        let head = Command::new("git")
            .arg("-C")
            .arg(dir.join("main"))
            .args(["symbolic-ref", "--short", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");

        // Re-running is refused (already a git repo).
        assert!(do_bare_init(&dir, None).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bare_init_defaults_branch_when_blank() {
        let dir = empty_tmp();
        do_bare_init(&dir, None).unwrap();
        // Whatever git's default is, the worktree folder is named after it and the
        // pointer + bare repo exist.
        assert!(dir.join(".bare").is_dir());
        let def = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["symbolic-ref", "--short", "HEAD"])
            .output()
            .unwrap();
        let def = String::from_utf8_lossy(&def.stdout).trim().to_string();
        assert!(!def.is_empty());
        assert!(dir.join(&def).is_dir());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn git_command_sets_askpass_bridge_env() {
        use std::ffi::OsStr;
        let sock = Path::new("/tmp/sway-akp-x/s");
        let cmd = git_command("/repo", "op-1", sock, "tok");
        let envs: std::collections::HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|s| s.to_string_lossy().into_owned()),
                )
            })
            .collect();
        // Fail-closed + locale-stable + bridge coordinates all present.
        assert_eq!(envs.get("GIT_TERMINAL_PROMPT").unwrap().as_deref(), Some("0"));
        assert_eq!(envs.get("LC_ALL").unwrap().as_deref(), Some("C"));
        assert_eq!(envs.get("SSH_ASKPASS_REQUIRE").unwrap().as_deref(), Some("force"));
        assert_eq!(envs.get(ENV_SOCK).unwrap().as_deref(), Some("/tmp/sway-akp-x/s"));
        assert_eq!(envs.get(ENV_TOKEN).unwrap().as_deref(), Some("tok"));
        assert_eq!(envs.get(ENV_OP).unwrap().as_deref(), Some("op-1"));
        assert!(envs.contains_key("GIT_ASKPASS"));
        assert!(envs.contains_key("SSH_ASKPASS"));
        assert!(envs
            .get("GIT_SSH_COMMAND")
            .unwrap()
            .as_deref()
            .unwrap()
            .contains("accept-new"));
        // current_exe resolved to something non-empty for GIT_ASKPASS.
        let exe = envs.get("GIT_ASKPASS").unwrap().as_deref().unwrap();
        assert!(!exe.is_empty());
        let _ = OsStr::new(exe);
    }

    #[test]
    fn origin_reports_url_only_when_set() {
        let dir = empty_tmp();
        do_init(&dir, Some("main")).unwrap();
        let p = dir.to_string_lossy().into_owned();
        assert_eq!(git_origin(p.clone()).unwrap(), None);
        git(&dir, &["remote", "add", "origin", "https://example.com/x.git"]);
        assert_eq!(git_origin(p).unwrap().as_deref(), Some("https://example.com/x.git"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- hunk-level staging (git_apply_hunks) ----------------------------
    //
    // These drive real `git apply --cached`. The patch offset maths and the
    // apply direction are the two things that corrupt an index silently rather
    // than failing, so they are checked against git itself, not just asserted
    // about in isolation (patch.rs covers the pure rebuild).

    /// A repo whose committed f.txt has 20 numbered lines, with line 2 and
    /// line 19 edited in the worktree: far enough apart to stay two hunks at
    /// -U3, so "stage one of two" is meaningful.
    fn repo_with_two_hunks() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_hunk_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let base: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
        std::fs::write(dir.join("f.txt"), base.join("\n") + "\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        let mut edited = base.clone();
        edited[1] = "line 2 EDITED".into();
        edited[18] = "line 19 EDITED".into();
        std::fs::write(dir.join("f.txt"), edited.join("\n") + "\n").unwrap();
        dir
    }

    fn status_of(dir: &Path, file: &str) -> String {
        let out = Command::new("git")
            .arg("-C").arg(dir)
            .args(["status", "--porcelain", "--", file])
            .output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    /// The file's content as currently staged in the index.
    fn indexed(dir: &Path, file: &str) -> String {
        let out = Command::new("git")
            .arg("-C").arg(dir)
            .args(["show", &format!(":{file}")])
            .output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn hunks_of(p: &str, file: &str, mode: DiffMode) -> crate::patch::FilePatch {
        let text = git_diff_text(p.into(), file.into(), Some(3), Some(mode)).unwrap();
        crate::patch::parse_patch(&text)
    }

    #[test]
    fn stages_one_hunk_of_two_leaving_the_file_partially_staged() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 2, "expected two separate hunks at -U3");

        // Stage only the second hunk (line 19).
        git_apply_hunks(p.clone(), "f.txt".into(), vec![1], vec![parsed.hunks[1].fingerprint.clone()], false, Some(3)).unwrap();

        assert_eq!(status_of(&dir, "f.txt"), "MM f.txt");
        let staged = indexed(&dir, "f.txt");
        assert!(staged.contains("line 19 EDITED"), "the selected hunk should be staged");
        assert!(!staged.contains("line 2 EDITED"), "the unselected hunk must not be staged");
        // The working tree keeps both edits: --cached never touches it.
        let worktree = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(worktree.contains("line 2 EDITED") && worktree.contains("line 19 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stages_the_first_hunk_at_the_right_offset() {
        // The first hunk is the one whose *new*-side offset shifts when the
        // second is dropped, so a naive rebuild misplaces it.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks(p.clone(), "f.txt".into(), vec![0], vec![parsed.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        let staged = indexed(&dir, "f.txt");
        assert!(staged.contains("line 2 EDITED"));
        assert!(!staged.contains("line 19 EDITED"));
        // Nothing else moved: still 20 lines, line 19 still original.
        assert_eq!(staged.lines().count(), 20);
        assert!(staged.lines().nth(18).unwrap().contains("line 19"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn walks_the_file_from_unstaged_to_fully_staged_one_hunk_at_a_time() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();

        let first = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks(p.clone(), "f.txt".into(), vec![0], vec![first.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();
        assert_eq!(status_of(&dir, "f.txt"), "MM f.txt");

        // Re-read: staging renumbered the remaining unstaged hunks.
        let rest = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        assert_eq!(rest.hunks.len(), 1);
        git_apply_hunks(p.clone(), "f.txt".into(), vec![0], vec![rest.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        assert_eq!(status_of(&dir, "f.txt"), "M  f.txt", "fully staged, nothing left unstaged");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unstaging_a_hunk_reverses_exactly_that_hunk() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["add", "f.txt"]);
        assert_eq!(status_of(&dir, "f.txt"), "M  f.txt");

        // Now unstage only the line-19 hunk, from the index-vs-HEAD diff.
        let staged_hunks = hunks_of(&p, "f.txt", DiffMode::Staged);
        assert_eq!(staged_hunks.hunks.len(), 2);
        git_apply_hunks(p.clone(), "f.txt".into(), vec![1], vec![staged_hunks.hunks[1].fingerprint.clone()], true, Some(3)).unwrap();

        let staged = indexed(&dir, "f.txt");
        assert!(staged.contains("line 2 EDITED"), "the untouched hunk stays staged");
        assert!(!staged.contains("line 19 EDITED"), "the reversed hunk left the index");
        assert_eq!(staged.lines().count(), 20);
        // The worktree still has both edits.
        let worktree = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(worktree.contains("line 19 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_two_sections_of_a_partially_staged_file_do_not_cross_contaminate() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let unstaged = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks(p.clone(), "f.txt".into(), vec![0], vec![unstaged.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        // "MM": one hunk in each section, and each section sees only its own.
        let staged = hunks_of(&p, "f.txt", DiffMode::Staged);
        let remaining = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        assert_eq!(staged.hunks.len(), 1);
        assert_eq!(remaining.hunks.len(), 1);
        assert!(staged.hunks[0].body.iter().any(|l| l.contains("line 2 EDITED")));
        assert!(remaining.hunks[0].body.iter().any(|l| l.contains("line 19 EDITED")));
        // Different content, so different fingerprints: an index reused across
        // the two sections could never silently match.
        assert_ne!(staged.hunks[0].fingerprint, remaining.hunks[0].fingerprint);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stale_fingerprint_refuses_and_stages_nothing() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let err = git_apply_hunks(
            p.clone(), "f.txt".into(), vec![1], vec!["deadbeef".into()], false, Some(3),
        ).unwrap_err();
        assert!(err.contains("diff changed"), "got: {err}");
        assert_eq!(status_of(&dir, "f.txt"), " M f.txt", "nothing may be staged");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_out_of_range_index_refuses_rather_than_panicking() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let err = git_apply_hunks(
            p.clone(), "f.txt".into(), vec![9], vec!["deadbeef".into()], false, Some(3),
        ).unwrap_err();
        assert!(err.contains("diff changed"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_selection_refuses() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        // Indices and fingerprints must correspond one-to-one.
        assert!(git_apply_hunks(p, "f.txt".into(), vec![0, 1], vec!["x".into()], false, Some(3)).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stages_one_hunk_of_an_untracked_file_via_intent_to_add() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let lines: Vec<String> = (1..=20).map(|i| format!("new {i}")).collect();
        std::fs::write(dir.join("n.txt"), lines.join("\n") + "\n").unwrap();
        assert_eq!(status_of(&dir, "n.txt"), "?? n.txt");

        // An untracked file is one all-additions hunk; staging it is the whole
        // file, but it must go through intent-to-add rather than failing.
        let parsed = hunks_of(&p, "n.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 1);
        git_apply_hunks(p.clone(), "n.txt".into(), vec![0], vec![parsed.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        assert!(indexed(&dir, "n.txt").contains("new 20"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_untracked_fallback_and_intent_to_add_agree_on_the_fingerprint() {
        // The panel renders an untracked file from the --no-index fallback, but
        // staging re-diffs it after `git add -N`. The preambles differ; the
        // hunk header and body must not, or every untracked stage would be
        // refused as stale.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("n.txt"), "alpha\nbeta\n").unwrap();

        let displayed = hunks_of(&p, "n.txt", DiffMode::Unstaged);
        git(&dir, &["add", "-N", "--", "n.txt"]);
        let after_add_n = hunks_of(&p, "n.txt", DiffMode::Unstaged);
        assert_eq!(displayed.hunks[0].fingerprint, after_add_n.hunks[0].fingerprint);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn diff_modes_describe_different_trees_for_a_partially_staged_file() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks(p.clone(), "f.txt".into(), vec![0], vec![parsed.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        let head = git_diff_text(p.clone(), "f.txt".into(), Some(3), Some(DiffMode::Head)).unwrap();
        let staged = git_diff_text(p.clone(), "f.txt".into(), Some(3), Some(DiffMode::Staged)).unwrap();
        let unstaged = git_diff_text(p.clone(), "f.txt".into(), Some(3), Some(DiffMode::Unstaged)).unwrap();

        // vs HEAD sees both edits; each of the other two sees exactly one.
        assert!(head.contains("line 2 EDITED") && head.contains("line 19 EDITED"));
        assert!(staged.contains("line 2 EDITED") && !staged.contains("line 19 EDITED"));
        assert!(unstaged.contains("line 19 EDITED") && !unstaged.contains("line 2 EDITED"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn omitting_the_mode_keeps_the_vs_head_behaviour_existing_callers_rely_on() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["add", "f.txt"]);
        // Staged, so worktree-vs-index is empty but vs-HEAD is not. The gutter
        // and the session diff both depend on still seeing the change here.
        let default = git_diff_text(p.clone(), "f.txt".into(), None, None).unwrap();
        assert!(default.contains("line 2 EDITED"), "default mode must stay vs HEAD");
        assert!(!git_diff_file(p, "f.txt".into(), None).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_slice_returns_the_requested_1_based_inclusive_range() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let lines = git_file_slice(p, "f.txt".into(), Some(DiffMode::Unstaged), 5, 7).unwrap();
        assert_eq!(lines, vec!["line 5", "line 6", "line 7"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_slice_reads_the_index_in_staged_mode_not_the_worktree() {
        // The distinction that matters for a partially-staged file: the Staged
        // section's unchanged lines are the index's, and showing the worktree's
        // there would display lines the user has not staged.
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "f.txt", DiffMode::Unstaged);
        git_apply_hunks(p.clone(), "f.txt".into(), vec![0], vec![parsed.hunks[0].fingerprint.clone()], false, Some(3)).unwrap();

        // Line 19 is edited in the worktree but not in the index.
        let staged = git_file_slice(p.clone(), "f.txt".into(), Some(DiffMode::Staged), 19, 19).unwrap();
        let worktree = git_file_slice(p, "f.txt".into(), Some(DiffMode::Unstaged), 19, 19).unwrap();
        assert_eq!(staged, vec!["line 19"]);
        assert_eq!(worktree, vec!["line 19 EDITED"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_slice_clamps_a_range_past_the_end_of_the_file() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        let lines = git_file_slice(p, "f.txt".into(), Some(DiffMode::Unstaged), 18, 900).unwrap();
        assert_eq!(lines.len(), 3, "20-line file, so 18..20");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_slice_rejects_a_degenerate_range_rather_than_panicking() {
        let dir = repo_with_two_hunks();
        let p = dir.to_string_lossy().into_owned();
        assert!(git_file_slice(p.clone(), "f.txt".into(), None, 0, 5).unwrap().is_empty());
        assert!(git_file_slice(p, "f.txt".into(), None, 9, 3).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A repo whose committed g.txt has 60 lines, with lines 10, 30 and 50
    /// edited: three hunks at default context, far enough apart that skipping
    /// the middle one exercises the offset accumulation.
    fn repo_with_three_hunks() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_hunk3_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let base: Vec<String> = (1..=60).map(|i| format!("line {i}")).collect();
        std::fs::write(dir.join("g.txt"), base.join("\n") + "\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        let mut edited = base.clone();
        for i in [9usize, 29, 49] {
            edited[i] = format!("line {} EDITED", i + 1);
        }
        std::fs::write(dir.join("g.txt"), edited.join("\n") + "\n").unwrap();
        dir
    }

    #[test]
    fn stages_two_hunks_skipping_the_one_between_them() {
        // The case the offset accumulation exists for: hunk 1 is dropped, so
        // hunk 2's new-side start must shift by hunk 0's drift alone. Get this
        // wrong and git applies the right lines in the wrong place.
        let dir = repo_with_three_hunks();
        let p = dir.to_string_lossy().into_owned();
        let parsed = hunks_of(&p, "g.txt", DiffMode::Unstaged);
        assert_eq!(parsed.hunks.len(), 3);

        git_apply_hunks(
            p.clone(), "g.txt".into(), vec![0, 2],
            vec![parsed.hunks[0].fingerprint.clone(), parsed.hunks[2].fingerprint.clone()],
            false, Some(3),
        ).unwrap();

        let staged = indexed(&dir, "g.txt");
        assert_eq!(staged.lines().count(), 60, "no lines gained or lost");
        assert_eq!(staged.lines().nth(9).unwrap(), "line 10 EDITED");
        assert_eq!(staged.lines().nth(29).unwrap(), "line 30", "the skipped hunk stays unstaged");
        assert_eq!(staged.lines().nth(49).unwrap(), "line 50 EDITED");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unstages_two_hunks_skipping_the_one_between_them() {
        // Same, in reverse: the new side is the source here, so the *old* side
        // is what accumulates drift.
        let dir = repo_with_three_hunks();
        let p = dir.to_string_lossy().into_owned();
        git(&dir, &["add", "g.txt"]);

        let parsed = hunks_of(&p, "g.txt", DiffMode::Staged);
        assert_eq!(parsed.hunks.len(), 3);
        git_apply_hunks(
            p.clone(), "g.txt".into(), vec![0, 2],
            vec![parsed.hunks[0].fingerprint.clone(), parsed.hunks[2].fingerprint.clone()],
            true, Some(3),
        ).unwrap();

        let staged = indexed(&dir, "g.txt");
        assert_eq!(staged.lines().count(), 60);
        assert_eq!(staged.lines().nth(9).unwrap(), "line 10", "reversed out of the index");
        assert_eq!(staged.lines().nth(29).unwrap(), "line 30 EDITED", "the skipped hunk stays staged");
        assert_eq!(staged.lines().nth(49).unwrap(), "line 50");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staging_hunks_that_change_the_line_count_keeps_later_hunks_aligned() {
        // Insertions and deletions of different sizes, so the running delta is
        // non-zero and unequal between hunks.
        let dir = repo_with_three_hunks();
        let p = dir.to_string_lossy().into_owned();
        let mut lines: Vec<String> = (1..=60).map(|i| format!("line {i}")).collect();
        // Hunk A: insert two lines after line 10. Hunk B (later): delete line 50.
        lines.remove(49);
        lines.splice(10..10, ["inserted a".to_string(), "inserted b".to_string()]);
        std::fs::write(dir.join("g.txt"), lines.join("\n") + "\n").unwrap();

        let parsed = hunks_of(&p, "g.txt", DiffMode::Unstaged);
        let all: Vec<usize> = (0..parsed.hunks.len()).collect();
        let fps: Vec<String> = parsed.hunks.iter().map(|h| h.fingerprint.clone()).collect();
        git_apply_hunks(p.clone(), "g.txt".into(), all, fps, false, Some(3)).unwrap();

        // Staging every hunk must reproduce the worktree exactly.
        assert_eq!(indexed(&dir, "g.txt"), std::fs::read_to_string(dir.join("g.txt")).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }
}
