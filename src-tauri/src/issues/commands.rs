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
use super::repos;
use super::store::{self, UnitIssue};
use super::{
    candidates, offers_issues, Access, FailedSource, Found, Issue, IssueKind, IssueQuery, IssueRef, IssueSource,
    LinkOutcome, SourceList,
};
use crate::forge::accounts;
use crate::forge::commands::{attempt, gated_client, Client, ForgeErrorDto};
use crate::forge::model::RepoRef;
use crate::forge::{Forge, ForgeError};
use serde::Serialize;
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

fn gather(c: &Client, project_path: &str, sources: &[IssueQuery], refresh: bool) -> Result<Assigned, ForgeError> {
    let cap = super::github::ASSIGNED_CAP as usize;
    let list = |search: Option<String>, kind: IssueKind, rows: Vec<IssueRef>| SourceList {
        complete: rows.len() < cap,
        search,
        kind,
        rows,
    };
    let reviews: Vec<IssueRef> = fetch_assigned(c, refresh)?
        .into_iter()
        .filter(|r| r.kind == IssueKind::ReviewRequest)
        .collect();
    let mut lists = vec![list(None, IssueKind::ReviewRequest, reviews)];
    let mut failed = Vec::new();
    if sources.is_empty() {
        let mine = fetch_assigned_in(c, &effective_repos(project_path, sources), refresh)?;
        let every_repo_read = mine.skipped.is_empty();
        let mut issues = list(None, IssueKind::Issue, mine.rows);
        issues.complete &= every_repo_read;
        lists.insert(0, issues);
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

fn search_assigned_in(c: &Client, repos: &[RepoRef], refresh: bool) -> Result<Vec<IssueRef>, ForgeError> {
    let scope: Vec<String> = repos.iter().map(name_of).collect();
    gate().assigned(
        &c.account_id,
        &format!("assigned in {}", scope.join(" ")),
        refresh,
        || attempt(c, |f| source_of(f)?.list_assigned_in(&c.repo, repos)),
    )
}

fn name_of(r: &RepoRef) -> String {
    format!("{}/{}", r.owner, r.repo)
}

// When every repo refused lately the search runs over all of them anyway, so
// the refusal reaches the user instead of an empty list.
fn searchable_repos(c: &Client, repos: &[String]) -> Vec<RepoRef> {
    let all: Vec<RepoRef> = repos.iter().filter_map(|r| repo_ref(r)).collect();
    let readable: Vec<RepoRef> = all
        .iter()
        .filter(|r| !gate().unreadable(&c.account_id, &name_of(r)))
        .cloned()
        .collect();
    if readable.is_empty() {
        all
    } else {
        readable
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignedIssues {
    pub rows: Vec<IssueRef>,
    pub skipped: Vec<String>,
}

// One unreadable repo fails a multi-repo search whole, so a refused search is
// retried a repo at a time and the refusing repo is left out of the next one.
fn fetch_assigned_in(c: &Client, repos: &[String], refresh: bool) -> Result<AssignedIssues, ForgeError> {
    let search = searchable_repos(c, repos);
    let mut skipped: Vec<String> = repos
        .iter()
        .filter(|r| !search.iter().any(|s| name_of(s).eq_ignore_ascii_case(r)))
        .cloned()
        .collect();
    let refused = match search_assigned_in(c, &search, refresh) {
        Ok(rows) => return Ok(AssignedIssues { rows, skipped }),
        Err(e) if search.len() > 1 && e.repo_refused() => e,
        Err(e) => {
            if e.repo_refused() {
                gate().note_access(&c.account_id, &name_of(&search[0]), false);
            }
            return Err(named_access(e));
        }
    };
    let mut rows = Vec::new();
    let mut answered = false;
    for repo in &search {
        match search_assigned_in(c, std::slice::from_ref(repo), refresh) {
            Ok(found) => {
                gate().note_access(&c.account_id, &name_of(repo), true);
                answered = true;
                rows.extend(found);
            }
            Err(e) if e.repo_refused() => {
                gate().note_access(&c.account_id, &name_of(repo), false);
                skipped.push(name_of(repo).to_lowercase());
            }
            Err(e) => return Err(named_access(e)),
        }
    }
    if answered {
        Ok(AssignedIssues { rows, skipped })
    } else {
        Err(named_access(refused))
    }
}

pub fn assigned_issues(
    project_path: &str,
    sources: &[IssueQuery],
    refresh: bool,
) -> Result<AssignedIssues, ForgeError> {
    let c = issue_client(project_path)?;
    let mut list = fetch_assigned_in(&c, &effective_repos(project_path, sources), refresh)?;
    let reviews = fetch_assigned(&c, refresh)?;
    list.rows
        .extend(reviews.into_iter().filter(|r| r.kind == IssueKind::ReviewRequest));
    Ok(list)
}

pub fn assigned(project_path: &str, sources: &[IssueQuery], refresh: bool) -> Result<Vec<IssueRef>, ForgeError> {
    assigned_issues(project_path, sources, refresh).map(|list| list.rows)
}

pub fn find(project_path: &str, input: &str, sources: &[IssueQuery]) -> Result<Found, ForgeError> {
    let c = issue_client(project_path)?;
    let listed = effective_repos(project_path, sources);
    let (repos, number) = candidates(input, &full_name(&c), &listed).ok_or_else(|| ForgeError::Invalid {
        message: format!(
            "\"{}\" is not an issue. Type a number, repo#N, owner/repo#N or an issue URL.",
            input.trim()
        ),
    })?;
    let refs: Vec<RepoRef> = repos.iter().filter_map(|r| repo_ref(r)).collect();
    let found = gate()
        .call(&c.account_id, || {
            attempt(&c, |f| source_of(f)?.find(&c.repo, number, &refs))
        })
        .map_err(named_access)?;
    for repo in &repos {
        gate().note_access(&c.account_id, repo, !found.skipped.contains(repo));
    }
    Ok(found)
}

// `None` where `offered` says no; one client resolve, since the poll tick calls it per project.
pub fn assigned_if_offered(project_path: &str, sources: &[IssueQuery]) -> Result<Option<Assigned>, ForgeError> {
    let Ok(c) = issue_client(project_path) else {
        return Ok(None);
    };
    if !offers(&c) {
        return Ok(None);
    }
    gather(&c, project_path, sources, false).map(Some)
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequests {
    pub rows: Vec<IssueRef>,
    pub complete: bool,
    #[serde(skip)]
    pub account: String,
    #[serde(skip)]
    pub full_name: String,
}

fn reviews_in(rows: Vec<IssueRef>) -> ReviewRequests {
    let rows: Vec<IssueRef> = rows
        .into_iter()
        .filter(|r| r.kind == IssueKind::ReviewRequest)
        .collect();
    ReviewRequests {
        // A list at the cap may have cut a request off, so it cannot say one went away.
        complete: rows.len() < super::github::ASSIGNED_CAP as usize,
        rows,
        account: String::new(),
        full_name: String::new(),
    }
}

// The origin's list alone, never the contract's sources: this runs every tick
// whether or not the autopilot does, so a source search would be new traffic.
// `None` only for a host or token with no list, so a failure keeps the last one.
pub fn origin_review_requests(project_path: &str) -> Result<Option<ReviewRequests>, ForgeError> {
    let c = gated_client(project_path)?;
    if c.forge.issues().is_none() || !offers(&c) {
        return Ok(None);
    }
    fetch_assigned(&c, false).map(|rows| {
        Some(ReviewRequests {
            account: c.account_id.clone(),
            full_name: full_name(&c),
            ..reviews_in(rows)
        })
    })
}

#[tauri::command(async)]
pub fn review_requests(app: AppHandle, project_path: String) -> Result<Option<ReviewRequests>, ForgeErrorDto> {
    let list = origin_review_requests(&project_path)?;
    crate::review_rule::tick(&app, &project_path, list.as_ref());
    Ok(list)
}

#[tauri::command(async)]
pub fn issues_source(project_path: String) -> bool {
    offered(&project_path)
}

fn contract_sources(project_path: &str) -> Result<Vec<IssueQuery>, ForgeError> {
    let contracts: std::collections::BTreeMap<String, crate::autopilot::Contract> =
        crate::rpc::office_call_as("autopilot.contracts", serde_json::json!({}))
            .map_err(|message| ForgeError::Transport { message })?;
    Ok(contracts.get(project_path).cloned().unwrap_or_default().issues)
}

#[tauri::command(async)]
pub fn issues_assigned(project_path: String, refresh: Option<bool>) -> Result<AssignedIssues, ForgeErrorDto> {
    let sources = contract_sources(&project_path)?;
    Ok(assigned_issues(&project_path, &sources, refresh.unwrap_or(false))?)
}

pub fn origin_of(project_path: &str) -> Option<String> {
    crate::forge::commands::remote_of(project_path)
        .ok()
        .map(|r| format!("{}/{}", r.repo.owner, r.repo.repo).to_lowercase())
}

pub fn effective_repos(project_path: &str, sources: &[IssueQuery]) -> Vec<String> {
    match origin_of(project_path) {
        Some(origin) => repos::effective(project_path, &origin, sources),
        None => repos::stored(project_path),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRepos {
    pub origin: Option<String>,
    pub stored: Vec<String>,
    pub effective: Vec<String>,
}

fn issue_repos_of(project_path: &str, sources: &[IssueQuery]) -> IssueRepos {
    let effective = effective_repos(project_path, sources);
    IssueRepos {
        origin: origin_of(project_path),
        stored: repos::stored(project_path),
        effective,
    }
}

// With the daemon out of reach the list still loads; only the one-time seed waits.
#[tauri::command(async)]
pub fn issue_repos_get(project_path: String) -> IssueRepos {
    let sources = contract_sources(&project_path).unwrap_or_default();
    issue_repos_of(&project_path, &sources)
}

fn keeps_every_source(project_path: &str, next: &[String], sources: &[IssueQuery]) -> Result<(), String> {
    let reads = match (next.is_empty(), origin_of(project_path)) {
        (true, Some(origin)) => vec![origin],
        _ => next.to_vec(),
    };
    match repos::unlisted(sources, &reads) {
        Some(repo) => Err(format!(
            "An autopilot issue source reads {repo}. Remove that source in Agents first, then remove {repo} here."
        )),
        None => Ok(()),
    }
}

#[tauri::command(async)]
pub fn issue_repos_set(project_path: String, repos: Vec<String>) -> Result<IssueRepos, String> {
    let next = repos::normalize(&repos)?;
    let sources = contract_sources(&project_path).map_err(|_| {
        "Tori could not check this project's autopilot sources, so the list was not saved. Try again in a moment."
            .to_string()
    })?;
    keeps_every_source(&project_path, &next, &sources)?;
    repos::save(&project_path, &next)?;
    Ok(issue_repos_of(&project_path, &[]))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoAccess {
    pub repo: String,
    pub access: Access,
}

fn repo_ref(full: &str) -> Option<RepoRef> {
    let (owner, repo) = full.split_once('/')?;
    Some(RepoRef {
        owner: owner.into(),
        repo: repo.into(),
    })
}

fn record_access(account: &str, refs: &[RepoRef], found: Vec<Access>) -> Vec<RepoAccess> {
    refs.iter()
        .zip(found)
        .map(|(r, access)| {
            let repo = format!("{}/{}", r.owner, r.repo);
            gate().note_access(account, &repo, access == Access::Readable);
            RepoAccess { repo, access }
        })
        .collect()
}

#[tauri::command(async)]
pub fn issue_repos_access(project_path: String, repos: Vec<String>) -> Result<Vec<RepoAccess>, ForgeErrorDto> {
    let c = issue_client(&project_path)?;
    let refs: Vec<RepoRef> = repos.iter().filter_map(|r| repo_ref(r)).collect();
    let found = gate()
        .call(&c.account_id, || attempt(&c, |f| source_of(f)?.access(&refs)))
        .map_err(named_access)?;
    Ok(record_access(&c.account_id, &refs, found))
}

#[tauri::command(async)]
pub fn issues_find(project_path: String, input: String) -> Result<Found, ForgeErrorDto> {
    let sources = contract_sources(&project_path).unwrap_or_default();
    Ok(find(&project_path, &input, &sources)?)
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
pub(crate) mod tests {
    use super::*;

    fn row(key: &str, kind: IssueKind) -> IssueRef {
        IssueRef {
            key: key.into(),
            display: key.into(),
            title: "t".into(),
            url: "u".into(),
            kind,
            author: None,
            head_sha: None,
            body_len: None,
        }
    }

    pub(crate) fn repo_with_origin(name: &str, origin: &str) -> String {
        let dir = std::env::temp_dir().join(format!("tori-issue-origin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for args in [vec!["init", "-q"], vec!["remote", "add", "origin", origin]] {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .status()
                .unwrap();
            assert!(ok.success());
        }
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn a_repo_a_source_reads_cannot_leave_the_list() {
        let project = repo_with_origin("keeps", "https://github.com/gettori/tori.git");
        let sources = [IssueQuery {
            repo: "gettori/tickets".into(),
            ..IssueQuery::default()
        }];
        let err = keeps_every_source(&project, &["gettori/tori".into()], &sources).unwrap_err();
        assert!(err.contains("gettori/tickets"), "{err}");
        assert!(keeps_every_source(&project, &[], &sources).is_err());
        assert!(keeps_every_source(&project, &["gettori/tori".into(), "gettori/tickets".into()], &sources).is_ok());
        let origin_only = [IssueQuery {
            repo: "gettori/tori".into(),
            ..IssueQuery::default()
        }];
        assert!(keeps_every_source(&project, &[], &origin_only).is_ok());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn review_requests_keep_only_reviews_and_say_when_the_cap_cut_them() {
        let got = reviews_in(vec![row("1", IssueKind::Issue), row("45", IssueKind::ReviewRequest)]);
        assert_eq!(got.rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), ["45"]);
        assert!(got.complete);
        let full = (0..super::super::github::ASSIGNED_CAP)
            .map(|n| row(&n.to_string(), IssueKind::ReviewRequest))
            .collect();
        assert!(
            !reviews_in(full).complete,
            "a list at the cap cannot prove a request left"
        );
    }
}
