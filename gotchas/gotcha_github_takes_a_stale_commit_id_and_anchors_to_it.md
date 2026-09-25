---
summary: GitHub accepts an older commit_id on a review without refusing, so a moved head must be checked by Tori first
status: current
updated: 2026-09-25
source: plan "Review flow" (gettori/tori#208) on branch orchestrator, commit b25293df; src-tauri/src/rpc/methods.rs (submit_pinned); GitHub REST "Create a review for a pull request", commit_id parameter
---

# GitHub takes a stale commit_id and anchors to it

Do not count on `commit_id` to refuse a review whose pull request has moved on: GitHub accepts an older commit, anchors the comments to it (they may show as outdated) and counts an approval as given. Why: the parameter names what was reviewed, it is not a precondition, so the only refusal is one Tori makes by reading the head first.

## Related

- [[adr_review_submit_pins_the_reviewed_head]]
- [[concept_review_line_anchoring]]
