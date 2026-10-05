import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import Breadcrumbs from "./Breadcrumbs";
import type { TintedMember } from "../../utils/topicMembers";
import { pointerClick } from "../../test/menus";
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

// Kobalte's focus scope focuses the content from a `setTimeout(0)`; asserting on
// the keyboard before yielding is asserting on machinery that does not exist
// yet. Same seam `Dropdown.test.tsx` documents.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

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

// Inside a Topic the trail starts one crumb earlier, at the repo the file is
// in (#158). The pane resolves the member; the bar only has to draw it.
describe("the member crumb", () => {
  const WEB = "/space/proj/web";
  const MEMBER: TintedMember = {
    member: {
      repoPath: "/repos/web",
      displayName: "web",
      worktreePath: WEB,
      state: { kind: "present" },
      order: 1,
    },
    key: WEB,
    root: WEB,
    label: "web",
    state: { label: "Ready", usable: true, action: null, reason: null },
    hue: "oklch(0.72 0.13 250)",
    style: { "--chip-hue": "oklch(0.72 0.13 250)", "--chip-rgb": "111 176 224" },
    icon: { seed: "/repos/web" },
    kind: "worktree",
  };
  const buttons = () => [...document.querySelectorAll<HTMLElement>("nav button")];

  it("starts the trail at the member holding the file, not at the active root", () => {
    // `ROOT` is the member in front; this file is in another one. Resolved
    // against `ROOT` the trail would find no shared prefix and collapse to the
    // basename, which is the state this crumb exists to end.
    render(() => <Breadcrumbs root={ROOT} path={`${WEB}/src/a.ts`} member={MEMBER} caret={null} />);
    // The chip is decorative, so the crumb is named by its label alone.
    expect(buttons()[0]).toBe(screen.getByRole("button", { name: "web" }));
    expect(crumbs().slice(1)).toEqual(["src", "a.ts"]);
    expect(document.querySelector("nav [data-chip]")?.getAttribute("data-chip")).toBe("/repos/web");
  });

  it("lists the member's own folder from its crumb", async () => {
    dirs[WEB] = [entry(WEB, "src", true), entry(WEB, "README.md")];
    render(() => <Breadcrumbs root={ROOT} path={`${WEB}/src/a.ts`} member={MEMBER} caret={null} />);
    pointerClick(screen.getByRole("button", { name: "web" }));
    expect(await screen.findByRole("menuitem", { name: "README.md" })).toBeTruthy();
    expect(reads).toEqual([WEB]);
  });

  it("leaves a file outside every member alone", () => {
    // A Docs-tree file opened while a Topic is selected: the pane resolves no
    // member for it, and a trail that named one would be naming the wrong repo.
    render(() => <Breadcrumbs root={ROOT} path="/elsewhere/todo.md" member={null} caret={null} />);
    expect(crumbs()).toEqual(["todo.md"]);
    expect(document.querySelector("nav [data-chip]")).toBeNull();
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
    pointerClick(screen.getByText("panels"));
    await screen.findByRole("menuitem", { name: "other.ts" });
    pointerClick(screen.getByRole("menuitem", { name: "other.ts" }));
    // Through OPEN_IN_EDITOR, which is where the pane records arrivals: this is
    // what makes the pick worth a jump-list entry, and worth exactly one.
    expect(opened).toEqual([{ path: `${ROOT}/src/panels/other.ts` }]);
  });

  it("lists the file crumb's own neighbours rather than the file", async () => {
    dirs[`${ROOT}/src/panels`] = [entry(`${ROOT}/src/panels`, "other.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    pointerClick(screen.getByText("thing.ts"));
    await screen.findByRole("menuitem", { name: "other.ts" });
    expect(reads).toEqual([`${ROOT}/src/panels`]);
  });

  it("reads nothing at all until a crumb is opened", async () => {
    // Three crumbs, three menus, and one folder read. Each crumb owns its own
    // menu now, and a menu's contents are mounted by the portal only while it
    // is open, so the bar costs nothing to render.
    dirs[`${ROOT}/src/panels`] = [entry(`${ROOT}/src/panels`, "other.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    expect(reads).toEqual([]);

    pointerClick(screen.getByText("panels"));

    await screen.findByRole("menuitem", { name: "other.ts" });
    expect(reads).toEqual([`${ROOT}/src/panels`]);
  });

  it("opens a subfolder beside its row, keeping the level it came from", async () => {
    // The whole point of the change. Descending used to replace the list in
    // place, so the way back out was the Escape key and the trail you had
    // walked was gone from the screen.
    dirs[`${ROOT}/src`] = [entry(`${ROOT}/src`, "utils", true), entry(`${ROOT}/src`, "main.ts")];
    dirs[`${ROOT}/src/utils`] = [entry(`${ROOT}/src/utils`, "fuzzy.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    pointerClick(screen.getByText("src"));
    pointerClick(await screen.findByRole("menuitem", { name: "utils" }));

    const row = await screen.findByRole("menuitem", { name: "fuzzy.ts" });
    expect(screen.getByRole("menuitem", { name: "main.ts" })).toBeTruthy();

    pointerClick(row);
    expect(opened).toEqual([{ path: `${ROOT}/src/utils/fuzzy.ts` }]);
    await waitFor(() => expect(screen.queryAllByRole("menu")).toEqual([]));
  });

  it("reads a folder only when its own level is opened", async () => {
    dirs[`${ROOT}/src`] = [entry(`${ROOT}/src`, "utils", true), entry(`${ROOT}/src`, "panels", true)];
    dirs[`${ROOT}/src/utils`] = [entry(`${ROOT}/src/utils`, "fuzzy.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    pointerClick(screen.getByText("src"));
    await screen.findByRole("menuitem", { name: "utils" });
    expect(reads).toEqual([`${ROOT}/src`]);

    pointerClick(screen.getByRole("menuitem", { name: "utils" }));

    await screen.findByRole("menuitem", { name: "fuzzy.ts" });
    // Its sibling folder is on screen the whole time and is never read.
    expect(reads).toEqual([`${ROOT}/src`, `${ROOT}/src/utils`]);
  });

  it("descends with the right arrow and comes back with the left", async () => {
    dirs[`${ROOT}/src`] = [entry(`${ROOT}/src`, "utils", true)];
    dirs[`${ROOT}/src/utils`] = [entry(`${ROOT}/src/utils`, "fuzzy.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    pointerClick(screen.getByText("src"));
    const menu = await screen.findByRole("menu");
    await macrotask();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "utils" }), { key: "ArrowRight" });
    const level = await screen.findByRole("menuitem", { name: "fuzzy.ts" });

    fireEvent.keyDown(level, { key: "ArrowLeft" });

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "fuzzy.ts" })).toBeNull());
    // Back where it started rather than closed outright.
    expect(screen.getByRole("menuitem", { name: "utils" })).toBeTruthy();
  });

  it("says a folder is empty rather than opening a blank menu", async () => {
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    pointerClick(screen.getByText("panels"));
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
  });

  it("does not call a folder it could not read an empty one", async () => {
    // Two different answers that a swallowed error would render as one, and the
    // wrong one of the two: a folder that would not open is not a folder with
    // nothing in it.
    unreadable.add(`${ROOT}/src/panels`);
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    pointerClick(screen.getByText("panels"));
    expect(await screen.findByText("Could not read this folder.")).toBeTruthy();
  });

  it("marks the file already open, for a reader as well as an eye", async () => {
    dirs[`${ROOT}/src/panels`] = [
      entry(`${ROOT}/src/panels`, "other.ts"),
      entry(`${ROOT}/src/panels`, "thing.ts"),
    ];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    pointerClick(screen.getByText("panels"));
    // Scoped to the menu: `thing.ts` is also the crumb that opened it.
    await screen.findByRole("menuitem", { name: "other.ts" });
    const rows = within(screen.getByRole("menu"));
    expect(rows.getByText("thing.ts").getAttribute("aria-current")).toBe("true");
    expect(rows.getByText("other.ts").getAttribute("aria-current")).toBeNull();
  });

  it("says on the crumb itself that it opens a menu", async () => {
    // The crumb is the trigger rather than something wrapped in one, which is
    // what puts these on the element a keyboard reaches. Every other dropdown in
    // the app belongs to a Tooltip and has to write them by hand.
    dirs[`${ROOT}/src/panels`] = [entry(`${ROOT}/src/panels`, "other.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    const crumb = screen.getByText("panels");
    expect(crumb.tagName).toBe("BUTTON");
    expect(crumb.getAttribute("aria-haspopup")).toBe("true");
    expect(crumb.getAttribute("aria-expanded")).toBe("false");

    pointerClick(crumb);

    await screen.findByRole("menuitem", { name: "other.ts" });
    expect(crumb.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers a symbol crumb its siblings, and opens the name rather than the body", async () => {
    publishSymbols(PATH, TREE);
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={{ line: 2, column: 4 }} />);
    // The `go` crumb: its siblings are the other methods of `Thing`.
    pointerClick(screen.getByText("go"));
    // Matched at the end: the kind glyph is labelled, so the row's whole
    // accessible name reads "Method stop".
    const row = await screen.findByRole("menuitem", { name: /stop$/ });
    pointerClick(row);
    // `stop`'s body starts at column 3 and its name at column 3 of line 5;
    // OutlinePanel makes the same choice for the same reason.
    expect(opened).toEqual([{ path: PATH, line: 5, col: 3 }]);
  });

  it("takes its menu with it when the crumb goes", async () => {
    // The other half of one menu per crumb: the menu belongs to the crumb, so a
    // trail that loses the crumb loses the menu with it. Nothing here is
    // listening for that, and Kobalte reports no close for a trigger that
    // unmounts, so a shared open-menu signal would have been left holding one.
    publishSymbols(PATH, TREE);
    const [caret, setCaret] = createSignal<{ line: number; column: number } | null>({
      line: 2,
      column: 4,
    });
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={caret()} />);
    pointerClick(screen.getByText("go"));
    await screen.findByRole("menu");

    setCaret(null);

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("offers the outermost crumb the file's top level", async () => {
    publishSymbols(PATH, TREE);
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={{ line: 2, column: 4 }} />);
    pointerClick(screen.getByText("Thing"));
    expect(await screen.findByRole("menuitem", { name: /helper$/ })).toBeTruthy();
  });

  it("closes the picker once something is picked", async () => {
    dirs[`${ROOT}/src/panels`] = [entry(`${ROOT}/src/panels`, "other.ts")];
    render(() => <Breadcrumbs root={ROOT} path={PATH} caret={null} />);
    pointerClick(screen.getByText("panels"));
    pointerClick(await screen.findByRole("menuitem", { name: "other.ts" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
