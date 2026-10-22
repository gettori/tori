//! The autopilot's queue, kept under `~/.config/tori/autopilot/` so a restart
//! hands back the same items. Only what a model decided is stored: whether an
//! item's session is live and whether its worktree is still there are derived
//! on every read, so a relaunch can never rewrite a state. See
//! [[adr_autopilot_is_a_session_not_a_state_machine]].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::forge::model::PrState;
use crate::issues::{canonical_key, FailedSource, IssueKind, IssueQuery, IssueRef, SourceList};
use crate::owned_state::{now_ms, write_atomically};
use crate::rpc::events::same_folder;
use crate::settings::{PrEvent, PrRule};

pub mod schedules;
pub use schedules::{Schedule, ScheduleRow, What};

const QUEUE: &str = "queue.json";
const PROJECTS: &str = "projects.json";
const LOG: &str = "log.jsonl";
const SCHEDULES: &str = "schedules.json";
const RULES: &str = "rules.json";
const HOUR_MS: u64 = 3_600_000;
const PR_STATES_TTL: Duration = Duration::from_secs(30);
const CLOSED_NOTE: &str = "its pull request was closed without merging";
const CLOSED_BY_HAND: &str = "closed by hand";
const GONE_UPSTREAM: &str = "no longer assigned or open upstream";
const LEFT_SOURCE: &str = "no longer matches its issue source";
const REVIEW_CLEARED: &str = "review request cleared (reviewed or withdrawn)";
const SCHEDULE_REMOVED: &str = "schedule removed";
const PAUSE_AFTER: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Take an issue to a pull request, or to a local branch.
    Ship,
    /// Review someone's pull request.
    Review,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Source {
    /// An issue, by the key its issue source gives it.
    Issue { key: String, project: String },
    /// A pull request, by number, in `owner/name`.
    Pr { number: u64, repo: String },
    /// A schedule's run, with the issue it works on when the schedule names one.
    Schedule {
        schedule: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        issue: Option<String>,
    },
    /// A project rule's firing on a watched pull request, in `owner/name`.
    Rule {
        pr: u64,
        repo: String,
        event: crate::settings::PrEvent,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Proposed,
    Queued,
    Running,
    WaitingOnYou,
    TakenOver,
    Done,
    Failed,
}

impl State {
    pub fn terminal(self) -> bool {
        matches!(self, State::Done | State::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub source: Source,
    pub project: String,
    pub state: State,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub pr_url: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    pub created: u64,
    pub updated: u64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub contract: Option<String>,
    // Only this account's list may close it: another login's `@me` is someone else.
    #[serde(default)]
    pub picked_by: Option<String>,
    // A reassign brings back only an item that left the list, never one declined.
    #[serde(default)]
    pub gone_upstream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picked_from: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fix_pushes: Vec<FixPush>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixPush {
    pub sha: String,
    pub at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Queue {
    #[serde(default)]
    items: Vec<Item>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Ships {
    /// Open a pull request.
    #[default]
    Pr,
    /// Leave the work on a local branch.
    Local,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Autonomy {
    /// Ask the user before each step.
    #[default]
    AskEverything,
    /// Go ahead alone until something would leave this machine.
    AutoUntilOutward,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Pickup {
    /// Propose new work and wait for a yes.
    #[default]
    Ask,
    /// Queue new work without asking.
    Auto,
}

// A field missing from the file reads as its default, so a contract written
// before a field existed still loads, and the defaults are the cautious ones.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Contract {
    pub ships: Ships,
    pub autonomy: Autonomy,
    pub pickup: Pickup,
    pub agent: Option<String>,
    pub account: Option<String>,
    pub model: Option<String>,
    pub issues: Vec<IssueQuery>,
}

#[derive(Default, Serialize, Deserialize)]
struct Projects {
    #[serde(default)]
    projects: BTreeMap<String, Contract>,
}

#[derive(Debug, Default, Clone)]
pub struct ContractPatch {
    pub ships: Option<Ships>,
    pub autonomy: Option<Autonomy>,
    pub pickup: Option<Pickup>,
    pub agent: Option<String>,
    pub account: Option<String>,
    pub model: Option<String>,
    pub issues: Option<Vec<IssueQuery>>,
}

pub enum Target {
    Id(String),
    // Matched among open items only, so a retry after a crash finds the item it made.
    // `origin` is the project's `owner/name`, which an issue key's spellings are read against.
    Key {
        kind: Kind,
        source: Source,
        project: String,
        origin: String,
    },
}

#[derive(Debug, Default, Clone)]
pub struct Patch {
    pub state: Option<State>,
    pub worktree: Option<String>,
    pub session: Option<String>,
    pub pr_url: Option<String>,
    pub url: Option<String>,
    pub note: Option<String>,
    pub title: Option<String>,
    pub contract: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum UpdateError {
    NoItem(String),
    NoSchedule(String),
    Write(String),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UpdateError::NoItem(id) => write!(f, "no autopilot item {id}"),
            UpdateError::NoSchedule(id) => write!(f, "no autopilot schedule {id}"),
            UpdateError::Write(e) => write!(f, "the autopilot queue was not saved: {e}"),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub items: Vec<Row>,
    pub projects: BTreeMap<String, Contract>,
}

// `session_live` is left out when the item has no session, `worktree_gone`
// when it has no worktree or git could not be read.
// `overlaps` and `base_conflicts` are left out while the conflict radar is off,
// and `base_conflicts` also for an item with no worktree or an unknown answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    #[serde(flatten)]
    pub item: Item,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_live: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_gone: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overlaps: Option<Vec<RowOverlap>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_conflicts: Option<Vec<String>>,
    pub reference: Reference,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct RowOverlap {
    pub file: String,
    pub other_session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_item: Option<String>,
    pub other_branch: Option<String>,
}

/// How an item is named to a person: `#212 (personal -> tori -> y-test)`, the
/// number opening the forge and the place opening Tori at `target`. `place` is
/// empty for a folder outside every space, and `markdown` is the whole of it
/// for the autopilot to paste.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Reference {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<Link>,
    pub place: Vec<String>,
    pub target: NavTarget,
    pub markdown: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Link {
    pub label: String,
    pub url: String,
}

/// Where Tori takes the user: a folder, a session, or both; mirrors `NavTarget` in the frontend's events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NavTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

// A worktree git lists, with its branch; `None` for a detached head.
pub type Listed = (PathBuf, Option<String>);

#[derive(Debug, Default)]
pub struct Observed {
    pub live: HashSet<String>,
    // `None` while the conflict radar is off.
    pub radar: Option<crate::radar::View>,
    // Project -> the worktrees git lists for it; `None` where git could not be read.
    pub worktrees: HashMap<String, Option<Vec<Listed>>>,
    // Project -> the states its origin gave, by (`owner/name`, number); absent where the forge failed.
    pub prs: HashMap<String, HashMap<PrKey, PrState>>,
}

fn apply(
    items: &mut Vec<Item>,
    target: Target,
    patch: Patch,
    now: u64,
    mint: impl FnOnce() -> String,
) -> Result<Item, UpdateError> {
    let at = match target {
        Target::Id(id) => items.iter().position(|i| i.id == id).ok_or(UpdateError::NoItem(id))?,
        Target::Key {
            kind,
            source,
            project,
            origin,
        } => {
            let source = match source {
                Source::Issue { key, project } => Source::Issue {
                    key: canonical_key(&key, &origin),
                    project,
                },
                pr => pr,
            };
            let open = items.iter().position(|i| {
                !i.state.terminal()
                    && i.kind == kind
                    && same_source(&i.source, &source, &origin)
                    && same_folder(&i.project, &project)
            });
            match open {
                Some(at) => at,
                None => {
                    items.push(Item {
                        id: mint(),
                        kind,
                        source,
                        project,
                        state: State::Proposed,
                        worktree: None,
                        session: None,
                        pr_url: None,
                        url: None,
                        created: now,
                        updated: now,
                        note: None,
                        title: None,
                        contract: None,
                        picked_by: None,
                        gone_upstream: false,
                        picked_from: None,
                        fix_pushes: Vec::new(),
                    });
                    items.len() - 1
                }
            }
        }
    };
    let item = &mut items[at];
    item.state = patch.state.unwrap_or(item.state);
    for (field, value) in [
        (&mut item.worktree, patch.worktree),
        (&mut item.session, patch.session),
        (&mut item.pr_url, patch.pr_url),
        (&mut item.url, patch.url),
        (&mut item.note, patch.note),
        (&mut item.title, patch.title),
        (&mut item.contract, patch.contract),
    ] {
        if value.is_some() {
            *field = value;
        }
    }
    item.updated = now;
    Ok(item.clone())
}

fn set_contract(
    projects: &mut BTreeMap<String, Contract>,
    project: String,
    patch: ContractPatch,
) -> (String, Contract) {
    let key = projects
        .keys()
        .find(|known| same_folder(known, &project))
        .cloned()
        .unwrap_or(project);
    let contract = projects.entry(key.clone()).or_default();
    contract.ships = patch.ships.unwrap_or(contract.ships);
    contract.autonomy = patch.autonomy.unwrap_or(contract.autonomy);
    contract.pickup = patch.pickup.unwrap_or(contract.pickup);
    if let Some(issues) = patch.issues {
        contract.issues = issues;
    }
    for (field, value) in [
        (&mut contract.agent, patch.agent),
        (&mut contract.account, patch.account),
        (&mut contract.model, patch.model),
    ] {
        if value.is_some() {
            *field = value;
        }
    }
    (key, contract.clone())
}

// (`owner/name` lowercased, number): a number alone would match another repo's PR.
pub type PrKey = (String, u64);

fn pr_key(item: &Item) -> Option<PrKey> {
    if let Source::Pr { number, repo } | Source::Rule { pr: number, repo, .. } = &item.source {
        return Some((repo.to_lowercase(), *number));
    }
    pr_key_of_url(item.pr_url.as_deref()?)
}

fn reserve_fix_push(items: &mut [Item], key: &PrKey, max_attempts: u32, sha: &str, now: u64) -> Result<Item, String> {
    let item = items
        .iter_mut()
        .find(|i| i.kind == Kind::Ship && !i.state.terminal() && pr_key(i).as_ref() == Some(key))
        .ok_or("no open autopilot ship item holds this pull request")?;
    if item.fix_pushes.len() >= max_attempts as usize {
        return Err(format!("item {} has used its {max_attempts} fix attempts", item.id));
    }
    item.fix_pushes.push(FixPush {
        sha: sha.into(),
        at: now,
    });
    item.updated = now;
    Ok(item.clone())
}

// A GitHub `/pull/N` or GitLab `/-/merge_requests/N` URL.
fn pr_key_of_url(url: &str) -> Option<PrKey> {
    let url = url.trim_end_matches('/');
    let (rest, number) = url.rsplit_once('/')?;
    let repo_url = rest
        .strip_suffix("/pull")
        .or_else(|| rest.strip_suffix("/-/merge_requests"))?;
    let (_host, repo) = repo_url
        .split_once("://")
        .map_or(repo_url, |(_, path)| path)
        .split_once('/')?;
    Some((repo.to_lowercase(), number.parse().ok()?))
}

// A person closing a worker ends its item, unless the work already left it: an
// open pull request or a pending approval is what the merge or the answer closes.
fn fail_closed_by_hand(items: &mut [Item], session: &str, held: &HashSet<String>, now: u64) -> Vec<Item> {
    let mut changed = Vec::new();
    for item in items
        .iter_mut()
        .filter(|i| matches!(i.state, State::Running | State::WaitingOnYou))
    {
        if item.session.as_deref() != Some(session) || item.pr_url.is_some() || held.contains(&item.id) {
            continue;
        }
        item.state = State::Failed;
        item.note = Some(CLOSED_BY_HAND.to_string());
        item.updated = now;
        changed.push(item.clone());
    }
    changed
}

pub fn paused_by<'a>(schedule: &Schedule, items: &'a [Item]) -> Option<&'a Item> {
    let since = schedule.resumed_at.unwrap_or(0);
    let mut runs: Vec<&Item> = items
        .iter()
        .filter(|i| {
            i.created > since && matches!(&i.source, Source::Schedule { schedule: id, .. } if *id == schedule.id)
        })
        .collect();
    runs.sort_by_key(|i| i.created);
    let last = &runs[runs.len().checked_sub(PAUSE_AFTER)?..];
    last.iter()
        .all(|i| i.state == State::Failed)
        .then(|| last[PAUSE_AFTER - 1])
}

fn schedule_row(schedule: &Schedule, items: &[Item], now: u64) -> ScheduleRow {
    schedules::row(schedule, now, &chrono::Local, paused_by(schedule, items).is_some())
}

#[derive(Debug, Default)]
pub struct Fired {
    pub queued: Vec<Item>,
    pub paused: Vec<Item>,
}

#[derive(Debug, Default)]
pub struct Firings {
    pub queued: Vec<Item>,
    pub noted: Vec<Item>,
    pub skipped: Vec<(String, String)>,
}

fn holds_work(item: &Item, schedule: &Schedule) -> bool {
    if item.state.terminal() || !same_folder(&item.project, &schedule.project) {
        return false;
    }
    match (&item.source, &schedule.what) {
        (Source::Schedule { schedule: id, .. }, _) if *id == schedule.id => true,
        (Source::Schedule { issue: Some(held), .. }, What::Issue { key })
        | (Source::Issue { key: held, .. }, What::Issue { key }) => held.eq_ignore_ascii_case(key),
        _ => false,
    }
}

pub fn plan_firings<Tz: chrono::TimeZone>(
    schedules: &mut [Schedule],
    items: &mut Vec<Item>,
    now: u64,
    tz: &Tz,
    mut mint: impl FnMut() -> String,
) -> Firings {
    let mut firings = Firings::default();
    for schedule in schedules.iter_mut() {
        let Some(slot) = schedules::due(schedule, now, tz) else {
            continue;
        };
        schedule.last_slot = Some(slot);
        if paused_by(schedule, items).is_some() {
            continue;
        }
        if let Some(open) = items.iter_mut().find(|i| holds_work(i, schedule)) {
            firings.skipped.push((schedule.id.clone(), open.id.clone()));
            let note = format!("skipped a run of {} while this one is open", schedule.name);
            if open.note.as_deref() != Some(note.as_str()) {
                open.note = Some(note);
                open.updated = now;
                firings.noted.push(open.clone());
            }
            continue;
        }
        let (issue, contract) = match &schedule.what {
            What::Prompt { text } => (None, text.clone()),
            What::Issue { key } => (Some(key.clone()), format!("Work on issue {key}.")),
        };
        let item = Item {
            id: mint(),
            kind: Kind::Ship,
            source: Source::Schedule {
                schedule: schedule.id.clone(),
                issue,
            },
            project: schedule.project.clone(),
            state: State::Queued,
            worktree: None,
            session: None,
            pr_url: None,
            url: None,
            created: now,
            updated: now,
            note: None,
            title: Some(schedule.name.clone()),
            contract: Some(contract),
            picked_by: None,
            gone_upstream: false,
            picked_from: None,
            fix_pushes: Vec::new(),
        };
        items.push(item.clone());
        firings.queued.push(item);
    }
    firings
}

// Pickup's rule for a removed source: running work is never closed under the worker.
fn drop_schedule_runs(items: &mut [Item], schedule: &str, now: u64) -> Vec<Item> {
    let mut changed = Vec::new();
    for item in items
        .iter_mut()
        .filter(|i| !i.state.terminal() && matches!(&i.source, Source::Schedule { schedule: s, .. } if s == schedule))
    {
        if matches!(item.state, State::Proposed | State::Queued) {
            item.state = State::Failed;
        } else if item.note.as_deref() == Some(SCHEDULE_REMOVED) {
            continue;
        }
        item.note = Some(SCHEDULE_REMOVED.to_string());
        item.updated = now;
        changed.push(item.clone());
    }
    changed
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuleHit {
    pub session: String,
    pub project: String,
    pub url: String,
    pub repo: String,
    pub pr: u64,
    pub event: PrEvent,
    pub max_per_hour: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Rules {
    #[serde(default)]
    resumed: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuleRow {
    pub project: String,
    pub on: Vec<PrEvent>,
    pub max_per_hour: u32,
    pub fired_this_hour: usize,
    pub paused: bool,
}

pub fn rule_rows(rules: &HashMap<String, PrRule>, items: &[Item], resumed: &Rules, now: u64) -> Vec<RuleRow> {
    let mut rows: Vec<RuleRow> = rules
        .iter()
        .filter(|(_, rule)| !rule.on.is_empty())
        .map(|(project, rule)| {
            let resumed_at = in_project(&resumed.resumed, project).copied();
            let since = now.saturating_sub(HOUR_MS).max(resumed_at.unwrap_or(0));
            let fired_this_hour = items
                .iter()
                .filter(|i| {
                    same_folder(&i.project, project) && matches!(i.source, Source::Rule { .. }) && i.created > since
                })
                .count();
            RuleRow {
                project: project.clone(),
                on: rule.on.clone(),
                max_per_hour: rule.max_per_hour,
                fired_this_hour,
                paused: rule_paused(project, rule.max_per_hour, items, resumed_at),
            }
        })
        .collect();
    rows.sort_by(|a, b| a.project.cmp(&b.project));
    rows
}

#[derive(Debug, Default)]
pub struct RuleFirings {
    pub filed: Vec<Item>,
    /// (session, url, item id) of each watch whose pull request an open item now holds.
    pub handed: Vec<(String, String, String)>,
}

fn in_project<'a, T>(map: &'a BTreeMap<String, T>, project: &str) -> Option<&'a T> {
    map.iter()
        .find(|(known, _)| same_folder(known, project))
        .map(|(_, v)| v)
}

// Paused once `max` firings since the last resume fell inside one hour, and
// stays so until a person resumes it.
pub fn rule_paused(project: &str, max_per_hour: u32, items: &[Item], resumed_at: Option<u64>) -> bool {
    let since = resumed_at.unwrap_or(0);
    let mut fired: Vec<u64> = items
        .iter()
        .filter(|i| same_folder(&i.project, project) && matches!(i.source, Source::Rule { .. }) && i.created > since)
        .map(|i| i.created)
        .collect();
    fired.sort_unstable();
    let max = (max_per_hour as usize).max(1);
    fired.windows(max).any(|w| w[max - 1] - w[0] < HOUR_MS)
}

fn rule_work(event: PrEvent, url: &str) -> (String, String) {
    match event {
        PrEvent::ChangesRequested => (
            "Changes requested".into(),
            format!("A review requested changes on {url}. Address the review on the pull request's own branch."),
        ),
        PrEvent::CheckFailed => (
            "Check failed".into(),
            format!("A check failed on {url}. Fix it on the pull request's own branch."),
        ),
        PrEvent::Conflicting => (
            "Conflicts with its base".into(),
            format!(
                "{url} now conflicts with its base. Bring the base in and resolve it on the pull request's own branch."
            ),
        ),
    }
}

pub fn plan_rule_firings(
    hits: &[RuleHit],
    items: &mut Vec<Item>,
    projects: &BTreeMap<String, Contract>,
    rules: &Rules,
    now: u64,
    mut mint: impl FnMut() -> String,
) -> RuleFirings {
    let mut firings = RuleFirings::default();
    for hit in hits {
        let Some(contract) = in_project(projects, &hit.project) else {
            continue;
        };
        let key = (hit.repo.to_lowercase(), hit.pr);
        if let Some(open) = items
            .iter()
            .find(|i| !i.state.terminal() && pr_key(i).as_ref() == Some(&key))
        {
            firings
                .handed
                .push((hit.session.clone(), hit.url.clone(), open.id.clone()));
            continue;
        }
        let resumed_at = in_project(&rules.resumed, &hit.project).copied();
        if rule_paused(&hit.project, hit.max_per_hour, items, resumed_at) {
            continue;
        }
        let (what, task) = rule_work(hit.event, &hit.url);
        let item = Item {
            id: mint(),
            kind: Kind::Ship,
            source: Source::Rule {
                pr: hit.pr,
                repo: hit.repo.clone(),
                event: hit.event,
            },
            project: hit.project.clone(),
            state: match contract.pickup {
                Pickup::Ask => State::Proposed,
                Pickup::Auto => State::Queued,
            },
            worktree: None,
            session: None,
            pr_url: Some(hit.url.clone()),
            url: Some(hit.url.clone()),
            created: now,
            updated: now,
            note: None,
            title: Some(format!("{what} on #{}", hit.pr)),
            contract: Some(task),
            picked_by: None,
            gone_upstream: false,
            picked_from: None,
            fix_pushes: Vec::new(),
        };
        firings
            .handed
            .push((hit.session.clone(), hit.url.clone(), item.id.clone()));
        items.push(item.clone());
        firings.filed.push(item);
    }
    firings
}

// What a closed PR means is the autopilot's call, so it only gets a note.
fn settle(items: &mut [Item], prs: &HashMap<String, HashMap<PrKey, PrState>>, now: u64) -> Vec<Item> {
    let mut changed = Vec::new();
    for item in items.iter_mut().filter(|i| !i.state.terminal()) {
        let Some(state) = pr_key(item).and_then(|key| prs.get(&item.project)?.get(&key)) else {
            continue;
        };
        match state {
            PrState::Merged => item.state = State::Done,
            PrState::Closed if item.note.as_deref() != Some(CLOSED_NOTE) => item.note = Some(CLOSED_NOTE.to_string()),
            _ => continue,
        }
        item.updated = now;
        changed.push(item.clone());
    }
    changed
}

fn same_source(a: &Source, b: &Source, origin: &str) -> bool {
    match (a, b) {
        (Source::Issue { key: a, .. }, Source::Issue { key: b, .. }) => {
            canonical_key(a, origin) == canonical_key(b, origin)
        }
        _ => a == b,
    }
}

// A hand-made item may key its issue by url, so both sides are read against the origin.
fn same_work(item: &Item, row: &IssueRef, repo: &str) -> bool {
    match (&item.source, row.kind) {
        (Source::Issue { key, .. }, IssueKind::Issue) => canonical_key(key, repo) == canonical_key(&row.key, repo),
        // Only while open: a finished scheduled run must not keep pickup off the issue for good.
        (Source::Schedule { issue: Some(key), .. }, IssueKind::Issue) => {
            !item.state.terminal() && canonical_key(key, repo) == canonical_key(&row.key, repo)
        }
        (Source::Pr { .. }, IssueKind::ReviewRequest) => row
            .key
            .parse()
            .ok()
            .is_some_and(|n: u64| pr_key(item) == Some((repo.to_lowercase(), n))),
        _ => false,
    }
}

fn kind_of(item: &Item) -> Option<IssueKind> {
    match item.source {
        Source::Issue { .. } | Source::Schedule { .. } => Some(IssueKind::Issue),
        Source::Pr { .. } => Some(IssueKind::ReviewRequest),
        Source::Rule { .. } => None,
    }
}

// Only a key naming its repo can be compared across projects: a bare number is
// each project's own origin.
fn held_elsewhere<'a>(items: &'a [Item], project: &str, key: &str) -> Option<&'a str> {
    if !key.contains('#') {
        return None;
    }
    items
        .iter()
        .find(|i| {
            !i.state.terminal()
                && !same_folder(&i.project, project)
                && matches!(&i.source, Source::Issue { key: k, .. } if k.eq_ignore_ascii_case(key))
        })
        .map(|i| i.project.as_str())
}

/// One tick of `account`'s lists for `project` (in `repo`, `owner/name`),
/// against the items. New rows become items; a list's first tick only
/// proposes, whatever the contract, so a new or changed source never starts a
/// backlog on its own. An item it picked that left every list closes as gone
/// upstream while it is still waiting to start, and only gets a note once
/// running; nothing closes unless every list answered under `cap`. A row
/// another project already holds open is left to that project. Answers the
/// items it changed, and the projects that held a row.
#[allow(clippy::too_many_arguments)]
pub fn plan_pickup(
    items: &mut Vec<Item>,
    project: &str,
    repo: &str,
    account: &str,
    lists: &[SourceList],
    answered: bool,
    pickup: Pickup,
    file_reviews: bool,
    now: u64,
    mut mint: impl FnMut() -> String,
) -> (Vec<Item>, Vec<(String, String)>) {
    let here = |i: &Item| same_folder(&i.project, project);
    let complete = |kind: IssueKind| {
        (answered || kind == IssueKind::ReviewRequest) && lists.iter().filter(|l| l.kind == kind).all(|l| l.complete)
    };
    let listed = |item: &Item| lists.iter().flat_map(|l| &l.rows).any(|r| same_work(item, r, repo));
    let mut changed = Vec::new();
    for item in items
        .iter_mut()
        .filter(|i| here(i) && !i.state.terminal() && i.picked_by.as_deref() == Some(account))
    {
        let Some(kind) = kind_of(item) else {
            continue;
        };
        if !complete(kind) || listed(item) {
            continue;
        }
        let note = match kind {
            IssueKind::Issue if matches!(item.state, State::Proposed | State::Queued) => GONE_UPSTREAM,
            IssueKind::Issue => LEFT_SOURCE,
            IssueKind::ReviewRequest => REVIEW_CLEARED,
        };
        if matches!(item.state, State::Proposed | State::Queued) {
            item.state = State::Done;
            item.gone_upstream = true;
        } else if item.note.as_deref() == Some(note) {
            continue;
        }
        item.note = Some(note.to_string());
        item.updated = now;
        changed.push(item.clone());
    }
    // Read before any row lands, since the origin's two lists share one `search`.
    let firsts: Vec<bool> = lists
        .iter()
        .map(|list| {
            !items.iter().any(|i| {
                here(i)
                    && i.picked_by.is_some()
                    && i.picked_from == list.search
                    && (file_reviews || i.kind != Kind::Review)
            })
        })
        .collect();
    let mut held = Vec::new();
    for (list, first) in lists.iter().zip(firsts) {
        let start = if first || pickup == Pickup::Ask {
            State::Proposed
        } else {
            State::Queued
        };
        for row in &list.rows {
            if !file_reviews && row.kind == IssueKind::ReviewRequest {
                continue;
            }
            let known: Vec<&Item> = items.iter().filter(|i| here(i) && same_work(i, row, repo)).collect();
            if !known.is_empty() && !known.iter().all(|i| i.state.terminal() && i.gone_upstream) {
                continue;
            }
            if let Some(other) = held_elsewhere(items, project, &row.key) {
                held.push((row.key.clone(), other.to_string()));
                continue;
            }
            let (kind, source) = match row.kind {
                IssueKind::Issue => (
                    Kind::Ship,
                    Source::Issue {
                        key: row.key.clone(),
                        project: project.to_string(),
                    },
                ),
                IssueKind::ReviewRequest => match row.key.parse() {
                    Ok(number) => (
                        Kind::Review,
                        Source::Pr {
                            number,
                            repo: repo.to_string(),
                        },
                    ),
                    Err(_) => continue,
                },
            };
            let item = Item {
                id: mint(),
                kind,
                source,
                project: project.to_string(),
                state: start,
                worktree: None,
                session: None,
                pr_url: None,
                url: Some(row.url.clone()),
                created: now,
                updated: now,
                note: None,
                title: Some(row.title.clone()),
                contract: None,
                picked_by: Some(account.to_string()),
                gone_upstream: false,
                picked_from: list.search.clone(),
                fix_pushes: Vec::new(),
            };
            items.push(item.clone());
            changed.push(item);
        }
    }
    (changed, held)
}

#[derive(Serialize, Deserialize)]
pub struct RuleReview {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub worktree: String,
    pub session: Option<String>,
}

pub fn plan_rule_review(
    items: &mut Vec<Item>,
    project: &str,
    repo: &str,
    account: &str,
    review: RuleReview,
    now: u64,
    mint: impl FnOnce() -> String,
) -> Item {
    let key = Some((repo.to_lowercase(), review.number));
    let ours = |i: &Item| i.kind == Kind::Review && same_folder(&i.project, project) && pr_key(i) == key;
    let at = items.iter().position(|i| ours(i) && !i.state.terminal()).or_else(|| {
        items
            .iter()
            .enumerate()
            .filter(|(_, i)| ours(i) && i.state == State::Done)
            .max_by_key(|(_, i)| i.updated)
            .map(|(at, _)| at)
    });
    let at = at.unwrap_or_else(|| {
        items.push(Item {
            id: mint(),
            kind: Kind::Review,
            source: Source::Pr {
                number: review.number,
                repo: repo.to_string(),
            },
            project: project.to_string(),
            state: State::Running,
            worktree: None,
            session: None,
            pr_url: None,
            url: None,
            created: now,
            updated: now,
            note: None,
            title: None,
            contract: None,
            picked_by: None,
            gone_upstream: false,
            picked_from: None,
            fix_pushes: Vec::new(),
        });
        items.len() - 1
    });
    let item = &mut items[at];
    item.state = State::Running;
    item.worktree = Some(review.worktree);
    if review.session.is_some() {
        item.session = review.session;
    }
    item.url = Some(review.url);
    item.title = Some(review.title);
    item.note = None;
    item.gone_upstream = false;
    item.picked_by.get_or_insert_with(|| account.to_string());
    item.updated = now;
    item.clone()
}

/// The PR numbers of every open item, by project.
pub fn open_prs(items: &[Item]) -> HashMap<String, Vec<u64>> {
    let mut by_project: HashMap<String, Vec<u64>> = HashMap::new();
    for item in items.iter().filter(|i| !i.state.terminal()) {
        if let Some((_, number)) = pr_key(item) {
            by_project.entry(item.project.clone()).or_default().push(number);
        }
    }
    by_project
}

struct Fetched {
    at: Instant,
    states: HashMap<PrKey, PrState>,
    asked: HashSet<u64>,
}

#[derive(Default)]
pub struct PrStates {
    fetched: Mutex<HashMap<String, Fetched>>,
}

impl PrStates {
    pub fn get(
        &self,
        project: &str,
        numbers: &[u64],
        fetch: impl FnOnce(&[u64]) -> Result<Vec<(PrKey, PrState)>, crate::forge::ForgeError>,
    ) -> Option<HashMap<PrKey, PrState>> {
        let fresh = |f: &Fetched| f.at.elapsed() < PR_STATES_TTL && numbers.iter().all(|n| f.asked.contains(n));
        if let Some(hit) = self
            .fetched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(project)
            .filter(|f| fresh(f))
        {
            return Some(hit.states.clone());
        }
        let states: HashMap<PrKey, PrState> = fetch(numbers).ok()?.into_iter().collect();
        let entry = Fetched {
            at: Instant::now(),
            states: states.clone(),
            asked: numbers.iter().copied().collect(),
        };
        self.fetched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(project.to_string(), entry);
        Some(states)
    }
}

fn canon(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn reconcile(
    items: &[Item],
    live: &HashSet<String>,
    worktrees: &HashMap<String, Option<Vec<Listed>>>,
    root: Option<&Path>,
    radar: Option<&crate::radar::View>,
) -> Vec<Row> {
    items
        .iter()
        .map(|item| Row {
            overlaps: radar.map(|r| overlaps_of(item, items, &r.overlaps)),
            base_conflicts: radar.and_then(|r| r.conflicts.get(item.worktree.as_deref()?).cloned().flatten()),
            session_live: item.session.as_ref().map(|s| live.contains(s)),
            worktree_gone: item.worktree.as_deref().and_then(|wt| {
                let listed = worktrees.get(&item.project)?.as_ref()?;
                let wt = canon(Path::new(wt));
                Some(!listed.iter().any(|(p, _)| canon(p) == wt))
            }),
            reference: reference(item, worktrees, root),
            item: item.clone(),
        })
        .collect()
}

fn overlaps_of(item: &Item, items: &[Item], overlaps: &[crate::radar::Overlap]) -> Vec<RowOverlap> {
    let mine = |o: &crate::radar::Overlap| {
        item.session.as_deref() == Some(o.session.as_str())
            || item
                .worktree
                .as_deref()
                .is_some_and(|wt| crate::rpc::events::same_folder(wt, &o.path))
    };
    let mut out: Vec<RowOverlap> = overlaps
        .iter()
        .filter(|o| mine(o))
        .map(|o| RowOverlap {
            file: o.file.clone(),
            other_session: o.other_session.clone(),
            other_item: items
                .iter()
                .find(|i| !i.state.terminal() && i.session.as_deref() == Some(o.other_session.as_str()))
                .map(|i| i.id.clone()),
            other_branch: o.other_branch.clone(),
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn is_number(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

// `ENG-123`, as Linear and Jira spell a key.
fn is_tracker_key(s: &str) -> bool {
    s.split_once('-')
        .is_some_and(|(team, n)| !team.is_empty() && team.bytes().all(|b| b.is_ascii_uppercase()) && is_number(n))
}

// An issue key may arrive as `12`, `#12`, `ENG-123` or the issue's url, whose
// key sits before any slug: `/issues/12`, `/issue/ENG-123/fix-login`.
fn label_of(source: &Source, title: Option<&str>) -> String {
    let key = match source {
        Source::Pr { number, .. } | Source::Rule { pr: number, .. } => return format!("#{number}"),
        Source::Schedule { schedule, .. } => return title.unwrap_or(schedule).to_string(),
        Source::Issue { key, .. } => key.trim().trim_start_matches('#'),
    };
    let found = key
        .trim_end_matches('/')
        .rsplit('/')
        .find(|s| is_number(s) || is_tracker_key(s))
        .unwrap_or(key);
    if is_number(found) {
        format!("#{found}")
    } else {
        found.to_string()
    }
}

// Tori lays folders out as <root>/<space>/<project>, so the names are the path's.
fn place(item: &Item, worktrees: &HashMap<String, Option<Vec<Listed>>>, root: Option<&Path>) -> Vec<String> {
    let project = Path::new(&item.project);
    let Some(space) = project.parent() else {
        return Vec::new();
    };
    let under_root = space
        .parent()
        .zip(root)
        .is_some_and(|(at, root)| same_folder(&at.to_string_lossy(), &root.to_string_lossy()));
    if !under_root {
        return Vec::new();
    }
    let mut place = vec![name_of(space), name_of(project)];
    if let Some(wt) = item.worktree.as_deref() {
        let wt_path = canon(Path::new(wt));
        let listed = worktrees
            .get(&item.project)
            .and_then(|l| l.as_ref())
            .and_then(|l| l.iter().find(|(p, _)| canon(p) == wt_path));
        place.push(
            listed
                .and_then(|(_, branch)| branch.clone())
                .unwrap_or_else(|| name_of(Path::new(wt))),
        );
    }
    place
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn reference(item: &Item, worktrees: &HashMap<String, Option<Vec<Listed>>>, root: Option<&Path>) -> Reference {
    let label = label_of(&item.source, item.title.as_deref());
    let key_url = match &item.source {
        Source::Issue { key, .. } if key.starts_with("https://") => Some(key.clone()),
        _ => None,
    };
    let url = item.url.clone().or(key_url);
    let pr = match &item.source {
        Source::Issue { .. } | Source::Schedule { .. } => item.pr_url.as_ref().and_then(|u| {
            Some(Link {
                label: format!("PR #{}", pr_key_of_url(u)?.1),
                url: u.clone(),
            })
        }),
        Source::Pr { .. } | Source::Rule { .. } => None,
    };
    let place = place(item, worktrees, root);
    let folder = item.worktree.clone().unwrap_or_else(|| item.project.clone());
    let mut markdown = match &url {
        Some(url) => format!("[{label}]({url})"),
        None => label.clone(),
    };
    if !place.is_empty() {
        let session = item
            .session
            .as_deref()
            .map(|s| format!("&session={}", encode(s)))
            .unwrap_or_default();
        markdown += &format!(
            " ([{}](tori://open?folder={}{session}))",
            place.join(" -> "),
            encode(&folder)
        );
    }
    if let Some(pr) = &pr {
        markdown += &format!(", [{}]({})", pr.label, pr.url);
    }
    let target = NavTarget {
        folder: Some(folder),
        session: item.session.clone(),
    };
    Reference {
        label,
        url,
        pr,
        place,
        target,
        markdown,
    }
}

// `list_worktrees_body` answers an empty list for an unreadable repo, so
// readability is asked first: "git failed" must not read as "every worktree is gone".
pub fn list_worktrees(items: &[Item]) -> HashMap<String, Option<Vec<Listed>>> {
    let projects: HashSet<&str> = items
        .iter()
        .filter(|i| i.worktree.is_some())
        .map(|i| i.project.as_str())
        .collect();
    projects
        .into_iter()
        .map(|project| {
            let listed = crate::worktree::repo_readable(project)
                .then(|| crate::worktree::list_worktrees_body(project.to_string()).ok())
                .flatten()
                .map(|all| {
                    all.into_iter()
                        .map(|w| (PathBuf::from(w.path), Some(w.branch).filter(|b| !b.is_empty())))
                        .collect()
                });
            (project.to_string(), listed)
        })
        .collect()
}

pub fn dir() -> PathBuf {
    crate::owned_state::config_dir().join("autopilot")
}

// Read backwards from the end: the log only grows, and a caller wants its last few lines.
fn tail_lines(path: &Path, limit: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: u64 = 8192;
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let Ok(mut start) = file.seek(SeekFrom::End(0)) else {
        return Vec::new();
    };
    let mut buf = Vec::new();
    while start > 0 && buf.iter().filter(|&&b| b == b'\n').count() <= limit {
        let step = CHUNK.min(start);
        start -= step;
        let mut chunk = vec![0; step as usize];
        if file
            .seek(SeekFrom::Start(start))
            .and_then(|_| file.read_exact(&mut chunk))
            .is_err()
        {
            return Vec::new();
        }
        chunk.extend(buf);
        buf = chunk;
    }
    let text = String::from_utf8_lossy(&buf);
    // Mid-file, the first line read is a fragment.
    let lines: Vec<&str> = text.lines().skip(usize::from(start > 0)).collect();
    lines[lines.len().saturating_sub(limit)..]
        .iter()
        .map(|l| l.to_string())
        .collect()
}

type Publish = Box<dyn Fn(Value) + Send + Sync>;
type Closed = Box<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
struct Held {
    items: Vec<Item>,
    projects: BTreeMap<String, Contract>,
    schedules: Vec<Schedule>,
    rules: Rules,
}

pub struct AutopilotStore {
    dir: PathBuf,
    held: Mutex<Held>,
    // File -> why it did not parse, say written by a newer Tori: writing it
    // would replace what this build cannot see.
    unreadable: HashMap<&'static str, String>,
    publish: Publish,
    // Told the id of an item that just became done or failed, with the lock
    // released, so it may call into `Asks` without ever nesting the two locks.
    closed: Closed,
    pub pr_states: PrStates,
    // The last full read's worktrees and root, so a change names its place
    // without a git call per update.
    seen: Mutex<Seen>,
    // The pickup trouble already logged, by project, so a tick repeating it every poll writes nothing.
    noted: Mutex<HashMap<String, HashSet<String>>>,
    clock_wake: (Mutex<bool>, Condvar),
    announced_pauses: Mutex<HashSet<String>>,
}

#[derive(Default)]
struct Seen {
    worktrees: HashMap<String, Option<Vec<Listed>>>,
    root: Option<PathBuf>,
}

fn load<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(T::default()),
    }
}

impl AutopilotStore {
    pub fn open(dir: PathBuf, publish: Publish) -> Self {
        let mut unreadable = HashMap::new();
        let queue: Queue = load(&dir.join(QUEUE)).unwrap_or_else(|e| {
            unreadable.insert(QUEUE, e);
            Queue::default()
        });
        let projects: Projects = load(&dir.join(PROJECTS)).unwrap_or_else(|e| {
            unreadable.insert(PROJECTS, e);
            Projects::default()
        });
        let schedules: schedules::Schedules = load(&dir.join(SCHEDULES)).unwrap_or_else(|e| {
            unreadable.insert(SCHEDULES, e);
            schedules::Schedules::default()
        });
        let rules: Rules = load(&dir.join(RULES)).unwrap_or_else(|e| {
            unreadable.insert(RULES, e);
            Rules::default()
        });
        let held = Held {
            items: queue.items,
            projects: projects.projects,
            schedules: schedules.schedules,
            rules,
        };
        Self {
            dir,
            held: Mutex::new(held),
            unreadable,
            publish,
            closed: Box::new(|_| {}),
            pr_states: PrStates::default(),
            seen: Mutex::default(),
            noted: Mutex::default(),
            clock_wake: (Mutex::new(false), Condvar::new()),
            announced_pauses: Mutex::default(),
        }
    }

    pub fn on_closed(self, closed: Closed) -> Self {
        Self { closed, ..self }
    }

    pub fn has(&self, id: &str) -> bool {
        self.lock().items.iter().any(|i| i.id == id)
    }

    fn lock(&self) -> MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, file: &'static str, value: Value) -> Result<(), UpdateError> {
        if let Some(e) = self.unreadable.get(file) {
            return Err(UpdateError::Write(format!(
                "{} does not parse, so it is left as it is: {e}",
                self.dir.join(file).display()
            )));
        }
        let text = serde_json::to_string_pretty(&value).map_err(|e| UpdateError::Write(e.to_string()))?;
        write_atomically(&self.dir.join(file), &text).map_err(UpdateError::Write)
    }

    pub fn update(&self, target: Target, patch: Patch) -> Result<Item, UpdateError> {
        let mint = || format!("item-{}", crate::chat::approval::random_token());
        let changed = self.write(|items| apply(items, target, patch, now_ms(), mint).map(|item| vec![item]))?;
        changed
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Write("the update changed nothing".into()))
    }

    // One save for every item `change` returns, then, with the lock released,
    // their events and the `closed` hook for each that just became terminal.
    fn write(
        &self,
        change: impl FnOnce(&mut Vec<Item>) -> Result<Vec<Item>, UpdateError>,
    ) -> Result<Vec<Item>, UpdateError> {
        let (changed, closed) = {
            let mut held = self.lock();
            let mut next = held.items.clone();
            let changed = change(&mut next)?;
            if changed.is_empty() {
                return Ok(changed);
            }
            let was_open = |id: &str| {
                held.items
                    .iter()
                    .find(|i| i.id == id)
                    .is_none_or(|i| !i.state.terminal())
            };
            let closed: Vec<String> = changed
                .iter()
                .filter(|i| i.state.terminal() && was_open(&i.id))
                .map(|i| i.id.clone())
                .collect();
            self.save(QUEUE, json!({ "items": next }))?;
            held.items = next;
            for item in &changed {
                self.log(json!({ "item": item }));
            }
            (changed, closed)
        };
        for item in &changed {
            self.changed(item, None);
        }
        let ran = |id: &String| {
            changed
                .iter()
                .any(|i| i.id == *id && matches!(i.source, Source::Schedule { .. }))
        };
        if closed.iter().any(ran) {
            self.wake_clock();
        }
        for id in &closed {
            (self.closed)(id);
        }
        Ok(changed)
    }

    pub fn set_project(&self, project: String, patch: ContractPatch) -> Result<Contract, UpdateError> {
        let (key, contract) = {
            let mut held = self.lock();
            let mut next = held.projects.clone();
            let (key, contract) = set_contract(&mut next, project, patch);
            self.save(PROJECTS, json!({ "projects": next }))?;
            held.projects = next;
            self.log(json!({ "project": key, "contract": contract }));
            (key, contract)
        };
        (self.publish)(json!({ "kind": "autopilot.changed", "project": key, "contract": contract, "ts": now_ms() }));
        Ok(contract)
    }

    pub fn schedules(&self) -> Vec<ScheduleRow> {
        let now = now_ms();
        let held = self.lock();
        held.schedules
            .iter()
            .map(|s| schedule_row(s, &held.items, now))
            .collect()
    }

    pub fn add_schedule(
        &self,
        project: String,
        name: String,
        cron: String,
        what: What,
    ) -> Result<ScheduleRow, UpdateError> {
        let schedule = Schedule {
            id: format!("schedule-{}", crate::chat::approval::random_token()),
            name,
            project,
            cron,
            what,
            created: now_ms(),
            last_slot: None,
            resumed_at: None,
        };
        self.write_schedules(|all| {
            all.push(schedule.clone());
            Ok(schedule)
        })
    }

    pub fn resume_schedule(&self, id: &str) -> Result<ScheduleRow, UpdateError> {
        self.write_schedules(|all| {
            let schedule = all
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or_else(|| UpdateError::NoSchedule(id.to_string()))?;
            schedule.resumed_at = Some(now_ms());
            Ok(schedule.clone())
        })
    }

    pub fn remove_schedule(&self, id: &str) -> Result<Schedule, UpdateError> {
        let removed = {
            let mut held = self.lock();
            let mut next = held.schedules.clone();
            let at = next
                .iter()
                .position(|s| s.id == id)
                .ok_or_else(|| UpdateError::NoSchedule(id.to_string()))?;
            let removed = next.remove(at);
            self.save(SCHEDULES, json!({ "schedules": next }))?;
            held.schedules = next;
            self.log(json!({ "schedule_removed": removed }));
            removed
        };
        (self.publish)(json!({ "kind": "autopilot.changed", "schedule_removed": id, "ts": now_ms() }));
        self.write(|items| Ok(drop_schedule_runs(items, id, now_ms())))?;
        Ok(removed)
    }

    pub fn fire_rules(&self, hits: &[RuleHit]) -> Result<RuleFirings, UpdateError> {
        if hits.is_empty() {
            return Ok(RuleFirings::default());
        }
        let mint = || format!("item-{}", crate::chat::approval::random_token());
        let (projects, rules) = {
            let held = self.lock();
            (held.projects.clone(), held.rules.clone())
        };
        let mut handed = Vec::new();
        let filed = self.write(|items| {
            let firings = plan_rule_firings(hits, items, &projects, &rules, now_ms(), mint);
            handed = firings.handed;
            Ok(firings.filed)
        })?;
        Ok(RuleFirings { filed, handed })
    }

    pub fn rules(&self, rules: &HashMap<String, PrRule>) -> Vec<RuleRow> {
        let held = self.lock();
        rule_rows(rules, &held.items, &held.rules, now_ms())
    }

    pub fn resume_rule(&self, project: &str) -> Result<(), UpdateError> {
        {
            let mut held = self.lock();
            let mut next = held.rules.clone();
            next.resumed.retain(|known, _| !same_folder(known, project));
            next.resumed.insert(project.to_string(), now_ms());
            self.save(RULES, json!(next))?;
            held.rules = next;
            self.log(json!({ "rule_resumed": project }));
        }
        (self.publish)(json!({ "kind": "autopilot.changed", "rule_resumed": project, "ts": now_ms() }));
        Ok(())
    }

    pub fn fire_due(&self, now: u64) -> Result<Fired, UpdateError> {
        let mint = || format!("item-{}", crate::chat::approval::random_token());
        let (firings, mut rows, paused) = {
            let mut held = self.lock();
            let mut items = held.items.clone();
            let mut schedules = held.schedules.clone();
            let firings = plan_firings(&mut schedules, &mut items, now, &chrono::Local, mint);
            let mut fired = Vec::new();
            if schedules != held.schedules {
                if !firings.queued.is_empty() || !firings.noted.is_empty() {
                    self.save(QUEUE, json!({ "items": items }))?;
                }
                self.save(SCHEDULES, json!({ "schedules": schedules }))?;
                fired = schedules
                    .iter()
                    .filter(|s| !held.schedules.contains(s))
                    .cloned()
                    .collect();
                held.items = items;
                held.schedules = schedules;
                for item in firings.queued.iter().chain(&firings.noted) {
                    self.log(json!({ "item": item }));
                }
                for (schedule, open) in &firings.skipped {
                    self.log(json!({ "schedule": schedule, "skipped_for": open }));
                }
            }
            let rows: Vec<ScheduleRow> = fired.iter().map(|s| schedule_row(s, &held.items, now)).collect();
            let paused: Vec<(ScheduleRow, Item)> = held
                .schedules
                .iter()
                .filter_map(|s| Some((schedule_row(s, &held.items, now), paused_by(s, &held.items)?.clone())))
                .collect();
            (firings, rows, paused)
        };
        let newly: Vec<(ScheduleRow, Item)> = {
            let mut told = self.announced_pauses.lock().unwrap_or_else(|e| e.into_inner());
            let newly = paused
                .iter()
                .filter(|(row, _)| !told.contains(&row.schedule.id))
                .cloned()
                .collect();
            *told = paused.iter().map(|(row, _)| row.schedule.id.clone()).collect();
            newly
        };
        for (row, run) in &newly {
            self.log(json!({ "schedule": row.schedule.id, "paused_after": run.id }));
            if !rows.iter().any(|r| r.schedule.id == row.schedule.id) {
                rows.push(row.clone());
            }
        }
        for item in firings.queued.iter().chain(&firings.noted) {
            self.changed(item, None);
        }
        for row in &rows {
            (self.publish)(json!({ "kind": "autopilot.changed", "schedule": row, "ts": now_ms() }));
        }
        Ok(Fired {
            queued: firings.queued,
            paused: newly.into_iter().map(|(_, run)| run).collect(),
        })
    }

    fn wake_clock(&self) {
        let (flag, changed) = &self.clock_wake;
        *flag.lock().unwrap_or_else(|e| e.into_inner()) = true;
        changed.notify_all();
    }

    pub fn wait_for_schedules(&self, timeout: Duration) {
        let (flag, changed) = &self.clock_wake;
        let flag = flag.lock().unwrap_or_else(|e| e.into_inner());
        let (mut flag, _) = changed
            .wait_timeout_while(flag, timeout, |set| !*set)
            .unwrap_or_else(|e| e.into_inner());
        *flag = false;
    }

    pub fn next_slot(&self) -> Option<u64> {
        self.lock()
            .schedules
            .iter()
            .filter_map(|s| schedules::next_slot(s, &chrono::Local))
            .min()
    }

    fn write_schedules(
        &self,
        change: impl FnOnce(&mut Vec<Schedule>) -> Result<Schedule, UpdateError>,
    ) -> Result<ScheduleRow, UpdateError> {
        let row = {
            let mut held = self.lock();
            let mut next = held.schedules.clone();
            let schedule = change(&mut next)?;
            self.save(SCHEDULES, json!({ "schedules": next }))?;
            held.schedules = next;
            self.log(json!({ "schedule": schedule }));
            schedule_row(&schedule, &held.items, now_ms())
        };
        self.wake_clock();
        (self.publish)(json!({ "kind": "autopilot.changed", "schedule": row, "ts": now_ms() }));
        Ok(row)
    }

    /// Applies one tick of the project's lists; see [`plan_pickup`]. `failed`
    /// names each source that did not answer, with why, and holds back every
    /// close. Answers the items it made or closed.
    pub fn pickup(
        &self,
        project: &str,
        repo: &str,
        account: &str,
        lists: &[SourceList],
        failed: &[FailedSource],
    ) -> Result<Vec<Item>, UpdateError> {
        let pickup = self.contract(project).unwrap_or_default().pickup;
        // A project whose review rule is on starts its own reviews; pickup still
        // closes what the rule filed once the request clears.
        let file_reviews = crate::settings::review_rule(project).action == crate::settings::ReviewAction::Off;
        let mint = || format!("item-{}", crate::chat::approval::random_token());
        let mut held = Vec::new();
        let changed = self.write(|items| {
            let (changed, by_others) = plan_pickup(
                items,
                project,
                repo,
                account,
                lists,
                failed.is_empty(),
                pickup,
                file_reviews,
                now_ms(),
                mint,
            );
            held = by_others;
            Ok(changed)
        })?;
        let trouble = failed
            .iter()
            .map(|f| json!({ "project": project, "source": f.search, "pickup_failed": f.error }))
            .chain(
                held.iter()
                    .map(|(key, other)| json!({ "project": project, "issue": key, "held_by": other })),
            );
        self.note_once(project, trouble.collect());
        Ok(changed)
    }

    pub fn rule_review(
        &self,
        project: &str,
        repo: &str,
        account: &str,
        review: RuleReview,
    ) -> Result<Item, UpdateError> {
        let mint = || format!("item-{}", crate::chat::approval::random_token());
        let changed = self.write(|items| {
            Ok(vec![plan_rule_review(
                items,
                project,
                repo,
                account,
                review,
                now_ms(),
                mint,
            )])
        })?;
        changed
            .into_iter()
            .next()
            .ok_or_else(|| UpdateError::Write("the update changed nothing".into()))
    }

    // Logs each line the project's last tick did not, and forgets what cleared.
    fn note_once(&self, project: &str, lines: Vec<Value>) {
        let now: HashSet<String> = lines.iter().map(Value::to_string).collect();
        let before = {
            let mut noted = self.noted.lock().unwrap_or_else(|e| e.into_inner());
            noted.insert(project.to_string(), now.clone()).unwrap_or_default()
        };
        for line in lines.into_iter().filter(|l| !before.contains(&l.to_string())) {
            self.log(line);
        }
    }

    pub fn projects(&self) -> BTreeMap<String, Contract> {
        self.lock().projects.clone()
    }

    pub fn contract(&self, project: &str) -> Option<Contract> {
        self.lock()
            .projects
            .iter()
            .find(|(known, _)| same_folder(known, project))
            .map(|(_, c)| c.clone())
    }

    // The file write already succeeded, so a failed log line is not a failed write.
    fn log(&self, entry: Value) {
        let mut line = json!({ "ts": now_ms() });
        if let (Some(line), Value::Object(entry)) = (line.as_object_mut(), entry) {
            line.extend(entry);
        }
        let appended = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(LOG))
            .and_then(|mut f| writeln!(f, "{line}"));
        if let Err(e) = appended {
            eprintln!("tori: autopilot log not appended: {e}");
        }
    }

    pub fn recent_log(&self, limit: usize) -> Vec<Value> {
        tail_lines(&self.dir.join(LOG), limit)
            .iter()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    // `observe` runs unlocked, since it shells out to git and later the forge;
    // the rows are built from the items as they are after it, so an update
    // landing meanwhile is neither lost nor waited on.
    pub fn state(&self, observe: impl FnOnce(&[Item]) -> Observed) -> Snapshot {
        let snapshot = self.lock().items.clone();
        let seen = observe(&snapshot);
        let root = crate::config::discovery_root();
        {
            let mut last = self.seen.lock().unwrap_or_else(|e| e.into_inner());
            last.worktrees.extend(seen.worktrees.clone());
            last.root = root.clone();
        }
        if let Err(e) = self.write(|items| Ok(settle(items, &seen.prs, now_ms()))) {
            eprintln!("tori: merged pull requests not recorded: {e}");
        }
        let held = self.lock();
        Snapshot {
            items: reconcile(
                &held.items,
                &seen.live,
                &seen.worktrees,
                root.as_deref(),
                seen.radar.as_ref(),
            ),
            projects: held.projects.clone(),
        }
    }

    pub fn reserve_fix_push(&self, key: &PrKey, max_attempts: u32, sha: &str) -> Result<String, String> {
        let mut refusal = None;
        let reserved = self
            .write(
                |items| match reserve_fix_push(items, key, max_attempts, sha, now_ms()) {
                    Ok(item) => Ok(vec![item]),
                    Err(why) => {
                        refusal = Some(why);
                        Ok(Vec::new())
                    }
                },
            )
            .map_err(|e| e.to_string())?;
        match (refusal, reserved.into_iter().next()) {
            (Some(why), _) => Err(why),
            (None, Some(item)) => Ok(item.id),
            (None, None) => Err("the fix push was not recorded".into()),
        }
    }

    // A push that never reached origin gives its attempt back.
    pub fn release_fix_push(&self, id: &str, sha: &str) -> Result<Vec<Item>, UpdateError> {
        self.write(|items| {
            Ok(items
                .iter_mut()
                .filter(|i| i.id == id)
                .filter_map(|i| {
                    let at = i.fix_pushes.iter().rposition(|p| p.sha == sha)?;
                    i.fix_pushes.remove(at);
                    Some(i.clone())
                })
                .collect())
        })
    }

    /// The open item `session` works on.
    pub fn item_for_session(&self, session: &str) -> Option<String> {
        self.lock()
            .items
            .iter()
            .find(|i| !i.state.terminal() && i.session.as_deref() == Some(session))
            .map(|i| i.id.clone())
    }

    /// The state of the item that names `session`, an open one over a closed one.
    pub fn state_for_session(&self, session: &str) -> Option<State> {
        let items = &self.lock().items;
        let named = || items.iter().filter(|i| i.session.as_deref() == Some(session));
        named()
            .find(|i| !i.state.terminal())
            .or_else(|| named().next_back())
            .map(|i| i.state)
    }

    /// A person closed `session`'s tab; `held` are the items with a pending approval.
    pub fn closed_by_hand(&self, session: &str, held: &HashSet<String>) -> Result<Vec<Item>, UpdateError> {
        self.write(|items| Ok(fail_closed_by_hand(items, session, held, now_ms())))
    }

    /// The worktree of every item still open.
    pub fn worktrees(&self) -> Vec<String> {
        self.lock()
            .items
            .iter()
            .filter(|i| !i.state.terminal())
            .filter_map(|i| i.worktree.clone())
            .collect()
    }

    /// Every session an item names.
    pub fn sessions(&self) -> Vec<String> {
        self.lock().items.iter().filter_map(|i| i.session.clone()).collect()
    }

    /// Open items a pull request event is about, as (item, its session): by the
    /// PR itself, or by the worktree it is checked out in, so an item hears of
    /// its PR after its worker ended.
    pub fn items_for_pr(&self, url: Option<&str>, worktree: Option<&str>) -> Vec<(String, Option<String>)> {
        let key = url.and_then(pr_key_of_url);
        self.lock()
            .items
            .iter()
            .filter(|i| !i.state.terminal())
            .filter(|i| {
                (key.is_some() && pr_key(i) == key)
                    || worktree
                        .zip(i.worktree.as_deref())
                        .is_some_and(|(a, b)| same_folder(a, b))
            })
            .map(|i| (i.id.clone(), i.session.clone()))
            .collect()
    }

    pub fn session_ended(&self, session: &str) {
        let ended: Vec<Item> = self
            .lock()
            .items
            .iter()
            .filter(|i| i.session.as_deref() == Some(session))
            .cloned()
            .collect();
        for item in ended {
            self.changed(&item, Some(false));
        }
    }

    // A worktree the last read did not list, say one made since, is asked of git.
    fn changed(&self, item: &Item, session_live: Option<bool>) {
        let reference = {
            let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
            let listed = seen.worktrees.get(&item.project).and_then(|l| l.as_ref());
            let known = item
                .worktree
                .as_deref()
                .is_none_or(|wt| listed.is_some_and(|l| l.iter().any(|(p, _)| canon(p) == canon(Path::new(wt)))));
            if !known {
                seen.worktrees.extend(list_worktrees(std::slice::from_ref(item)));
            }
            if seen.root.is_none() {
                seen.root = crate::config::discovery_root();
            }
            reference(item, &seen.worktrees, seen.root.as_deref())
        };
        let row = Row {
            item: item.clone(),
            session_live,
            worktree_gone: None,
            overlaps: None,
            base_conflicts: None,
            reference,
        };
        (self.publish)(json!({ "kind": "autopilot.changed", "item": row, "ts": now_ms() }));
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-autopilot-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn issue(key: &str) -> Target {
        Target::Key {
            kind: Kind::Ship,
            source: Source::Issue {
                key: key.into(),
                project: "/p".into(),
            },
            project: "/p".into(),
            origin: "o/r".into(),
        }
    }

    fn quiet(dir: &Path) -> AutopilotStore {
        AutopilotStore::open(dir.to_path_buf(), Box::new(|_| {}))
    }

    fn state(state: State) -> Patch {
        Patch {
            state: Some(state),
            ..Patch::default()
        }
    }

    fn item(id: &str, state: State) -> Item {
        Item {
            id: id.into(),
            kind: Kind::Ship,
            source: Source::Pr {
                number: 7,
                repo: "o/r".into(),
            },
            project: "/p".into(),
            state,
            worktree: None,
            session: None,
            pr_url: None,
            url: None,
            created: 1,
            updated: 1,
            note: None,
            title: None,
            contract: None,
            picked_by: None,
            gone_upstream: false,
            picked_from: None,
            fix_pushes: Vec::new(),
        }
    }

    fn hit(pr: u64) -> RuleHit {
        RuleHit {
            session: "chat".into(),
            project: "/p".into(),
            url: format!("https://github.com/o/r/pull/{pr}"),
            repo: "o/r".into(),
            pr,
            event: PrEvent::ChangesRequested,
            max_per_hour: 2,
        }
    }

    fn contracts(pickup: Pickup) -> BTreeMap<String, Contract> {
        BTreeMap::from([(
            "/p".to_string(),
            Contract {
                pickup,
                ..Contract::default()
            },
        )])
    }

    fn fire_rule(hits: &[RuleHit], items: &mut Vec<Item>, pickup: Pickup, rules: &Rules, now: u64) -> RuleFirings {
        let mut n = items.len();
        plan_rule_firings(hits, items, &contracts(pickup), rules, now, || {
            n += 1;
            format!("r{n}")
        })
    }

    #[test]
    fn a_fix_push_lands_on_an_open_ship_item_under_its_cap() {
        let key: PrKey = ("o/r".into(), 7);
        let mut items = vec![item("a", State::Running)];
        assert_eq!(
            reserve_fix_push(&mut items, &key, 2, "s1", 5).map(|i| i.fix_pushes.len()),
            Ok(1)
        );
        assert_eq!(
            reserve_fix_push(&mut items, &("o/r".into(), 8), 2, "s2", 6).unwrap_err(),
            "no open autopilot ship item holds this pull request",
            "another pull request"
        );
        assert!(reserve_fix_push(&mut items, &key, 2, "s2", 6).is_ok());
        assert_eq!(
            reserve_fix_push(&mut items, &key, 2, "s3", 7).unwrap_err(),
            "item a has used its 2 fix attempts"
        );
        assert_eq!(items[0].fix_pushes.len(), 2, "a refusal records nothing");

        let mut review = item("r", State::Running);
        review.kind = Kind::Review;
        assert!(
            reserve_fix_push(&mut [review], &key, 3, "s", 1).is_err(),
            "a review request is someone else's"
        );
        assert!(
            reserve_fix_push(&mut [item("d", State::Done)], &key, 3, "s", 1).is_err(),
            "a closed item"
        );
    }

    #[test]
    fn a_fix_push_is_counted_on_disk_and_a_failed_one_given_back() {
        let dir = temp_dir("fix-push");
        let store = quiet(&dir);
        store
            .write(|items| {
                items.push(item("a", State::Running));
                Ok(items.clone())
            })
            .unwrap();
        let key: PrKey = ("o/r".into(), 7);
        assert_eq!(store.reserve_fix_push(&key, 1, "abc"), Ok("a".into()));
        assert_eq!(
            quiet(&dir).reserve_fix_push(&key, 1, "def"),
            Err("item a has used its 1 fix attempts".into())
        );
        let store = quiet(&dir);
        store.release_fix_push("a", "abc").unwrap();
        assert_eq!(store.reserve_fix_push(&key, 1, "def"), Ok("a".into()));
    }

    #[test]
    fn a_rule_hit_files_a_ship_item_on_the_pull_request_under_the_contracts_pickup() {
        let mut items = Vec::new();
        let asked = fire_rule(&[hit(7)], &mut items, Pickup::Ask, &Rules::default(), 10);
        let filed = &asked.filed[0];
        assert_eq!((filed.kind, filed.state), (Kind::Ship, State::Proposed));
        assert_eq!(filed.pr_url.as_deref(), Some("https://github.com/o/r/pull/7"));
        assert!(filed.worktree.is_none());
        assert_eq!(
            asked.handed,
            vec![("chat".into(), filed.url.clone().unwrap(), "r1".into())]
        );

        let mut items = Vec::new();
        let auto = fire_rule(&[hit(7)], &mut items, Pickup::Auto, &Rules::default(), 10);
        assert_eq!(auto.filed[0].state, State::Queued);
    }

    #[test]
    fn a_project_with_no_contract_files_nothing() {
        let mut items = Vec::new();
        let none = plan_rule_firings(&[hit(7)], &mut items, &BTreeMap::new(), &Rules::default(), 10, || {
            "x".into()
        });
        assert!(none.filed.is_empty() && none.handed.is_empty() && items.is_empty());
    }

    #[test]
    fn an_open_item_on_the_pull_request_takes_the_hit_instead_of_a_second_item() {
        let mut items = Vec::new();
        fire_rule(&[hit(7)], &mut items, Pickup::Auto, &Rules::default(), 10);
        let again = fire_rule(&[hit(7)], &mut items, Pickup::Auto, &Rules::default(), 20);
        assert!(again.filed.is_empty());
        assert_eq!(again.handed[0].2, "r1", "the watch is handed to the open item");
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn the_hourly_cap_pauses_the_rule_until_a_resume() {
        let mut items = Vec::new();
        let done = |items: &mut Vec<Item>| items.iter_mut().for_each(|i| i.state = State::Done);
        fire_rule(&[hit(1)], &mut items, Pickup::Auto, &Rules::default(), 1_000);
        done(&mut items);
        fire_rule(&[hit(2)], &mut items, Pickup::Auto, &Rules::default(), 2_000);
        done(&mut items);
        let capped = fire_rule(&[hit(3)], &mut items, Pickup::Auto, &Rules::default(), 3_000);
        assert!(
            capped.filed.is_empty() && capped.handed.is_empty(),
            "two in an hour is the cap"
        );
        let later = fire_rule(
            &[hit(3)],
            &mut items,
            Pickup::Auto,
            &Rules::default(),
            3_000 + HOUR_MS * 5,
        );
        assert!(later.filed.is_empty(), "a pause outlasts the hour");

        let resumed = Rules {
            resumed: BTreeMap::from([("/p".to_string(), 2_500)]),
        };
        assert_eq!(
            fire_rule(&[hit(3)], &mut items, Pickup::Auto, &resumed, 4_000)
                .filed
                .len(),
            1
        );
    }

    #[test]
    fn a_rule_row_counts_this_hours_firings_and_shows_the_pause() {
        let mut items = Vec::new();
        fire_rule(&[hit(1)], &mut items, Pickup::Auto, &Rules::default(), 1_000);
        items[0].state = State::Done;
        fire_rule(&[hit(2)], &mut items, Pickup::Auto, &Rules::default(), 2_000);
        let rules = HashMap::from([
            (
                "/p".to_string(),
                PrRule {
                    on: vec![PrEvent::CheckFailed],
                    max_per_hour: 2,
                },
            ),
            ("/off".to_string(), PrRule::default()),
        ]);
        let rows = rule_rows(&rules, &items, &Rules::default(), 3_000);
        assert_eq!(rows.len(), 1, "a rule with no events is no row");
        assert_eq!((rows[0].fired_this_hour, rows[0].paused), (2, true));

        let later = rule_rows(&rules, &items, &Rules::default(), 3_000 + HOUR_MS);
        assert_eq!(
            (later[0].fired_this_hour, later[0].paused),
            (0, true),
            "the pause outlasts the hour"
        );
    }

    #[test]
    fn resuming_a_rule_is_kept_on_disk_and_lifts_its_pause() {
        let dir = temp_dir("rule-resume");
        let rules = HashMap::from([(
            "/p".to_string(),
            PrRule {
                on: vec![PrEvent::Conflicting],
                max_per_hour: 1,
            },
        )]);
        let store = quiet(&dir);
        store.set_project("/p".into(), ContractPatch::default()).unwrap();
        let firings = store.fire_rules(&[hit(4)]).unwrap();
        assert_eq!(firings.filed.len(), 1);
        assert!(store.rules(&rules)[0].paused);
        store.resume_rule("/p").unwrap();
        let reopened = quiet(&dir).rules(&rules);
        assert_eq!((reopened[0].paused, reopened[0].fired_this_hour), (false, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_merged_pull_request_closes_its_rule_item() {
        let mut items = Vec::new();
        fire_rule(&[hit(7)], &mut items, Pickup::Auto, &Rules::default(), 10);
        let prs = HashMap::from([(
            "/p".to_string(),
            HashMap::from([(("o/r".to_string(), 7), PrState::Merged)]),
        )]);
        let changed = settle(&mut items, &prs, 20);
        assert_eq!(changed[0].state, State::Done);
    }

    #[test]
    fn a_hand_close_fails_only_work_that_has_not_left_the_worker() {
        let on = |id: &str, state: State| Item {
            session: Some(format!("s-{id}")),
            ..item(id, state)
        };
        let shipped = Item {
            pr_url: Some("https://github.com/o/r/pull/7".into()),
            ..on("shipped", State::Running)
        };
        let mut items = vec![
            on("working", State::Running),
            on("waiting", State::WaitingOnYou),
            on("held", State::WaitingOnYou),
            shipped,
            on("done", State::Done),
        ];
        let held: HashSet<String> = ["held".to_string()].into();
        for id in ["working", "waiting", "held", "shipped", "done"] {
            fail_closed_by_hand(&mut items, &format!("s-{id}"), &held, 9);
        }
        let state = |id: &str| {
            items
                .iter()
                .find(|i| i.id == id)
                .map(|i| (i.state, i.note.clone()))
                .unwrap()
        };
        assert_eq!(state("working"), (State::Failed, Some(CLOSED_BY_HAND.into())));
        assert_eq!(state("waiting"), (State::Failed, Some(CLOSED_BY_HAND.into())));
        assert_eq!(state("held").0, State::WaitingOnYou, "a pending approval closes it");
        assert_eq!(state("shipped").0, State::Running, "its merge closes it");
        assert_eq!(state("done").0, State::Done);
    }

    #[test]
    fn a_reopened_store_reads_back_what_was_written() {
        let dir = temp_dir("round-trip");
        let store = quiet(&dir);
        let patch = Patch {
            session: Some("s1".into()),
            note: Some("started".into()),
            title: Some("Fix the login redirect".into()),
            contract: Some("Build: the redirect. Ships: a PR. Out: the signup page.".into()),
            ..state(State::Running)
        };
        let made = store.update(issue("12"), patch).unwrap();
        let again = quiet(&dir);
        assert_eq!(again.lock().items, vec![made.clone()]);
        assert_eq!(made.title.as_deref(), Some("Fix the login redirect"));
        let old = r#"{"id": "i1", "kind": "ship", "source": {"type": "pr", "number": 7, "repo": "o/r"}, "project": "/p", "state": "queued", "created": 1, "updated": 1}"#;
        let old: Item = serde_json::from_str(old).unwrap();
        assert_eq!(
            (old.title, old.contract, old.url),
            (None, None, None),
            "an item written before these fields still loads"
        );
        let log = std::fs::read_to_string(dir.join(LOG)).unwrap();
        assert_eq!(log.lines().count(), 1, "one line per write");
        assert_eq!(
            again.update(Target::Id("nope".into()), Patch::default()),
            Err(UpdateError::NoItem("nope".into()))
        );
        let url = Some("https://github.com/o/r/issues/12".to_string());
        again
            .update(
                Target::Id(made.id.clone()),
                Patch {
                    url: url.clone(),
                    ..Patch::default()
                },
            )
            .unwrap();
        assert_eq!(quiet(&dir).state(|_| Observed::default()).items[0].item.url, url);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_update_landing_while_state_observes_is_kept() {
        let dir = temp_dir("interleave");
        let store = Arc::new(quiet(&dir));
        let id = store.update(issue("1"), Patch::default()).unwrap().id;
        let (observing, observed) = channel();
        let (updated, update_seen) = channel();
        let reader = store.clone();
        let read = std::thread::spawn(move || {
            reader.state(|_| {
                observing.send(()).unwrap();
                update_seen.recv().unwrap();
                Observed::default()
            })
        });
        observed.recv().unwrap();
        store.update(Target::Id(id.clone()), state(State::Running)).unwrap();
        updated.send(()).unwrap();
        let rows = read.join().unwrap().items;
        assert_eq!(
            rows[0].item.state,
            State::Running,
            "the rows are built after the update"
        );
        assert_eq!(
            quiet(&dir).lock().items[0].state,
            State::Running,
            "and the read wrote nothing back over it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_slow_lookup_does_not_hold_up_an_update() {
        let dir = temp_dir("slow-lookup");
        let store = Arc::new(quiet(&dir));
        let id = store.update(issue("1"), Patch::default()).unwrap().id;
        let reader = store.clone();
        let read = std::thread::spawn(move || {
            reader.state(|_| {
                std::thread::sleep(Duration::from_millis(500));
                Observed::default()
            })
        });
        std::thread::sleep(Duration::from_millis(50));
        let start = Instant::now();
        store.update(Target::Id(id), state(State::Queued)).unwrap();
        assert!(
            start.elapsed() < Duration::from_millis(250),
            "the update waited {:?} on the lookup",
            start.elapsed()
        );
        read.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_contract_missing_fields_reads_them_as_the_cautious_defaults() {
        let old: Contract = serde_json::from_str(r#"{"ships": "local", "agent": "codex"}"#).unwrap();
        assert_eq!(
            old,
            Contract {
                ships: Ships::Local,
                agent: Some("codex".into()),
                ..Contract::default()
            }
        );
        assert_eq!((old.autonomy, old.pickup), (Autonomy::AskEverything, Pickup::Ask));
        let empty: Projects = serde_json::from_str("{}").unwrap();
        assert!(empty.projects.is_empty());
    }

    #[test]
    fn a_set_contract_comes_back_in_state_and_after_a_reopen() {
        let dir = temp_dir("contract");
        let store = quiet(&dir);
        store
            .set_project(
                "/p".into(),
                ContractPatch {
                    autonomy: Some(Autonomy::AutoUntilOutward),
                    ..ContractPatch::default()
                },
            )
            .unwrap();
        let set = store
            .set_project(
                "/p/".into(),
                ContractPatch {
                    model: Some("opus".into()),
                    ..ContractPatch::default()
                },
            )
            .unwrap();
        assert_eq!(
            (set.autonomy, set.model.as_deref()),
            (Autonomy::AutoUntilOutward, Some("opus")),
            "a second set patches the first"
        );
        let reopened = quiet(&dir).state(|_| Observed::default());
        assert_eq!(
            reopened.projects,
            BTreeMap::from([("/p".to_string(), set)]),
            "one project, however it is spelled"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_merged_pull_request_closes_its_item_and_nothing_else_moves() {
        let dir = temp_dir("merged");
        let (closed_tx, closed) = channel();
        let closed_tx = Mutex::new(closed_tx);
        let store = quiet(&dir).on_closed(Box::new(move |id| {
            closed_tx.lock().unwrap().send(id.to_string()).unwrap()
        }));
        let review = |number| Target::Key {
            kind: Kind::Review,
            source: Source::Pr {
                number,
                repo: "o/r".into(),
            },
            project: "/p".into(),
            origin: "o/r".into(),
        };
        let merged = store.update(review(1), state(State::Running)).unwrap().id;
        let shut = store.update(review(2), state(State::Running)).unwrap().id;
        let open = store.update(review(3), state(State::Running)).unwrap().id;
        let shipped = store
            .update(
                issue("9"),
                Patch {
                    pr_url: Some("https://github.com/o/r/pull/4".into()),
                    ..state(State::WaitingOnYou)
                },
            )
            .unwrap()
            .id;
        let unknown = store
            .update(
                issue("10"),
                Patch {
                    pr_url: Some("https://github.com/o/r/pull/5".into()),
                    ..state(State::Running)
                },
            )
            .unwrap()
            .id;
        let fork = Target::Key {
            kind: Kind::Review,
            source: Source::Pr {
                number: 6,
                repo: "Someone/Else".into(),
            },
            project: "/p".into(),
            origin: "o/r".into(),
        };
        let elsewhere = store.update(fork, state(State::Running)).unwrap().id;
        let key = |n| ("o/r".to_string(), n);
        let states = HashMap::from([
            (key(1), PrState::Merged),
            (key(2), PrState::Closed),
            (key(3), PrState::Open),
            (key(4), PrState::Merged),
            (key(6), PrState::Merged),
        ]);
        let prs = HashMap::from([("/p".to_string(), states)]);

        let rows = store
            .state(|_| Observed {
                prs: prs.clone(),
                ..Observed::default()
            })
            .items;
        let by_id = |id: &str| rows.iter().find(|r| r.item.id == id).unwrap().item.clone();
        assert_eq!(
            (by_id(&merged).state, by_id(&shipped).state),
            (State::Done, State::Done)
        );
        assert_eq!(
            (by_id(&shut).state, by_id(&shut).note.as_deref()),
            (State::Running, Some(CLOSED_NOTE))
        );
        assert_eq!(
            (by_id(&open).state, by_id(&unknown).state),
            (State::Running, State::Running)
        );
        assert_eq!(
            by_id(&elsewhere).state,
            State::Running,
            "o/r#6 merging says nothing about someone/else#6"
        );
        let mut hooked: Vec<String> = closed.try_iter().collect();
        hooked.sort();
        let mut expected = vec![merged.clone(), shipped.clone()];
        expected.sort();
        assert_eq!(hooked, expected, "the merged items' holds get dropped");

        store.state(|_| Observed {
            prs,
            ..Observed::default()
        });
        let lines = std::fs::read_to_string(dir.join(LOG)).unwrap().lines().count();
        assert_eq!(lines, 6 + 3, "a second read with the same answer writes nothing");
        assert_eq!(
            quiet(&dir)
                .lock()
                .items
                .iter()
                .filter(|i| i.state == State::Done)
                .count(),
            2,
            "and the first was persisted"
        );

        let forge_down = quiet(&dir).state(|_| Observed::default());
        assert_eq!(
            forge_down
                .items
                .iter()
                .filter(|r| r.item.state == State::Running)
                .count(),
            4,
            "no answer changes nothing"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_lookup_within_the_ttl_asks_the_forge_nothing() {
        let cache = PrStates::default();
        let calls = std::cell::Cell::new(0);
        let fetch = |numbers: &[u64]| {
            calls.set(calls.get() + 1);
            Ok(numbers
                .iter()
                .map(|n| (("o/r".to_string(), *n), PrState::Open))
                .collect())
        };
        assert!(cache.get("/p", &[1, 2], fetch).is_some());
        assert!(cache.get("/p", &[2], fetch).is_some());
        assert_eq!(calls.get(), 1);
        assert!(
            cache.get("/p", &[3], fetch).is_some(),
            "a number not asked before is asked for"
        );
        assert_eq!(calls.get(), 2);
        assert!(cache
            .get("/q", &[1], |_| Err(crate::forge::ForgeError::NoRemote))
            .is_none());
        assert!(cache.get("/q", &[1], fetch).is_some(), "a failure is not cached");
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn a_dead_session_leaves_a_running_item_running() {
        let running = Item {
            session: Some("gone".into()),
            ..item("a", State::Running)
        };
        let rows = reconcile(&[running], &HashSet::new(), &HashMap::new(), None, None);
        assert_eq!(rows[0].item.state, State::Running);
        assert_eq!(rows[0].session_live, Some(false));
        assert_eq!(rows[0].worktree_gone, None, "no worktree, nothing to say");
        let live = reconcile(
            &[Item {
                session: Some("s".into()),
                ..item("a", State::Running)
            }],
            &HashSet::from(["s".to_string()]),
            &HashMap::new(),
            None,
            None,
        );
        assert_eq!(live[0].session_live, Some(true));
    }

    #[test]
    fn two_running_items_on_one_file_name_each_other_and_say_nothing_while_off() {
        let running = |id: &str, session: &str, wt: &str| Item {
            session: Some(session.into()),
            worktree: Some(wt.into()),
            ..item(id, State::Running)
        };
        let items = [running("a", "s1", "/p/one"), running("b", "s2", "/p/two")];
        let side = |session: &str, path: &str, other: &str, other_path: &str, branch: &str| crate::radar::Overlap {
            session: session.into(),
            path: path.into(),
            file: "src/a.rs".into(),
            other_session: other.into(),
            other_path: other_path.into(),
            other_branch: Some(branch.into()),
        };
        let view = crate::radar::View {
            overlaps: vec![
                side("s1", "/p/one", "s2", "/p/two", "two"),
                side("s2", "/p/two", "s1", "/p/one", "one"),
            ],
            conflicts: HashMap::from([
                ("/p/one".to_string(), Some(vec!["src/b.rs".to_string()])),
                ("/p/two".to_string(), None),
            ]),
        };
        let rows = reconcile(&items, &HashSet::new(), &HashMap::new(), None, Some(&view));
        let named = |row: &Row| {
            row.overlaps
                .as_ref()
                .unwrap()
                .iter()
                .map(|o| (o.other_item.clone(), o.other_branch.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(named(&rows[0]), vec![(Some("b".into()), Some("two".into()))]);
        assert_eq!(named(&rows[1]), vec![(Some("a".into()), Some("one".into()))]);
        assert_eq!(rows[0].base_conflicts, Some(vec!["src/b.rs".to_string()]));
        assert_eq!(rows[1].base_conflicts, None, "unknown is left out");

        let off = reconcile(&items, &HashSet::new(), &HashMap::new(), None, None);
        let json = serde_json::to_value(&off[0]).unwrap();
        assert!(
            json.get("overlaps").is_none() && json.get("base_conflicts").is_none(),
            "{json}"
        );
    }

    #[test]
    fn a_worktree_git_no_longer_lists_is_gone_and_an_unreadable_repo_says_nothing() {
        let with = |wt: &str| Item {
            worktree: Some(wt.into()),
            ..item("a", State::Running)
        };
        let listed = HashMap::from([("/p".to_string(), Some(vec![(PathBuf::from("/p/wt-1"), None)]))]);
        let rows = reconcile(
            &[with("/p/wt-1"), with("/p/wt-2")],
            &HashSet::new(),
            &listed,
            None,
            None,
        );
        assert_eq!(
            (rows[0].worktree_gone, rows[1].worktree_gone),
            (Some(false), Some(true))
        );
        assert_eq!(
            rows[1].item.state,
            State::Running,
            "a missing worktree is reported, never stored"
        );

        let unreadable = HashMap::from([("/p".to_string(), None)]);
        assert_eq!(
            reconcile(&[with("/p/wt-2")], &HashSet::new(), &unreadable, None, None)[0].worktree_gone,
            None
        );
    }

    #[test]
    fn a_reference_names_the_place_and_links_both_ways() {
        let root = Path::new("/r");
        let project = "/r/personal/tori";
        let ship = |key: &str| Item {
            source: Source::Issue {
                key: key.into(),
                project: project.into(),
            },
            project: project.into(),
            url: Some("https://github.com/o/tori/issues/212".into()),
            ..item("a", State::Running)
        };
        let listed = HashMap::from([(
            project.to_string(),
            Some(vec![(PathBuf::from("/r/personal/tori/wt"), Some("y-test".to_string()))]),
        )]);
        let worker = Item {
            worktree: Some("/r/personal/tori/wt".into()),
            session: Some("s 1".into()),
            ..ship("212")
        };
        let r = reference(&worker, &listed, Some(root));
        assert_eq!(
            (r.label.as_str(), r.place.clone()),
            ("#212", vec!["personal".to_string(), "tori".into(), "y-test".into()])
        );
        assert_eq!(
            r.markdown,
            "[#212](https://github.com/o/tori/issues/212) ([personal -> tori -> y-test](tori://open?folder=/r/personal/tori/wt&session=s%201))"
        );

        let proposed = reference(&ship("#212"), &HashMap::new(), Some(root));
        assert_eq!(
            (proposed.label.as_str(), proposed.place.len()),
            ("#212", 2),
            "no worktree yet, so project only"
        );
        assert_eq!(
            proposed.target,
            NavTarget {
                folder: Some(project.into()),
                session: None
            }
        );

        let orphan = Item {
            project: "/elsewhere/tori".into(),
            ..ship("https://github.com/o/tori/issues/212")
        };
        let r = reference(&Item { url: None, ..orphan }, &HashMap::new(), Some(root));
        assert_eq!(r.place, Vec::<String>::new(), "a folder no space holds");
        assert_eq!(
            r.markdown, "[#212](https://github.com/o/tori/issues/212)",
            "a url key is its own link"
        );

        let spaced = Item {
            project: "/r/Initech News/app".into(),
            worktree: Some("/r/Initech News/app/my wt".into()),
            ..ship("ENG-9")
        };
        let r = reference(&spaced, &HashMap::new(), Some(root));
        assert_eq!(
            r.place,
            vec!["Initech News".to_string(), "app".into(), "my wt".into()],
            "an unlisted worktree reads by its folder"
        );
        assert!(
            r.markdown
                .ends_with("(tori://open?folder=/r/Initech%20News/app/my%20wt))"),
            "{}",
            r.markdown
        );
        assert!(
            r.markdown.starts_with("[ENG-9]("),
            "a key that is not a number reads as it is"
        );
        let linear = Item {
            url: None,
            ..ship("https://linear.app/x/issue/ENG-9/fix-login")
        };
        assert_eq!(
            reference(&linear, &HashMap::new(), Some(root)).label,
            "ENG-9",
            "the key, not the slug after it"
        );

        let shipped = Item {
            pr_url: Some("https://github.com/o/tori/pull/230".into()),
            ..ship("212")
        };
        let pr = reference(&shipped, &HashMap::new(), Some(root)).pr.unwrap();
        assert_eq!(
            (pr.label.as_str(), pr.url.as_str()),
            ("PR #230", "https://github.com/o/tori/pull/230")
        );
    }

    fn row(key: &str, kind: IssueKind) -> IssueRef {
        IssueRef {
            key: key.into(),
            display: format!("#{key}"),
            title: format!("t{key}"),
            url: format!("https://github.com/o/r/issues/{key}"),
            kind,
            author: None,
            head_sha: None,
        }
    }

    // The origin's own lists, as a project with no issue sources reads them.
    fn origin_lists(rows: &[IssueRef], cap: usize) -> Vec<SourceList> {
        [IssueKind::Issue, IssueKind::ReviewRequest]
            .into_iter()
            .map(|kind| {
                let rows: Vec<IssueRef> = rows.iter().filter(|r| r.kind == kind).cloned().collect();
                SourceList {
                    search: None,
                    kind,
                    complete: rows.len() < cap,
                    rows,
                }
            })
            .collect()
    }

    fn tick_lists(
        items: &mut Vec<Item>,
        project: &str,
        lists: &[SourceList],
        answered: bool,
        pickup: Pickup,
    ) -> (Vec<Item>, Vec<(String, String)>) {
        let n = std::cell::Cell::new(items.len());
        plan_pickup(items, project, "o/r", "me", lists, answered, pickup, true, 9, || {
            n.set(n.get() + 1);
            format!("p{}", n.get())
        })
    }

    fn tick(items: &mut Vec<Item>, account: &str, rows: &[IssueRef], cap: usize, pickup: Pickup) -> Vec<Item> {
        let n = std::cell::Cell::new(items.len());
        let lists = origin_lists(rows, cap);
        plan_pickup(items, "/p", "o/r", account, &lists, true, pickup, true, 9, || {
            n.set(n.get() + 1);
            format!("p{}", n.get())
        })
        .0
    }

    #[test]
    fn an_assigned_row_becomes_an_item_once_and_a_first_tick_only_proposes() {
        let mut items = Vec::new();
        let made = tick(
            &mut items,
            "me",
            &[row("1", IssueKind::Issue), row("2", IssueKind::ReviewRequest)],
            50,
            Pickup::Auto,
        );
        assert_eq!(
            made.iter().map(|i| (i.kind, i.state)).collect::<Vec<_>>(),
            vec![(Kind::Ship, State::Proposed), (Kind::Review, State::Proposed)]
        );
        assert_eq!(
            made[1].source,
            Source::Pr {
                number: 2,
                repo: "o/r".into()
            }
        );
        assert_eq!(
            (made[0].title.as_deref(), made[0].picked_by.as_deref()),
            (Some("t1"), Some("me"))
        );
        let later = tick(
            &mut items,
            "me",
            &[
                row("1", IssueKind::Issue),
                row("2", IssueKind::ReviewRequest),
                row("3", IssueKind::Issue),
            ],
            50,
            Pickup::Auto,
        );
        assert_eq!(
            later.iter().map(|i| (i.source.clone(), i.state)).collect::<Vec<_>>(),
            vec![(
                Source::Issue {
                    key: "3".into(),
                    project: "/p".into()
                },
                State::Queued
            )]
        );
        assert_eq!(
            tick(
                &mut Vec::from([items[0].clone()]),
                "me",
                &[row("4", IssueKind::Issue)],
                50,
                Pickup::Ask
            )
            .last()
            .unwrap()
            .state,
            State::Proposed
        );
    }

    #[test]
    fn a_declined_item_stays_declined_until_it_leaves_the_list_and_comes_back() {
        let mut items = Vec::new();
        tick(&mut items, "me", &[row("1", IssueKind::Issue)], 50, Pickup::Ask);
        items[0].state = State::Failed;
        assert!(
            tick(&mut items, "me", &[row("1", IssueKind::Issue)], 50, Pickup::Ask).is_empty(),
            "declined, still assigned"
        );
        let dropped = Item {
            state: State::Done,
            gone_upstream: true,
            ..items[0].clone()
        };
        let mut back = vec![dropped];
        assert_eq!(
            tick(&mut back, "me", &[row("1", IssueKind::Issue)], 50, Pickup::Ask).len(),
            1,
            "reassigned after it left"
        );
    }

    #[test]
    fn an_item_started_from_the_issue_url_is_the_same_issue() {
        let by_hand = Item {
            source: Source::Issue {
                key: "https://github.com/o/r/issues/7".into(),
                project: "/p".into(),
            },
            ..item("h", State::Running)
        };
        let mut items = vec![by_hand];
        assert!(
            tick(
                &mut items,
                "me",
                &[row("7", IssueKind::Issue), row("#8", IssueKind::Issue)],
                50,
                Pickup::Auto
            )
            .len()
                == 1
        );
        assert!(tick(
            &mut items,
            "me",
            &[row("#7", IssueKind::Issue), row("8", IssueKind::Issue)],
            50,
            Pickup::Auto
        )
        .is_empty());
    }

    #[test]
    fn a_project_whose_review_rule_is_on_files_no_review_and_still_clears_the_rules_item() {
        let mut items = vec![Item {
            kind: Kind::Review,
            picked_by: Some("me".into()),
            ..item("rule", State::Running)
        }];
        let lists = |rows: &[IssueRef]| origin_lists(rows, 50);
        let mint = || "new".to_string();
        let first = lists(&[row("1", IssueKind::Issue), row("7", IssueKind::ReviewRequest)]);
        plan_pickup(
            &mut items,
            "/p",
            "o/r",
            "me",
            &first,
            true,
            Pickup::Auto,
            false,
            9,
            mint,
        );
        let again = lists(&[
            row("1", IssueKind::Issue),
            row("7", IssueKind::ReviewRequest),
            row("8", IssueKind::ReviewRequest),
        ]);
        plan_pickup(
            &mut items,
            "/p",
            "o/r",
            "me",
            &again,
            true,
            Pickup::Auto,
            false,
            9,
            mint,
        );
        assert!(
            !items.iter().any(|i| i.id != "rule" && i.kind == Kind::Review),
            "the rule starts its own reviews: {items:?}"
        );
        assert!(items.iter().any(|i| i.kind == Kind::Ship), "issues are still filed");

        plan_pickup(
            &mut items,
            "/p",
            "o/r",
            "me",
            &lists(&[row("1", IssueKind::Issue)]),
            true,
            Pickup::Auto,
            false,
            9,
            mint,
        );
        let rule = items.iter().find(|i| i.id == "rule").unwrap();
        assert_eq!(rule.note.as_deref(), Some(REVIEW_CLEARED));
    }

    fn rule_review(session: &str) -> RuleReview {
        RuleReview {
            number: 7,
            url: "https://github.com/o/r/pull/7".into(),
            title: "t7".into(),
            worktree: "/p/pr-7".into(),
            session: Some(session.into()),
        }
    }

    #[test]
    fn the_review_rule_files_a_running_item_and_a_re_review_reopens_it() {
        let mut items = Vec::new();
        let made = plan_rule_review(&mut items, "/p", "O/R", "me", rule_review("s1"), 5, || "r1".into());
        assert_eq!((made.kind, made.state), (Kind::Review, State::Running));
        assert_eq!(
            (made.worktree.as_deref(), made.session.as_deref()),
            (Some("/p/pr-7"), Some("s1"))
        );
        assert_eq!((made.picked_by.as_deref(), made.picked_from), (Some("me"), None));

        items[0].state = State::Done;
        let again = plan_rule_review(&mut items, "/p", "o/r", "me", rule_review("s2"), 9, || "r2".into());
        assert_eq!(items.len(), 1, "the done item is reopened, not doubled");
        assert_eq!(
            (again.id.as_str(), again.state, again.session.as_deref()),
            ("r1", State::Running, Some("s2"))
        );
    }

    #[test]
    fn a_rule_item_does_not_make_the_issue_lists_first_tick_a_second() {
        let mut items = Vec::new();
        plan_rule_review(&mut items, "/p", "o/r", "me", rule_review("s1"), 5, || "r1".into());
        let lists = origin_lists(&[row("1", IssueKind::Issue), row("7", IssueKind::ReviewRequest)], 50);
        let (made, _) = plan_pickup(
            &mut items,
            "/p",
            "o/r",
            "me",
            &lists,
            true,
            Pickup::Auto,
            false,
            9,
            || "p1".into(),
        );
        let ship = made.iter().find(|i| i.kind == Kind::Ship).unwrap();
        assert_eq!(
            ship.state,
            State::Proposed,
            "a first tick only proposes, under auto too"
        );
    }

    #[test]
    fn the_brief_pushes_a_rule_item_to_its_own_pull_request_and_opens_none() {
        let brief = include_str!("../resources/autopilot/brief.md");
        let rules = &brief[brief.find("My pull request rules").unwrap()..];
        let section = &rules[..rules.find("\n\nWhen a wake names").unwrap()];
        for needed in [
            "`pr.push` draft",
            "its head branch\n  as `head`",
            "passing `pr` and no branch",
            "Never open a new pull request",
        ] {
            assert!(section.contains(needed), "{needed} missing");
        }
        assert!(!section.contains("pr_create"), "a rule item never opens a pull request");
    }

    #[test]
    fn the_brief_says_a_review_the_rule_started_is_handled_like_its_own() {
        let brief = include_str!("../resources/autopilot/brief.md");
        assert!(brief.contains("`started (review rule)`"));
    }

    #[test]
    fn only_a_complete_list_from_the_picking_account_closes_what_it_picked() {
        let mut items = vec![Item {
            source: Source::Issue {
                key: "9".into(),
                project: "/p".into(),
            },
            ..item("h", State::Running)
        }];
        tick(
            &mut items,
            "me",
            &[row("1", IssueKind::Issue), row("2", IssueKind::ReviewRequest)],
            50,
            Pickup::Ask,
        );
        assert!(
            tick(&mut items, "other", &[], 50, Pickup::Ask).is_empty(),
            "another account's list closes nothing"
        );
        let cut = tick(&mut items, "me", &[row("5", IssueKind::Issue)], 1, Pickup::Ask);
        let closed = |changed: &[Item]| -> Vec<(String, Option<String>)> {
            changed
                .iter()
                .filter(|i| i.state.terminal() && i.gone_upstream)
                .map(|i| (i.id.clone(), i.note.clone()))
                .collect()
        };
        assert_eq!(
            closed(&cut),
            vec![("p3".to_string(), Some(REVIEW_CLEARED.to_string()))],
            "issues hit the cap, so only the review search is whole"
        );
        let rest = tick(&mut items, "me", &[], 50, Pickup::Ask);
        assert_eq!(
            closed(&rest),
            vec![
                ("p2".to_string(), Some(GONE_UPSTREAM.to_string())),
                ("p4".to_string(), Some(GONE_UPSTREAM.to_string()))
            ]
        );
        assert_eq!(
            items.iter().find(|i| i.id == "h").unwrap().state,
            State::Running,
            "an item made by hand is never closed"
        );
    }

    fn tickets(search: &str, keys: &[&str], complete: bool) -> SourceList {
        SourceList {
            search: Some(search.into()),
            kind: IssueKind::Issue,
            rows: keys.iter().map(|k| row(k, IssueKind::Issue)).collect(),
            complete,
        }
    }

    fn reviews() -> SourceList {
        SourceList {
            search: None,
            kind: IssueKind::ReviewRequest,
            rows: Vec::new(),
            complete: true,
        }
    }

    fn keys(items: &[Item]) -> Vec<(String, State)> {
        items
            .iter()
            .map(|i| match &i.source {
                Source::Issue { key, .. } => (key.clone(), i.state),
                Source::Pr { number, .. } => (format!("pr{number}"), i.state),
                Source::Schedule { schedule, .. } => (schedule.clone(), i.state),
                Source::Rule { pr, .. } => (format!("rule{pr}"), i.state),
            })
            .collect()
    }

    #[test]
    fn an_issue_two_sources_list_becomes_one_item() {
        let mut items = Vec::new();
        let (made, _) = tick_lists(
            &mut items,
            "/p",
            &[
                tickets("a", &["x/t#1", "x/t#2"], true),
                tickets("b", &["x/t#2"], true),
                reviews(),
            ],
            true,
            Pickup::Ask,
        );
        assert_eq!(
            keys(&made),
            vec![("x/t#1".into(), State::Proposed), ("x/t#2".into(), State::Proposed)]
        );
        assert_eq!(made[1].picked_from.as_deref(), Some("a"));
    }

    #[test]
    fn a_failed_or_capped_source_closes_nothing() {
        let mut items = Vec::new();
        tick_lists(
            &mut items,
            "/p",
            &[tickets("a", &["x/t#1"], true), reviews()],
            true,
            Pickup::Ask,
        );
        let (failed, _) = tick_lists(&mut items, "/p", &[reviews()], false, Pickup::Ask);
        assert!(failed.is_empty(), "a source that did not answer proves nothing gone");
        let (capped, _) = tick_lists(
            &mut items,
            "/p",
            &[tickets("a", &["x/t#2"], false), reviews()],
            true,
            Pickup::Ask,
        );
        assert_eq!(keys(&capped), vec![("x/t#2".into(), State::Proposed)]);
        assert_eq!(items[0].state, State::Proposed);
    }

    #[test]
    fn leaving_its_source_closes_a_waiting_item_but_only_notes_a_running_one() {
        let mut items = Vec::new();
        tick_lists(
            &mut items,
            "/p",
            &[tickets("a", &["x/t#1", "x/t#2"], true), reviews()],
            true,
            Pickup::Ask,
        );
        items[1].state = State::Running;
        let (changed, _) = tick_lists(
            &mut items,
            "/p",
            &[tickets("a", &[], true), reviews()],
            true,
            Pickup::Ask,
        );
        assert_eq!(
            changed.iter().map(|i| (i.state, i.note.as_deref())).collect::<Vec<_>>(),
            vec![(State::Done, Some(GONE_UPSTREAM)), (State::Running, Some(LEFT_SOURCE))]
        );
        let (again, _) = tick_lists(
            &mut items,
            "/p",
            &[tickets("a", &[], true), reviews()],
            true,
            Pickup::Ask,
        );
        assert!(again.is_empty(), "the note is written once, not every tick");
    }

    #[test]
    fn a_new_or_edited_source_only_proposes_on_its_first_tick() {
        let mut items = Vec::new();
        tick(&mut items, "me", &[row("1", IssueKind::Issue)], 50, Pickup::Auto);
        let origin = tick(
            &mut items,
            "me",
            &[row("1", IssueKind::Issue), row("2", IssueKind::Issue)],
            50,
            Pickup::Auto,
        );
        assert_eq!(keys(&origin), vec![("2".into(), State::Queued)]);
        let mut lists = origin_lists(
            &[
                row("1", IssueKind::Issue),
                row("2", IssueKind::Issue),
                row("3", IssueKind::Issue),
            ],
            50,
        );
        lists.push(tickets("label:a", &["x/t#9"], true));
        let (added, _) = tick_lists(&mut items, "/p", &lists, true, Pickup::Auto);
        assert_eq!(
            keys(&added),
            vec![("3".into(), State::Queued), ("x/t#9".into(), State::Proposed)]
        );
        let (later, _) = tick_lists(
            &mut items,
            "/p",
            &[tickets("label:a", &["x/t#9", "x/t#10"], true), reviews()],
            true,
            Pickup::Auto,
        );
        assert_eq!(keys(&later).last().unwrap(), &("x/t#10".to_string(), State::Queued));
        let (edited, _) = tick_lists(
            &mut items,
            "/p",
            &[tickets("label:b", &["x/t#9", "x/t#10", "x/t#11"], true), reviews()],
            true,
            Pickup::Auto,
        );
        assert_eq!(keys(&edited), vec![("x/t#11".into(), State::Proposed)]);
    }

    #[test]
    fn an_issue_another_project_holds_open_is_left_to_it() {
        let mut items = Vec::new();
        tick_lists(
            &mut items,
            "/q",
            &[tickets("a", &["x/t#1"], true), reviews()],
            true,
            Pickup::Ask,
        );
        let (made, held) = tick_lists(
            &mut items,
            "/p",
            &[tickets("b", &["x/t#1", "x/t#2"], true), reviews()],
            true,
            Pickup::Ask,
        );
        assert_eq!(keys(&made), vec![("x/t#2".into(), State::Proposed)]);
        assert_eq!(held, vec![("x/t#1".to_string(), "/q".to_string())]);
    }

    #[test]
    fn a_retried_update_finds_the_item_by_any_spelling_of_its_issue() {
        let mut items = Vec::new();
        let target = |key: &str| Target::Key {
            kind: Kind::Ship,
            source: Source::Issue {
                key: key.into(),
                project: "/p".into(),
            },
            project: "/p".into(),
            origin: "o/r".into(),
        };
        let made = apply(
            &mut items,
            target("https://github.com/x/t/issues/4"),
            Patch::default(),
            1,
            || "a".into(),
        )
        .unwrap();
        assert_eq!(
            made.source,
            Source::Issue {
                key: "x/t#4".into(),
                project: "/p".into()
            }
        );
        apply(&mut items, target("X/T#4"), Patch::default(), 2, || "b".into()).unwrap();
        apply(
            &mut items,
            target("https://github.com/o/r/issues/4"),
            Patch::default(),
            3,
            || "c".into(),
        )
        .unwrap();
        apply(&mut items, target("#4"), Patch::default(), 4, || "d".into()).unwrap();
        assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["a", "c"]);
    }

    #[test]
    fn a_foreign_issue_is_labelled_by_its_repo() {
        let label = |key: &str| {
            label_of(
                &Source::Issue {
                    key: key.into(),
                    project: "/p".into(),
                },
                None,
            )
        };
        assert_eq!(
            [label("31"), label("#31"), label("gettori/tickets#31")],
            ["#31".to_string(), "#31".to_string(), "gettori/tickets#31".to_string()]
        );
    }

    #[test]
    fn a_contract_written_before_issue_sources_loads_with_none() {
        let old: Projects = serde_json::from_str(r#"{"projects":{"/p":{"ships":"pr","pickup":"auto"}}}"#).unwrap();
        assert!(old.projects["/p"].issues.is_empty());
        let mut projects = old.projects;
        let query = IssueQuery {
            repo: "gettori/tickets".into(),
            ..IssueQuery::default()
        };
        let (_, set) = set_contract(
            &mut projects,
            "/p".into(),
            ContractPatch {
                issues: Some(vec![query.clone()]),
                ..ContractPatch::default()
            },
        );
        assert_eq!((set.issues, set.pickup), (vec![query], Pickup::Auto));
    }

    #[test]
    fn a_pickup_publishes_each_item_it_made_or_closed_and_reads_back() {
        let dir = temp_dir("pickup");
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let store = AutopilotStore::open(
            dir.clone(),
            Box::new(move |event| tx.lock().unwrap().send(event).unwrap()),
        );
        store
            .pickup("/p", "o/r", "me", &origin_lists(&[row("1", IssueKind::Issue)], 50), &[])
            .unwrap();
        store.pickup("/p", "o/r", "me", &origin_lists(&[], 50), &[]).unwrap();
        let events: Vec<Value> = rx.try_iter().collect();
        assert_eq!(
            events.iter().map(|e| e["item"]["state"].clone()).collect::<Vec<_>>(),
            vec![json!("proposed"), json!("done")]
        );
        let back = quiet(&dir).lock().items[0].clone();
        assert_eq!((back.picked_by.as_deref(), back.gone_upstream), (Some("me"), true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_write_and_an_items_session_ending_publish_a_change() {
        let dir = temp_dir("publish");
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let store = AutopilotStore::open(
            dir.clone(),
            Box::new(move |event| tx.lock().unwrap().send(event).unwrap()),
        );
        store
            .update(
                issue("1"),
                Patch {
                    session: Some("s1".into()),
                    ..Patch::default()
                },
            )
            .unwrap();
        assert_eq!(rx.try_recv().unwrap()["kind"], "autopilot.changed");
        store.session_ended("other");
        assert!(rx.try_recv().is_err(), "a session no item names moves nothing");
        store.session_ended("s1");
        let event = rx.try_recv().unwrap();
        assert_eq!(
            (event["item"]["session"].clone(), event["item"]["session_live"].clone()),
            (json!("s1"), json!(false))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn scheduled(id: &str, schedule: &str, state: State) -> Item {
        Item {
            id: id.into(),
            kind: Kind::Ship,
            source: Source::Schedule {
                schedule: schedule.into(),
                issue: None,
            },
            project: "/p".into(),
            state,
            worktree: None,
            session: None,
            pr_url: None,
            url: None,
            created: 1,
            updated: 1,
            note: None,
            title: Some("Bump deps".into()),
            contract: None,
            picked_by: None,
            gone_upstream: false,
            picked_from: None,
            fix_pushes: Vec::new(),
        }
    }

    #[test]
    fn a_schedule_comes_back_after_a_reopen_and_a_file_that_does_not_parse_is_left_alone() {
        let dir = temp_dir("schedules");
        let store = quiet(&dir);
        let what = What::Prompt {
            text: "bump deps".into(),
        };
        let added = store
            .add_schedule("/p".into(), "Bump deps".into(), "0 7 * * 1-5".into(), what)
            .unwrap();
        assert!(added.next_run.is_some());
        assert_eq!(
            quiet(&dir)
                .schedules()
                .into_iter()
                .map(|r| r.schedule)
                .collect::<Vec<_>>(),
            vec![added.schedule.clone()]
        );
        let resumed = quiet(&dir).resume_schedule(&added.schedule.id).unwrap();
        assert!(resumed.schedule.resumed_at.is_some());
        assert_eq!(
            quiet(&dir).resume_schedule("nope").map(|r| r.schedule.id),
            Err(UpdateError::NoSchedule("nope".into()))
        );

        std::fs::write(dir.join(SCHEDULES), r#"{"schedules": [{"id": 7}]}"#).unwrap();
        let broken = quiet(&dir);
        assert!(broken.schedules().is_empty());
        let what = What::Issue { key: "12".into() };
        assert!(matches!(
            broken.add_schedule("/p".into(), "n".into(), "0 7 * * *".into(), what),
            Err(UpdateError::Write(_))
        ));
        assert_eq!(
            std::fs::read_to_string(dir.join(SCHEDULES)).unwrap(),
            r#"{"schedules": [{"id": 7}]}"#
        );
        broken.update(issue("3"), Patch::default()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_schedule_fails_its_queued_run_and_notes_a_running_one() {
        let mut items = vec![
            scheduled("a", "s1", State::Queued),
            scheduled("b", "s1", State::Running),
            scheduled("c", "s2", State::Queued),
            scheduled("d", "s1", State::Done),
        ];
        let changed = drop_schedule_runs(&mut items, "s1", 9);
        let states: Vec<(State, Option<&str>)> = items.iter().map(|i| (i.state, i.note.as_deref())).collect();
        assert_eq!(
            states,
            vec![
                (State::Failed, Some(SCHEDULE_REMOVED)),
                (State::Running, Some(SCHEDULE_REMOVED)),
                (State::Queued, None),
                (State::Done, None),
            ]
        );
        assert_eq!(changed.len(), 2);
        assert!(
            drop_schedule_runs(&mut items, "s1", 10).is_empty(),
            "the note is written once"
        );
    }

    #[test]
    fn a_scheduled_run_is_named_by_its_schedule_and_links_its_pr() {
        let mut item = scheduled("a", "schedule-1", State::Running);
        item.pr_url = Some("https://github.com/o/r/pull/40".into());
        let back: Item = serde_json::from_str(&serde_json::to_string(&item).unwrap()).unwrap();
        assert_eq!(back, item);
        let named = reference(&item, &HashMap::new(), None);
        assert_eq!(named.label, "Bump deps");
        assert_eq!(named.pr.map(|p| p.label), Some("PR #40".to_string()));
    }

    fn daily(id: &str, what: What) -> Schedule {
        Schedule {
            id: id.into(),
            name: "Bump deps".into(),
            project: "/p".into(),
            cron: "0 7 * * *".into(),
            what,
            created: 0,
            last_slot: None,
            resumed_at: None,
        }
    }

    const DAY: u64 = 86_400_000;
    const SEVEN: u64 = 7 * 3_600_000;

    fn fire(schedules: &mut [Schedule], items: &mut Vec<Item>, now: u64) -> Firings {
        let n = std::cell::Cell::new(0);
        plan_firings(schedules, items, now, &chrono::Utc, || {
            n.set(n.get() + 1);
            format!("f{}", n.get())
        })
    }

    #[test]
    fn a_due_schedule_queues_one_run_named_by_it_and_skips_while_that_run_is_open() {
        let prompt = What::Prompt {
            text: "bump deps".into(),
        };
        let mut schedules = vec![daily("s1", prompt)];
        let mut items = Vec::new();
        let first = fire(&mut schedules, &mut items, 3 * DAY + SEVEN + 5);
        assert_eq!(first.queued.len(), 1, "three missed days fire once");
        let run = &first.queued[0];
        assert_eq!(
            (run.state, run.title.as_deref(), run.contract.as_deref()),
            (State::Queued, Some("Bump deps"), Some("bump deps"))
        );
        assert_eq!(schedules[0].last_slot, Some(3 * DAY + SEVEN));
        assert!(fire(&mut schedules, &mut items, 3 * DAY + SEVEN + 60_000)
            .queued
            .is_empty());

        items[0].state = State::TakenOver;
        let next = fire(&mut schedules, &mut items, 4 * DAY + SEVEN);
        assert!(next.queued.is_empty());
        assert_eq!(next.skipped, vec![("s1".to_string(), "f1".to_string())]);
        assert_eq!(
            items[0].note.as_deref(),
            Some("skipped a run of Bump deps while this one is open")
        );
        let again = fire(&mut schedules, &mut items, 5 * DAY + SEVEN);
        assert!(again.noted.is_empty(), "the note is written once");
        assert_eq!(schedules[0].last_slot, Some(5 * DAY + SEVEN));

        items[0].state = State::Done;
        assert_eq!(fire(&mut schedules, &mut items, 6 * DAY + SEVEN).queued.len(), 1);
    }

    #[test]
    fn an_issue_schedule_and_pickup_never_hold_one_issue_twice() {
        let mut items = Vec::new();
        tick(&mut items, "me", &[row("12", IssueKind::Issue)], 100, Pickup::Auto);
        let mut schedules = vec![daily("s1", What::Issue { key: "12".into() })];
        let firings = fire(&mut schedules, &mut items, DAY + SEVEN);
        assert!(firings.queued.is_empty());
        assert_eq!(firings.skipped, vec![("s1".to_string(), "p1".to_string())]);

        let mut items = Vec::new();
        let made = fire(&mut schedules, &mut items, 2 * DAY + SEVEN).queued;
        assert_eq!(made.len(), 1);
        assert!(
            tick(&mut items, "me", &[row("12", IssueKind::Issue)], 100, Pickup::Auto).is_empty(),
            "pickup leaves an issue a scheduled run holds"
        );
        items[0].state = State::Done;
        assert_eq!(
            tick(&mut items, "me", &[row("12", IssueKind::Issue)], 100, Pickup::Auto).len(),
            1,
            "a finished scheduled run lets pickup have the issue"
        );
    }

    fn run(id: &str, created: u64, state: State) -> Item {
        Item {
            created,
            ..scheduled(id, "s1", state)
        }
    }

    #[test]
    fn three_failed_runs_pause_a_schedule_until_it_is_resumed() {
        let prompt = What::Prompt {
            text: "bump deps".into(),
        };
        let mut schedules = vec![daily("s1", prompt)];
        let mut items = vec![
            run("a", 1, State::Failed),
            run("b", 2, State::Failed),
            run("c", 3, State::Done),
            run("d", 4, State::Failed),
            run("e", 5, State::Failed),
        ];
        assert!(
            paused_by(&schedules[0], &items).is_none(),
            "a done run resets the count"
        );

        items.push(run("f", 6, State::Failed));
        assert_eq!(paused_by(&schedules[0], &items).map(|i| i.id.as_str()), Some("f"));
        let firings = fire(&mut schedules, &mut items, DAY + SEVEN);
        assert!(firings.queued.is_empty() && firings.skipped.is_empty());
        assert_eq!(
            schedules[0].last_slot,
            Some(DAY + SEVEN),
            "a paused slot is spent, not retried"
        );

        schedules[0].resumed_at = Some(7);
        assert!(paused_by(&schedules[0], &items).is_none());
        assert_eq!(fire(&mut schedules, &mut items, 2 * DAY + SEVEN).queued.len(), 1);
    }
}
