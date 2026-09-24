//! The autopilot's queue, kept under `~/.config/tori/autopilot/` so a restart
//! hands back the same items. Only what a model decided is stored: whether an
//! item's session is live and whether its worktree is still there are derived
//! on every read, so a relaunch can never rewrite a state. See
//! [[adr_autopilot_is_a_session_not_a_state_machine]].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::owned_state::{now_ms, write_atomically};
use crate::rpc::events::same_folder;

const QUEUE: &str = "queue.json";
const PROJECTS: &str = "projects.json";
const LOG: &str = "log.jsonl";

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
        Self { dir, held: Mutex::new(held), unreadable, publish, closed: Box::new(|_| {}) }
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
        let (item, was_open) = {
            let mut held = self.lock();
            let mut next = held.items.clone();
            let mint = || format!("item-{}", crate::chat::approval::random_token());
            let before = |id: &str| held.items.iter().find(|i| i.id == id).map(|i| i.state);
            let item = apply(&mut next, target, patch, now_ms(), mint)?;
            let was_open = before(&item.id).is_none_or(|state| !state.terminal());
            self.save(QUEUE, json!({ "items": next }))?;
            held.items = next;
            self.log(json!({ "item": item }));
            (item, was_open)
        };
        self.changed(&item, None);
        if was_open && item.state.terminal() {
            (self.closed)(&item.id);
        }
        Ok(item)
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

    // `observe` runs unlocked, since it shells out to git and later the forge;
    // the rows are built from the items as they are after it, so an update
    // landing meanwhile is neither lost nor waited on.
    pub fn state(&self, observe: impl FnOnce(&[Item]) -> Observed) -> Snapshot {
        let snapshot = self.lock().items.clone();
        let seen = observe(&snapshot);
        let held = self.lock();
        Snapshot { items: reconcile(&held.items, &seen.live, &seen.worktrees), projects: held.projects.clone() }
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
        }
    }

    #[test]
    fn a_reopened_store_reads_back_what_was_written() {
        let dir = temp_dir("round-trip");
        let store = quiet(&dir);
        let made = store.update(issue("12"), Patch { session: Some("s1".into()), note: Some("started".into()), ..state(State::Running) }).unwrap();
        let again = quiet(&dir);
        assert_eq!(again.lock().items, vec![made.clone()]);
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
