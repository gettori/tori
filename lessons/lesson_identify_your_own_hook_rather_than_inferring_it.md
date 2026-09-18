---
summary: stamp your own hook's output with a marker, hook_name reports the tool not the matcher so two hooks can look identical
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (phase 12), branch `chat`; `src-tauri/src/chat/approval.rs`; `src-tauri/src/chat/claude.rs`
---

# Stamp your own hook's output; never infer ownership from its name

## What happened

Under `--include-hook-events`, Claude reports each hook execution in-band. Tori needed to fold away its *own* injected approval hook (it runs on every tool call, contributing two frames each time) while showing the user's hooks inline.

The obvious discriminator was `hook_name`, and it does not work. Measured on claude 2.1.220: `hook_name` reports the **tool**, not the configured matcher. Tori's hook is registered with `matcher: "*"`, but on a Bash call it arrives as `PreToolUse:Bash` - byte-identical to a user's own `PreToolUse` hook on Bash. Both fired, both with that name, and the frames carry no command line to separate them.

## Why

The plan's own premise was also wrong in a way worth recording: it said the all-tools matcher makes Tori's hook "fire twice per tool call". It fires **once** and emits **two frames** (`hook_started` + `hook_response`). The arithmetic downstream was right; the stated mechanism was not.

Inferring ownership from the *shape* of the output (does it carry a `permissionDecision`?) would have been a heuristic that silently misfires on any user hook that also gates permissions - the exact users most likely to notice.

## What to do next time

**Make your own artefact self-identifying at the point you emit it**, rather than reconstructing its provenance downstream. Tori's hook output now carries a `toriApproval: true` marker, so attribution is exact rather than probabilistic.

Verify the marker is genuinely inert before relying on it. Here that meant confirming Claude echoes the whole stdout string back in `hook_response.output` verbatim, ignores keys it does not know, and **still honoured a `deny` carrying the marker** (it landed in `result.permission_denials`).

Two consequences worth copying:

- **Parse, don't substring-match.** A user hook that merely prints the marker word (echoing a payload, logging a diff) must not be mistaken for yours. Only a real top-level `true` counts.
- **Handle the half that arrives before the evidence.** Only the *response* carries the marker, so a `hook_started` is attributed retroactively by `hook_id`. An unattributed frame reports as *not* yours - the safe direction, showing a row that may later fold rather than hiding a user's hook that never gets attributed.

## Related

- [[concept_pretooluse_capture_hook]] - the hook being identified
- [[component_chat_panel]] - where the fold is applied as a view decision
- [[gotcha_hook_name_reports_the_tool_not_the_configured_matcher]]
