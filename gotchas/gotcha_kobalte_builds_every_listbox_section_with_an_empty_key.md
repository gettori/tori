---
summary: Kobalte gives every listbox section key empty string, so a second heading added on update collides with the first
status: current
updated: 2026-08-16
source: "plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (personal/sway, branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); `src/components/Combobox/Combobox.tsx:99,190`; commit `9d471b7`"
---

# Kobalte builds every listbox section with an empty key

Do NOT assume a grouped Kobalte listbox survives gaining a second heading. The collection builder gives every `type: "section"` node `key: ""`, and the listbox renders the collection through `<Key each={[...collection()]} by="key">`, so two headings are two entries claiming one key. A first render is fine, which is what makes this hide: a statically-grouped list has always shown both headings. An **update** is not. Going from one heading to two comes back with one, sitting in the other one's place, and no error is raised. The Omnibox hits it the instant `list_project_files` answers and the project block appears under the recent blocks. Fix it in the wrapper rather than per consumer: derive a signature from the group labels and wrap the listbox in `<Show when={signature()} keyed>` so it is rebuilt instead of reconciled, which costs nothing for a flat list because the signature is then constant. See [[component_combobox]].
