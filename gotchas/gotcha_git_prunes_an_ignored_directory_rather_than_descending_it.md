---
summary: git already prunes an ignored directory instead of descending it, so an exclude pathspec for it only breaks git add A
status: current
updated: 2026-07-29
source: Chat surface plan, phase 12 (personal/sway, branch `chat`); `src-tauri/src/attempts.rs` (`the_per_turn_snapshot_does_not_walk_the_attempts`)
---

# git prunes an ignored directory rather than descending it

Do NOT add an exclude pathspec to keep `git add -A` from walking a large ignored directory: it is not walked anyway, and the pathspec **breaks the command**. `git add -A -- . :(exclude)<ignored>` errors, because an exclude matching only ignored paths counts as naming ignored paths, so the "optimisation" would fail every snapshot on any project that has the directory. Why: git prunes at the ignored directory instead of descending it (measured: 4000 ignored files added in 34ms against 200ms for the same files tracked). The ignore entry alone is the mechanism.
