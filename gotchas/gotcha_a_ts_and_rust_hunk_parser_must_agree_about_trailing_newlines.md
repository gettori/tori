---
summary: js split on newline yields a trailing empty string that rust's lines() does not, drifting a hunk hash on the last hunk
status: current
updated: 2026-07-20
source: Editor upgrades (personal/sway, phase 2); `src/utils/diffHunks.ts`, `src-tauri/src/patch.rs` (`cross_language_tests`); commit 01f0196
---

# A TS and Rust hunk parser must agree about trailing newlines

Do NOT assume two hunk parsers in different languages split a diff the same way. JS `"a\nb\n".split("\n")` yields a trailing `""`; Rust's `str::lines()` does not. Why: hunk-level staging fingerprints a hunk's header + body in both languages ([[concept_hunk_level_staging]]), so the phantom line changed the hash of the **last** hunk in every file and only the last one — staging it would have been refused as stale, looking like flakiness rather than a bug. `parseDiffHunks` now pops the trailing empty element to match `lines()`. Both suites lock the same value for a shared parse-then-hash fixture (`SHARED_FIXTURE`), so a future drift fails the build instead of the feature.
