// CodeMirror resolves a gutter click by the target's height and jsdom gives
// every element a zero rect, so in here every gutter click lands on line 1.
// Only the two wiring tests at the bottom, whose hunk is on line 1, use one.
import { describe, it, expect, afterEach } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  diffGutterExtension,
  diffLineNumbers,
  setDiffMarkers,
  toggleDiffPeek,
  PEEKABLE_CLASS,
  type Hunk,
} from "./diffGutter";

const DOC = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

/** Lines 11 and 12 replaced what used to be lines 10 and 11. */
const MODIFIED: Hunk = { kind: "modified", start: 11, count: 2, old_start: 10, removed: ["was ten", "was eleven"] };
const THREE: Hunk = {
  kind: "modified",
  start: 5,
  count: 3,
  old_start: 5,
  removed: ["old five", "old six", "old seven"],
};
const ADDED: Hunk = { kind: "added", start: 20, count: 2, old_start: 0, removed: [] };
const DELETED: Hunk = { kind: "deleted", start: 30, count: 0, old_start: 31, removed: ["gone"] };
const AT_TOP: Hunk = { kind: "modified", start: 1, count: 1, old_start: 1, removed: ["was one"] };

let view: EditorView | undefined;
let host: HTMLElement | undefined;

function mount(hunks: Hunk[]): EditorView {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: DOC, extensions: [diffLineNumbers(), diffGutterExtension()] }),
  });
  setDiffMarkers(view, hunks);
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = host = undefined;
});

const toggle = (line: number) => toggleDiffPeek(view!, view!.state.doc.line(line).from);
const marks = () => [...host!.querySelectorAll<HTMLElement>(".cm-diff-gutter .cm-gutterElement")];
const peek = () => host!.querySelector<HTMLElement>(".cm-peek");
const peekTitle = () => peek()?.querySelector(".cm-peek-title")?.textContent;
const peekLines = () => [...peek()!.querySelectorAll(".cm-peek-source .cm-line")].map((l) => l.textContent);
// Dropping the first: CodeMirror's line-number gutter leads with a hidden
// spacer element holding the widest number it expects to draw.
const peekNumbers = () =>
  [...peek()!.querySelectorAll(".cm-peek-source .cm-lineNumbers .cm-gutterElement")].slice(1).map((n) => n.textContent);

// Read off the DOM rather than the decoration set, because where the widget
// lands on screen is the claim.
function sitsAbove(text: string): boolean {
  const kids = [...view!.contentDOM.children];
  const line = kids.findIndex((c) => c.classList.contains("cm-line") && c.textContent === text);
  return line > 0 && kids[line - 1].contains(peek());
}

describe("what the peek shows", () => {
  it("shows the removed lines, numbered from the file they came from", () => {
    mount([MODIFIED]);
    toggle(11);

    expect(peekTitle()).toBe("2 removed lines");
    expect(peekLines()).toEqual(["was ten", "was eleven"]);
    // The whole reason old_start is carried over from git: these lines are not
    // at 1 and 2 of anything, and a peek you cannot cite is one you cannot act
    // on.
    expect(peekNumbers()).toEqual(["10", "11"]);
  });

  it("offers one on a pure deletion, where the stripe is all there is to see", () => {
    mount([DELETED]);
    expect(marks()[0].className).toContain(PEEKABLE_CLASS);

    expect(toggle(30)).toBe(true);
    expect(peekTitle()).toBe("1 removed line");
    expect(peekLines()).toEqual(["gone"]);
  });

  it("does not offer one on an addition, which removed nothing", () => {
    mount([ADDED]);
    expect(marks()[0].className).not.toContain(PEEKABLE_CLASS);

    // False, not a silent no-op: the caller needs to know the click is still
    // theirs, or an unmarked line number would stop behaving like one.
    expect(toggle(20)).toBe(false);
    expect(peek()).toBeNull();
  });

  it("leaves an unmarked line alone", () => {
    mount([MODIFIED]);
    expect(toggle(30)).toBe(false);
    expect(peek()).toBeNull();
  });
});

describe("where the peek sits", () => {
  it("anchors above the hunk's first line however far down it you clicked", () => {
    mount([THREE]);
    toggle(7);

    // Clicked at the bottom of the hunk, drawn at the top of it: the removed
    // lines belong where their replacement starts, not where the pointer was.
    expect(sitsAbove("line 5")).toBe(true);
  });

  it("follows an edit above it instead of staying on a line number", () => {
    const v = mount([THREE]);
    toggle(5);
    v.dispatch({ changes: { from: 0, insert: "x\n".repeat(10) } });

    expect(sitsAbove("line 5")).toBe(true);
  });
});

describe("closing the peek", () => {
  it("toggles shut from any line of the same hunk", () => {
    mount([MODIFIED]);
    toggle(11);
    toggle(12);

    // One gesture opens and closes it, so any of a hunk's lines has to be able
    // to undo what any other did.
    expect(peek()).toBeNull();
  });

  it("shows one at a time", () => {
    mount([THREE, MODIFIED]);
    toggle(5);
    toggle(11);

    expect(host!.querySelectorAll(".cm-peek")).toHaveLength(1);
    expect(peekTitle()).toBe("2 removed lines");
  });

  it("closes on Esc from the editor itself", () => {
    const v = mount([MODIFIED]);
    toggle(11);
    v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(peek()).toBeNull();
  });

  it("closes on Esc from inside the widget, ahead of any handler on the editor", () => {
    mount([MODIFIED]);
    toggle(11);
    const source = peek()!.querySelector(".cm-peek-source")!;
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    source.dispatchEvent(event);

    // Stopped here rather than merely handled: with vim on, the outer editor is
    // an ancestor of this element and would take Esc for leaving insert mode.
    expect(event.defaultPrevented).toBe(true);
    expect(peek()).toBeNull();
  });

  it("closes on the close button", () => {
    mount([MODIFIED]);
    toggle(11);
    peek()!.querySelector<HTMLButtonElement>(".cm-peek-close")!.click();

    expect(peek()).toBeNull();
  });

  it("closes when a fresh diff replaces the markers", () => {
    const v = mount([MODIFIED]);
    toggle(11);
    setDiffMarkers(v, [MODIFIED]);

    // A save re-reads the hunks, and the marker this was opened from is gone.
    // Leaving the panel up would describe the file as it no longer is.
    expect(peek()).toBeNull();
  });
});

describe("what a click reaches", () => {
  it("opens from the stripe", () => {
    mount([AT_TOP]);
    marks()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(peekLines()).toEqual(["was one"]);
  });

  it("opens from the line number too, since the stripe is 3px wide", () => {
    mount([AT_TOP]);
    const number = host!.querySelector<HTMLElement>(".cm-lineNumbers .cm-gutterElement")!;
    number.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(peekLines()).toEqual(["was one"]);
  });
});
