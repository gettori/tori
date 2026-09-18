---
summary: Kobalte's ariaHideOutside writes aria-hidden from inside a setTimeout plus rAF, so a sync assertion reads too early
status: current
updated: 2026-08-13
source: "plan \"Tooltip primitive and the `title=` sweep\" (personal/tori, branch `102-tooltip-primitive`, issue #102); `src/components/Tooltip/Tooltip.test.tsx`, `src/components/Dialogs/SpaceDialog.test.tsx`; commits `c996ca9`, `dbfa12a`"
---

# Kobalte writes aria-hidden a timeout and a frame after mount

`ariaHideOutside` (behind `Dialog.Content`'s `createHideOutside`) watches the document with a `MutationObserver` and sets the attribute from inside `setTimeout(() => requestAnimationFrame(...))`, so a node portalled onto the body is hidden **two turns** after it is inserted. Any synchronous assertion about `aria-hidden` therefore reads the tree before the write lands and passes whether or not the code under test is correct — the shape of a test that cannot fail. Await both turns before asserting. When two such assertions sit together ("inside the panel" and "not inside an aria-hidden subtree"), verify each fails on its own with the mechanism removed: the first masks the second.
