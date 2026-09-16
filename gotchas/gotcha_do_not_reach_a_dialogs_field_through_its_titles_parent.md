---
summary: querying a dialog field through its title's parent only works while the dialog is a flat box, Dialog nests head body
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven simple dialogs onto Dialog\" (personal/sway, branch `99-migrate-seven-dialogs`, issue #99); `src/panels/Editor/editorCommands.test.tsx:110`, `src/panels/Editor/scratchTabs.test.tsx:145`, `src/panels/LeftSidebar/LeftSidebar.test.tsx:157`"
---

# Do not reach a dialog's field through its title's parent

Do NOT write `getByText(title).parentElement.querySelector("input")` to find a control in a dialog. Why: it only works while the dialog is a flat box holding title, field and buttons as siblings, and [[component_dialog]] nests them under `.head` / `.body` / `.actions`, so the title's parent becomes the heading row and every helper shaped this way breaks in the same commit. Ask by role and accessible name instead. See [[lesson_characterize_the_contract_not_the_shape]].
