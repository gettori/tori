---
summary: rebuilding item objects when reordering a solid For list remounts by identity, killing a pty or resetting an editor
status: current
updated: 2026-06-29
source: Overflow-tab-bar (personal/sway); `src/components/tabOverflow.ts` (`moveIntoView`), `src/components/OverflowTabBar.tsx`
---

# Reordering a referentially-keyed For must preserve object identity

Do NOT rebuild the item objects when reordering a list rendered by Solid `<For>` (e.g. the tab arrays behind `.term-stage` `TerminalView`s or the editor buffers); splice the SAME references. Why: `<For>` is keyed by object identity, so reusing references reorders DOM nodes, but a `.map(x => ({...x}))` (new refs) makes `<For>` dispose+remount the rows. Remounting a `TerminalView` runs its `onCleanup` -> `pty_kill`, SIGKILLing and respawning the running `claude` session (lost scrollback), and remounting a `CodeEditor` row resets its buffer/cursor. `moveIntoView` in `tabOverflow.ts` returns a new array of the same elements for exactly this reason.
