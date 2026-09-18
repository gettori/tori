---
summary: an error path stays untested by every passing test, send one deliberate bad request before trusting how failures render
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/tori, branch `wave-8`); Phases 3, 9; epic #69; `src/utils/dapClient.ts:176`; commit 1c1fbf6"
---

# Make something fail on purpose before trusting the error path

## What happened

`dapClient.ts` rejected a failed request with `frame.message ?? "failed"`, which is what the DAP specification describes. It shipped in Phase 3 and survived six more phases, every one of them green. In Phase 9, the first feature whose whole point is showing the adapter's refusal to the user (a watch expression that does not resolve, a REPL entry that throws), every failure rendered as the single word **"failed"**.

Measured against js-debug 1.117, a failed response is:

```json
{"success":false,"body":{"error":{"id":9222,"format":"Uncaught ReferenceError: notAName$ is not defined","showUser":false}}}
```

**No `message` field at all.** The readable text is in `body.error.format`, with `{placeholder}` substitutions in `body.error.variables`.

## Why

Nothing had failed on a path anybody looked at. Six phases of tests drove the *success* path, and the two probes written to check the error body came back empty for a second reason: the e2e harness bundles its Tauri stub with esbuild, so editing the stub changed nothing until the bundle was rebuilt. The first probe result therefore *confirmed* the wrong belief.

The deeper cause is that an error path has no natural user. Everything else in a client is exercised by working; the failure branch is exercised only by something going wrong, and if the first thing that goes wrong is in front of a user, that is where you find out.

## What to do next time

**When you write the branch that renders somebody else's error, make the error happen before you move on.** One deliberate bad request, once, against the real other side. Not a unit test with a hand-built failure frame, which only proves the code matches your belief about the wire, but a real refusal from the real server, and then pin the frame you actually received into a test verbatim.

And when a probe of an unfamiliar wire comes back **empty**, suspect the probe. An empty result is the same shape as "the field is not there", and the harness is the cheaper thing to check first ([[lesson_debug_the_harness_before_recording_the_outcome]]).

## Related

- [[component_debug_session_tree]], `failureText` and the pinned frame
- [[gotcha_js_debug_sends_no_message_on_a_failed_response]]
- [[lesson_debug_the_harness_before_recording_the_outcome]], why the first two probes lied
- [[lesson_a_test_that_passes_against_the_broken_code]], the same shape, from the test side
