---
summary: fireEvent.click never triggers the microtask checkpoint, so vitest is blind and only a trusted CDP click catches it
status: current
updated: 2026-08-16
source: "plan \"Revive tab selection, and make an unnamed segment a type error\" (personal/sway, branch `116-optional-accessible`, issue #116); `src/components/OverflowTabBar.tsx`, `src/utils/tabGesture.ts`, `src/components/OverflowTabBar.stories.tsx`; regression from commit `74f3e3d`"
---

# Verifying under trusted input

Some defects exist **only under real user input**, and the whole vitest suite is structurally blind to them. Driving a Storybook story in headless Chrome over CDP is how Sway checks those, and it costs no new test stack: Storybook is already the component workshop ([[adr_headless_primitives]]), and Chrome ships on the machine.

The defect that forced this: every tab strip in the app was unclickable for a whole commit while 279 test files stayed green ([[gotcha_a_capture_phase_flag_cleared_in_a_queuemicrotask_is_gone_before_the_targets_listener_runs]]).

## Why the suite cannot see it

**A scripted dispatch is not a user gesture.** `fireEvent.click(el)` and `el.click()` both run inside a JS call stack that never empties, so the browser's per-listener **microtask checkpoint** never fires mid-dispatch. Any bug whose mechanism is "what expires between two listeners" is invisible to them, and jsdom does not implement the checkpoint at all, so it is invisible twice over. The distinction is `isTrusted`, and it is not decoration.

Three things that follow, each of which the suite reports as fine:

- timing that depends on the checkpoint (the gate above),
- anything reading real geometry, since jsdom measures every box as zero ([[gotcha_jsdom_measures_everything_as_zero_wide_so_overflowtabbar_hides_every_tab_label]]),
- anything reading CSS, since vitest stubs CSS Modules to the empty string.

## The harness

Plain Node, no new dependency:

1. `npx storybook dev -p 6007 --no-open --quiet`, then poll `/index.json` until it answers.
2. Launch `--headless=new` Chrome with `--remote-debugging-port`, pointed at `iframe.html?id=<story-id>&viewMode=story`.
3. Take the page's `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json` and speak CDP over Node's global `WebSocket`.
4. `Runtime.evaluate` to read the DOM, `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` to drive it. **Input from the CDP `Input` domain is trusted**, produced by the browser's own event loop, which is the entire point; anything the page script dispatches is not.
5. Poll for the story to mount before the first assertion. Storybook compiles on demand, so the first load is slow enough to read as "no tabs rendered".

## What makes it evidence rather than a demo

Run it **against the unfixed code too**. The tab gate's before/after was one script and two runs (`git show HEAD:<file> > <file>`, run, restore):

| gesture | before | after |
| --- | --- | --- |
| click the third tab | selection stays on the first | selection moves |
| ArrowLeft | focus moves, selection does not | both move |
| Delete on the focused tab | closes, and the heal opens the leftmost | closes, heal not forwarded |
| press, move 300px, release off-target | no selection | no selection (drag protection intact) |

That table is what the plan's manual "run the app and click a tab" step turned into. A Tauri window is *not* the surface for this: it has no automation port, so a human has to click it and report back, and the report is prose rather than a diff.

## What it does not replace

It is a **check**, not a suite: it runs by hand, in a session, and nothing fails in CI when it regresses. For a defect no functional test can discriminate, pair it with a **source guard** that asserts the shape of the fix rather than its behaviour (`src/test/tabBarGate.test.ts` bans a deferred clear in the tab bar), and mutation-check every new test against the unfixed line ([[lesson_a_test_that_passes_against_the_broken_code]]).

## Connections

- [[concept_axe_accessibility_gate]] - the other harness that exists because the suite was not asking; it is a jsdom floor, and this reaches past it into a real browser.
- [[component_overflow_tab_bar]] - the component that needed it, and whose "what the tests cannot see" list this shortens.
- [[gotcha_jsdoms_pointerdown_carries_no_pointertype_so_a_press_vs_click_test_proves_nothing]] - the same lesson one layer up, where a synthetic event is merely missing a field.
