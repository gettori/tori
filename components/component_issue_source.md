---
summary: issue source: a second adapter axis beside the forge, canonical keys, read per contract source, gated in Rust
status: current
updated: 2026-10-08
source: "gettori/tori#202 on branch orchestrator; commits f8a61936, 83aa08f4, 982c9bed; src-tauri/src/issues/{mod,github,gate,store,commands}.rs; src/components/Dialogs/AddBranchDialog.tsx; src/utils/issues.ts; gettori/tori#210 on branch orchestrator, plan 'Assigned pickup: poll my issues and review requests, queue them, start on ask or auto (#210)'; gettori/tickets#31 on branch phase-1-block-1, plan 'Issue sources per project, and the autopilot on Tori\'s own repo', commit e7d4df6f"
---

# Issue source

`src-tauri/src/issues/` where a branch unit's work comes from, the left half of its life, beside the forge that is the right half.

## Responsibility

- Declares `IssueSource` (`issues/mod.rs`): `list_assigned` (open issues assigned to the viewer, then PRs waiting on the viewer's review, each with a `kind`), `get` (title, body, url, `suggested_branch`) `list_matching` (the open issues one `IssueQuery` matches) and `link_branch` (make the branch on the host under the issue, answering `Created`, `AlreadyLinked` or `Unlinked`). Everything is keyed by an opaque string `key` with a `display` beside it, because the record below is persisted and Linear's keys are `ENG-123`.
- The GitHub impl lives on `GitHubForge` and is reached through `Forge::issues()` (default `None`), so an issue call rides the repo's account pick and `attempt`'s token renewal like any PR call. GitLab answers `None`.
- Gates every call per account (`issues/gate.rs`): a `RateLimited` answer closes the gate until the host's own deadline. Lists are fetched on demand, never polled, through a 30 s cache with `SingleFlight`, keyed on account plus what was asked (the repo, or a query's search string), so two projects reading one ticket repo with different labels never share an answer. See [[concept_forge_rate_budget]].
- `IssueQuery { repo, labels, exclude_labels, milestone, assignee, extra }` is a contract's issue source. `search()` builds the GitHub search, quoting every value and dropping `"`; `assignee` left out is `@me`, `any` drops it. `check()` refuses a repo that is not `owner/name`, since a search with no repo in it reads every repo the account sees; `autopilot.project.set` refuses on it and pickup treats it as a failed source.
- Keys are canonical (`canonical_key(key, origin)`, `display_of`): bare `N` for the project's own repo, `owner/name#N` for any other, from `N`, `#N`, `owner/name#N` or a URL. Search rows read `repository { nameWithOwner }`, `get` answers the canonical key, and a foreign issue's branch suggestion leads with its repo name (`tickets-31-...`).
- `get` and `link_branch` read the issue from the repo its key names. `LINK_PLAN` asks for the project's repo and the issue's repo as two aliases, and `createLinkedBranch` gets the project repo's `repositoryId`, so the branch lands in the project while the issue lives elsewhere.
- `assigned(project, sources, refresh)` and `assigned_if_offered` gather one list per source beside the origin's review requests (`Assigned { lists, failed }`); with no sources it is the origin's own assigned list, as before. The `issues_assigned` command and `issues.assigned` answer the union, so the Add branch Issue tab lists source issues.
- Remembers which issue a unit was started from in `~/.config/tori/unit_issues.json` (`issues/store.rs`), keyed by project path then branch. Written only once the local branch exists, pruned only on a write and only when the branch is gone locally and on `origin`. `resolve` in `config.rs` attaches it to `BranchUnit.issue`.
- Is polled by assigned pickup through `assigned_if_offered` (one client resolve, `None` where `offered` says no), called from the webview's forge poll tick ([[adr_assigned_pickup_rides_the_forge_poll_tick]]). Does **not** flip board status; that is #173.

## Interface

- Tauri: `issues_source` (no request, from the account's recorded scopes), `issues_assigned`, `issues_get`, `issues_link` (links, then fetches the branch with `git::fetch_branch_quiet` so a local one can track it), `issues_record`.
- Socket: `issues.assigned`, `issues.get`, `issues.link_branch` (not workers), and `worktree.new {issue?}`. `issues.get` with a URL and no project finds it by origin, else by the one project whose sources read that repo, and refuses naming them when several do. See [[component_app_socket]] and [[adr_one_protocol_several_fronts]].
- UI: the Issue tab of `AddBranchDialog`, shown when `issues_source` says yes. It links first when asked (the host makes the branch), then `create_worktree` with no base tracks `origin/<name>`, or a plain repo attaches and checks it out. The row shows `display` and opens the url. `NEW_CHAT_AT {prompt, origin}` seeds the draft with title and body, and `ChatDraft` shows "from #N" until the first send remounts it as `ChatView`.
- A key that is not an issue, a base missing on the host and a token that cannot read issues all come back as `invalid` or `forbidden` with the sentence to show.

## Related

- [[component_forge_client]]: the client this rides
- [[gotcha_createlinkedbranch_only_makes_a_new_ref]]: why linking comes before the local branch
- [[gotcha_github_graphql_answers_a_missing_number_with_a_not_found_error]]: how `get` tells a missing number apart
- [[gotcha_string_of_an_invoke_rejection_can_be_object_object]]: how the UI reads these errors
- [[gotcha_an_assigned_list_at_the_search_cap_proves_nothing_missing]]: why a full list closes nothing
- [[adr_assigned_pickup_rides_the_forge_poll_tick]]: who polls this, and when
- [[adr_issue_sources_live_on_the_contract]]: the decision behind sources and canonical keys
