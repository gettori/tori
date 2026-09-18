---
summary: git refuses to rm a path with unmerged entries unless forced, accepting a delete on a delete/modify conflict needs it
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phases 12, 13; `src-tauri/src/conflict.rs` (`git_conflict_resolve`), `src/utils/conflictAsk.ts`; commits 167ac63, 9cdbe93"
---

# `git rm` on an unmerged path needs `-f`

Don't offer "accept the deletion" on a delete/modify conflict as a plain `git rm`. Why: git refuses to remove a path that has unmerged entries without `-f`, so the one action that finishes a delete/modify conflict fails with a message about the working tree rather than doing the thing. Related and easy to get wrong in the same breath: for that conflict shape, "accept theirs" would stage an **empty** file where git means **no** file, so the pair offered has to be keep versus remove, not a region walk.
