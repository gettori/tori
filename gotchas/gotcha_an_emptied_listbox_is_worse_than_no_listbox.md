---
summary: role listbox on a container whose only child is a no-matches fallback trips aria-required-children, drop the role too
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven complex dialogs onto Dialog\" (personal/tori, branch `100-migrate-seven-conplex-dialogs`, issue #100); `src/components/Dialogs/PickerModal.tsx:160`, `PickerModal.test.tsx`; commit `97a1eb6`"
---

# An emptied `listbox` is worse than no listbox

Do NOT leave `role="listbox"` on a container while its only child is a "No matches" fallback. Why: the role promises owned `option` children, so an empty one trips `aria-required-children` (critical) and, having no options to be named by, `aria-input-field-name` too - two violations where the un-roled markup had none. The `aria-activedescendant` pointing into it is the same trap one level up: it names an id that is no longer on the page. Withdraw the role and the activedescendant together with the rows, and keep the *container* rendered unconditionally so the input's `aria-controls` still resolves.
