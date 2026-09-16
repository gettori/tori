---
summary: a second lsp_start for a root with a live server reuses its handle but never wires the caller's channel to a transport
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/sway, branch `wave-4`); Phase 2; `src/panels/Editor/lspClient.ts`, `src-tauri/src/lsp.rs`; commit 0802a17"
---

# `lsp_start` reuses a running session and returns without wiring the new Channel

Do NOT assume a second `lsp_start` for a root that already has a server hands you a live transport. The backend reuses the session and returns its handle, but the new caller's `Channel` is never attached, so a client built from that call sits connected to a transport no frame ever reaches — no error, just a language server that answers nothing. Serialize starts per server id so the second call sees the first's session and skips building a client at all, and treat the returned handle as "this is who answers", not "this is yours".
