---
summary: the search buffer guards each edit against the line's own text (was), not a file digest, so a late edit lands right
status: current
updated: 2026-08-27
source: "Editor Wave 6: the IDE surface (personal/tori, branch `wave-6`); Phase 11, issue #50, commit 48af914; extended by Phase 12 (#61, commit 98b038b); widened to span a Feature by Features phase 4 (#156), branch `feature-workspace`, phase 3, commit 9c7ce7a; `src/panels/Editor/searchResultsDoc.ts`, `searchResultsStore.ts`, `SearchResultsBuffer.tsx`"
---

# The editable search-results buffer: a line-to-(file, line) map guarded by the line itself

Project search results are materialised as one editable CodeMirror document. Edit the matching lines, press ⌘S, and the edits are written back to the files they came from. It is not a buffer inside `CodeEditor` and it is not a file: it is its own CodeMirror instance behind a `tori://search/<query>?ws=` tab, because the document has no path, needs no language server, and lives under rules no file buffer has.

Since #156 the map is **buffer line -> (member, file, source line)**: one buffer covers a whole Feature, and a row writes into its own member's repo.

## How it works

- **The unit is a whole line.** A result row shows a line, so the map is line-to-line and the write carries `was` (the text the row was built from) as its guard. `buildSearchDoc` (`searchResultsDoc.ts:122`) mints it; `collectEdits` (`:217`) reads the edits back out.
- **A row is addressed by `(root, file)`, never by the file alone.** Two members of a Feature routinely hold the same `src/index.ts`, so `markKey` (`:98`) joins the member root and the relative path on a NUL and everything keyed on a file goes through it: the applied/refused marks, the collected edits, the already-written lock. Locking one member's `src/index.ts` after a write has to leave the other member's copy editable, and that is the ordinary frontend/backend case rather than an edge one.
- **Two invariants, each enforced twice.** The line count cannot change, and only a result's own text is editable: at the buffer by a transaction filter (`refusalFor`, `:242`), and again at the write by Rust's `apply_line_edits`, which refuses a `now` containing a newline and two edits on one line. A map nobody can see is not a thing to trust to one guard, and the command is reachable with arbitrary arguments the way `replace_in_files` is.
- **A refusal is said out loud.** A plain read-only range set would drop the keystroke silently, which reads as a broken editor; the filter refuses *and* names why, which is the only reason it is a filter and not a range set.
- **A mixed apply settles into two states** (`settle`, `:274`). An applied file is locked *and* re-anchored, so a second apply has nothing to say about it by two independent routes. A refused file stays editable and keeps **the text the search saw** as its `was`.
- **`markSelfWrite` is used here, unlike in the panel's replace.** A file with a **dirty** buffer takes the edit in the buffer (`liveBuffers.patch`) and is not written at all; a file that is written hands its new bytes to any buffer holding it. Marked twice around the batch, for the reason `writeRenamedFiles` documents. The absolute path it marks is built from the **row's own** root, so a batch spanning members cannot suppress a watcher echo in the wrong repo.
- **`apply_line_edits` takes one root, so a write fans out per member.** `collectEdits` groups by `(root, path)` and `writeBack` sends one command per member with that member's files, root stripped back off each one. Grouped rather than one call per file, so a member still writes in a single command as it always did.
- **Phase 12 made a saved search open this buffer.** After #50 the thing a saved search names is something you can edit and write back, not a list to click through; the panel is restored underneath it so the toggles on screen still describe what is being looked at. A search that now matches nothing opens no tab.

## One buffer for a whole Feature (2026-08-27, #156)

- **The document carries `roots: DocRoot[]`, not a single `root`.** Each is the absolute folder its rows write into plus the label a header shows. `Row` gained `root` on both the `file` and `match` kinds, and a fourth kind, `member`, renders as `[Payments API]`.
- **The member header appears only where the document spans more than one.** Bracketed because a bare label and a bare file header are both left-aligned plain text and would otherwise be indistinguishable; absent over a single member because it would name what every row already is, at the cost of a line before the first result.
- **A message names the member only when the path alone names two.** `describeApply` qualifies a refusal as `src/index.ts in Web App` in a multi-member document and leaves it bare in a single-member one, so nothing about the branch-unit case changed.
- **The tab keys on `wsKey`, not on a root** (`searchResultsId`, `searchResultsStore.ts:47`). Open means "the result set on screen", and a tab per member is a tab per member to close. The cost is real and is paid in [[concept_synthetic_editor_tabs]]: the id stops carrying a folder, so `searchBufferRoots` (`:61`) exists for the two readers that needed one.
- **Open is no longer fenced.** Between #156's phases 1 and 3 the button was disabled with an explaining tooltip whenever hits spanned members, because the document held one root and every row would have resolved against it. That fence is gone.

## Why it's this way

**The guard is the source line, not `replace_in_files`' file digest.** A digest is right for a replace fired seconds after a search and wrong here: a results buffer is edited over minutes, and refusing every file because something else touched an unrelated region of it would make the feature unusable on a repo with an agent running in it. Comparing the line answers the question that actually matters, which is whether *this* edit still lands where it was aimed.

**A refused file must not adopt the edit.** Keeping the search's text as `was` is what makes a retry compare against the file; adopting would make it compare the buffer against itself and write at an offset nobody agreed on.

**`patch` is `adopt`'s opposite, and `liveBuffers.ts` now carries both.** `adopt` says "the file now matches you"; `patch` rewrites lines and leaves the buffer as dirty as it found it, all-or-nothing against `was`, and says "this edit is yours to save".

**It needed a module-level store, for `closedBuffers`' exact reason.** The Editor renders a synthetic tab's view only while that tab is active, so switching tabs unmounts it. A read-only view does not care; a buffer with typed edits in it very much does. That store is also where the wave's sharpest CodeMirror trap lived: see [[gotcha_a_kept_editorstate_carries_the_configuration_it_was_built_with]].

**Phase 10 went the other way for scratch buffers, and the contrast is the useful part.** A scratch *is* an ordinary file, so making it one added no branch to the buffer map, the dirty flags, the stash or the persist layer. This document is not a file, and forcing it into the path-keyed model would have put a branch in all four.

**`searchResultsDoc.ts` and `searchResultsStore.ts` import CodeMirror as types only.** The Search panel is on the eager side of the lazy `CodeEditor` import; one forgotten `import {` would pull ~1.3 MB into the main chunk and nothing in the suite would fail. Checked with `?raw`, following `commands.test.ts`.

## Related

- [[component_search_panel]] — the panel that produces the result set and now also owns history and saved searches.
- [[concept_member_fan_out]] — how the merged, member-tagged result set is produced, and the `(root, path)` rule this document inherits.
- [[concept_fail_closed_replace]] — the guard chain the panel's own replace uses, and why this one differs.
- [[concept_synthetic_editor_tabs]] — the `tori://search` tab id, and why its `ws=` field stopped being a folder.
- [[component_editor_stores]] — the eager/lazy boundary that forces the type-only imports.
- [[gotcha_a_kept_editorstate_carries_the_configuration_it_was_built_with]] — the Major that hid inside the store.
