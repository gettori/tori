// Disk only, never git: nothing in the folder is trusted yet.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::attached_folder::{layout_at, origin_at, Layout};
use crate::base_layout::{has_git, is_project, setup_would_group, worktree_of_another_repo};

const HEAVY: &[&str] = &["node_modules", "target", "vendor", ".venv", "dist", "build"];
const BUDGET: usize = 2_000;
const MAX_DEPTH: usize = 4;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundSpace {
    pub name: String,
    pub path: String,
    pub projects: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Misplaced {
    pub path: String,
    pub relative: String,
    pub name: String,
    pub layout: Layout,
    pub suggestion: Option<String>,
}

// Every entry name inside a top-level folder, so the grouping view can refuse
// a move that would land on one before anything moves.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopFolder {
    pub name: String,
    pub entries: Vec<String>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RootScan {
    pub base: String,
    pub folders: Vec<TopFolder>,
    pub hidden: Vec<String>,
    pub spaces: Vec<FoundSpace>,
    pub misplaced: Vec<Misplaced>,
    pub empty_top: Vec<String>,
    pub too_big: Vec<String>,
    pub too_deep: Vec<String>,
    pub unreadable: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

struct Around {
    home: Option<PathBuf>,
    own_state: PathBuf,
}

fn canon(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// Symlinks are never followed, so a link back up the tree cannot loop the walk.
fn children(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|p| {
            let name = name_of(p);
            !name.starts_with('.') && !HEAVY.contains(&name.as_str())
        })
        .collect();
    out.sort();
    Ok(out)
}

fn linked_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_symlink()))
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !name_of(p).starts_with('.'))
        .collect();
    out.sort();
    out
}

fn remote_owner(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest
        .split_once('@')
        .map_or(rest, |(user, r)| if user.contains('/') { rest } else { r });
    let rest = match rest.split_once(':') {
        Some((host, path)) if !path.starts_with(|c: char| c.is_ascii_digit()) => format!("{host}/{path}"),
        _ => rest.to_string(),
    };
    let parts: Vec<&str> = rest
        .trim_end_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    (parts.len() >= 3).then(|| parts[parts.len() - 2].to_string())
}

#[derive(Default)]
struct Space {
    visited: usize,
    projects: usize,
    manifests: usize,
    nested: Vec<PathBuf>,
    too_deep: Vec<PathBuf>,
    unreadable: Vec<PathBuf>,
}

impl Space {
    fn over(&self) -> bool {
        self.visited > BUDGET
    }

    fn list(&mut self, dir: &Path) -> Vec<PathBuf> {
        children(dir).unwrap_or_else(|_| {
            self.unreadable.push(dir.to_path_buf());
            Vec::new()
        })
    }

    // Below the project level only a git repo is a project of its own: a
    // manifest down there belongs to the folder holding it, like a non-git
    // app with frontend/ and backend/.
    fn descend(&mut self, dir: &Path, depth: usize) {
        for child in self.list(dir) {
            self.visited += 1;
            if self.over() {
                break;
            }
            if has_git(&child) {
                self.nested.push(child);
            } else if is_project(&child) {
                self.manifests += 1;
            } else if depth == MAX_DEPTH {
                let deeper = self.list(&child);
                self.too_deep.extend(deeper.into_iter().filter(|g| has_git(g)));
            } else {
                self.descend(&child, depth + 1);
            }
        }
    }

    fn walk(top: &Path) -> Self {
        let mut space = Space::default();
        for child in space.list(top) {
            space.visited += 1;
            if space.over() {
                break;
            }
            if is_project(&child) {
                space.projects += 1;
                continue;
            }
            let (nested, manifests) = (space.nested.len(), space.manifests);
            space.descend(&child, 3);
            if space.manifests > manifests && space.nested.len() == nested {
                space.projects += 1;
            }
        }
        space
    }
}

fn refusal(base: &Path, around: &Around) -> Option<String> {
    if !base.is_dir() {
        return Some(format!("{} is not a folder.", base.display()));
    }
    let base = canon(base);
    if base.parent().is_none() || around.home.as_deref().map(canon).is_some_and(|h| h == base) {
        return Some("Pick a folder of projects, not your home folder or the whole disk.".into());
    }
    let own = canon(&around.own_state);
    if base.starts_with(&own) || own.starts_with(&base) {
        return Some("This folder holds Tori's own files.".into());
    }
    if setup_would_group(&base) {
        return Some("This is a project. Pick the folder that holds your projects.".into());
    }
    None
}

fn top_folder(dir: &Path) -> TopFolder {
    let mut entries: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();
    TopFolder {
        name: name_of(dir),
        entries,
    }
}

fn relative(base: &Path, path: &Path) -> String {
    path.strip_prefix(base).unwrap_or(path).to_string_lossy().into_owned()
}

fn misplaced(base: &Path, path: PathBuf, suggestion: Option<String>) -> Misplaced {
    Misplaced {
        relative: relative(base, &path),
        name: name_of(&path),
        layout: layout_at(&path),
        path: path.to_string_lossy().into_owned(),
        suggestion,
    }
}

fn scan_in(base: &Path, around: &Around) -> RootScan {
    let mut scan = RootScan {
        base: base.to_string_lossy().into_owned(),
        ..Default::default()
    };
    if let Some(why) = refusal(base, around) {
        scan.refused = Some(why);
        return scan;
    }
    let tops = match children(base) {
        Ok(tops) => tops,
        Err(e) => {
            scan.refused = Some(format!("Tori can't read this folder: {e}"));
            return scan;
        }
    };
    let mut walked_tops = 0;
    for top in &tops {
        if worktree_of_another_repo(top) {
            continue;
        }
        if setup_would_group(top) {
            let owner = origin_at(top).as_deref().and_then(remote_owner);
            scan.misplaced.push(misplaced(base, top.clone(), owner));
            continue;
        }
        walked_tops += 1;
        let walked = Space::walk(top);
        let name = name_of(top);
        scan.folders.push(top_folder(top));
        if walked.over() {
            scan.too_big.push(name);
            continue;
        }
        scan.too_deep.extend(walked.too_deep.iter().map(|p| relative(base, p)));
        scan.unreadable
            .extend(walked.unreadable.iter().map(|p| relative(base, p)));
        if walked.projects == 0 && walked.nested.is_empty() && walked.unreadable.is_empty() {
            scan.empty_top.push(name.clone());
        }
        if walked.projects > 0 {
            scan.spaces.push(FoundSpace {
                name: name.clone(),
                path: top.to_string_lossy().into_owned(),
                projects: walked.projects,
            });
        }
        for path in walked.nested {
            scan.misplaced.push(misplaced(base, path, Some(name.clone())));
        }
    }
    // A linked space is listed by discovery but never walked, so a link back up
    // the tree cannot loop the scan.
    for link in linked_dirs(base) {
        scan.folders.push(top_folder(&link));
        let projects = children(&link)
            .unwrap_or_default()
            .iter()
            .filter(|c| is_project(c))
            .count();
        match projects {
            0 => scan.empty_top.push(name_of(&link)),
            n => scan.spaces.push(FoundSpace {
                name: name_of(&link),
                path: link.to_string_lossy().into_owned(),
                projects: n,
            }),
        }
    }
    scan.spaces.sort_by(|a, b| a.name.cmp(&b.name));
    if walked_tops > 0 && scan.too_big.len() == walked_tops && scan.misplaced.is_empty() && scan.spaces.is_empty() {
        scan.refused = Some("This folder is too big to scan. Pick a narrower folder.".into());
    }
    scan
}

#[tauri::command(async)]
pub fn scan_root(path: String) -> RootScan {
    let trimmed = path.trim();
    let base = PathBuf::from(trimmed.strip_suffix('/').filter(|t| !t.is_empty()).unwrap_or(trimmed));
    let around = Around {
        home: dirs::home_dir(),
        own_state: crate::owned_state::config_dir(),
    };
    RootScan {
        hidden: crate::config::discovery_filters().1,
        ..scan_in(&base, &around)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-root-scan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        canon(&dir)
    }

    fn around(tmp: &Path) -> Around {
        Around {
            home: Some(tmp.join("home")),
            own_state: tmp.join("home/.config/tori"),
        }
    }

    fn repo(dir: &Path, origin: Option<&str>) {
        let git = dir.join(".git");
        fs::create_dir_all(git.join("refs/heads")).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let config = match origin {
            Some(url) => format!("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = {url}\n"),
            None => "[core]\n\tbare = false\n".into(),
        };
        fs::write(git.join("config"), config).unwrap();
    }

    fn relatives(scan: &RootScan) -> Vec<(&str, Option<&str>)> {
        scan.misplaced
            .iter()
            .map(|m| (m.relative.as_str(), m.suggestion.as_deref()))
            .collect()
    }

    #[test]
    fn a_base_that_already_fits_has_nothing_to_group() {
        let tmp = tmp();
        let base = tmp.join("P");
        repo(&base.join("work/api"), None);
        repo(&base.join("personal/blog"), None);
        fs::create_dir_all(base.join("work/notes")).unwrap();
        let scan = scan_in(&base, &around(&tmp));
        assert_eq!(scan.refused, None);
        let spaces: Vec<(&str, usize)> = scan.spaces.iter().map(|s| (s.name.as_str(), s.projects)).collect();
        assert_eq!(spaces, [("personal", 1), ("work", 1)]);
        assert!(scan.misplaced.is_empty() && scan.empty_top.is_empty() && scan.too_big.is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn loose_and_deep_repos_are_misplaced_with_a_suggested_space() {
        let tmp = tmp();
        let base = tmp.join("P");
        repo(&base.join("work/api"), None);
        repo(&base.join("site"), Some("git@github.com:fonngroup/site.git"));
        repo(&base.join("scratch"), None);
        repo(&base.join("office/x/repo"), None);
        fs::create_dir_all(base.join("screenshots/2026")).unwrap();
        for part in ["frontend", "backend"] {
            fs::create_dir_all(base.join("work/app").join(part)).unwrap();
            fs::write(base.join("work/app").join(part).join("package.json"), "{}").unwrap();
        }
        let scan = scan_in(&base, &around(&tmp));
        assert_eq!(scan.refused, None);
        assert_eq!(
            relatives(&scan),
            [
                ("office/x/repo", Some("office")),
                ("scratch", None),
                ("site", Some("fonngroup"))
            ]
        );
        assert!(matches!(scan.misplaced[2].layout, Layout::Clone { .. }));
        let spaces: Vec<(&str, usize)> = scan.spaces.iter().map(|s| (s.name.as_str(), s.projects)).collect();
        assert_eq!(spaces, [("work", 2)]);
        assert_eq!(scan.empty_top, ["screenshots"]);
        let work = scan.folders.iter().find(|f| f.name == "work").unwrap();
        assert_eq!(work.entries, ["api", "app"]);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_repo_past_the_depth_cap_is_reported_too_deep_not_dropped() {
        let tmp = tmp();
        let base = tmp.join("P");
        repo(&base.join("a/b/c/d/repo"), None);
        let scan = scan_in(&base, &around(&tmp));
        assert!(scan.misplaced.is_empty());
        assert_eq!(scan.too_deep, ["a/b/c/d/repo"]);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn heavy_folders_are_skipped_and_never_entered() {
        let tmp = tmp();
        let base = tmp.join("P");
        repo(&base.join("work/node_modules/pkg"), None);
        repo(&base.join("work/target/x"), None);
        let scan = scan_in(&base, &around(&tmp));
        assert!(scan.misplaced.is_empty());
        assert_eq!(scan.empty_top, ["work"]);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn one_huge_folder_is_skipped_and_only_an_all_huge_base_is_refused() {
        let tmp = tmp();
        let base = tmp.join("P");
        for i in 0..=BUDGET {
            fs::create_dir_all(base.join("photos").join(format!("d{i}"))).unwrap();
        }
        let scan = scan_in(&base, &around(&tmp));
        assert_eq!(scan.too_big, ["photos"]);
        assert!(scan.refused.unwrap().contains("too big"));

        repo(&base.join("work/api"), None);
        let scan = scan_in(&base, &around(&tmp));
        assert_eq!(scan.too_big, ["photos"]);
        assert_eq!(scan.refused, None);
        assert_eq!(scan.spaces.len(), 1);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn each_refusal_names_its_reason_and_lists_nothing() {
        let tmp = tmp();
        let around = around(&tmp);
        fs::create_dir_all(tmp.join("home/.config/tori")).unwrap();
        repo(&tmp.join("one-repo"), None);
        for (path, reason) in [
            (tmp.join("home"), "home folder"),
            (PathBuf::from("/"), "whole disk"),
            (tmp.join("home/.config"), "Tori's own files"),
            (tmp.join("one-repo"), "is a project"),
            (tmp.join("missing"), "not a folder"),
        ] {
            let scan = scan_in(&path, &around);
            assert!(scan.refused.as_deref().unwrap().contains(reason), "{path:?}");
            assert!(scan.spaces.is_empty() && scan.misplaced.is_empty());
        }
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn remote_owner_reads_every_common_url_shape() {
        for url in [
            "git@github.com:fonngroup/site.git",
            "https://github.com/fonngroup/site",
            "ssh://git@gitlab.com/fonngroup/site.git",
            "https://user@bitbucket.org/fonngroup/site.git",
        ] {
            assert_eq!(remote_owner(url).as_deref(), Some("fonngroup"), "{url}");
        }
        assert_eq!(remote_owner("/local/path/site").as_deref(), Some("path"));
        assert_eq!(remote_owner("site.git"), None);
    }
}
