---
summary: a real browser synthesizes a click on the focused button on Enter but jsdom does not, the assertion needs an ancestor
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven simple dialogs onto Dialog\" (personal/sway, branch `99-migrate-seven-dialogs`, issue #99); `src/components/Dialogs/ConfirmDialog.tsx:44`, `ConfirmDialog.test.tsx:118`"
---

# jsdom does not click a focused button on Enter

Do NOT assert Enter-to-confirm by firing `keyDown` at the focused default button. Why: a real browser synthesizes a click there and jsdom does not, so the assertion passes only while some ancestor still carries a keydown handler and fails the moment that handler is deleted - which is exactly what a migration onto [[component_dialog]] does, since the actions row sits outside the body. Assert the two halves separately: the focus is the component's, the click is the browser's.
