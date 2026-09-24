---
summary: a missing issue number comes back as NOT_FOUND in errors[] beside a null, and graphql_data folds it into Api 200
status: current
updated: 2026-09-24
source: "gettori/tori#202 on branch orchestrator; commits f8a61936, 83aa08f4, 982c9bed; src-tauri/src/issues/github.rs only_not_found; src-tauri/src/forge/http.rs graphql_data; gettori/tori#204 commit 280f72e8, src-tauri/src/forge/github.rs pull_request_states"
---

# GitHub GraphQL answers a missing number with a NOT_FOUND error

Do not expect `repository.issue(number:)` or `issueOrPullRequest` to answer a plain `null` for a number that is not there: GitHub adds `{"type": "NOT_FOUND"}` to `errors[]`, and `graphql_data` turns any non-`FORBIDDEN` error into `Api { status: 200 }` with the raw message. Why: the typed answer ("#N is not an issue") needs the error's `type`, so read the raw answer with `GitHubForge::graphql_response` and check it before unwrapping. In an aliased batch the same error fails the whole call, even though `data` still holds every other alias: `pull_request_states` keeps that partial `data` whenever `repository` is present.

## Related

- [[component_issue_source]]
- [[component_forge_client]]
- [[component_autopilot_store]]
