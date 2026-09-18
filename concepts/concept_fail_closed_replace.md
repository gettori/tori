---
summary: multi file replace has no undo, so every file passes containment, a digest, re-verification and overlap or skips whole
status: current
updated: 2026-08-01
source: "Search panel v2: toggles, ignored files, replace-in-files (personal/tori, branch `wave-1-2`); Phase 3; `src-tauri/src/search.rs:628` (`replace_in_files`); PR #81; issue #11"
---

# Fail-closed multi-file replace

Replace-in-files writes to many files at once, on the user's say-so, with **no undo**. That combination sets the design: every step assumes its input is wrong until shown otherwise, and the default at each one is to skip rather than write. A skipped file is a line in a report; a wrongly-written file is unrecoverable, and on the no-git backend there is not even a `git checkout` to fall back on.

The chain, in order, per file: **containment → digest → span re-verification → overlap → atomic write**. Anything that fails skips the whole file, never part of it, and the reason travels back to the panel by name.

## How it works

**Containment** reuses `fs::ensure_inside_named` (`fs.rs:156`), the same fail-closed guard the Shared tab's mutation commands use: `..` components are rejected lexically up front (a not-yet-created target cannot be canonicalized), then symlink-resolved absolute forms are compared so a symlink cannot redirect out of the project. It gained a `noun` parameter here so its message names the boundary it is actually guarding.

**The digest** is the file's size and mtime as captured at *search* time, carried out to the panel in `SearchResult.files` and handed back with the targets. A file whose digest has moved is skipped whole. An **absent** digest is also a skip, not a pass: without one there is nothing to compare, so the file cannot be shown to be the one that was searched.

**Span re-verification** re-runs the canonical regex at each offset and requires the match to start and end exactly there (`expand_at`, `search.rs:585`). This is not redundant with the digest: the digest proves the file has not moved, while this proves the *caller's offsets* describe a real match. It is also where the `Captures` for `$1` expansion come from, so the check and the work are the same call.

**Overlap rejection** sorts the edits and refuses any pair that intersects. Unreachable through the panel, whose spans come from `find_iter` and never overlap, but the command accepts arbitrary targets and every other guard in it is fail-closed.

**The write** applies edits back to front on the original bytes, so an earlier edit never shifts a later one's offsets, and goes through `chat/rules.rs:695` `write_atomically` (write temp, fsync, rename, fsync the directory). Operating on the original bytes rather than splitting and rejoining lines is what preserves CRLF endings and a missing final newline.

The frontend adds one guard the backend cannot: files with **unsaved edits** are withheld from the targets entirely, because the buffer, not the disk, is the version the user is looking at. Since the backend never sees those targets, it cannot report them, so the panel merges its own `unsaved changes` skips into the outcome alongside the backend's.

## Why it's this way

Each guard exists for a failure the others do not catch.

The digest replaced an earlier design that compared the *text of the addressed line*. That fails on the most ordinary case in code: an external edit inserts two identical lines above the match, so line 40 still reads exactly as it did while the match has moved to line 42. A line-text comparison sees no mismatch and writes to the wrong occurrence, silently. Duplicated lines (`}`, a repeated import, a log line) are the norm, not the exception.

The atomic write is not paranoia about crashes in the abstract. A Replace All spans many files and cannot be undone from the app, so a torn write is unrecoverable in exactly the situation where the user has the least ability to notice. `[[gotcha_a_truncating_write_under_a_lenient_reader_loses_data_silently]]` established the shape for this codebase already; the motivation differs (no lenient reader here) but the conclusion is the same, and the property is testable without crashing anything: a handle opened before the replace still reads the old bytes after a rename, where a truncating write would rewrite the file that handle points at.

The trade-off worth knowing: size-plus-mtime is cheaper than a content hash by roughly a thousandfold on a result set, because a content hash would mean re-reading every matched file on every debounced keystroke. What it buys in I/O it gives up in precision, being blind to an edit that preserves a file's exact byte length within the filesystem's mtime resolution (nanoseconds on APFS, so this needs a same-length write in the same nanosecond).

## Related

- [[concept_canonical_matcher]] - the matcher whose spans this writes at
- [[component_search_panel]] - the panel that assembles the targets and reports the outcome
- [[gotcha_a_truncating_write_under_a_lenient_reader_loses_data_silently]] - the atomic-write shape
- [[gotcha_containment_checking_a_not_yet_created_path]] - why `..` is caught lexically
- [[gotcha_a_replace_must_not_mark_its_own_writes_as_self_writes]] - the guard that must *not* be applied here
- [[concept_fs_change_pipeline]] - the watcher that carries the change back to open buffers
