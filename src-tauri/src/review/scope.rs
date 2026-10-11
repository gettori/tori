//! The folders a task named, from the session's first prompt and the issue its
//! branch was started from, and the changed files that fall outside them.
//!
//! A word counts as a path only when it looks like one (a `/`, or a name with
//! an extension) and its first part exists in the repo, so prose like
//! "and/or" names nothing. Naming nothing keeps the signal silent.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use crate::checkpoint::CheckpointFile;

const TRIM: &[char] = &[
    '.', ',', ':', ';', '!', '?', '`', '"', '\'', '(', ')', '[', ']', '<', '>', '{', '}', '*',
];

fn line_suffix(token: &str) -> &str {
    let mut out = token;
    for _ in 0..2 {
        match out.rsplit_once(':') {
            Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) => out = head,
            _ => break,
        }
    }
    out
}

fn named_path(word: &str, repo: &Path) -> Option<String> {
    let word = line_suffix(word.trim_matches(TRIM));
    if word.is_empty() || word.contains("://") || word.starts_with(['#', '@', '-', '~', '$']) {
        return None;
    }
    let word = match word.strip_prefix('/') {
        Some(_) => Path::new(word).strip_prefix(repo).ok()?.to_str()?,
        None => word.strip_prefix("./").unwrap_or(word),
    };
    let folder_like = word.ends_with('/');
    let word = word.trim_end_matches('/');
    let last = word.rsplit('/').next()?;
    let has_extension = last
        .rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && !ext.is_empty());
    if !word.contains('/') && !has_extension && !folder_like {
        return None;
    }
    let first = word.split('/').next()?;
    if first.is_empty() || first == ".." || !repo.join(first).exists() {
        return None;
    }
    let folder = match word.rsplit_once('/') {
        Some((parent, _)) if has_extension && !repo.join(word).is_dir() => parent,
        _ => word,
    };
    Some(folder.to_string())
}

pub(super) fn named_paths(text: &str, repo: &Path) -> Vec<String> {
    let mut out: Vec<String> = text.split_whitespace().filter_map(|w| named_path(w, repo)).collect();
    out.sort();
    out.dedup();
    out
}

pub(super) fn outside(files: &[CheckpointFile], named: &[String]) -> u32 {
    if named.is_empty() {
        return 0;
    }
    let inside = |path: &str| {
        named
            .iter()
            .any(|n| path == n || path.strip_prefix(n.as_str()).is_some_and(|rest| rest.starts_with('/')))
    };
    files.iter().filter(|f| !inside(&f.path)).count() as u32
}

// Per session: the first prompt and the branch's issue do not change, and the
// issue is a forge call, so each session is read once.
#[derive(Default)]
pub(super) struct ScopeCache {
    by_session: HashMap<String, Vec<String>>,
}

impl ScopeCache {
    pub(super) fn named(
        &mut self,
        session: &str,
        repo: &Path,
        in_repo: &str,
        first_prompt: impl FnOnce() -> Option<String>,
        issue_body: impl FnOnce() -> Option<String>,
    ) -> Vec<String> {
        if let Some(named) = self.by_session.get(session) {
            return named.clone();
        }
        let text = [first_prompt(), issue_body()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        // Changed files are named from the repo root, the prompt from the folder.
        let named: Vec<String> = named_paths(&text, repo)
            .into_iter()
            .map(|p| format!("{in_repo}{p}"))
            .collect();
        self.by_session.insert(session.to_string(), named.clone());
        named
    }
}

pub(super) static SCOPES: std::sync::LazyLock<Mutex<ScopeCache>> = std::sync::LazyLock::new(Mutex::default);

pub(super) fn linked_issue_body(project: &str, branch: &str) -> Option<String> {
    let store = crate::issues::store::IssueStore::load();
    let key = store.for_repo(project)?.get(branch)?.key.clone();
    crate::issues::commands::get(project, &key).ok().map(|issue| issue.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::PathBuf;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori_review_scope_{}", std::process::id()));
        for d in ["src/review", "src/panels", "docs"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        std::fs::write(dir.join("README.md"), "x").unwrap();
        dir
    }

    fn changed(paths: &[&str]) -> Vec<CheckpointFile> {
        paths
            .iter()
            .map(|p| CheckpointFile {
                path: p.to_string(),
                status: "modified".into(),
                added: 4,
                removed: 1,
                shared_with: Vec::new(),
                unattributed: false,
            })
            .collect()
    }

    #[test]
    fn paths_named_in_prose_become_folders_and_prose_names_nothing() {
        let dir = repo();
        let text = "Fix the scoring in `src/review/mod.rs:120` and update README.md, \
                    see https://github.com/x/y and/or the docs/ folder. Not lib/missing.rs.";
        assert_eq!(named_paths(text, &dir), vec!["README.md", "docs", "src/review"]);
    }

    #[test]
    fn files_outside_the_named_folders_fire_and_inside_ones_do_not() {
        let named = vec!["src/review".to_string(), "README.md".to_string()];
        let inside = changed(&["src/review/paths.rs", "README.md"]);
        assert_eq!(outside(&inside, &named), 0);
        let mixed = changed(&["src/review/paths.rs", "src/review-old/x.rs", "src/panels/App.tsx"]);
        assert_eq!(outside(&mixed, &named), 2, "a sibling with the same prefix is outside");
    }

    #[test]
    fn naming_nothing_keeps_the_signal_silent() {
        let dir = repo();
        let named = named_paths("Make the inbox faster, it lags on big repos.", &dir);
        assert!(named.is_empty());
        assert_eq!(outside(&changed(&["src/panels/App.tsx"]), &named), 0);
    }

    #[test]
    fn a_session_reads_its_issue_once() {
        let dir = repo();
        let mut cache = ScopeCache::default();
        let calls = Cell::new(0);
        let fetch = || {
            calls.set(calls.get() + 1);
            Some("Touch only src/panels/Inbox.tsx".to_string())
        };
        let first = cache.named("s1", &dir, "", || None, fetch);
        let again = cache.named("s1", &dir, "", || None, fetch);
        assert_eq!(first, vec!["src/panels"]);
        assert_eq!(again, first);
        assert_eq!(calls.get(), 1, "the second refresh makes no forge request");
    }
}
