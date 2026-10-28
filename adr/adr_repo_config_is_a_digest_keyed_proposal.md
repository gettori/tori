---
summary: repo config is each worktree's own .tori/project.json, accepted by content digest; the user's value wins, declining is the off switch
status: current
updated: 2026-10-28
source: plan "Shareable project config in the repository, trust-gated" (branch shareable-project-config, gettori/tickets#49); commits ef60287f, d944ce30, e8de60e9, 70a3fb0c; gettori/tickets#49 brief comment
---

# Repo config is a digest-keyed proposal

## Context

Setup, run and teardown commands, the port count and verification commands lived only in the user's own settings, so a team could not share them. A file in the repo is code from whoever last committed it, and Tori already holds that a repository never grants itself anything ([[concept_workspace_settings_overlay]]).

## Decision

Each worktree's own `.tori/project.json` is a proposal. Acceptance is keyed by trust scope plus sha256 of the content and kept outside the repo. A changed file asks again. Trust comes first, forks never read it, and an unaccepted file falls back to the user's commands and asks. Field by field the user's non-empty value wins, and turning a repo command off means declining the file. v1 carries worktree fields only, `ports` narrows the exported variables inside the fixed 10-wide block, and acceptance is never reachable from the socket.

## Alternatives rejected

- **A default-branch blob**: simpler, but a branch could not change its own setup, and Settings would show commands other worktrees do not run.
- **A per-field "ignore repo" flag**: empty already means unset in `WorktreePrefs`, so a flag would be a second meaning for the same state.
- **Real variable port widths**: needs a `ports.json` migration.
- **Skipping setup, or holding creation, while unaccepted**: stalls autopilot workers on a question nobody is there to answer.
- **Issue sources and agents in the file**: per project, and a per-worktree file cannot speak for them without picking a winner ([[adr_issue_sources_live_on_the_contract]] still holds).
- **Rerunning setup automatically on accept**: starts an install nobody chose, so Accept offers Run setup now instead.

## Consequences

Two branches can carry different files, so the settings page lists each accepted value with the worktrees it covers rather than one value. A file edited in a worktree already checked this launch does not toast until the next launch, though runners still refuse it and Tooling lists it. See [[concept_repo_proposals]].
