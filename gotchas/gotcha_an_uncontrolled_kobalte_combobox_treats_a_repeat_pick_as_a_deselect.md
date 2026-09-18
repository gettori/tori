---
summary: an uncontrolled Kobalte combobox toggles selection, so a repeat pick fires onChange null and the row goes dead
status: current
updated: 2026-08-16
source: "plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (personal/tori, branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); `src/components/Combobox/Combobox.tsx:135`; commit `9d471b7`"
---

# An uncontrolled Kobalte combobox treats a repeat pick as a deselect

Do NOT leave `Combobox.Root`'s `value` uncontrolled on a surface that stays open after a pick. Selection is a toggle, so picking the same row twice fires `onChange` with the option and then with `null`. For a picker that commits and closes this never shows; for the Omnibox's `?` mode signposts, which retype the box and leave the palette open, the row goes dead on the second press. Pin `value={null}` and let `onChange` be the event: Kobalte's controllable signal still calls `onChange` on every pick because the incoming value differs from the pinned one. Two things come free with it, `resetInputValue` never rewriting the filter box to the picked label, and no visible row ever carrying `aria-selected`, which is what lets `data-highlighted` mean "active" unambiguously. See [[component_combobox]].
