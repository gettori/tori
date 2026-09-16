---
summary: the Forge trait sits over a Transport seam so rate budget and a rejected credential are captured once, not per method
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phases 1 to 3; commits 474f146, e73cf00, 7f9be1a; `src-tauri/src/forge/mod.rs:154`, `src-tauri/src/forge/http.rs:143`, `src-tauri/src/forge/github.rs`"
---

# Forge provider seam (trait over transport)

Layer 2 of git's two auth layers (the forge HTTP API, where pull requests, review threads and checks exist) sits behind a single `Forge` trait, and every byte that trait sends passes through a separate `Transport` seam. Two seams rather than one, because they answer different questions: the trait is where a second forge would be added, the transport is where a test replaces the network and where facts that belong to *every* request (the rate budget, a rejected credential) are captured once instead of at each call site.

## How it works

- **`pub trait Forge`** (`forge/mod.rs:154`) declares the whole surface in forge-neutral terms: look up a PR for a branch, create one, read checks and review decision, read files, read and reply to threads, submit a review, merge, update a branch. A `Stub` implementation answering `NotAuthenticated` sits beside it, so the app compiles and behaves sanely with no credential at all.
- **`pub trait Transport`** (`http.rs:143`) is one method, `send(HttpRequest) -> Result<HttpResponse, ForgeError>`. `GitHubForge` is built over a `Transport`, so every test drives the real client against a recorded exchange rather than a mocked client.
- **`Recording` wraps a transport rather than extending the client.** Two facts are per-request and belong to no single call: the `X-RateLimit-*` snapshot, and whether the credential was just rejected. Threading them through every method would mean every new method remembering to. Wrapping means it cannot be forgotten.
- **REST or GraphQL, chosen per operation, not per client.** Checks plus review decision for a whole project is one GraphQL query; replies to a review thread only exist in GraphQL; the rest is REST. See [[concept_forge_rate_budget]] for why the batching is load-bearing rather than a style choice.
- **Two pagination walkers, both in the transport** (`http.rs:299` `paginate_rest`, `http.rs:445` `paginate_graphql`). They are not one function with a flag: REST pages by a `Link` header and GraphQL by a cursor inside the payload, and the GraphQL walker additionally has to drain every top-level page *before* filling each node's nested connection (see [[gotcha_paginate_graphql_drains_top_level_pages_before_nested_connections]]).
- **Redaction covers response bodies, not just headers.** An `Authorization` header is the obvious leak; a device-flow or token response carries the credential in its *body*, so `SECRET_KEYS` values are redacted in every `Debug` too. The token never crosses the Tauri bridge and the `device_code` never leaves Rust.
- **A 401 suspends, it never destroys.** `auth::note_result` (`auth.rs:158`) marks the credential suspect; only an explicit sign-out or a fresh sign-in clears the keychain entry. A transient rejection must not delete a working token.

## Why it's this way

[[adr_github_api_layer]] chose the provider trait so GitLab or Bitbucket can be added without rework, and in-app OAuth so nothing depends on an external binary. The transport seam was not in that decision and was added during Phase 1 for a concrete reason: rate capture and the suspect flag were originally per-method, which made every new trait method a place to forget them. Moving both into a wrapper turned "remember to record this" into "you cannot avoid recording this".

## Related

- [[component_forge_client]] - the module cluster this describes
- [[concept_forge_rate_budget]] - what the batching in this client is defending
- [[adr_github_api_layer]] - the decision that put layer 2 behind a trait
- [[adr_git_integration_auth]] - layer 1, which authenticates separately and on purpose
- [[concept_askpass_bridge]] - the layer-1 credential mechanism, deliberately not reused here
- [[lesson_a_suspect_latch_must_be_able_to_clear]] - the flag this seam owns, and how it went wrong
- [[gotcha_a_422s_actionable_text_is_in_errors_not_message]] - reading a refusal from this client
