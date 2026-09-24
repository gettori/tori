//! The autopilot's queue, kept under `~/.config/tori/autopilot/` so a restart
//! hands back the same items. Only what a model decided is stored: whether an
//! item's session is live and whether its worktree is still there are derived
//! on every read, so a relaunch can never rewrite a state. See
//! [[adr_autopilot_is_a_session_not_a_state_machine]].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::forge::model::PrState;
use crate::owned_state::{now_ms, write_atomically};
use crate::rpc::events::same_folder;

const QUEUE: &str = "queue.json";
const PROJECTS: &str = "projects.json";
const LOG: &str = "log.jsonl";
const PR_STATES_TTL: Duration = Duration::from_secs(30);
const CLOSED_NOTE: &str = "its pull request was closed without merging";

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
    pub created: u64,
    pub updated: u64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub contract: Option<String>,
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
}

pub enum Target {
    Id(String),
    // Matched among open items only, so a retry after a crash finds the item it made.
    Key { kind: Kind, source: Source, project: String },
}

#[derive(Debug, Default, Clone)]
pub struct Patch {
    pub state: Option<State>,
    pub worktree: Option<String>,
    pub session: Option<String>,
    pub pr_url: Option<String>,
    pub note: Option<String>,
    pub title: Option<String>,
    pub contract: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum UpdateError {
    NoItem(String),
    Write(String),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UpdateError::NoItem(id) => write!(f, "no autopilot item {id}"),
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
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    #[serde(flatten)]
    pub item: Item,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_live: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_gone: Option<bool>,
}

#[derive(Debug, Default)]
pub struct Observed {
    pub live: HashSet<String>,
    // Project -> the worktrees git lists for it; `None` where git could not be read.
    pub worktrees: HashMap<String, Option<Vec<PathBuf>>>,
    // Project -> the states its origin gave, by (`owner/name`, number); absent where the forge failed.
    pub prs: HashMap<String, HashMap<PrKey, PrState>>,
}

fn apply(items: &mut Vec<Item>, target: Target, patch: Patch, now: u64, mint: impl FnOnce() -> String) -> Result<Item, UpdateError> {
    let at = match target {
        Target::Id(id) => items.iter().position(|i| i.id == id).ok_or(UpdateError::NoItem(id))?,
        Target::Key { kind, source, project } => {
            let open = items.iter().position(|i| !i.state.terminal() && i.kind == kind && i.source == source && same_folder(&i.project, &project));
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
                        created: now,
                        updated: now,
                        note: None,
                        title: None,
                        contract: None,
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

fn set_contract(projects: &mut BTreeMap<String, Contract>, project: String, patch: ContractPatch) -> (String, Contract) {
    let key = projects.keys().find(|known| same_folder(known, &project)).cloned().unwrap_or(project);
    let contract = projects.entry(key.clone()).or_default();
    contract.ships = patch.ships.unwrap_or(contract.ships);
    contract.autonomy = patch.autonomy.unwrap_or(contract.autonomy);
    contract.pickup = patch.pickup.unwrap_or(contract.pickup);
    for (field, value) in [(&mut contract.agent, patch.agent), (&mut contract.account, patch.account), (&mut contract.model, patch.model)] {
        if value.is_some() {
            *field = value;
        }
    }
    (key, contract.clone())
}

// (`owner/name` lowercased, number): a number alone would match another repo's PR.
pub type PrKey = (String, u64);

fn pr_key(item: &Item) -> Option<PrKey> {
    if let Source::Pr { number, repo } = &item.source {
        return Some((repo.to_lowercase(), *number));
    }
    pr_key_of_url(item.pr_url.as_deref()?)
}

// A GitHub `/pull/N` or GitLab `/-/merge_requests/N` URL.
fn pr_key_of_url(url: &str) -> Option<PrKey> {
    let url = url.trim_end_matches('/');
    let (rest, number) = url.rsplit_once('/')?;
    let repo_url = rest.strip_suffix("/pull").or_else(|| rest.strip_suffix("/-/merge_requests"))?;
    let (_host, repo) = repo_url.split_once("://").map_or(repo_url, |(_, path)| path).split_once('/')?;
    Some((repo.to_lowercase(), number.parse().ok()?))
}

// What a closed PR means is the autopilot's call, so it only gets a note.
fn settle(items: &mut [Item], prs: &HashMap<String, HashMap<PrKey, PrState>>, now: u64) -> Vec<Item> {
    let mut changed = Vec::new();
    for item in items.iter_mut().filter(|i| !i.state.terminal()) {
        let Some(state) = pr_key(item).and_then(|key| prs.get(&item.project)?.get(&key)) else { continue };
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
        if let Some(hit) = self.fetched.lock().unwrap_or_else(|e| e.into_inner()).get(project).filter(|f| fresh(f)) {
            return Some(hit.states.clone());
        }
        let states: HashMap<PrKey, PrState> = fetch(numbers).ok()?.into_iter().collect();
        let entry = Fetched { at: Instant::now(), states: states.clone(), asked: numbers.iter().copied().collect() };
        self.fetched.lock().unwrap_or_else(|e| e.into_inner()).insert(project.to_string(), entry);
        Some(states)
    }
}

fn canon(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn reconcile(items: &[Item], live: &HashSet<String>, worktrees: &HashMap<String, Option<Vec<PathBuf>>>) -> Vec<Row> {
    items
        .iter()
        .map(|item| Row {
            session_live: item.session.as_ref().map(|s| live.contains(s)),
            worktree_gone: item.worktree.as_deref().and_then(|wt| {
                let listed = worktrees.get(&item.project)?.as_ref()?;
                let wt = canon(Path::new(wt));
                Some(!listed.iter().any(|p| canon(p) == wt))
            }),
            item: item.clone(),
        })
        .collect()
}

// `list_worktrees_body` answers an empty list for an unreadable repo, so
// readability is asked first: "git failed" must not read as "every worktree is gone".
pub fn list_worktrees(items: &[Item]) -> HashMap<String, Option<Vec<PathBuf>>> {
    let projects: HashSet<&str> = items.iter().filter(|i| i.worktree.is_some()).map(|i| i.project.as_str()).collect();
    projects
        .into_iter()
        .map(|project| {
            let listed = crate::worktree::repo_readable(project)
                .then(|| crate::worktree::list_worktrees_body(project.to_string()).ok())
                .flatten()
                .map(|all| all.into_iter().map(|w| PathBuf::from(w.path)).collect());
            (project.to_string(), listed)
        })
        .collect()
}

pub fn dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/tori/autopilot")
}

// Read backwards from the end: the log only grows, and a caller wants its last few lines.
fn tail_lines(path: &Path, limit: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: u64 = 8192;
    let Ok(mut file) = std::fs::File::open(path) else { return Vec::new() };
    let Ok(mut start) = file.seek(SeekFrom::End(0)) else { return Vec::new() };
    let mut buf = Vec::new();
    while start > 0 && buf.iter().filter(|&&b| b == b'\n').count() <= limit {
        let step = CHUNK.min(start);
        start -= step;
        let mut chunk = vec![0; step as usize];
        if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut chunk)).is_err() {
            return Vec::new();
        }
        chunk.extend(buf);
        buf = chunk;
    }
    let text = String::from_utf8_lossy(&buf);
    // Mid-file, the first line read is a fragment.
    let lines: Vec<&str> = text.lines().skip(usize::from(start > 0)).collect();
    lines[lines.len().saturating_sub(limit)..].iter().map(|l| l.to_string()).collect()
}

type Publish = Box<dyn Fn(Value) + Send + Sync>;
type Closed = Box<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
struct Held {
    items: Vec<Item>,
    projects: BTreeMap<String, Contract>,
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
        let held = Held { items: queue.items, projects: projects.projects };
        Self { dir, held: Mutex::new(held), unreadable, publish, closed: Box::new(|_| {}), pr_states: PrStates::default() }
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
            return Err(UpdateError::Write(format!("{} does not parse, so it is left as it is: {e}", self.dir.join(file).display())));
        }
        let text = serde_json::to_string_pretty(&value).map_err(|e| UpdateError::Write(e.to_string()))?;
        write_atomically(&self.dir.join(file), &text).map_err(UpdateError::Write)
    }

    pub fn update(&self, target: Target, patch: Patch) -> Result<Item, UpdateError> {
        let mint = || format!("item-{}", crate::chat::approval::random_token());
        let changed = self.write(|items| apply(items, target, patch, now_ms(), mint).map(|item| vec![item]))?;
        changed.into_iter().next().ok_or_else(|| UpdateError::Write("the update changed nothing".into()))
    }

    // One save for every item `change` returns, then, with the lock released,
    // their events and the `closed` hook for each that just became terminal.
    fn write(&self, change: impl FnOnce(&mut Vec<Item>) -> Result<Vec<Item>, UpdateError>) -> Result<Vec<Item>, UpdateError> {
        let (changed, closed) = {
            let mut held = self.lock();
            let mut next = held.items.clone();
            let changed = change(&mut next)?;
            if changed.is_empty() {
                return Ok(changed);
            }
            let was_open = |id: &str| held.items.iter().find(|i| i.id == id).is_none_or(|i| !i.state.terminal());
            let closed: Vec<String> = changed.iter().filter(|i| i.state.terminal() && was_open(&i.id)).map(|i| i.id.clone()).collect();
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

    pub fn contract(&self, project: &str) -> Option<Contract> {
        self.lock().projects.iter().find(|(known, _)| same_folder(known, project)).map(|(_, c)| c.clone())
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
        tail_lines(&self.dir.join(LOG), limit).iter().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    // `observe` runs unlocked, since it shells out to git and later the forge;
    // the rows are built from the items as they are after it, so an update
    // landing meanwhile is neither lost nor waited on.
    pub fn state(&self, observe: impl FnOnce(&[Item]) -> Observed) -> Snapshot {
        let snapshot = self.lock().items.clone();
        let seen = observe(&snapshot);
        if let Err(e) = self.write(|items| Ok(settle(items, &seen.prs, now_ms()))) {
            eprintln!("tori: merged pull requests not recorded: {e}");
        }
        let held = self.lock();
        Snapshot { items: reconcile(&held.items, &seen.live, &seen.worktrees), projects: held.projects.clone() }
    }

    /// The open item `session` works on.
    pub fn item_for_session(&self, session: &str) -> Option<String> {
        self.lock().items.iter().find(|i| !i.state.terminal() && i.session.as_deref() == Some(session)).map(|i| i.id.clone())
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
                    || worktree.zip(i.worktree.as_deref()).is_some_and(|(a, b)| same_folder(a, b))
            })
            .map(|i| (i.id.clone(), i.session.clone()))
            .collect()
    }

    pub fn session_ended(&self, session: &str) {
        let ended: Vec<Item> = self.lock().items.iter().filter(|i| i.session.as_deref() == Some(session)).cloned().collect();
        for item in ended {
            self.changed(&item, Some(false));
        }
    }

    fn changed(&self, item: &Item, session_live: Option<bool>) {
        let row = Row { item: item.clone(), session_live, worktree_gone: None };
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
        Target::Key { kind: Kind::Ship, source: Source::Issue { key: key.into(), project: "/p".into() }, project: "/p".into() }
    }

    fn quiet(dir: &Path) -> AutopilotStore {
        AutopilotStore::open(dir.to_path_buf(), Box::new(|_| {}))
    }

    fn state(state: State) -> Patch {
        Patch { state: Some(state), ..Patch::default() }
    }

    fn item(id: &str, state: State) -> Item {
        Item {
            id: id.into(),
            kind: Kind::Ship,
            source: Source::Pr { number: 7, repo: "o/r".into() },
            project: "/p".into(),
            state,
            worktree: None,
            session: None,
            pr_url: None,
            created: 1,
            updated: 1,
            note: None,
            title: None,
            contract: None,
        }
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
        assert_eq!((old.title, old.contract), (None, None), "an item written before these fields still loads");
        let log = std::fs::read_to_string(dir.join(LOG)).unwrap();
        assert_eq!(log.lines().count(), 1, "one line per write");
        assert_eq!(again.update(Target::Id("nope".into()), Patch::default()), Err(UpdateError::NoItem("nope".into())));
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
        assert_eq!(rows[0].item.state, State::Running, "the rows are built after the update");
        assert_eq!(quiet(&dir).lock().items[0].state, State::Running, "and the read wrote nothing back over it");
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
        assert!(start.elapsed() < Duration::from_millis(250), "the update waited {:?} on the lookup", start.elapsed());
        read.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_contract_missing_fields_reads_them_as_the_cautious_defaults() {
        let old: Contract = serde_json::from_str(r#"{"ships": "local", "agent": "codex"}"#).unwrap();
        assert_eq!(old, Contract { ships: Ships::Local, agent: Some("codex".into()), ..Contract::default() });
        assert_eq!((old.autonomy, old.pickup), (Autonomy::AskEverything, Pickup::Ask));
        let empty: Projects = serde_json::from_str("{}").unwrap();
        assert!(empty.projects.is_empty());
    }

    #[test]
    fn a_set_contract_comes_back_in_state_and_after_a_reopen() {
        let dir = temp_dir("contract");
        let store = quiet(&dir);
        store.set_project("/p".into(), ContractPatch { autonomy: Some(Autonomy::AutoUntilOutward), ..ContractPatch::default() }).unwrap();
        let set = store.set_project("/p/".into(), ContractPatch { model: Some("opus".into()), ..ContractPatch::default() }).unwrap();
        assert_eq!((set.autonomy, set.model.as_deref()), (Autonomy::AutoUntilOutward, Some("opus")), "a second set patches the first");
        let reopened = quiet(&dir).state(|_| Observed::default());
        assert_eq!(reopened.projects, BTreeMap::from([("/p".to_string(), set)]), "one project, however it is spelled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_merged_pull_request_closes_its_item_and_nothing_else_moves() {
        let dir = temp_dir("merged");
        let (closed_tx, closed) = channel();
        let closed_tx = Mutex::new(closed_tx);
        let store = quiet(&dir).on_closed(Box::new(move |id| closed_tx.lock().unwrap().send(id.to_string()).unwrap()));
        let review = |number| Target::Key { kind: Kind::Review, source: Source::Pr { number, repo: "o/r".into() }, project: "/p".into() };
        let merged = store.update(review(1), state(State::Running)).unwrap().id;
        let shut = store.update(review(2), state(State::Running)).unwrap().id;
        let open = store.update(review(3), state(State::Running)).unwrap().id;
        let shipped = store.update(issue("9"), Patch { pr_url: Some("https://github.com/o/r/pull/4".into()), ..state(State::WaitingOnYou) }).unwrap().id;
        let unknown = store.update(issue("10"), Patch { pr_url: Some("https://github.com/o/r/pull/5".into()), ..state(State::Running) }).unwrap().id;
        let fork = Target::Key { kind: Kind::Review, source: Source::Pr { number: 6, repo: "Someone/Else".into() }, project: "/p".into() };
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

        let rows = store.state(|_| Observed { prs: prs.clone(), ..Observed::default() }).items;
        let by_id = |id: &str| rows.iter().find(|r| r.item.id == id).unwrap().item.clone();
        assert_eq!((by_id(&merged).state, by_id(&shipped).state), (State::Done, State::Done));
        assert_eq!((by_id(&shut).state, by_id(&shut).note.as_deref()), (State::Running, Some(CLOSED_NOTE)));
        assert_eq!((by_id(&open).state, by_id(&unknown).state), (State::Running, State::Running));
        assert_eq!(by_id(&elsewhere).state, State::Running, "o/r#6 merging says nothing about someone/else#6");
        let mut hooked: Vec<String> = closed.try_iter().collect();
        hooked.sort();
        let mut expected = vec![merged.clone(), shipped.clone()];
        expected.sort();
        assert_eq!(hooked, expected, "the merged items' holds get dropped");

        store.state(|_| Observed { prs, ..Observed::default() });
        let lines = std::fs::read_to_string(dir.join(LOG)).unwrap().lines().count();
        assert_eq!(lines, 6 + 3, "a second read with the same answer writes nothing");
        assert_eq!(quiet(&dir).lock().items.iter().filter(|i| i.state == State::Done).count(), 2, "and the first was persisted");

        let forge_down = quiet(&dir).state(|_| Observed::default());
        assert_eq!(forge_down.items.iter().filter(|r| r.item.state == State::Running).count(), 4, "no answer changes nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_lookup_within_the_ttl_asks_the_forge_nothing() {
        let cache = PrStates::default();
        let calls = std::cell::Cell::new(0);
        let fetch = |numbers: &[u64]| {
            calls.set(calls.get() + 1);
            Ok(numbers.iter().map(|n| (("o/r".to_string(), *n), PrState::Open)).collect())
        };
        assert!(cache.get("/p", &[1, 2], fetch).is_some());
        assert!(cache.get("/p", &[2], fetch).is_some());
        assert_eq!(calls.get(), 1);
        assert!(cache.get("/p", &[3], fetch).is_some(), "a number not asked before is asked for");
        assert_eq!(calls.get(), 2);
        assert!(cache.get("/q", &[1], |_| Err(crate::forge::ForgeError::NoRemote)).is_none());
        assert!(cache.get("/q", &[1], fetch).is_some(), "a failure is not cached");
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn a_dead_session_leaves_a_running_item_running() {
        let running = Item { session: Some("gone".into()), ..item("a", State::Running) };
        let rows = reconcile(&[running], &HashSet::new(), &HashMap::new());
        assert_eq!(rows[0].item.state, State::Running);
        assert_eq!(rows[0].session_live, Some(false));
        assert_eq!(rows[0].worktree_gone, None, "no worktree, nothing to say");
        let live = reconcile(&[Item { session: Some("s".into()), ..item("a", State::Running) }], &HashSet::from(["s".to_string()]), &HashMap::new());
        assert_eq!(live[0].session_live, Some(true));
    }

    #[test]
    fn a_worktree_git_no_longer_lists_is_gone_and_an_unreadable_repo_says_nothing() {
        let with = |wt: &str| Item { worktree: Some(wt.into()), ..item("a", State::Running) };
        let listed = HashMap::from([("/p".to_string(), Some(vec![PathBuf::from("/p/wt-1")]))]);
        let rows = reconcile(&[with("/p/wt-1"), with("/p/wt-2")], &HashSet::new(), &listed);
        assert_eq!((rows[0].worktree_gone, rows[1].worktree_gone), (Some(false), Some(true)));
        assert_eq!(rows[1].item.state, State::Running, "a missing worktree is reported, never stored");

        let unreadable = HashMap::from([("/p".to_string(), None)]);
        assert_eq!(reconcile(&[with("/p/wt-2")], &HashSet::new(), &unreadable)[0].worktree_gone, None);
    }

    #[test]
    fn every_write_and_an_items_session_ending_publish_a_change() {
        let dir = temp_dir("publish");
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let store = AutopilotStore::open(dir.clone(), Box::new(move |event| tx.lock().unwrap().send(event).unwrap()));
        store.update(issue("1"), Patch { session: Some("s1".into()), ..Patch::default() }).unwrap();
        assert_eq!(rx.try_recv().unwrap()["kind"], "autopilot.changed");
        store.session_ended("other");
        assert!(rx.try_recv().is_err(), "a session no item names moves nothing");
        store.session_ended("s1");
        let event = rx.try_recv().unwrap();
        assert_eq!((event["item"]["session"].clone(), event["item"]["session_live"].clone()), (json!("s1"), json!(false)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
