---
summary: github answers 422 to approve and request changes from the pull request's own author, every pr on a single owner repo
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phase 11; `src/utils/pendingReview.ts:112`; commit 8e6f03b"
---

# GitHub refuses approve and request-changes from the PR author

Don't offer approve or request-changes without knowing who the viewer is. Why: GitHub answers 422 to both from the pull request's own author, and on a single-owner repo that is every pull request Sway opens, so the two verbs render disabled with the reason rather than hidden. An unknown viewer blocks them too: not-yet-known is not known-different.
