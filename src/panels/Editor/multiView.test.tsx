// Two panes over one editor (plan phase 9), with a real `CodeEditor` and a real
// CodeMirror in each pane over a mocked filesystem.
//
// The claim under test is the authority model: the buffer map holds one state
// per file, the first pane showing a file owns it, and a second pane onto the
// same file is a follower that mirrors the document, keeps no history of its
// own, and never answers a question about it (save, dirty, hot exit, the live
// buffer the preview and the language workspace read).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const ONE = `${REPO}/one.ts`;
const TWO = `${REPO}/two.ts`;

let disk: Record<string, string> = {};
let stashed: Record<string, { savedText: string; state: { doc?: string } }> = {};
const writes: { path: string; contents: string }[] = [];
let lspAttached: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    const path = String(args?.path ?? "");
    switch (cmd) {
      case "fs_read_file":
        return path in disk ? Promise.resolve(disk[path]) : Promise.reject("ENOENT");
      case "fs_write_file":
        disk[path] = String(args.contents);
        writes.push({ path, contents: String(args.contents) });
        return Promise.resolve(null);
      case "file_exists":
        return Promise.resolve(path in disk);
      case "git_diff_file":
      case "git_status":
        return Promise.resolve([]);
      case "hot_exit_save":
        stashed = args.stash as typeof stashed;
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
// The plugin is what a view uses to talk to the server, so counting the calls
// counts the views that would: one per file, however many panes show it.
vi.mock("./lspClient", () => ({
  claimedByLsp: () => false,
  ensureLspFor: () => Promise.resolve(),
  lspPluginFor: (path: string) => {
    lspAttached.push(path);
    return [];
  },
  lspTargetFor: () => null,
  notifyLspFileChanged: () => {},
  onLspChange: () => () => {},
  setSemanticRefreshListener: () => () => {},
  setCodeLensRefreshListener: () => () => {},
  stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { emit, emitWith, EDITOR_SAVE, EDITOR_STASH_DIRTY } = await import("../../utils/events");
type StashDirty = import("../../utils/events").EditorStashDirty;
const { liveBufferText } = await import("./liveBuffers");

let mounted: ReturnType<typeof render> | null = null;

/** Mount two panes, each showing whatever the test tells it to. */
async function mountPanes(left: string | null, right: string | null) {
  const dirty: { path: string; dirty: boolean }[] = [];
  const [a, setA] = createSignal<string | null>(left);
  const [b, setB] = createSignal<string | null>(right);
  const [focused, setFocused] = createSignal("left");
  // A signal, not a plain object: the editor reads the host reactively, so a
  // ref landing after the first render has to be a change it can see.
  const [hosts, setHosts] = createSignal<Record<string, HTMLElement>>({});
  const hold = (id: string) => (el: HTMLElement) => setHosts((prev) => ({ ...prev, [id]: el }));
  mounted = render(() => (
    <>
      <div ref={hold("left")} data-pane="left" />
      <div ref={hold("right")} data-pane="right" />
      <CodeEditor
        paneIds={["left", "right"]}
        paneHost={(id) => hosts()[id]}
        panePath={(id) => (id === "left" ? a() : b())}
        paneHidden={() => false}
        focusedPaneId={focused()}
        openPaths={[ONE, TWO]}
        projectRoot={REPO}
        goto={null}
        onDirty={(p, d) => dirty.push({ path: p, dirty: d })}
        selected={null}
      />
    </>
  ));
  const viewIn = (pane: "left" | "right") =>
    EditorView.findFromDOM(hosts()[pane].querySelector(".cm-editor") as HTMLElement)!;
  await waitFor(() => {
    for (const pane of ["left", "right"] as const) {
      const want = pane === "left" ? left : right;
      if (want) expect(viewIn(pane).state.sliceDoc()).toBe(disk[want]);
    }
  });
  return { dirty, viewIn, setA, setB, setFocused };
}

/** A real undo chord on a view, which is what a keymap can answer. Both
 *  modifiers, since "Mod" is Cmd or Ctrl depending on the platform CM6 detects
 *  and jsdom is not a Mac. */
const undoKey = (v: EditorView) => {
  for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
    v.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true, ...mods }),
    );
  }
};

const type = (v: EditorView, at: number, text: string) =>
  v.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });

beforeEach(() => {
  disk = { [ONE]: "one\ntwo\nthree\n", [TWO]: "alpha\nbeta\n" };
  writes.length = 0;
  stashed = {};
  lspAttached = [];
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("two panes, two files", () => {
  it("shows each file in its own pane and lands edits in the right buffer", async () => {
    const { viewIn } = await mountPanes(ONE, TWO);
    expect(viewIn("left").state.sliceDoc()).toBe(disk[ONE]);
    expect(viewIn("right").state.sliceDoc()).toBe(disk[TWO]);

    type(viewIn("left"), 0, "// left\n");
    type(viewIn("right"), 0, "// right\n");

    expect(viewIn("left").state.sliceDoc().startsWith("// left")).toBe(true);
    expect(viewIn("right").state.sliceDoc().startsWith("// right")).toBe(true);
    // And the buffers behind them, which is what a save or a preview reads.
    await waitFor(() => {
      expect(liveBufferText(ONE)?.startsWith("// left")).toBe(true);
      expect(liveBufferText(TWO)?.startsWith("// right")).toBe(true);
    });
  });

  it("attaches one language client per file, not one per view", async () => {
    await mountPanes(ONE, ONE);
    expect(lspAttached.filter((p) => p === ONE)).toHaveLength(1);
  });
});

describe("two panes, one file", () => {
  it("mirrors edits both ways over one document", async () => {
    const { viewIn } = await mountPanes(ONE, ONE);
    type(viewIn("left"), 0, "L");
    expect(viewIn("right").state.sliceDoc()).toBe(viewIn("left").state.sliceDoc());

    type(viewIn("right"), 0, "R");
    expect(viewIn("left").state.sliceDoc()).toBe(viewIn("right").state.sliceDoc());
    expect(viewIn("left").state.sliceDoc().startsWith("RL")).toBe(true);
  });

  it("converges under interleaved edits from both views", async () => {
    // The property: whatever order the two views are typed into, they hold one
    // document. Positions are chosen from the live doc each round, so a change
    // that mapped wrongly shows up as divergence rather than as an exception.
    const { viewIn } = await mountPanes(ONE, ONE);
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 60; i++) {
      const v = viewIn(i % 2 === 0 ? "left" : "right");
      const at = rand(v.state.doc.length + 1);
      if (i % 5 === 4 && v.state.doc.length > 2) {
        const from = rand(v.state.doc.length - 1);
        v.dispatch({ changes: { from, to: from + 1 }, userEvent: "delete" });
      } else {
        type(v, at, `x${i}`);
      }
      expect(viewIn("left").state.sliceDoc()).toBe(viewIn("right").state.sliceDoc());
    }
    await waitFor(() => expect(liveBufferText(ONE)).toBe(viewIn("left").state.sliceDoc()));
  });

  it("keeps one undo history, on the authority, whichever view asks", async () => {
    const { viewIn } = await mountPanes(ONE, ONE);
    const before = viewIn("left").state.sliceDoc();
    type(viewIn("left"), 0, "first ");
    type(viewIn("right"), 0, "second ");
    const both = viewIn("left").state.sliceDoc();
    expect(both.startsWith("second first ")).toBe(true);

    // The follower has no history of its own, so its undo *key* is the one
    // routed to the authority (a command called on the view cannot be).
    undoKey(viewIn("right"));
    expect(viewIn("left").state.sliceDoc()).toBe(viewIn("right").state.sliceDoc());
    expect(viewIn("left").state.sliceDoc()).not.toBe(both);
    undo(viewIn("left"));
    expect(viewIn("left").state.sliceDoc()).toBe(before);
    expect(viewIn("right").state.sliceDoc()).toBe(before);
  });

  it("never lets the follower answer for the file", async () => {
    const { viewIn, dirty } = await mountPanes(ONE, ONE);
    // An edit typed into the follower, so every read below has a chance to be
    // wrong in the same direction if it went to the wrong view.
    type(viewIn("right"), 0, "typed in the follower\n");
    const text = viewIn("left").state.sliceDoc();

    // Dirty: reported once, by the authority, naming the file.
    await waitFor(() => expect(dirty.some((d) => d.path === ONE && d.dirty)).toBe(true));

    // The live buffer, which the preview and the language workspace read.
    await waitFor(() => expect(liveBufferText(ONE)).toBe(text));

    // Save: what lands on disk is the authority's document.
    emit(EDITOR_SAVE);
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const last = writes[writes.length - 1];
    expect(last.path).toBe(ONE);
    expect(last.contents).toBe(text);

    // Hot exit: the stash carries the same text. Typed again first, since the
    // save above just made the buffer clean and a clean buffer is not stashed.
    type(viewIn("right"), 0, "and again\n");
    const stashText = viewIn("left").state.sliceDoc();
    emitWith<StashDirty>(EDITOR_STASH_DIRTY, { requestId: "7" });
    await waitFor(() => expect(stashed[ONE]).toBeTruthy());
    // The serialized state carries the document, which is the authority's.
    expect(stashed[ONE].state.doc).toBe(stashText);
  });

  it("hands the file over when the pane that owned it moves on", async () => {
    const { viewIn, setA } = await mountPanes(ONE, ONE);
    type(viewIn("right"), 0, "kept\n");
    // The authority leaves for another file: the follower is the only view on
    // this one now, and has to hold its edits and its history.
    setA(TWO);
    await waitFor(() => expect(viewIn("left").state.sliceDoc()).toBe(disk[TWO]));
    await waitFor(() => expect(viewIn("right").state.sliceDoc().startsWith("kept")).toBe(true));
    expect(liveBufferText(ONE)?.startsWith("kept")).toBe(true);

    type(viewIn("right"), 0, "more\n");
    await waitFor(() => expect(liveBufferText(ONE)?.startsWith("more")).toBe(true));
    // And it has a real history now, reaching back through the edit it made
    // while it was only following. (Both edits land in one undo group, since
    // CM6 groups by time and a test types them in the same millisecond.)
    undo(viewIn("right"));
    expect(viewIn("right").state.sliceDoc()).toBe(disk[ONE]);
  });
});
