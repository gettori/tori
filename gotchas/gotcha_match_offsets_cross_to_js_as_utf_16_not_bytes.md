---
summary: ripgrep reports offsets in bytes while JavaScript indexes strings in UTF-16, so non-ASCII before a match drifts
status: current
updated: 2026-08-01
source: "Search panel v2 (branch `wave-1-2`); Phase 1; `src-tauri/src/search.rs:195`; PR #81"
---

# Match offsets cross to JS as UTF-16, not bytes

Don't hand ripgrep's submatch offsets straight to the frontend: they are byte offsets, and JavaScript indexes strings in UTF-16. Why: for `café needle` rg reports the match at 6, while JS needs 5, so every highlight and every replace span drifts on any line containing non-ASCII before the match. Convert at the boundary (`text[..start].encode_utf16().count()`), and note that trimming a line must strip only `\r\n`, since trimming trailing whitespace can push a `\s+$` match past the end of the text the UI renders.
