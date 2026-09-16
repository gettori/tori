import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState, type StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
// Type-only, so it is erased and does not race the mocks below.
import type { PeekState } from "./peekView";
import peekViewSource from "./peekView?raw";
import peekCommandSource from "./peekCommand?raw";
import peekLocationsSource from "./peekLocations?raw";
import codeEditorSource from "./CodeEditor.tsx?raw";
import commandsSource from "../../utils/commands.ts?raw";

const SOURCES = {
  "peekView.ts": peekViewSource,
  "peekCommand.ts": peekCommandSource,
  "peekLocations.ts": peekLocationsSource,
};

let disk: Record<string, string> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "fs_read_file") {
      const path = args?.path as string;
      return path in disk ? Promise.resolve(disk[path]) : Promise.reject(new Error("ENOENT"));
    }
    return Promise.resolve();
  },
}));

type Target = {
  root: string;
  ready: Promise<void>;
  supports: () => boolean;
  sync: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};
let target: Target | null = null;

vi.mock("./lspClient", () => ({ lspTargetFor: () => target }));

const { peekField, peekKeymap, peekWindow, hidePeek } = await import("./peekView");
const { openPeek, selectPeekResult } = await import("./peekCommand");
const { pathToUri } = await import("./toriWorkspace");

const OUTER = ["function caller() {", "  return callee();", "}", ""].join("\n");

function mount(): { view: EditorView; field: StateField<PeekState | null> } {
  const field: StateField<PeekState | null> = peekField((v, i) => void selectPeekResult(v, field, i));
  const view = new EditorView({
    state: EditorState.create({ doc: OUTER, extensions: [field, peekKeymap(field)] }),
    parent: document.body,
  });
  // The caret on the line that will be peeked from.
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 9 } });
  return { view, field };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const peekEl = () => document.querySelector(".cm-peek");

function replyWith(locations: { uri: string; line: number; endLine?: number }[]) {
  target = {
    root: "/repo",
    ready: Promise.resolve(),
    supports: () => true,
    sync: () => {},
    request: () =>
      Promise.resolve(
        locations.map((l) => ({
          uri: l.uri,
          range: { start: { line: l.line }, end: { line: l.endLine ?? l.line } },
        })),
      ),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  disk = {};
  target = null;
});

describe("which lines a peek shows", () => {
  const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

  it("shows context above the target and numbers the lines as the real file does", () => {
    const w = peekWindow(source, { path: "/x", line: 10, endLine: 10 });
    // Line 10 is 0-based, so line 11 in the file; two lines of context puts the
    // window's first line at 9.
    expect(w.firstLine).toBe(9);
    expect(w.text.split("\n")[0]).toBe("line 9");
    expect(w.text.split("\n")).toContain("line 11");
  });

  it("does not run off the top of the file", () => {
    const w = peekWindow(source, { path: "/x", line: 0, endLine: 0 });
    expect(w.firstLine).toBe(1);
    expect(w.text.split("\n")[0]).toBe("line 1");
  });

  it("does not run off the bottom of the file", () => {
    const w = peekWindow(source, { path: "/x", line: 38, endLine: 39 });
    const lines = w.text.split("\n");
    expect(lines[lines.length - 1]).toBe("line 40");
    expect(w.firstLine + lines.length - 1).toBe(40);
  });

  it("stays bounded for a target longer than the window", () => {
    // A peek is a glance. A 400-line function must not turn the widget into a
    // second editor; "open as a tab" is the answer to wanting the whole thing.
    const w = peekWindow(source, { path: "/x", line: 2, endLine: 39 });
    expect(w.text.split("\n").length).toBeLessThanOrEqual(14);
  });
});

describe("opening a peek", () => {
  it("renders the source of a file no tab holds, without opening one", async () => {
    disk = { "/repo/dep.ts": "export function callee() {\n  return 1;\n}\n" };
    replyWith([{ uri: pathToUri("/repo/dep.ts"), line: 0, endLine: 2 }]);
    const { view } = mount();

    expect(await openPeek(view, "definition", "/repo/a.ts")).toBe(true);
    await settle();

    const el = peekEl();
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain("export function callee()");
    // The file it names, and the line the server gave, counted the way a person
    // reads a gutter.
    expect(el!.textContent).toContain("dep.ts:1");
  });

  it("reads the peeked file itself rather than opening it through the workspace", async () => {
    // The claim the whole widget is built around, checked two ways because
    // neither alone is worth much.
    //
    // Behaviourally: the text came from a plain file read. An earlier version
    // of this test built a `ToriWorkspace` and asserted its `files` had not
    // grown - which passed for a worthless reason, since nothing under test
    // holds a reference to that workspace and no wiring exists by which it
    // could. It would have passed against an implementation that opened files
    // through a *different* workspace just as happily.
    disk = { "/repo/dep.ts": "export function callee() {}\n" };
    replyWith([{ uri: pathToUri("/repo/dep.ts"), line: 0 }]);
    const { view } = mount();
    await openPeek(view, "definition", "/repo/a.ts");
    await settle();
    expect(peekEl()!.textContent).toContain("export function callee()");

    // Structurally: no route to the workspace's opening API exists at all.
    // `ToriWorkspace` tracks what the *server* has been told about, and an
    // entry for a peeked file would be the workspace claiming a file with no
    // buffer and no view - the confusion the one-view-per-file gotcha is about.
    // This is what fails if a later change reaches for `displayFile` to get the
    // text, which is the obvious wrong way to do it.
    // Matched as calls rather than as words: these modules discuss the
    // workspace's bookkeeping in prose precisely because not touching it is the
    // point, and a bare-word match would fail on its own explanation.
    for (const [name, source] of Object.entries(SOURCES)) {
      for (const call of [".displayFile(", ".requestOpen(", ".openFile(", "new ToriWorkspace"]) {
        expect(source.includes(call), `${name} must not call ${call}`).toBe(false);
      }
    }
  });

  it("says so rather than rendering nothing when the file cannot be read", async () => {
    replyWith([{ uri: pathToUri("/repo/gone.ts"), line: 3 }]);
    const { view } = mount();
    await openPeek(view, "definition", "/repo/a.ts");
    await settle();

    expect(peekEl()!.textContent).toContain("Could not read that file");
  });

  it("shows nothing at all when no server claims the file", async () => {
    target = null;
    const { view } = mount();
    expect(await openPeek(view, "definition", "/repo/a.ts")).toBe(false);
    await settle();
    expect(peekEl()).toBeFalsy();
  });

  it("closes an open peek when the next one finds nothing", async () => {
    // A peek already up belongs to a *different* symbol. Leaving it there makes
    // the previous answer read as this question's, which is the same "right
    // source, wrong symbol" failure the request guard prevents - reached here
    // by a door the guard does not cover.
    disk = { "/repo/dep.ts": "export function callee() {}\n" };
    replyWith([{ uri: pathToUri("/repo/dep.ts"), line: 0 }]);
    const { view } = mount();
    await openPeek(view, "definition", "/repo/a.ts");
    await settle();
    expect(peekEl()).toBeTruthy();

    // Now ask somewhere the server cannot answer for.
    target = null;
    expect(await openPeek(view, "definition", "/repo/a.ts")).toBe(false);
    await settle();

    expect(peekEl()).toBeFalsy();
  });
});

describe("the way in", () => {
  // The command emits an event and the editor listens for it; a command whose
  // event nothing handles is a palette entry that silently does nothing, and
  // the type checker cannot see the gap because both sides name the same
  // constant. Source-inspected the way `commands.test.ts` inspects this table.
  it("is wired from the palette entry through to the editor", () => {
    for (const event of ["EDITOR_PEEK_DEFINITION", "EDITOR_PEEK_REFERENCES"]) {
      expect(commandsSource.includes(`emit(${event})`), `commands.ts must emit ${event}`).toBe(true);
      expect(codeEditorSource.includes(`onEvent(${event},`), `CodeEditor must listen for ${event}`).toBe(true);
    }
  });

  it("binds the chord with a matcher that already existed", () => {
    // `⌘⌥P`, on `e.code` like every other Cmd-Option chord: macOS rewrites
    // `e.key` while Option is held, so a key-based match would never fire.
    expect(commandsSource.includes('match: cmdOpt("KeyP")')).toBe(true);
    // And `⌥F12` in the editor's own keymap, which is what the `sub:` prints.
    expect(codeEditorSource.includes('key: "Alt-F12"')).toBe(true);
  });
});

describe("a references peek", () => {
  const three = [
    { uri: pathToUri("/repo/one.ts"), line: 1 },
    { uri: pathToUri("/repo/two.ts"), line: 2 },
    { uri: pathToUri("/repo/three.ts"), line: 3 },
  ];

  beforeEach(() => {
    disk = {
      "/repo/one.ts": "a\nfirst hit\nb\n",
      "/repo/two.ts": "a\nb\nsecond hit\n",
      "/repo/three.ts": "a\nb\nc\nthird hit\n",
    };
    replyWith(three);
  });

  it("lists every hit and renders the first", async () => {
    const { view } = mount();
    await openPeek(view, "references", "/repo/a.ts");
    await settle();

    const rows = [...document.querySelectorAll(".cm-peek-row")].map((r) => r.textContent);
    expect(rows).toEqual(["one.ts:2", "two.ts:3", "three.ts:4"]);
    expect(document.querySelector(".cm-peek-source")!.textContent).toContain("first hit");
    expect(peekEl()!.textContent).toContain("3 references");
  });

  it("shows the one you choose, in the same widget", async () => {
    const { view } = mount();
    await openPeek(view, "references", "/repo/a.ts");
    await settle();

    (document.querySelectorAll(".cm-peek-row")[2] as HTMLButtonElement).click();
    await settle();

    expect(document.querySelector(".cm-peek-source")!.textContent).toContain("third hit");
    // Still one widget, not a second one stacked under the first.
    expect(document.querySelectorAll(".cm-peek").length).toBe(1);
    expect(document.querySelectorAll(".cm-peek-row-active")[0].textContent).toBe("three.ts:4");
  });

  it("draws no list for a single result", async () => {
    replyWith([three[0]]);
    const { view } = mount();
    await openPeek(view, "definition", "/repo/a.ts");
    await settle();
    expect(document.querySelectorAll(".cm-peek-row").length).toBe(0);
  });
});

describe("closing a peek", () => {
  beforeEach(() => {
    disk = { "/repo/dep.ts": "export function callee() {}\n" };
    replyWith([{ uri: pathToUri("/repo/dep.ts"), line: 0 }]);
  });

  it("closes on Esc from inside the widget, ahead of any handler on the editor", async () => {
    // A block widget lives inside `contentDOM`, so the outer editor's handlers
    // (vim's among them) are ancestors. This is the case a keymap cannot reach:
    // the capture-phase listener on the widget has to win, or Esc typed while
    // reading the peek is swallowed by whatever the outer editor does with it.
    const { view } = mount();
    await openPeek(view, "definition", "/repo/a.ts");
    await settle();

    const swallowed: string[] = [];
    view.contentDOM.addEventListener("keydown", (e) => swallowed.push(e.key));

    const source = document.querySelector(".cm-peek-source")!;
    source.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();

    expect(peekEl()).toBeFalsy();
    // And the outer editor never saw it, so vim cannot have acted on it either.
    expect(swallowed).toEqual([]);
  });

  it("closes on Esc from the editor itself", async () => {
    const { view, field } = mount();
    await openPeek(view, "definition", "/repo/a.ts");
    await settle();

    view.dispatch({ effects: hidePeek.of(null) });
    expect(view.state.field(field)).toBe(null);
    expect(peekEl()).toBeFalsy();
  });

  it("leaves no orphaned widget behind after a reconfigure", async () => {
    // The wave-6 trap: a throw or a reconfigure can leave DOM attached to a
    // dead plugin, pinned over the file with nothing able to close it.
    // See [[gotchas#reading-the-editor-layout-during-a-cm6-update-throws]].
    const { view } = mount();
    await openPeek(view, "definition", "/repo/a.ts");
    await settle();
    expect(peekEl()).toBeTruthy();

    view.setState(EditorState.create({ doc: OUTER, extensions: [] }));
    await settle();

    expect(peekEl()).toBeFalsy();
    expect(document.querySelectorAll(".cm-peek-source").length).toBe(0);
  });

  it("tears down the nested view rather than only dropping its DOM", async () => {
    // CodeMirror removes the widget's DOM whether or not the widget cleans up
    // after itself, so "the peek is gone" is true either way. The nested
    // `EditorView` is a live view with its own listeners, and only the widget's
    // `destroy` releases it - which is why this counts the call rather than
    // looking at the document.
    const destroyed = vi.spyOn(EditorView.prototype, "destroy");
    const { view } = mount();
    await openPeek(view, "definition", "/repo/a.ts");
    await settle();

    const before = destroyed.mock.calls.length;
    view.dispatch({ effects: hidePeek.of(null) });
    await settle();

    expect(destroyed.mock.calls.length).toBe(before + 1);
    destroyed.mockRestore();
  });

  it("survives being opened and closed repeatedly", async () => {
    // Reading layout inside an update throws, and the throw is what leaves the
    // orphan. Nothing in the widget reads layout, and this is what says so.
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    const { view } = mount();

    for (let i = 0; i < 5; i++) {
      await openPeek(view, "definition", "/repo/a.ts");
      await settle();
      expect(peekEl()).toBeTruthy();
      view.dispatch({ effects: hidePeek.of(null) });
      await settle();
      expect(peekEl()).toBeFalsy();
    }

    expect(errors).toEqual([]);
    // Deliberately *not* asserting the outer scroll position here: jsdom does
    // no layout, so `scrollTop` is 0 before and after whatever happens, and an
    // assertion on it would pass against any implementation at all.
    // See [[gotchas#jsdom-measures-everything-as-zero-wide]].
    spy.mockRestore();
  });
});
