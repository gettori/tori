// Project-wide text search for the right panel's Search mode. Prefers `rg
// --json` when installed (fast, respects .gitignore natively); falls back to
// `git grep -n --untracked` inside a git repo (still respects .gitignore, plus
// untracked-but-not-ignored files); falls back further to a plain recursive
// `grep -rn` with the same churn-dir excludes as `fs::list_project_files` for
// a non-git folder without `rg`.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "dist", "target"];

#[derive(Clone, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

fn has_rg() -> bool {
    Command::new("rg")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn is_git_repo(root: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Parse one ripgrep `--json` stream, collecting `match` messages up to `max`.
/// Returns `truncated = true` once the cap is hit even if more matches exist.
fn parse_rg_json(stdout: &[u8], root: &str, max: usize) -> SearchResult {
    let mut matches = Vec::new();
    let mut truncated = false;
    for line in String::from_utf8_lossy(stdout).lines() {
        if matches.len() >= max {
            truncated = true;
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }
        let data = &v["data"];
        let Some(abs_path) = data["path"]["text"].as_str() else {
            continue;
        };
        let rel = Path::new(abs_path)
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| abs_path.to_string());
        let line_no = data["line_number"].as_u64().unwrap_or(0) as u32;
        let text = data["lines"]["text"].as_str().unwrap_or("").trim_end().to_string();
        matches.push(SearchMatch { path: rel, line: line_no, text });
    }
    SearchResult { matches, truncated }
}

/// Parse `grep -n`/`git grep -n` output (`path:line:text`, path already
/// relative when run with `-C root`). Caps at `max`, splitting only on the
/// first two `:` so match text containing `:` is preserved.
fn parse_grep_lines(stdout: &[u8], max: usize) -> SearchResult {
    let mut matches = Vec::new();
    let mut truncated = false;
    for line in String::from_utf8_lossy(stdout).lines() {
        if matches.len() >= max {
            truncated = true;
            break;
        }
        let mut parts = line.splitn(3, ':');
        let (Some(path), Some(line_no), Some(text)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(line_no) = line_no.parse::<u32>() else {
            continue;
        };
        matches.push(SearchMatch {
            path: path.to_string(),
            line: line_no,
            text: text.to_string(),
        });
    }
    SearchResult { matches, truncated }
}

/// Plain recursive `grep -rn`, excluding the same churn dirs the file tree
/// walk skips. Used only when neither `rg` nor a git repo is available.
fn plain_grep(root: &str, query: &str, case_sensitive: bool) -> Result<SearchResult, String> {
    let mut cmd = Command::new("grep");
    cmd.arg("-rn");
    if !case_sensitive {
        cmd.arg("-i");
    }
    for dir in IGNORED_DIRS {
        cmd.arg(format!("--exclude-dir={dir}"));
    }
    cmd.arg("-e").arg(query).arg(".");
    cmd.current_dir(root);
    let out = cmd.output().map_err(|e| e.to_string())?;
    // grep exits 1 for "no matches", which is not an error here.
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let mut result = parse_grep_lines(&out.stdout, usize::MAX);
    // Searching "." leaves a "./" prefix on every path; strip it so results
    // match the relative-path shape rg/git-grep already produce.
    for m in &mut result.matches {
        if let Some(stripped) = m.path.strip_prefix("./") {
            m.path = stripped.to_string();
        }
    }
    Ok(result)
}

/// Search `root` for `query`, capping results at `max` matches. `case`
/// controls case sensitivity. Strategy: `rg --json` when installed, else
/// `git grep -n --untracked --exclude-standard` in a repo, else a plain
/// `grep -rn` walk with churn-dir excludes.
#[tauri::command]
pub fn grep_project(
    root: String,
    query: String,
    case: bool,
    max: usize,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult { matches: Vec::new(), truncated: false });
    }

    if has_rg() {
        let mut cmd = Command::new("rg");
        cmd.args(["--json", "--line-number"]);
        if !case {
            cmd.arg("--ignore-case");
        }
        cmd.arg("--max-count").arg(max.to_string());
        cmd.arg("-e").arg(&query).arg(&root);
        let out = cmd.output().map_err(|e| e.to_string())?;
        // rg exits 1 for "no matches", which is not an error here.
        if out.status.success() || out.status.code() == Some(1) {
            return Ok(parse_rg_json(&out.stdout, &root, max));
        }
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }

    if is_git_repo(&root) {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&root);
        cmd.args(["grep", "-n", "--untracked", "--exclude-standard"]);
        if !case {
            cmd.arg("-i");
        }
        cmd.arg("-e").arg(&query);
        let out = cmd.output().map_err(|e| e.to_string())?;
        // git grep exits 1 for "no matches", which is not an error here.
        if out.status.success() || out.status.code() == Some(1) {
            return Ok(parse_grep_lines(&out.stdout, max));
        }
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }

    let mut result = plain_grep(&root, &query, case)?;
    if result.matches.len() > max {
        result.matches.truncate(max);
        result.truncated = true;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@test.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@test.com")
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sway_search_test_{name}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        dir
    }

    #[test]
    fn parse_rg_json_extracts_matches_and_relativizes_path() {
        let root = "/proj";
        let stdout = format!(
            "{}\n{}\n",
            r#"{"type":"begin","data":{"path":{"text":"/proj/src/a.ts"}}}"#,
            r#"{"type":"match","data":{"path":{"text":"/proj/src/a.ts"},"lines":{"text":"needle here\n"},"line_number":42}}"#,
        );
        let result = parse_rg_json(stdout.as_bytes(), root, 10);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "src/a.ts");
        assert_eq!(result.matches[0].line, 42);
        assert_eq!(result.matches[0].text, "needle here");
        assert!(!result.truncated);
    }

    #[test]
    fn parse_rg_json_truncates_at_max() {
        let mut stdout = String::new();
        for i in 0..5 {
            stdout.push_str(&format!(
                r#"{{"type":"match","data":{{"path":{{"text":"/p/f.ts"}},"lines":{{"text":"x"}},"line_number":{i}}}}}"#
            ));
            stdout.push('\n');
        }
        let result = parse_rg_json(stdout.as_bytes(), "/p", 3);
        assert_eq!(result.matches.len(), 3);
        assert!(result.truncated);
    }

    #[test]
    fn parse_grep_lines_preserves_colons_in_match_text() {
        let stdout = b"src/a.ts:10:const x: number = 1;\n";
        let result = parse_grep_lines(stdout, 10);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "src/a.ts");
        assert_eq!(result.matches[0].line, 10);
        assert_eq!(result.matches[0].text, "const x: number = 1;");
    }

    #[test]
    fn git_grep_fallback_finds_untracked_file() {
        let dir = temp_repo("untracked");
        std::fs::write(dir.join("tracked.txt"), "needle in tracked\n").unwrap();
        git(&dir, &["add", "tracked.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("scratch.txt"), "needle in untracked\n").unwrap();

        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&dir);
        cmd.args(["grep", "-n", "--untracked", "--exclude-standard", "-e", "needle"]);
        let out = cmd.output().unwrap();
        let result = parse_grep_lines(&out.stdout, 100);
        let paths: Vec<_> = result.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"tracked.txt"));
        assert!(paths.contains(&"scratch.txt"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn git_grep_excludes_gitignored_files() {
        let dir = temp_repo("ignored");
        std::fs::write(dir.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.join("ignored.txt"), "needle in ignored\n").unwrap();
        std::fs::write(dir.join("kept.txt"), "needle in kept\n").unwrap();
        git(&dir, &["add", ".gitignore", "kept.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&dir);
        cmd.args(["grep", "-n", "--untracked", "--exclude-standard", "-e", "needle"]);
        let out = cmd.output().unwrap();
        let result = parse_grep_lines(&out.stdout, 100);
        let paths: Vec<_> = result.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"kept.txt"));
        assert!(!paths.contains(&"ignored.txt"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn plain_grep_caps_at_max_and_excludes_churn_dirs() {
        let dir = std::env::temp_dir().join(format!(
            "sway_search_plain_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules/dep.txt"), "needle in dep\n").unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.txt")), "needle here\n").unwrap();
        }
        let root = dir.to_string_lossy().into_owned();

        let mut result = plain_grep(&root, "needle", true).unwrap();
        assert_eq!(result.matches.len(), 5);
        assert!(!result.matches.iter().any(|m| m.path.contains("node_modules")));
        assert!(!result.matches.iter().any(|m| m.path.starts_with("./")));

        if result.matches.len() > 2 {
            result.matches.truncate(2);
            result.truncated = true;
        }
        assert_eq!(result.matches.len(), 2);
        assert!(result.truncated);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
