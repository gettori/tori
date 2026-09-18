---
summary: a single threaded backend was quietly providing mutual exclusion and ordering, making commands async removes both
status: current
updated: 2026-08-20
source: Worktree and tab switching at native speed (personal/tori, branch `unified-tab-bar`), Phase 2, commit d8714d0, `src-tauri/src/exec.rs`, `src-tauri/src/pty.rs`
---

# The single-threaded backend was the lock and the ordering, not just the executor

## What happened

The ticket asked to sweep every sync Tauri command off the IPC thread, and the
obvious reading was "make them all async". That would have shipped two silent
regressions. Running everything inline on one thread had been providing
**mutual exclusion** for every load-modify-save store in the app, and
**arrival ordering** for fire-and-forget command streams. Neither was written
down anywhere; both were side effects of the execution model.

## Why

Nothing declared these guarantees, so nothing broke at compile time when they
were removed. Concretely:

- `pty_write` keystrokes stayed byte-ordered only because execution followed
  IPC arrival. Async-ify it and a rapid chunked paste can arrive scrambled.
- `pty_spawn`'s check-then-insert is only safe single-threaded; concurrent
  execution lets a remount double-spawn the shell.
- tori.toml, attached.json, settings, the session overlay and touched-file
  attribution were all load-modify-save with no lock of their own.
- `git status` opportunistically takes `index.lock`, and a concurrent
  `git add` *fails* rather than waits, so even two "reads" were not safe
  together.

## What to do next time

**Before removing a serialisation point, enumerate what was riding on it, and
split "cannot run together" from "must run in this order".** They are different
guarantees and they need different fixes: mutual exclusion becomes an explicit
lock, ordering becomes either a FIFO or a decision to leave that command
serialized. The sweep therefore shipped a written concurrency policy with three
classes rather than a blanket conversion, and class 3 (the `pty` family,
`lsp_send`) stays sync **by design**, which is a thing to state loudly so a
future reader does not "finish the job".

## Related

- [[adr_no_sync_ipc_commands]] - the policy this produced
- [[concept_command_execution_tiers]] - where the locks live now
- [[component_pty_host]] - the ordering-sensitive surface
- [[gotcha_git_status_takes_the_index_lock_opportunistically]] - the trap that caught this
