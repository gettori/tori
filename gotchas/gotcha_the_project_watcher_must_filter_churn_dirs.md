---
summary: the fs watcher must filter .git, node_modules, dist and target before emitting fs://changed, or builds yank the editor
status: current
updated: 2026-06-29
source: CM6 migration (personal/sway); `src-tauri/src/fs.rs` (`is_ignored`); commit ccd7337
---

# The project watcher must filter churn dirs

Do NOT emit `fs://changed` for paths under `.git`/`node_modules`/`dist`/`target`; filter them before emit. Why: this is an agent-first tool whose terminal constantly runs git/builds/installs, so follow-mode would yank the editor to `.git/index` or build output and the gutter would re-diff on every git write. Filtering is in `fs_watch_start`'s debounce thread; the file tree and quick-open walk filter independently.
