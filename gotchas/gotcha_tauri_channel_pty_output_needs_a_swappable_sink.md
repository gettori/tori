---
summary: an idempotent pty_spawn that early returns drops a fresh per invocation Channel, a remounted terminal renders blank
status: current
updated: 2026-06-29
source: CM6 migration (personal/sway); `src-tauri/src/pty.rs`; commit 7dad6fa
---

# Tauri Channel PTY output needs a swappable sink

Do NOT keep the early-return-only idempotent `pty_spawn` when moving output to a `tauri::ipc::Channel`; the reader thread must read the channel from a swappable slot. Why: under the old global-event model a remount's new listener still got output, but a per-invocation Channel passed to a `pty_spawn` that early-returns is dropped, so a re-subscribe renders a blank terminal. The session holds `Arc<Mutex<Option<Channel>>>` and re-`pty_spawn` rewires it.
