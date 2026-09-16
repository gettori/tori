---
summary: a test that includes the file it lives in finds its own pattern in its own string literals and fails on a clean tree
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth, Phase 6 (personal/sway, branch `wave-7`); `src-tauri/src/lsp.rs` (`every_command_here_is_registered_with_the_app`); commit 506d7e7"
---

# A source-scanning test in the file it scans reads itself

Do NOT `include_str!`/`?raw` a file from a test living inside that same file without cutting the test half off first. The scan finds the pattern inside its own string literals and reports a fragment of its own parser as a finding, so the test fails on a clean tree. Split on `#[cfg(test)]` and scan only the half above it. Why: the failure looks like the thing the test was written to catch, so the first instinct is to "fix" working code.
