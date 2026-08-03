// Expand, shrink, join and split: the selection commands CM6 does not ship
// whole.
//
// `selectParentSyntax` grows a selection to its enclosing syntax node and is
// already bound at `Mod-i`, but there is no way back down. CM6 keeps no record
// of what the selection was before it grew, so expand without shrink is a
// one-way trip: three presses past the node you wanted and the only way back is
// to re-select by hand. The record is what this module adds; the growing itself
// is still `selectParentSyntax`'s, captured rather than reimplemented so the two
// can never disagree about what a parent is.
//
// Every command here is a `StateCommand`, so all of it is testable without a
// view. The pane only supplies `view.state` and `view.dispatch`.

import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeSpec,
  type SelectionRange,
  type StateCommand,
} from "@codemirror/state";
import { selectParentSyntax } from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";

/** The selection an expansion left behind, pushed by that expansion. */
const pushSelection = StateEffect.define<EditorSelection>();
/** A shrink consuming the top of the stack. */
const popSelection = StateEffect.define<null>();

/**
 * The selections an expansion chain passed on the way up, oldest first.
 *
 * Unbounded on purpose: the stack can only grow as deep as the syntax tree at
 * the cursor, and any selection the user makes themselves empties it.
 */
export const selectionHistory = StateField.define<readonly EditorSelection[]>({
  create: () => [],
  update(stack, tr) {
    // Positions first. An edit under a stashed selection has to move it exactly
    // as it moves the live one, or a shrink after a delete would restore an
    // offset that no longer exists: a jump at best, a RangeError at worst.
    const mapped = tr.docChanged ? stack.map((sel) => sel.map(tr.changes)) : stack;
    for (const e of tr.effects) {
      if (e.is(pushSelection)) return [...mapped, e.value.map(tr.changes)];
      if (e.is(popSelection)) return mapped.slice(0, -1);
    }
    // A selection the user set some other way (a click, an arrow key, a search
    // hit) ends the chain: shrinking back into a region they have already left
    // is not undoing an expansion, it is a jump. An edit is not that, which is
    // why this reads the selection and not the changes.
    if (tr.selection && !tr.docChanged) return [];
    return mapped;
  },
});

/** Grow the selection to its enclosing syntax node, remembering where it was. */
export const expandSelection: StateCommand = ({ state, dispatch }) => {
  const before = state.selection;
  let grown: EditorSelection | undefined;
  // `selectParentSyntax` returns false and dispatches nothing when there is no
  // enclosing node left, so an unset `grown` is also its refusal.
  selectParentSyntax({
    state,
    dispatch: (tr) => {
      grown = tr.selection;
    },
  });
  if (!grown) return false;
  dispatch(
    state.update({
      selection: grown,
      effects: pushSelection.of(before),
      scrollIntoView: true,
      userEvent: "select",
    }),
  );
  return true;
};

/** Step back down one expansion. Refuses when nothing was expanded. */
export const shrinkSelection: StateCommand = ({ state, dispatch }) => {
  const stack = state.field(selectionHistory, false);
  const back = stack?.[stack.length - 1];
  if (!back) return false;
  dispatch(
    state.update({
      selection: back,
      effects: popSelection.of(null),
      scrollIntoView: true,
      userEvent: "select",
    }),
  );
  return true;
};

/**
 * Join every line a selection spans onto its first line, separated by single
 * spaces. A bare cursor pulls the following line up instead, which is what makes
 * the command worth a chord when nothing is selected.
 */
export const joinLines: StateCommand = ({ state, dispatch }) => {
  const doc = state.doc;
  // Line numbers whose following break closes, as a set: two cursors on one
  // line, or two ranges meeting at one, would otherwise emit overlapping
  // changes, and CM6 throws on those.
  const breaks = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    // A cursor takes the break below it; a real selection takes only the breaks
    // inside itself, so joining lines 3 to 5 does not swallow line 6.
    for (let n = first; n <= (first === last ? first : last - 1); n++) {
      if (n < doc.lines) breaks.add(n);
    }
  }
  if (breaks.size === 0) return false;
  const changes: ChangeSpec[] = [...breaks]
    .sort((a, b) => a - b)
    .map((n) => {
      const line = doc.line(n);
      const next = doc.line(n + 1);
      // The break plus the whitespace hugging it on both sides: a joined line
      // should read as prose, not carry the indentation the break made sense of.
      const tail = line.text.replace(/\s+$/, "").length;
      const head = next.text.length - next.text.replace(/^\s+/, "").length;
      // No space when either side has no content, so joining a blank line does
      // not leave the space behind as the only thing it contributed.
      const glue = tail === 0 || next.text.trim() === "" ? "" : " ";
      return { from: line.from + tail, to: next.from + head, insert: glue };
    });
  dispatch(state.update({ changes, userEvent: "input.join" }));
  return true;
};

/**
 * One cursor at the end of every line the selection covers.
 *
 * Hand-rolled because no CM6 package ships it: `defaultKeymap` has
 * `addCursorAbove`/`addCursorBelow` (one line at a time) and `searchKeymap` has
 * `selectSelectionMatches` (every match of the selected text), and neither is
 * this. Wave 1's multi-cursor enablement was assumed to have brought it along;
 * it could not have.
 */
export const splitSelectionIntoLines: StateCommand = ({ state, dispatch }) => {
  const doc = state.doc;
  const cursors: SelectionRange[] = [];
  for (const range of state.selection.ranges) {
    if (range.empty) {
      cursors.push(range);
      continue;
    }
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to);
    // A selection ending at column 0 has not reached that line's content, so it
    // gets no cursor of its own; dragging down one line is the common way to
    // land there.
    const upto = last.from === range.to && last.number > first ? last.number - 1 : last.number;
    for (let n = first; n <= upto; n++) {
      const line = doc.line(n);
      cursors.push(EditorSelection.cursor(n === last.number ? range.to : line.to));
    }
  }
  const next = EditorSelection.create(cursors, cursors.length - 1);
  if (next.eq(state.selection)) return false;
  dispatch(state.update({ selection: next, scrollIntoView: true, userEvent: "select" }));
  return true;
};

/**
 * The chords, kept with the commands rather than in the pane, because their
 * order relative to `defaultKeymap` is part of what they mean.
 *
 * Spread **before** `defaultKeymap`: it binds `Mod-i` to `selectParentSyntax`
 * directly, and CM6 stops at the first binding that handles a key, so this one
 * replaces that one instead of running alongside it. The app's command table
 * carries none of these (see the Editor group in `utils/commands.ts`); a
 * table-level binding is dispatched even while a terminal has focus.
 */
export const selectionKeymap: readonly KeyBinding[] = [
  { key: "Mod-i", run: expandSelection, preventDefault: true },
  { key: "Mod-Shift-i", run: shrinkSelection, preventDefault: true },
  // Not `Mod-j`: that is the app's "focus the terminal", which wins the key
  // before the editor ever sees it.
  { key: "Mod-Shift-j", run: joinLines, preventDefault: true },
  // `Mod-Alt-l` rather than VS Code's `Alt-Shift-i`, because a bare Option
  // chord cannot work here. macOS rewrites `event.key` to the Option glyph
  // (Opt+I -> "ˆ"), and CM6 falls back to the physical key for exactly this
  // reason - except on macOS with Alt held and neither Ctrl nor Meta, where it
  // deliberately does not, since those combinations are usually typed
  // characters. Holding Meta as well puts the chord back inside the fallback.
  // The command table hit the same wall and answered it the same way (`cmdOpt`
  // matching on `e.code`).
  { key: "Mod-Alt-l", run: splitSelectionIntoLines, preventDefault: true },
];
