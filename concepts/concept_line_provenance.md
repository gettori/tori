---
summary: line provenance shows a commit if blame has one, else the turn that wrote it, from the same walk as hunk provenance
status: current
updated: 2026-10-08
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phases 8 and 9 (commits ad173e9, 6dc425f); `src-tauri/src/blame.rs`, `src-tauri/src/agent_lines.rs`, `src/utils/blame.ts`, `src/utils/agentLines.ts`, `src/panels/Editor/blameGutter.ts`; reworked by the provenance plan, gettori/tickets#25 (branch phase-1-block-1), commit a402d912, `src-tauri/src/provenance.rs` (`line_turns`)"
---

# Line provenance: a commit if it has one, otherwise a turn

Every line in the editor can say where it came from. Two marker layers answer that over one buffer, mapped identically and read in order: a commit answers the line if it has one, and failing that the turn that wrote it does. There is no third state to reconcile, because "no blame marker" is exactly what uncommitted means.

## How it works

**The committed layer (blame)**

- `git blame --porcelain` parsed to per-line sha, author and time. The payload is **one record per commit plus one index per line** (`lines: Vec<u32>`), not a record per line: a 5000-line file is about 20KB instead of about 1MB of repeated author and summary strings.
- **The cache key is `(file, HEAD)` and nothing else.** Blame answers which commit a line comes from, which cannot change while HEAD stands still, so an edit invalidates nothing.
- **Position is CM6's job, not ours.** Markers ride the same `ChangeSet` the document does, so typing never issues a blame call. That is asserted by counting call sites in a `?raw` source test, because it is a fact about call sites rather than about any one function.
- **A write changes which lines are uncommitted while HEAD stands still**, which the key alone cannot notice, so `dropBlame(root, file)` runs on our own save and on an external change. It *drops* rather than re-reads: the markers on screen were mapped through exactly the edits saved and are still correct, so the next rebuild pays rather than the save.
- **Laying blame down is the delicate half, not reading it.** `Blame.lines` is indexed by the file's numbering *on disk*, so rebuilding markers onto a buffer with unsaved edits puts every one of them out by however much was typed, and replaces markers CM6 had already mapped correctly. `canPlaceBlame(docText, savedText)` gates it.
- Age shading is on a **fixed scale**, not normalised to the file's own oldest line, so a file nobody has touched in years does not read as fresh as one written this morning.

**The uncommitted layer (agent attribution)**

- **Since 2026-10-08 this is `provenance::line_turns`**, the walk [[component_provenance]] runs for a diff hunk, read once per line. `agent_lines` is a thin projection of it, so the gutter and the hunk panel cannot disagree. The old walk over only the turns that named the file (`work_plan`, `resolve_lines`) is gone, and so is the reverse index's only reader.
- **The checkpoints still hold the answer.** Each turn checkpoint is a full tree, so the difference between two consecutive trees is what happened in that interval. Every checkpoint of every session in the worktree is a point on one timeline, and one batched `cat-file` drops the intervals where the file did not change before any diff runs.
- **Who wrote an interval is graded, not assumed** ([[concept_who_wrote_an_interval]]): a terminal session is read from its transcript like a chat, and a turn that wrote through a shell command is named as such rather than read as nobody.
- **Sessions are found by worktree in Rust** (`worktree_sessions`), no longer passed in by the editor from its open chats, which missed terminal sessions. The bare-repo reason still holds: the shared ref store lists sessions of other worktrees, so they are found by cwd, never from the refs.
- The cache is dropped in `flushAgentWrites` **before** the "does this path have a buffer" test, so a file cached while open, closed, then rewritten does not come back stale.
- The walk keeps the **40 newest changes** to the file, and what the cap costs is stated: an older line reads as older than the walk, never as written by the wrong turn.

## Why it's this way

**The resolution is a turn, not a keystroke, and the test says so out loud.** A checkpoint is taken per prompt, so an edit the user makes *between* two turns is credited to the turn whose interval it fell in. The one interval that is genuinely separable is the tail, after the last recorded turn, and it is attributed to nobody rather than to the most recent agent.

**Both layers need `startSide = 1` on their gutter markers**, and the same test caught it for each. See [[gotcha_a_cm6_gutter_marker_needs_startside_1_or_the_line_you_just_typed_inherits_its_neighbours_blame]]. That is the one case where provenance *lies* rather than merely goes missing.

**The toggle is a localStorage preference, not a settings field**, for the same reason `sideBySide` is: it is something you switch on while reading one file, and routing it through the Rust settings shape and the Settings window would be ceremony for a per-reading choice. The extension lives in a `Compartment` so switching off takes the field, the gutter and the widget together rather than leaving an empty column.

## Related

- [[component_turn_checkpoints]] - the trees this replays over.
- [[component_provenance]] - the resolver the gutter now reads.
- [[concept_who_wrote_an_interval]] - how an interval's writer is graded.
- [[gotcha_grep_here_skips_files_it_thinks_are_binary]] - why the gutter once looked unwired.
- [[concept_evidence_tiered_attribution]] - the same discipline about stating what is measured versus inferred, one layer up.
- [[component_cm6_editor]] - the buffer both marker sets decorate.
- [[gotcha_a_cm6_gutter_marker_needs_startside_1_or_the_line_you_just_typed_inherits_its_neighbours_blame]] - the mapping default that silently misattributes.
- [[gotcha_git_blame_porcelain_emits_a_commits_metadata_only_the_first_time_it_appears]] - the parse trap underneath the committed layer.
