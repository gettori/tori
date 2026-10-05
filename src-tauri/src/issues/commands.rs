//! The Tauri surface of the issue source, over a core the socket shares.
//!
//! Every call resolves the project's forge client the way a PR call does (the
//! repo's account pick, renewal on a rejected token) and then goes through the
//! rate [`gate`](super::gate).

use super::gate::gate;
use super::store::{self, UnitIssue};
use super::{offers_issues, Issue, IssueRef, IssueSource, LinkOutcome};
use crate::forge::accounts;
use crate::forge::commands::{attempt, gated_client, Client, ForgeErrorDto};
use crate::forge::{Forge, ForgeError};
use tauri::{AppHandle, Emitter};

fn source_of(f: &dyn Forge) -> Result<&dyn IssueSource, ForgeError> {
    f.issues().ok_or_else(|| ForgeError::Invalid {
        message: "This host has no issue source in Tori yet".into(),
    })
}

/// A refusal on an issue call is nearly always the token, so it says which.
fn named_access(e: ForgeError) -> ForgeError {
    match e {
        ForgeError::Forbidden { message } => ForgeError::Forbidden {
            message: format!(
                "This account's token cannot read issues here ({message}). A fine-grained token needs Issues access on this repo."
            ),
        },
        other => other,
    }
}

fn issue_client(project_path: &str) -> Result<Client, ForgeError> {
    let c = gated_client(project_path)?;
    source_of(c.forge.as_ref())?;
    Ok(c)
}

fn offers(c: &Client) -> bool {
    let file = accounts::load();
    accounts::find(&file, &c.account_id)
        .is_some_and(|(_, account)| offers_issues(account.provider, account.scopes.as_deref()))
}

/// Whether this project's account is worth offering issues for, without a
/// request: a signed-in account on a host with an issue source, whose token is
/// not known to lack `repo`.
pub fn offered(project_path: &str) -> bool {
    issue_client(project_path).is_ok_and(|c| offers(&c))
}

fn fetch_assigned(c: &Client, refresh: bool) -> Result<Vec<IssueRef>, ForgeError> {
    gate()
        .assigned(&c.account_id, &c.repo, refresh, || {
            attempt(c, |f| source_of(f)?.list_assigned(&c.repo))
        })
        .map_err(named_access)
}

pub fn assigned(project_path: &str, refresh: bool) -> Result<Vec<IssueRef>, ForgeError> {
    fetch_assigned(&issue_client(project_path)?, refresh)
}

pub struct Assigned {
    pub account: String,
    // `owner/name`
    pub repo: String,
    pub rows: Vec<IssueRef>,
}

// `None` where `offered` says no; one client resolve, since the poll tick calls it per project.
pub fn assigned_if_offered(project_path: &str) -> Result<Option<Assigned>, ForgeError> {
    let Ok(c) = issue_client(project_path) else {
        return Ok(None);
    };
    if !offers(&c) {
        return Ok(None);
    }
    let rows = fetch_assigned(&c, false)?;
    Ok(Some(Assigned {
        repo: format!("{}/{}", c.repo.owner, c.repo.repo),
        account: c.account_id,
        rows,
    }))
}

pub fn get(project_path: &str, key: &str) -> Result<Issue, ForgeError> {
    let c = issue_client(project_path)?;
    gate()
        .call(&c.account_id, || attempt(&c, |f| source_of(f)?.get(&c.repo, key)))
        .map_err(named_access)
}

/// Links, then fetches the branch so a local one can track it. A retry after a
/// failed fetch finds the branch already linked and fetches again.
pub fn link(project_path: &str, key: &str, branch: &str, base: Option<&str>) -> Result<LinkOutcome, ForgeError> {
    let c = issue_client(project_path)?;
    let outcome = gate()
        .call(&c.account_id, || {
            attempt(&c, |f| source_of(f)?.link_branch(&c.repo, key, branch, base))
        })
        .map_err(named_access)?;
    crate::git::fetch_branch_quiet(project_path, branch).map_err(|e| ForgeError::Transport {
        message: format!("{branch} is on GitHub, but fetching it failed: {e}"),
    })?;
    Ok(outcome)
}

#[tauri::command(async)]
pub fn issues_source(project_path: String) -> bool {
    offered(&project_path)
}

#[tauri::command(async)]
pub fn issues_assigned(project_path: String, refresh: Option<bool>) -> Result<Vec<IssueRef>, ForgeErrorDto> {
    Ok(assigned(&project_path, refresh.unwrap_or(false))?)
}

#[tauri::command(async)]
pub fn issues_get(project_path: String, key: String) -> Result<Issue, ForgeErrorDto> {
    Ok(get(&project_path, &key)?)
}

#[tauri::command(async)]
pub fn issues_link(
    project_path: String,
    key: String,
    branch: String,
    base: Option<String>,
) -> Result<LinkOutcome, ForgeErrorDto> {
    Ok(link(&project_path, &key, &branch, base.as_deref())?)
}

/// Remembers the unit's issue once its branch exists, then reloads the
/// sidebar so the row shows it.
#[tauri::command(async)]
pub fn issues_record(app: AppHandle, project_path: String, branch: String, issue: UnitIssue) -> Result<(), String> {
    store::record(&project_path, &branch, issue)?;
    let _ = app.emit("config://changed", ());
    Ok(())
}
