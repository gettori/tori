---
summary: a buffer can be shorter than its file or already discarded, so a destructive decision must ask the file, not the view
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface (personal/sway, branch `wave-6`); Phase 9 (#57, commit 3cbbde1) and Phase 10 (#58, commit de2a19d); `src/panels/Editor/bookmarksPane.test.tsx`, `src/panels/Editor/scratchTabs.test.tsx`"
---

# Ask the file, not the buffer, when the buffer is allowed to be incomplete

## What happened

Two phases, two features, the same bug found in self-review both times.

**Bookmarks.** Marks are held as CodeMirror positions so edits map them for free, and the buffer reports back which ones moved. A file can be *shorter* than it was when a mark was made (a checkout, a revert), and a buffer cannot report a mark past its own end. Taking the buffer's answer as the whole truth deleted those marks on the next keystroke.

**Scratch buffers.** Closing an untouched scratch deletes its backing file. The first version asked the buffer whether it was empty. A discard throws the buffer's text away without touching disk, so `Cmd+N`, type, close, Discard left an empty file behind: exactly the litter the rule exists to prevent, produced by the sequence that produces it most.

## Why

A buffer is a *view* of a file, and a view is allowed to be partial, stale, or already gone. It cannot see content beyond its own length, it does not exist for a tab nobody has clicked, and it is discarded before the file it described is. Every one of those is a legitimate state, so any of them makes the buffer an unsound witness about the file.

The bookmark case is the sharper one because of *how* it fails: it only bites when a mark that can be seen moves in the same file as one that cannot. The obvious first test passed against the broken code (see [[lesson_a_test_that_passes_against_the_broken_code]]).

## What to do next time

When a decision destroys something (drops a stored entry, deletes a file), name the witness explicitly and check whether it can be incomplete:

- If the buffer's answer is a *subset* of the truth, carry the rest across untouched rather than treating absence as removal. `onMoved` now ships the buffer's line count, and the pane keeps out-of-range marks.
- If the file can answer at all, read the file. The scratch close now stats the file in all five cases, including the two the buffer cannot answer, short-circuited on the scratch test so an ordinary close costs no read, and with a failed read answering "not empty" so nothing is deleted on a guess.
- Default the failure direction toward keeping data. A leaked empty file is recoverable; a deleted bookmark set is not.

## Related

- [[concept_path_keyed_workspace_stores]] — bookmarks and the sweep family this belongs to.
- [[concept_editor_tab_workspaces]] — scratch buffers as ordinary files, and why that was the cheaper model.
- [[lesson_a_test_that_passes_against_the_broken_code]] — the reason neither bug was caught by its first test.
