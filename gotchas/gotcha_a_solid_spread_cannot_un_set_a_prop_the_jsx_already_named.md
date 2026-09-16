---
summary: spreading undefined cannot remove a prop a test helper hard coded above it in JSX, the earlier attribute wins
status: current
updated: 2026-08-15
source: "plan \"Migrate the seven simple dialogs onto Dialog\" (personal/sway, branch `99-migrate-seven-dialogs`, issue #99); `src/components/Dialogs/ConfirmDialog.test.tsx:60`; _2026-08-12_; second instance from \"Menu onto Kobalte DropdownMenu and ContextMenu\" phase 6 (branch `103-menu`, issue #103); `src/components/Menu/Dropdown.tsx`"
---

# A Solid spread cannot un-set a prop the JSX already named

Do NOT expect `{...{ message: undefined }}` to remove a prop a test helper hard-coded above the spread. Why: the earlier explicit attribute keeps winning, so `open({ message: undefined })` renders the helper's default and the test asserts the opposite of what it reads. Give helpers overrides only, and render the component directly for the case that needs a prop absent.

The same rule bites through a library. Kobalte writes `aria-haspopup` and `aria-expanded` on its menu trigger, and spreading `undefined` over them from the call site leaves both in place, so a trigger that is only a wrapper cannot be stripped of the popup semantics; it can only be told to stop being a control ([[concept_menu_trigger_wrapping]]).
