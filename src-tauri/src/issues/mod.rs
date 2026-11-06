//! The issue source: where a piece of work comes from, the left half of its
//! life, beside the forge that is the right half.
//!
//! A second adapter axis rather than more methods on [`crate::forge::Forge`],
//! because the two are separate products on most stacks (Linear with GitLab,
//! Jira with GitHub). GitHub happens to be both, so its source rides the forge
//! client for the same account through [`crate::forge::Forge::issues`].
//!
//! Everything is keyed by an opaque string `key` with a `display` label beside
//! it. GitHub's key is the issue number, Linear's is `ENG-123`, and the record a
//! branch unit keeps ([`store`]) is persisted, so a number-shaped key would be a
//! migration the day a second source lands.
//!
//! Module layout:
//!   * `github` - the GitHub impl, on [`crate::forge::github::GitHubForge`]
//!   * `gate` - the rate gate and the assigned-list cache every call goes through
//!   * `store` - which issue a branch unit was started from
//!   * `commands` - the Tauri surface

pub mod commands;
pub mod gate;
pub mod github;
pub mod repos;
pub mod store;

use crate::forge::accounts::Provider;
use crate::forge::model::RepoRef;
use crate::forge::ForgeError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Why an item is on the viewer's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    /// An issue assigned to the viewer.
    Issue,
    /// A pull request waiting on the viewer's review.
    ReviewRequest,
}

/// One row of the viewer's list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRef {
    pub key: String,
    pub display: String,
    pub title: String,
    pub url: String,
    pub kind: IssueKind,
    // A review request's own, so a row can name who asked and notice a push
    // without a read per pull request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_len: Option<usize>,
}

/// One issue, with what a branch unit started from it needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub key: String,
    pub display: String,
    pub title: String,
    pub body: String,
    pub url: String,
    pub suggested_branch: String,
}

/// Whether the viewer can read issues in a repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Readable,
    /// Missing, private to someone else, or a token without issue access.
    NoAccess,
    /// The repo has issues turned off.
    IssuesOff,
}

/// One issue number looked up across repos: the issues it is in each, and the
/// repos that could not be read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub hits: Vec<IssueRef>,
    pub skipped: Vec<String>,
}

/// What asking to link a branch found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkOutcome {
    /// The branch was made on the host, linked to the issue.
    Created,
    /// The issue already names this branch, from an earlier try or by hand.
    AlreadyLinked,
    /// The branch already exists on the host without the link, and a host
    /// that only links branches it creates cannot add it now.
    Unlinked,
}

/// Where a project's issues come from: a repo and what an issue there must match.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct IssueQuery {
    /// The repo the issues live in, as `owner/name`.
    pub repo: String,
    /// Labels an issue must carry, all of them.
    pub labels: Vec<String>,
    /// Labels an issue must not carry.
    pub exclude_labels: Vec<String>,
    /// The milestone an issue must be in.
    pub milestone: Option<String>,
    /// Who an issue is assigned to: left out it is you, `any` is anyone, else a login.
    pub assignee: Option<String>,
    /// Raw search qualifiers added after the ones above.
    pub extra: Option<String>,
}

impl IssueQuery {
    /// Refuses a repo that is not `owner/name`, since a search with no repo
    /// in it reads every repo the account can see.
    pub fn check(&self) -> Result<(), String> {
        let repo = self.repo.trim();
        let parts: Vec<&str> = repo.split('/').collect();
        let named = |s: &str| !s.is_empty() && !s.contains(char::is_whitespace);
        if parts.len() == 2 && parts.iter().all(|p| named(p)) {
            Ok(())
        } else {
            Err(format!("an issue source's repo must be owner/name, not \"{repo}\""))
        }
    }

    /// The search it runs, which is also what tells two queries apart.
    pub fn search(&self) -> String {
        // The search syntax has no escape for a quote inside a quoted value.
        let quoted = |v: &str| format!("\"{}\"", v.trim().replace('"', ""));
        let mut out = format!("repo:{} is:open is:issue", self.repo.trim());
        for label in self.labels.iter().filter(|l| !l.trim().is_empty()) {
            out.push_str(&format!(" label:{}", quoted(label)));
        }
        for label in self.exclude_labels.iter().filter(|l| !l.trim().is_empty()) {
            out.push_str(&format!(" -label:{}", quoted(label)));
        }
        if let Some(milestone) = self.milestone.as_deref().filter(|m| !m.trim().is_empty()) {
            out.push_str(&format!(" milestone:{}", quoted(milestone)));
        }
        match self.assignee.as_deref().map(str::trim) {
            None | Some("") => out.push_str(" assignee:@me"),
            Some("any") => {}
            Some(login) => out.push_str(&format!(" assignee:{}", login.trim_start_matches('@'))),
        }
        if let Some(extra) = self.extra.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
            out.push(' ');
            out.push_str(extra);
        }
        out
    }
}

/// One list a pickup tick read: the issues one query matched, or the review
/// requests. `search` is the query's, `None` for the origin's own list, and
/// `complete` says it came back shorter than the cap, so an issue missing from
/// it is really gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceList {
    pub search: Option<String>,
    pub kind: IssueKind,
    pub rows: Vec<IssueRef>,
    pub complete: bool,
}

/// A query that did not answer this tick, so nothing it lists is picked or closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedSource {
    pub search: String,
    pub error: String,
}

/// `owner/name#N`, or a forge's issue or pull request URL: the repo,
/// lowercased, and the number.
pub fn split_key(key: &str) -> Option<(String, u64)> {
    let key = key.trim().trim_end_matches('/');
    let (repo, number) = match key.split_once('#') {
        Some((repo, number)) => (repo, number),
        None => {
            let (before, number) = ["/issues/", "/pull/", "/merge_requests/"]
                .iter()
                .find_map(|kind| key.rsplit_once(kind))?;
            let before = before.strip_suffix("/-").unwrap_or(before);
            let path = before.split_once("://").map_or(before, |(_, path)| path);
            (path.split_once('/')?.1, number)
        }
    };
    let number = number.parse::<u64>().ok().filter(|n| *n > 0)?;
    repo.contains('/').then(|| (repo.to_lowercase(), number))
}

/// The one spelling of an issue key: bare `N` in `origin` (`owner/name`),
/// `owner/name#N` in any other repo. A key with no repo in it is the origin's,
/// and one that is not a GitHub-style key (`ENG-123`) comes back as written.
pub fn canonical_key(key: &str, origin: &str) -> String {
    let key = key.trim();
    let bare = key.trim_start_matches('#');
    if !bare.is_empty() && bare.bytes().all(|b| b.is_ascii_digit()) {
        return bare.to_string();
    }
    match split_key(key) {
        Some((repo, number)) if repo.eq_ignore_ascii_case(origin.trim()) => number.to_string(),
        Some((repo, number)) => format!("{repo}#{number}"),
        None => key.to_string(),
    }
}

/// The repos to look in and the number, for what a person typed: a bare `N`
/// or `#N` reads every `listed` repo, `owner/name#N` and an issue URL that
/// repo alone, and `name#N` each listed repo of that name, else that name
/// under `origin`'s owner. `None` for anything else.
pub fn candidates(input: &str, origin: &str, listed: &[String]) -> Option<(Vec<String>, u64)> {
    let input = input.trim();
    let number = |n: &str| n.parse::<u64>().ok().filter(|n| *n > 0);
    let bare = input.trim_start_matches('#');
    if !bare.is_empty() && bare.bytes().all(|b| b.is_ascii_digit()) {
        return Some((listed.to_vec(), number(bare)?));
    }
    if let Some((repo, n)) = split_key(input) {
        return Some((vec![repo], n));
    }
    let (name, n) = input.split_once('#')?;
    let name = name.trim().to_lowercase();
    if name.is_empty() || name.contains(['/', ' ']) {
        return None;
    }
    let n = number(n.trim())?;
    let named: Vec<String> = listed
        .iter()
        .filter(|r| {
            r.rsplit('/')
                .next()
                .is_some_and(|tail| tail.eq_ignore_ascii_case(&name))
        })
        .cloned()
        .collect();
    if !named.is_empty() {
        return Some((named, n));
    }
    let owner = origin.split_once('/')?.0;
    Some((vec![format!("{}/{name}", owner.to_lowercase())], n))
}

/// How a canonical key reads to a person: `#N`, or `owner/name#N`.
pub fn display_of(canonical: &str) -> String {
    if canonical.contains('#') {
        canonical.to_string()
    } else {
        format!("#{canonical}")
    }
}

/// An issue source.
///
/// Intent-shaped like the forge trait: nothing here names a query language or
/// a URL, so a tracker with no git of its own can implement it.
pub trait IssueSource: Send + Sync {
    /// Open issues assigned to the viewer, then open pull requests waiting on
    /// the viewer's review, in `repo`.
    fn list_assigned(&self, repo: &RepoRef) -> Result<Vec<IssueRef>, ForgeError>;

    /// Open issues matching `query`, keyed against `origin`, the project's repo.
    fn list_matching(&self, origin: &RepoRef, query: &IssueQuery) -> Result<Vec<IssueRef>, ForgeError>;

    /// One issue by key, read from the repo the key names, else `repo`. A key
    /// naming something that is not an issue there is [`ForgeError::Invalid`],
    /// with the sentence to show.
    fn get(&self, repo: &RepoRef, key: &str) -> Result<Issue, ForgeError>;

    /// Open issues assigned to the viewer across `repos`, keyed against `origin`.
    fn list_assigned_in(&self, origin: &RepoRef, repos: &[RepoRef]) -> Result<Vec<IssueRef>, ForgeError>;

    /// Issue `number` in each of `repos`, in one request, keyed against
    /// `origin`. A pull request with that number is not a hit, and a repo the
    /// viewer cannot read is skipped rather than failing the rest.
    fn find(&self, origin: &RepoRef, number: u64, repos: &[RepoRef]) -> Result<Found, ForgeError>;

    /// Whether the viewer can read issues in each of `repos`, in order, in
    /// one request. One repo it cannot read never fails the others.
    fn access(&self, repos: &[RepoRef]) -> Result<Vec<Access>, ForgeError>;

    /// Make `branch` in `repo` from `base` (the host's default branch when
    /// `None`) and link it to the issue, which may live in another repo.
    ///
    /// Idempotent by design: a retry after the local half of a start failed
    /// must not fail on the branch its first try made.
    fn link_branch(
        &self,
        repo: &RepoRef,
        key: &str,
        branch: &str,
        base: Option<&str>,
    ) -> Result<LinkOutcome, ForgeError>;
}

/// Whether an account is worth offering issues for, from what sign-in
/// recorded about its token.
///
/// Only a token that listed classic scopes and left out `repo` is known not to
/// read issues. A fine-grained token lists none and may well hold issue
/// access, and an unrecorded grant has never been asked, so both are tried and
/// a refusal says so on the call that met it.
pub fn offers_issues(provider: Provider, scopes: Option<&[String]>) -> bool {
    match provider {
        Provider::Gitlab => false,
        Provider::Github => match scopes {
            Some(list) if !list.is_empty() => list.iter().any(|s| s == "repo"),
            _ => true,
        },
    }
}

const BRANCH_CAP: usize = 60;

/// `<prefix>-<slug of title>`: lowercase ASCII, every run of anything else one
/// `-`, cut to [`BRANCH_CAP`] on a character boundary with no dangling `-`.
pub fn suggested_branch(prefix: &str, title: &str) -> String {
    let mut out = prefix.to_ascii_lowercase();
    let mut gap = true;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            if gap {
                out.push('-');
                gap = false;
            }
            out.push(c.to_ascii_lowercase());
        } else {
            gap = true;
        }
    }
    out.truncate(BRANCH_CAP);
    out.trim_end_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slug_folds_punctuation_and_case() {
        assert_eq!(
            suggested_branch("202", "GitHub Issues: start a unit!"),
            "202-github-issues-start-a-unit"
        );
    }

    #[test]
    fn a_title_with_nothing_ascii_is_just_the_prefix() {
        assert_eq!(suggested_branch("7", ""), "7");
        assert_eq!(suggested_branch("7", "日本語 ✓"), "7");
        assert_eq!(suggested_branch("7", "Fix café crash"), "7-fix-caf-crash");
    }

    #[test]
    fn a_long_title_is_cut_without_a_trailing_dash() {
        let name = suggested_branch("12", &"word ".repeat(30));
        assert!(name.len() <= BRANCH_CAP);
        assert!(!name.ends_with('-'));
        assert!(name.starts_with("12-word-word"));
    }

    #[test]
    fn only_a_classic_token_without_repo_is_refused() {
        let classic = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(offers_issues(Provider::Github, Some(&classic(&["repo", "workflow"]))));
        assert!(!offers_issues(Provider::Github, Some(&classic(&["read:org"]))));
        // Fine-grained: sign-in records an empty list.
        assert!(offers_issues(Provider::Github, Some(&[])));
        assert!(offers_issues(Provider::Github, None));
        assert!(!offers_issues(Provider::Gitlab, None));
    }

    #[test]
    fn a_query_quotes_every_value_and_defaults_to_you() {
        let query = IssueQuery {
            repo: "gettori/tickets".into(),
            labels: vec!["block 1".into(), "effort: easy".into()],
            exclude_labels: vec!["discuss".into()],
            milestone: Some("Phase 1: Mac and Android".into()),
            assignee: None,
            extra: Some("sort:created-asc".into()),
        };
        assert_eq!(
            query.search(),
            "repo:gettori/tickets is:open is:issue label:\"block 1\" label:\"effort: easy\" -label:\"discuss\" milestone:\"Phase 1: Mac and Android\" assignee:@me sort:created-asc"
        );
        let anyone = IssueQuery {
            assignee: Some("any".into()),
            ..query.clone()
        };
        assert!(!anyone.search().contains("assignee:"));
        let named = IssueQuery {
            assignee: Some("@skarif2".into()),
            labels: vec!["say \"hi\"".into()],
            ..IssueQuery::default()
        };
        assert_eq!(
            named.search(),
            "repo: is:open is:issue label:\"say hi\" assignee:skarif2"
        );
    }

    #[test]
    fn each_typed_form_picks_its_repos() {
        let origin = "gettori/tori";
        let listed = [
            "gettori/tori".to_string(),
            "gettori/tickets".to_string(),
            "other/tickets".to_string(),
        ];
        let got = |input: &str| candidates(input, origin, &listed);
        assert_eq!(got("31"), Some((listed.to_vec(), 31)));
        assert_eq!(got("#31"), Some((listed.to_vec(), 31)));
        assert_eq!(got("gettori/tickets#31"), Some((vec!["gettori/tickets".into()], 31)));
        assert_eq!(
            got("https://github.com/Acme/Docs/issues/7"),
            Some((vec!["acme/docs".into()], 7))
        );
        assert_eq!(
            got("Tickets#31"),
            Some((vec!["gettori/tickets".into(), "other/tickets".into()], 31))
        );
        assert_eq!(got("web#4"), Some((vec!["gettori/web".into()], 4)));
        for nothing in ["", "fix the bug", "web#", "web#x", "#0", "a b#3"] {
            assert_eq!(got(nothing), None, "{nothing}");
        }
    }

    #[test]
    fn every_spelling_of_an_issue_reaches_one_key() {
        let origin = "gettori/tori";
        for spelling in [
            "https://github.com/gettori/tickets/issues/31",
            "gettori/tickets#31",
            "GetTori/Tickets#31",
        ] {
            assert_eq!(canonical_key(spelling, origin), "gettori/tickets#31", "{spelling}");
        }
        for spelling in [
            "31",
            "#31",
            "https://github.com/gettori/tori/issues/31",
            "GetTori/Tori#31",
        ] {
            assert_eq!(canonical_key(spelling, origin), "31", "{spelling}");
        }
        assert_eq!(canonical_key("ENG-123", origin), "ENG-123");
        assert_eq!(display_of("31"), "#31");
        assert_eq!(display_of("gettori/tickets#31"), "gettori/tickets#31");
    }
}
