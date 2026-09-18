---
summary: in a creatable filter picker Enter must accept the highlighted match, not create the typed text while rows still match
status: current
updated: 2026-08-12
source: "Add Branch/Worktree unify (personal/tori, branch code-mirror-6); now `src/components/Dialogs/PickerModal.tsx` (`commitEnter`, `commitTyped`, `creatable`), moved in #100; _2026-07-11, path refreshed 2026-08-12_"
---

# A creatable filter-picker must not create on Enter while rows still match

A single dialog that both filters an existing list and creates a new item on no-match (the *Add Branch* / *Add Worktree* combobox) is a footgun if **Enter** commits the raw typed text whenever it isn't an exact match. Why: fuzzy-filtering to reach an item means typing a **prefix/subsequence** of it, so pressing Enter after typing `mai` to reach `main` would create a branch/worktree literally named `mai` (a real, easy accidental-creation, and for a worktree it also spawns a folder). Split the two intents: **Enter accepts the highlighted suggestion** whenever the filtered result set is non-empty (creating the typed name only when nothing matches at all), while an explicit **Ok button** commits exactly what's typed (create-new). Row click still selects directly. So keyboard nav never creates while a candidate is visible; deliberate creation is the button (or an empty result set). See `PickerModal.commitEnter` vs `commitTyped` and [[component_picker_modal]].
