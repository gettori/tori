---
summary: axe treats a placeholder as an accessible name, so a field's only name vanishes the moment the user types
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven complex dialogs onto Dialog\" (personal/tori, branch `100-migrate-seven-conplex-dialogs`, issue #100); `src/components/Dialogs/SpaceDialog.tsx:14`, `PickerModal.tsx:143`; PR #125"
---

# axe accepts a `placeholder` as an accessible name

Do NOT read a green `label` rule as "this field is named". Why: axe falls back to `placeholder` when there is no `<label>`, `aria-label` or `aria-labelledby`, so a field whose only name vanishes the moment the user types anything passes the gate silently. Four fields in the dialog cluster looked named and were not; two of them were only ever green because a *test* supplied a placeholder no caller passes ([[lesson_a_gate_only_sees_the_configuration_the_test_builds]]). The rule fires the instant the placeholder goes, which is why the same field can be clean in one mode of a dialog and critical in another. Name fields from the visible label line with `aria-labelledby` and let the placeholder go back to being a hint.
