---
summary: kobalte fires no close event when a menu trigger unmounts, an open count never comes down, track the row's own id
status: current
updated: 2026-08-15
source: Menu onto Kobalte DropdownMenu and ContextMenu, phases 3 to 5 (personal/tori, branch `103-menu`); `src/panels/Terminal/HistoryPanel.tsx`, `src/panels/Editor/Editor.tsx`; [[component_menu]]; commits `7c610cb`, `a0913d9`
---

# Kobalte reports no close for a trigger that unmounts

Do NOT derive state from "a menu is open" with a counter, or with anything cleared by `onOpenChange(false)` alone. Kobalte fires no close event when the trigger goes away, and a trigger per row means rows go away constantly: HistoryPanel refilters its list, the editor closes a tab, a breadcrumb trail loses a crumb as the caret moves. The count never comes back down, and whatever it gated (a popover held open, a document-level arrow handler stood down) stays stuck. Track the open row's **id** and clear it from that row's own `onCleanup`, which `For` gives each item. Then a row that vanishes takes its entry with it whether or not Kobalte says anything.
