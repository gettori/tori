---
summary: axe's aria-valid-attr-value flags every trigger with both aria-haspopup and aria-controls even in a real browser
status: current
updated: 2026-08-15
source: "Menu onto Kobalte DropdownMenu and ContextMenu, phase 2 (personal/sway, branch `103-menu`); `src/components/Menu/Dropdown.test.tsx`; [[component_menu]]; _2026-08-15_; confirmed again for the select trigger, which carries both attributes once open; Select wrapper and native select migration (branch `106-select`, issue #106); `src/components/Select/Select.test.tsx`; [[component_select]]"
---

# axe cannot judge a dropdown trigger, in any browser

Do NOT add `aria-valid-attr-value` to the disabled list in `src/test/axe.ts` when a dropdown trips it. The rule returns a review item keyed `controlsWithinPopup` for any element carrying both `aria-haspopup` and `aria-controls`, because axe cannot tell whether the popup is currently open. That is not a jsdom blind spot, which is what that list is for: it happens in a real browser too, and every trigger Kobalte renders has both attributes. Turn it off for the one scan, with the reason inline, so the rule keeps running everywhere else.
