---
summary: Kobalte keys every listbox section "", so an update collapses its headings into one; fixed by our pnpm patch, not upstream
status: stale
updated: 2026-11-21
source: "plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (personal/tori, branch `110-pickermodal-and-chatpicker`, issue #110, PR #140), commit `9d471b7`; replaced by the patch in plan \"Cmd+K navigator\" (branch `cmdk-improvements`), Phase 11, commit `8cc77a78`; `patches/@kobalte__core@0.13.13.patch`; `pnpm-workspace.yaml` patchedDependencies"
---

# Kobalte builds every listbox section with an empty key

> Stale: Kobalte left in gettori/tickets#106, so this describes the old implementation. See [[adr_own_primitives_on_native_layers]].

Do NOT drop the pnpm patch on `@kobalte/core`, and do NOT expect an upgrade to fix this: 0.13.14 and 2.0.0-alpha.4 still ship it. Kobalte's collection builder gives every `type: "section"` node `key: ""`, and the listbox renders through `<Key by="key">`, so on any options update every heading maps onto one node and only the last one draws, with no error. A first render is fine, which is what hides it. `patches/@kobalte__core@0.13.13.patch` keys each section `__kobalte_section_${index}` in the two dist chunks; the keyboard delegate already skips non-item nodes. It replaced the keyed `<Show>` remount Combobox used to wrap the listbox in, and Combobox's "keeps every heading" case is the guard: it fails with the patch reverted. Why: the bug is in the dist build, so only a patch reaches it, and a remount reset the highlight and scroll on every heading change. `pnpm patch-commit` also reorders `overrides` in `pnpm-workspace.yaml`; put that back by hand.

## Related

- [[component_combobox]] the surface the patch serves
- [[gotcha_kobaltes_optiongroupchildren_is_all_or_nothing]] the other grouped-list trap in the same surface
