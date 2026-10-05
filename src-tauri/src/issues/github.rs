//! GitHub Issues as an issue source, on the forge client for the same account.
//!
//! GraphQL throughout: the assigned list is two searches in one request, and
//! `createLinkedBranch` exists nowhere else. GitHub keeps no suggested branch
//! name an API can read (its default is built server side at link time), so
//! the suggestion is computed here.

use super::{suggested_branch, Issue, IssueKind, IssueRef, IssueSource, LinkOutcome};
use crate::forge::github::GitHubForge;
use crate::forge::http::graphql_data;
use crate::forge::model::RepoRef;
use crate::forge::ForgeError;
use serde_json::{json, Value};

pub const ASSIGNED_CAP: u32 = 50;

const ASSIGNED: &str = "query($issues: String!, $reviews: String!, $first: Int!) {
  issues: search(query: $issues, type: ISSUE, first: $first) {
    nodes { ... on Issue { number title url } }
  }
  reviews: search(query: $reviews, type: ISSUE, first: $first) {
    nodes { ... on PullRequest { number title url } }
  }
}";

const GET: &str = "query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { number title body url }
    }
  }
}";

const LINK_PLAN: &str =
    "query($owner: String!, $name: String!, $number: Int!, $base: String!, $head: String!, $named: Boolean!) {
  repository(owner: $owner, name: $name) {
    id
    defaultBranchRef { target { oid } }
    base: ref(qualifiedName: $base) @include(if: $named) { target { oid } }
    head: ref(qualifiedName: $head) { name }
    issue(number: $number) {
      id
      linkedBranches(first: 100) { nodes { ref { name } } }
    }
  }
}";

const LINK: &str = "mutation($issueId: ID!, $oid: GitObjectID!, $name: String!, $repositoryId: ID!) {
  createLinkedBranch(input: { issueId: $issueId, oid: $oid, name: $name, repositoryId: $repositoryId }) {
    linkedBranch { id }
  }
}";

fn number_of(key: &str) -> Result<u64, ForgeError> {
    key.trim()
        .trim_start_matches('#')
        .parse()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| ForgeError::Invalid {
            message: format!("\"{key}\" is not an issue number"),
        })
}

fn refs_from(data: &Value, alias: &str, kind: IssueKind) -> Vec<IssueRef> {
    let nodes = data.pointer(&format!("/{alias}/nodes")).and_then(Value::as_array);
    nodes
        .into_iter()
        .flatten()
        // A search node of another type comes back as `{}` through the fragment.
        .filter_map(|n| {
            let number = n.get("number")?.as_u64()?;
            Some(IssueRef {
                key: number.to_string(),
                display: format!("#{number}"),
                title: n.get("title")?.as_str()?.to_string(),
                url: n.get("url")?.as_str()?.to_string(),
                kind,
            })
        })
        .collect()
}

fn only_not_found(body: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    match v.get("errors").and_then(Value::as_array) {
        Some(errors) if !errors.is_empty() => errors
            .iter()
            .all(|e| e.get("type").and_then(Value::as_str) == Some("NOT_FOUND")),
        _ => false,
    }
}

fn not_an_issue(number: u64, repo: &RepoRef, what: &str) -> ForgeError {
    ForgeError::Invalid {
        message: format!("#{number} is {what} in {}/{}", repo.owner, repo.repo),
    }
}

fn qualified(branch: &str) -> String {
    format!("refs/heads/{}", branch.trim_start_matches("refs/heads/"))
}

impl IssueSource for GitHubForge {
    fn list_assigned(&self, repo: &RepoRef) -> Result<Vec<IssueRef>, ForgeError> {
        let scope = format!("repo:{}/{} is:open", repo.owner, repo.repo);
        let data = self.graphql(
            ASSIGNED,
            json!({
                "issues": format!("{scope} is:issue assignee:@me"),
                "reviews": format!("{scope} is:pr review-requested:@me"),
                "first": ASSIGNED_CAP,
            }),
        )?;
        let mut out = refs_from(&data, "issues", IssueKind::Issue);
        out.extend(refs_from(&data, "reviews", IssueKind::ReviewRequest));
        Ok(out)
    }

    fn get(&self, repo: &RepoRef, key: &str) -> Result<Issue, ForgeError> {
        let number = number_of(key)?;
        let resp = self.graphql_response(GET, json!({ "owner": repo.owner, "name": repo.repo, "number": number }))?;
        if resp.status == 200 && only_not_found(&resp.body) {
            return Err(not_an_issue(number, repo, "not an issue"));
        }
        let data = graphql_data(&resp)?;
        let node = data.pointer("/repository/issueOrPullRequest").filter(|n| !n.is_null());
        let Some(node) = node else {
            return Err(not_an_issue(number, repo, "not an issue"));
        };
        if node.get("__typename").and_then(Value::as_str) != Some("Issue") {
            return Err(not_an_issue(number, repo, "a pull request, not an issue,"));
        }
        let text = |k: &str| node.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let title = text("title");
        Ok(Issue {
            key: number.to_string(),
            display: format!("#{number}"),
            suggested_branch: suggested_branch(&number.to_string(), &title),
            title,
            body: text("body"),
            url: text("url"),
        })
    }

    fn link_branch(
        &self,
        repo: &RepoRef,
        key: &str,
        branch: &str,
        base: Option<&str>,
    ) -> Result<LinkOutcome, ForgeError> {
        let number = number_of(key)?;
        let name = branch.trim().trim_start_matches("refs/heads/");
        if name.is_empty() {
            return Err(ForgeError::Invalid {
                message: "Branch name is empty".into(),
            });
        }
        let base = base.map(str::trim).filter(|b| !b.is_empty());
        let resp = self.graphql_response(
            LINK_PLAN,
            json!({
                "owner": repo.owner,
                "name": repo.repo,
                "number": number,
                "base": qualified(base.unwrap_or_default()),
                "head": qualified(name),
                "named": base.is_some(),
            }),
        )?;
        if resp.status == 200 && only_not_found(&resp.body) {
            return Err(not_an_issue(number, repo, "not an issue"));
        }
        let plan = graphql_data(&resp)?;
        let repository = plan
            .get("repository")
            .filter(|r| !r.is_null())
            .ok_or(ForgeError::NotFound)?;
        let issue = repository
            .get("issue")
            .filter(|i| !i.is_null())
            .ok_or_else(|| not_an_issue(number, repo, "not an issue"))?;
        let linked = issue
            .pointer("/linkedBranches/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|n| n.pointer("/ref/name").and_then(Value::as_str) == Some(name));
        if linked {
            return Ok(LinkOutcome::AlreadyLinked);
        }
        if repository.get("head").is_some_and(|h| !h.is_null()) {
            return Ok(LinkOutcome::Unlinked);
        }
        let from = if base.is_some() {
            "/base/target/oid"
        } else {
            "/defaultBranchRef/target/oid"
        };
        let oid = repository
            .pointer(from)
            .and_then(Value::as_str)
            .ok_or_else(|| ForgeError::Invalid {
                message: format!(
                    "{} is not on {}/{}, push it first",
                    base.unwrap_or("The default branch"),
                    repo.owner,
                    repo.repo
                ),
            })?;
        let str_at = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        self.graphql(
            LINK,
            json!({
                "issueId": str_at(issue, "id"),
                "oid": oid,
                "name": name,
                "repositoryId": str_at(repository, "id"),
            }),
        )?;
        Ok(LinkOutcome::Created)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::http::test_support::StubTransport;
    use crate::forge::http::HttpResponse;
    use std::sync::Arc;

    fn forge(responses: Vec<HttpResponse>) -> (GitHubForge, Arc<StubTransport>) {
        let stub = Arc::new(StubTransport::new(responses));
        let f = GitHubForge::new(
            Box::new(stub.clone()),
            "https://github.com",
            Some("gho_test".into()),
            None,
        )
        .with_base("https://api.test");
        (f, stub)
    }

    fn repo() -> RepoRef {
        RepoRef {
            owner: "gettori".into(),
            repo: "tori".into(),
        }
    }

    fn vars(stub: &StubTransport, i: usize) -> Value {
        let body: Value = serde_json::from_str(&stub.bodies()[i]).unwrap();
        body["variables"].clone()
    }

    #[test]
    fn the_assigned_list_is_issues_then_review_requests_in_one_request() {
        let (f, stub) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{
              "issues":{"nodes":[{"number":202,"title":"Issues","url":"https://github.com/gettori/tori/issues/202"},{}]},
              "reviews":{"nodes":[{"number":45,"title":"Fix","url":"https://github.com/gettori/tori/pull/45"}]}
            }}"#,
        )]);
        let list = f.list_assigned(&repo()).unwrap();
        assert_eq!(stub.request_count(), 1);
        assert_eq!(list.len(), 2);
        assert_eq!(
            (list[0].key.as_str(), list[0].display.as_str(), list[0].kind),
            ("202", "#202", IssueKind::Issue)
        );
        assert_eq!((list[1].key.as_str(), list[1].kind), ("45", IssueKind::ReviewRequest));
        let v = vars(&stub, 0);
        assert_eq!(v["issues"], "repo:gettori/tori is:open is:issue assignee:@me");
        assert_eq!(v["reviews"], "repo:gettori/tori is:open is:pr review-requested:@me");
    }

    #[test]
    fn an_issue_comes_back_with_its_suggested_branch() {
        let (f, _) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"issueOrPullRequest":{"__typename":"Issue","number":202,"title":"GitHub Issues as a source","body":"Do it.","url":"u"}}}}"#,
        )]);
        let issue = f.get(&repo(), "#202").unwrap();
        assert_eq!(issue.suggested_branch, "202-github-issues-as-a-source");
        assert_eq!((issue.key.as_str(), issue.body.as_str()), ("202", "Do it."));
    }

    #[test]
    fn a_pull_request_number_is_not_an_issue() {
        let (f, _) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"issueOrPullRequest":{"__typename":"PullRequest"}}}}"#,
        )]);
        let err = f.get(&repo(), "45").unwrap_err();
        assert!(
            matches!(&err, ForgeError::Invalid { message } if message.contains("pull request")),
            "{err:?}"
        );
    }

    #[test]
    fn a_missing_number_is_not_an_issue_rather_than_an_api_failure() {
        let (f, _) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"issueOrPullRequest":null}},"errors":[{"type":"NOT_FOUND","message":"Could not resolve"}]}"#,
        )]);
        let err = f.get(&repo(), "999999").unwrap_err();
        assert!(
            matches!(&err, ForgeError::Invalid { message } if message.contains("not an issue")),
            "{err:?}"
        );
    }

    #[test]
    fn a_key_that_is_not_a_number_never_reaches_the_host() {
        let (f, stub) = forge(vec![]);
        assert!(matches!(f.get(&repo(), "ENG-1"), Err(ForgeError::Invalid { .. })));
        assert_eq!(stub.request_count(), 0);
    }

    fn plan(linked: &str, head: &str) -> HttpResponse {
        StubTransport::json(
            200,
            &format!(
                r#"{{"data":{{"repository":{{"id":"R_1","defaultBranchRef":{{"target":{{"oid":"d3f"}}}},
                "base":{{"target":{{"oid":"ba5e"}}}},"head":{head},
                "issue":{{"id":"I_1","linkedBranches":{{"nodes":[{linked}]}}}}}}}}}}"#
            ),
        )
    }

    #[test]
    fn linking_makes_the_branch_at_the_bases_commit() {
        let (f, stub) = forge(vec![
            plan("", "null"),
            StubTransport::json(200, r#"{"data":{"createLinkedBranch":{"linkedBranch":{"id":"LB_1"}}}}"#),
        ]);
        let out = f.link_branch(&repo(), "202", "202-issues", Some("main")).unwrap();
        assert_eq!(out, LinkOutcome::Created);
        let asked = vars(&stub, 0);
        assert_eq!(
            (asked["base"].as_str(), asked["head"].as_str()),
            (Some("refs/heads/main"), Some("refs/heads/202-issues"))
        );
        let made = vars(&stub, 1);
        assert_eq!(
            made,
            json!({ "issueId": "I_1", "oid": "ba5e", "name": "202-issues", "repositoryId": "R_1" })
        );
    }

    #[test]
    fn no_base_links_from_the_default_branch() {
        let (f, stub) = forge(vec![
            plan("", "null"),
            StubTransport::json(200, r#"{"data":{"createLinkedBranch":{"linkedBranch":{"id":"LB_1"}}}}"#),
        ]);
        f.link_branch(&repo(), "202", "202-issues", None).unwrap();
        assert_eq!(vars(&stub, 0)["named"], false);
        assert_eq!(vars(&stub, 1)["oid"], "d3f");
    }

    #[test]
    fn a_branch_already_linked_is_not_made_twice() {
        let (f, stub) = forge(vec![plan(
            r#"{"ref":{"name":"202-issues"}}"#,
            r#"{"name":"202-issues"}"#,
        )]);
        assert_eq!(
            f.link_branch(&repo(), "202", "202-issues", Some("main")).unwrap(),
            LinkOutcome::AlreadyLinked
        );
        assert_eq!(stub.request_count(), 1);
    }

    #[test]
    fn a_branch_already_on_the_host_is_reported_unlinked_not_made() {
        let (f, stub) = forge(vec![plan("", r#"{"name":"202-issues"}"#)]);
        assert_eq!(
            f.link_branch(&repo(), "202", "202-issues", Some("main")).unwrap(),
            LinkOutcome::Unlinked
        );
        assert_eq!(stub.request_count(), 1);
    }

    #[test]
    fn linking_a_pull_request_number_is_not_an_issue() {
        let (f, stub) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"id":"R_1","defaultBranchRef":null,"head":null,"issue":null}},
               "errors":[{"type":"NOT_FOUND","message":"Could not resolve to an Issue"}]}"#,
        )]);
        let err = f.link_branch(&repo(), "193", "193-x", None).unwrap_err();
        assert!(
            matches!(&err, ForgeError::Invalid { message } if message.contains("not an issue")),
            "{err:?}"
        );
        assert_eq!(stub.request_count(), 1);
    }

    #[test]
    fn a_base_missing_on_the_host_is_refused_before_the_mutation() {
        let (f, stub) = forge(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"id":"R_1","defaultBranchRef":null,"base":null,"head":null,
               "issue":{"id":"I_1","linkedBranches":{"nodes":[]}}}}}"#,
        )]);
        let err = f
            .link_branch(&repo(), "202", "202-issues", Some("local-only"))
            .unwrap_err();
        assert!(
            matches!(&err, ForgeError::Invalid { message } if message.contains("local-only")),
            "{err:?}"
        );
        assert_eq!(stub.request_count(), 1);
    }
}
