---
summary: the menu idioms guard flags any lone fireEvent.mouseDown with no nearby pointerDown, since dismissal needs pointerdown
status: current
updated: 2026-09-07
source: plan "Chat composer Tier 1" (personal/tori, branch `composer-260907`), phase 3 . `src/test/menuIdioms.test.ts:77` . `src/panels/Chat/QuoteSelection.test.tsx` . commit `c3eb12f` . _2026-09-07_
---

# `menuIdioms.test.ts` flags a lone `fireEvent.mouseDown` in any test file

Do NOT assert a mousedown on its own, even for a control that has nothing to do with a menu. Why: the guard scans every test in `src/` for a `mouseDown` with no `pointerDown` within three lines, because Kobalte's dismissable layer listens for `pointerdown` and every pre-migration dismissal test was written the wrong way. A button that calls `preventDefault` on mousedown to keep a selection alive is a legitimate case: write the pair, which is what a real pointer sends anyway.
