---
summary: CodeMirror prevents default but never stops propagation, a window hotkey must check defaultPrevented or double fire
status: current
updated: 2026-08-01
source: "Editor wave-1 opener: multi-cursor, editing polish, language packs (branch `editor-improvements`); `src/utils/hotkeys.ts:275`; PR #80"
---

# An app-global hotkey must yield to a defaultPrevented key

Don't fire a window-level hotkey without checking `e.defaultPrevented`: CodeMirror preventDefaults every binding it runs but never stops propagation, so a handled Cmd+/ still bubbled to the window listener and double-fired (the comment toggled AND the shortcut sheet opened, the very symptom that made ticket #8 claim Mod-/ was never bound). Why: `fire()` matched on scope and keys alone; the guard now lives at its top.
