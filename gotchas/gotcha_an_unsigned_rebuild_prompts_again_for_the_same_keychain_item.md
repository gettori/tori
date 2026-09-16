---
summary: macOS binds a Keychain Always Allow grant to the binary's contents, so any unsigned rebuild prompts again
status: current
updated: 2026-09-06
source: "Agent usage preview plan (personal/sway, branch `agent-usage`), phase 4 . `src-tauri/src/usage_token.rs:32` . PR #169 . _2026-09-06_"
---

# An unsigned rebuild prompts again for the same Keychain item

Do NOT promise a user that "Always Allow" ends the dialog. Measured 2026-09-06: macOS binds the ACL entry to the binary's **contents**, not to its path, so every rebuild of an unsigned Sway asks afresh for `Claude Code-credentials`, and a prompt returning after an update reads as a bug unless the copy said it would. Allow grants one read; Always Allow silences later reads of that exact build (0.03s against 7 to 10s blocked on the dialog).
