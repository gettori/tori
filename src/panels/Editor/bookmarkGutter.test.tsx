// The half of a bookmark that only an EditorState can answer: whether a mark
// still points at the line it was put on after the file has been edited above
// it.
//
// `bookmarks.ts` owns the store and is tested on its own. What is here is the
// mapping and the reporting, plus the one DOM fact jsdom can check: that the
// gutter draws a marker on the marked line and that clicking it toggles.
import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  bookmarkGutter,
  bookmarkEffect,
  bookmarksIn,
  setBookmarkMarkers,
  BOOKMARK_GUTTER_CLASS,
  BOOKMARK_MARKER_CLASS,
  BOOKMARK_HINT_CLASS,
} from "./bookmarkGutter";
import type { Bookmark } from "../../utils/bookmarks";

const DOC = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

let view: EditorView | undefined;
let host: HTMLElement | undefined;
let toggled: number[] = [];
let moved: { marks: Bookmark[]; docLines: number }[] = [];

function mount(marks: Bookmark[] = [], doc = DOC): EditorView {
  toggled = [];
  moved = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        bookmarkGutter({
          onToggle: (line) => toggled.push(line),
          onMoved: (marks, docLines) => moved.push({ marks, docLines }),
        }),
      ],
    }),
  });
  if (marks.length) setBookmarkMarkers(view, marks);
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
  [...host!.querySelectorAll(`.${BOOKMARK_GUTTER_CLASS} .${BOOKMARK_MARKER_CLASS}`)];

describe("where a mark points after an edit", () => {
  it("follows the line down when text is inserted above it", () => {
    // The whole reason positions are held in a RangeSet rather than as the line
    // numbers that were stored: without this, adding a line at the top leaves
    // every mark below sitting one line above the code it was put on.
    mount([{ line: 10, label: "here" }]);
    view!.dispatch({ changes: { from: 0, insert: "new\n" } });
    expect(bookmarksIn(view!.state)).toEqual([{ line: 11, label: "here" }]);
  });

  it("stays put when the edit is below it", () => {
    mount([{ line: 10 }]);
    view!.dispatch({ changes: { from: view!.state.doc.line(20).from, insert: "new\n" } });
    expect(bookmarksIn(view!.state)).toEqual([{ line: 10 }]);
  });

  it("reports the move so the store can follow", () => {
    mount([{ line: 10 }]);
    view!.dispatch({ changes: { from: 0, insert: "a\nb\n" } });
    expect(moved).toEqual([{ marks: [{ line: 12 }], docLines: 42 }]);
  });

  it("says how long the buffer is, so the pane can tell a loss from a shrink", () => {
    // What this reports is everything the *buffer* knows about, which is not the
    // same claim as everything there is: a file can be shorter than it was when
    // a mark was made, and the pane has to keep what this cannot describe.
    mount([{ line: 2 }], "a\nb\nc\nd\ne");
    view!.dispatch({ changes: { from: 0, insert: "x\n" } });
    expect(moved).toEqual([{ marks: [{ line: 3 }], docLines: 6 }]);
  });

  it("says nothing at all when every mark is already past the end", () => {
    // The buffer has nothing to report, so it must not report an empty list:
    // that would read as "the reader removed them" rather than "this file is
    // currently too short to hold them".
    mount([{ line: 40 }], "a\nb\nc");
    view!.dispatch({ changes: { from: 0, insert: "x\n" } });
    expect(moved).toEqual([]);
  });

  it("says nothing on an edit that moved no mark", () => {
    // The pane writes what it is told into a persisted store, so a report per
    // keystroke would be a write per keystroke.
    mount([{ line: 10 }]);
    view!.dispatch({ changes: { from: view!.state.doc.line(30).from, insert: "x" } });
    expect(moved).toEqual([]);
  });

  it("collapses two marks squeezed onto one line", () => {
    mount([{ line: 10, label: "first" }, { line: 11 }]);
    const from = view!.state.doc.line(10).from;
    view!.dispatch({ changes: { from, to: view!.state.doc.line(11).from, insert: "" } });
    expect(bookmarksIn(view!.state)).toEqual([{ line: 10, label: "first" }]);
  });

  it("drops a mark past the end of a file that shrank under it", () => {
    // A revert or a checkout, not an edit. Dropped rather than clamped to the
    // last line, which would silently move it somewhere nobody chose.
    mount();
    view!.dispatch({ effects: bookmarkEffect(view!.state, [{ line: 10 }, { line: 400 }]) });
    expect(bookmarksIn(view!.state)).toEqual([{ line: 10 }]);
  });
});

describe("the gutter itself", () => {
  it("draws one marker per marked line and none anywhere else", () => {
    mount([{ line: 3 }, { line: 8 }]);
    expect(markers()).toHaveLength(2);
  });

  it("carries the label as the marker's tooltip", () => {
    mount([{ line: 3, label: "the retry" }]);
    expect(markers()[0].querySelector("span")?.title).toBe("the retry");
  });

  it("holds the column open with a spacer that is not itself a mark", () => {
    // The column has to have a width before anything is in it, or marking the
    // first line in a file shoves the whole document sideways. CodeMirror
    // renders the spacer as a real (hidden) element, so it must not carry the
    // marker class or the empty gutter would read as one mark.
    mount();
    expect(host!.querySelector(`.${BOOKMARK_GUTTER_CLASS}`)).toBeTruthy();
    expect(markers()).toHaveLength(0);
  });

  it("puts a hint on every unmarked line, so the column can be found at all", () => {
    // The gutter's only affordance. Without an element per line there is
    // nothing to hover, and an empty strip beside the line numbers is invisible
    // until someone already knows to click it.
    mount([{ line: 3 }], "a\nb\nc\nd");
    const hints = host!.querySelectorAll(`.${BOOKMARK_GUTTER_CLASS} .${BOOKMARK_HINT_CLASS}`);
    expect(hints).toHaveLength(3);
    // And never on a line that already has a mark, which would draw two dots.
    expect(markers()).toHaveLength(1);
  });

  it("reports a line when the column is clicked", () => {
    // *Which* line needs layout, which jsdom has none of: every coordinate maps
    // to line 1 here. What this can say is that the click is wired at all, and
    // that it is the same gesture whether or not the line is already marked -
    // there is nowhere else to click to remove one, so it has to be a toggle.
    mount();
    host!
      .querySelector(`.${BOOKMARK_GUTTER_CLASS}`)!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(toggled).toHaveLength(1);

    mount([{ line: 1 }]);
    markers()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(toggled).toEqual([1]);
  });
});
