---
summary: src/lib now holds only our layer and keyboard modules, and boundary.test.ts fails if a removed UI package returns
status: current
updated: 2026-11-21
source: "Design system foundation: src/lib boundary, Kobalte install, import guard (personal/tori, branch `94-design-system-foundation`, issue #94, part of #93); `src/lib/dialog.ts`, `src/lib/boundary.test.ts`; commit e90eba3; second module: plan \"Tooltip primitive and the `title=` sweep\" (branch `102-tooltip-primitive`, issue #102); `src/lib/tooltip.ts`; commit c996ca9; toggle group: plan \"SegmentedControl onto Kobalte ToggleGroup, absorb LayoutToggles\" (branch `108-segmented-control`, issue #108); `src/lib/toggle-group.ts`; select: plan \"Select wrapper and native select migration\" (branch `106-select`, issue #106); `src/lib/select.ts`; boolean controls: plan \"Checkbox, Switch and Slider wrappers and control migration\" (branch `107-checkbox-switch-slider`, issue #107); `src/lib/checkbox.ts`, `src/lib/switch.ts`, `src/lib/slider.ts`; commit 121f892; tabs: plan \"Tab and OverflowTabBar onto Kobalte Tabs\" (branch `111-tab-and-overflow-tab-bar`, issue #111); `src/lib/tabs.ts`; combobox: plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); `src/lib/combobox.ts`, `src/lib/combobox.test.tsx`; commit `bd86d48`; radio group: plan \"Answer AskUserQuestion inside the chat panel\" (phase 1, branch `chat-transcription`); `src/lib/radio-group.ts`; commit `6933de0`; rewritten by solid-2-stage-a-own-primitives plan, gettori/tickets#106, commit f2895a16"
---

# `src/lib/`: shared behaviour

This folder used to be the seam around a third party primitives library, one re-export file per primitive. That library is gone, which is what the seam was for: the swap was an edit to `lib/` and the wrappers rather than to the app. Each styled component in `src/components` now owns its behaviour, and `src/lib` holds only what several of them share.

## What it owns

- `layer.ts`: dismissal, focus return, scroll lock, placement and presence. See [[component_layer]].
- `keyboard.ts`: roving focus, item order and typeahead. See [[component_keyboard_helpers]].
- `boundary.test.ts`: fails if `@kobalte/core` or `lucide-solid` is named in any `.ts` or `.tsx` under `src` or `mobile/src`, or appears in `package.json` or the lockfile. It skips only itself.

## What it does not do

- No styling. Visual identity is `src/components/`, on [[concept_design_token_system]].
- No per primitive wrappers. Rejected in [[adr_own_primitives_on_native_layers]]: an own API in `lib/` for each primitive would be a second layer with one consumer each.

## Connections

- [[adr_own_primitives_on_native_layers]] the decision behind the current shape
- [[adr_headless_primitives]] the decision this folder was first built for, now stale
- [[gotcha_the_src_lib_boundary_guard_reads_comments_not_just_imports]] the guard matches raw text
- [[gotcha_import_meta_glob_keys_are_normalized_against_the_importing_file]] how a sibling file is keyed in the guard's glob
- [[component_dialog]] the main consumer
- [[component_menu]] a consumer
- [[component_select]] a consumer
- [[component_boolean_controls]] form controls, which need only native inputs
