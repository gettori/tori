import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import OutlinePanel from "./OutlinePanel";
import { publishSymbols, clearSymbols, normalizeDocumentSymbols } from "../../utils/symbols";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";

// The outline reads the shared store rather than talking to a server, so what
// is asserted here is the rendering and the reveal: whether the tree that was
// published is the tree on screen, and whether clicking a row asks for the
// symbol's *name* rather than the top of its body.

const PATH = "/proj/src/thing.ts";

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

const TREE = normalizeDocumentSymbols(
  [
    {
      name: "Thing",
      detail: "class",
      kind: 5,
      range: range(0, 0, 6, 1),
      selectionRange: range(0, 6, 0, 11),
      children: [
        { name: "go", kind: 6, range: range(1, 2, 3, 3), selectionRange: range(1, 2, 1, 4) },
      ],
    },
    { name: "helper", kind: 12, range: range(8, 0, 10, 1), selectionRange: range(8, 9, 8, 15) },
  ],
  PATH,
);

let opened: OpenInEditor[] = [];
let offOpen: (() => void) | undefined;

beforeEach(() => {
  clearSymbols();
  opened = [];
  offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opened.push(d));
});

afterEach(() => {
  offOpen?.();
  clearSymbols();
});

describe("OutlinePanel", () => {
  it("lists the file's symbols, children included", () => {
    publishSymbols(PATH, TREE);
    render(() => <OutlinePanel path={PATH} />);
    for (const name of ["Thing", "go", "helper"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("indents a child further than its parent", () => {
    // The nesting is the outline's whole content; a flat list of the same names
    // would say nothing about what belongs to what.
    publishSymbols(PATH, TREE);
    const { container } = render(() => <OutlinePanel path={PATH} />);
    const rows = [...container.querySelectorAll<HTMLElement>("div[style]")];
    const pad = (name: string) =>
      rows.find((r) => r.textContent?.startsWith(name))!.style.paddingLeft;
    expect(pad("go")).not.toBe(pad("Thing"));
    expect(pad("helper")).toBe(pad("Thing"));
  });

  it("reveals the name, not the top of the body", () => {
    // `class Thing` opens at column 1 and the name is at column 7; landing on
    // the brace is technically the symbol and practically the wrong place.
    publishSymbols(PATH, TREE);
    render(() => <OutlinePanel path={PATH} />);
    fireEvent.click(screen.getByText("Thing"));
    expect(opened).toEqual([{ path: PATH, line: 1, col: 7 }]);
  });

  it("opens a nested symbol at its own position", () => {
    publishSymbols(PATH, TREE);
    render(() => <OutlinePanel path={PATH} />);
    fireEvent.click(screen.getByText("go"));
    expect(opened).toEqual([{ path: PATH, line: 2, col: 3 }]);
  });

  it("shows the server's detail beside the name", () => {
    publishSymbols(PATH, TREE);
    render(() => <OutlinePanel path={PATH} />);
    expect(screen.getByText("class")).toBeTruthy();
  });

  it("says so plainly when the server answered with nothing", () => {
    publishSymbols(PATH, []);
    render(() => <OutlinePanel path={PATH} />);
    expect(screen.getByText("No symbols in this file.")).toBeTruthy();
  });

  it("follows the store when the active file's symbols land later", () => {
    // Which is every file: the request goes out on the swap and the panel is
    // already mounted when it comes back.
    render(() => <OutlinePanel path={PATH} />);
    expect(screen.getByText("No symbols in this file.")).toBeTruthy();
    publishSymbols(PATH, TREE);
    expect(screen.getByText("Thing")).toBeTruthy();
  });

  it("shows nothing for a null path, which is an editor with no tabs", () => {
    publishSymbols(PATH, TREE);
    render(() => <OutlinePanel path={null} />);
    expect(screen.queryByText("Thing")).toBeNull();
  });
});
