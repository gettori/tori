---
summary: the pulls files endpoint silently caps at 300 files, so a larger PR renders as complete when it is truncated
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phase 9; `src-tauri/src/forge/github.rs:46` (`PR_FILE_CAP`); commit ce1c941"
---

# `pulls/{n}/files` stops at 300 files

Don't treat the files response as the whole pull request. Why: GitHub caps it at 300 and says nothing about the truncation, so a 400-file PR renders 300 files and looks complete; the cap is the server's, not a budget Tori chose, so the count that was not listed has to be shown.
