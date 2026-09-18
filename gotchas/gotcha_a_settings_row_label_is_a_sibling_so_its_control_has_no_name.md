---
summary: a settings Row label sits beside its control with no for, point the control at rowLabelId or it stays unnamed
status: current
updated: 2026-08-15
source: "plan \"Select wrapper and native select migration\" (personal/tori, branch `106-select`, issue #106); `src/panels/Settings/paneKit.tsx:130` (`rowLabelId`), `src/panels/Settings/paneSelects.test.tsx`; see [[component_select]]"
---

# A settings `Row` label is a sibling, so its control has no name

Do NOT assume a control in `paneKit`'s `Row` inherits the row's visible label. The `<label>` is rendered *beside* the control, not around it, and carries no `for`, so nothing associates them: every picker in Settings was unnamed to a screen reader until #106, and axe files it as a `label` violation. Point the control at `rowLabelId(id)` with `aria-labelledby` (a `Select` renders a button, which cannot take a `for` at all). **Still open for the native controls:** every checkbox, number and text input in a `Row` has the same gap, which is #107's to close, so a pane-wide axe scan fails today for reasons unrelated to whatever you just changed.
