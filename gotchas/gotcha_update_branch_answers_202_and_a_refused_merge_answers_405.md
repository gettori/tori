---
summary: GitHub's update-branch answers 202 before the queued merge runs, so state must be re-read, and a refusal answers 405
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phase 13; `src-tauri/src/forge/github.rs` (`update_branch`); commit 945c1bd"
---

# `update-branch` answers 202, and a refused merge answers 405

Don't read a 202 from `pulls/{n}/update-branch` as "the branch is now up to date". Why: GitHub queues the merge of base into head and answers before it has run, so the state afterwards is a question and the verdict must be re-read rather than assumed. Separately, a merge GitHub refuses comes back as 405, not 409 or 422, and that response body carries the only wording that ever names the rule blocking it.
