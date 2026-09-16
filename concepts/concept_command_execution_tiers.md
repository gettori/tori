---
summary: every blocking Tauri command runs through exec.rs, which picks the thread and lock, keyed by the resolved git dir
status: current
updated: 2026-08-20
source: Worktree and tab switching at native speed (personal/sway, branch `unified-tab-bar`), Phase 2, commit d8714d0, `src-tauri/src/exec.rs`
---

# Command execution tiers and the `exec.rs` seam

Every Tauri command that can block goes through `exec.rs`, which is the single
seam where Sway decides *where* a command body runs and *what lock it holds*.
It exists because [[adr_no_sync_ipc_commands]] needed one place to enforce its
three classes, and because the sync backend had been doubling as an implicit
lock for things nobody had written down.

## How it works

Four entry points, each answering a different question:

- **`blocking(name, f)`** = `spawn_blocking` plus a `{"t":"body",...}` trace
  line carrying the real thread id. The `traced` wrapper around
  `generate_handler!` cannot see async bodies, so its `cmd` line is dispatch
  only (~5us on `ThreadId(1)`); the `body` line is the actual work. Reading a
  trace means knowing which of the two you are looking at.
- **`git_write(name, path, f)`** adds the per-repo write lock on top.
- **`repo_lock`** is keyed by the resolved `git rev-parse --git-common-dir`,
  cached per path and invalidated by `git_init`/`bare_init` through
  `forget_common_dir`. Resolving rather than using the path directly is what
  makes two worktrees of one repo share the lock their common `.git` implies.
- **`named_lock(store)`** serializes load-modify-save stores.

**Three conversion tiers**, picked per command:

1. Hot switch-path commands: `async fn` plus `exec::blocking` with `_body`
   extraction. Real body spans, runs on the blocking pool.
2. Git writes: `exec::git_write` (30 commands).
3. Everything else that can block: the one-line `#[tauri::command(async)]`
   attribute form (~120 commands). Runs on a tokio worker, no body span.

Class 3 of the ADR (the `pty` family, `lsp_send`) never reaches `exec.rs` at
all; it stays sync on the IPC thread deliberately.

## Why it's this way

The tiering is a cost decision. `_body` extraction breaks every direct test
caller (~180 call sites had to be fixed), so it is spent only where a body span
is worth having, which is the switch path the plan's targets are read from.
The attribute form is one line and no test churn, so it covers the long tail.

Single-flight accompanies every lock-drop: `cached_probe` re-checks the cache
under a per-path flight lock and probes with no lock held (8 concurrent cold
probes collapse to 1 subprocess), and `index_roots` walks lock-free then
lock-swaps. This is [[lesson_never_hold_a_cache_lock_across_a_network_call]]
applied to subprocesses and fs walks.

## Related

- [[adr_no_sync_ipc_commands]] - the decision this seam enforces
- [[lesson_the_ipc_thread_was_also_the_lock]] - what the sweep had to restore explicitly
- [[lesson_a_converted_command_dropped_with_let_underscore]] - the codemod's silent failure mode
- [[gotcha_git_status_takes_the_index_lock_opportunistically]] - why reads need `--no-optional-locks`
- [[gotcha_the_command_attribute_async_form_compiles_where_a_true_async_fn_does_not]] - the macro constraint that shaped the tiers
- [[concept_release_profile_tracing]] - where the `cmd` and `body` lines are read
