import { describe, it, expect } from "vitest";
import type { EditorView } from "@codemirror/view";
import { cmdClickDefinition } from "./lspCommands";

// Cmd-click has to stay out of the way of everything else a mouse does in an
// editor: a plain click, CodeMirror's own Cmd-Alt multiple-cursor gesture, a
// click on empty space below the last line, and a file with no language server
// at all. Each of those going wrong reads as "the editor stopped responding to
// clicks", which is a far worse bug than a missing jump.

function fakeView(over: { posAtCoords?: number | null } = {}) {
  const dispatched: number[] = [];
  const view = {
    posAtCoords: () => (over.posAtCoords === undefined ? 42 : over.posAtCoords),
    dispatch: (spec: { selection?: { anchor: number } }) => {
      if (spec.selection) dispatched.push(spec.selection.anchor);
    },
  };
  return { view: view as unknown as EditorView, dispatched };
}

function mouse(over: Partial<MouseEvent> = {}): MouseEvent {
  let prevented = false;
  return {
    metaKey: true,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    button: 0,
    clientX: 10,
    clientY: 20,
    preventDefault: () => (prevented = true),
    get defaultPrevented() {
      return prevented;
    },
    ...over,
  } as unknown as MouseEvent;
}

describe("cmd-click to definition", () => {
  it("moves the caret and jumps", () => {
    const { view, dispatched } = fakeView();
    const event = mouse();

    expect(cmdClickDefinition(event, view, () => true)).toBe(true);
    // The LSP command reads the selection, not the mouse, so the caret has to
    // move first or it answers about wherever the caret happened to be.
    expect(dispatched).toEqual([42]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a plain click alone", () => {
    const { view, dispatched } = fakeView();
    let jumped = false;
    expect(cmdClickDefinition(mouse({ metaKey: false }), view, () => (jumped = true))).toBe(false);
    expect(jumped).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("leaves CodeMirror's own modifier gestures alone", () => {
    const { view } = fakeView();
    for (const over of [{ altKey: true }, { shiftKey: true }, { ctrlKey: true }, { button: 1 }]) {
      expect(cmdClickDefinition(mouse(over), view, () => true)).toBe(false);
    }
  });

  it("does nothing where there is no position to ask about", () => {
    // Below the last line, or outside the content entirely.
    const { view, dispatched } = fakeView({ posAtCoords: null });
    expect(cmdClickDefinition(mouse(), view, () => true)).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("stays an ordinary click when the file has no server", () => {
    // `jumpToDefinition` returns false with no LSP plugin in the editor, and
    // swallowing the event then would leave a dead click in every plain file.
    const { view } = fakeView();
    const event = mouse();
    expect(cmdClickDefinition(event, view, () => false)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
