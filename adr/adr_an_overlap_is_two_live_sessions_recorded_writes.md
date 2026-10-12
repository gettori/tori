---
summary: an overlap is two live chats' recorded writes still differing from base, not branch diffs, so PTY agents never overlap
status: current
updated: 2026-10-12
source: Conflict radar plan (branch `phase-1-block-2`, gettori/tickets#33); commits 8bf7aed9, 7cfd89cb, e15376c2; `src-tauri/src/radar.rs` (`side_of`, `intersect`)
---

# An overlap is two live sessions' recorded writes

## Context

gettori/tickets#33 asked to warn when two agents edit the same file across worktrees, before the rework surfaces at the pull request. Tori already records each chat's written paths per turn ([[component_turn_checkpoints]]) and knows which sessions are live. Git knows what each branch changed.

## Decision

An overlap is a file that two live sessions (any state but Ended, idle included) in different worktrees of one repository both recorded writing, and that still differs from the base in both worktrees. It is per session, listed from both sides, and names the other worktree's current branch.

## Alternatives rejected

- **Branch-diff intersection**: survives after the sessions end, which is closer to where rework bites, but cannot name a session and does not match the ticket's "live".
- **Every write the session ever made**: keeps flagging files that were reverted or already merged.
- **Dirty-vs-base files as a stand-in for a PTY session**: would claim edits no session made in that worktree.
- **Running only for Working or NeedsYou sessions**: two idle sessions with unpushed edits are exactly the PR rework case.

## Consequences

- PTY agents record no writes, so they never overlap; their branches still get base conflicts. The docs say so.
- Because it is per session, the autopilot can name the other item and hold the later one.
- A session that edits outside a turn's record (a shell heredoc) is under-counted, the same limit attribution already has.

## Related

- [[component_conflict_radar]]: the implementation
- [[adr_autopilot_is_a_session_not_a_state_machine]]: why the autopilot reacts through its brief, not Rust gating
