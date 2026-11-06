//! Kept in `~/.config/tori/issue_repos.json` beside `unit_issues.json`, for
//! the same reason: writing the watched `tori.toml` would loop the config
//! watcher.

use super::IssueQuery;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct RepoStore(HashMap<String, Vec<String>>);

fn norm(path: &str) -> String {
    path.trim_end_matches('/').to_string()
}

fn store_path() -> PathBuf {
    crate::owned_state::config_dir().join("issue_repos.json")
}

impl RepoStore {
    fn read(path: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} does not parse: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.to_string()),
        }
    }

    // A reader degrades to no lists; only a write must not drop the others.
    fn load_from(path: &Path) -> Self {
        Self::read(path).unwrap_or_default()
    }

    fn save_to(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::owned_state::write_atomically(path, &json)
    }
}

fn checked(repo: &str) -> Result<String, String> {
    let repo = repo.trim().to_lowercase();
    IssueQuery {
        repo: repo.clone(),
        ..IssueQuery::default()
    }
    .check()
    .map(|()| repo)
}

pub fn normalize(repos: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for repo in repos {
        let repo = checked(repo)?;
        if !out.contains(&repo) {
            out.push(repo);
        }
    }
    Ok(out)
}

pub fn unlisted<'a>(sources: &'a [IssueQuery], listed: &[String]) -> Option<&'a str> {
    sources
        .iter()
        .map(|q| q.repo.trim())
        .find(|repo| !listed.iter().any(|l| l.eq_ignore_ascii_case(repo)))
}

pub fn stored(project: &str) -> Vec<String> {
    RepoStore::load_from(&store_path())
        .0
        .get(&norm(project))
        .cloned()
        .unwrap_or_default()
}

pub fn save(project: &str, repos: &[String]) -> Result<Vec<String>, String> {
    save_in(&store_path(), project, repos)
}

fn save_in(file: &Path, project: &str, repos: &[String]) -> Result<Vec<String>, String> {
    let repos = normalize(repos)?;
    let lock = crate::exec::named_lock("issue_repos");
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = RepoStore::read(file)?;
    store.0.insert(norm(project), repos.clone());
    store.save_to(file)?;
    Ok(repos)
}

// Before the list existed, a project with autopilot sources read the origin
// and those sources, so it starts with exactly that.
fn seed_if_unset(file: &Path, project: &str, origin: &str, sources: &[IssueQuery]) -> Option<Vec<String>> {
    if sources.is_empty() || RepoStore::load_from(file).0.contains_key(&norm(project)) {
        return None;
    }
    let seed: Vec<String> = std::iter::once(origin)
        .chain(sources.iter().map(|q| q.repo.as_str()))
        .filter_map(|r| checked(r).ok())
        .collect();
    Some(save_in(file, project, &seed).unwrap_or_else(|_| normalize(&seed).unwrap_or_default()))
}

pub fn effective(project: &str, origin: &str, sources: &[IssueQuery]) -> Vec<String> {
    effective_in(&store_path(), project, origin, sources)
}

fn effective_in(file: &Path, project: &str, origin: &str, sources: &[IssueQuery]) -> Vec<String> {
    let list = seed_if_unset(file, project, origin, sources)
        .or_else(|| RepoStore::load_from(file).0.get(&norm(project)).cloned())
        .unwrap_or_default();
    if list.is_empty() {
        vec![origin.to_lowercase()]
    } else {
        list
    }
}

pub(crate) fn rekey(old: &str, new: &str) -> Result<(), String> {
    let lock = crate::exec::named_lock("issue_repos");
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    crate::attached_folder::rekey_file(&store_path(), old, new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-issue-repos-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("issue_repos.json")
    }

    fn source(repo: &str) -> IssueQuery {
        IssueQuery {
            repo: repo.into(),
            ..IssueQuery::default()
        }
    }

    #[test]
    fn only_owner_slash_name_is_saved_once_each_in_lowercase() {
        for bad in ["tori", "a/b/c", " ", "own er/x"] {
            assert!(normalize(&[bad.into()]).is_err(), "{bad}");
        }
        assert_eq!(
            normalize(&["GetTori/Tori".into(), " gettori/tickets ".into(), "gettori/tori".into()]).unwrap(),
            ["gettori/tori", "gettori/tickets"]
        );
    }

    #[test]
    fn a_cleared_list_stays_cleared_and_reads_the_origin() {
        let f = file("cleared");
        save_in(&f, "/p/", &[]).unwrap();
        let got = effective_in(&f, "/p", "gettori/tori", &[source("gettori/tickets")]);
        assert_eq!(got, ["gettori/tori"]);
        assert_eq!(RepoStore::load_from(&f).0.get("/p"), Some(&Vec::new()));
    }

    #[test]
    fn a_project_with_sources_and_no_list_is_seeded_once() {
        let f = file("seeded");
        let got = effective_in(&f, "/p", "gettori/tori", &[source("GetTori/Tickets")]);
        assert_eq!(got, ["gettori/tori", "gettori/tickets"]);
        assert_eq!(
            RepoStore::load_from(&f).0.get("/p").unwrap(),
            &["gettori/tori", "gettori/tickets"]
        );
    }

    #[test]
    fn no_list_and_no_sources_reads_the_origin_without_writing() {
        let f = file("origin");
        assert_eq!(effective_in(&f, "/p", "gettori/tori", &[]), ["gettori/tori"]);
        assert!(!f.exists());
    }

    #[test]
    fn a_source_outside_the_list_is_named() {
        let listed = ["gettori/tori".to_string()];
        let sources = [source("GetTori/Tori"), source("gettori/tickets")];
        assert_eq!(unlisted(&sources, &listed), Some("gettori/tickets"));
        assert_eq!(unlisted(&sources[..1], &listed), None);
    }

    #[test]
    fn a_saved_list_is_exactly_what_is_read() {
        let f = file("exact");
        save_in(&f, "/p", &["gettori/tickets".into()]).unwrap();
        assert_eq!(effective_in(&f, "/p", "gettori/tori", &[]), ["gettori/tickets"]);
    }
}
