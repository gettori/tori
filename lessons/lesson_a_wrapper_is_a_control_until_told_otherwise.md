---
summary: a comment claimed a menu wrapper was not focusable and passed two phases of review, until an axe scan found it was
status: current
updated: 2026-08-15
source: Menu onto Kobalte DropdownMenu and ContextMenu, phase 6 self-review (personal/sway, branch `103-menu`, skarif2/sway#103); `src/components/Menu/Dropdown.tsx`, `src/components/OverflowTabBar.test.tsx`; commit `3e0ddc4`
---

# A wrapper is a control until you tell it not to be

Three menu call sites carried this comment, written in phase 4 and copied twice:

> Kobalte writes these on the trigger, which is the wrapper, and a wrapper is neither focusable nor what a screen reader lands on.

The first half was true. The second half was never true. Kobalte makes any non-`button` trigger a `role="button"` with `tabindex="0"`, so each of those wrappers was a focusable control around a focusable control: two tab stops, and a button inside a button. It shipped for two phases, through a self-review pass that read the comment and agreed with it.

What found it was the first axe scan run over an *open* menu at one of those sites, in phase 6, which reported `nested-interactive` immediately.

## Why the comment survived review

Because it was doing an assertion's job. It named a real property (`aria-haspopup` on a non-focusable element is useless), drew the right conclusion (so the inner control must write it too), and shipped the right fix for the wrong reason. Everything downstream of it was correct, so nothing failed. A comment that is 90% right and load-bearing is harder to catch than one that is wrong.

## What to do instead

**Scan the surface in the state the claim is about.** The suite had axe scans over `Dropdown` and `ContextMenu` in isolation from phase 2, and both passed: neither has a wrapper, because a wrapper is a *call site's* shape. The claim was about a composition no component test covered. One scan at one real wrapped site was enough, and it is now the thing that keeps the property true.

**Suspect a claim about what an element is not.** "Not focusable", "not reachable", "never announced" are all assertions about the accessibility tree, and the accessibility tree is exactly what a scan can read and a reader cannot.

The same scan, pointed at a real surface for the first time, also surfaced two older defects in that bar (tabs with no `tablist` above them, and an `aria-hidden` measuring row full of focusable buttons). Neither is menu-shaped and neither was this ticket's to fix, but the pattern holds: the component tests were green because they never rendered the composition.

## Connections

- [[concept_menu_trigger_wrapping]] holds the rule and the `wrapper` prop this produced.
- [[concept_axe_accessibility_gate]] is the harness; the scan cost one call and a rule exemption.
- [[lesson_a_test_that_passes_against_the_broken_code]] is the same failure one layer down: coverage that cannot fail.
- [[component_overflow_tab_bar]] is where the scan landed, and where the two unrelated findings live.
