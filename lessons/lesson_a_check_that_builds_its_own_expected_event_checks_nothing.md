---
summary: a neutrality check compared the mapper to an event it hand built instead of calling the mapper, so it checked nothing
status: current
updated: 2026-09-04
source: plan "Confirm an ACP mode or model switch from the agent's own answer" (personal/sway, branch `bugfix-260903`, issue 164, commit 1aedc0b); `src-tauri/src/chat/neutrality_check.rs` (`map_acp`, `CurrentModeUpdate` arm); `src-tauri/src/chat/acp.rs` (`an_update_with_no_sway_counterpart_maps_to_no_events`)
---

# A check that builds its own expected event checks nothing

## What happened

`neutrality_check.rs` asserted that an ACP `CurrentModeUpdate` maps to a `TurnStarted` carrying the new mode, with a comment saying that is "how Claude confirms a mode switch took effect too". The real mapper in `acp.rs` drops that update, and a test there pins the drop. Both files were green for months. Meanwhile no ACP agent ever emitted a `TurnStarted`, so the store's mode confirmation, which lives in the `turnStarted` arm, never ran on that transport (issue 164).

## Why

The neutrality check's `map_acp` is a hand-written table of "what this update should become", not a call into the mapper. A hand-built expectation can describe a mapping nobody implemented, and the check stays green because it is comparing the table to itself. The comment made it worse by explaining a mechanism that did not exist, which read as documentation to anyone who trusted the file.

## What to do next time

When a check asserts a mapping, either call the real mapper or state the gap in the table: a source variant the mapper drops maps to the check's no-counterpart target, with a comment naming the test that pins the drop, never to a plausible event built by hand. If a comment in a check explains *how* something is confirmed, grep the mapper for that event before believing it. Here `CurrentModeUpdate` now maps to `sessionError` with the ACP bound raised to two, and the foreign-vocabulary assertion moved to the `SessionStarted` arm.

## Related

- [[concept_transport_neutral_event_model]] - the check this lives in
- [[concept_acp_config_options]] - how an ACP mode is actually confirmed
- [[gotcha_an_acp_mode_pick_is_staged_until_the_next_prompt_a_model_pick_is_answered_at_once]] - the rule the real confirmation had to follow
