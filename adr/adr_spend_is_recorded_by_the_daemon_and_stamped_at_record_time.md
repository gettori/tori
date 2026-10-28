---
summary: spend is written by the daemon on a live TurnCompleted and stamped with branch and item then; issue and PR are derived on read
status: current
updated: 2026-10-28
source: gettori/tickets#48 on branch cost-per-ticket, plan "Cost per ticket and per pull request, with a projection before queueing", commits 798e6f83, a72dc201, 6374485e, e0acfc08; src-tauri/src/chat/usage.rs:174; src-tauri/src/chat/host.rs:209
---

# Spend is recorded by the daemon and stamped at record time

## Context

Usage used to be one total per session per folder, written by the webview's `chat_record_usage` from a mounted `ChatView`, plus the second opinion's own write. Chats are served by the daemon and a worker's turn often ends with no window open, so it was never recorded. Nothing mapped a record back to a branch, an item, an issue or a pull request.

## Decision

The daemon records every live turn, through an `OnTurn` hook on `ChatHost`, and stamps it with the repo's git common dir, the branch, the item and the time, in buckets per (session, branch). Issue and PR totals are derived at read time from branch links and PR heads. Nothing is backfilled.

## Alternatives rejected

- Keeping the webview write and adding a Rust fallback: double counts whenever a pane is open.
- Deriving the branch from the folder alone: misattributes the main checkout's branches and a reused worktree.
- Stamping the issue key: freezes it against a later relink.
- One stamp per session, last wins: a branch switch inside a chat would move earlier spend.
- Backfilling old worktree files onto the worktree's current branch: a guess.

## Consequences

The session and project ceilings now read totals from `usage://changed` instead of a write's return. `repo` is stamped because a merged worktree's folder is gone. Records from before the change count toward no branch or item, so the projection starts empty. Reused branch names are not told apart.

## Related

- [[concept_spend_attribution]]: how the records are read
- [[concept_spend_ceilings]]: the ceilings that moved to the event
