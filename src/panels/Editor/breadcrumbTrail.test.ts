import { describe, it, expect } from "vite-plus/test";
import { pathCrumbs, symbolTrail, siblingsAt, dirOf, baseName } from "./breadcrumbTrail";
import { normalizeDocumentSymbols } from "../../utils/symbols";

// The two halves of the trail, each on its own. What is worth testing here is
// not that a name comes out but that the arithmetic is right: which crumb counts
// as a folder, and which symbol actually holds the caret.

const ROOT = "/space/proj/main";
const PATH = `${ROOT}/src/panels/thing.ts`;

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

// class Thing (lines 1-7) { go (lines 2-4) { inner (line 3) } }, then a
// free-standing helper at lines 9-11 with a gap above it.
const TREE = normalizeDocumentSymbols(
  [
    {
      name: "Thing",
      kind: 5,
      range: range(0, 0, 6, 1),
      selectionRange: range(0, 6, 0, 11),
      children: [
        {
          name: "go",
          kind: 6,
          range: range(1, 2, 3, 3),
          selectionRange: range(1, 2, 1, 4),
          children: [
            { name: "inner", kind: 12, range: range(2, 4, 2, 30), selectionRange: range(2, 4, 2, 9) },
          ],
        },
      ],
    },
    { name: "helper", kind: 12, range: range(8, 0, 10, 1), selectionRange: range(8, 9, 8, 15) },
  ],
  PATH,
);

const names = (nodes: readonly { name: string }[]) => nodes.map((n) => n.name);

describe("the path half of the trail", () => {
  it("names every folder between the workspace and the file", () => {
    expect(pathCrumbs(ROOT, PATH)).toEqual([
      { name: "src", path: `${ROOT}/src`, isDir: true },
      { name: "panels", path: `${ROOT}/src/panels`, isDir: true },
      { name: "thing.ts", path: PATH, isDir: false },
    ]);
  });

  it("leaves the workspace itself out, since the sidebar already names it", () => {
    // The root repeated in front of every file is the part that never varies,
    // and it is long enough to push the part that does off the right edge.
    expect(pathCrumbs(ROOT, PATH).some((c) => c.path === ROOT)).toBe(false);
  });

  it("gives a file at the root a single crumb", () => {
    expect(pathCrumbs(ROOT, `${ROOT}/README.md`)).toEqual([
      { name: "README.md", path: `${ROOT}/README.md`, isDir: false },
    ]);
  });

  it("still names a file opened from outside the workspace", () => {
    // A Docs-tree file. The trail cannot say where it sits relative to a root it
    // does not share, but the crumb it can offer is the one people click.
    expect(pathCrumbs(ROOT, "/elsewhere/notes/todo.md")).toEqual([
      { name: "todo.md", path: "/elsewhere/notes/todo.md", isDir: false },
    ]);
  });

  it("is empty with no file open, which is an editor showing nothing", () => {
    expect(pathCrumbs(ROOT, null)).toEqual([]);
    expect(pathCrumbs(null, null)).toEqual([]);
  });

  it("starts at the member a Topic's file belongs to", () => {
    // The member root, not the active one: the trail for a background member's
    // file has to resolve against the folder that file is actually under.
    const MEMBER = "/space/proj/web";
    expect(pathCrumbs(ROOT, `${MEMBER}/src/a.ts`, { root: MEMBER, label: "web" })).toEqual([
      { name: "web", path: MEMBER, isDir: true },
      { name: "src", path: `${MEMBER}/src`, isDir: true },
      { name: "a.ts", path: `${MEMBER}/src/a.ts`, isDir: false },
    ]);
  });

  it("keeps the single crumb when the member does not hold the file either", () => {
    // A Docs-tree file opened while a Topic is selected. Naming a member the
    // file is not under would be the one thing worse than saying nothing.
    expect(pathCrumbs(ROOT, "/elsewhere/todo.md", { root: "/space/proj/web", label: "web" })).toEqual([
      { name: "todo.md", path: "/elsewhere/todo.md", isDir: false },
    ]);
  });

  it("falls back to the root when the member does not hold the file", () => {
    // The member costs its own crumb, not the trail: a root that does hold the
    // file still has a folder chain worth walking.
    expect(pathCrumbs(ROOT, PATH, { root: "/space/proj/web", label: "web" })).toEqual([
      { name: "src", path: `${ROOT}/src`, isDir: true },
      { name: "panels", path: `${ROOT}/src/panels`, isDir: true },
      { name: "thing.ts", path: PATH, isDir: false },
    ]);
  });

  it("does not mistake a sibling workspace for a parent", () => {
    // `/space/proj/main-old` shares the root's characters but not its folder.
    expect(pathCrumbs(ROOT, "/space/proj/main-old/a.ts")).toEqual([
      { name: "a.ts", path: "/space/proj/main-old/a.ts", isDir: false },
    ]);
  });

  it("knows a folder from the file in it", () => {
    expect(dirOf(PATH)).toBe(`${ROOT}/src/panels`);
    expect(dirOf("/a.ts")).toBe("/");
    expect(baseName(PATH)).toBe("thing.ts");
  });
});

describe("the symbol half of the trail", () => {
  it("walks from the outermost symbol down to the one holding the caret", () => {
    expect(names(symbolTrail(TREE, 3, 6))).toEqual(["Thing", "go", "inner"]);
  });

  it("stops at the depth the caret actually reaches", () => {
    expect(names(symbolTrail(TREE, 2, 3))).toEqual(["Thing", "go"]);
    expect(names(symbolTrail(TREE, 7, 1))).toEqual(["Thing"]);
  });

  it("is empty between two symbols, which is not an error", () => {
    // Line 8 is the blank line above `helper`. A caret there is inside nothing,
    // and saying so is better than leaving the last trail on screen.
    expect(symbolTrail(TREE, 8, 1)).toEqual([]);
  });

  it("is empty for a file whose server offers no symbols", () => {
    expect(symbolTrail([], 3, 6)).toEqual([]);
  });

  it("tells symbols apart by column when they share a line", () => {
    // A one-line file, or a minified one: every symbol starts and ends on line
    // 1, so a line-only test would call all of them enclosing.
    const ONE_LINE = normalizeDocumentSymbols(
      [
        { name: "a", kind: 12, range: range(0, 0, 0, 10), selectionRange: range(0, 0, 0, 1) },
        { name: "b", kind: 12, range: range(0, 12, 0, 22), selectionRange: range(0, 12, 0, 13) },
      ],
      PATH,
    );
    expect(names(symbolTrail(ONE_LINE, 1, 5))).toEqual(["a"]);
    expect(names(symbolTrail(ONE_LINE, 1, 16))).toEqual(["b"]);
    expect(symbolTrail(ONE_LINE, 1, 12)).toEqual([]);
  });

  it("counts a caret on the symbol's first and last character as inside it", () => {
    // Clicking a function's name must not empty the trail that names it.
    expect(names(symbolTrail(TREE, 9, 1))).toEqual(["helper"]);
    expect(names(symbolTrail(TREE, 11, 2))).toEqual(["helper"]);
  });
});

describe("what a symbol crumb could have been instead", () => {
  it("offers the file's top level for the first crumb", () => {
    const trail = symbolTrail(TREE, 3, 6);
    expect(names(siblingsAt(TREE, trail, 0))).toEqual(["Thing", "helper"]);
  });

  it("offers the crumb before it its own children", () => {
    const trail = symbolTrail(TREE, 3, 6);
    expect(names(siblingsAt(TREE, trail, 1))).toEqual(["go"]);
    expect(names(siblingsAt(TREE, trail, 2))).toEqual(["inner"]);
  });

  it("offers nothing for a depth the trail does not reach", () => {
    expect(siblingsAt(TREE, [], 3)).toEqual([]);
  });
});
