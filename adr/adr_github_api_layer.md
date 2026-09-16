---
summary: in-app GitHub OAuth device flow behind a forge provider trait, beating the gh CLI and pasted PATs
status: current
updated: 2026-08-03
source: "Editor roadmap discussion (personal/sway, branch editor-improvements, 2026-08-01); implemented by Editor Wave 3: GitHub as a first-class surface (branch `wave-3`, 14 commits 474f146 to 945c1bd), issue #22 and its five sub-issues"
---

# GitHub API layer: in-app OAuth device flow behind a forge provider trait

Git has two auth layers and Sway only had one. Layer 1 is the git protocol (clone, fetch, push): system `git` + the askpass bridge, already built ([[adr_git_integration_auth]], [[concept_askpass_bridge]]), unchanged by this decision. Layer 2 is the forge HTTP API, the only place PRs, review threads, and CI checks exist. For layer 2 we decided: **in-app OAuth device flow from day one** (Sway-registered GitHub OAuth app, `POST /login/device/code` + token poll, no client secret), token stored in the **macOS keychain**, and every API call behind a **forge provider trait** so GitLab/Bitbucket can be added without rework. This un-defers the "provider OAuth deferred and pluggable" clause of [[adr_git_integration_auth]]: the PR/review/checks surface is now core, so its auth is core.

## Considered Options

- **Probe and use the `gh` CLI** (rejected): matches the system-tools philosophy and ships fastest, but makes an external binary the gate for a core surface, ties Sway to gh's auth state, and leaves gh-less users with nothing.
- **PAT pasted into settings** (rejected): trivial to build, but the worst UX and pushes scope management onto the user.
- **gh now, OAuth later** (rejected): front-loads features but ships a throwaway auth path; the user chose to pay the plumbing cost once, up front.
- **In-app OAuth device flow** (chosen): VS Code-grade UX (VS Code likewise ships a built-in OAuth GitHub auth provider with keychain-backed storage feeding its PR extension), works in a desktop app without a redirect server, no dependency.

## Consequences

- Sway must register a GitHub OAuth app and own token storage, scope requests (start with `repo`), refresh-on-revoke, and API rate-limit handling (poll on focus + interval, cache aggressively).
- The provider trait is the seam for other forges and for capability differences (e.g. GitLab MRs); provider detection can reuse `parseOrigin` in `src/utils/prUrl.ts`.
- Unauthenticated Sway keeps the existing compare-URL "Open PR" flow as the fallback; nothing regresses without sign-in.
- The auth foundation ticket gates every Wave 3 feature (PR create, checks in sidebar, full in-app review, merge).

## What shipped

The seam turned out to be **two** seams, not one: the provider trait where a second forge would be added, and a transport underneath it where rate capture, the suspect-credential flag and every test substitution live ([[concept_forge_provider_seam]]). The rate budget shaped more of the design than the decision anticipated: a tick asks about a **project**, never a unit ([[concept_forge_rate_budget]]). Sign-in is the device flow as decided, with the token in the login keychain and a 401 suspending rather than destroying it.

## Related

- [[component_forge_client]] - the implementation
- [[component_pull_requests_panel]] - the surface it feeds
- [[concept_forge_provider_seam]] - the trait plus transport shape this decision became
- [[concept_forge_rate_budget]] - the constraint that shaped the poll layer
- [[adr_git_integration_auth]] - layer 1, and the deferral this supersedes in part
- [[concept_askpass_bridge]] - the layer-1 credential mechanism, deliberately not reused for API calls
- [[component_changes_panel]] - the surface whose push/PR flow the API layer upgrades
- [[component_presence]] - the needs-you pipeline that CI/check states will feed
