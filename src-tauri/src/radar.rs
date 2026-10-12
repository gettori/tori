//! The conflict radar: for each branch unit, the paths a merge of its base
//! would conflict on, kept here so the sidebar, a phone, the CLI and the
//! autopilot all read one answer.
//!
//! A read through `git_branch_sync` computes on a miss and leaves its answer
//! here. Sweeps refresh the units somebody is looking at (a drawn row, a live
//! session's folder, an autopilot item's worktree) when something moved them,
//! and say so only for the units whose answer actually changed.
//!
//! A fetch or a re-pointed base can move any branch of the repository, so it
//! re-asks every watched unit there. A turn's commit moves one folder's branch,
//! which is another unit's base only when that base is a local branch.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::SystemTime;

use serde::Serialize;

pub const CHANGED_EVENT: &str = "radar://changed";

/// A sidebar row's identity: the folder and the branch it speaks for, empty
/// for whichever is checked out there.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct Unit {
    path: String,
    branch: String,
}

impl Unit {
    fn checked_out(path: String) -> Self {
        Self {
            path,
            branch: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Answer {
    pub path: String,
    pub branch: String,
    pub conflicts: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    pub enabled: bool,
    pub units: Vec<Answer>,
}

#[derive(Default)]
struct Radar {
    drawn: HashSet<Unit>,
    answers: HashMap<Unit, Option<Vec<String>>>,
    /// Units measured against a local branch, the only base a commit here moves.
    local_base: HashSet<Unit>,
    was_enabled: Option<bool>,
}

/// What the radar needs from the rest of the app, handed in at start so this
/// module reaches neither the session store nor the hub itself.
pub struct Hooks {
    /// Folders with a live session or an open autopilot item.
    pub watched: Box<dyn Fn() -> Vec<String> + Send>,
    /// Folders worth an answer before any row is drawn: open autopilot items.
    pub at_start: Box<dyn Fn() -> Vec<String> + Send>,
    pub publish: Publish,
}

pub type Publish = Box<dyn Fn(&[Answer]) + Send + Sync>;

enum Job {
    Moved(String),
    Committed(String),
    All,
}

#[derive(Default)]
struct Batch {
    all: bool,
    dirs: HashSet<PathBuf>,
    folders: Vec<String>,
}

static RADAR: OnceLock<Mutex<Radar>> = OnceLock::new();
static JOBS: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
static PUBLISH: OnceLock<Publish> = OnceLock::new();

fn radar() -> std::sync::MutexGuard<'static, Radar> {
    RADAR
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Whether the radar is on, re-read only when settings.json moves: every
/// branch row's sync asks this.
pub fn enabled() -> bool {
    static CACHE: Mutex<Option<(Option<SystemTime>, bool)>> = Mutex::new(None);
    let stamp = crate::settings::modified();
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((at, on)) = *cache {
        if at == stamp {
            return on;
        }
    }
    let on = crate::settings::conflict_radar().enabled;
    *cache = Some((stamp, on));
    on
}

/// Start the sweeper. Idempotent: a second call is ignored.
pub fn start(hooks: Hooks) {
    let (tx, rx) = mpsc::channel();
    if JOBS.set(Mutex::new(tx)).is_err() {
        return;
    }
    let Hooks {
        watched,
        at_start,
        publish,
    } = hooks;
    let _ = PUBLISH.set(publish);
    radar().was_enabled = Some(enabled());
    std::thread::spawn(move || {
        if enabled() {
            sweep(at_start().into_iter().map(Unit::checked_out).collect());
        }
        while let Some(batch) = next_batch(&rx) {
            if !enabled() {
                continue;
            }
            let folders = watched();
            let units = {
                let radar = radar();
                in_scope(&radar.drawn, &radar.local_base, folders, &batch)
            };
            sweep(units);
        }
    });
}

/// Block for one job, then take whatever else queued behind it, so a fetch
/// fanned out across ten folders of one container is one sweep.
fn next_batch(rx: &Receiver<Job>) -> Option<Batch> {
    let first = rx.recv().ok()?;
    let mut batch = Batch::default();
    for job in std::iter::once(first).chain(rx.try_iter()) {
        match job {
            Job::All => batch.all = true,
            Job::Moved(path) => {
                batch.dirs.insert(crate::exec::common_dir(&path));
            }
            Job::Committed(folder) => batch.folders.push(folder),
        }
    }
    Some(batch)
}

fn send(job: Job) {
    if let Some(tx) = JOBS.get() {
        let _ = tx.lock().unwrap_or_else(PoisonError::into_inner).send(job);
    }
}

/// Something moved refs across `path`'s repository: a fetch, a base
/// re-pointed. Every watched unit sharing its common dir is re-asked.
pub fn moved(path: &str) {
    if enabled() {
        send(Job::Moved(path.to_string()));
    }
}

/// A turn ended in `folder`, so its branch may have a new commit.
pub fn committed(folder: &str) {
    if enabled() {
        send(Job::Committed(folder.to_string()));
    }
}

/// A row's answer, computed by the read that drew it. Kept so the next sweep
/// can tell a change from a repeat, and never announced: the reader has it.
pub fn note_read(path: &str, branch: &str, conflicts: Option<Vec<String>>, local_base: bool) {
    let unit = Unit {
        path: path.to_string(),
        branch: branch.to_string(),
    };
    let mut radar = radar();
    if local_base {
        radar.local_base.insert(unit.clone());
    } else {
        radar.local_base.remove(&unit);
    }
    radar.answers.insert(unit, conflicts);
}

/// The rows the sidebar draws now, whole, so a row that left stops being swept.
#[tauri::command]
pub fn radar_set_drawn(units: Vec<crate::git::SyncUnit>) {
    let next: HashSet<Unit> = units
        .into_iter()
        .map(|u| Unit {
            path: u.path,
            branch: u.branch,
        })
        .collect();
    let mut radar = radar();
    let gone: Vec<Unit> = radar.drawn.difference(&next).cloned().collect();
    for unit in gone {
        radar.answers.remove(&unit);
        radar.local_base.remove(&unit);
    }
    radar.drawn = next;
}

/// The switch moved, by the panel or by hand. Off forgets every answer and
/// tells the readers so; on sweeps everything watched.
pub fn settings_changed() {
    let now = enabled();
    let cleared = {
        let mut radar = radar();
        if radar.was_enabled.replace(now) == Some(now) {
            return;
        }
        if now {
            Vec::new()
        } else {
            switched_off(&mut radar.answers)
        }
    };
    if now {
        send(Job::All);
    } else {
        announce(&cleared);
    }
}

fn switched_off(answers: &mut HashMap<Unit, Option<Vec<String>>>) -> Vec<Answer> {
    let mut gone: Vec<Answer> = answers
        .drain()
        .filter(|(_, conflicts)| conflicts.is_some())
        .map(|(unit, _)| Answer {
            path: unit.path,
            branch: unit.branch,
            conflicts: None,
        })
        .collect();
    gone.sort_by(|a, b| (&a.path, &a.branch).cmp(&(&b.path, &b.branch)));
    gone
}

pub fn list() -> Listing {
    listing(enabled(), &radar().answers)
}

fn listing(enabled: bool, answers: &HashMap<Unit, Option<Vec<String>>>) -> Listing {
    let mut units: Vec<Answer> = if enabled {
        answers
            .iter()
            .map(|(unit, conflicts)| Answer {
                path: unit.path.clone(),
                branch: unit.branch.clone(),
                conflicts: conflicts.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };
    units.sort_by(|a, b| (&a.path, &a.branch).cmp(&(&b.path, &b.branch)));
    Listing { enabled, units }
}

fn in_scope(drawn: &HashSet<Unit>, local_base: &HashSet<Unit>, watched: Vec<String>, batch: &Batch) -> Vec<Unit> {
    let mut units: Vec<Unit> = drawn
        .iter()
        .cloned()
        .chain(watched.into_iter().map(Unit::checked_out))
        .collect::<HashSet<_>>()
        .into_iter()
        .filter(|u| {
            batch.all
                || local_base.contains(u)
                || batch
                    .folders
                    .iter()
                    .any(|f| crate::rpc::events::same_folder(f, &u.path))
                || (!batch.dirs.is_empty() && batch.dirs.contains(&crate::exec::common_dir(&u.path)))
        })
        .collect();
    units.sort();
    units
}

fn sweep(units: Vec<Unit>) {
    // Outside the lock: each answer can be a merge-tree, and a row's read must
    // not wait behind a whole sweep.
    let fresh: Vec<(Unit, crate::git::UnitConflicts)> = units
        .into_iter()
        .map(|unit| {
            let want = (!unit.branch.is_empty()).then_some(unit.branch.as_str());
            let answer = crate::git::unit_conflicts(&unit.path, want);
            (unit, answer)
        })
        .collect();
    let changed = {
        let mut radar = radar();
        for (unit, answer) in &fresh {
            if answer.local_base {
                radar.local_base.insert(unit.clone());
            } else {
                radar.local_base.remove(unit);
            }
        }
        let fresh = fresh
            .into_iter()
            .map(|(unit, answer)| (unit, answer.conflicts))
            .collect();
        apply(&mut radar.answers, fresh)
    };
    announce(&changed);
}

/// Store fresh answers and return the ones that differ from what was held.
/// No answer and an unknown one are the same: neither draws anything.
fn apply(answers: &mut HashMap<Unit, Option<Vec<String>>>, fresh: Vec<(Unit, Option<Vec<String>>)>) -> Vec<Answer> {
    fresh
        .into_iter()
        .filter_map(|(unit, conflicts)| {
            let before = answers.insert(unit.clone(), conflicts.clone()).flatten();
            (before != conflicts).then_some(Answer {
                path: unit.path,
                branch: unit.branch,
                conflicts,
            })
        })
        .collect()
}

fn announce(changed: &[Answer]) {
    if changed.is_empty() {
        return;
    }
    if let Some(publish) = PUBLISH.get() {
        publish(changed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(path: &str) -> Unit {
        Unit::checked_out(path.to_string())
    }

    fn paths(list: &[&str]) -> Option<Vec<String>> {
        Some(list.iter().map(|p| p.to_string()).collect())
    }

    #[test]
    fn a_sweep_reports_only_the_answers_that_moved() {
        let mut answers = HashMap::new();
        let first = apply(
            &mut answers,
            vec![
                (unit("/a"), paths(&["f.rs"])),
                (unit("/b"), paths(&[])),
                (unit("/c"), None),
            ],
        );
        assert_eq!(
            first.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(),
            vec!["/a", "/b"],
            "an unknown answer for a unit never answered is not news"
        );

        let same = apply(
            &mut answers,
            vec![
                (unit("/a"), paths(&["f.rs"])),
                (unit("/b"), paths(&[])),
                (unit("/c"), None),
            ],
        );
        assert!(same.is_empty(), "nothing moved, nothing said: {same:?}");

        let moved = apply(&mut answers, vec![(unit("/a"), paths(&[])), (unit("/b"), None)]);
        assert_eq!(
            moved,
            vec![
                Answer {
                    path: "/a".into(),
                    branch: String::new(),
                    conflicts: paths(&[])
                },
                Answer {
                    path: "/b".into(),
                    branch: String::new(),
                    conflicts: None
                },
            ]
        );
    }

    #[test]
    fn the_listing_holds_a_swept_unit_no_row_drew_and_nothing_while_off() {
        let mut answers = HashMap::new();
        apply(&mut answers, vec![(unit("/wt"), paths(&["f.rs"]))]);
        let on = listing(true, &answers);
        assert!(on.enabled);
        assert_eq!(on.units[0].conflicts, paths(&["f.rs"]));
        let off = listing(false, &answers);
        assert!(!off.enabled);
        assert!(off.units.is_empty());
    }
}
