---
summary: pty_spawn delivers init backend once, re-subscribing to the same tab id is a no-op, put the run ordinal in the tab id
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 14 (personal/sway, branch `wave-6`); `src-tauri/src/pty.rs`, `src/utils/tasks.ts:150`; commit 44d8c99"
---

# `pty_spawn`'s `init` fires once, so a re-run needs a new tab id

Do NOT try to re-run a command in an existing terminal tab. `pty_spawn` delivers `init` backend-once and is idempotent on re-subscribe, which is what makes a remount re-subscribe rather than re-type; the shell has already taken its one command line, so a second run in that tab is a no-op. Kill-and-respawn does not save it either: `closeId` fires `pty_kill` asynchronously while the fresh mount's `pty_spawn` re-subscribes to a session still in `PtyState`, so the re-run attaches to the process being killed. Put the run ordinal in the tab id.
