---
summary: a Feature member's path is the worktree or repo and moves on recreate, persist repoPath and resolve it at read time
status: current
updated: 2026-08-27
source: Features phase 4 (#156), branch `feature-workspace`, `src/utils/featureMembers.ts` (`resolveMemberRestriction`), `src/utils/searchHistory.ts`, `src/utils/savedSearches.ts`, commit ec71908, _2026-08-27_
---

# A member's path moves, only repoPath survives a recreate

Do NOT persist `MemberRoot.path` as a Feature member's identity. Why: `path` is the **worktree** when the member has one and the **repo** otherwise, so repairing or recreating a member relocates it, and anything stored against the old value silently stops matching. The failure is quiet in the worst direction: a saved search restricted to two members comes back matching none of them, and "restricted to nothing" is indistinguishable from unrestricted unless you go looking. Store `repoPath`, which holds across recreate, relocate and a missing worktree, and resolve it back against the members present now at read time (`resolveMemberRestriction`), falling back to every member when nothing resolves, since a saved search that searches nothing reads as broken rather than as empty. Both stores omit the field entirely when there was no restriction, so nothing in `localStorage` can spell "restricted to no member at all".
