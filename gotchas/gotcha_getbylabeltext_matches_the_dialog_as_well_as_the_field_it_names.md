---
summary: getByLabelText throws multiple matches since Dialog labels the whole panel by its heading too, narrow with getByRole
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven simple dialogs onto Dialog\" (personal/sway, branch `99-migrate-seven-dialogs`, issue #99); `src/panels/Editor/editorCommands.test.tsx:114`"
---

# `getByLabelText` matches the dialog as well as the field it names

Do NOT reach for `getByLabelText(title)` as the fix when a dialog field's query breaks. Why: [[component_dialog]] labels the panel by its own heading, so a field whose accessible name repeats that heading gives the query two matches and it throws "found multiple elements" - a failure that reads as a broken component rather than an ambiguous query. Narrow it with a role: `getByRole("textbox", { name: title })`.
