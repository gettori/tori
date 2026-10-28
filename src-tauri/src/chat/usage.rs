//! What a session has cost, kept across restarts.
//!
//! **Why this has to be persisted at all.** `total_cost_usd` on a `result` frame
//! is per *turn*, not per session (measured, see `chatUsage.ts`), so a session
//! total is the sum of the turns Tori watched finish. Held only in the panel's
//! store, that sum resets every time the tab is reopened - which is fine for a
//! readout and useless for a ceiling, because a budget that forgets itself on
//! restart is not a budget.
//!
//! **One map per project, not one file per session.** The owned-state layout
//! calls for a small map atomically replaced, never a file per fact. Keying by
//! project rather than putting every session in one global map keeps each file
//! bounded by the sessions of one project, so the rewrite stays small on a
//! machine with years of history, and uses the shared path shape
//! [`crate::owned_state::project_state_path`] gives every per-project store.
//!
//! **Turns observed is recorded next to turns cost**, because the difference is
//! the honesty rule: a chat opened on a session with prior turns has history it
//! never saw a `result` frame for, so its total is a floor. Storing only the sum
//! would lose the one fact that says whether the sum can be trusted.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};

use serde::{Deserialize, Serialize};

use crate::owned_state::write_atomically;

/// The version stamped into a usage file.
///
/// Held here rather than shared, and deliberately still `2`: this used to be the
/// *rule* file's version constant, borrowed because both files were written by
/// the same module. Every usage file already on disk carries that value, so
/// giving this store its own constant must not change it - renumbering to 1
/// would make every existing file look like it came from the future.
const FORMAT_VERSION: u32 = 2;

pub const CHANGED_EVENT: &str = "usage://changed";

/// One session's running total.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub tokens: u64,
    /// `None` until some turn actually reported a cost, so a session whose
    /// agent reports no money reads as "unknown" rather than as free.
    #[serde(default)]
    pub cost_usd: Option<f64>,
    /// Turns Tori watched finish, which is what the two figures above are the
    /// sum of.
    pub turns: u32,
    /// The repo's git common dir, so the record still finds its repo after the
    /// worktree it ran in is deleted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    /// Split by the branch checked out when each turn ended, so a branch switch
    /// inside one chat splits the cost instead of moving it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub branches: BTreeMap<String, Spend>,
    /// Split by the session whose ceiling each turn was charged to, stamped per
    /// turn so a side chat's fork reopened as an ordinary chat charges nobody.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub charged_to: BTreeMap<String, Spend>,
    /// A side chat's turns split by the item they were charged to, kept per turn
    /// rather than in `item`, which would charge every later turn too.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub items: BTreeMap<String, Spend>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    pub tokens: u64,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    pub turns: u32,
    pub first: u64,
    pub last: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stamp {
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub item: Option<String>,
    pub parent: Option<String>,
    pub at: u64,
}

fn add_cost(total: &mut Option<f64>, cost: Option<f64>) {
    if let Some(cost) = cost {
        *total = Some(total.unwrap_or(0.0) + cost);
    }
}

impl SessionUsage {
    fn add(&mut self, tokens: u64, cost_usd: Option<f64>, turns: u32) {
        self.tokens = self.tokens.saturating_add(tokens);
        self.turns = self.turns.saturating_add(turns);
        add_cost(&mut self.cost_usd, cost_usd);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFile {
    #[serde(default)]
    pub format_version: u32,
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionUsage>,
}

pub fn usage_path(cwd: &str) -> PathBuf {
    crate::owned_state::project_state_path("usage", cwd)
}

pub fn load(path: &Path) -> UsageFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Add one completed turn and return the file it was written into.
///
/// Read-modify-write from the daemon's turn end, which is the only writer, so
/// there is no second party to race. The turn is counted whether or
/// not it reported a cost: `turns` is what the floor rule compares against, and
/// dropping an uncosted turn would make an *incomplete* observation look
/// complete.
fn write_turn(
    path: &Path,
    session_id: &str,
    tokens: u64,
    cost_usd: Option<f64>,
    stamp: &Stamp,
) -> Result<UsageFile, String> {
    let mut file = load(path);
    file.format_version = FORMAT_VERSION;
    let entry = file.sessions.entry(session_id.to_string()).or_default();
    entry.add(tokens, cost_usd, 1);
    if stamp.repo.is_some() {
        entry.repo.clone_from(&stamp.repo);
    }
    if let Some(branch) = &stamp.branch {
        add_to(&mut entry.branches, branch, tokens, cost_usd, stamp.at);
    }
    if let Some(parent) = &stamp.parent {
        add_to(&mut entry.charged_to, parent, tokens, cost_usd, stamp.at);
        if let Some(item) = &stamp.item {
            add_to(&mut entry.items, item, tokens, cost_usd, stamp.at);
        }
    } else if stamp.item.is_some() {
        entry.item.clone_from(&stamp.item);
    }
    write_atomically(path, &serde_json::to_string(&file).map_err(|e| e.to_string())?)?;
    Ok(file)
}

fn add_to(buckets: &mut BTreeMap<String, Spend>, key: &str, tokens: u64, cost_usd: Option<f64>, at: u64) {
    let bucket = buckets.entry(key.to_string()).or_insert_with(|| Spend {
        first: at,
        ..Spend::default()
    });
    bucket.tokens = bucket.tokens.saturating_add(tokens);
    bucket.turns = bucket.turns.saturating_add(1);
    add_cost(&mut bucket.cost_usd, cost_usd);
    bucket.last = at;
}

pub fn folded_session_total(file: &UsageFile, session_id: &str) -> SessionUsage {
    let mut out = file.sessions.get(session_id).cloned().unwrap_or_default();
    for b in file.sessions.values().filter_map(|s| s.charged_to.get(session_id)) {
        out.add(b.tokens, b.cost_usd, b.turns);
    }
    out
}

/// What a project has spent across every session in it, for the project ceiling.
pub fn project_total(file: &UsageFile) -> SessionUsage {
    let mut out = SessionUsage::default();
    for s in file.sessions.values() {
        out.add(s.tokens, s.cost_usd, s.turns);
    }
    out
}

/// The two sums a ceiling is measured against, sent together so a caller never
/// needs a second round trip for the one it did not ask for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub session: SessionUsage,
    pub project: SessionUsage,
}

pub fn record_live(
    cwd: &str,
    session_id: &str,
    tokens: u64,
    cost_usd: Option<f64>,
) -> Result<Vec<(String, UsageTotals)>, String> {
    let stamp = Stamp {
        repo: Some(crate::exec::common_dir(cwd).to_string_lossy().into_owned()),
        branch: crate::git::current_branch(cwd),
        item: crate::rpc::item_for_spend(session_id),
        parent: super::side::parent(session_id),
        at: crate::owned_state::now_ms(),
    };
    let path = usage_path(cwd);
    let file = write_turn(&path, session_id, tokens, cost_usd, &stamp)?;
    let changed = moved(&file, session_id, stamp.parent.as_deref());
    index()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(path, file);
    Ok(changed)
}

fn moved(file: &UsageFile, session_id: &str, parent: Option<&str>) -> Vec<(String, UsageTotals)> {
    let project = project_total(file);
    std::iter::once(session_id)
        .chain(parent)
        .map(|id| {
            let totals = UsageTotals {
                session: folded_session_total(file, id),
                project: project.clone(),
            };
            (id.to_string(), totals)
        })
        .collect()
}

fn parents() -> &'static Mutex<HashMap<String, String>> {
    static PARENTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    PARENTS.get_or_init(Default::default)
}

pub fn adopt(child: &str, parent: &str) {
    parents()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(child.to_string(), parent.to_string());
}

pub fn forget_parent(child: &str) {
    parents().lock().unwrap_or_else(PoisonError::into_inner).remove(child);
}

pub fn parent_of(session: &str) -> String {
    parents()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(session)
        .cloned()
        .unwrap_or_else(|| session.to_string())
}

pub type Index = HashMap<PathBuf, UsageFile>;

fn index() -> &'static Mutex<Index> {
    static INDEX: OnceLock<Mutex<Index>> = OnceLock::new();
    INDEX.get_or_init(|| Mutex::new(load_dir(&crate::owned_state::config_dir().join("usage"))))
}

pub fn load_dir(dir: &Path) -> Index {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Index::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            let file = load(&p);
            (p, file)
        })
        .collect()
}

pub fn with_index<R>(f: impl FnOnce(&Index) -> R) -> R {
    f(&index().lock().unwrap_or_else(PoisonError::into_inner))
}

fn sessions(index: &Index) -> impl Iterator<Item = &SessionUsage> {
    index.values().flat_map(|f| f.sessions.values())
}

pub fn branch_total(index: &Index, repo: &str, branch: &str) -> SessionUsage {
    let mut out = SessionUsage::default();
    for s in sessions(index).filter(|s| s.repo.as_deref() == Some(repo)) {
        if let Some(b) = s.branches.get(branch) {
            out.add(b.tokens, b.cost_usd, b.turns);
        }
    }
    out
}

pub fn item_total(index: &Index, item: &str) -> SessionUsage {
    let mut out = SessionUsage::default();
    for s in sessions(index) {
        if s.item.as_deref() == Some(item) {
            out.add(s.tokens, s.cost_usd, s.turns);
        } else if let Some(b) = s.items.get(item) {
            out.add(b.tokens, b.cost_usd, b.turns);
        }
    }
    out
}

// An item one of whose sessions reported no cost is left out, so a partial
// sum never passes for what the item cost.
pub fn item_costs(index: &Index) -> HashMap<String, f64> {
    let mut costs: HashMap<&str, Option<f64>> = HashMap::new();
    for s in sessions(index).filter(|s| s.turns > 0) {
        let whole = s.item.as_deref().map(|item| (item, s.cost_usd));
        let charged = s.items.iter().map(|(item, b)| (item.as_str(), b.cost_usd));
        for (item, cost) in whole.into_iter().chain(charged) {
            let total = costs.entry(item).or_insert(Some(0.0));
            *total = total.zip(cost).map(|(a, b)| a + b);
        }
    }
    costs
        .into_iter()
        .filter_map(|(item, cost)| Some((item.to_string(), cost?)))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpendQuery {
    Branch { project: String, branch: String },
    Item { id: String },
}

pub fn spend_for(index: &Index, queries: &[SpendQuery], repo_of: impl Fn(&str) -> String) -> Vec<SessionUsage> {
    queries
        .iter()
        .map(|q| match q {
            SpendQuery::Branch { project, branch } => branch_total(index, &repo_of(project), branch),
            SpendQuery::Item { id } => item_total(index, id),
        })
        .collect()
}

// A session one of `items` worked on counts whole (a side chat only its turns
// charged to one), any other only for its buckets on `branches`, so a session
// reached both ways counts once.
pub fn issue_total(index: &Index, repo: &str, branches: &HashSet<String>, items: &HashSet<String>) -> SessionUsage {
    let mut out = SessionUsage::default();
    for s in sessions(index) {
        let charged: Vec<&Spend> = items.iter().filter_map(|i| s.items.get(i)).collect();
        if s.item.as_ref().is_some_and(|i| items.contains(i)) {
            out.add(s.tokens, s.cost_usd, s.turns);
        } else if !charged.is_empty() {
            for b in charged {
                out.add(b.tokens, b.cost_usd, b.turns);
            }
        } else if s.repo.as_deref() == Some(repo) {
            for b in branches.iter().filter_map(|b| s.branches.get(b)) {
                out.add(b.tokens, b.cost_usd, b.turns);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_turn(
        path: &Path,
        id: &str,
        tokens: u64,
        cost_usd: Option<f64>,
        stamp: &Stamp,
    ) -> Result<SessionUsage, String> {
        write_turn(path, id, tokens, cost_usd, stamp).map(|file| file.sessions[id].clone())
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-usage-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("usage.json")
    }

    /// The whole reason this is on disk: a ceiling that forgets what has been
    /// spent every time a tab is reopened is not a ceiling.
    #[test]
    fn a_sessions_total_survives_being_reopened() {
        let path = scratch("survives");
        record_turn(&path, "s1", 100, Some(0.01), &Stamp::default()).unwrap();
        record_turn(&path, "s1", 250, Some(0.02), &Stamp::default()).unwrap();

        let reloaded = load(&path);
        let s1 = &reloaded.sessions["s1"];
        assert_eq!(s1.tokens, 350);
        assert_eq!(s1.turns, 2);
        assert!((s1.cost_usd.unwrap() - 0.03).abs() < 1e-9);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A turn that reported no cost still counts as a turn. `turns` is what the
    /// floor rule compares against the transcript, so dropping an uncosted turn
    /// would make an incomplete observation look complete.
    #[test]
    fn a_turn_with_no_cost_still_counts_as_observed() {
        let path = scratch("uncosted");
        let after = record_turn(&path, "s1", 10, None, &Stamp::default()).unwrap();
        assert_eq!(after.turns, 1);
        assert_eq!(after.cost_usd, None, "no cost reported is not the same as free");

        let with_cost = record_turn(&path, "s1", 10, Some(0.5), &Stamp::default()).unwrap();
        assert_eq!(with_cost.turns, 2);
        assert_eq!(with_cost.cost_usd, Some(0.5), "the costed turns still add up");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Sessions in one project share a file, and the project ceiling is measured
    /// across all of them - two chats open on one repo spend one budget.
    #[test]
    fn a_projects_total_spans_every_session_in_it() {
        let path = scratch("project");
        record_turn(&path, "s1", 100, Some(0.10), &Stamp::default()).unwrap();
        record_turn(&path, "s2", 200, Some(0.20), &Stamp::default()).unwrap();

        let total = project_total(&load(&path));
        assert_eq!(total.tokens, 300);
        assert_eq!(total.turns, 2);
        assert!((total.cost_usd.unwrap() - 0.30).abs() < 1e-9);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    fn at(repo: &str, branch: Option<&str>, item: Option<&str>, at: u64) -> Stamp {
        Stamp {
            repo: Some(repo.into()),
            branch: branch.map(Into::into),
            item: item.map(Into::into),
            parent: None,
            at,
        }
    }

    #[test]
    fn a_branch_switch_inside_a_session_splits_its_cost() {
        let path = scratch("switch");
        record_turn(&path, "s1", 100, Some(3.0), &at("/r/.git", Some("main"), None, 10)).unwrap();
        let s = record_turn(&path, "s1", 10, Some(0.5), &at("/r/.git", Some("fix-x"), None, 20)).unwrap();

        assert_eq!(s.turns, 2);
        assert_eq!(s.cost_usd, Some(3.5));
        assert_eq!(s.repo.as_deref(), Some("/r/.git"));
        let main = &s.branches["main"];
        assert_eq!(
            (main.cost_usd, main.turns, main.first, main.last),
            (Some(3.0), 1, 10, 10)
        );
        let fix = &s.branches["fix-x"];
        assert_eq!((fix.cost_usd, fix.turns, fix.first, fix.last), (Some(0.5), 1, 20, 20));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_file_from_before_stamping_loads_as_unstamped_spend() {
        let path = scratch("old");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"formatVersion":2,"sessions":{"s1":{"tokens":5,"costUsd":0.2,"turns":1}}}"#,
        )
        .unwrap();

        let s = &load(&path).sessions["s1"];
        assert_eq!((s.cost_usd, s.turns), (Some(0.2), 1));
        assert_eq!((s.repo.as_deref(), s.item.as_deref()), (None, None));
        assert!(s.branches.is_empty());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_reviewer_is_looked_up_under_its_parent() {
        adopt("reviewer-1", "parent-1");
        assert_eq!(parent_of("reviewer-1"), "parent-1");
        assert_eq!(parent_of("someone-else"), "someone-else");
        forget_parent("reviewer-1");
        assert_eq!(parent_of("reviewer-1"), "reviewer-1");
    }

    fn machine(name: &str) -> (PathBuf, Index) {
        let dir = scratch(name).parent().unwrap().to_path_buf();
        let repo = "/r/.git";
        let main = dir.join("main.json");
        record_turn(&main, "hand", 10, Some(1.0), &at(repo, Some("main"), None, 1)).unwrap();
        record_turn(&main, "hand", 10, Some(2.0), &at(repo, Some("fix-x"), None, 2)).unwrap();
        let gone = dir.join("wt-gone.json");
        record_turn(
            &gone,
            "worker",
            10,
            Some(4.0),
            &at(repo, Some("item-branch"), Some("i1"), 3),
        )
        .unwrap();
        record_turn(
            &gone,
            "reviewer",
            10,
            Some(0.5),
            &at(repo, Some("item-branch"), Some("i1"), 4),
        )
        .unwrap();
        let other = dir.join("other.json");
        record_turn(
            &other,
            "elsewhere",
            10,
            Some(8.0),
            &at("/o/.git", Some("main"), None, 5),
        )
        .unwrap();
        record_turn(&other, "old", 10, Some(16.0), &Stamp::default()).unwrap();
        let index = load_dir(&dir);
        (dir, index)
    }

    #[test]
    fn a_deleted_worktrees_spend_still_counts_for_its_item_and_branch() {
        let (dir, index) = machine("gone");
        let item = item_total(&index, "i1");
        assert_eq!((item.cost_usd, item.turns), (Some(4.5), 2));
        assert_eq!(branch_total(&index, "/r/.git", "item-branch").cost_usd, Some(4.5));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_item_on_a_branch_linked_to_its_own_issue_counts_once() {
        let (dir, index) = machine("once");
        let branches: HashSet<String> = ["item-branch".to_string(), "fix-x".to_string()].into();
        let items: HashSet<String> = ["i1".to_string()].into();
        let issue = issue_total(&index, "/r/.git", &branches, &items);
        assert_eq!((issue.cost_usd, issue.turns), (Some(6.5), 3));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_batch_answers_each_query_in_order_by_the_projects_repo() {
        let (dir, index) = machine("batch");
        let queries: Vec<SpendQuery> = serde_json::from_value(serde_json::json!([
            { "kind": "item", "id": "i1" },
            { "kind": "branch", "project": "/r/worktree", "branch": "fix-x" },
            { "kind": "branch", "project": "/r/worktree", "branch": "nowhere" },
        ]))
        .unwrap();
        let answers = spend_for(&index, &queries, |_| "/r/.git".to_string());
        let costs: Vec<_> = answers.iter().map(|s| s.cost_usd).collect();
        assert_eq!(costs, [Some(4.5), Some(2.0), None]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_items_cost_is_unknown_once_any_of_its_sessions_reported_none() {
        let (dir, _) = machine("item-cost");
        let acp = dir.join("acp.json");
        record_turn(&acp, "acp", 0, None, &at("/r/.git", Some("b"), Some("i2"), 6)).unwrap();
        record_turn(&acp, "claude", 10, Some(3.0), &at("/r/.git", Some("b"), Some("i2"), 7)).unwrap();
        let index = load_dir(&dir);
        let costs = item_costs(&index);
        assert_eq!(
            (costs.get("i1"), costs.get("i2"), costs.get("none")),
            (Some(&4.5), None, None)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unstamped_spend_counts_nowhere() {
        let (dir, index) = machine("nowhere");
        let everything: HashSet<String> = ["main".to_string()].into();
        let issue = issue_total(&index, "/o/.git", &everything, &HashSet::new());
        assert_eq!(issue.cost_usd, Some(8.0), "the old session's 16 is in no bucket");
        assert_eq!(item_total(&index, "").turns, 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_side_chats_stamped_turns_count_toward_its_parents_session_and_item_only() {
        let dir = scratch("side").parent().unwrap().to_path_buf();
        let path = dir.join("p.json");
        let repo = "/r/.git";
        record_turn(&path, "parent", 10, Some(1.0), &at(repo, Some("b"), Some("i1"), 1)).unwrap();
        let side = Stamp {
            parent: Some("parent".into()),
            ..at(repo, Some("b"), Some("i1"), 2)
        };
        record_turn(&path, "side", 10, Some(0.5), &side).unwrap();
        record_turn(&path, "side", 10, Some(0.25), &side).unwrap();
        record_turn(&path, "side", 10, Some(2.0), &at(repo, Some("b"), None, 3)).unwrap();

        let index = load_dir(&dir);
        let file = &index[&path];
        let parent = folded_session_total(file, "parent");
        assert_eq!((parent.cost_usd, parent.turns), (Some(1.75), 3));
        assert_eq!(
            file.sessions["parent"].cost_usd,
            Some(1.0),
            "the stored total is the parent's own"
        );
        assert_eq!(folded_session_total(file, "side").cost_usd, Some(2.75));
        assert_eq!(
            item_total(&index, "i1").cost_usd,
            Some(1.75),
            "the fork's unstamped turn is not the item's"
        );
        assert_eq!(item_costs(&index).get("i1"), Some(&1.75));
        let items: HashSet<String> = ["i1".to_string()].into();
        assert_eq!(issue_total(&index, repo, &HashSet::new(), &items).cost_usd, Some(1.75));
        assert_eq!(branch_total(&index, repo, "b").cost_usd, Some(3.75));
        let branches: HashSet<String> = ["b".to_string()].into();
        assert_eq!(
            issue_total(&index, repo, &branches, &HashSet::new()).cost_usd,
            Some(3.75)
        );

        let changed = moved(file, "side", Some("parent"));
        let ids: Vec<_> = changed
            .iter()
            .map(|(id, t)| (id.as_str(), t.session.cost_usd))
            .collect();
        assert_eq!(ids, [("side", Some(2.75)), ("parent", Some(1.75))]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Two checkouts of one repo are two projects, and must not share a budget.
    #[test]
    fn two_checkouts_sharing_a_basename_get_separate_usage_files() {
        let a = usage_path("/Users/x/Projects/tori/main");
        let b = usage_path("/Users/x/Projects/tori-wt/main");
        assert_ne!(a, b);
        assert_eq!(a.parent(), b.parent());
    }
}
