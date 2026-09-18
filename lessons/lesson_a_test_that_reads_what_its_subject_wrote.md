---
summary: a listing test passed in seven seconds because setup had already written the file it read, a suspiciously fast pass
status: current
updated: 2026-08-15
source: Make a harness installable, signed in, and discoverable (personal/tori, branch `harness-lifecycle`); Phase 6; `src-tauri/src/chat/acp_transport.rs` (`codex_lists_the_sessions_it_already_had_over_session_list`)
---

# A test that reads what its subject wrote is asserting its own setup

The question was whether `codex-acp` answers `session/list` with anything. The test opened a live Codex session, ran a turn, closed it, opened a *second* session, and asserted the first now appeared in Tori's locator store. It passed in 7.49 seconds.

It should not have. `session/new` writes a locator of its own, so the first session's file was sitting in the store the entire time. The assertion read a file the setup had written and could not have failed no matter what the agent answered. Wiping the store between the two connections turned it red immediately, and only then did the real answer arrive: the listing returned **zero rows**, for a reason worth finding ([[gotcha_codex_acp_matches_the_session_list_cwd_filter_as_a_string]]).

## The shape

The subject under test and the assertion's source of truth are the same store. It is easy to build without noticing, because the store is usually the *right* place to look: it genuinely is where a listing deposits its rows. The problem is that it is also where three other code paths deposit theirs.

The tell here was the clock. Two `npx` spawns and a live model turn do not finish in seven seconds, and the second `wait_for` returning instantly meant its condition was true before the agent had said anything. **A green test that is suspiciously fast is reporting its own setup back to you.** A failing version of the same test burned its full 180-second deadline, which is what it looks like when the condition is actually being evaluated.

## What to do

- Ask what else writes to the place the assertion reads. If the setup does, the test proves nothing about the subject.
- **Clear the shared store between arranging and acting**, and assert it is empty before acting. One line, and it converts an untestable assertion into a real one.
- Treat an implausibly fast pass as a failure signal, the same way you would treat an implausibly fast build.
- Sanity-check the negative: make the thing you are measuring impossible and confirm the test goes red. Here that was already available for free, because wiping the store *was* the fix.

The same run produced a second reason to distrust the store as an oracle: with Tori's own id gone, the imported row is filed under an id derived from the agent's, which is the shape a session started outside Tori actually arrives in. The honest test measures that shape; the vacuous one measured the shape Tori had just written.

## Related

- [[concept_acp_session_locator]] - the store this test reads, and the three writers it has
- [[lesson_a_per_row_value_hoisted_to_a_container]] - the sibling failure, a caller nothing tests rather than a test that cannot fail
- [[lesson_a_test_can_pass_because_its_fixture_stopped_parsing]] - same family: the assertion stopped being evaluated
- [[lesson_debug_the_harness_before_recording_the_outcome]] - measure the measurement first
