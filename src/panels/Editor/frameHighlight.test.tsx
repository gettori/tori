// The paused-line stripe: that it lands on the right line, that it survives an
// edit above it, and that it goes away.
//
// `debugStack.ts` decides which line and is tested on its own. What is here is
// the part only an EditorState can answer.
import { describe, it, expect, afterEach } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { frameHighlight, frameLineEffect, frameLineIn, setFrameLineMarker, FRAME_LINE_CLASS } from "./frameHighlight";

const DOC = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

let view: EditorView | undefined;
let host: HTMLElement | undefined;

function mount(line: number | null = null, doc = DOC): EditorView {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [frameHighlight()] }),
  });
  if (line !== null) setFrameLineMarker(view, line);
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = host = undefined;
});

const stripes = () => [...host!.querySelectorAll(`.${FRAME_LINE_CLASS}`)];

describe("where the program is", () => {
  it("marks the line, and only that line", () => {
    const v = mount(3);
    expect(frameLineIn(v.state)).toBe(3);
    expect(stripes()).toHaveLength(1);
    expect(stripes()[0].textContent).toBe("line 3");
  });

  it("follows ten lines inserted above it", () => {
    const v = mount(20);
    v.dispatch({ changes: { from: 0, insert: "x\n".repeat(10) } });

    // A paused buffer is still editable, and a stripe left on line 20 while the
    // code moved to line 30 would be pointing at whatever landed there.
    expect(frameLineIn(v.state)).toBe(30);
  });

  it("draws nothing for a line the buffer does not have", () => {
    const v = mount(90, "one\ntwo\nthree");

    // A revert or a checkout can leave the frame naming a line the file no
    // longer has. Clamping it to the last line would claim the program is
    // somewhere it is not.
    expect(frameLineIn(v.state)).toBeNull();
    expect(stripes()).toEqual([]);
  });
});

describe("when the pause ends", () => {
  it("clears on null", () => {
    const v = mount(3);
    setFrameLineMarker(v, null);

    expect(frameLineIn(v.state)).toBeNull();
    expect(stripes()).toEqual([]);
  });

  it("moves rather than accumulating", () => {
    const v = mount(3);
    setFrameLineMarker(v, 9);

    // Stepping is a stream of these, and a stripe per step would paint the
    // whole path taken instead of where the program is.
    expect(stripes()).toHaveLength(1);
    expect(frameLineIn(v.state)).toBe(9);
  });

  it("dispatches nothing when the line did not change", () => {
    const v = mount(3);
    const before = v.state;
    setFrameLineMarker(v, 3);

    // Continuing through a breakpoint in a file that is not on screen must not
    // cost every open buffer a transaction.
    expect(v.state).toBe(before);
  });

  it("lets an effect in the same transaction as an edit win", () => {
    const v = mount(3);
    v.dispatch({
      changes: { from: v.state.doc.length, insert: "\ntail" },
      effects: frameLineEffect(5),
    });

    expect(frameLineIn(v.state)).toBe(5);
  });
});
