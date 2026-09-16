---
summary: reverting a mutation test with git checkout on an uncommitted tree destroys the work, restore from a scratch copy
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth, Phases 6 and 9 (personal/sway, branch `wave-7`); commits 506d7e7, d7a6e3e"
---

# Reverting a mutation with `git checkout` restores HEAD, not your work

Do NOT revert a mutation test with `git checkout <file>` on an uncommitted tree. It restores the file to HEAD and destroys the in-progress phase's own edits, and the next mutation then runs against already-reverted code and reports a meaningless result. Copy the files to a scratch directory first and restore from the copy. Why: mutation testing is most useful exactly when the work is not yet committed, which is when this is most destructive; it cost real rewrites twice in one wave.
