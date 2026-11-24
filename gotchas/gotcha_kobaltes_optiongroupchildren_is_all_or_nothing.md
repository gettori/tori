---
summary: Kobalte's optionGroupChildren is read off every entry, one bare option in a grouped list throws and drops the combobox
status: stale
updated: 2026-11-21
source: "plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (personal/tori, branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); `src/components/Combobox/Combobox.tsx`, `src/components/Omnibox/Omnibox.tsx`; commit `bd86d48`"
---

# Kobalte's `optionGroupChildren` is all-or-nothing

> Stale: Kobalte left in gettori/tickets#106, so this describes the old implementation. See [[adr_own_primitives_on_native_layers]].

Do NOT hand a Kobalte combobox a list that mixes headed groups with bare options. `optionGroupChildren` is read off **every** top-level entry, so a single bare option in a list that declares the key throws `Cannot read properties of undefined (reading 'filter')` and takes the whole surface down. This is the good version of the failure (a throw, not a mis-render), and it is the enforcement behind the wrapper's "flat or grouped, never mixed" contract: a caller with a headed block and a bare tail has to name the tail too. The wrapper declares the key only when at least one entry is a group, so a flat list is unaffected. See [[component_combobox]].
