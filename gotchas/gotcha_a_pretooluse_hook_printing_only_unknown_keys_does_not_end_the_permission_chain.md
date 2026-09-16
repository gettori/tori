---
summary: a PreToolUse hook printing only unknown keys leaves the permission chain running, so a failing hook goes unattributed
status: current
updated: 2026-08-14
source: Defer permissions to the harness, and grow to four harnesses, phases 2 and 7 (personal/sway, branch `chat-fix`); `src-tauri/src/chat/approval.rs:134`, `dev/protocol-probe.mjs` scenario `hook-matcher`; [[concept_pretooluse_capture_hook]]
---

# A PreToolUse hook printing only unknown keys does not end the permission chain

Do NOT assume a `PreToolUse` hook must print nothing to stay out of the harness's way. Measured on claude 2.1.232: an output carrying **only keys claude does not know** leaves the permission chain running (the `Write` still raised `can_use_tool`) and comes back verbatim in `hook_response.output`. Any `permissionDecision`, by contrast, ends the chain at the hook. This matters because printing *nothing* is also chain-safe and is the tempting choice - and it silently makes `sway_owned` always false, so a Sway hook row cannot be attributed and a **failing** capture hook becomes invisible at exactly the moment the user needs to see it.
