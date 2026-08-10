// The half of a breakpoint that only an EditorState can answer: whether it
// still points at the line it was set on after the file has been edited above
// it, and what the column draws for each of the three states.
//
// `breakpoints.ts` owns the store and `debugBreakpoints.ts` owns the wire; both
// are tested on their own. Nothing here knows a debug session exists.
import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  breakpointGutter,
  breakpointEffect,
  breakpointsIn,
  setBreakpointMarkers,
  BREAKPOINT_GUTTER_CLASS,
  BREAKPOINT_MARKER_CLASS,
  BREAKPOINT_BOUND_CLASS,
  BREAKPOINT_PENDING_CLASS,
  BREAKPOINT_HINT_CLASS,
} from "./breakpointGutter";
import type { BreakpointMark } from "../../utils/debugBreakpoints";

const DOC = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

let view: EditorView | undefined;
let host: HTMLElement | undefined;
let toggled: number[] = [];
let moved: { lines: number[]; docLines: number }[] = [];

const armed = (...lines: number[]): BreakpointMark[] =>
  lines.map((line) => ({ line, state: "armed" as const }));

function mount(marks: BreakpointMark[] = [], doc = DOC): EditorView {
  toggled = [];
  moved = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        breakpointGutter({
          onToggle: (line) => toggled.push(line),
          onMoved: (lines, docLines) => moved.push({ lines, docLines }),
        }),
      ],
    }),
  });
  if (marks.length) setBreakpointMarkers(view, marks);
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = host = undefined;
});

/** The drawn markers. CodeMirror gives a gutter an element only for the lines
 *  that have one, so this is the whole of what the column shows. */
const markers = () =>
  [...host!.querySelectorAll(`.${BREAKPOINT_GUTTER_CLASS} .${BREAKPOINT_MARKER_CLASS}`)];

describe("staying on the line it was set on", () => {
  it("follows ten lines inserted above it", () => {
    const v = mount(armed(20));
    v.dispatch({ changes: { from: 0, insert: "x\n".repeat(10) } });

    // The whole reason positions are held in a RangeSet: stored line numbers do
    // not move under an edit, and a breakpoint ten lines above the code it was
    // set on stops in the wrong place with nothing to say it moved.
    expect(breakpointsIn(v.state)).toEqual([30]);
    expect(moved[moved.length - 1]).toEqual({ lines: [30], docLines: 50 });
  });

  it("says nothing when an edit below it changes no line", () => {
    const v = mount(armed(3));
    v.dispatch({ changes: { from: v.state.doc.line(30).from, insert: "y\n" } });

    // The pane writes what it is told straight into a persisted store, so a
    // report per keystroke would be a write per keystroke.
    expect(moved).toEqual([]);
  });

  it("merges two squeezed onto one line", () => {
    const v = mount(armed(10, 11));
    const from = v.state.doc.line(10).from;
    v.dispatch({ changes: { from, to: v.state.doc.line(11).to, insert: "one" } });

    // The adapter cannot stop twice on a line, so what is left is one
    // breakpoint rather than a duplicate that would go out in `setBreakpoints`.
    expect(breakpointsIn(v.state)).toEqual([10]);
  });

  it("lets an effect in the same transaction as an edit win", () => {
    const v = mount(armed(3));
    // Appended at the end, so every position the effect names is the same in
    // both documents and the only question left is which of the two directions
    // the field takes.
    v.dispatch({
      changes: { from: v.state.doc.length, insert: "\ntail" },
      effects: breakpointEffect(v.state, armed(5)),
    });

    // Mapping first and replacing second is what makes the pane's answer the
    // last word; the other order would map a set that was about to be thrown
    // away and then keep the stale one.
    expect(breakpointsIn(v.state)).toEqual([5]);
  });

  it("drops one past the end of a file that shrank under it", () => {
    const v = mount(armed(30), "one\ntwo\nthree");

    // A revert or a checkout can leave a stored line the file no longer has.
    // Dropped rather than clamped to the last line, which would silently move it
    // somewhere nobody chose.
    expect(breakpointsIn(v.state)).toEqual([]);
  });
});

describe("what the column shows", () => {
  it("draws one marker per breakpoint and a hint everywhere else", () => {
    mount(armed(2));
    expect(markers()).toHaveLength(1);
    // An empty column is a target nobody can see, and this feature has no other
    // affordance.
    expect(host!.querySelectorAll(`.${BREAKPOINT_HINT_CLASS}`).length).toBeGreaterThan(1);
  });

  it("tells the three states apart", () => {
    mount([
      { line: 2, state: "armed" },
      { line: 4, state: "bound" },
      { line: 6, state: "pending" },
    ]);
    const drawn = markers();

    // Armed is the normal state of a good breakpoint, not a warning: js-debug
    // answers `verified: false` during the handshake for breakpoints that then
    // bind and stop. So only bound and pending carry a class of their own.
    expect(drawn[0].className).not.toContain(BREAKPOINT_BOUND_CLASS);
    expect(drawn[0].className).not.toContain(BREAKPOINT_PENDING_CLASS);
    expect(drawn[1].className).toContain(BREAKPOINT_BOUND_CLASS);
    expect(drawn[2].className).toContain(BREAKPOINT_PENDING_CLASS);
    // Filled once it has bound, hollow until then, so the difference is legible
    // without colour.
    expect(drawn[1].textContent).toBe("●");
    expect(drawn[0].textContent).toBe("○");
    expect(drawn[2].textContent).toBe("○");
    expect((drawn[2].firstChild as HTMLElement).title).toContain("save");
  });

  it("toggles on a click in the column", () => {
    const v = mount(armed(1));
    const marker = markers()[0] as HTMLElement;
    marker.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    // One gesture, so it has to be able to undo itself: there is nowhere else to
    // click to remove one.
    expect(toggled).toEqual([1]);
    expect(v.state.selection.main.head).toBe(0);
  });
});
