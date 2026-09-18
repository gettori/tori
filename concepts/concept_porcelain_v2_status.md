---
summary: git status reads by porcelain v2 record type with counted fields, since a leading XY scan cannot tell DD from a delete
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phase 2 (commit db98306) and Phase 10 (commit b8bd8b4); `src-tauri/src/git.rs` (`git_status`, `parse_status`)"
---

# Reading git status by record type, not by columns

`git status` used to be read as `--porcelain` v1 and sliced with `&line[..2]`. It is now read as `--porcelain=v2 -z` and dispatched on each record's **type letter**, because the thing the panel needs to know (is this file staged, unstaged, conflicted, and what is its real path) is carried by the record type and by counted fields, not by two columns of text.

## How it works

- **Five record types, dispatched before anything else is read.** `1` ordinary change, `2` rename or copy, `u` unmerged, `?` untracked, `!` ignored. Each has its own field layout and its own derivation of `staged` / `unstaged` / `conflicted`.
- **Field counts before the path are the whole parser**: `1` spends 7, `2` spends 8, `u` spends 9. The path is whatever is left, so the split is **counted, never greedy**: a real path may contain spaces, and a greedy split silently truncates it.
- **A rename spends two NUL fields**, the new path inline and the original as the *next* record, so the reader pulls `records.next()` rather than splitting. Type `2` is renames **and** copies (`R100` versus `C100`) and both take that form, so the pairing must not key on the score. See [[gotcha_a_rename_or_copy_record_spends_an_extra_field_so_a_fixed_size_chunker_desyncs]], which is the same shape three more times over.
- **`-z` removes quoting entirely.** Under v1, git quoted and escaped any non-ASCII or space-containing path, so the string the panel held was not a path and every diff for such a file came back empty. Under `-z` the bytes arrive raw and usable.
- **The status string is normalised back to v1's spelling**, v2's `.`-for-unmodified becoming a space and untracked synthesising `"??"`. That kept the field's meaning identical for its one consumer (`statusClass` in [[component_changes_panel]]) and left every existing fixture valid.
- **`conflicted` is exclusive with `staged` and `unstaged`.** A `u` record has three index stages, not one staged version, and git refuses `commit`, `restore --staged` and `restore` on it alike. Clearing the other two flags is what drops the file out of both sections, so the Conflicts section is the only place it can appear and nothing has to filter it back out.

## Why it's this way

**The record type carries information the columns threw away.** Two of the seven unmerged codes carry no `U` at all: `AA` (both added) and `DD` (both deleted). `DD` is indistinguishable from an ordinary staged-plus-worktree delete once the type is gone, so any leading-XY scan misclassifies it. Every fixture for this parser was captured from **real** `git status --porcelain=v2 -z` output, including a real merge conflict for the `u` record, rather than written from the documentation: the field counts are the entire parser, and a doc-derived layout would have failed silently a phase later rather than at the point of writing.

The migration was staged deliberately. Phase 2 was a **pure format change** that kept v1's reading of conflicts (`u UU` still counted as both staged and unstaged); Phase 10 is what added `conflicted` and stopped counting them. Keeping the two apart is what made a wholesale parser rewrite reviewable.

`from_utf8_lossy` became genuinely load-bearing here rather than incidental. Under v1 the quoting made stdout valid UTF-8 by construction; under `-z` a non-UTF-8 filename now degrades to U+FFFD. That is no worse than v1, whose quoted form did not match a real file either, so it stays lossy with a comment saying so.

`worktree.rs::tree_dirty` still parses v1, and that is correct rather than an oversight: the only path it extracts is compared against the fixed ASCII `.shared` name, and every other branch returns dirty without reading the name at all.

## Related

- [[component_changes_panel]] - the sole consumer of the staged/unstaged/conflicted split.
- [[concept_three_way_conflict_model]] - what the `u` record leads to once a file is known to be unmerged.
- [[gotcha_a_rename_or_copy_record_spends_an_extra_field_so_a_fixed_size_chunker_desyncs]] - the trap this parser met first and three more surfaces met after.
