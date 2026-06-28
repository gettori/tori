// Git queries for the editor: the changed-file list (for a review surface) and
// per-file diff hunks in new-file coordinates (for the CM6 gutter). Both shell
// out to git, like `list_branches` in config.rs. Diffs are taken against HEAD so
// the gutter reflects all uncommitted work (staged + unstaged), matching the
// "uncommitted changes" review surface, not just unstaged edits.

use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
pub struct GitFileStatus {
    /// Porcelain XY status code, e.g. " M", "??", "A ", "MM".
    status: String,
    path: String,
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
        files.push(GitFileStatus {
            status: line[..2].to_string(),
            path: line[3..].to_string(),
        });
    }
    files
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
pub fn git_diff_file(project_path: String, file: String) -> Result<Vec<DiffHunk>, String> {
    // -U0: hunk headers carry exact ranges, no surrounding context to walk.
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "HEAD", "--no-color", "-U0", "--", &file])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // No HEAD yet, untracked file, or not a repo: no hunks.
        return Ok(vec![]);
    }

    Ok(parse_hunks(&String::from_utf8_lossy(&output.stdout)))
}

/// Raw unified diff text vs HEAD for a single file, for the inline review view.
/// Untracked files have no diff vs HEAD, so fall back to showing the whole file
/// as additions (`git diff --no-index /dev/null <file>`).
#[tauri::command]
pub fn git_diff_text(project_path: String, file: String) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "HEAD", "--no-color", "--", &file])
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() && !text.trim().is_empty() {
        return Ok(text);
    }

    // Untracked (or no HEAD): diff against an empty tree so new files still show.
    let untracked = Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "--no-color", "--no-index", "--", "/dev/null", &file])
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
}
