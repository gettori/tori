//! Who a repo's commits are authored as, when its account says so: one git
//! config file per account, included from the repo's own config.

use super::accounts::{self, Account, AccountsFile, Resolution};
use super::model::IdentityHint;
use super::ForgeError;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const KEYS: [&str; 2] = ["user.name", "user.email"];

pub fn files_dir() -> PathBuf {
    crate::owned_state::config_dir().join("git-accounts")
}

pub fn file_for(account_id: &str) -> PathBuf {
    files_dir().join(format!("{account_id}.gitconfig"))
}

pub fn suggestion(host: &str, hint: &IdentityHint) -> (String, String) {
    let name = hint.name.clone().unwrap_or_else(|| hint.login.clone());
    // Only the two public hosts have a noreply form Tori can be sure of.
    let noreply = match (host, hint.id) {
        _ if hint.login.is_empty() => None,
        (accounts::GITHUB_COM, Some(id)) => Some(format!("{id}+{}@users.noreply.github.com", hint.login)),
        (accounts::GITLAB_COM, Some(id)) => Some(format!("{id}-{}@users.noreply.gitlab.com", hint.login)),
        _ => None,
    };
    let email = noreply.or_else(|| hint.email.clone()).unwrap_or_default();
    (name, email)
}

pub fn write_file(account: &Account) -> Result<(), String> {
    write_file_in(&files_dir(), account)
}

fn write_file_in(dir: &Path, account: &Account) -> Result<(), String> {
    let path = dir.join(format!("{}.gitconfig", account.id));
    let Some((name, email)) = account.identity() else {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    for (key, value) in [("user.name", name), ("user.email", email)] {
        let out = crate::exec::git_outside_a_repo()
            .args(["config", "--file"])
            .arg(&tmp)
            .args([key, value])
            .output()
            .map_err(|e| format!("git could not run: {e}"))?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&tmp);
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// A checkout Tori may run git in, with the git dir every worktree of it shares.
struct Repo {
    path: String,
    common: PathBuf,
}

impl Repo {
    fn open(path: &str) -> Result<Self, String> {
        if !crate::trust::allows_git(Path::new(path)) {
            return Err(format!("{path} is not trusted, so Tori leaves its git config alone"));
        }
        let out = crate::exec::git_in(path)
            .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .output()
            .map_err(|e| format!("git could not run: {e}"))?;
        let common = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || common.is_empty() {
            return Err(format!("{path} is not a git repository"));
        }
        Ok(Self {
            path: path.to_string(),
            common: PathBuf::from(common),
        })
    }

    /// Lines git printed, where exit 1 means the key is simply unset.
    fn config_lines(&self, args: &[&str]) -> Result<Vec<String>, String> {
        let out = crate::exec::git_in(&self.path)
            .arg("config")
            .args(args)
            .output()
            .map_err(|e| format!("git could not run: {e}"))?;
        match out.status.code() {
            Some(0) => Ok(String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::to_string)
                .collect()),
            Some(1) => Ok(Vec::new()),
            _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        }
    }

    fn entries(&self, key: &str) -> Result<Vec<Entry>, String> {
        let lines = self.config_lines(&["--show-scope", "--show-origin", "--get-all", key])?;
        Ok(lines.iter().filter_map(|line| self.parse_entry(line)).collect())
    }

    fn parse_entry(&self, line: &str) -> Option<Entry> {
        let mut parts = line.splitn(3, '\t');
        let scope = parts.next()?.to_string();
        let origin = parts.next()?.strip_prefix("file:")?;
        let value = parts.next()?.to_string();
        let origin = origin
            .strip_prefix('"')
            .and_then(|o| o.strip_suffix('"'))
            .unwrap_or(origin);
        let origin = Path::new(origin);
        // git names the repo's own files relative to where it ran.
        let origin = if origin.is_absolute() {
            origin.to_path_buf()
        } else if scope == "local" {
            self.common.join("config")
        } else {
            Path::new(&self.path).join(origin)
        };
        Some(Entry { scope, origin, value })
    }

    fn own(&self, places: &Places) -> Result<Vec<(String, Entry)>, String> {
        let mut own = Vec::new();
        for key in KEYS {
            for entry in self.entries(key)? {
                if matches!(places.kind(&entry), Kind::Repo | Kind::Include) {
                    own.push((key.to_string(), entry));
                }
            }
        }
        Ok(own)
    }

    fn included(&self, places: &Places) -> Result<Vec<PathBuf>, String> {
        let lines = self.config_lines(&["--local", "--get-all", "include.path"])?;
        Ok(lines
            .into_iter()
            .map(PathBuf::from)
            .filter(|path| path.starts_with(&places.accounts))
            .collect())
    }

    /// Points the repo at one account file, or at none.
    fn apply(&self, want: Option<&Path>, places: &Places) -> Result<(), String> {
        let have = self.included(places)?;
        if have.len() <= 1 && have.first().map(PathBuf::as_path) == want {
            return Ok(());
        }
        for path in &have {
            let out = crate::exec::git_in(&self.path)
                .args(["config", "--local", "--fixed-value", "--unset-all", "include.path"])
                .arg(path)
                .output()
                .map_err(|e| format!("git could not run: {e}"))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
        }
        match want {
            // At the very end of the file, so the account outranks the repo's own values.
            Some(want) => crate::credential::append_include(&self.common.join("config"), &want.to_string_lossy()),
            None => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    scope: String,
    origin: PathBuf,
    value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Account,
    /// The user's global or system file itself, which an account replaces.
    Plain,
    Repo,
    /// A file the user's config includes, often only for some folders.
    Include,
}

struct Places {
    accounts: PathBuf,
    globals: Vec<PathBuf>,
}

impl Places {
    fn here() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let mut globals = vec![
            home.join(".gitconfig"),
            std::env::var_os("XDG_CONFIG_HOME")
                .map_or_else(|| home.join(".config"), PathBuf::from)
                .join("git/config"),
        ];
        if let Some(path) = std::env::var_os("GIT_CONFIG_GLOBAL") {
            globals.push(path.into());
        }
        Self {
            accounts: files_dir(),
            globals,
        }
    }

    fn kind(&self, entry: &Entry) -> Kind {
        if entry.origin.starts_with(&self.accounts) {
            Kind::Account
        } else if entry.scope == "system" || (entry.scope == "global" && self.globals.contains(&entry.origin)) {
            Kind::Plain
        } else if matches!(entry.scope.as_str(), "local" | "worktree") {
            Kind::Repo
        } else {
            Kind::Include
        }
    }
}

fn wanted(repo: &str, file: &AccountsFile, picks: &BTreeMap<String, String>) -> Option<(String, PathBuf)> {
    let remote = super::commands::remote_of(repo).ok()?;
    let Resolution::Account(id) = accounts::resolve(file, picks, &remote) else {
        return None;
    };
    accounts::find(file, &id)?.1.identity()?;
    let path = file_for(&id);
    Some((id, path))
}

static INDEX: OnceLock<crate::config::ProjectIndex> = OnceLock::new();

pub fn install(index: crate::config::ProjectIndex) {
    let _ = INDEX.set(index);
}

/// One folder per repository the sidebar knows.
fn known_repos() -> Vec<String> {
    use crate::config::ProjectKind;
    let Some(config) = INDEX.get().and_then(|index| crate::config::get_config_body(index).ok()) else {
        return Vec::new();
    };
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut repos = Vec::new();
    for unit in config
        .project_groups()
        .iter()
        .flat_map(|group| &group.projects)
        .flat_map(|project| &project.branch_units)
    {
        let folder = Path::new(&unit.folder_path);
        if !matches!(unit.kind, ProjectKind::Worktree | ProjectKind::Plain)
            || !folder.is_dir()
            || !crate::trust::allows_git(folder)
        {
            continue;
        }
        let common = crate::exec::common_dir(&unit.folder_path);
        if !seen.contains(&common) {
            seen.push(common);
            repos.push(unit.folder_path.clone());
        }
    }
    repos
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Brings every account file and every known repo in line with the accounts
/// and picks as they stand, and answers what it could not do.
pub fn reconcile() -> Vec<String> {
    let _guard = lock();
    let file = accounts::load();
    let picks = crate::settings::get_settings().forge.picks;
    let places = Places::here();
    let mut failed = Vec::new();
    for (_, account) in accounts::all_accounts(&file) {
        if let Err(e) = write_file(account) {
            failed.push(format!("the git config file for {}: {e}", account.id));
        }
    }
    for path in known_repos() {
        let want = wanted(&path, &file, &picks).map(|(_, file)| file);
        let applied = Repo::open(&path).and_then(|repo| {
            // A repo with its own author and no account yet waits for the user.
            if want.is_some() && repo.included(&places)?.is_empty() && !repo.own(&places)?.is_empty() {
                return Ok(());
            }
            repo.apply(want.as_deref(), &places)
        });
        if let Err(e) = applied {
            failed.push(format!("{path}: {e}"));
        }
    }
    // After the repos, so none is left including a file that is already gone.
    let live: Vec<PathBuf> = accounts::all_accounts(&file)
        .filter(|(_, a)| a.identity().is_some())
        .map(|(_, a)| file_for(&a.id))
        .collect();
    if let Ok(dir) = std::fs::read_dir(files_dir()) {
        for path in dir.flatten().map(|e| e.path()) {
            if !live.contains(&path) {
                if let Err(e) = std::fs::remove_file(&path) {
                    failed.push(format!("{}: {e}", path.display()));
                }
            }
        }
    }
    failed
}

pub fn reconcile_soon() {
    std::thread::spawn(|| {
        for failure in reconcile() {
            eprintln!("[tori] git account: {failure}");
        }
    });
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    pub source: IdentitySource,
    pub ignored: Vec<IgnoredValue>,
    pub needs_choice: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum IdentitySource {
    Account { account_id: String },
    Repo,
    Global,
    Include { file: String },
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredValue {
    pub key: String,
    pub value: String,
    /// Only a value in the repo's own config: a conditional include is a file
    /// of the user's, and Tori leaves it alone.
    pub removable: bool,
}

fn failed(message: String) -> ForgeError {
    ForgeError::Transport { message }
}

pub fn commit_identity(path: &str) -> Result<CommitIdentity, ForgeError> {
    let repo = Repo::open(path).map_err(failed)?;
    let places = Places::here();
    let name = repo.entries("user.name").map_err(failed)?.pop();
    let email = repo.entries("user.email").map_err(failed)?.pop();
    let source = match &email {
        None => IdentitySource::None,
        Some(e) => match places.kind(e) {
            Kind::Account => IdentitySource::Account {
                account_id: e
                    .origin
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            },
            Kind::Plain => IdentitySource::Global,
            Kind::Repo => IdentitySource::Repo,
            Kind::Include => IdentitySource::Include {
                file: e.origin.to_string_lossy().into_owned(),
            },
        },
    };
    let own = repo.own(&places).map_err(failed)?;
    let ignored = match source {
        IdentitySource::Account { .. } => own
            .iter()
            .map(|(key, e)| IgnoredValue {
                key: key.clone(),
                value: e.value.clone(),
                removable: places.kind(e) == Kind::Repo,
            })
            .collect(),
        _ => Vec::new(),
    };
    let needs_choice = if !own.is_empty() && repo.included(&places).map_err(failed)?.is_empty() {
        wanted(path, &accounts::load(), &crate::settings::get_settings().forge.picks).map(|(id, _)| id)
    } else {
        None
    };
    Ok(CommitIdentity {
        name: name.map(|e| e.value),
        email: email.map(|e| e.value),
        source,
        ignored,
        needs_choice,
    })
}

pub fn use_account(path: &str) -> Result<(), ForgeError> {
    let _guard = lock();
    let (_, want) = wanted(path, &accounts::load(), &crate::settings::get_settings().forge.picks).ok_or_else(|| {
        ForgeError::Invalid {
            message: "This repo's account has no commit author set.".into(),
        }
    })?;
    Repo::open(path)
        .and_then(|repo| repo.apply(Some(&want), &Places::here()))
        .map_err(failed)
}

pub fn stop_account(path: &str) -> Result<(), ForgeError> {
    let _guard = lock();
    Repo::open(path)
        .and_then(|repo| repo.apply(None, &Places::here()))
        .map_err(failed)
}

pub fn remove_own(path: &str, key: &str) -> Result<(), ForgeError> {
    if !KEYS.contains(&key) {
        return Err(ForgeError::Invalid {
            message: format!("Tori does not manage {key}."),
        });
    }
    let repo = Repo::open(path).map_err(failed)?;
    // `--worktree` is `--local` unless the repo keeps per-worktree config.
    for scope in ["--local", "--worktree"] {
        let out = crate::exec::git_in(&repo.path)
            .args(["config", scope, "--unset-all", key])
            .output()
            .map_err(|e| failed(format!("git could not run: {e}")))?;
        // Exit 5 is git's "nothing to unset".
        if !matches!(out.status.code(), Some(0 | 5)) {
            return Err(failed(String::from_utf8_lossy(&out.stderr).trim().to_string()));
        }
    }
    Ok(())
}
