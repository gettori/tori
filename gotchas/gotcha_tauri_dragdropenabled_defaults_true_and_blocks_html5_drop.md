---
summary: tauri's window dragDropEnabled defaults true and its native handler intercepts events before html5 dnd sees them
status: current
updated: 2026-06-29
source: CM6 migration (personal/tori, branch code-mirror-6); `src-tauri/tauri.conf.json`, `src/components/TerminalView.tsx` (`handleDrop`)
---

# Tauri dragDropEnabled defaults true and blocks HTML5 drop

Do NOT leave the window's `dragDropEnabled` at its default when you rely on HTML5 drag-and-drop *inside* the webview (e.g. dragging a file-tree row or editor tab onto the terminal); set `"dragDropEnabled": false` on the window in `tauri.conf.json`. Why: it defaults to `true`, and Tauri's native OS-level drag-drop handler intercepts drag events before the WKWebView's HTML5 DnD sees them, so `onDragStart` fires but `onDrop` never does and the drop silently no-ops. It is a window-creation setting, so a frontend hot-reload won't pick it up, restart `pnpm tauri dev`. Trade-off: with it off, Tauri no longer emits `tauri://drag-drop` for OS-level (Finder) file drops.
