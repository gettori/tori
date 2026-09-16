---
summary: two CSS modules declaring the same property on one element resolve by bundler emit order, use a custom property
status: current
updated: 2026-08-16
source: "plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (personal/sway, branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); Phase 3 self-review; `src/components/Dialog/Dialog.module.css:37`, `src/components/Omnibox/Omnibox.module.css`, `scripts/check-tokens.mjs` check 8; commit `9d471b7`"
---

# A CSS module redeclaring a property another module sets on the same element is settled by bundle order

Do NOT give a caller's class the same property the wrapper's class already declares on that element. Both are a single class, so specificity does not separate them and the winner is whichever CSS module the bundler happened to emit second, which is stated and controlled by neither file. The command palette's `max-height` and `Dialog`'s `.panel` did exactly this and resolved correctly by luck (verified in the built CSS: palette at byte 148689, dialog at 10625). Worse, `check-tokens.mjs` check 8 exists to stop the palette losing its height bound and would have stayed green if that order ever flipped, because it only grepped for the declaration. Use a custom property instead: `Dialog` reads `max-height: var(--dialog-max-height, <default>)` and the caller sets the hook, which resolves on the element and makes bundle order irrelevant. Same family as [[gotcha_same_specificity_hover_and_active_declare_active_last]], one file further out, and see [[gotcha_an_unlayered_css_module_beats_a_layered_one_at_any_specificity]] for when the layers rather than the order decide it.
