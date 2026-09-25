// A plain repo's branch units share one folder and differ only by recorded
// branch, so the folder alone cannot say which row a session sits under.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::{BranchUnit, ProjectIndex, ProjectKind, Space};

// The sidebar lists every tracked folder in one burst, and each listing wants
// the tree, so a resolve is shared for a moment rather than repeated per folder.
const FRESH: Duration = Duration::from_secs(2);
static SPACES: Mutex<Option<(Instant, Arc<Vec<Space>>)>> = Mutex::new(None);

/// The configured tree, resolved at most once per `FRESH`.
pub fn spaces(index: &ProjectIndex) -> Arc<Vec<Space>> {
    let mut held = SPACES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, spaces)) = held.as_ref().filter(|(at, _)| at.elapsed() < FRESH) {
        return spaces.clone();
    }
    let spaces = Arc::new(crate::config::get_config_body(index).map(|c| c.spaces).unwrap_or_default());
    *held = Some((Instant::now(), spaces.clone()));
    spaces
}

/// The row a session sits under: its project, and the unit inside it, which is
/// its folder plus, for a plain repo, the branch that tells siblings apart.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Home {
    pub project: String,
    pub folder: String,
    pub branch: Option<String>,
}

/// The plain unit that owns re-homed sessions: the current checkout, else the
/// branchless folder fallback, else the first plain unit.
pub fn fallback_home<'a>(units: &[&'a BranchUnit]) -> Option<&'a BranchUnit> {
    let plain = || units.iter().copied().filter(|u| u.kind == ProjectKind::Plain);
    plain()
        .find(|u| u.is_current)
        .or_else(|| plain().find(|u| u.branch.is_none()))
        .or_else(|| plain().next())
}

/// Whether a session recording `branch`, anchored in `unit`'s folder, belongs
/// to `unit` rather than to one of its siblings.
pub fn belongs_to_unit(branch: Option<&str>, unit: &BranchUnit, siblings: &[&BranchUnit]) -> bool {
    if unit.kind != ProjectKind::Plain {
        return true;
    }
    let is_home = fallback_home(siblings).is_some_and(|home| home.branch == unit.branch);
    let b = branch.unwrap_or("");
    let visible = siblings
        .iter()
        .any(|x| x.kind == ProjectKind::Plain && x.branch.as_deref() == Some(b) && !b.is_empty());
    if visible {
        return unit.branch.as_deref().unwrap_or("") == b;
    }
    is_home
}

/// The row `cwd` and `branch` land under, or `None` when no unit's folder holds
/// the session. The most specific folder wins, so a worktree nested inside its
/// repo claims its own sessions.
pub fn home_of(spaces: &[Space], cwd: &str, branch: Option<&str>) -> Option<Home> {
    let (project, folder) = spaces
        .iter()
        .flat_map(|s| &s.projects)
        .flat_map(|p| p.branch_units.iter().map(move |u| (p, u.folder_path.as_str())))
        .filter(|(_, folder)| crate::sessions::owned_by_listing(cwd, folder))
        .max_by_key(|(_, folder)| folder.len())?;
    let siblings: Vec<&BranchUnit> = project.branch_units.iter().filter(|u| u.folder_path == folder).collect();
    let unit = siblings.iter().find(|u| belongs_to_unit(branch, u, &siblings))?;
    Some(Home { project: project.path.clone(), folder: folder.to_string(), branch: unit.branch.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(kind: ProjectKind, branch: Option<&str>, is_current: bool) -> BranchUnit {
        BranchUnit {
            label: String::new(),
            folder_path: "/p/repo".into(),
            branch: branch.map(str::to_string),
            kind,
            is_current,
            issue: None,
        }
    }
    fn plain(branch: Option<&str>, is_current: bool) -> BranchUnit {
        unit(ProjectKind::Plain, branch, is_current)
    }

    #[test]
    fn gives_a_worktree_everything_in_its_folder() {
        let u = unit(ProjectKind::Worktree, Some("feat"), false);
        assert!(belongs_to_unit(Some("main"), &u, &[&u]));
        assert!(belongs_to_unit(None, &u, &[&u]));
    }

    #[test]
    fn splits_a_plain_repos_siblings_by_recorded_branch() {
        let main = plain(Some("main"), true);
        let feat = plain(Some("feat"), false);
        let units = [&main, &feat];
        assert!(belongs_to_unit(Some("feat"), &feat, &units));
        assert!(!belongs_to_unit(Some("feat"), &main, &units));
        assert!(belongs_to_unit(Some("main"), &main, &units));
        assert!(!belongs_to_unit(Some("main"), &feat, &units));
    }

    #[test]
    fn re_homes_an_orphaned_recorded_branch_onto_the_checkout() {
        let main = plain(Some("main"), true);
        let feat = plain(Some("feat"), false);
        let units = [&main, &feat];
        assert!(belongs_to_unit(Some("deleted-branch"), &main, &units));
        assert!(!belongs_to_unit(Some("deleted-branch"), &feat, &units));
    }

    #[test]
    fn parks_a_branchless_session_on_the_checkout() {
        let main = plain(Some("main"), true);
        let feat = plain(Some("feat"), false);
        let units = [&main, &feat];
        for branch in [None, Some("")] {
            assert!(belongs_to_unit(branch, &main, &units));
            assert!(!belongs_to_unit(branch, &feat, &units));
        }
    }

    #[test]
    fn fallback_prefers_the_checkout_then_the_branchless_unit_then_the_first_plain_one() {
        let (a, b_current) = (plain(Some("a"), false), plain(Some("b"), true));
        assert_eq!(fallback_home(&[&a, &b_current]).unwrap().branch.as_deref(), Some("b"));
        let detached = plain(None, false);
        assert_eq!(fallback_home(&[&a, &detached]).unwrap().branch, None);
        let b = plain(Some("b"), false);
        assert_eq!(fallback_home(&[&a, &b]).unwrap().branch.as_deref(), Some("a"));
        let w = unit(ProjectKind::Worktree, Some("a"), false);
        assert!(fallback_home(&[&w]).is_none());
    }

    #[test]
    fn home_of_picks_the_most_specific_folder_and_skips_topic_worktrees() {
        let mut wt = unit(ProjectKind::Worktree, Some("feat"), false);
        wt.folder_path = "/p/repo-wt/feat".into();
        let project = crate::config::Project {
            name: "repo".into(),
            path: "/p/repo".into(),
            branch_units: vec![plain(Some("main"), true), plain(Some("feat"), false), wt],
            icon: None,
            icon_file: None,
            favicon: None,
        };
        let spaces = [Space { name: "s".into(), path: "/p".into(), projects: vec![project], icon: None, color: None }];
        let home = |cwd, branch| home_of(&spaces, cwd, branch).map(|h| (h.folder, h.branch));
        assert_eq!(home("/p/repo/src", Some("feat")), Some(("/p/repo".into(), Some("feat".into()))));
        assert_eq!(home("/p/repo", Some("gone")), Some(("/p/repo".into(), Some("main".into()))));
        assert_eq!(home("/p/repo-wt/feat", Some("main")), Some(("/p/repo-wt/feat".into(), Some("feat".into()))));
        assert_eq!(home("/p/repo/.tori/worktrees/auth", Some("auth")), None);
        assert_eq!(home("/elsewhere", None), None);
    }
}
