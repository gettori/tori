---
summary: log and commit tabs share one diff-tree framing with root, first-parent and rename flags together for clean merges
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/sway, branch `wave-2`); Phases 6 and 7 (commits fecf42d, b108974)"
---

# Commit history: log, commit detail, file history

**Location:** `src/panels/Editor/CommitLog.tsx`, `src/panels/Editor/CommitDetail.tsx`, `src-tauri/src/git.rs` (`git_log`, `git_commit_files`, `git_commit_file_diff`, `valid_object_name`)

Branch history and a single commit's diff, rendered as [[concept_synthetic_editor_tabs]] (`sway://log`, `sway://commit/<sha>`) so they open in the editor pane where there is width to read them, rather than in the right panel's column.

## Responsibilities

- **`git_log`**, one flat NUL stream: `-z --format=%H%x00%h%x00%s%x00%an%x00%cr%x00%D`, six NUL-terminated fields per commit with records NUL-terminated too, so `split('\0').chunks_exact(6)` drops the trailing empty field for free. `%D` is empty for an undecorated commit, which is nearly every commit, and is the case the parse fixture pins.
- **An unborn HEAD is an empty log, not an error**, detected with `rev-parse --quiet --verify HEAD`. See [[gotcha_git_log_exits_non_zero_on_a_repo_with_no_commits]].
- **`git_log` takes an optional `file`**, which is `--follow`, rather than being a separate command: file history is the same view with a different header, and one component is what stops the two lists drifting.
- **`sway://commit/<sha>`** renders per-file diffs by reusing `diffView.ts` and `DiffRows.tsx`, so a commit's diff looks exactly like the Changes panel's.
- **Rows in both views are `<button>`s**, not divs, which is what makes a commit reachable by keyboard.
- **A sha from a tab id is a string**, so `valid_object_name` (hex, 7 to 64) gates both commit commands before the value reaches a command line. File paths are already safe by sitting after `--`.
- **A 100% rename has no hunks**, so the file view says "Moved, with no change to its contents." rather than rendering an empty body, which reads as a failed load. Same for a binary or mode-only change.

## One diff-tree framing answers all three awkward commit shapes

Picking it was most of the backend:

```
git diff-tree -r -m --first-parent --root -M --no-commit-id <sha>
```

- **`--root`** gives the first commit a diff against nothing, rather than nothing at all.
- **`-m --first-parent`** gives a merge one diff against the branch it landed on. `git show`'s own default, the combined diff, is **empty for a clean merge**, and nearly every merge is clean, so the obvious command shows nothing for the commits people most want to inspect (see [[gotcha_git_shows_default_combined_diff_is_empty_for_a_clean_merge]]). Mutation-checked: drop the two flags and the test fails.
- **`-M`** finds renames, which then have to be carried: see [[gotcha_pathspec_limited_rename_detection_needs_both_paths_or_it_is_not_a_rename]] for why `old_path` is on `CommitFile` and threaded all the way to the frontend's diff call rather than being display-only.

Every one of these was probed against a real repository before any of it was written.

## Why it's this way

**Author name is paired with *committer* date on purpose.** After a rebase the author date of the tip can be months old, and "3 months ago" beside a branch you rebased this morning is a lie about the branch.

**Both views need a supersede token**, because the pane reuses a view across tabs of the same kind. That bit twice, once per component, and is written up in [[lesson_a_view_reused_across_tabs_needs_a_supersede_token]].

## Related

- [[concept_synthetic_editor_tabs]] - the tab-id scheme both views ride, and why it carries the workspace.
- [[component_changes_panel]] - the header entry point to the log, and the diff renderer both surfaces share.
- [[lesson_a_view_reused_across_tabs_needs_a_supersede_token]] - the reactivity trap this component met.
- [[lesson_a_solid_effect_inherits_the_change_rate_of_what_it_reads]] - why the log refetched on every file save until its accessors became memos.
