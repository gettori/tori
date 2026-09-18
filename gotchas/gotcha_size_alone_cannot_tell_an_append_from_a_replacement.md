---
summary: a resume by byte offset cache keyed on size and mtime alone resumes stale forever once a longer file replaces it
status: current
updated: 2026-08-20
source: plan "Worktree and tab switching at native speed" (phase 6, personal/tori, branch `unified-tab-bar`), `src-tauri/src/sessions.rs` (`session_prompt_tail`), commit 267fc4a, _2026-08-20_
---

# Size alone cannot tell an append from a replacement

Do NOT key a resume-by-byte-offset cache on file size and mtime alone. Why: a *different* file written to the same path that happens to be longer than the old one will resume from the stale offset and report the old count forever, and the failure is silent and permanent rather than noisy once. A small head sample (256 bytes) as part of the stamp is the guard. Watch the test too: the first version of the covering test replaced the file with one of the **same** count, so it passed with the guard removed and proved nothing.
