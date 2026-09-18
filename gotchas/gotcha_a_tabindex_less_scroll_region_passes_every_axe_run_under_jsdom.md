---
summary: a tabindex less overflow auto region passes every axe run under jsdom, since scrollable region focusable is disabled
status: current
updated: 2026-08-12
source: "plan \"Dialog primitive on Kobalte with stories and behavior tests\" (personal/tori, branch `98-dialog-primitive`, issue #98); `src/test/axe.ts`, `src/components/Dialog/Dialog.tsx:113`, `Dialog.test.tsx:118`"
---

# A `tabindex`-less scroll region passes every axe run under jsdom

Do NOT read a green axe run as evidence that a scrollable container is reachable. Why: `scrollable-region-focusable` is one of the three rules [[concept_axe_accessibility_gate]] disables, because jsdom has no scroll geometry for it to match on, so an `overflow-y: auto` element with no focusable content and no `tabindex` cannot fail any assertion in the suite while being unscrollable by keyboard. It bites hardest inside a modal, where the page behind is scroll-locked and there is nothing else to scroll. The disabled set is not merely absent coverage: it is a shape of defect the gate can never report, so those cases need a hand-written test. Same family as [[lesson_a_rule_that_matches_nothing_passes_every_guard]]. See [[component_dialog]].
