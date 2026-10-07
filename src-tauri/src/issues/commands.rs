//! The Tauri surface of the issue source, over a core the socket shares.
//!
//! Every call resolves the project's forge client the way a PR call does (the
//! repo's account pick, renewal on a rejected token) and then goes through the
//! rate [`gate`](super::gate).

#![allow(
    clippy::result_large_err,
    reason = "a Tauri command result, serialized to the webview once per call; boxing the error saves a copy nothing pays for"
)]

use super::gate::gate;
use super::store::{self, UnitIssue};
use super::{
    offers_issues, FailedSource, Issue, IssueKind, IssueQuery, IssueRef, IssueSource, LinkOutcome, SourceList,
};
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

fn full_name(c: &Client) -> String {
    format!("{}/{}", c.repo.owner, c.repo.repo)
}

fn fetch_assigned(c: &Client, refresh: bool) -> Result<Vec<IssueRef>, ForgeError> {
    gate()
        .assigned(&c.account_id, &full_name(c), refresh, || {
            attempt(c, |f| source_of(f)?.list_assigned(&c.repo))
        })
        .map_err(named_access)
}

fn fetch_matching(c: &Client, query: &IssueQuery, refresh: bool) -> Result<Vec<IssueRef>, ForgeError> {
    gate()
        .assigned(&c.account_id, &query.search(), refresh, || {
            attempt(c, |f| source_of(f)?.list_matching(&c.repo, query))
        })
        .map_err(named_access)
}

pub struct Assigned {
    pub account: String,
    // `owner/name`
    pub repo: String,
    pub lists: Vec<SourceList>,
    pub failed: Vec<FailedSource>,
}

impl Assigned {
    pub fn rows(&self) -> Vec<IssueRef> {
        let mut out: Vec<IssueRef> = Vec::new();
        for row in self.lists.iter().flat_map(|l| &l.rows) {
            if !out.iter().any(|r| r.kind == row.kind && r.key == row.key) {
                out.push(row.clone());
            }
        }
        out
    }
}

/// The project's lists: with no `sources` its own assigned list as before,
/// else one list per source beside the origin's review requests.
fn gather(c: &Client, sources: &[IssueQuery], refresh: bool) -> Result<Assigned, ForgeError> {
    let cap = super::github::ASSIGNED_CAP as usize;
    let list = |search: Option<String>, kind: IssueKind, rows: Vec<IssueRef>| SourceList {
        complete: rows.len() < cap,
        search,
        kind,
        rows,
    };
    let assigned = fetch_assigned(c, refresh)?;
    let (issues, reviews): (Vec<IssueRef>, Vec<IssueRef>) =
        assigned.into_iter().partition(|r| r.kind == IssueKind::Issue);
    let mut lists = vec![list(None, IssueKind::ReviewRequest, reviews)];
    let mut failed = Vec::new();
    if sources.is_empty() {
        lists.insert(0, list(None, IssueKind::Issue, issues));
    }
    for query in sources {
        match query
            .check()
            .and_then(|()| fetch_matching(c, query, refresh).map_err(|e| e.to_string()))
        {
            Ok(rows) => lists.push(list(Some(query.search()), IssueKind::Issue, rows)),
            Err(error) => failed.push(FailedSource {
                search: query.search(),
                error,
            }),
        }
    }
    Ok(Assigned {
        repo: full_name(c),
        account: c.account_id.clone(),
        lists,
        failed,
    })
}

/// Every row the project's sources list, issues then review requests, once each.
pub fn assigned(project_path: &str, sources: &[IssueQuery], refresh: bool) -> Result<Vec<IssueRef>, ForgeError> {
    let mut rows = gather(&issue_client(project_path)?, sources, refresh)?.rows();
    rows.sort_by_key(|r| r.kind == IssueKind::ReviewRequest);
    Ok(rows)
}

// `None` where `offered` says no; one client resolve, since the poll tick calls it per project.
pub fn assigned_if_offered(project_path: &str, sources: &[IssueQuery]) -> Result<Option<Assigned>, ForgeError> {
    let Ok(c) = issue_client(project_path) else {
        return Ok(None);
    };
    if !offers(&c) {
        return Ok(None);
    }
    gather(&c, sources, false).map(Some)
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
pub fn issues_assigned(
    rpc: tauri::State<crate::rpc::RpcState>,
    project_path: String,
    refresh: Option<bool>,
) -> Result<Vec<IssueRef>, ForgeErrorDto> {
    let sources = rpc.autopilot.contract(&project_path).unwrap_or_default().issues;
    Ok(assigned(&project_path, &sources, refresh.unwrap_or(false))?)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn row(key: &str, kind: IssueKind) -> IssueRef {
        IssueRef {
            key: key.into(),
            display: key.into(),
            title: "t".into(),
            url: "u".into(),
            kind,
        }
    }

    #[test]
    fn the_rows_are_every_lists_once_each() {
        let list = |search: &str, rows: Vec<IssueRef>| SourceList {
            search: Some(search.into()),
            kind: IssueKind::Issue,
            rows,
            complete: true,
        };
        let assigned = Assigned {
            account: "a".into(),
            repo: "gettori/tori".into(),
            lists: vec![
                SourceList {
                    search: None,
                    kind: IssueKind::ReviewRequest,
                    rows: vec![row("4", IssueKind::ReviewRequest)],
                    complete: true,
                },
                list("a", vec![row("gettori/tickets#31", IssueKind::Issue)]),
                list(
                    "b",
                    vec![
                        row("gettori/tickets#31", IssueKind::Issue),
                        row("gettori/tickets#32", IssueKind::Issue),
                    ],
                ),
            ],
            failed: Vec::new(),
        };
        let keys: Vec<String> = assigned.rows().into_iter().map(|r| r.key).collect();
        assert_eq!(keys, ["4", "gettori/tickets#31", "gettori/tickets#32"]);
    }
}
