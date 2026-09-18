---
summary: staging a hunk rebuilds the patch with rewritten offsets, a content fingerprint refuses to apply if the diff has moved
status: current
updated: 2026-08-02
source: "Editor upgrades: diff polish, hunk staging, diagnostics (personal/tori, phase 2); commit 01f0196; `src-tauri/src/patch.rs`, `src-tauri/src/git.rs` (`git_apply_hunks`), `src/utils/hunkFingerprint.ts`; extended to discard and line selection by Editor wave 2: git depth (branch `wave-2`), Phases 4 and 14; commits b42b494, 4c9154e"
---

# Hunk-level staging: rebuilt patches, offsets, and content fingerprints

Staging a *subset* of a file's changes means handing `git apply --cached` a patch that never existed on disk: the selected hunks only, with their headers rewritten so the offsets are still internally consistent. Two things about that are easy to get wrong, and both corrupt the index **silently** rather than failing — which is why the mechanism is spelled out here and covered against real `git apply` rather than in isolation.

## How it works

- **Parse, select, rebuild.** `parse_patch` (`src-tauri/src/patch.rs`) splits a single-file unified diff into a preamble (`diff --git`/`index`/`---`/`+++`) and hunks carrying their header, body, and both line spans. `build_patch(patch, selected, reverse)` emits the preamble plus only the selected hunks, rewriting each `@@` header.
- **Offsets: only the produced side moves.** Dropping a hunk shifts every later hunk on the side being *produced*, not the side being read. A running `delta` accumulates `new_count - old_count` across the **selected** hunks only (a dropped hunk is not in the patch, so it shifts nothing). This is what `git add -p` does internally.
- **Direction decides which side is which.** The side the patch is applied *to* keeps its real coordinates; the other is recomputed.
  - **Staging** reads worktree-vs-index and applies forward: source = old side, so the old start stays and the new start shifts.
  - **Unstaging** reads index-vs-HEAD and applies with `--reverse`: source = new side, so the new start stays and the old start shifts, with delta accumulating `old_count - new_count`.
- **The two directions never share a source.** `git_apply_hunks(..., reverse)` picks both the diff mode and the apply direction from one flag, so a caller cannot pair a Changes-section hunk with a reverse apply.
- **Identity is content, not position.** Every hunk carries an FNV-1a fingerprint of its header + body. The UI sends the fingerprint it rendered alongside the index; the backend re-reads the diff and refuses (`"The diff changed, refreshed."`) unless it reproduces. Nothing is applied on mismatch.
- **Index-only, always.** `--cached` means a failed apply can never leave the working tree half-rewritten. `--unidiff-zero` is deliberately **not** passed: it disables the context checks that a zero-context patch cannot satisfy, and the panel always diffs with real context.
- **Untracked files** go through `git add -N` first so a patch has an index entry to apply against. The `--no-index` diff the panel displays and the post-`add -N` diff produce identical hunk headers and bodies (only the preamble differs, which the fingerprint excludes), so the displayed fingerprint still validates.

## The same machinery, one level finer, and one level more destructive (2026-08-02)

Two directions were added on top, and both reuse the parse-select-rebuild core rather than forking it. `checked_patch` re-reads the diff and proves the fingerprints; each caller then builds what it needs from the result.

**Discard** (`git_discard_hunks`) is the one apply path that is **not** `--cached`. `apply_cached` became `git_apply(project_path, patch, cached, reverse)`, and `cached` is the entire safety story: with it the working tree cannot be touched at all, which is why staging needs no confirmation; without it the patch rewrites the file, which only discard does and only after a [[concept_worktree_backstops]] snapshot. It is a **separate command**, not a third `reverse` value, because one bool cannot express it: discard is reverse-direction against the *unstaged* diff, and the bool ties direction to source. It is unstaged-only by construction, and a staged hunk aimed at it is answered with "That change is staged. Unstage it first" rather than the generic staleness message, which would be true but useless.

**Line-level staging** (`build_line_patch`, `git_apply_lines`) selects body-line indices inside one hunk. The rule is the same rule seen from two directions: the side the patch is applied *to* is the source, so every source line survives (as itself if selected, as context if not) and an unselected line that exists only on the produced side is dropped. Staging makes the old side the source, so unselected `-` becomes context and unselected `+` disappears; unstaging swaps them.

- **The hunk is never split into several.** Its source span stays whole, so the context around a selection always abuts it however scattered the selection is, and the unselected changes in between are exactly what holds the two ends together. Emitting one hunk per run of selected lines would have to re-derive context git never sent.
- **A demoted removal keeps its place in the body**, which is the one visible consequence. See [[gotcha_a_demoted_removal_lands_before_the_additions_in_the_same_block]]: staging half of a mixed removal/addition block reorders the staged content, and matching `git add -p` is the only defensible answer because a unified diff does not say which removal each addition replaced.
- **`\ No newline at end of file` markers follow their owner** and are re-validated after the rebuild: a marker must sit directly after the last line of the side it claims. A selection that would strand one is refused with a sentence rather than emitted as a patch git parses and applies wrongly.
- **Row index equals body index.** The panel sends the indices of the rows the user clicked and the backend reads them against the raw body. `buildRows` preserved order all along, but nothing said so until a test did; if pairing ever reordered, the wrong lines would be staged with no error anywhere.

## Why it's this way

Hunk *indices* are only meaningful against the exact diff they were read from. An agent writing to the open file between render and click renumbers them, and so does staging an earlier hunk — so a positional apply would quietly stage the wrong hunk, producing a wrong commit that looks right. Fingerprinting makes that failure loud and inert instead of silent and destructive. It is the same "prove the world hasn't moved before you act" discipline as [[concept_safe_send]]'s probe-at-flush-time.

The dual Rust/TS fingerprint implementation is a real drift risk, taken on because the UI must send a value derived from what it *rendered*. It is contained by locking the same value in both suites, plus a shared parse-then-hash fixture — which caught a genuine mismatch on the first run (see [[gotcha_a_ts_and_rust_hunk_parser_must_agree_about_trailing_newlines]]).

## Related

- [[component_changes_panel]] — the surface that renders hunks and calls `git_apply_hunks`.
- [[lesson_diff_context_is_hunk_granularity]] — why the diff feeding this is taken at git's default context.
- [[concept_safe_send]] — the same revalidate-before-acting discipline on a different boundary.
- [[gotcha_a_ts_and_rust_hunk_parser_must_agree_about_trailing_newlines]] — the drift this design invited, and how it was caught.
- [[concept_worktree_backstops]] - what discard takes before it rewrites a file, and the recovery route its dialog names.
- [[gotcha_a_demoted_removal_lands_before_the_additions_in_the_same_block]] - the ordering consequence a line selection inherits from the diff format.
