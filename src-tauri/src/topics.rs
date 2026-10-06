// A Topic: one shared branch checked out as one worktree per member
// repository, recorded in a sidecar so the group has an order, display names
// and a state git cannot express. See [[adr_feature_workspace]] and
// [[concept_feature_workspace]].
//
// Two shapes are load-bearing.
//
//   * **A read reconciles state, never membership.** Unlike `attempts.rs`, a
//     member whose worktree or repo is gone stays in the record with a state
//     naming what is missing, because the UI owes the user a repair action, not
//     a smaller Topic.
//   * **Every access to the file, the reconciling read included, takes the
//     `topics` named lock.** The reconcile is a load-compute-save, and a
//     creation loop flipping members on another thread would otherwise have its
//     flips overwritten by a stale copy.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::exec::{common_dir, named_lock, repo_lock};
use crate::owned_state::write_atomically;
use crate::worktree::{
    branch_exists, branch_has_worktree, create_worktree_in, list_worktrees_body, remote_branch_exists,
};

/// The member's creation is in flight: recorded before the first `worktree
/// add`, so a crash mid-loop leaves a retryable member, not a lost one.
pub const PENDING: &str = "pending";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MemberState {
    Present,
    /// Also the value a record without a state reads as: the reconcile
    /// rewrites it on the next read anyway.
    #[default]
    WorktreeMissing,
    RepoMissing,
    CheckoutMissing,
    Failed {
        reason: String,
    },
}

/// What the user asked a member to be. `state` is what git says it is, and
/// the two stay apart so a demoted member can still reconcile.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemberMode {
    /// The repo's own checkout, read for context. No worktree, no branch.
    Reference,
    #[default]
    Worktree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkout {
    pub path: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub repo_path: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub mode: MemberMode,
    /// Only ever a worktree this Topic owns. A reference keeps it `None`, so no
    /// removal or purge keyed on it can reach the user's own checkout.
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub checkout: Option<Checkout>,
    #[serde(default)]
    pub state: MemberState,
    #[serde(default)]
    pub order: u32,
}

pub fn member_root(m: &Member) -> Option<&str> {
    if m.state != MemberState::Present {
        return None;
    }
    match m.mode {
        MemberMode::Worktree => m.worktree_path.as_deref(),
        MemberMode::Reference => m.checkout.as_ref().map(|c| c.path.as_str()),
    }
}

/// What a chat gets when it asks for a worktree in a member it may only read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Promotion {
    #[default]
    Ask,
    Auto,
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub name: String,
    /// What the user typed, frozen at creation; the name stays free to change.
    pub branch: String,
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub promotion: Promotion,
    /// Where the Topic's chats run. Filled on the way out, never stored: the
    /// folder follows from where the record lives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TopicFile {
    #[serde(default)]
    topics: Vec<Topic>,
}

/// The file the records live in. A handle rather than a fixed path so every
/// rule below runs against a temp store in tests.
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn default_location() -> Self {
        Self::at(crate::owned_state::config_dir().join("topics.json"))
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Lenient like every other owned store: a missing or corrupt file is an
    /// empty set, never an error.
    fn load(&self) -> TopicFile {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    fn save(&self, file: &TopicFile) -> Result<(), String> {
        let stored = TopicFile {
            topics: file.topics.iter().cloned().map(|t| Topic { home: None, ..t }).collect(),
        };
        let text = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
        write_atomically(&self.path, &text)?;
        crate::topic_home::sync(&self.path, &file.topics);
        Ok(())
    }

    fn with_home(&self, mut topic: Topic) -> Topic {
        topic.home = Some(
            crate::topic_home::home_dir(&self.path, &topic.id)
                .to_string_lossy()
                .into_owned(),
        );
        topic
    }

    /// Load, edit, save, under the store's lock.
    fn mutate<T>(&self, f: impl FnOnce(&mut TopicFile) -> Result<T, String>) -> Result<T, String> {
        let lock = named_lock("topics");
        let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut file = self.load();
        let out = f(&mut file)?;
        self.save(&file)?;
        Ok(out)
    }
}

/// The branch as typed, trimmed, if git accepts it as a branch name. The echo
/// has to match: inside a repository `--branch` expands `@{-1}` to whatever was
/// checked out before, which is not the name the user asked for.
pub fn valid_branch(branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name is empty".into());
    }
    let out = crate::exec::git_outside_a_repo()
        .args(["check-ref-format", "--branch", branch])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() || String::from_utf8_lossy(&out.stdout).trim() != branch {
        return Err(format!("\"{branch}\" is not a valid branch name"));
    }
    Ok(branch.to_string())
}

pub fn new_id(branch: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos:x}", crate::worktree::slugify(branch))
}

fn canon(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn same_path(a: &str, b: &str) -> bool {
    canon(a) == canon(b)
}

/// Every Topic as the file holds it, homes filled, nothing asked of git.
pub fn recorded(store: &Store) -> Vec<Topic> {
    store.load().topics.into_iter().map(|t| store.with_home(t)).collect()
}

/// Every Topic, each member's `state` refreshed against git. Membership is
/// never changed by a read.
pub fn list_topics(store: &Store) -> Vec<Topic> {
    reconcile(store, false).0
}

/// `list_topics`, also taking on a worktree made outside promote: a reference
/// member whose repo already has one on the Topic branch becomes a worktree
/// member, the same record promote writes, and the worktree becomes the
/// Topic's to remove. Read from the listing the reconcile already made.
pub fn list_and_adopt(store: &Store) -> (Vec<Topic>, Vec<Adopted>) {
    reconcile(store, true)
}

/// A reference member taken on as a worktree member, and where its root moved.
pub struct Adopted {
    pub topic_id: String,
    pub from: Option<String>,
    pub to: String,
}

fn reconcile(store: &Store, adopt: bool) -> (Vec<Topic>, Vec<Adopted>) {
    let lock = named_lock("topics");
    let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = store.load();
    let mut changed = false;
    let mut adopted = Vec::new();
    for topic in &mut file.topics {
        for member in &mut topic.members {
            let was = member.mode;
            let (state, checkout) = match member.mode {
                MemberMode::Worktree => (reconcile_member(member, &topic.branch), None),
                MemberMode::Reference => {
                    let (found, listed) = reference_checkout(&member.repo_path);
                    let made = listed
                        .into_iter()
                        .find(|w| w.branch == topic.branch && !w.is_main && !w.is_bare && Path::new(&w.path).is_dir());
                    if let (true, Ok(c), Some(wt)) = (adopt, &found, made) {
                        adopted.push(Adopted {
                            topic_id: topic.id.clone(),
                            from: Some(c.path.clone()),
                            to: wt.path.clone(),
                        });
                        member.mode = MemberMode::Worktree;
                        member.worktree_path = Some(wt.path);
                        (MemberState::Present, None)
                    } else {
                        match found {
                            Ok(c) => (MemberState::Present, Some(c)),
                            Err(state) => (state, None),
                        }
                    }
                }
            };
            if state != member.state || checkout != member.checkout || member.mode != was {
                member.state = state;
                member.checkout = checkout;
                changed = true;
            }
        }
    }
    // Every read, not only a changed one: a Topic from before homes existed
    // has none until something writes it, and a chat cannot start in a folder
    // that is not there. A note already current costs one read.
    if changed {
        let _ = store.save(&file);
    } else {
        crate::topic_home::sync(&store.path, &file.topics);
    }
    (file.topics.into_iter().map(|t| store.with_home(t)).collect(), adopted)
}

/// Three checks, in order: the repo answers git at all, the recorded worktree
/// is on disk and listed, and the listed checkout is still on the Topic
/// branch. A folder deleted without `git worktree prune` is still listed, which
/// is why the disk check is separate from the list.
fn reconcile_member(member: &Member, branch: &str) -> MemberState {
    if !crate::worktree::repo_readable(&member.repo_path) {
        return MemberState::RepoMissing;
    }
    let Some(wt) = member.worktree_path.as_deref() else {
        return match &member.state {
            failed @ MemberState::Failed { .. } => failed.clone(),
            _ => MemberState::WorktreeMissing,
        };
    };
    if !Path::new(wt).is_dir() {
        return MemberState::WorktreeMissing;
    }
    let target = canon(wt);
    let listed = crate::worktree::list_worktrees_body(member.repo_path.clone())
        .ok()
        .and_then(|all| all.into_iter().find(|w| canon(&w.path) == target));
    match listed {
        Some(w) if w.branch == branch => MemberState::Present,
        _ => MemberState::WorktreeMissing,
    }
}

/// The checkout a reference reads, and the repo's worktrees as git listed them.
fn reference_checkout(repo: &str) -> (Result<Checkout, MemberState>, Vec<crate::worktree::Worktree>) {
    if !crate::worktree::repo_readable(repo) {
        return (Err(MemberState::RepoMissing), Vec::new());
    }
    let default_branch = crate::worktree::origin_default(repo);
    let worktrees = list_worktrees_body(repo.to_string()).unwrap_or_default();
    if !worktrees.iter().any(|w| w.is_bare) {
        let branch = worktrees
            .iter()
            .find(|w| same_path(&w.path, repo))
            .map(|w| w.branch.clone())
            .filter(|b| !b.is_empty());
        return (
            Ok(Checkout {
                path: repo.to_string(),
                branch,
                default_branch,
            }),
            worktrees,
        );
    }
    let found = worktrees
        .iter()
        .filter(|w| !w.is_bare && Path::new(&w.path).is_dir())
        .find(|w| match &default_branch {
            Some(d) => &w.branch == d,
            None => w.branch == "main" || w.branch == "master",
        })
        .map(|w| Checkout {
            path: w.path.clone(),
            branch: Some(w.branch.clone()),
            default_branch: default_branch.clone(),
        })
        .ok_or(MemberState::CheckoutMissing);
    (found, worktrees)
}

fn topic_mut<'a>(file: &'a mut TopicFile, topic_id: &str) -> Result<&'a mut Topic, String> {
    file.topics
        .iter_mut()
        .find(|f| f.id == topic_id)
        .ok_or_else(|| format!("No Topic with id {topic_id}"))
}

fn member_mut<'a>(topic: &'a mut Topic, repo_path: &str) -> Result<&'a mut Member, String> {
    topic
        .members
        .iter_mut()
        .find(|m| same_path(&m.repo_path, repo_path))
        .ok_or_else(|| format!("{repo_path} is not a member of {}", topic.name))
}

/// What the last-member refusal says, so the row menu can draw the reason on a
/// refusing Remove rather than waiting for the command to answer with it.
pub const LAST_MEMBER: &str = "A Topic needs at least one repository. Delete the Topic instead.";

/// Detach the record only. The worktree stays on disk; removing it is the
/// existing `remove_worktree` flow's job, with its own guards.
pub fn remove_member(store: &Store, topic_id: &str, repo_path: &str) -> Result<(), String> {
    store.mutate(|file| {
        let topic = topic_mut(file, topic_id)?;
        member_mut(topic, repo_path)?;
        if topic.members.len() <= 1 {
            return Err(LAST_MEMBER.into());
        }
        topic.members.retain(|m| !same_path(&m.repo_path, repo_path));
        Ok(())
    })
}

/// `repo_paths` in the wanted order; members it does not name keep their
/// relative order after the named ones.
pub fn reorder_members(store: &Store, topic_id: &str, repo_paths: &[String]) -> Result<(), String> {
    store.mutate(|file| {
        let topic = topic_mut(file, topic_id)?;
        let rank = |m: &Member| {
            repo_paths
                .iter()
                .position(|p| same_path(p, &m.repo_path))
                .unwrap_or(repo_paths.len())
        };
        topic.members.sort_by_key(|m| (rank(m), m.order));
        for (i, m) in topic.members.iter_mut().enumerate() {
            m.order = i as u32;
        }
        Ok(())
    })
}

pub fn rename_member(store: &Store, topic_id: &str, repo_path: &str, display_name: &str) -> Result<(), String> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err("Display name is empty".into());
    }
    store.mutate(|file| {
        member_mut(topic_mut(file, topic_id)?, repo_path)?.display_name = display_name.to_string();
        Ok(())
    })
}

/// The name only. The slug, and with it every member's branch, was frozen at
/// creation: renaming branches across repos is a git op this store never runs.
pub fn rename_topic(store: &Store, topic_id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Topic name is empty".into());
    }
    store.mutate(|file| {
        topic_mut(file, topic_id)?.name = name.to_string();
        Ok(())
    })
}

pub fn set_promotion(store: &Store, topic_id: &str, promotion: Promotion) -> Result<(), String> {
    store.mutate(|file| {
        topic_mut(file, topic_id)?.promotion = promotion;
        Ok(())
    })
}

/// The member a chat names: its repository, the folder it opens as, or its
/// name.
pub fn member_named<'a>(topic: &'a Topic, named: &str) -> Result<&'a Member, String> {
    topic
        .members
        .iter()
        .find(|m| {
            same_path(&m.repo_path, named)
                || member_root(m).is_some_and(|r| same_path(r, named))
                || m.display_name.eq_ignore_ascii_case(named.trim())
        })
        .ok_or_else(|| format!("{named} is not a member of {}", topic.name))
}

/// A chat's request for a worktree, settled by the Topic's policy: `ask`
/// puts the question to the user and says whether they agreed, `promote`
/// does the work.
pub fn promote_for_chat(
    topic: &Topic,
    member: &Member,
    ask: impl FnOnce(&str) -> Result<bool, String>,
    promote: impl FnOnce() -> Result<Topic, String>,
) -> Result<Topic, String> {
    if member.mode == MemberMode::Worktree {
        return Err(format!("{} already has a worktree for this Topic", member.display_name));
    }
    match topic.promotion {
        Promotion::Never => Err(format!(
            "The Topic {} does not let a chat create worktrees. Ask the user to create one for {}.",
            topic.name, member.display_name
        )),
        Promotion::Auto => promote(),
        Promotion::Ask => {
            let question = format!(
                "Create a worktree for {} on {} so this chat can change it?",
                member.display_name, topic.branch
            );
            if ask(&question)? {
                promote()
            } else {
                Err(format!(
                    "The user declined a worktree for {}. Leave it unchanged.",
                    member.display_name
                ))
            }
        }
    }
}

/// Point a member at the repository it moved to.
///
/// `repo_path` is a member's persisted identity, so this is the one write that
/// changes it. Three steps, in this order, and the order is the point.
///
///   1. **Re-point the worktree when it travelled.** A worktree inside the repo
///      folder (both layouts put one there: `.tori/worktrees/<slug>` for a plain
///      repo, `<container>/<slug>` for a bare one) moved with it, so its recorded
///      path is stale in exactly the same way. One that sits elsewhere did not
///      move and is left alone.
///   2. **`git worktree repair`.** A moved repo leaves its worktrees physically
///      present but administratively broken, pointing at a gitdir that is gone.
///      Without this the member reads `WorktreeMissing` at a folder that is
///      plainly there, and Recreate refuses it as a branch already checked out.
///   3. **Prune.** Whatever repair could not save is dropped, so the member
///      lands on `WorktreeMissing` honestly and Recreate can build it.
///
/// Repair is not "rebuild the worktree". This never creates or deletes one; the
/// reconcile that follows is what names the state.
pub fn relocate_member(store: &Store, topic_id: &str, repo_path: &str, new_repo_path: &str) -> Result<Topic, String> {
    if !crate::worktree::repo_readable(new_repo_path) {
        return Err(format!("{new_repo_path} is not a git repository"));
    }
    let topic = load_topic(store, topic_id)?;
    let member = topic
        .members
        .iter()
        .find(|m| same_path(&m.repo_path, repo_path))
        .ok_or_else(|| format!("{repo_path} is not a member of {}", topic.name))?;
    // Every member but this one: re-pointing a member at the repo it already
    // has is a harmless no-op, while landing on another member's repo would
    // check the same branch out twice.
    if topic
        .members
        .iter()
        .filter(|m| !same_path(&m.repo_path, repo_path))
        .any(|m| same_repo(&m.repo_path, new_repo_path))
    {
        return Err(format!("{new_repo_path} is already a member of {}", topic.name));
    }

    let worktree_path = member
        .worktree_path
        .as_deref()
        .map(|wt| match relative_to(wt, &member.repo_path) {
            Some(rest) => format!("{}/{rest}", new_repo_path.trim_end_matches('/')),
            None => wt.to_string(),
        });

    {
        let lock = repo_lock(new_repo_path);
        let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut args = vec!["worktree".to_string(), "repair".to_string()];
        if let Some(wt) = worktree_path.as_deref() {
            args.push(wt.to_string());
        }
        let _ = crate::exec::git_in(new_repo_path).args(&args).output();
        crate::worktree::prune_worktrees(new_repo_path);
    }

    store.mutate(|file| {
        let member = member_mut(topic_mut(file, topic_id)?, repo_path)?;
        member.repo_path = new_repo_path.to_string();
        member.worktree_path = worktree_path;
        Ok(())
    })?;
    reconciled_topic(store, topic_id)
}

/// The record with every member's state refreshed. What a call that changed the
/// world on disk has to answer with: `load_topic` returns the stored state,
/// and the stored state is the one such a call has just invalidated. Callers
/// that write the state themselves (`build_member`) do not need it.
fn reconciled_topic(store: &Store, topic_id: &str) -> Result<Topic, String> {
    list_topics(store)
        .into_iter()
        .find(|f| f.id == topic_id)
        .ok_or_else(|| format!("No Topic with id {topic_id}"))
}

/// `path`'s tail below `base`, or None when it is not inside it. String work on
/// purpose: a moved repo's old path no longer exists, so nothing here can be
/// canonicalized.
fn relative_to(path: &str, base: &str) -> Option<String> {
    let base = base.trim_end_matches('/');
    path.strip_prefix(base)
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|rest| !rest.is_empty())
        .map(str::to_string)
}

/// The record only. Worktrees and branches stay exactly as they are.
pub fn delete_topic(store: &Store, topic_id: &str) -> Result<(), String> {
    store.mutate(|file| {
        let before = file.topics.len();
        file.topics.retain(|f| f.id != topic_id);
        if file.topics.len() == before {
            return Err(format!("No Topic with id {topic_id}"));
        }
        Ok(())
    })?;
    crate::topic_home::remove(&store.path, topic_id);
    Ok(())
}

// --- creation ---

/// Where a member's worktree goes. A bare container takes it directly, the
/// way every other worktree there is laid out; a plain repo gets it under
/// `.tori/worktrees`, kept out of the repo by `.git/info/exclude`.
pub(crate) fn topic_container(repo: &str) -> Result<PathBuf, String> {
    // A vanished repo lists as empty, which would read as "plain" and create
    // `.tori/worktrees` at a path that no longer holds a repository.
    if !crate::worktree::repo_readable(repo) {
        return Err(format!("{repo} is not a git repository"));
    }
    let is_container = list_worktrees_body(repo.to_string())?.iter().any(|w| w.is_bare);
    if is_container {
        return Ok(PathBuf::from(repo));
    }
    crate::git::exclude_from_repo(repo, crate::workspace_settings::TORI_DIR);
    let (tori, worktrees) = crate::fs::TOPIC_WORKTREES;
    let dir = Path::new(repo).join(tori).join(worktrees);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

fn repo_display_name(repo: &str) -> String {
    Path::new(repo)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo.to_string())
}

/// Two paths naming one repository (a worktree and its main checkout share a
/// common dir) are one member: the same branch cannot be checked out twice.
fn same_repo(a: &str, b: &str) -> bool {
    common_dir(a) == common_dir(b)
}

fn pending_member(repo: &str, mode: MemberMode, order: u32) -> Member {
    Member {
        repo_path: repo.to_string(),
        display_name: repo_display_name(repo),
        mode,
        worktree_path: None,
        checkout: None,
        state: MemberState::Failed { reason: PENDING.into() },
        order,
    }
}

/// One repo a creating call adds, and what it should be.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMember {
    pub repo_path: String,
    #[serde(default)]
    pub mode: MemberMode,
}

fn build(store: &Store, topic_id: &str, repo: &str, branch: &str, mode: MemberMode) -> Result<(), String> {
    match mode {
        MemberMode::Worktree => build_member(store, topic_id, repo, branch),
        MemberMode::Reference => build_reference(store, topic_id, repo, false),
    }
}

/// Attaching never writes git. Only the repair, which the user asks for by
/// name, checks a container's default branch out when it has none.
fn build_reference(store: &Store, topic_id: &str, repo: &str, repair: bool) -> Result<(), String> {
    let resolved = match reference_checkout(repo).0 {
        Err(MemberState::CheckoutMissing) if repair => {
            let default = crate::worktree::origin_default(repo).unwrap_or_else(|| "main".into());
            let lock = repo_lock(repo);
            let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match create_worktree_in(repo, &default, Path::new(repo), None) {
                Ok(_) => reference_checkout(repo).0,
                Err(reason) => Err(MemberState::Failed { reason }),
            }
        }
        other => other,
    };
    store.mutate(|file| {
        let member = member_mut(topic_mut(file, topic_id)?, repo)?;
        match resolved {
            Ok(c) => {
                member.checkout = Some(c);
                member.state = MemberState::Present;
            }
            Err(state) => {
                member.checkout = None;
                member.state = state;
            }
        }
        Ok(())
    })
}

/// Create one member's worktree and flip its record. The repo lock covers the
/// git work only; the store is re-loaded under its own lock for the flip, so
/// a concurrent read never overwrites this member with a stale copy.
fn build_member(store: &Store, topic_id: &str, repo: &str, branch: &str) -> Result<(), String> {
    let outcome = member_worktree(repo, branch);
    store.mutate(|file| {
        let member = member_mut(topic_mut(file, topic_id)?, repo)?;
        match outcome {
            Ok(path) => {
                member.worktree_path = Some(path.to_string_lossy().into_owned());
                member.state = MemberState::Present;
            }
            Err(reason) => member.state = MemberState::Failed { reason },
        }
        Ok(())
    })
}

/// A branch that already has a secondary worktree is adopted as it is; one
/// checked out in the repo's own working tree is the user's and fails instead.
///
/// The prune and the `is_dir` filter are what make Recreate converge. Git keeps
/// listing a worktree whose folder was deleted outside Tori, so adopting the
/// entry as it stands would flip the member `Present` and `reconcile_member`
/// (which checks the disk separately) would put it straight back to
/// `WorktreeMissing` on the next read. Both, not either: prune skips a locked
/// entry, and it can fail on a repo git is unhappy with.
fn member_worktree(repo: &str, branch: &str) -> Result<PathBuf, String> {
    let lock = repo_lock(repo);
    let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    crate::worktree::prune_worktrees(repo);
    let existing = list_worktrees_body(repo.to_string()).ok().and_then(|wts| {
        wts.into_iter()
            .find(|w| w.branch == branch && Path::new(&w.path).is_dir())
    });
    match existing {
        Some(w) if w.is_main && !w.is_bare => Err(format!("{branch} is checked out in place")),
        Some(w) => Ok(PathBuf::from(w.path)),
        None => topic_container(repo).and_then(|c| create_worktree_in(repo, branch, &c, None)),
    }
}

fn find_member<'a>(topic: &'a Topic, repo: &str) -> Result<&'a Member, String> {
    topic
        .members
        .iter()
        .find(|m| same_path(&m.repo_path, repo))
        .ok_or_else(|| format!("{repo} is not a member of {}", topic.name))
}

/// Give a reference its worktree on the Topic branch. The record changes only
/// once git has answered, so a refusal leaves the member a reference.
pub fn promote_member(store: &Store, topic_id: &str, repo: &str) -> Result<Topic, String> {
    let topic = load_topic(store, topic_id)?;
    let member = find_member(&topic, repo)?;
    if member.mode == MemberMode::Worktree {
        return Err(format!("{} already has a worktree", member.display_name));
    }
    let path = member_worktree(repo, &topic.branch)?;
    store.mutate(|file| {
        let member = member_mut(topic_mut(file, topic_id)?, repo)?;
        member.mode = MemberMode::Worktree;
        member.worktree_path = Some(path.to_string_lossy().into_owned());
        member.checkout = None;
        member.state = MemberState::Present;
        Ok(())
    })?;
    reconciled_topic(store, topic_id)
}

/// Remove a member's worktree and keep it as a reference. The branch stays,
/// so promoting again picks the work back up. Only a `Present` worktree is
/// removed: a recorded folder git no longer lists on the Topic branch may be
/// holding something else.
pub fn demote_member(store: &Store, topic_id: &str, repo: &str, force: bool) -> Result<Topic, String> {
    let topic = load_topic(store, topic_id)?;
    let member = find_member(&topic, repo)?;
    if member.mode == MemberMode::Reference {
        return Err(format!("{} has no worktree", member.display_name));
    }
    if let (MemberState::Present, Some(wt)) = (&member.state, member.worktree_path.as_deref()) {
        let lock = repo_lock(repo);
        let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        crate::worktree::do_remove_worktree(repo, wt, force)?;
    }
    store.mutate(|file| {
        let member = member_mut(topic_mut(file, topic_id)?, repo)?;
        member.mode = MemberMode::Reference;
        member.worktree_path = None;
        Ok(())
    })?;
    reconciled_topic(store, topic_id)
}

fn load_topic(store: &Store, topic_id: &str) -> Result<Topic, String> {
    let lock = named_lock("topics");
    let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = store.load();
    topic_mut(&mut file, topic_id).map(|f| store.with_home(f.clone()))
}

/// Record first, then one worktree per member in order. A member that fails
/// stays recorded as `Failed` with git's reason and the loop moves on, so the
/// Topic exists even when one repo has a colliding folder. `on_step` sees
/// the record after the write and after every member, N+1 times for N repos.
#[cfg(test)]
pub fn create_topic(
    store: &Store,
    name: &str,
    branch: &str,
    repos: &[String],
    on_step: &dyn Fn(&Topic),
) -> Result<Topic, String> {
    let members: Vec<NewMember> = repos
        .iter()
        .map(|r| NewMember {
            repo_path: r.clone(),
            mode: MemberMode::Worktree,
        })
        .collect();
    create_topic_with(store, name, branch, &members, on_step)
}

/// `create_topic` with a mode per repo. A reference creates nothing in git, so
/// a Topic of only references never creates its branch.
pub fn create_topic_with(
    store: &Store,
    name: &str,
    branch: &str,
    members: &[NewMember],
    on_step: &dyn Fn(&Topic),
) -> Result<Topic, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Topic name is empty".into());
    }
    let branch = valid_branch(branch)?;
    if members.is_empty() {
        return Err("A Topic needs at least one repository".into());
    }
    let repos: Vec<&String> = members.iter().map(|m| &m.repo_path).collect();
    for (i, repo) in repos.iter().enumerate() {
        if repos[..i].iter().any(|seen| same_repo(seen, repo)) {
            return Err(format!("{repo} is listed twice"));
        }
    }

    let id = new_id(&branch);
    store.mutate(|file| {
        if let Some(taken) = file.topics.iter().find(|f| f.branch == branch) {
            return Err(format!("Topic \"{}\" already uses {branch}", taken.name));
        }
        file.topics.push(Topic {
            id: id.clone(),
            name: name.to_string(),
            branch: branch.clone(),
            members: members
                .iter()
                .enumerate()
                .map(|(i, m)| pending_member(&m.repo_path, m.mode, i as u32))
                .collect(),
            created_at: crate::owned_state::now_ms(),
            promotion: Promotion::default(),
            home: None,
        });
        Ok(())
    })?;

    on_step(&load_topic(store, &id)?);
    for m in members {
        build(store, &id, &m.repo_path, &branch, m.mode)?;
        on_step(&load_topic(store, &id)?);
    }
    load_topic(store, &id)
}

/// Re-run one member's creation. A `Present` member simply re-resolves to the
/// worktree it already has.
pub fn retry_member(store: &Store, topic_id: &str, repo: &str) -> Result<Topic, String> {
    let topic = load_topic(store, topic_id)?;
    let Some(member) = topic.members.iter().find(|m| same_path(&m.repo_path, repo)) else {
        return Err(format!("{repo} is not a member of {}", topic.name));
    };
    match member.mode {
        MemberMode::Worktree => build_member(store, topic_id, repo, &topic.branch)?,
        MemberMode::Reference => build_reference(store, topic_id, repo, true)?,
    }
    load_topic(store, topic_id)
}

/// Append a pending member, then build it: one call ends with a member the
/// user can open, or a `Failed` one with the reason. `on_step` sees the
/// record after the append and after the build.
#[cfg(test)]
pub fn add_member(store: &Store, topic_id: &str, repo: &str, on_step: &dyn Fn(&Topic)) -> Result<Topic, String> {
    add_member_as(store, topic_id, repo, MemberMode::Worktree, on_step)
}

pub fn add_member_as(
    store: &Store,
    topic_id: &str,
    repo: &str,
    mode: MemberMode,
    on_step: &dyn Fn(&Topic),
) -> Result<Topic, String> {
    let branch = store.mutate(|file| {
        let topic = topic_mut(file, topic_id)?;
        if topic.members.iter().any(|m| same_repo(&m.repo_path, repo)) {
            return Err(format!("{repo} is already a member of {}", topic.name));
        }
        let order = topic.members.len() as u32;
        topic.members.push(pending_member(repo, mode, order));
        Ok(topic.branch.clone())
    })?;
    on_step(&load_topic(store, topic_id)?);
    build(store, topic_id, repo, &branch, mode)?;
    let topic = load_topic(store, topic_id)?;
    on_step(&topic);
    Ok(topic)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchProbe {
    pub valid: bool,
    pub local: bool,
    pub remote: bool,
    pub has_worktree: bool,
}

/// Whether git would take `branch`, and what it already is in `repo`, so a
/// dialog can say "will reuse" or "checked out in place" before anything runs.
pub fn probe_topic_branch(repo: &str, branch: &str) -> BranchProbe {
    let branch = branch.trim();
    BranchProbe {
        valid: valid_branch(branch).is_ok(),
        local: branch_exists(repo, branch),
        remote: remote_branch_exists(repo, branch),
        has_worktree: branch_has_worktree(repo, branch),
    }
}

pub mod commands {
    use std::path::Path;

    use tauri::{AppHandle, Emitter, Manager, State};

    use super::{BranchProbe, MemberMode, NewMember, Store, Topic};
    use crate::config::ProjectIndex;
    use crate::exec::blocking;

    /// Per-step progress for the Topic list: cheap for the sidebar, unlike
    /// `config://changed`, which reloads the whole Spaces tree.
    fn step(app: &AppHandle) -> impl Fn(&Topic) + '_ {
        move |topic| {
            let _ = app.emit("topics://changed", topic);
        }
    }

    /// After a worktree-creating call: adopt the new folders, drop the cached
    /// probes so discovery sees them, and refresh the tree once.
    fn settle(app: &AppHandle, index: &ProjectIndex, topic: &Topic) {
        for m in &topic.members {
            index.evict(Path::new(&m.repo_path));
            // A reference's folder is already the user's own unit.
            if m.mode == MemberMode::Reference {
                continue;
            }
            if let Some(path) = super::member_root(m) {
                let _ = crate::sessions::adopt(path);
            }
        }
        let _ = app.emit("config://changed", ());
    }

    fn told_now(topic_id: &str) -> crate::topic_home::Told {
        super::load_topic(&Store::default_location(), topic_id)
            .map(|t| crate::topic_home::told(&t))
            .unwrap_or_default()
    }

    /// Running chats in the Topic's home hear how it stands now.
    fn tell_chats(app: &AppHandle, before: &crate::topic_home::Told, topic: &Topic) {
        let host = &app.state::<crate::chat::host::ChatState>().0;
        crate::topic_home::tell_home_chats(
            before,
            topic,
            &host.live_sessions(),
            |session, dirs| host.grant_dirs(session, dirs),
            |session, text| crate::rpc::tell_session(app, session, "topic-changed", text),
        );
    }

    /// The Topics as git has them now. Also where a change nobody made through
    /// Tori is noticed: a worktree made outside promote is adopted, and a home
    /// chat hears of whatever its note no longer matches.
    #[tauri::command]
    pub async fn list_topics(app: AppHandle, index: State<'_, ProjectIndex>) -> Result<Vec<Topic>, String> {
        let index = index.inner().clone();
        blocking("list_topics", move || {
            // Several surfaces list at once; each change is told once.
            let lock = crate::exec::named_lock("topics-told");
            let _g = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let store = Store::default_location();
            let before: Vec<_> = super::recorded(&store)
                .iter()
                .map(|t| (t.id.clone(), crate::topic_home::told(t)))
                .collect();
            let (topics, adopted) = super::list_and_adopt(&store);
            for topic in &topics {
                if let Some((_, told)) = before.iter().find(|(id, _)| *id == topic.id) {
                    tell_chats(&app, told, topic);
                }
            }
            for a in &adopted {
                let Some(topic) = topics.iter().find(|t| t.id == a.topic_id) else {
                    continue;
                };
                settle(&app, &index, topic);
                let _ = app.emit(
                    "topics://promoted",
                    serde_json::json!({ "topic": topic, "from": a.from, "to": a.to }),
                );
            }
            Ok(topics)
        })
        .await
    }

    #[tauri::command]
    pub async fn create_topic(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        name: String,
        branch: String,
        members: Vec<NewMember>,
    ) -> Result<Topic, String> {
        let index = index.inner().clone();
        blocking("create_topic", move || {
            let topic = super::create_topic_with(&Store::default_location(), &name, &branch, &members, &step(&app))?;
            settle(&app, &index, &topic);
            Ok(topic)
        })
        .await
    }

    #[tauri::command]
    pub async fn retry_member(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        topic_id: String,
        repo_path: String,
    ) -> Result<Topic, String> {
        let index = index.inner().clone();
        blocking("retry_member", move || {
            let before = told_now(&topic_id);
            let topic = super::retry_member(&Store::default_location(), &topic_id, &repo_path)?;
            settle(&app, &index, &topic);
            tell_chats(&app, &before, &topic);
            Ok(topic)
        })
        .await
    }

    #[tauri::command]
    pub async fn add_member(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        topic_id: String,
        repo_path: String,
        mode: Option<MemberMode>,
    ) -> Result<Topic, String> {
        let index = index.inner().clone();
        blocking("add_member", move || {
            let store = Store::default_location();
            let mode = mode.unwrap_or_default();
            let before = told_now(&topic_id);
            let topic = super::add_member_as(&store, &topic_id, &repo_path, mode, &step(&app))?;
            settle(&app, &index, &topic);
            tell_chats(&app, &before, &topic);
            Ok(topic)
        })
        .await
    }

    #[tauri::command]
    pub async fn promote_member(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        topic_id: String,
        repo_path: String,
    ) -> Result<Topic, String> {
        let index = index.inner().clone();
        blocking("promote_member", move || {
            promote_settled(&app, &index, &topic_id, &repo_path)
        })
        .await
    }

    /// Promote, then tell the rest of the app: the sidebar, and every chat in
    /// the Topic's home, which is granted the new worktree.
    pub(crate) fn promote_settled(
        app: &AppHandle,
        index: &ProjectIndex,
        topic_id: &str,
        repo: &str,
    ) -> Result<Topic, String> {
        let before = told_now(topic_id);
        let topic = super::promote_member(&Store::default_location(), topic_id, repo)?;
        settle(app, index, &topic);
        tell_chats(app, &before, &topic);
        Ok(topic)
    }

    /// The UI tears down what runs under the worktree first, the same contract
    /// `remove_worktree` has, and passes `force` once its confirm has warned.
    #[tauri::command]
    pub async fn demote_member(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        topic_id: String,
        repo_path: String,
        force: bool,
    ) -> Result<Topic, String> {
        let index = index.inner().clone();
        blocking("demote_member", move || {
            let before = told_now(&topic_id);
            let topic = super::demote_member(&Store::default_location(), &topic_id, &repo_path, force)?;
            settle(&app, &index, &topic);
            tell_chats(&app, &before, &topic);
            Ok(topic)
        })
        .await
    }

    /// Not record-only despite writing one field: the repo folder changed, so
    /// the tree has to re-discover it and the probe cache for both paths is
    /// stale. That is `settle`, the same finish a worktree-creating call takes.
    #[tauri::command]
    pub async fn relocate_member(
        app: AppHandle,
        index: State<'_, ProjectIndex>,
        topic_id: String,
        repo_path: String,
        new_repo_path: String,
    ) -> Result<Topic, String> {
        let index = index.inner().clone();
        blocking("relocate_member", move || {
            index.evict(Path::new(&repo_path));
            let before = told_now(&topic_id);
            let topic = super::relocate_member(&Store::default_location(), &topic_id, &repo_path, &new_repo_path)?;
            settle(&app, &index, &topic);
            tell_chats(&app, &before, &topic);
            Ok(topic)
        })
        .await
    }

    /// A record-only mutation: run it, reload, and announce the result. Every
    /// consumer of `createTopicMembers` reads on the event, so a rename or a
    /// reorder that emits nothing is invisible outside the sidebar's own signal.
    fn announce(
        app: &AppHandle,
        store: &Store,
        topic_id: &str,
        run: impl FnOnce() -> Result<(), String>,
    ) -> Result<Topic, String> {
        run()?;
        let topic = super::load_topic(store, topic_id)?;
        let _ = app.emit("topics://changed", &topic);
        Ok(topic)
    }

    /// `announce`, and home chats hear how the Topic stands after it.
    fn announce_and_tell(
        app: &AppHandle,
        store: &Store,
        topic_id: &str,
        run: impl FnOnce() -> Result<(), String>,
    ) -> Result<Topic, String> {
        let before = told_now(topic_id);
        let topic = announce(app, store, topic_id, run)?;
        tell_chats(app, &before, &topic);
        Ok(topic)
    }

    #[tauri::command]
    pub async fn remove_member(app: AppHandle, topic_id: String, repo_path: String) -> Result<Topic, String> {
        blocking("remove_member", move || {
            let store = Store::default_location();
            announce_and_tell(&app, &store, &topic_id, || {
                super::remove_member(&store, &topic_id, &repo_path)
            })
        })
        .await
    }

    #[tauri::command]
    pub async fn reorder_members(app: AppHandle, topic_id: String, repo_paths: Vec<String>) -> Result<Topic, String> {
        blocking("reorder_members", move || {
            let store = Store::default_location();
            announce(&app, &store, &topic_id, || {
                super::reorder_members(&store, &topic_id, &repo_paths)
            })
        })
        .await
    }

    #[tauri::command]
    pub async fn rename_member(
        app: AppHandle,
        topic_id: String,
        repo_path: String,
        display_name: String,
    ) -> Result<Topic, String> {
        blocking("rename_member", move || {
            let store = Store::default_location();
            announce_and_tell(&app, &store, &topic_id, || {
                super::rename_member(&store, &topic_id, &repo_path, &display_name)
            })
        })
        .await
    }

    #[tauri::command]
    pub async fn rename_topic(app: AppHandle, topic_id: String, name: String) -> Result<Topic, String> {
        blocking("rename_topic", move || {
            let store = Store::default_location();
            announce_and_tell(&app, &store, &topic_id, || {
                super::rename_topic(&store, &topic_id, &name)
            })
        })
        .await
    }

    #[tauri::command]
    pub async fn set_topic_promotion(
        app: AppHandle,
        topic_id: String,
        promotion: super::Promotion,
    ) -> Result<Topic, String> {
        blocking("set_topic_promotion", move || {
            let store = Store::default_location();
            announce_and_tell(&app, &store, &topic_id, || {
                super::set_promotion(&store, &topic_id, promotion)
            })
        })
        .await
    }

    #[tauri::command]
    pub async fn delete_topic(topic_id: String) -> Result<(), String> {
        blocking("delete_topic", move || {
            super::delete_topic(&Store::default_location(), &topic_id)
        })
        .await
    }

    #[tauri::command]
    pub async fn probe_topic_branch(repo_path: String, branch: String) -> Result<BranchProbe, String> {
        blocking("probe_topic_branch", move || {
            Ok(super::probe_topic_branch(&repo_path, &branch))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owned_state::now_ms;

    fn unique_tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori-topics-{}-{seq}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        // git reports resolved paths, and macOS resolves `/var` to `/private/var`.
        std::fs::canonicalize(dir).unwrap()
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::platform::process::command("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn repo(dir: &Path) -> String {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@t"]);
        git(dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "first"]);
        dir.to_string_lossy().into_owned()
    }

    fn member(repo_path: &str, worktree_path: Option<&str>, state: MemberState) -> Member {
        Member {
            repo_path: repo_path.to_string(),
            display_name: "m".into(),
            mode: MemberMode::Worktree,
            worktree_path: worktree_path.map(String::from),
            checkout: None,
            state,
            order: 0,
        }
    }

    fn topic(id: &str, members: Vec<Member>) -> Topic {
        Topic {
            id: id.into(),
            name: id.into(),
            branch: format!("feat/{id}"),
            members,
            created_at: 1,
            promotion: Promotion::default(),
            home: None,
        }
    }

    fn store_with(tmp: &Path, topics: Vec<Topic>) -> Store {
        let store = Store::at(tmp.join("topics.json"));
        store.save(&TopicFile { topics }).unwrap();
        store
    }

    #[test]
    fn round_trips_and_tolerates_an_empty_file_and_unknown_fields() {
        let tmp = unique_tmp();
        let store = Store::at(tmp.join("topics.json"));
        assert!(store.load().topics.is_empty(), "a missing file is an empty set");

        std::fs::write(&store.path, "").unwrap();
        assert!(store.load().topics.is_empty(), "an empty file is an empty set");

        let full = topic(
            "auth",
            vec![
                member("/r/a", Some("/r/a/.tori/worktrees/auth"), MemberState::Present),
                member(
                    "/r/b",
                    None,
                    MemberState::Failed {
                        reason: "pending".into(),
                    },
                ),
            ],
        );
        store
            .save(&TopicFile {
                topics: vec![full.clone()],
            })
            .unwrap();
        assert_eq!(store.load().topics, vec![full]);

        std::fs::write(
            &store.path,
            r#"{"topics":[{"id":"x","name":"X","branch":"feat/x","members":[{"repoPath":"/r","mood":"?"}],"future":1}]}"#,
        )
        .unwrap();
        let loaded = store.load().topics;
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].members[0].worktree_path, None);
        assert_eq!(loaded[0].members[0].state, MemberState::WorktreeMissing);
        assert_eq!(loaded[0].created_at, 0);

        let text = std::fs::read_to_string(&store.path).unwrap();
        assert!(text.contains("\"repoPath\""), "the wire format is camelCase");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_deleted_repo_reads_as_repo_missing_and_stays_in_the_file() {
        let tmp = unique_tmp();
        let gone = tmp.join("gone");
        let repo_path = repo(&gone);
        let wt = tmp.join("wt");
        git(&gone, &["worktree", "add", "-q", "-b", "feat/f", &wt.to_string_lossy()]);
        let store = store_with(
            &tmp,
            vec![topic(
                "f",
                vec![member(&repo_path, Some(&wt.to_string_lossy()), MemberState::Present)],
            )],
        );

        std::fs::remove_dir_all(&gone).unwrap();
        let listed = list_topics(&store);
        assert_eq!(listed[0].members[0].state, MemberState::RepoMissing);
        assert_eq!(store.load().topics[0].members.len(), 1, "a read never drops a member");
        assert_eq!(store.load().topics[0].members[0].state, MemberState::RepoMissing);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_folder_deleted_without_prune_reads_as_worktree_missing() {
        let tmp = unique_tmp();
        let r = tmp.join("r");
        let repo_path = repo(&r);
        let wt = tmp.join("wt");
        let wt_str = wt.to_string_lossy().into_owned();
        git(&r, &["worktree", "add", "-q", "-b", "feat/f", &wt_str]);
        let store = store_with(
            &tmp,
            vec![topic(
                "f",
                vec![member(&repo_path, Some(&wt_str), MemberState::WorktreeMissing)],
            )],
        );

        assert_eq!(
            list_topics(&store)[0].members[0].state,
            MemberState::Present,
            "a live worktree on the branch is present"
        );

        std::fs::remove_dir_all(&wt).unwrap();
        assert_eq!(list_topics(&store)[0].members[0].state, MemberState::WorktreeMissing);
        assert_eq!(
            store.load().topics[0].members[0].state,
            MemberState::WorktreeMissing,
            "and the file was written back"
        );
        assert_eq!(
            store.load().topics[0].members[0].worktree_path.as_deref(),
            Some(wt_str.as_str()),
            "only state changes"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_worktree_switched_off_the_branch_reads_as_worktree_missing() {
        let tmp = unique_tmp();
        let r = tmp.join("r");
        let repo_path = repo(&r);
        let wt = tmp.join("wt");
        let wt_str = wt.to_string_lossy().into_owned();
        git(&r, &["worktree", "add", "-q", "-b", "feat/f", &wt_str]);
        let store = store_with(
            &tmp,
            vec![topic(
                "f",
                vec![member(&repo_path, Some(&wt_str), MemberState::Present)],
            )],
        );

        git(&wt, &["checkout", "-q", "-b", "other"]);
        assert_eq!(list_topics(&store)[0].members[0].state, MemberState::WorktreeMissing);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_pending_member_stays_failed_until_it_has_a_worktree() {
        let tmp = unique_tmp();
        let repo_path = repo(&tmp.join("r"));
        let pending = MemberState::Failed {
            reason: "pending".into(),
        };
        let store = store_with(&tmp, vec![topic("f", vec![member(&repo_path, None, pending.clone())])]);
        assert_eq!(list_topics(&store)[0].members[0].state, pending);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn remove_member_detaches_the_record_and_leaves_the_worktree() {
        let tmp = unique_tmp();
        let r = tmp.join("r");
        let repo_path = repo(&r);
        let wt = tmp.join("wt");
        let wt_str = wt.to_string_lossy().into_owned();
        git(&r, &["worktree", "add", "-q", "-b", "feat/f", &wt_str]);
        let store = store_with(
            &tmp,
            vec![topic(
                "f",
                vec![
                    member(&repo_path, Some(&wt_str), MemberState::Present),
                    member("/r/b", None, MemberState::WorktreeMissing),
                ],
            )],
        );

        remove_member(&store, "f", &repo_path).unwrap();
        let members = store.load().topics[0].members.clone();
        assert_eq!(
            members.iter().map(|m| m.repo_path.as_str()).collect::<Vec<_>>(),
            ["/r/b"]
        );
        assert!(wt.join("a.txt").is_file(), "the worktree is untouched");
        assert!(
            remove_member(&store, "f", &repo_path).is_err(),
            "a second removal names the absent member"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn remove_member_refuses_the_last_one_and_points_at_delete() {
        let tmp = unique_tmp();
        let store = store_with(
            &tmp,
            vec![topic("f", vec![member("/r/a", None, MemberState::WorktreeMissing)])],
        );

        let err = remove_member(&store, "f", "/r/a").expect_err("the last member stays");
        assert_eq!(err, LAST_MEMBER);
        assert_eq!(store.load().topics[0].members.len(), 1, "the record is intact");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn topic_container_is_the_bare_container_or_an_excluded_tori_dir() {
        let tmp = unique_tmp();
        let src = tmp.join("src");
        repo(&src);
        let cont = tmp.join("cont");
        std::fs::create_dir_all(&cont).unwrap();
        let out = crate::platform::process::command("git")
            .args([
                "clone",
                "-q",
                "--bare",
                src.to_str().unwrap(),
                cont.join(".bare").to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
        let cont_s = cont.to_string_lossy().into_owned();
        assert_eq!(topic_container(&cont_s).unwrap(), cont);

        let plain = tmp.join("plain");
        let plain_s = repo(&plain);
        assert_eq!(topic_container(&plain_s).unwrap(), plain.join(".tori/worktrees"));
        assert!(plain.join(".tori/worktrees").is_dir());
        let exclude = || std::fs::read_to_string(plain.join(".git/info/exclude")).unwrap_or_default();
        assert_eq!(exclude().lines().filter(|l| *l == ".tori/").count(), 1);
        topic_container(&plain_s).unwrap();
        assert_eq!(exclude().lines().filter(|l| *l == ".tori/").count(), 1, "idempotent");

        let gone = tmp.join("gone");
        let gone_s = repo(&gone);
        std::fs::remove_dir_all(&gone).unwrap();
        assert!(topic_container(&gone_s).is_err());
        assert!(!gone.exists(), "nothing is created where the repo used to be");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn create_topic_records_first_and_keeps_going_past_a_failed_member() {
        let tmp = unique_tmp();
        let a = repo(&tmp.join("a"));
        let b = repo(&tmp.join("b"));
        let c = repo(&tmp.join("c"));
        // Both folder names the picker would try are taken in b.
        std::fs::create_dir_all(tmp.join("b/.tori/worktrees/x")).unwrap();
        std::fs::create_dir_all(tmp.join("b/.tori/worktrees/feat-x")).unwrap();
        let store = Store::at(tmp.join("topics.json"));

        let f = create_topic(&store, "X", "feat/x", &[a.clone(), b.clone(), c.clone()], &|_| {}).unwrap();
        assert_eq!(f.branch, "feat/x");
        assert!(f.id.starts_with("feat-x-"));
        let states: Vec<_> = f.members.iter().map(|m| &m.state).collect();
        assert_eq!(states[0], &MemberState::Present);
        assert!(
            matches!(states[1], MemberState::Failed { reason } if reason.contains("refusing to overwrite")),
            "{:?}",
            states[1]
        );
        assert_eq!(states[2], &MemberState::Present);
        assert_eq!(f.members.iter().map(|m| m.order).collect::<Vec<_>>(), [0, 1, 2]);
        assert_eq!(f.members[0].display_name, "a");
        let wt_a = PathBuf::from(f.members[0].worktree_path.as_deref().unwrap());
        assert_eq!(wt_a, tmp.join("a/.tori/worktrees/x"));
        assert!(wt_a.join("a.txt").is_file());
        assert_eq!(f.members[1].worktree_path, None);

        // The record is what a reader sees between members: the reconcile agrees.
        let listed = list_topics(&store);
        assert_eq!(
            listed[0].members.iter().map(|m| m.state.clone()).collect::<Vec<_>>(),
            f.members.iter().map(|m| m.state.clone()).collect::<Vec<_>>()
        );

        // The plain repo stays clean and its walkers do not see the worktree.
        let status = crate::platform::process::command("git")
            .arg("-C")
            .arg(&a)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout).trim(), "");
        let files = crate::fs::list_project_files_body(a.clone()).unwrap();
        assert!(files.iter().all(|p| !p.contains(".tori/worktrees")), "{files:?}");
        let hits =
            crate::search::grep_project(a.clone(), "one".into(), crate::search::SearchOptions::default(), 50).unwrap();
        assert!(!hits.matches.is_empty());
        assert!(hits.matches.iter().all(|m| !m.path.contains(".tori/worktrees")));

        // Guards: same branch, same repo twice, a worktree of a member is the member.
        assert!(create_topic(&store, "x", "feat/x", std::slice::from_ref(&a), &|_| {})
            .unwrap_err()
            .contains("already uses feat/x"));
        assert!(create_topic(&store, "Y", "y", &[a.clone(), a.clone()], &|_| {})
            .unwrap_err()
            .contains("listed twice"));
        let wt_a_s = wt_a.to_string_lossy().into_owned();
        assert!(create_topic(&store, "Y", "y", &[a.clone(), wt_a_s], &|_| {})
            .unwrap_err()
            .contains("listed twice"));
        assert!(create_topic(&store, "Z", "z", &[], &|_| {}).is_err());
        assert_eq!(store.load().topics.len(), 1, "a rejected create leaves no record");

        // Retry flips the failed member once the collision is gone.
        std::fs::remove_dir_all(tmp.join("b/.tori/worktrees/x")).unwrap();
        std::fs::remove_dir_all(tmp.join("b/.tori/worktrees/feat-x")).unwrap();
        let f = retry_member(&store, &f.id, &b).unwrap();
        assert_eq!(f.members[1].state, MemberState::Present);
        assert_eq!(
            f.members[1].worktree_path.as_deref(),
            Some(tmp.join("b/.tori/worktrees/x").to_str().unwrap())
        );
        assert!(retry_member(&store, &f.id, &c).is_ok(), "a present member re-resolves");
        assert!(retry_member(&store, &f.id, "/nope").is_err());

        // add_member ends present with a worktree on disk.
        let d = repo(&tmp.join("d"));
        let f = add_member(&store, &f.id, &d, &|_| {}).unwrap();
        assert_eq!(f.members.len(), 4);
        assert_eq!(f.members[3].order, 3);
        assert_eq!(f.members[3].state, MemberState::Present);
        assert!(tmp.join("d/.tori/worktrees/x/a.txt").is_file());
        assert!(add_member(&store, &f.id, &d, &|_| {})
            .unwrap_err()
            .contains("already a member"));

        let probe = probe_topic_branch(&d, "feat/x");
        assert_eq!(
            probe,
            BranchProbe {
                valid: true,
                local: true,
                remote: false,
                has_worktree: true
            }
        );
        let fresh = repo(&tmp.join("e"));
        assert_eq!(
            probe_topic_branch(&fresh, "feat/x"),
            BranchProbe {
                valid: true,
                local: false,
                remote: false,
                has_worktree: false
            }
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn build_member_adopts_a_secondary_worktree_and_refuses_the_main_tree() {
        let tmp = unique_tmp();
        let a = tmp.join("a");
        let a_s = repo(&a);
        let wt = tmp.join("elsewhere");
        let wt_s = wt.to_string_lossy().into_owned();
        git(&a, &["worktree", "add", "-q", "-b", "feat/x", &wt_s]);
        let b = tmp.join("b");
        let b_s = repo(&b);
        git(&b, &["checkout", "-q", "-b", "feat/x"]);
        let store = Store::at(tmp.join("topics.json"));

        let f = create_topic(&store, "X", "feat/x", &[a_s.clone(), b_s.clone()], &|_| {}).unwrap();
        assert_eq!(f.members[0].state, MemberState::Present);
        assert_eq!(f.members[0].worktree_path.as_deref(), Some(wt_s.as_str()));
        assert!(!a.join(".tori/worktrees").exists(), "adopting creates no container");
        let listed = list_worktrees_body(a_s.clone()).unwrap();
        assert_eq!(listed.len(), 2, "no new worktree");
        assert_eq!(
            f.members[1].state,
            MemberState::Failed {
                reason: "feat/x is checked out in place".into()
            }
        );
        assert_eq!(f.members[1].worktree_path, None);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn recreate_converges_on_a_worktree_deleted_outside_git() {
        // The exact state Recreate exists for: the folder is gone but git still
        // lists it, because nothing ran `git worktree prune`. Adopting that
        // entry flips the member Present at a path that is not there, and
        // `reconcile_member`'s own disk check puts it back to WorktreeMissing on
        // the very next read, so Recreate would loop forever on its own subject.
        let tmp = unique_tmp();
        let a = tmp.join("a");
        let a_s = repo(&a);
        let store = Store::at(tmp.join("topics.json"));
        let f = create_topic(&store, "X", "feat/x", std::slice::from_ref(&a_s), &|_| {}).unwrap();
        let wt = f.members[0].worktree_path.clone().unwrap();

        std::fs::remove_dir_all(&wt).unwrap();
        assert_eq!(
            list_worktrees_body(a_s.clone()).unwrap().len(),
            2,
            "git still lists the deleted folder"
        );
        assert_eq!(list_topics(&store)[0].members[0].state, MemberState::WorktreeMissing);

        let fixed = retry_member(&store, &f.id, &a_s).unwrap();
        assert_eq!(fixed.members[0].state, MemberState::Present);
        let path = fixed.members[0].worktree_path.clone().unwrap();
        assert!(Path::new(&path).is_dir(), "{path} is not on disk");
        // And it stays: a second read is what the loop used to fail.
        assert_eq!(list_topics(&store)[0].members[0].state, MemberState::Present);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn create_topic_takes_the_branch_exactly_as_typed() {
        let tmp = unique_tmp();
        let a = repo(&tmp.join("a"));
        let store = Store::at(tmp.join("topics.json"));
        let head = |wt: &str| {
            let out = crate::platform::process::command("git")
                .arg("-C")
                .arg(wt)
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        for (name, branch, folder) in [
            ("Webhooks", "webhooks", "webhooks"),
            ("Login bug", "bug/login", "login"),
            ("\u{56fd}\u{969b}\u{5316}", "i18n", "i18n"),
        ] {
            let t = create_topic(&store, name, branch, std::slice::from_ref(&a), &|_| {}).unwrap();
            assert_eq!(t.name, name);
            assert_eq!(t.branch, branch);
            assert!(
                t.id.starts_with(&format!("{}-", crate::worktree::slugify(branch))),
                "{}",
                t.id
            );
            assert_eq!(t.members[0].state, MemberState::Present, "{branch}");
            let wt = t.members[0].worktree_path.clone().unwrap();
            assert_eq!(PathBuf::from(&wt), tmp.join("a/.tori/worktrees").join(folder));
            assert_eq!(head(&wt), branch);
        }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn create_topic_refuses_a_branch_git_would_not_take() {
        let tmp = unique_tmp();
        let a = repo(&tmp.join("a"));
        let store = Store::at(tmp.join("topics.json"));

        for bad in ["bug login", "@{-1}", "-x", "  "] {
            assert!(
                create_topic(&store, "X", bad, std::slice::from_ref(&a), &|_| {}).is_err(),
                "{bad:?}"
            );
            assert!(!probe_topic_branch(&a, bad).valid, "{bad:?}");
        }
        assert!(store.load().topics.is_empty(), "a refused branch leaves no record");
        assert!(!tmp.join("a/.tori").exists());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn one_repo_belongs_to_two_topics_at_once() {
        // The refusal is per branch, not per repo: two Topics over the same
        // repository get one worktree each, on their own branch, so the
        // repo's unit row wears a chip pointing back at each of them.
        let tmp = unique_tmp();
        let a = repo(&tmp.join("a"));
        let store = Store::at(tmp.join("topics.json"));

        let auth = create_topic(&store, "auth", "auth", std::slice::from_ref(&a), &|_| {}).unwrap();
        let billing = create_topic(&store, "billing", "billing", std::slice::from_ref(&a), &|_| {}).unwrap();

        assert_eq!(auth.members[0].state, MemberState::Present);
        assert_eq!(billing.members[0].state, MemberState::Present);
        let (wt_a, wt_b) = (
            auth.members[0].worktree_path.clone().unwrap(),
            billing.members[0].worktree_path.clone().unwrap(),
        );
        assert_ne!(wt_a, wt_b, "one worktree each, named by the branch");
        assert!(wt_a.ends_with("auth") && wt_b.ends_with("billing"));
        assert_eq!(list_topics(&store).len(), 2);
        // Only the branch collides, and only with itself.
        assert!(create_topic(&store, "auth", "auth", std::slice::from_ref(&a), &|_| {})
            .unwrap_err()
            .contains("already uses auth"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn relocate_refuses_a_non_repo_and_another_members_repo() {
        let tmp = unique_tmp();
        let a = repo(&tmp.join("a"));
        let b = repo(&tmp.join("b"));
        let store = Store::at(tmp.join("topics.json"));
        let f = create_topic(&store, "X", "feat/x", &[a.clone(), b.clone()], &|_| {}).unwrap();

        let plain = tmp.join("not-a-repo");
        std::fs::create_dir_all(&plain).unwrap();
        let err = relocate_member(&store, &f.id, &a, plain.to_str().unwrap()).unwrap_err();
        assert!(err.contains("not a git repository"), "{err}");

        let err = relocate_member(&store, &f.id, &a, &b).unwrap_err();
        assert!(err.contains("already a member"), "{err}");

        // Neither refusal wrote anything.
        let now = list_topics(&store).remove(0);
        assert_eq!(now.members[0].repo_path, a);
        assert_eq!(now.members[0].state, MemberState::Present);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn relocate_lands_a_moved_plain_repo_on_present_in_one_step() {
        // What Locate is for. The whole repo folder was renamed outside Tori, so
        // the member reads RepoMissing and its worktree, which travelled inside
        // the folder, is at a path nobody recorded and has a gitdir pointer to a
        // directory that is gone.
        let tmp = unique_tmp();
        let old = tmp.join("api");
        let old_s = repo(&old);
        let store = Store::at(tmp.join("topics.json"));
        let f = create_topic(&store, "X", "feat/x", std::slice::from_ref(&old_s), &|_| {}).unwrap();
        let old_wt = f.members[0].worktree_path.clone().unwrap();
        assert!(old_wt.starts_with(&old_s), "the plain layout puts it inside the repo");

        let new = tmp.join("moved-api");
        std::fs::rename(&old, &new).unwrap();
        let new_s = new.to_string_lossy().into_owned();
        assert_eq!(list_topics(&store)[0].members[0].state, MemberState::RepoMissing);

        let fixed = relocate_member(&store, &f.id, &old_s, &new_s).unwrap();
        assert_eq!(fixed.members[0].repo_path, new_s);
        assert_eq!(
            fixed.members[0].worktree_path.as_deref(),
            Some(format!("{new_s}/.tori/worktrees/x").as_str())
        );
        assert_eq!(fixed.members[0].state, MemberState::Present, "one step, no Recreate");
        assert_eq!(list_topics(&store)[0].members[0].state, MemberState::Present);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn relocate_leaves_a_worktree_that_lives_outside_the_repo_alone() {
        // The adopted case: the worktree was never inside the repo folder, so it
        // did not travel with it and its recorded path is still true.
        let tmp = unique_tmp();
        let old = tmp.join("api");
        let old_s = repo(&old);
        let wt = tmp.join("elsewhere");
        let wt_s = wt.to_string_lossy().into_owned();
        git(&old, &["worktree", "add", "-q", "-b", "feat/x", &wt_s]);
        let store = Store::at(tmp.join("topics.json"));
        let f = create_topic(&store, "X", "feat/x", std::slice::from_ref(&old_s), &|_| {}).unwrap();
        assert_eq!(f.members[0].worktree_path.as_deref(), Some(wt_s.as_str()), "adopted");

        let new = tmp.join("moved-api");
        std::fs::rename(&old, &new).unwrap();
        let new_s = new.to_string_lossy().into_owned();

        let fixed = relocate_member(&store, &f.id, &old_s, &new_s).unwrap();
        assert_eq!(fixed.members[0].repo_path, new_s);
        assert_eq!(
            fixed.members[0].worktree_path.as_deref(),
            Some(wt_s.as_str()),
            "untouched"
        );
        assert_eq!(fixed.members[0].state, MemberState::Present);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn on_step_sees_the_record_once_per_write() {
        use std::cell::RefCell;
        let tmp = unique_tmp();
        let a = repo(&tmp.join("a"));
        let b = repo(&tmp.join("b"));
        let store = Store::at(tmp.join("topics.json"));
        let seen = RefCell::new(Vec::<Vec<MemberState>>::new());
        let record = |f: &Topic| {
            seen.borrow_mut()
                .push(f.members.iter().map(|m| m.state.clone()).collect())
        };

        let f = create_topic(&store, "X", "feat/x", &[a, b], &record).unwrap();
        let pending = MemberState::Failed { reason: PENDING.into() };
        assert_eq!(
            *seen.borrow(),
            vec![
                vec![pending.clone(), pending.clone()],
                vec![MemberState::Present, pending.clone()],
                vec![MemberState::Present, MemberState::Present],
            ]
        );

        seen.borrow_mut().clear();
        let c = repo(&tmp.join("c"));
        add_member(&store, &f.id, &c, &record).unwrap();
        assert_eq!(seen.borrow().len(), 2);
        assert_eq!(seen.borrow()[0][2], pending);
        assert_eq!(seen.borrow()[1][2], MemberState::Present);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn reorder_rename_and_delete_touch_only_the_record() {
        let tmp = unique_tmp();
        let store = store_with(
            &tmp,
            vec![topic(
                "f",
                vec![
                    Member {
                        order: 0,
                        ..member("/r/a", None, MemberState::WorktreeMissing)
                    },
                    Member {
                        order: 1,
                        ..member("/r/b", None, MemberState::WorktreeMissing)
                    },
                    Member {
                        order: 2,
                        ..member("/r/c", None, MemberState::WorktreeMissing)
                    },
                ],
            )],
        );

        reorder_members(&store, "f", &["/r/c".to_string()]).unwrap();
        let members = store.load().topics[0].members.clone();
        assert_eq!(
            members.iter().map(|m| m.repo_path.as_str()).collect::<Vec<_>>(),
            ["/r/c", "/r/a", "/r/b"]
        );
        assert_eq!(members.iter().map(|m| m.order).collect::<Vec<_>>(), [0, 1, 2]);

        rename_member(&store, "f", "/r/a", " Backend ").unwrap();
        assert_eq!(store.load().topics[0].members[1].display_name, "Backend");
        assert!(rename_member(&store, "f", "/r/a", "  ").is_err());

        rename_topic(&store, "f", "Auth v2").unwrap();
        let f = store.load().topics[0].clone();
        assert_eq!(f.name, "Auth v2");
        assert_eq!(f.branch, "feat/f", "the branch is frozen");

        assert!(delete_topic(&store, "nope").is_err());
        delete_topic(&store, "f").unwrap();
        assert!(store.load().topics.is_empty());
        std::fs::remove_dir_all(&tmp).ok();
    }

    fn container(tmp: &Path, name: &str) -> String {
        let src = tmp.join(format!("{name}-src"));
        repo(&src);
        let cont = tmp.join(name);
        std::fs::create_dir_all(&cont).unwrap();
        let out = crate::platform::process::command("git")
            .args([
                "clone",
                "-q",
                "--bare",
                src.to_str().unwrap(),
                cont.join(".bare").to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
        cont.to_string_lossy().into_owned()
    }

    fn git_out(dir: &str, args: &[&str]) -> String {
        let out = crate::platform::process::command("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn a_record_from_before_modes_loads_as_worktree_members() {
        let tmp = unique_tmp();
        let store = Store::at(tmp.join("topics.json"));
        std::fs::write(
            &store.path,
            r#"{"topics":[{"id":"f","name":"f","branch":"feat/f","members":[{"repoPath":"/r/a","worktreePath":"/r/a/.tori/worktrees/f","state":{"kind":"present"}}]}]}"#,
        )
        .unwrap();
        let m = &store.load().topics[0].members[0];
        assert_eq!(m.mode, MemberMode::Worktree);
        assert_eq!(m.checkout, None);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_reference_reconciles_present_on_the_repos_own_checkout() {
        let tmp = unique_tmp();
        let a = repo(&tmp.join("a"));
        let store = Store::at(tmp.join("topics.json"));
        let branches = git_out(&a, &["branch", "--list"]);
        let worktrees = git_out(&a, &["worktree", "list"]);

        let members = [NewMember {
            repo_path: a.clone(),
            mode: MemberMode::Reference,
        }];
        let t = create_topic_with(&store, "X", "feat/x", &members, &|_| {}).unwrap();
        let m = &t.members[0];
        assert_eq!(m.state, MemberState::Present);
        assert_eq!(m.worktree_path, None, "a reference never records a worktree");
        let checkout = m.checkout.as_ref().expect("a reference records where it reads");
        assert_eq!(checkout.path, a);
        assert!(checkout.branch.is_some());
        assert_eq!(member_root(m), Some(a.as_str()));

        assert_eq!(git_out(&a, &["branch", "--list"]), branches, "no branch is created");
        assert_eq!(git_out(&a, &["worktree", "list"]), worktrees, "no worktree is created");
        assert!(!tmp.join("a/.tori").exists());

        let listed = list_topics(&store);
        assert_eq!(listed[0].members[0].state, MemberState::Present);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_container_without_its_default_checkout_is_named_and_retry_checks_it_out() {
        let tmp = unique_tmp();
        let cont = container(&tmp, "cont");
        let store = Store::at(tmp.join("topics.json"));

        let worktrees = git_out(&cont, &["worktree", "list"]);
        let members = [NewMember {
            repo_path: cont.clone(),
            mode: MemberMode::Reference,
        }];
        let t = create_topic_with(&store, "X", "feat/x", &members, &|_| {}).unwrap();
        assert_eq!(t.members[0].state, MemberState::CheckoutMissing);
        assert_eq!(
            git_out(&cont, &["worktree", "list"]),
            worktrees,
            "attaching writes nothing"
        );
        assert_eq!(member_root(&list_topics(&store)[0].members[0]), None);

        let t = retry_member(&store, &t.id, &cont).unwrap();
        assert_eq!(t.members[0].state, MemberState::Present);
        let checkout = t.members[0].checkout.as_ref().unwrap();
        assert!(Path::new(&checkout.path).is_dir());
        assert_eq!(t.members[0].worktree_path, None);
        std::fs::remove_dir_all(&tmp).ok();
    }

    fn cloned(tmp: &Path, name: &str) -> (String, String) {
        let src = repo(&tmp.join(format!("{name}-src")));
        let clone = tmp.join(name);
        let out = crate::platform::process::command("git")
            .args(["clone", "-q", &src, clone.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(out.status.success());
        git(&clone, &["config", "user.email", "t@t"]);
        git(&clone, &["config", "user.name", "t"]);
        (src, clone.to_string_lossy().into_owned())
    }

    fn reference_topic(store: &Store, repo: &str) -> Topic {
        let members = [NewMember {
            repo_path: repo.to_string(),
            mode: MemberMode::Reference,
        }];
        create_topic_with(store, "X", "feat/x", &members, &|_| {}).unwrap()
    }

    fn commit(dir: &str, file: &str) -> String {
        std::fs::write(Path::new(dir).join(file), file).unwrap();
        git(Path::new(dir), &["add", "."]);
        git(Path::new(dir), &["commit", "-qm", file]);
        git_out(dir, &["rev-parse", "HEAD"])
    }

    #[test]
    fn the_promotion_policy_round_trips_and_defaults_to_ask() {
        let tmp = unique_tmp();
        let (_, a) = cloned(&tmp, "a");
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);
        assert_eq!(t.promotion, Promotion::Ask);
        set_promotion(&store, &t.id, Promotion::Never).unwrap();
        assert_eq!(recorded(&store)[0].promotion, Promotion::Never);
        assert!(std::fs::read_to_string(store.path())
            .unwrap()
            .contains("\"promotion\": \"never\""));
    }

    #[test]
    fn a_chat_asking_for_a_worktree_gets_what_the_policy_says() {
        let tmp = unique_tmp();
        let (_, a) = cloned(&tmp, "a");
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);
        let web = member_named(&t, &a).unwrap().clone();
        let run = |promotion, answer: bool| {
            let asked = std::cell::Cell::new(false);
            let promoted = std::cell::Cell::new(false);
            let out = promote_for_chat(
                &Topic { promotion, ..t.clone() },
                &web,
                |_| {
                    asked.set(true);
                    Ok(answer)
                },
                || {
                    promoted.set(true);
                    Ok(t.clone())
                },
            );
            (out.is_ok(), asked.get(), promoted.get())
        };
        assert_eq!(run(Promotion::Ask, true), (true, true, true));
        assert_eq!(run(Promotion::Ask, false), (false, true, false));
        assert_eq!(run(Promotion::Auto, false), (true, false, true));
        assert_eq!(run(Promotion::Never, true), (false, false, false));
    }

    #[test]
    fn promote_branches_from_origins_default_not_the_local_checkout() {
        let tmp = unique_tmp();
        let (_, a) = cloned(&tmp, "a");
        commit(&a, "local-only.txt");
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);

        let t = promote_member(&store, &t.id, &a).unwrap();
        let m = &t.members[0];
        assert_eq!(m.mode, MemberMode::Worktree);
        assert_eq!(m.state, MemberState::Present);
        assert_eq!(m.checkout, None);
        let wt = m.worktree_path.as_deref().unwrap();
        assert_eq!(
            git_out(wt, &["rev-parse", "HEAD"]),
            git_out(&a, &["rev-parse", "origin/HEAD"])
        );
        assert_eq!(member_root(m), Some(wt));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn promote_tracks_a_topic_branch_that_already_exists_on_origin() {
        let tmp = unique_tmp();
        let (src, a) = cloned(&tmp, "a");
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);
        // Pushed after the clone, so only the fetch promote runs can see it.
        git(Path::new(&src), &["checkout", "-qb", "feat/x"]);
        let pushed = commit(&src, "remote.txt");

        let t = promote_member(&store, &t.id, &a).unwrap();
        let wt = t.members[0].worktree_path.clone().unwrap();
        assert_eq!(git_out(&wt, &["rev-parse", "HEAD"]), pushed);
        assert_eq!(
            git_out(&wt, &["rev-parse", "--abbrev-ref", "feat/x@{u}"]).trim(),
            "origin/feat/x"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn promote_refuses_a_topic_branch_checked_out_in_place_and_stays_a_reference() {
        let tmp = unique_tmp();
        let (_, a) = cloned(&tmp, "a");
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);
        git(Path::new(&a), &["checkout", "-qb", "feat/x"]);
        let worktrees = git_out(&a, &["worktree", "list"]);

        let err = promote_member(&store, &t.id, &a).unwrap_err();
        assert!(err.contains("checked out in place"), "{err}");
        assert_eq!(git_out(&a, &["worktree", "list"]), worktrees);
        let m = &list_topics(&store)[0].members[0];
        assert_eq!(m.mode, MemberMode::Reference);
        assert_eq!(m.worktree_path, None);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn demote_keeps_the_branch_so_promote_picks_the_work_back_up() {
        let tmp = unique_tmp();
        let (_, a) = cloned(&tmp, "a");
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);
        let t = promote_member(&store, &t.id, &a).unwrap();
        let wt = t.members[0].worktree_path.clone().unwrap();
        let work = commit(&wt, "work.txt");

        let t = demote_member(&store, &t.id, &a, false).unwrap();
        let m = &t.members[0];
        assert_eq!(m.mode, MemberMode::Reference);
        assert_eq!(m.state, MemberState::Present);
        assert_eq!(m.worktree_path, None);
        assert_eq!(m.checkout.as_ref().map(|c| c.path.as_str()), Some(a.as_str()));
        assert!(!Path::new(&wt).exists());
        assert_eq!(git_out(&a, &["rev-parse", "feat/x"]), work);

        let t = promote_member(&store, &t.id, &a).unwrap();
        let wt = t.members[0].worktree_path.clone().unwrap();
        assert_eq!(git_out(&wt, &["rev-parse", "HEAD"]), work);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_worktree_made_outside_promote_on_the_topic_branch_is_adopted_and_no_other_is() {
        let tmp = unique_tmp();
        let (_, a) = cloned(&tmp, "a");
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);
        let other = tmp.join("other").to_string_lossy().into_owned();
        git(Path::new(&a), &["worktree", "add", "-q", "-b", "feat/y", &other]);
        assert!(list_and_adopt(&store).1.is_empty(), "another branch is not the Topic's");

        let made = tmp.join("made").to_string_lossy().into_owned();
        git(Path::new(&a), &["worktree", "add", "-q", "-b", "feat/x", &made]);
        assert!(
            list_topics(&store)
                .iter()
                .all(|x| x.members[0].mode == MemberMode::Reference),
            "a plain read adopts nothing"
        );
        let (topics, adopted) = list_and_adopt(&store);
        assert_eq!(adopted.len(), 1);
        assert_eq!(
            (adopted[0].from.as_deref(), adopted[0].to.as_str()),
            (Some(a.as_str()), made.as_str())
        );
        let m = &topics.into_iter().find(|x| x.id == t.id).unwrap().members[0];
        assert_eq!(
            (m.mode, m.worktree_path.as_deref(), &m.state),
            (MemberMode::Worktree, Some(made.as_str()), &MemberState::Present)
        );
        assert!(list_and_adopt(&store).1.is_empty(), "adopted once");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn the_home_note_follows_every_record_change_and_goes_with_the_topic() {
        let tmp = unique_tmp();
        let (_, a) = cloned(&tmp, "a");
        let b = repo(&tmp.join("b"));
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);
        let home = crate::topic_home::home_dir(&store.path, &t.id);
        assert_eq!(t.home.as_deref(), Some(home.to_string_lossy().as_ref()));
        let note = || std::fs::read_to_string(home.join(crate::topic_home::NOTE)).unwrap();
        assert!(
            note().contains(&format!("a (reference, read only): `{a}`")),
            "{}",
            note()
        );

        add_member_as(&store, &t.id, &b, MemberMode::Reference, &|_| {}).unwrap();
        assert!(note().contains(&format!("`{b}`")));

        let wt = promote_member(&store, &t.id, &a).unwrap().members[0]
            .worktree_path
            .clone()
            .unwrap();
        assert!(note().contains(&format!("a (worktree): `{wt}`")), "{}", note());

        demote_member(&store, &t.id, &a, false).unwrap();
        assert!(!note().contains(&wt));
        assert!(note().contains(&format!("a (reference, read only): `{a}`")));

        remove_member(&store, &t.id, &b).unwrap();
        assert!(!note().contains(&format!("`{b}`")));
        assert!(
            !std::fs::read_to_string(&store.path).unwrap().contains("\"home\""),
            "the home is never stored"
        );

        delete_topic(&store, &t.id).unwrap();
        assert!(!home.exists());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_live_home_chat_is_granted_a_new_worktree_and_told_every_change_once() {
        use std::cell::RefCell;
        let tmp = unique_tmp();
        let (_, a) = cloned(&tmp, "a");
        let store = Store::at(tmp.join("topics.json"));
        let t = reference_topic(&store, &a);
        let home = t.home.clone().unwrap();
        let before = crate::topic_home::told(&load_topic(&store, &t.id).unwrap());

        let topic = promote_member(&store, &t.id, &a).unwrap();
        let wt = topic.members[0].worktree_path.clone().unwrap();
        let (grants, notes) = (RefCell::new(Vec::new()), RefCell::new(Vec::new()));
        let live = [("home-chat".to_string(), home), ("member-chat".to_string(), a.clone())];
        crate::topic_home::tell_home_chats(
            &before,
            &topic,
            &live,
            |s, dirs| {
                grants.borrow_mut().push((s.to_string(), dirs.to_vec()));
                Ok(())
            },
            |s, text| {
                notes.borrow_mut().push((s.to_string(), text.to_string()));
                Ok(())
            },
        );
        assert_eq!(grants.into_inner(), vec![("home-chat".to_string(), vec![wt.clone()])]);
        let notes = notes.into_inner();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].0, "home-chat");
        assert!(notes[0].1.contains(&wt), "{}", notes[0].1);

        let before = crate::topic_home::told(&topic);
        let topic = demote_member(&store, &t.id, &a, false).unwrap();
        let notes = RefCell::new(Vec::new());
        crate::topic_home::tell_home_chats(
            &before,
            &topic,
            &live,
            |_, _| Ok(()),
            |s, text| {
                notes.borrow_mut().push((s.to_string(), text.to_string()));
                Ok(())
            },
        );
        let notes = notes.into_inner();
        assert_eq!(notes.len(), 1, "a demote is told");
        assert!(
            notes[0].1.contains(&format!("(reference, read only): `{a}`")) && !notes[0].1.contains(&wt),
            "{}",
            notes[0].1
        );

        let before = crate::topic_home::told(&topic);
        let told = RefCell::new(0);
        crate::topic_home::tell_home_chats(
            &before,
            &topic,
            &live,
            |_, _| Ok(()),
            |_, _| {
                *told.borrow_mut() += 1;
                Ok(())
            },
        );
        assert_eq!(told.into_inner(), 0, "nothing changed, nothing told");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
