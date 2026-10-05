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
pub mod store;

use crate::forge::accounts::Provider;
use crate::forge::model::RepoRef;
use crate::forge::ForgeError;
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

/// An issue source.
///
/// Intent-shaped like the forge trait: nothing here names a query language or
/// a URL, so a tracker with no git of its own can implement it.
pub trait IssueSource: Send + Sync {
    /// Open issues assigned to the viewer, then open pull requests waiting on
    /// the viewer's review, in `repo`.
    fn list_assigned(&self, repo: &RepoRef) -> Result<Vec<IssueRef>, ForgeError>;

    /// One issue by key. A key naming something that is not an issue here is
    /// [`ForgeError::Invalid`], with the sentence to show.
    fn get(&self, repo: &RepoRef, key: &str) -> Result<Issue, ForgeError>;

    /// Make `branch` on the host from `base` (the host's default branch when
    /// `None`) and link it to the issue.
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
}
