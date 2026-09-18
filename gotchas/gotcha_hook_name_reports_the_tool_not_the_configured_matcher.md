---
summary: hook_name in the in-band frames names the tool a hook fired on, not the matcher, so two hooks look identical
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (personal/tori, branch `chat`); Phase 12; `src-tauri/src/chat/claude.rs`, `src-tauri/src/chat/approval.rs`
---

# `hook_name` reports the tool, not the configured matcher

Do NOT try to tell whose hook fired from `hook_name` in the in-band `hook_started`/`hook_response` frames. Measured on claude 2.1.220: a hook registered with `matcher: "*"` arrives as `PreToolUse:Bash` on a Bash call, i.e. named for the **tool**, so Tori's all-tools approval hook and a user's own `PreToolUse` hook on that tool are byte-identical by name, and the frames carry no command line. Stamp your own output with a marker instead (Tori uses `toriApproval`) and parse it rather than substring-matching, since a user hook can legitimately print the word. Only the *response* carries the marker, so a `started` frame must be attributed retroactively by `hook_id`. Related: [[lesson_identify_your_own_hook_rather_than_inferring_it]], [[concept_pretooluse_capture_hook]].
