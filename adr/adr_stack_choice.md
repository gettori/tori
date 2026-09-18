---
summary: Tauri plus SolidJS plus Monaco and a manual tori toml, chosen for a small binary that still embeds pty and editor
status: stale
updated: 2026-07-14
source: not recorded; imported from grimoire docs/personal/tori
---

# Tori stack: Tauri + SolidJS + Monaco + manual tori.toml

For a fast, single-window dev cockpit on macOS we chose **Tauri 2** (Rust backend, web UI) over Electron and native SwiftUI: it gives a small native binary and low memory while still allowing an embedded terminal and editor, which SwiftUI makes very hard. The frontend is **SolidJS + Vite** for fine-grained reactivity under high-frequency PTY/file streams. The editor is **Monaco** wired by us (no LSP/extensions initially) for speed over fidelity. The tree structure is a **manually declared `tori.toml`** (spaces → projects, one working dir each) while sessions and branches are **auto-discovered** (git branches live; Claude sessions from `~/.claude`), so the user controls structure but never hand-maintains session lists.

## Considered Options

- **IDE pane:** real VS Code via code-server (rejected: heavy, open-vsx marketplace) vs external VS Code window (rejected: not one window) vs **embedded Monaco** (chosen: fastest, smoothest, we accept building the file tree and losing extensions).
- **Shell:** Electron (rejected: heavier, though richest terminal ecosystem) vs native SwiftUI (rejected: terminal + editor embedding too hard) vs **Tauri** (chosen).
- **Tree source:** auto-discover everything (rejected: less predictable) vs **manual config + auto-attached sessions** (chosen).

## Consequences

- No VS Code extensions, debugger, or LSP in the editor until a later phase wires language servers.
- PTY lives in Rust (`portable-pty`), so terminal work is Rust-side, not Node.
- Branches come from live git, so a project shares one working dir; git-worktree-per-branch is a deferred enhancement.

## Related

- [[concept_filesystem_source_of_truth]] — the mechanism this stack serves.
- [[component_pty_host]] — the terminal half of the decision.
- [[component_session_scanner]] — the discovery half.
