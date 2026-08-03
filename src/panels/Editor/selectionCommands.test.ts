// The selection commands, exercised as state transforms.
//
// Every one of them is a `StateCommand`, so none of this needs a view: a real
// language pack gives `selectParentSyntax` a syntax tree to climb, and a
// capturing dispatch stands in for the pane.
import { describe, it, expect } from "vitest";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { defaultKeymap, selectParentSyntax } from "@codemirror/commands";
import { COMMANDS } from "../../utils/commands";
import {
  selectionHistory,
  selectionKeymap,
  expandSelection,
  shrinkSelection,
  joinLines,
  splitSelectionIntoLines,
} from "./selectionCommands";

const CODE = `function outer() {
  if (ready) {
    doThing(value)
  }
}`;

/** Inside the argument, so there are several nodes to climb through. */
const IN_VALUE = CODE.indexOf("value") + 2;

type At = number | { anchor: number; head: number };

/** The facet the pane installs beside these commands: without it CM6 folds
 *  every selection back to its main range, so a split would produce one cursor
 *  and pass anyway. */
const MULTIPLE = EditorState.allowMultipleSelections.of(true);

function stateFor(doc: string, at: At = 0, withHistory = true): EditorState {
  return EditorState.create({
    doc,
    selection: typeof at === "number" ? { anchor: at } : at,
    extensions: [javascript(), MULTIPLE, ...(withHistory ? [selectionHistory] : [])],
  });
}

function run(cmd: StateCommand, state: EditorState): { ok: boolean; state: EditorState } {
  let next = state;
  const ok = cmd({
    state,
    dispatch: (tr) => {
      next = tr.state;
    },
  });
  return { ok, state: next };
}

const main = (s: EditorState) => s.selection.main;
const span = (s: EditorState) => [main(s).from, main(s).to];

describe("expanding and shrinking a selection", () => {
  it("climbs to the enclosing node, and comes back down the same way", () => {
    let state = stateFor(CODE, IN_VALUE);
    const climbed = [span(state)];
    for (let i = 0; i < 3; i++) {
      const step = run(expandSelection, state);
      expect(step.ok, `expand ${i + 1}`).toBe(true);
      state = step.state;
      climbed.push(span(state));
    }
    // Each step actually grew, so the round trip below is testing something.
    expect(climbed[3][1] - climbed[3][0]).toBeGreaterThan(climbed[1][1] - climbed[1][0]);

    for (let i = 3; i > 0; i--) {
      const step = run(shrinkSelection, state);
      expect(step.ok, `shrink ${i}`).toBe(true);
      state = step.state;
      expect(span(state), `back to step ${i - 1}`).toEqual(climbed[i - 1]);
    }
  });

  it("refuses to shrink when nothing was expanded", () => {
    expect(run(shrinkSelection, stateFor(CODE, IN_VALUE)).ok).toBe(false);
  });

  it("refuses to shrink in a buffer that never installed the field", () => {
    const state = stateFor(CODE, IN_VALUE, false);
    expect(run(shrinkSelection, state).ok).toBe(false);
  });

  it("drops the chain when the user selects something else", () => {
    const expanded = run(expandSelection, stateFor(CODE, IN_VALUE)).state;
    // A click, an arrow key, a search hit: a selection that did not come from
    // this module at all.
    const clicked = expanded.update({ selection: { anchor: 0 } }).state;
    expect(run(shrinkSelection, clicked).ok).toBe(false);
  });

  it("survives an edit made between the expand and the shrink", () => {
    let state = stateFor(CODE, IN_VALUE);
    state = run(expandSelection, state).state;
    const afterFirst = span(state);
    state = run(expandSelection, state).state;

    // A large block disappears from above the selection, moving every offset
    // the stack is holding.
    const head = CODE.indexOf("  if");
    const edited = state.update({ changes: { from: 0, to: head, insert: "" } });
    state = edited.state;

    const shrunk = run(shrinkSelection, state);
    expect(shrunk.ok).toBe(true);
    state = shrunk.state;
    expect(main(state).to).toBeLessThanOrEqual(state.doc.length);
    expect(span(state)).toEqual(afterFirst.map((p) => p - head));
  });
});

describe("joining lines", () => {
  const joined = (doc: string, at: At) => run(joinLines, stateFor(doc, at)).state.sliceDoc();

  it("collapses a multi-line selection onto one line, single-spaced", () => {
    expect(joined("one\n  two\n   three\nfour", { anchor: 0, head: 17 })).toBe("one two three\nfour");
  });

  it("pulls the next line up when nothing is selected", () => {
    expect(joined("one\n  two\nthree", 1)).toBe("one two\nthree");
  });

  it("keeps no space where a side has no content", () => {
    expect(joined("one\n\ntwo", 1)).toBe("one\ntwo");
    expect(joined("\n  two", 0)).toBe("two");
  });

  it("eats the whitespace hugging the break, not just the break", () => {
    expect(joined("one   \n      two", 1)).toBe("one two");
  });

  it("refuses on the last line, where there is no break to close", () => {
    const state = stateFor("one\ntwo", 5);
    expect(run(joinLines, state).ok).toBe(false);
  });

  it("joins once when two cursors sit on the same line", () => {
    const state = EditorState.create({
      doc: "one\ntwo\nthree",
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]),
      extensions: [MULTIPLE, selectionHistory],
    });
    expect(run(joinLines, state).state.sliceDoc()).toBe("one two\nthree");
  });
});

// Order, not key events: CM6 reads `Mod` as Meta only when it believes it is on
// a Mac, and under jsdom it does not, so a simulated Cmd+I would resolve to a
// chord nothing is bound to. What actually decides the outcome is which binding
// the keymap reaches first, and that is a property of this array.
describe("the chords", () => {
  it("shadows defaultKeymap's own Mod-i rather than running beside it", () => {
    const stock = defaultKeymap.filter((b) => b.key === "Mod-i");
    // If upstream ever drops this, the shadowing stops being load-bearing and
    // this file should say so out loud rather than keep asserting nothing.
    expect(stock.map((b) => b.run)).toEqual([selectParentSyntax]);

    const asInstalled = [...selectionKeymap, ...defaultKeymap];
    expect(asInstalled.find((b) => b.key === "Mod-i")?.run).toBe(expandSelection);
  });

  it("takes no chord the command table already owns", () => {
    // A table chord is dispatched from the window, before the editor is asked,
    // so a collision is not a race the editor can win: `Mod-j` would simply
    // focus the terminal. Derived from the table rather than spot-checked, so a
    // chord added on either side is caught from whichever side moved.
    const GLYPHS: Record<string, string> = { "⌘": "Mod", "⌥": "Alt", "⇧": "Shift", "⌃": "Ctrl" };
    const taken = new Set(
      COMMANDS.filter((c) => c.keys).map((c) =>
        c
          .keys!.map((k) => GLYPHS[k] ?? k)
          .join("-")
          .toLowerCase(),
      ),
    );
    // The mapping produces real chord names, so an empty `taken` cannot make
    // the loop below pass by matching nothing.
    expect(taken).toContain("mod-j");
    for (const b of selectionKeymap) {
      // Same modifier order both sides (Mod, Alt, Shift, then the key), which is
      // the order the table writes its glyphs in.
      expect(taken, `${b.key} is already a table chord`).not.toContain(b.key?.toLowerCase());
    }
  });
});

describe("splitting a selection into lines", () => {
  const doc = "aa\nbbb\ncccc";

  it("leaves one cursor at the end of every line it covers", () => {
    const out = run(splitSelectionIntoLines, stateFor(doc, { anchor: 0, head: doc.length }));
    expect(out.ok).toBe(true);
    expect(out.state.selection.ranges.map((r) => r.head)).toEqual([2, 6, 11]);
    expect(out.state.selection.ranges.every((r) => r.empty)).toBe(true);
  });

  it("ignores a line the selection only reaches the start of", () => {
    const out = run(splitSelectionIntoLines, stateFor(doc, { anchor: 0, head: 3 }));
    expect(out.state.selection.ranges.map((r) => r.head)).toEqual([2]);
  });

  it("refuses when there is no selection to split", () => {
    expect(run(splitSelectionIntoLines, stateFor(doc, 1)).ok).toBe(false);
  });
});
