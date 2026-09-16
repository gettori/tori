---
summary: restoring scroll from a raw pixel breaks across a rebuild since rewrap changes geometry, use scrollSnapshot instead
status: current
updated: 2026-08-20
source: "The reveal path: verify the mismatch switch, then decide what it costs (personal/sway, branch `unified-tab-bar`), Phases 1 to 3, commits 6b0867b, be27425, dab0114, `src/panels/Editor/CodeEditor.tsx`, `src/utils/perfRecipe.ts`"
---

# A pixel offset is not a reading position, and CodeMirror will not pretend it is

## What happened

The editor lost the reader's scroll position whenever its pane was rebuilt. Six
attempts over two phases, five of which failed, and the first failure was that
the check could not fail.

**The check that could not fail.** The recipe put the caret at a position and
then scrolled to that same position. A view rebuilt from its stored selection
lands on the caret, so a restore that kept the reader's place and one that threw
it away produced the same number. Phase 1 recorded the loss as happening "at the
split" and recorded the same-shape control as keeping it; both readings were
artifacts. Separating them (caret at 10% of the document, scroll to 60%, in
different dispatches) showed the offset was lost on **every** view rebuild, not
just at the split, and that the control lost it too.

**Four mechanisms that carried a pixel, all reverted.**

1. Capture the scroller's offset at the adoption seam. The capture runs after
   the pane the host came from is torn down, by which time detaching the element
   has already reset `scrollTop` to 0.
2. Record it from a capture-phase `scroll` listener on the host and restore
   after adoption. The split does not *move* the host, it re-keys it:
   `editorStageId` is per pane, so the id goes `editor-stage:main` to
   `editor-stage:pane-1` and a new host and a new view are built.
3. Carry a CodeMirror `scrollSnapshot()` on the buffer. Taken when the view is
   left, it is taken after the workspace flip has already hidden the view, and a
   hidden view measures nothing. Applied to a fresh view whose line heights are
   still estimates, it landed at the end of the file.
4. Carry the pixel offset, written back in CodeMirror's measure phase with a
   guard so a hidden view's 0 could not overwrite it. The record was poisoned to
   0 anyway, immediately after a correct restore.

**What worked**, in phase 3: `view.scrollSnapshot()` taken *from the scroll
handler while the view is on screen*, stashed on the `Buffer` beside its state,
and dispatched **instead of** the caret `scrollIntoView` rather than after it.

## Why

**A pixel written behind CodeMirror's back is a position it never agreed to.**
Measured, such a write came back exactly one line low on every restore, because
CodeMirror re-anchors on its next measure to the anchor *it* is holding, which
is still the one from before the write. Worse, a snapshot taken right after such
a write names the top of the document, for the same reason: `scrollSnapshot()`
packages `viewState.scrollAnchorPos`, not the DOM's `scrollTop`.

**And both are applied in the same measure cycle**, so dispatching the caret
scroll and then writing the offset is a race the caret wins.

**A pixel is not comparable across geometry either.** A split halves the pane's
width, the document rewraps, and the same content sits at a different offset:
measured on one file, 3137px tall before and 4649 after. The recipe's own check
had to move from the pixel to the first visible line for the same reason phase 1
refused byte-identity of the terminal's visible window.

## What to do next time

- **Ask what makes the check able to fail**, before trusting a green. Two
  independent quantities that happen to be equal in the fixture is the shape to
  look for. Compare [[lesson_a_test_that_passes_against_the_broken_code]].
- **Restore through the library, not around it.** CodeMirror has
  `scrollSnapshot()` for exactly this; every mechanism that reached for
  `scrollTop` failed, including the one that worked in isolation.
- **Record while visible, restore later.** Anything read at the moment a surface
  is left is read from a surface that is already hidden. The seam that has a
  real reading is the event that moved it.
- **On a path whose premise is changing geometry, the criterion cannot be a
  pixel.** Use the document position (a line), and keep the pixel in the record
  so a difference can be classified as a rewrap rather than a loss.

## Related

- [[component_cm6_editor]] - the pane whose view is now moved rather than rebuilt
- [[concept_switch_cost_anatomy]] - the rebuild this was a symptom of
- [[lesson_a_test_that_passes_against_the_broken_code]] - the general form of the first failure
- [[gotcha_a_split_halves_the_pane_so_the_editors_document_rewraps]] - the geometry trap in one line
- [[gotcha_a_kept_editorstate_carries_the_configuration_it_was_built_with]] - the neighbouring trap in kept state
