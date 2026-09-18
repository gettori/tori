---
summary: line provenance shows a commit if blame has one, else the turn that wrote it, replayed via git diff -U0 over trees
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phases 8 and 9 (commits ad173e9, 6dc425f); `src-tauri/src/blame.rs`, `src-tauri/src/agent_lines.rs`, `src/utils/blame.ts`, `src/utils/agentLines.ts`, `src/panels/Editor/blameGutter.ts`"
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

- **The checkpoints already hold the answer.** Each turn checkpoint is a full tree, so the difference between two consecutive trees *is* what happened in that interval. Attribution replays `git diff -U0` over a per-line vector, stamping each hunk's new lines with the turn that introduced them. No per-line ledger and no new write on the hot path.
- **The intervals have to tile, and that is the whole correctness story.** A turn that wrote the file through a `Bash` heredoc records no path, so it is not in the plan, but it still moved the lines. The plan therefore carries **unnamed gap steps** between named turns plus a tail step to the live tree.
- **The reverse index is `{turns: [ts], files: {path: [index]}}`, append-only.** Per-turn records answer "what did turn N write"; a line asks the opposite, and answering it from those records is 200 file reads to find 3. The verify is proven by deleting every per-turn record and asking again.
- **A turn that named no file is still registered**, so "turn 12" is the session's own numbering rather than a count of the turns that happened to write something.
- **Sessions come from the caller, not from the refs**, because a bare repo's worktrees share one ref store and `refs/tori/checkpoint/*` lists sessions whose trees describe a different set of files.
- The cache is dropped in `flushAgentWrites` **before** the "does this path have a buffer" test, so a file cached while open, closed, then rewritten does not come back stale.
- The walk is capped at **40 turns, newest kept**, and what the cap costs is stated: a dropped turn's lines read as written by nobody, never as written by the wrong turn.

## Why it's this way

**The resolution is a turn, not a keystroke, and the test says so out loud.** A checkpoint is taken per prompt, so an edit the user makes *between* two turns is credited to the turn whose interval it fell in. The one interval that is genuinely separable is the tail, after the last recorded turn, and it is attributed to nobody rather than to the most recent agent.

**Both layers need `startSide = 1` on their gutter markers**, and the same test caught it for each. See [[gotcha_a_cm6_gutter_marker_needs_startside_1_or_the_line_you_just_typed_inherits_its_neighbours_blame]]. That is the one case where provenance *lies* rather than merely goes missing.

**The toggle is a localStorage preference, not a settings field**, for the same reason `sideBySide` is: it is something you switch on while reading one file, and routing it through the Rust settings shape and the Settings window would be ceremony for a per-reading choice. The extension lives in a `Compartment` so switching off takes the field, the gutter and the widget together rather than leaving an empty column.

## Related

- [[component_turn_checkpoints]] - the trees this replays over, and the touched-index that makes the lookup cheap.
- [[concept_evidence_tiered_attribution]] - the same discipline about stating what is measured versus inferred, one layer up.
- [[component_cm6_editor]] - the buffer both marker sets decorate.
- [[gotcha_a_cm6_gutter_marker_needs_startside_1_or_the_line_you_just_typed_inherits_its_neighbours_blame]] - the mapping default that silently misattributes.
- [[gotcha_git_blame_porcelain_emits_a_commits_metadata_only_the_first_time_it_appears]] - the parse trap underneath the committed layer.
