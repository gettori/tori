---
summary: a sync Tauri command runs on the main thread; waiting there on a lock another thread holds across a tray menu call deadlocks
status: current
updated: 2026-09-26
source: gettori/tori#212 phase presence-in-rust, commit 21533ec4; src-tauri/src/rpc/mod.rs (rpc_attention, Composer::present)
---

# A sync Tauri command must not wait on a lock held across a tray call

Don't hold a lock while building a tray menu or calling another main-thread API from a background thread if a sync `#[tauri::command]` can wait on that same lock. The command runs on the main thread, and the menu call waits for the main thread, so each waits on the other. Release the lock before the OS call, and make the command `async`. Why: Tauri 2 dispatches menu work to the main thread and blocks until it runs.

## Related

- [[adr_no_sync_ipc_commands]]: the rule that keeps blocking work off the IPC thread
- [[component_presence]]: where this bit
