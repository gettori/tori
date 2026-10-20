//! Ports per worktree: a block of ten handed to everything Tori spawns in a
//! checkout, and the dev servers actually listening from each one.
//!
//! The two halves are independent on purpose. The scan finds a server on any
//! port, whether or not it read `TORI_PORT`, by the listener's cwd; the block is
//! what an agent can know before it starts anything.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::State;

const BLOCK: u16 = 10;

// Below the macOS ephemeral range (49152 and up), where the kernel picks source
// ports for outgoing connections, and apart so a dev build never hands out a
// block the installed app holds.
const RANGE: (u16, u16) = if cfg!(debug_assertions) {
    (45000, 48990)
} else {
    (40000, 44990)
};

const PROBE: Duration = Duration::from_millis(50);

fn registry_dir() -> PathBuf {
    if cfg!(test) {
        std::env::temp_dir().join(format!("tori-ports-{}", std::process::id()))
    } else {
        crate::owned_state::config_dir()
    }
}

/// `TORI_PORT` and `TORI_PORT_1` to `TORI_PORT_9` for a process starting in
/// `cwd`, or nothing when `cwd` is in no checkout.
pub fn env_for(cwd: &Path) -> Vec<(String, String)> {
    let Some(base) = root_of(cwd).and_then(|root| block_for(&registry_dir(), &root, answers)) else {
        return Vec::new();
    };
    (0..BLOCK)
        .map(|i| {
            let name = if i == 0 {
                "TORI_PORT".to_string()
            } else {
                format!("TORI_PORT_{i}")
            };
            (name, (base + i).to_string())
        })
        .collect()
}

/// Free the block of a worktree that is gone. `root` must be the path
/// canonicalized while the folder still existed.
pub fn release(root: &Path) {
    let dir = registry_dir();
    let _lock = lock(&dir);
    let mut map = load(&dir);
    if map.remove(&key(root)).is_some() {
        save(&dir, &map);
    }
}

#[cfg(test)]
pub(crate) fn holds(root: &Path) -> bool {
    load(&registry_dir()).contains_key(&key(root))
}

fn root_of(cwd: &Path) -> Option<PathBuf> {
    let cwd = std::fs::canonicalize(cwd).ok()?;
    cwd.ancestors().find(|dir| is_checkout_root(dir)).map(Path::to_path_buf)
}

fn is_checkout_root(dir: &Path) -> bool {
    let git = dir.join(".git");
    if git.is_dir() {
        return true;
    }
    let Ok(text) = std::fs::read_to_string(&git) else {
        return false;
    };
    text.trim()
        .strip_prefix("gitdir:")
        .is_some_and(|gitdir| !is_submodule(&dir.join(gitdir.trim())))
}

// A linked worktree's gitdir sits in a `worktrees` folder, even a worktree of a
// submodule; a submodule's own gitdir sits under `modules`.
fn is_submodule(gitdir: &Path) -> bool {
    let parent = gitdir.parent().and_then(Path::file_name);
    parent.is_some_and(|p| p != "worktrees") && gitdir.components().any(|c| c.as_os_str() == "modules")
}

fn block_for(dir: &Path, root: &Path, taken: impl Fn(u16) -> bool) -> Option<u16> {
    // Read unlocked first: every PTY spawn lands here on the sync IPC thread, and
    // only a first allocation needs the lock and the probes.
    if let Some(base) = load(dir).get(&key(root)) {
        return Some(*base);
    }
    let _lock = lock(dir);
    let mut map = load(dir);
    let before = map.len();
    map.retain(|path, _| Path::new(path).is_dir());
    let root = key(root);
    if let Some(base) = map.get(&root) {
        let base = *base;
        if map.len() != before {
            save(dir, &map);
        }
        return Some(base);
    }
    let used: HashSet<u16> = map.values().copied().collect();
    let base = (RANGE.0..=RANGE.1)
        .step_by(BLOCK as usize)
        .find(|b| !used.contains(b) && !(*b..*b + BLOCK).any(&taken))?;
    map.insert(root, base);
    save(dir, &map);
    Some(base)
}

fn answers(port: u16) -> bool {
    let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let v6 = SocketAddr::from((Ipv6Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&v4, PROBE).is_ok() || TcpStream::connect_timeout(&v6, PROBE).is_ok()
}

fn key(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

// The app and the daemon both spawn into worktrees, so two processes allocate.
fn lock(dir: &Path) -> Option<std::fs::File> {
    std::fs::create_dir_all(dir).ok()?;
    crate::exec::flock(&dir.join("ports.lock"), true)
}

fn load(dir: &Path) -> BTreeMap<String, u16> {
    std::fs::read_to_string(dir.join("ports.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(dir: &Path, map: &BTreeMap<String, u16>) {
    if let Ok(text) = serde_json::to_string_pretty(map) {
        let _ = crate::owned_state::write_atomically(&dir.join("ports.json"), &text);
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Listener {
    pid: u32,
    port: u16,
    cwd: String,
}

pub const CACHE: Duration = Duration::from_secs(2);

/// How old a scan may be before a port nobody owns is looked for again, since
/// a server that just started is the usual reason for a miss.
pub const MISS: Duration = Duration::from_millis(500);

static LAST: Mutex<Vec<Listener>> = Mutex::new(Vec::new());
static SCANNED: Mutex<Option<Instant>> = Mutex::new(None);
static SCANNING: Mutex<()> = Mutex::new(());
static EXCLUDED: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// The window's scan, answered by the daemon so the window and every socket
/// caller see one scan.
#[tauri::command(async)]
pub fn ports_scan(
    worktrees: Vec<String>,
    lsp: State<crate::lsp::LspState>,
    dap: State<crate::dap::DapState>,
) -> Result<BTreeMap<String, Vec<u16>>, String> {
    let exclude: Vec<u32> = lsp.pids().into_iter().chain(dap.pids()).collect();
    crate::rpc::office_call_as(
        "ports.scan",
        serde_json::json!({ "worktrees": worktrees, "exclude": exclude }),
    )
}

#[tauri::command(async)]
pub fn browser_open(port: u16) -> Result<(), String> {
    open_in_browser(port)
}

pub fn open_in_browser(port: u16) -> Result<(), String> {
    let url = format!("http://localhost:{port}/");
    let record = serde_json::json!({ "op": "browser.opening", "args": { "url": url } });
    // A stalled daemon must not hold the browser back; the record only saves a tab.
    if let Err(e) = crate::rpc::daemon_wait("office", record, Duration::from_secs(1)) {
        eprintln!("browser_open: the daemon did not hear {url}: {e}");
    }
    crate::exec::spawn_detached(std::process::Command::new("open").arg(url)).map_err(|e| e.to_string())
}

pub fn tell_excluded(app: &tauri::AppHandle) {
    use tauri::Manager;
    let lsp = app.state::<crate::lsp::LspState>().pids();
    let pids: Vec<u32> = lsp
        .into_iter()
        .chain(app.state::<crate::dap::DapState>().pids())
        .collect();
    crate::rpc::office_tell("ports.exclude", serde_json::json!({ "pids": pids }));
}

pub fn exclude(pids: Vec<u32>) {
    *EXCLUDED.lock().unwrap_or_else(PoisonError::into_inner) = pids;
}

pub fn scan(worktrees: &[String], max_age: Duration) -> BTreeMap<String, Vec<u16>> {
    let exclude: HashSet<u32> = EXCLUDED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .copied()
        .collect();
    attribute(&listeners(max_age), worktrees, &exclude, &load(&registry_dir()))
}

pub fn cwd_of(port: u16, max_age: Duration) -> Option<String> {
    listeners(max_age).into_iter().find(|l| l.port == port).map(|l| l.cwd)
}

/// The block base of each of `folders` that holds one, never allocating.
pub fn bases(folders: &[String]) -> HashMap<String, u16> {
    let map = load(&registry_dir());
    folders
        .iter()
        .filter_map(|f| {
            let canonical = std::fs::canonicalize(f).ok()?;
            map.get(&key(&canonical)).map(|base| (f.clone(), *base))
        })
        .collect()
}

// One lsof at a time.
fn listeners(max_age: Duration) -> Vec<Listener> {
    let asked = Instant::now();
    let _one = SCANNING.lock().unwrap_or_else(PoisonError::into_inner);
    let scanned = *SCANNED.lock().unwrap_or_else(PoisonError::into_inner);
    if answered_by(scanned, asked, max_age) {
        return LAST.lock().unwrap_or_else(PoisonError::into_inner).clone();
    }
    let started = Instant::now();
    let seen = remember(&LAST, scan_lsof());
    *SCANNED.lock().unwrap_or_else(PoisonError::into_inner) = Some(started);
    seen
}

fn answered_by(scanned: Option<Instant>, asked: Instant, max_age: Duration) -> bool {
    scanned.is_some_and(|at| at >= asked || asked.duration_since(at) <= max_age)
}

// A scan that times out answers with the last one rather than with nothing,
// so a hung lsof does not blank every link.
fn remember(last: &Mutex<Vec<Listener>>, fresh: Option<Vec<Listener>>) -> Vec<Listener> {
    let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(fresh) = fresh {
        *last = fresh;
    }
    last.clone()
}

fn scan_lsof() -> Option<Vec<Listener>> {
    let out = lsof(&["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"])?;
    let ports = parse_listening(&out);
    if ports.is_empty() {
        return Some(Vec::new());
    }
    let pids: Vec<String> = ports.keys().map(u32::to_string).collect();
    let cwds = parse_cwds(&lsof(&["-a", "-d", "cwd", "-p", &pids.join(","), "-F", "pn"])?);
    Some(
        ports
            .into_iter()
            .filter_map(|(pid, ports)| cwds.get(&pid).map(|cwd| (pid, ports, cwd.clone())))
            .flat_map(|(pid, ports, cwd)| {
                ports.into_iter().map(move |port| Listener {
                    pid,
                    port,
                    cwd: cwd.clone(),
                })
            })
            .collect(),
    )
}

// `-b` keeps lsof off kernel calls that block on a dead mount, `-w` drops the
// warnings that would come with it. Exit 1 means no match, so the code is not read.
fn lsof(args: &[&str]) -> Option<String> {
    let out = crate::env::output_with_timeout(Command::new("/usr/sbin/lsof").args(["-b", "-w"]).args(args))?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn parse_listening(out: &str) -> BTreeMap<u32, Vec<u16>> {
    let mut ports: BTreeMap<u32, Vec<u16>> = BTreeMap::new();
    let mut pid = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(name), Some(pid)) = (line.strip_prefix('n'), pid) {
            if let Some(port) = name.rsplit(':').next().and_then(|p| p.parse().ok()) {
                let list = ports.entry(pid).or_default();
                if !list.contains(&port) {
                    list.push(port);
                }
            }
        }
    }
    ports
}

fn parse_cwds(out: &str) -> HashMap<u32, String> {
    let mut cwds = HashMap::new();
    let mut pid = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(name), Some(pid)) = (line.strip_prefix('n'), pid) {
            cwds.insert(pid, name.to_string());
        }
    }
    cwds
}

// By cwd first, then by block: a port in a worktree's block is that worktree's
// even when the process listening runs elsewhere, as Docker's does.
fn attribute(
    listeners: &[Listener],
    worktrees: &[String],
    exclude: &HashSet<u32>,
    blocks: &BTreeMap<String, u16>,
) -> BTreeMap<String, Vec<u16>> {
    let roots: Vec<(&String, String)> = worktrees
        .iter()
        .map(|w| {
            let canonical = std::fs::canonicalize(w).map_or_else(|_| w.clone(), |p| key(&p));
            (w, canonical)
        })
        .collect();
    let mut out: BTreeMap<String, Vec<u16>> = BTreeMap::new();
    for l in listeners.iter().filter(|l| !exclude.contains(&l.pid)) {
        let owner = roots
            .iter()
            .filter(|(_, root)| l.cwd == *root || l.cwd.starts_with(&format!("{}/", root.trim_end_matches('/'))))
            .max_by_key(|(_, root)| root.len())
            .or_else(|| {
                roots
                    .iter()
                    .find(|(_, root)| blocks.get(root).is_some_and(|b| (*b..*b + BLOCK).contains(&l.port)))
            });
        if let Some((given, _)) = owner {
            let ports = out.entry((*given).clone()).or_default();
            if !ports.contains(&l.port) {
                ports.push(l.port);
            }
        }
    }
    for ports in out.values_mut() {
        ports.sort_unstable();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tori-ports-test-{}-{}-{name}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn checkout(name: &str) -> PathBuf {
        let dir = tmp(name);
        std::fs::create_dir(dir.join(".git")).unwrap();
        dir
    }

    const FREE: fn(u16) -> bool = |_| false;

    #[test]
    fn a_worktree_keeps_its_block_and_a_second_gets_another() {
        let reg = tmp("reg");
        let (a, b) = (checkout("a"), checkout("b"));
        let first = block_for(&reg, &a, FREE).unwrap();
        assert_eq!(block_for(&reg, &a, FREE), Some(first));
        let second = block_for(&reg, &b, FREE).unwrap();
        assert_ne!(first, second);
        assert_eq!(second, first + BLOCK);
    }

    #[test]
    fn a_port_already_answering_skips_its_whole_block() {
        let reg = tmp("reg");
        let a = checkout("a");
        let base = block_for(&reg, &a, |p| p == RANGE.0 + 3).unwrap();
        assert_eq!(base, RANGE.0 + BLOCK);
    }

    #[test]
    fn a_vanished_folder_frees_its_block_on_load() {
        let reg = tmp("reg");
        let (a, b) = (checkout("a"), checkout("b"));
        let freed = block_for(&reg, &a, FREE).unwrap();
        std::fs::remove_dir_all(&a).unwrap();
        assert_eq!(block_for(&reg, &b, FREE), Some(freed));
        assert!(!load(&reg).contains_key(&key(&a)));
    }

    #[test]
    fn a_subfolder_resolves_to_its_checkout() {
        let a = checkout("a");
        std::fs::create_dir_all(a.join("packages/web")).unwrap();
        assert_eq!(root_of(&a.join("packages/web")), Some(a));
    }

    #[test]
    fn a_submodule_resolves_to_its_superproject_but_a_worktree_is_its_own_root() {
        let a = checkout("a");
        let sub = a.join("libs/sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(".git"), "gitdir: ../../.git/modules/libs/sub\n").unwrap();
        assert_eq!(root_of(&sub), Some(a.clone()));

        let wt = tmp("wt");
        std::fs::write(wt.join(".git"), "gitdir: /repo/.git/modules/sub/worktrees/wt\n").unwrap();
        assert_eq!(root_of(&wt), Some(wt.clone()));

        let linked = tmp("linked");
        std::fs::write(linked.join(".git"), "gitdir: /repo/.git/worktrees/linked\n").unwrap();
        assert_eq!(root_of(&linked), Some(linked.clone()));
    }

    #[test]
    fn a_folder_in_no_checkout_gets_no_env() {
        assert!(root_of(&tmp("lone")).is_none());
        assert!(env_for(&tmp("lone")).is_empty());
    }

    #[test]
    fn env_names_the_base_and_nine_after_it() {
        let a = checkout("a");
        let env = env_for(&a);
        assert_eq!(env.len(), 10);
        assert_eq!(env[0].0, "TORI_PORT");
        assert_eq!(env[9].0, "TORI_PORT_9");
        let base: u16 = env[0].1.parse().unwrap();
        assert_eq!(env[9].1, (base + 9).to_string());
        assert_eq!(env_for(&a), env);
    }

    #[test]
    fn a_scan_that_times_out_answers_with_the_last_one() {
        let last = Mutex::new(Vec::new());
        let seen = vec![Listener {
            pid: 1,
            port: 5173,
            cwd: "/w/a".into(),
        }];
        assert_eq!(remember(&last, Some(seen.clone())), seen);
        assert_eq!(remember(&last, None), seen);
        assert!(remember(&last, Some(Vec::new())).is_empty());
    }

    #[test]
    fn answers_sees_an_ipv6_only_listener() {
        let l = TcpListener::bind("[::1]:0").expect("every Mac has ::1");
        assert!(answers(l.local_addr().unwrap().port()));
    }

    const LISTEN: &str = "p100\nn*:5173\nn[::1]:5173\np200\nn127.0.0.1:3000\np300\nn[::1]:6006\np400\nn*:9000\n";

    #[test]
    fn listening_output_parses_ipv4_ipv6_and_wildcard_binds() {
        let ports = parse_listening(LISTEN);
        assert_eq!(ports[&100], vec![5173]);
        assert_eq!(ports[&200], vec![3000]);
        assert_eq!(ports[&300], vec![6006]);
        assert_eq!(ports[&400], vec![9000]);
    }

    #[test]
    fn cwd_output_parses_per_pid() {
        let cwds = parse_cwds("p100\nfcwd\nn/w/a/packages/web\np200\nfcwd\nn/w/a/.tori/worktrees/b\n");
        assert_eq!(cwds[&100], "/w/a/packages/web");
        assert_eq!(cwds[&200], "/w/a/.tori/worktrees/b");
    }

    #[test]
    fn attribution_takes_the_deepest_worktree_and_drops_the_rest() {
        let l = |pid, port, cwd: &str| Listener {
            pid,
            port,
            cwd: cwd.to_string(),
        };
        let listeners = [
            l(100, 5173, "/w/a/packages/web"),
            l(200, 5174, "/w/a/.tori/worktrees/b"),
            l(300, 6006, "/elsewhere"),
            l(400, 9000, "/w/a"),
            l(500, 7000, "/w/ab"),
        ];
        let worktrees = vec!["/w/a".to_string(), "/w/a/.tori/worktrees/b".to_string()];
        let out = attribute(&listeners, &worktrees, &HashSet::from([400]), &BTreeMap::new());
        assert_eq!(out["/w/a"], vec![5173]);
        assert_eq!(out["/w/a/.tori/worktrees/b"], vec![5174]);
        assert_eq!(out.len(), 2);
    }
}
