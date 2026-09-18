---
summary: a codemirror vim keymap's DOM handler stops propagation on claimed keys, so it can kill window level hotkeys
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phase 8; `src/panels/Editor/vimMode.ts`, `vimMode.test.tsx`; commit 14b389b"
---

# A keymap extension that stopPropagations kills window-scope hotkeys

Do NOT reason about a third-party keymap package only in terms of CodeMirror's own keymaps. `@replit/codemirror-vim` intercepts keys through a ViewPlugin **DOM** handler and calls `e.stopPropagation()` as well as `preventDefault()` on anything it claims (`dist/index.cjs:1480-1527`), so a key it takes is dead in every other CM keymap *and* in Tori's `window`-level hotkey dispatcher — where the four LSP commands live. What saves Tori's bindings is incidental, not designed: `vimKeyFromEvent` turns Cmd into `M-` and vim binds nothing with it. Assert it with real keydown events rather than trusting it, and include the negative (a plain key really is stopped), or the test would pass just as well with the package uninstalled. Extension order decides a key both claim — whichever is earlier in the array takes it, since both are `ViewPlugin` `domEventHandlers`.
