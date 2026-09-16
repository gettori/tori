---
summary: let _ = async_fn() drops the future unpolled after a sync-to-async codemod, grep discard sites before trusting build
status: current
updated: 2026-08-20
source: Worktree and tab switching at native speed (personal/sway, branch `unified-tab-bar`), Phase 2, commit d8714d0, `src-tauri/src/exec.rs`
---

# `let _ = converted_command(...)` builds a future and throws it away

## What happened

Sweeping ~150 Tauri commands from sync to async had exactly one silent failure
mode, and it shipped once before being caught. An internal caller written as
`let _ = some_command(...)` compiled perfectly after the conversion, because
the expression now constructs a future and immediately drops it. The body never
runs. The real case was `discard_attempt`'s checkpoint prune, which quietly
stopped pruning.

## Why

`let _ = expr` discards the value, and a future *is* a value. Before the
conversion the call did its work and returned a result nobody read, which is
fine; after it, the work is the thing being discarded. The compiler is happy
either way. Only clippy's `let_underscore_future` lint catches it, and it is
not on by default.

## What to do next time

**When a codemod changes a function's return type from a value to a lazy one,
grep for every discard site before trusting the build.** A green compile means
nothing here. Specifically:

- Sweep for `let _ =` against the converted symbol set with a script, and check
  the count reaches zero outside tests.
- Turn on `clippy::let_underscore_future` if the sweep will happen again.
- The same shape applies to any sync-to-lazy conversion, not just Tauri
  commands: `impl Future`, builders that need `.await`, anything where the
  useful work moved from call time to poll time.

## Related

- [[concept_command_execution_tiers]] - the conversion this happened during
- [[adr_no_sync_ipc_commands]] - the sweep's policy
- [[lesson_a_registered_command_with_no_caller_is_not_shipped]] - the neighbouring "it compiled but does nothing" failure
