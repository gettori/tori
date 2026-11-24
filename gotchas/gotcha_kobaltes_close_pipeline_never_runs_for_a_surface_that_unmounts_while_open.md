---
summary: onCloseAutoFocus never runs for a wrapper whose contract is mounted is open, the caller unmounts instead of toggling
status: stale
updated: 2026-11-21
source: "plan \"Popover onto Kobalte Popover\" (personal/tori, branch `104-popover`, issue #104); `src/components/Popover/Popover.tsx`; see [[component_popover]]"
---

# Kobalte's close pipeline never runs for a surface that unmounts while open

> Stale: Kobalte left in gettori/tickets#106, so this describes the old implementation. See [[adr_own_primitives_on_native_layers]].

Do NOT hang anything on `onCloseAutoFocus` (or any close-transition hook) in a wrapper whose contract is mounted-is-open: the caller pins `open` true, dismissal arrives as `onOpenChange(false)`, the caller unmounts the whole tree, and Kobalte never sees an open-to-closed transition, so the close pipeline is dead code. Restore focus by capturing `document.activeElement` in `onMount` and focusing it back from `onCleanup`. `Dropdown`'s anchor mode uses `onCloseAutoFocus` and that is correct there, because its Root stays mounted while `open` toggles.
