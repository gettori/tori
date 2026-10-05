// Closing a tab and opening it again, with a real `CodeEditor` over a mocked
// filesystem.
//
// The rule itself is unit-tested in `closedBuffers.test.ts`. What only a mount
// can answer is whether the pane hands the right state to the right tab at the
// right moment: the buffer being closed has to be the one the view was showing
// (not the copy stashed before the last keystroke), and the one handed back has
// to be reachable by `undo` rather than merely present in memory.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
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
const ORIGINAL = "one\ntwo\nthree\n";

// A fresh path per test. The store the pane keeps closed buffers in is
// module-level (it has to outlive the pane, see the tear-down test below), so
// two tests naming one file would be two tests sharing one entry, and the order
// they happened to run in would decide what the second one saw.
let seq = 0;
let FILE = "";

let disk: Record<string, string> = {};
const writes: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    const path = String(args?.path ?? "");
    switch (cmd) {
      case "fs_read_file":
        return path in disk ? Promise.resolve(disk[path]) : Promise.reject("ENOENT");
      case "fs_write_file":
        disk[path] = String(args.contents);
        writes.push(path);
        return Promise.resolve(null);
      case "file_exists":
        return Promise.resolve(path in disk);
      case "git_diff_file":
      case "git_status":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("./lspClient", () => ({
  claimedByLsp: () => false,
  ensureLspFor: () => Promise.resolve(),
  lspPluginFor: () => [],
  lspTargetFor: () => null,
  notifyLspFileChanged: () => {},
  onLspChange: () => () => {},
  setSemanticRefreshListener: () => () => {},
  setCodeLensRefreshListener: () => () => {},
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { emitWith, EDITOR_SAVE } = await import("../../utils/events");
const { diagnostics, publishDiagnostics, clearDiagnostics } = await import("../../utils/diagnostics");
const { MAX_CLOSED_BUFFERS } = await import("./closedBuffers");

let mounted: ReturnType<typeof render> | null = null;

/**
 * Mount one editor whose tab set the test drives.
 *
 * `openPaths` and `activePath` are separate props for a reason worth keeping in
 * the agent: closing a tab moves both, and the pane relies on the active swap
 * (which stashes the live view state) running before the eviction sweep sees it.
 */
async function mountEditor(first: string) {
  const dirty: { path: string; dirty: boolean }[] = [];
  const [open, setOpen] = createSignal<string[]>([first]);
  const [active, setActive] = createSignal<string | null>(first);
  mounted = render(() => (
    <CodeEditor
      activePath={active()}
      openPaths={open()}
      projectRoot={REPO}
      goto={null}
      onDirty={(p, d) => dirty.push({ path: p, dirty: d })}
      selected={null}
    />
  ));
  await waitFor(() => expect(dirty.length).toBeGreaterThan(0));
  const view = () => EditorView.findFromDOM(mounted!.container.querySelector(".cm-editor") as HTMLElement)!;

  /** Close every tab, then open `path`, the way the tab strip would. */
  const close = async (paths: string[]) => {
    const rest = open().filter((p) => !paths.includes(p));
    setActive(rest[0] ?? null);
    setOpen(rest);
    await Promise.resolve();
  };
  // Waits on the swap's own last act (`onDirty` for the new path), not on the
  // buffer looking non-empty: closing every tab leaves the *previous* file's
  // text on screen, so a content check would return before the open had begun.
  const openTab = async (path: string) => {
    const seen = dirty.length;
    setOpen([...open(), path]);
    setActive(path);
    await waitFor(() => {
      expect(dirty.length).toBeGreaterThan(seen);
      expect(dirty[dirty.length - 1].path).toBe(path);
    });
  };
  return { dirty, view, close, openTab };
}

/** Type at the top of the buffer, the way a keystroke would. */
function typeInto(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, insert: text }, userEvent: "input.type" });
}

/** Save the active buffer and wait for the write to have actually landed, so a
 *  close that follows cannot race it into looking dirty. */
async function save() {
  const seen = writes.length;
  emitWith(EDITOR_SAVE, undefined);
  await waitFor(() => expect(writes.length).toBe(seen + 1));
}

beforeEach(() => {
  FILE = `${REPO}/a${++seq}.txt`;
  disk = { [FILE]: ORIGINAL };
  writes.length = 0;
  clearDiagnostics();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("reopening a tab that was closed", () => {
  it("brings its undo history back with it", async () => {
    // The ticket in one test. Saved before closing because closing a *dirty*
    // tab is a discard the user was warned about; what survives here is the
    // history of edits that were kept, not the edits themselves.
    const ed = await mountEditor(FILE);
    typeInto(ed.view(), "zero\n");
    await save();
    expect(disk[FILE]).toBe("zero\n" + ORIGINAL);

    await ed.close([FILE]);
    await ed.openTab(FILE);

    const view = ed.view();
    expect(view.state.sliceDoc()).toBe("zero\n" + ORIGINAL);
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(true);
    expect(view.state.sliceDoc()).toBe(ORIGINAL);
  });

  it("brings the cursor back to where it was left", async () => {
    const ed = await mountEditor(FILE);
    ed.view().dispatch({ selection: { anchor: 5 } });

    await ed.close([FILE]);
    await ed.openTab(FILE);

    expect(ed.view().state.selection.main.anchor).toBe(5);
  });

  it("starts fresh when the file changed on disk while the tab was shut", async () => {
    // The undo history is a chain of positions into the document as it was.
    // Against content somebody else rewrote, those positions point at the wrong
    // places, so the only honest answer is a new buffer with nothing behind it.
    const ed = await mountEditor(FILE);
    typeInto(ed.view(), "zero\n");
    await save();

    await ed.close([FILE]);
    disk[FILE] = "rewritten by somebody else\n";
    await ed.openTab(FILE);

    const view = ed.view();
    expect(view.state.sliceDoc()).toBe("rewritten by somebody else\n");
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(false);
    expect(view.state.sliceDoc()).toBe("rewritten by somebody else\n");
  });

  it("does not hand back the edits a discard threw away", async () => {
    // Closing a dirty tab goes through "the edits in this tab will be lost".
    // Keeping that buffer would make the warning untrue the moment the file was
    // reopened. Carrying unsaved work across a *quit* is hot exit's job.
    const ed = await mountEditor(FILE);
    typeInto(ed.view(), "never saved\n");

    await ed.close([FILE]);
    await ed.openTab(FILE);

    const view = ed.view();
    expect(view.state.sliceDoc()).toBe(ORIGINAL);
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(false);
  });

  it("reports it clean, so the tab comes back without a dirty dot", async () => {
    const ed = await mountEditor(FILE);
    typeInto(ed.view(), "zero\n");
    await save();

    await ed.close([FILE]);
    await ed.openTab(FILE);

    expect(ed.dirty[ed.dirty.length - 1]).toEqual({ path: FILE, dirty: false });
  });

  it("survives the pane being torn down with the last tab", async () => {
    // `Editor.tsx:1160` mounts this pane only while some tab is open, so closing
    // the only one unmounts it and `onCleanup` destroys the view. If the store
    // lived on the instance it would be empty in precisely the case this ticket
    // is named after, and every other test here would still pass.
    const first = await mountEditor(FILE);
    typeInto(first.view(), "zero\n");
    await save();
    first.view().dispatch({ selection: { anchor: 5 } });
    await first.close([FILE]);
    mounted?.unmount();
    mounted = null;

    const second = await mountEditor(FILE);
    const view = second.view();
    expect(view.state.selection.main.anchor).toBe(5);
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(true);
    expect(view.state.sliceDoc()).toBe(ORIGINAL);
  });

  it("is answerable to the pane that took it back, not the one that kept it", async () => {
    // The trap the tear-down test above cannot see. A live `EditorState` carries
    // the configuration it was built with, and half of that belongs to the
    // component instance: the update listener behind the dirty flag closes over
    // *that* instance's buffer map and props. Hand one back after a remount and
    // the buffer reads perfectly and reports nothing, for good. Serializing and
    // rebuilding is what makes the state answer to whoever revived it.
    const first = await mountEditor(FILE);
    await first.close([FILE]);
    mounted?.unmount();
    mounted = null;

    const second = await mountEditor(FILE);
    const before = second.dirty.length;
    typeInto(second.view(), "x");

    expect(second.dirty.length).toBeGreaterThan(before);
    expect(second.dirty[second.dirty.length - 1]).toEqual({ path: FILE, dirty: true });
  });

  it("forgets the oldest once more than the cap have been closed", async () => {
    // Whole documents with their histories, so the store is bounded. The oldest
    // reopens as a fresh buffer, which is exactly what closing always did.
    const ed = await mountEditor(FILE);
    ed.view().dispatch({ selection: { anchor: 5 } });
    await ed.close([FILE]);

    for (let i = 0; i < MAX_CLOSED_BUFFERS; i++) {
      const path = `${REPO}/filler${seq}-${i}.txt`;
      disk[path] = `filler ${i}\n`;
      await ed.openTab(path);
      await ed.close([path]);
    }

    await ed.openTab(FILE);
    expect(ed.view().state.selection.main.anchor).toBe(0);
  });
});

describe("what closing takes with it regardless", () => {
  it("drops the file's diagnostics, kept buffer or not", async () => {
    // The Problems list is a list of open files. A closed one still appearing
    // there is a row whose click has nowhere to go.
    const ed = await mountEditor(FILE);
    publishDiagnostics(FILE, [{ line: 1, endLine: 1, column: 1, severity: "error", message: "boom" }]);
    expect(diagnostics()[FILE]).toHaveLength(1);

    await ed.close([FILE]);

    expect(diagnostics()[FILE]).toBeUndefined();
  });
});
