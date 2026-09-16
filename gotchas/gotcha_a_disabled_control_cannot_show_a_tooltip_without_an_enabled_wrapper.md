---
summary: a disabled button fires no pointer events and takes no focus, so a tooltip needs an enabled wrapper around it
status: current
updated: 2026-08-13
source: "plan \"Tooltip primitive and the `title=` sweep\" (personal/sway, branch `102-tooltip-primitive`, issue #102); `src/components/Tooltip/Tooltip.tsx`; commit `c996ca9`"
---

# A disabled control cannot show a tooltip without an enabled wrapper

A `disabled` button fires no pointer events *at all* — not `pointerenter`, not `pointerover` — and takes no focus, so both routes to a tooltip are gone at once. A native `title` still renders on it, which is why swapping one for a tooltip silently loses the hover text on every disabled control. The only way back is an **enabled element wrapping the control**, driving a controlled `open` on its own timer; that state bypasses Kobalte's module-global warm-up, so such a tooltip does not join the skip-delay group. It also changes the DOM shape at the call site, so `Tooltip`'s `whenDisabled` (`tooltipWhenDisabled` on `Button`/`IconButton`/`Tab`) is opt-in per site rather than the default. Opt in where the label explains *why* the control is greyed out; leave it off where the label only says what the control does, since a disabled control is unfocusable anyway and nothing is lost on the keyboard path. jsdom cannot reproduce the behaviour this works around — it dispatches pointer events to disabled elements regardless — so no test in this repo proves the wrapper is necessary; the ones that exist prove only that it is wired.
