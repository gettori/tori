---
summary: only pty and lsp_send stay sync on the IPC thread by design, because their ordering is semantics, not just a lock
status: needs-verification
updated: 2026-08-20
source: not recorded; imported from grimoire docs/personal/tori
---

# No command that can block runs on the IPC thread

Every Tauri command in Tori used to be a sync `fn` executed inline on the IPC
thread, which made the backend a global serialisation point: one warm worktree
switch issued 57 invokes, 654ms of body time, all strictly serialized, with a
median queue wait of 132ms and a worst case of 1437ms. We decided the rule is
**"no command that can block runs on the IPC thread"**, not "every command is
async", and split the surface into three classes with different treatment.

The three classes:

1. **Free reads.** Run concurrently with no lock. Hot switch-path commands
   become `async fn` bodies dispatched through `exec::blocking`.
2. **Git writes.** Serialize behind an async mutex keyed by the *resolved*
   `git rev-parse --git-common-dir`, cached per path, so worktrees of one repo
   share the lock their shared `.git` implies.
3. **Order-sensitive fast commands.** Stay sync on the IPC thread by design:
   the whole `pty` family and `lsp_send`. These are microsecond fd operations
   where blocking is harmless and **arrival order is semantics**.

## Considered Options

**Blanket async on every command** was the obvious reading of "sweep the sync
commands" and it is wrong. The single IPC thread was silently providing two
guarantees, not one: mutual exclusion *and* arrival ordering. Converting
`pty_write` would have kept the first and destroyed the second, so a rapid
chunked paste could arrive out of order, and `pty_spawn`'s check-then-insert is
only safe single-threaded (a concurrent remount would double-spawn the shell).
The ordering guarantee was invisible because nothing declared it; it was a side
effect of the execution model. See
[[lesson_the_ipc_thread_was_also_the_lock]].

## Consequences

- Every load-modify-save store mutator needed an explicit `named_lock`, because
  the IPC thread had been their implicit lock too (tori.toml, attached.json,
  settings, the session overlay, touched-file attribution).
- `git status` reads cannot run outside the repo write lock without
  `--no-optional-locks`, because a concurrent `git add` *fails* on `index.lock`
  rather than waiting. See [[gotcha_git_status_takes_the_index_lock_opportunistically]].
- `exec::blocking` re-panics a panicked body: the promise never resolves and the
  app survives, where the sync form took the whole app down.
- ~120 lower-traffic commands use the one-line `#[tauri::command(async)]`
  attribute form, which blocks a tokio worker and emits no body span. Accepted:
  bounded by core count, and the hot path avoids both.

Measured result: bodies on `ThreadId(1)` went from all of them to **zero**,
overlapping body pairs from **0 to 514-519** per run (up to 7 concurrent), and
worst-case queue wait from 1437ms to 4.3ms.

## Related

- [[concept_command_execution_tiers]] - the `exec.rs` seam this rule is enforced through
- [[lesson_the_ipc_thread_was_also_the_lock]] - why blanket async was rejected
- [[component_pty_host]] - the largest class-3 surface
- [[concept_release_profile_tracing]] - how the before and after were measured
