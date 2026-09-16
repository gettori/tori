---
summary: moving preference state to module level turns old localStorage seeding into a no-op, hiding test order dependence
status: current
updated: 2026-09-05
source: "Settings redesign: horizontal tab strip with per-tab search counts (personal/sway, branch `settings`, issue #91); Phase 4; `src/utils/blamePref.ts`, `src/panels/Editor/blameToggle.test.tsx`"
---

# Moving state from per-instance to shared makes its tests order-dependent

## What happened

`blamePref.ts` and `sideBySide.ts` were read/write pairs over a localStorage key,
and every consumer seeded its own `createSignal(readPref())` at mount. The key
was therefore shared *across sessions* but not *within* one: two diff surfaces
open at once already disagreed the moment either was toggled. Adding a Settings
row for each would have put that on screen, so both became one module-level
signal, read from localStorage once at import.

The whole suite stayed green, including `blameToggle.test.tsx`, whose middle test
is named *"comes back on for the next session once it has been asked for"*:

```ts
beforeEach(() => { localStorage.clear(); … });

it("comes back on for the next session once it has been asked for", async () => {
  localStorage.setItem(BLAME_KEY, "1");   // ← no longer reaches the app
  await mountWithFile();
  expect(last()).toBe(true);              // ← passes on the previous test's signal
});
```

Writing the key stopped reaching the app the moment the signal became the source
of truth. The assertion carried on passing because the *previous* test had ended
by clicking blame on, leaving the module signal at `true`. The test was asserting
nothing, and `localStorage.clear()` in `beforeEach` gave every appearance that it
was starting clean.

## Why

Per-instance state is re-created per test by construction: mounting the component
*is* the reset. Module-level state is not, and `beforeEach` hooks written against
the old shape keep clearing the thing that used to be the source of truth while
the new one carries over. The failure is silent in both directions - the seeding
step becomes a no-op, and leftover state supplies the expected value anyway - and
it turns a suite that reads as independent into one that passes because of the
order it happens to run in.

This is the same family as
[[lesson_a_test_can_pass_because_its_fixture_stopped_parsing]] (a test asserting
a *value* has two ways to be green, and a refactor can move it from one to the
other) and [[lesson_a_test_that_passes_against_the_broken_code]]. What is
particular here is the trigger: **a green suite after a state-ownership change is
not evidence the tests still test what they say.** They may only be evidence that
the state survived them.

## What to do

- When state moves from per-instance to module-level, **grep the tests for the
  old seeding mechanism** (a localStorage write, a constructor argument, a prop)
  and check each still reaches the code under test.
- Give the module an explicit re-seed for tests (`reloadBlamePref()`) and name the
  helper after what it stands in for, not after what it calls:
  `previousSessionLeftBlame(true)` says why the line exists where
  `localStorage.setItem(KEY, "1")` had stopped saying anything.
- Confirm the fix by checking the test now *fails* without the re-seed. Adding a
  line to a passing test proves nothing on its own.

Applies to [[component_settings_store]] and to any of the localStorage-backed
reader preferences (zoom in `settingsStore.ts`, blame, side-by-side), all of
which are now module-level signals for the same reason.

## A second sighting (2026-09-05)

The multi-account work hit the same shape from the other side: `agentHealth` and `modelCatalog` are module-level stores behind a **once-per-run latch** (`requested`, `reading`), so whichever accounts the *first* test in a file mounted with answered for every test after it, and a `beforeEach` that reset the invoke mock changed nothing because the store never re-read. The fix in both files was to re-seed the store per test (`refreshAgentHealth()`, `__resetModelCatalogsForTests()`) rather than to trust the mock reset.

**Source:** plan "Multi-account: pick, lock and default an account per session" (personal/sway, branch `multiaccount`), phases 3 and 4 · `src/panels/Terminal/newTabControl.test.tsx`, `src/panels/Settings/panes/AgentsPane/agentAccounts.test.tsx`
