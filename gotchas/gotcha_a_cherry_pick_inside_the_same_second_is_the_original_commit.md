---
summary: a cherry-pick in the same second with the same parent is byte-identical to its original, so a test copy is no copy; use -x
status: current
updated: 2026-10-11
source: plan "Pull, Pull (Rebase) and Push say what they will do to this branch" (gettori/tickets#73, branch phase-1-block-2); `src-tauri/src/git.rs:4788` `push_duplicates_counts_main_replayed_onto_the_branch`
---

# A cherry-pick inside the same second is the original commit

A commit's hash covers its tree, parents, author, committer (with timestamps to the second) and message. Cherry-picking a commit onto its own parent, as a fixture does to make copies of main on a branch still sitting where main was, reproduces every one of those fields when the pick lands in the same second as the original. The "copy" is the original commit, the branch fast-forwards, and a count of commits ahead reads zero. The test passes or fails depending on whether the clock ticked between the two commits.

Pass `-x`: it appends a "cherry picked from" line to the message, so the copy gets its own hash while `git cherry` still matches it by patch.

## Related

- [[concept_push_target_is_origin_branch_not_the_upstream]]: the copy check this broke the test for
