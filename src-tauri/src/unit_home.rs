// A plain repo's branch units share one folder and differ only by recorded
// branch, so the folder alone cannot say which row a session sits under.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::{BranchUnit, ProjectIndex, ProjectKind, Space};
use crate::topics::Topic;

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

/// Every Topic as recorded. Read fresh each time, so a Topic's first chat is
/// placed the moment it starts; not reconciled, since the folders a Topic
/// claims are on the record and git has no say in them.
pub fn topics() -> Vec<Topic> {
    crate::topics::recorded(&crate::topics::Store::default_location())
}

/// A Topic's workspace key, the same prefix as `TOPIC_KEY_PREFIX` in `topics.ts`.
pub const TOPIC_KEY: &str = "topic:";

/// The Topic a session belongs to, from whatever `at` is: the Topic's
/// workspace key, its home folder, or one of its member worktrees (where its
/// chats ran before homes existed).
pub fn topic_of<'a>(topics: &'a [Topic], at: &str) -> Option<&'a Topic> {
    if let Some(id) = at.strip_prefix(TOPIC_KEY) {
        return topics.iter().find(|t| t.id == id);
    }
    topics.iter().find(|t| {
        t.home.as_deref().is_some_and(|h| crate::sessions::cwd_matches(at, h))
            || t.members.iter().filter_map(|m| m.worktree_path.as_deref()).any(|w| crate::sessions::cwd_matches(at, w))
    })
}

/// The row a session sits under: its project, and the unit inside it, which is
/// its folder plus, for a plain repo, the branch that tells siblings apart.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Home {
    pub project: String,
    pub folder: String,
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
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

/// The row `cwd` and `branch` land under, or `None` when neither a unit's
/// folder nor a Topic holds the session. The most specific folder wins, so a
/// worktree nested inside its repo claims its own sessions. A Topic's session
/// also carries the Topic, and lands on its home when no unit holds it.
pub fn home_of(spaces: &[Space], topics: &[Topic], cwd: &str, branch: Option<&str>) -> Option<Home> {
    let topic = topic_of(topics, cwd);
    let home = unit_of(spaces, cwd, branch).or_else(|| {
        topic.map(|t| Home {
            project: t.name.clone(),
            folder: t.home.clone().unwrap_or_default(),
            branch: Some(t.branch.clone()),
            topic: None,
        })
    })?;
    Some(Home { topic: topic.map(|t| t.id.clone()), ..home })
}

fn unit_of(spaces: &[Space], cwd: &str, branch: Option<&str>) -> Option<Home> {
    let (project, folder) = spaces
        .iter()
        .flat_map(|s| &s.projects)
        .flat_map(|p| p.branch_units.iter().map(move |u| (p, u.folder_path.as_str())))
        .filter(|(_, folder)| crate::sessions::owned_by_listing(cwd, folder))
        .max_by_key(|(_, folder)| folder.len())?;
    let siblings: Vec<&BranchUnit> = project.branch_units.iter().filter(|u| u.folder_path == folder).collect();
    let unit = siblings.iter().find(|u| belongs_to_unit(branch, u, &siblings))?;
    Some(Home { project: project.path.clone(), folder: folder.to_string(), branch: unit.branch.clone(), topic: None })
}

/// The name of the project one of whose units lives at `folder`, or empty.
pub fn project_name(spaces: &[Space], folder: &str) -> String {
    spaces
        .iter()
        .flat_map(|s| &s.projects)
        .find(|p| p.branch_units.iter().any(|u| u.folder_path == folder))
        .map(|p| p.name.clone())
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod tests {
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
        let home = |cwd, branch| home_of(&spaces, &[], cwd, branch).map(|h| (h.folder, h.branch));
        assert_eq!(home("/p/repo/src", Some("feat")), Some(("/p/repo".into(), Some("feat".into()))));
        assert_eq!(home("/p/repo", Some("gone")), Some(("/p/repo".into(), Some("main".into()))));
        assert_eq!(home("/p/repo-wt/feat", Some("main")), Some(("/p/repo-wt/feat".into(), Some("feat".into()))));
        assert_eq!(home("/p/repo/.tori/worktrees/auth", Some("auth")), None);
        assert_eq!(home("/elsewhere", None), None);
    }

    pub(crate) fn topic() -> Topic {
        use crate::topics::{Checkout, Member, MemberMode, MemberState};
        let member = |repo: &str, mode, worktree: Option<&str>| Member {
            repo_path: repo.into(),
            display_name: String::new(),
            mode,
            worktree_path: worktree.map(Into::into),
            checkout: (mode == MemberMode::Reference).then(|| Checkout { path: repo.into(), branch: None, default_branch: None }),
            state: MemberState::Present,
            order: 0,
        };
        Topic {
            id: "auth-1".into(),
            name: "Auth".into(),
            branch: "auth".into(),
            members: vec![
                member("/p/api", MemberMode::Worktree, Some("/p/api/.tori/worktrees/auth")),
                member("/p/web", MemberMode::Reference, None),
            ],
            created_at: 0,
            home: Some("/cfg/topics/auth-1".into()),
        }
    }

    #[test]
    fn a_topic_claims_its_key_its_home_and_its_worktrees_but_not_a_reference_checkout() {
        let web = crate::config::Project {
            name: "web".into(),
            path: "/p/web".into(),
            branch_units: vec![BranchUnit { folder_path: "/p/web".into(), ..plain(Some("main"), true) }],
            icon: None,
            icon_file: None,
            favicon: None,
        };
        let spaces = [Space { name: "s".into(), path: "/p".into(), projects: vec![web], icon: None, color: None }];
        let topics = [topic()];
        let home = |at| home_of(&spaces, &topics, at, None).map(|h| (h.folder, h.topic));
        let topic_home = Some(("/cfg/topics/auth-1".to_string(), Some("auth-1".to_string())));
        assert_eq!(home("topic:auth-1"), topic_home);
        assert_eq!(home("/cfg/topics/auth-1"), topic_home);
        assert_eq!(home("/p/api/.tori/worktrees/auth/src"), topic_home);
        assert_eq!(home("/p/web"), Some(("/p/web".to_string(), None)));
        assert_eq!(home("topic:gone"), None);

        let wt = BranchUnit { folder_path: "/p/api/.tori/worktrees/auth".into(), ..unit(ProjectKind::Worktree, Some("auth"), false) };
        let api = crate::config::Project { name: "api".into(), path: "/p/api".into(), branch_units: vec![wt], icon: None, icon_file: None, favicon: None };
        let spaces = [Space { name: "s".into(), path: "/p".into(), projects: vec![api], icon: None, color: None }];
        let unit_home = home_of(&spaces, &topics, "/p/api/.tori/worktrees/auth", Some("auth")).unwrap();
        assert_eq!((unit_home.project.as_str(), unit_home.topic.as_deref()), ("/p/api", Some("auth-1")));
    }
}
