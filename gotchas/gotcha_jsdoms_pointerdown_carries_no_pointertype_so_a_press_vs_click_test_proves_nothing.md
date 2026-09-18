---
summary: jsdom builds pointerdown with pointerType empty, a mouse type branch always falls to click, a press test proves nothing
status: current
updated: 2026-08-16
source: "plan \"Tab and OverflowTabBar onto Kobalte Tabs\" (personal/tori, branch `111-tab-and-overflow-tab-bar`, issue #111); `src/components/OverflowTabBar.test.tsx`, `node_modules/@kobalte/core/dist/chunk/3D6FM2PJ.js`"
---

# jsdom's `pointerdown` carries no `pointerType`, so a press-vs-click test proves nothing

Do NOT write `fireEvent.pointerDown(el)` and conclude the control does not activate on press. jsdom builds the event with `pointerType: ""`, and code that branches on `e.pointerType === "mouse"` takes the other path, so the assertion passes against a control that selects on press in every real browser. Kobalte's tab trigger is exactly that shape: `createSelectableItem`'s `onPointerDown` selects only for a mouse, and falls through to `onClick` otherwise, which is the branch jsdom always takes. A characterization test written to pin "activates on the click, not on the press" therefore survived two phases of migration while asserting nothing at all. Pass the field the code reads - `fireEvent.pointerDown(el, { pointerType: "mouse", button: 0 })` - and the test fails honestly. Generally: a synthetic event is only as good as the fields the code under test branches on, and the ones you leave out are the ones that make it green. See [[component_overflow_tab_bar]] and [[lesson_a_test_that_passes_against_the_broken_code]].
