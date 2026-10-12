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
//!
//! It also keeps the overlaps: a file two live sessions in different worktrees
//! of one repository both recorded writing, while both worktrees still carry
//! it against their base. A session in a terminal tab records no writes, so it
//! never overlaps.

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

/// One session's half of a file two worktrees fight over. Every overlap is
/// listed from both sides, so a reader filters by its own session or folder.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Overlap {
    pub session: String,
    pub path: String,
    /// Relative to the worktree root, the same in both worktrees.
    pub file: String,
    pub other_session: String,
    pub other_path: String,
    /// What the other worktree has checked out now, `None` when detached.
    pub other_branch: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    pub enabled: bool,
    pub units: Vec<Answer>,
    pub overlaps: Vec<Overlap>,
}

/// What a sweep announces. `overlaps` is the whole new list, and absent when it
/// did not change.
#[derive(Debug, Serialize)]
pub struct Changed {
    pub units: Vec<Answer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overlaps: Option<Vec<Overlap>>,
}

/// What a live session wrote that its worktree still carries against the base.
#[derive(Debug, Clone)]
struct SessionWrites {
    folder: String,
    top: String,
    common: PathBuf,
    branch: Option<String>,
    files: HashSet<String>,
}

/// `None` is kept too, so a session with no writes is not re-read every batch.
type Sides = HashMap<String, Option<SessionWrites>>;

#[derive(Default)]
struct Radar {
    drawn: HashSet<Unit>,
    answers: HashMap<Unit, Option<Vec<String>>>,
    /// Units measured against a local branch, the only base a commit here moves.
    local_base: HashSet<Unit>,
    sides: Sides,
    overlaps: Vec<Overlap>,
    was_enabled: Option<bool>,
}

/// What the radar needs from the rest of the app, handed in at start so this
/// module reaches neither the session store nor the hub itself.
pub struct Hooks {
    /// Folders with a live session or an open autopilot item.
    pub watched: Box<dyn Fn() -> Vec<String> + Send>,
    /// Every live session, idle ones included, with its folder.
    pub live: Box<dyn Fn() -> Vec<(String, String)> + Send>,
    /// Folders worth an answer before any row is drawn: open autopilot items.
    pub at_start: Box<dyn Fn() -> Vec<String> + Send>,
    pub publish: Publish,
}

pub type Publish = Box<dyn Fn(&Changed) + Send + Sync>;

enum Job {
    Moved(String),
    Committed(String),
    /// Only a session that is new to the list costs any git.
    Sessions,
    All,
}

#[derive(Default)]
struct Batch {
    all: bool,
    dirs: HashSet<PathBuf>,
    folders: Vec<String>,
}

impl Batch {
    fn moves_refs(&self) -> bool {
        self.all || !self.dirs.is_empty() || !self.folders.is_empty()
    }

    fn stales(&self, side: &SessionWrites) -> bool {
        self.all
            || self.dirs.contains(&side.common)
            || self
                .folders
                .iter()
                .any(|f| crate::rpc::events::same_folder(f, &side.folder))
    }
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
        live,
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
            if batch.moves_refs() {
                let folders = watched();
                let units = {
                    let radar = radar();
                    in_scope(&radar.drawn, &radar.local_base, folders, &batch)
                };
                sweep(units);
            }
            refresh_overlaps(&batch, live());
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
            Job::Sessions => {}
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

/// A session started, ended or changed state, so the set of live sides may
/// have moved.
pub fn sessions_changed() {
    if enabled() {
        send(Job::Sessions);
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
            None
        } else {
            radar.sides.clear();
            let had = !std::mem::take(&mut radar.overlaps).is_empty();
            Some(Changed {
                units: switched_off(&mut radar.answers),
                overlaps: had.then(Vec::new),
            })
        }
    };
    match cleared {
        Some(changed) => announce(changed),
        None => send(Job::All),
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

/// What the radar holds against one session, for the Inbox score.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SessionSignals {
    /// Files a merge of the base into the session's folder would conflict on.
    pub conflicts: u32,
    /// Files a live session in another worktree is changing too.
    pub overlaps: u32,
}

pub fn session_signals(session: &str, folder: &str) -> SessionSignals {
    let (held, overlaps) = {
        let radar = radar();
        let held = radar.answers.get(&Unit::checked_out(folder.to_string())).cloned();
        (held, overlap_files(&radar.overlaps, session))
    };
    gated_session_signals(
        enabled(),
        || overlaps,
        || held.unwrap_or_else(|| crate::git::unit_conflicts(folder, None).conflicts),
    )
}

fn overlap_files(overlaps: &[Overlap], session: &str) -> u32 {
    let files: HashSet<&str> = overlaps
        .iter()
        .filter(|o| o.session == session)
        .map(|o| o.file.as_str())
        .collect();
    files.len() as u32
}

/// The conflicts are asked for on a miss, not only read from a sweep: a session
/// the Inbox lists may have ended, and nothing sweeps an ended session's folder.
fn gated_session_signals(
    enabled: bool,
    overlaps: impl FnOnce() -> u32,
    conflicts: impl FnOnce() -> Option<Vec<String>>,
) -> SessionSignals {
    if !enabled {
        return SessionSignals::default();
    }
    SessionSignals {
        conflicts: conflicts().map_or(0, |c| c.len() as u32),
        overlaps: overlaps(),
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct View {
    pub overlaps: Vec<Overlap>,
    pub conflicts: HashMap<String, Option<Vec<String>>>,
}

pub fn view<'a>(worktrees: impl IntoIterator<Item = &'a str>) -> Option<View> {
    if !enabled() {
        return None;
    }
    let (overlaps, held) = {
        let radar = radar();
        let held: Vec<_> = worktrees
            .into_iter()
            .map(|wt| {
                let answer = radar.answers.get(&Unit::checked_out(wt.to_string())).cloned();
                (wt.to_string(), answer)
            })
            .collect();
        (radar.overlaps.clone(), held)
    };
    let conflicts = held
        .into_iter()
        .map(|(wt, answer)| {
            let answer = answer.unwrap_or_else(|| crate::git::unit_conflicts(&wt, None).conflicts);
            (wt, answer)
        })
        .collect();
    Some(View { overlaps, conflicts })
}

pub fn list() -> Listing {
    let radar = radar();
    listing(enabled(), &radar.answers, &radar.overlaps)
}

/// The same listing for the webview, which is not a socket client.
#[tauri::command]
pub fn radar_list() -> Listing {
    list()
}

fn listing(enabled: bool, answers: &HashMap<Unit, Option<Vec<String>>>, overlaps: &[Overlap]) -> Listing {
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
    let overlaps = if enabled { overlaps.to_vec() } else { Vec::new() };
    Listing {
        enabled,
        units,
        overlaps,
    }
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
        // Switched off while the answers were being computed: they are stale.
        if radar.was_enabled == Some(false) {
            return;
        }
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
    announce(Changed {
        units: changed,
        overlaps: None,
    });
}

fn refresh_overlaps(batch: &Batch, live: Vec<(String, String)>) {
    // Taken out for the git calls, so a row's read never waits behind them.
    let mut sides = std::mem::take(&mut radar().sides);
    sides.retain(|_, side| side.as_ref().is_none_or(|s| !batch.stales(s)));
    let overlaps = gated_overlaps(enabled(), &live, &mut sides, crate::checkpoint::touched_files, side_of);
    let changed = {
        let mut radar = radar();
        if radar.was_enabled == Some(false) {
            return;
        }
        radar.sides = sides;
        (radar.overlaps != overlaps).then(|| {
            radar.overlaps = overlaps.clone();
            overlaps
        })
    };
    if let Some(overlaps) = changed {
        announce(Changed {
            units: Vec::new(),
            overlaps: Some(overlaps),
        });
    }
}

fn gated_overlaps(
    enabled: bool,
    live: &[(String, String)],
    sides: &mut Sides,
    read: impl Fn(&str) -> Vec<String>,
    measure: impl Fn(&str, &[String]) -> Option<SessionWrites>,
) -> Vec<Overlap> {
    if !enabled {
        sides.clear();
        return Vec::new();
    }
    sides.retain(|id, _| live.iter().any(|(live_id, _)| live_id == id));
    for (id, folder) in live {
        if !sides.contains_key(id) {
            let touched = read(id);
            sides.insert(id.clone(), measure(folder, &touched));
        }
    }
    intersect(live, sides)
}

/// A session's side, from the absolute paths it recorded writing.
fn side_of(folder: &str, touched: &[String]) -> Option<SessionWrites> {
    if touched.is_empty() {
        return None;
    }
    let (top, given) = crate::git::worktree_roots(folder)?;
    let changed = crate::git::changed_since_base(&top)?;
    let files = touched
        .iter()
        .filter_map(|f| crate::checkpoint::relative_to(&top, f).or_else(|| crate::checkpoint::relative_to(&given, f)))
        .filter(|f| changed.contains(f))
        .collect();
    Some(SessionWrites {
        folder: folder.to_string(),
        common: crate::exec::common_dir(&top),
        branch: crate::git::current_branch(&top),
        top,
        files,
    })
}

fn intersect(live: &[(String, String)], sides: &Sides) -> Vec<Overlap> {
    let present: Vec<(&String, &SessionWrites)> = live
        .iter()
        .filter_map(|(id, _)| sides.get(id).and_then(Option::as_ref).map(|s| (id, s)))
        .collect();
    let mut out = Vec::new();
    for (id, side) in &present {
        for (other_id, other) in &present {
            if id == other_id || side.common != other.common || side.top == other.top {
                continue;
            }
            for file in side.files.intersection(&other.files) {
                out.push(Overlap {
                    session: (*id).clone(),
                    path: side.folder.clone(),
                    file: file.clone(),
                    other_session: (*other_id).clone(),
                    other_path: other.folder.clone(),
                    other_branch: other.branch.clone(),
                });
            }
        }
    }
    out.sort();
    out
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

fn announce(changed: Changed) {
    if changed.units.is_empty() && changed.overlaps.is_none() {
        return;
    }
    if let Some(publish) = PUBLISH.get() {
        publish(&changed);
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

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t.test")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repo on `main` pushed to a bare origin, with worktrees `one` and `two`
    /// branched off it side by side.
    fn two_worktrees() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "tori_radar_test_{}_{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let (remote, main) = (root.join("remote.git"), root.join("main"));
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&main).unwrap();
        git(&remote, &["init", "--bare", "-q"]);
        git(&main, &["init", "-q"]);
        git(&main, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        std::fs::write(main.join("a.rs"), "base").unwrap();
        std::fs::write(main.join("b.rs"), "base").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-qm", "init"]);
        git(&main, &["remote", "add", "origin", &remote.to_string_lossy()]);
        git(&main, &["push", "-q", "-u", "origin", "main"]);
        for name in ["one", "two"] {
            git(
                &main,
                &["worktree", "add", "-q", "-b", name, &root.join(name).to_string_lossy()],
            );
        }
        root
    }

    #[test]
    fn two_worktrees_writing_one_file_overlap_from_both_sides_until_one_lets_go() {
        let root = two_worktrees();
        let (one, two) = (root.join("one"), root.join("two"));
        std::fs::write(one.join("a.rs"), "one").unwrap();
        std::fs::write(one.join("b.rs"), "only one").unwrap();
        std::fs::write(two.join("a.rs"), "two").unwrap();
        let path = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let touched: HashMap<&str, Vec<String>> = [
            ("s1", vec![path(&one.join("a.rs")), path(&one.join("b.rs"))]),
            ("s2", vec![path(&two.join("a.rs"))]),
        ]
        .into_iter()
        .collect();
        let reads = std::cell::Cell::new(0u32);
        let read = |id: &str| {
            reads.set(reads.get() + 1);
            touched.get(id).cloned().unwrap_or_default()
        };
        let both = vec![("s1".to_string(), path(&one)), ("s2".to_string(), path(&two))];
        let mut sides = Sides::new();

        let found = gated_overlaps(true, &both, &mut sides, read, side_of);
        let pair = |other_branch: &str| {
            vec![
                Overlap {
                    session: "s1".into(),
                    path: path(&one),
                    file: "a.rs".into(),
                    other_session: "s2".into(),
                    other_path: path(&two),
                    other_branch: Some(other_branch.into()),
                },
                Overlap {
                    session: "s2".into(),
                    path: path(&two),
                    file: "a.rs".into(),
                    other_session: "s1".into(),
                    other_path: path(&one),
                    other_branch: Some("one".into()),
                },
            ]
        };
        assert_eq!(found, pair("two"), "b.rs is one's alone");

        git(&two, &["checkout", "-q", "-b", "three"]);
        sides.clear();
        assert_eq!(
            gated_overlaps(true, &both, &mut sides, read, side_of),
            pair("three"),
            "the other branch is read off the worktree now"
        );

        git(&two, &["checkout", "-q", "--", "a.rs"]);
        sides.remove("s2");
        assert!(
            gated_overlaps(true, &both, &mut sides, read, side_of).is_empty(),
            "two's a.rs is back at base"
        );

        std::fs::write(two.join("a.rs"), "two again").unwrap();
        sides.remove("s2");
        let only_two = vec![("s2".to_string(), path(&two))];
        assert!(
            gated_overlaps(true, &only_two, &mut sides, read, side_of).is_empty(),
            "s1 ended"
        );

        let before = reads.get();
        sides.clear();
        assert!(gated_overlaps(false, &both, &mut sides, read, side_of).is_empty());
        assert_eq!(reads.get(), before, "off reads no touched record");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_session_counts_its_own_overlapping_files_once_and_nothing_while_off() {
        let overlap = |session: &str, file: &str, other: &str| Overlap {
            session: session.into(),
            path: "/r".into(),
            file: file.into(),
            other_session: other.into(),
            other_path: "/o".into(),
            other_branch: None,
        };
        let overlaps = vec![
            overlap("s1", "a.rs", "s2"),
            overlap("s1", "a.rs", "s3"),
            overlap("s1", "b.rs", "s2"),
            overlap("s2", "a.rs", "s1"),
        ];
        assert_eq!(overlap_files(&overlaps, "s1"), 2);
        assert_eq!(
            gated_session_signals(true, || 2, || Some(vec!["x".into(), "y".into()])),
            SessionSignals {
                conflicts: 2,
                overlaps: 2
            }
        );
        let asked = std::cell::Cell::new(false);
        let off = gated_session_signals(
            false,
            || 2,
            || {
                asked.set(true);
                Some(vec!["x".into()])
            },
        );
        assert_eq!(off, SessionSignals::default());
        assert!(!asked.get(), "off runs no merge");
    }

    #[test]
    fn the_listing_holds_a_swept_unit_no_row_drew_and_nothing_while_off() {
        let mut answers = HashMap::new();
        apply(&mut answers, vec![(unit("/wt"), paths(&["f.rs"]))]);
        let on = listing(true, &answers, &[]);
        assert!(on.enabled);
        assert_eq!(on.units[0].conflicts, paths(&["f.rs"]));
        let off = listing(false, &answers, &[]);
        assert!(!off.enabled);
        assert!(off.units.is_empty());
    }
}
