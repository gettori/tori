---
summary: a registered Tauri command with passing tests but no UI caller is not shipped, grep the frontend for its name
status: current
updated: 2026-08-02
source: Chat surface plan, phases 6, 11, 12 (branch `chat`); `src-tauri/src/lib.rs` invoke handler; `src/panels/LeftSidebar/LeftSidebar.test.tsx`; commit "Show fan-out attempts as one group, and promote from the tree"
---

# A registered command with no caller is not shipped

## What happened

The same defect landed three times in one ticket. Phase 6 built `deny` and `ask`
rules with `chat_add_restriction` registered, tested and unreachable: no UI wrote
one. Phase 12 built the entire fan-out backend, 11 tests green, with
`create_attempt`, `promote_attempt` and `list_project_attempts` all registered
and **none of them called by anything**, which is why that phase had to stay
`pending` through a whole session. In both cases the phase's own tests passed,
because they tested the command.

## Why

A Tauri command in the invoke handler looks shipped from every angle a backend
test can see. The tests call the function directly, the compiler is satisfied,
and the registration list grows. Nothing in the toolchain notices that the arrow
from the UI to the command was never drawn, and a task's `verify:` phrased as "a
worktree removed outside Sway leaves no stale entry" is satisfied by a unit test
that never renders anything.

The tell is in the verify's own wording. Phase 12's task said "three attempts
**render** as one group", and the backend test that was accepted for it asserted
that three attempts *read back* as one group. The verb had been quietly
downgraded.

## What to do next time

- **Read the verify's verb literally.** If it says render, click, or appear, the
  test has to drive the surface. A backend round-trip is a different claim.
- **Grep the frontend for each new command name before calling a phase done.** An
  invoke handler entry with zero hits outside `lib.rs` is the whole finding.
- **A component test with a mocked bridge is enough and is not expensive.**
  Mocking `@tauri-apps/api/core`, `/event`, `/window` and the two plugins let a
  2685-line sidebar mount in jsdom and assert the group renders, the action fires
  `create_attempt` three times with one `groupId`, and the confirm is declinable.
  It also found two latent bugs no reading had.

## It applied again, on the frontend (2026-08-02)

Editor wave 1 phase 3 (branch `wave-1-4`, issue #15) added eight events wiring
the command registry to its handlers. Self-review caught the same shape with no
Tauri command in sight: every event had an emitter and a consumer (grepped, all
eight), `commands.test.ts` and `CommandPalette.test.tsx` were green, and *nothing
drove the seven handlers in `Editor.tsx`*. The verify's verb was the tell again -
"running each from the palette **opens a prompt**" had been satisfied by testing
only that the palette closes before it emits.

`editorCommands.test.tsx` now mounts the pane with the bridge mocked and fires
the events the palette fires. It found a real bug on its first run: `Editor`
registers `OPEN_IN_EDITOR` after two awaits in `onMount`, so an event aimed at a
still-mounting pane lands on nothing
([[gotcha_a_listener_registered_after_an_await_in_onmount_misses_what_fires_in_that_window]]).
The lesson's own claim - that this kind of test is cheap and finds latent bugs -
held for a fourth time.

## It applied again, one table over (2026-08-05)

Editor wave 6 phase 13 (branch `wave-6`, issue #53) shipped the TODO/FIXME
explorer with no way to reach it. `RIGHT_MODE_TABS` gained a `todos` entry and
`modeOrder` did not, and `rightTabs()` is `modeOrder().filter(...)`, so the tab
never rendered; the mode was also missing from `SetRightMode` and from
`commands.ts`'s `RIGHT_MODES`. Phase 14 found it while adding a second panel to
the same strip, a phase later.

The shape is the earlier one with the registration split across *two* tables
instead of a frontend and a backend: the panel was built, tested and registered,
and its own tests passed because they mount `TodoPanel` directly. A component
test that never goes through the surface's own routing proves the component
works, not that anyone can get to it.

**Added to the checklist:** when a surface is reached through a list, grep for
every list its siblings appear in and confirm the new entry is in all of them. A
right-panel mode needs four (`RIGHT_MODE_TABS`, `modeOrder`, `SetRightMode`,
`RIGHT_MODES`); at least one test should drive it the way a user does.

## It hid a whole feature behind a working one (2026-08-14)

"Defer permissions to the harness" phase 1 wired Claude's in-protocol
`can_use_tool` question, and `ChatCommand::RespondPermission` had **no caller
outside tests**. So the in-protocol answer path was unreachable from the UI while
every unit test around it passed - and the surface did not look broken, because
the *other* answer path (Sway's own hook, which the phase existed to retire) was
still handling every prompt. The user would have clicked a button that answered
the wrong mechanism.

That is the sharpest version of this lesson so far: the previous occurrences left
a control that visibly did nothing. This one left a control that visibly worked,
because a second implementation of the same verb was still live. **When a change
introduces a second path to an existing behaviour, the test that matters is which
path a click actually reaches**, not that both paths pass their own tests.

## Related

- [[concept_fan_out_attempts]] - the phase this held up for a session
- [[component_acp_transport]] - the second answer path, whose arrival is what made the fourth occurrence invisible
- The first occurrence was `chat_add_restriction`, in the chat plan's phase 6. Its
  concept page is deleted: the Sway-owned rule store it described was retired
  whole in "Defer permissions to the harness", so the occurrence survives only
  here.
- [[lesson_verify_after_the_last_edit]] - the sibling failure, one step later in the cycle
- [[concept_command_registry]] - the frontend table whose handlers this caught
- [[gotcha_a_solid_component_that_early_returns_on_a_prop_freezes_at_mount]]
