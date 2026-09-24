---
summary: forge client owns the OAuth device flow, keychain credential and caches in Rust, and the token never crosses the bridge
status: current
updated: 2026-09-24
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phases 1, 2, 3, 5, 13; commits 474f146, e73cf00, b16724c, 7f9be1a, 8aedaed, 945c1bd; gettori/tori#202 commit f8a61936"; gettori/tori#204 commits 424a5d26, aa67f28d, 29293fe2, 280f72e8
---

# Forge client (Rust)

**Location:** `src-tauri/src/forge/` (key files: `mod.rs`, `http.rs`, `github.rs`, `model.rs`, `token.rs`, `device_flow.rs`, `auth.rs`, `prs.rs`, `status.rs`, `commands.rs`)

Everything Tori knows about a forge's HTTP API. It owns the provider trait, the transport, the credential, the two caches and the Tauri command surface. It reaches the network on a plain blocking `fn` (so Tauri runs it off the async runtime, matching `model.rs` and `update.rs`), and it never hands the access token to the frontend.

## Responsibilities

- Declares the forge-neutral surface (`Forge`) and the GitHub implementation of it, plus a `Stub` that answers `NotAuthenticated`.
- Owns the OAuth device flow end to end: the `device_code` never leaves Rust and the access token never crosses the Tauri bridge.
- Stores the credential in the macOS login keychain and decides what a rejection of it means.
- Batches a project's status into one request, caches it, and collapses concurrent ticks.
- Does **not** decide when to poll, how to back off, or what any of this looks like. Those live in `forgePoll.ts` and the panel ([[concept_forge_rate_budget]]).
- Does **not** touch layer 1. Clone, fetch and push remain system `git` plus [[concept_askpass_bridge]], which authenticates separately on purpose.

## Key files & entry points

- `mod.rs:154` - `pub trait Forge`, the whole provider surface, plus `MergeMethod` and the error type
- `http.rs:143` - `pub trait Transport`, the seam every test substitutes
- `http.rs:203` - `classify`, which turns a response into a `ForgeError` and reads `X-RateLimit-Reset` off the refusal
- `http.rs:299` / `http.rs:445` - `paginate_rest` (Link header) and `paginate_graphql` (cursors, top-level pages before nested connections)
- `github.rs:46` - `PR_FILE_CAP`, GitHub's 300-file ceiling
- `github.rs:192` - `require_token`, the guard every authenticated call opens with
- `token.rs:19` - the keychain service name, stable because changing it orphans stored tokens
- `auth.rs:158` - `note_result`, which marks a credential suspect without deleting it
- `status.rs:63` - `plan_tick`, what to ask about and how much it could not cover
- `status.rs:198` - `SingleFlight<T = Fetched>`, so two triggers make one request; generic so the assigned-issues list reuses it
- `Forge::issues()` - the same host as an issue source, `None` by default, `Some(self)` on GitHub ([[component_issue_source]])
- `github.rs` `graphql_response` - the raw GraphQL answer, beside `graphql`, for a caller that must read an error's `type` ([[gotcha_github_graphql_answers_a_missing_number_with_a_not_found_error]])
- `Forge::pull_request_states(repo, numbers)` - open, closed or merged for many PRs in one request: aliased `pullRequest(number:)` on GitHub, an `iids[]` list on GitLab. `commands::pull_request_states` goes through `gated_client` and keys each answer by `owner/name`, for [[component_autopilot_store]]
- `prs.rs:135` - `push_then_create`, always in that order, never a pre-check on ahead/behind
- `commands.rs` - the Tauri surface, including `landing()`, which invalidates both caches for a repo on a successful merge

## Connections

- Governed by [[adr_github_api_layer]] - the trait, the device flow and the keychain are that decision
- Implements [[concept_forge_provider_seam]] and the Rust half of [[concept_forge_rate_budget]]
- Feeds [[component_pull_requests_panel]] and the sidebar chips
- Feeds [[component_presence]] - a failing required check raises the needs-you dot ([[concept_needs_you_floor]])
- Calls into `git.rs` for `push` and for the PR-head fetch of [[concept_pr_diff_two_sources]]

## Related

- [[lesson_never_hold_a_cache_lock_across_a_network_call]] - a bug in `prs.rs`, caught in self-review
- [[lesson_a_suspect_latch_must_be_able_to_clear]] - a bug in `http.rs`'s `Recording`
- [[gotcha_keyring_the_all_in_one_crate_is_the_wrong_dependency]]
- [[gotcha_a_422s_actionable_text_is_in_errors_not_message]]
- [[gotcha_paginate_graphql_drains_top_level_pages_before_nested_connections]]
- [[component_issue_source]] - rides this client through `Forge::issues()`
- [[gotcha_string_of_an_invoke_rejection_can_be_object_object]] - how a `ForgeErrorDto` rejection reads in the webview
