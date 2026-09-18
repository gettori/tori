---
summary: a hidden ghost row rendered for measurement can quietly answer every query a test aims at the real visible row instead
status: current
updated: 2026-08-15
source: Menu onto Kobalte DropdownMenu and ContextMenu, phase 4 (personal/tori, branch `103-menu`, gettori/tori#103); `src/panels/Editor/__fixtures__/editorHarness.ts`, `src/test/tabs.ts`, `src/panels/Editor/syntheticTab.test.tsx`; commit `a0913d9`
---

# The measuring ghost answered the test

`OverflowTabBar` renders every tab twice: an inert `aria-hidden` ghost row it measures from, and the visible row. Under jsdom the visible row was empty, so every tab assertion in the Editor suites had been reaching the ghost since they were written. `src/test/tabs.ts` wrapped that up as `tab()` and documented it, so it was known and considered harmless.

It stopped being harmless in phase 4, when the ghost became menu-free (one menu trigger per tab, and the ghost is a copy). A right-click test then asked a copy that deliberately has nothing to answer with. Worse, one of the two tests being re-pointed, "a view leaves the right-click alone", had been passing *against a ghost with no menu at all*: it would have passed with the entire `disabled` mapping deleted. The failing-first check found a test that proved nothing, not a test pointed at the wrong node.

## The recorded cause was wrong

The vault and `tabs.ts` both said jsdom gives the bar no geometry, so the visible row keeps almost nothing. True, but not the cause. The bar seeds its visible count from `props.items.length` at mount, when the list is still empty, and corrects it in an `onMount` `requestAnimationFrame`. jsdom never runs that frame. So the count stayed at its seeded value, every tab overflowed, and the visible row was empty *before* any width was measured.

The fix is one line in the editor harness, `installAnimationFrame()`, which runs the callback synchronously. Widths are still zero, and one real tab now shows up. No layout is faked.

## What to take from it

**A second copy of a row is a second answer to every query.** The moment two copies stop being identical, every assertion that was reaching the wrong one becomes a lie in whichever direction is convenient. A test that reaches a measurement artefact is worth flagging even while it is passing.

**A cause that explains the symptom is not therefore the cause.** "jsdom has no geometry" predicted the observed behaviour perfectly and pointed at nothing fixable, which is why it sat there for a ticket and a half. The real cause was one unflushed frame, and it took writing a throwaway test that dumped the strip's HTML to see it.

## Connections

- [[gotcha_jsdom_measures_everything_as_zero_wide_so_overflowtabbar_hides_every_tab_label]] carries the corrected cause and the helpers.
- [[component_overflow_tab_bar]] is the bar itself and the ghost row's reason for existing.
- [[lesson_a_test_that_passes_against_the_broken_code]] is the same family: coverage that cannot fail.
- [[concept_synthetic_editor_tabs]] is the surface whose menu the vacuous test was supposed to be pinning.
