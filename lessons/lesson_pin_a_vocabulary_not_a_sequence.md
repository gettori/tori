---
summary: an LLM CLI's stream mixes vendor format with model discretion, so pin the frame kind set and grammar, not a sequence
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (phase 1), branch `chat`; `dev/protocol-probe.mjs`
---

# Pin a vocabulary and a grammar, not an event sequence

## What happened

The task said the wire-format check should "re-run and reproduce every fixture's event-kind sequence". Built that way as a linear sequence diff, it failed on runs where nothing had changed. An LLM CLI's output stream mixes the CLI's own format with the *model's* discretion, and a sequence diff cannot tell the two apart.

Measured flapping across identical repeated runs: `rate_limit_event` landed at index 2 of 11 twice and index 9 of 11 once; the same `bash-call` prompt produced a thinking block on one run and none on the next; `system/hook_response` and `user/tool_result` traded places with `message_delta`/`message_stop`.

## Why

A check that fails on every run is a check nobody reads, and it would have been deleted or permanently ignored within a week - taking the real regression coverage with it. The flapping was not noise to be tolerated; it was the signal that the check was asserting something the CLI never promised.

## What to do next time

Split what the vendor guarantees from what the model chooses, and assert only the former:

- **A vocabulary** - the *set* of frame kinds. Model-discretionary kinds are declared optional, so their absence is fine, but an **unrecognised** kind always fails. A rename is still caught, via its new name showing up as unknown.
- **A grammar** - the orderings that are structural: messages open and close in order, blocks nest inside them, deltas fall inside an open block, each turn's `system/init` precedes its first stream frame.
- **A `requires` clause per scenario**, or "optional" hollows the corpus into a check that passes on an empty stream.
- **Run a negative control.** A deliberately bogus required kind must fail with a non-zero exit, or you have only proven the check is quiet.

This generalises past wire formats: whenever a check is flaky against an unchanged system, suspect the assertion before the system.

## Related

- [[concept_transport_neutral_event_model]] - what the pinned contract feeds
- [[lesson_synthetic_test_values_hide_unit_bugs]] - the sibling failure, a check that is quiet when it should shout
