---
summary: a sync tauri command doing blocking io freezes the window, only async commands dispatch off the main thread
status: current
updated: 2026-07-19
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/tori, branch `topbar`); Phases 2 and 5; `src-tauri/src/model.rs:65`, `src-tauri/src/update.rs:138`"
---

# A Tauri command without `async` runs on the main thread

Do NOT put blocking I/O (a network request, a slow file read) in a `#[tauri::command]` that is not `async fn`. Why: async commands are dispatched via `async_runtime::spawn`, but a **sync** command runs on the **main thread**, so anything blocking in it freezes the window. Verified against the Tauri v2 docs rather than assumed, and it has bitten in both directions: `check_for_update`/`agent_health`/`onboarding_should_show` are all `async fn` deliberately, while `model_context_caps` shipped sync and stalled the UI at toolbar mount on a cold cache. Note that `async` alone is only half the fix, since the request itself is still blocking: it moves an unbounded block off the main thread onto a runtime worker. Pair it with an explicit timeout (both `ureq` call sites now set 10s). A command that only calls something returning immediately (`open_releases_page`, which just `spawn()`s) can stay sync.
