---
summary: partial line staging cannot reorder a diff's grouped removals and additions, staging half a pair commits the wrong file
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phase 14; `src-tauri/src/patch.rs` (`build_line_patch`); commit 4c9154e"
---

# A demoted removal lands before the additions in the same block

Don't expect line-level staging to stage the lines you picked *in the order you see them*. Why: git groups a run of removals ahead of a run of additions, and a partial line selection turns each unselected removal into context in place, so staging the `a -> A` half of `-a -b +A +B` produces `b, A` in the index and not `A, b`. Committing there is a file nobody wrote. There is no fix available from the diff alone: ordering it correctly needs to know which removal each addition replaced, and a unified diff does not say, so any pairing is a similarity guess that writes the wrong file when it guesses wrong. Tori follows the rule `git add -p`'s edit mode documents ("to remove a `-` line, make it a ` ` line"), which is what every other line-staging tool produces, and re-reads the diff immediately after so the result is on screen.
