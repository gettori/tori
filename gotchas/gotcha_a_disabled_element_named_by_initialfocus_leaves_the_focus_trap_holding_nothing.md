---
summary: a disabled control named by initialFocus refuses focus, so the trap holds nothing and closing restores focus nowhere
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven complex dialogs onto Dialog\" (personal/tori, branch `100-migrate-seven-conplex-dialogs`, issue #100); `src/components/Dialog/Dialog.tsx:91`, `Dialogs/stackedDialogs.test.tsx:225`; commit `8e56c39`"
---

# A `disabled` element named by `initialFocus` leaves the focus trap holding nothing

Do NOT assume the element a dialog names for initial focus will take it. Why: a `disabled` control refuses focus, so focus stays on whatever was outside the dialog; the trap then holds nothing, and closing a dialog stacked on top of this one restores focus to nowhere. It is not hypothetical or rare: a confirm dialog that names its confirm button and opens already `busy` (a removal in flight) hits it every time. Nothing in the dialog itself looks wrong, and only a *stacked* test surfaced it. [[component_dialog]] now re-checks after applying `initialFocus` and takes the panel if focus did not land inside, so every consumer gets the fallback rather than each gated dialog repeating the bug.
