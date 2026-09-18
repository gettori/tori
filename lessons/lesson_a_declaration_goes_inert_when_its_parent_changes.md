---
summary: a flex scroller rule went dead the day its parent stopped being a flex container, and a presence guard never noticed
status: current
updated: 2026-08-16
source: "plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (personal/tori, branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); Phases 3 and 4; `src/components/Omnibox/Omnibox.module.css`, `src/components/Dialog/Dialog.module.css`, `scripts/check-tokens.mjs` check 8; commit `9d471b7`"
---

# A declaration can go inert without changing, when its parent does

## What happened

The command palette's result list was the scroller, and that was load-bearing: the panel is fixed and centred, so an unbounded list puts the rows past the fold out of reach. It had already been lost once (commit `be21ced` deleted the shared rule that was its only height bound), which is why `check-tokens.mjs` grew check 8, asserting that `.list` declares `overflow-y` and `.panel` declares its height bound.

Phase 3 moved the palette's shell onto [[component_dialog]]. The `.list` rule was not touched:

```css
.list {
  flex: 1 1 auto;
  overflow-y: auto;
}
```

`flex: 1 1 auto` only means anything inside a flex container. The palette used to be one. `Dialog`'s `.body` is a block, so from that commit on the flex line did nothing, the list had no height constraint to overflow, and `overflow-y: auto` never produced a scrollbar. The scroller silently moved to `Dialog`'s `.body`, which does bound and does scroll, so nothing looked broken. Check 8 stayed green through all of it, because the declarations it names were still present, character for character.

Phase 4 deleted `.list` entirely when the list became the shared `<Combobox>`'s, which is the only reason any of this was noticed: the guard finally failed, for the wrong reason.

## The lesson

A guard that asks whether a declaration is **present** cannot tell you whether it still **means** anything. Presence is a property of the file; meaning is a property of the file plus its context, and a migration is exactly the event that changes the context while leaving the file alone.

So: when a component moves inside a different parent, re-derive every layout declaration that depends on the parent's formatting context (`flex`, `grid`, percentage heights, `position: sticky`, `min-height: 0`), not just the ones the diff touched. The diff will not show them, because they did not change. That is the point.

And when the guard's subject moves, move the guard. Check 8 now asserts that `Dialog`'s `.body` declares `overflow-y`, because that is where the scroller actually is, and that `Dialog` still reads the `--dialog-max-height` hook the palette sets. Both halves were mutation-tested by breaking them one at a time, which is the only way to know a guard still fails.

## Related

- [[lesson_a_rule_that_matches_nothing_passes_every_guard]], the same failure one step earlier: there the selector never matched, here it matched and stopped mattering
- [[lesson_a_guard_keyed_on_what_changed_is_inert]], a guard that cannot fire by construction
- [[gotcha_a_css_module_redeclaring_a_property_another_module_sets_on_the_same_element_is_settled_by_bundle_order]], the other thing this same migration got wrong on the same two files
- [[gotcha_vitest_stubs_css_imports_to_the_empty_string]], why this class of check lives in a Node script and not in vitest at all
- [[component_command_palette]], [[component_dialog]], [[component_combobox]]
