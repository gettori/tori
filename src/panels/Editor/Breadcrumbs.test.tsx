import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import Breadcrumbs from "./Breadcrumbs";
import { publishSymbols, clearSymbols, normalizeDocumentSymbols } from "../../utils/symbols";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";

// The bar from the outside: what it says, and what a click on it does.
//
// `breadcrumbTrail.ts` owns the arithmetic and is tested on its own. What is
// here is the part it cannot see: that the path half renders with no server in
// sight, that the symbol half follows the caret, and that a pick leaves through
// OPEN_IN_EDITOR - which is the pane's one recording site, and therefore the
// only way a pick earns its jump-list entry.

const ROOT = "/space/proj/main";
const PATH = `${ROOT}/src/panels/thing.ts`;

type Entry = { name: string; path: string; is_dir: boolean; ignored: boolean };
const entry = (dir: string, name: string, is_dir = false, ignored = false): Entry => ({
  name,
  path: `${dir}/${name}`,
  is_dir,
  ignored,
});

const dirs: Record<string, Entry[]> = {};
const unreadable = new Set<string>();
const reads: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "fs_read_dir") {
      const path = args.path as string;
      reads.push(path);
      if (unreadable.has(path)) return Promise.reject("permission denied");
      return Promise.resolve(dirs[path] ?? []);
    }
    return Promise.resolve(null);
  },
}));

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

const TREE = normalizeDocumentSymbols(
  [
    {
      name: "Thing",
      kind: 5,
      range: range(0, 0, 6, 1),
      selectionRange: range(0, 6, 0, 11),
      children: [
        { name: "go", kind: 6, range: range(1, 2, 3, 3), selectionRange: range(1, 2, 1, 4) },
        { name: "stop", kind: 6, range: range(4, 2, 5, 3), selectionRange: range(4, 2, 4, 6) },
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
  reads.length = 0;
  unreadable.clear();
  for (const key of Object.keys(dirs)) delete dirs[key];
  offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opened.push(d));
});

afterEach(() => {
  offOpen?.();
  clearSymbols();
});

const crumbs = () => [...document.querySelectorAll("nav button")].map((b) => b.textContent);

describe("the path half of the bar", () => {
  it("renders for a file with no language server attached", () => {
    // Nothing published for this path, which is what a project with no server
    // looks like. The trail is still the whole point of the bar.
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    expect(crumbs()).toEqual(["src", "panels", "thing.ts"]);
  });

  it("shows nothing at all with no file open", () => {
    render(() => <Breadcrumbs root={ROOT} path={null} caret={null} />);
    expect(document.querySelector("nav")).toBeNull();
  });
});

describe("the symbol half of the bar", () => {
  it("names the symbols holding the caret, outermost first", () => {
    publishSymbols(PATH, TREE);
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={{ line: 2, column: 4 }} />);
    expect(crumbs()).toEqual(["src", "panels", "thing.ts", "Thing", "go"]);
  });

  it("updates when the cursor moves into a nested function", () => {
    publishSymbols(PATH, TREE);
    const [caret, setCaret] = createSignal({ line: 7, column: 1 });
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={caret()} />);
    expect(crumbs()).toEqual(["src", "panels", "thing.ts", "Thing"]);
    setCaret({ line: 5, column: 4 });
    expect(crumbs()).toEqual(["src", "panels", "thing.ts", "Thing", "stop"]);
    setCaret({ line: 9, column: 1 });
    expect(crumbs()).toEqual(["src", "panels", "thing.ts", "helper"]);
  });

  it("shows the path half alone when the caret is not in this file", () => {
    // A tab swap: the pane withholds the caret until the buffer it belongs to is
    // the one on screen, so the trail cannot name a symbol from the file you
    // just left.
    publishSymbols(PATH, TREE);
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    expect(crumbs()).toEqual(["src", "panels", "thing.ts"]);
  });

  it("follows the store when the symbols land after the file opens", () => {
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={{ line: 2, column: 4 }} />);
    expect(crumbs()).toEqual(["src", "panels", "thing.ts"]);
    publishSymbols(PATH, TREE);
    expect(crumbs()).toEqual(["src", "panels", "thing.ts", "Thing", "go"]);
  });
});

describe("picking somewhere else from a crumb", () => {
  it("offers the folder's other entries and opens the one picked", async () => {
    dirs[`${ROOT}/src/panels`] = [
      entry(`${ROOT}/src/panels`, "other.ts"),
      entry(`${ROOT}/src/panels`, "thing.ts"),
    ];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    fireEvent.click(screen.getByText("panels"));
    const row = await screen.findByText("other.ts");
    fireEvent.click(row);
    // Through OPEN_IN_EDITOR, which is where the pane records arrivals: this is
    // what makes the pick worth a jump-list entry, and worth exactly one.
    expect(opened).toEqual([{ path: `${ROOT}/src/panels/other.ts` }]);
  });

  it("lists the file crumb's own neighbours rather than the file", async () => {
    dirs[`${ROOT}/src/panels`] = [entry(`${ROOT}/src/panels`, "other.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    fireEvent.click(screen.getByText("thing.ts"));
    await screen.findByText("other.ts");
    expect(reads).toEqual([`${ROOT}/src/panels`]);
  });

  it("drills into a folder without closing the picker", async () => {
    dirs[`${ROOT}/src`] = [entry(`${ROOT}/src`, "utils", true)];
    dirs[`${ROOT}/src/utils`] = [entry(`${ROOT}/src/utils`, "fuzzy.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(await screen.findByText("utils"));
    const row = await screen.findByText("fuzzy.ts");
    fireEvent.click(row);
    expect(opened).toEqual([{ path: `${ROOT}/src/utils/fuzzy.ts` }]);
  });

  it("says a folder is empty rather than opening a blank menu", async () => {
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    fireEvent.click(screen.getByText("panels"));
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
  });

  it("does not call a folder it could not read an empty one", async () => {
    // Two different answers that a swallowed error would render as one, and the
    // wrong one of the two: a folder that would not open is not a folder with
    // nothing in it.
    unreadable.add(`${ROOT}/src/panels`);
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    fireEvent.click(screen.getByText("panels"));
    expect(await screen.findByText("Could not read this folder.")).toBeTruthy();
  });

  it("marks the file already open, for a reader as well as an eye", async () => {
    dirs[`${ROOT}/src/panels`] = [
      entry(`${ROOT}/src/panels`, "other.ts"),
      entry(`${ROOT}/src/panels`, "thing.ts"),
    ];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    fireEvent.click(screen.getByText("panels"));
    // Scoped to the menu: `thing.ts` is also the crumb that opened it.
    await screen.findByText("other.ts");
    const rows = within(document.querySelector("[role='menu']") as HTMLElement);
    expect(rows.getByText("thing.ts").getAttribute("aria-current")).toBe("true");
    expect(rows.getByText("other.ts").getAttribute("aria-current")).toBeNull();
  });

  it("offers a symbol crumb its siblings, and opens the name rather than the body", async () => {
    publishSymbols(PATH, TREE);
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={{ line: 2, column: 4 }} />);
    // The `go` crumb: its siblings are the other methods of `Thing`.
    fireEvent.click(screen.getByText("go"));
    const row = await screen.findByText("stop");
    fireEvent.click(row);
    // `stop`'s body starts at column 3 and its name at column 3 of line 5;
    // OutlinePanel makes the same choice for the same reason.
    expect(opened).toEqual([{ path: PATH, line: 5, col: 3 }]);
  });

  it("offers the outermost crumb the file's top level", async () => {
    publishSymbols(PATH, TREE);
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={{ line: 2, column: 4 }} />);
    fireEvent.click(screen.getByText("Thing"));
    expect(await screen.findByText("helper")).toBeTruthy();
  });

  it("closes the picker once something is picked", async () => {
    dirs[`${ROOT}/src/panels`] = [entry(`${ROOT}/src/panels`, "other.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    fireEvent.click(screen.getByText("panels"));
    fireEvent.click(await screen.findByText("other.ts"));
    await waitFor(() => expect(document.querySelector("[role='menu']")).toBeNull());
  });
});
