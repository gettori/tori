// Hot exit through the editor pane: what a quit stashes, and what a launch
// makes of it.
//
// The store's rules are unit-tested in `utils/hotExit.test.ts`. What needs a
// real `CodeEditor` is the half that only it can do: serializing a live buffer,
// and rebuilding one from a stash so that the text, the undo history and the
// conflict banner all come back the way the ticket describes.
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
const ORIGINAL = "one\ntwo\nthree\n";

// A path per test: the pending stash is module-level, so two tests naming one
// file would be two tests sharing one entry.
let seq = 0;
let FILE = "";

let disk: Record<string, string> = {};
/** What the backend's hot-exit file holds. */
let stashOnDisk: unknown = {};
/** Set to make the stash write fail, which is the case the quit prompt exists for. */
let saveFails = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    const path = String(args?.path ?? "");
    switch (cmd) {
      case "fs_read_file":
        return path in disk ? Promise.resolve(disk[path]) : Promise.reject("ENOENT");
      case "fs_write_file":
        disk[path] = String(args.contents);
        return Promise.resolve(null);
      case "hot_exit_load":
        return Promise.resolve(stashOnDisk);
      case "hot_exit_save":
        if (saveFails) return Promise.reject("disk full");
        stashOnDisk = args.stash;
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
  stopAllLsp: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { requestStash, loadPendingStash, clearPendingStash, pendingStashPaths } = await import(
  "../../utils/hotExit"
);

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor(path: string) {
  const dirty: { path: string; dirty: boolean }[] = [];
  const [active, setActive] = createSignal<string | null>(path);
  mounted = render(() => (
    <CodeEditor
      activePath={active()}
      openPaths={[path]}
      projectRoot={REPO}
      goto={null}
      onDirty={(p, d) => dirty.push({ path: p, dirty: d })}
      selected={null}
    />
  ));
  await waitFor(() => expect(dirty.length).toBeGreaterThan(0));
  const view = EditorView.findFromDOM(mounted.container.querySelector(".cm-editor") as HTMLElement)!;
  return { dirty, view, setActive };
}

function typeInto(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, insert: text }, userEvent: "input.type" });
}

/** What the stash holds for one path, as the backend would have stored it. */
const storedFor = (path: string) => (stashOnDisk as Record<string, { savedText: string; state: unknown }>)[path];

beforeEach(() => {
  FILE = `${REPO}/a${++seq}.txt`;
  disk = { [FILE]: ORIGINAL };
  stashOnDisk = {};
  saveFails = false;
  clearPendingStash();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("quitting with unsaved edits", () => {
  it("writes them to the stash and says it managed to", async () => {
    const ed = await mountEditor(FILE);
    typeInto(ed.view, "zero\n");

    await expect(requestStash()).resolves.toBe(true);

    expect(storedFor(FILE).savedText).toBe(ORIGINAL);
    expect(Object.keys(stashOnDisk as object)).toEqual([FILE]);
  });

  it("says it did not when the write is refused", async () => {
    // The boolean the quit path reads. A stash that did not land must send the
    // window back to the "unsaved edits will be lost" confirm, because the
    // preference being on is not evidence that anything was kept.
    const ed = await mountEditor(FILE);
    typeInto(ed.view, "zero\n");
    saveFails = true;

    await expect(requestStash()).resolves.toBe(false);
  });

  it("stashes nothing for a buffer with no unsaved edits", async () => {
    await mountEditor(FILE);

    await expect(requestStash()).resolves.toBe(true);

    expect(stashOnDisk).toEqual({});
  });

  it("reads the shown buffer from the view, not from its stashed record", async () => {
    // The buffer's record is only refreshed on a swap, so mid-edit it is one
    // buffer behind. A quit is exactly when that gap costs something: it would
    // stash the file as it was when the tab was last switched to.
    const ed = await mountEditor(FILE);
    typeInto(ed.view, "typed after the last swap\n");

    await requestStash();

    const restored = storedFor(FILE).state as { doc: string };
    expect(restored.doc).toBe("typed after the last swap\n" + ORIGINAL);
  });
});

describe("launching with a stash", () => {
  /** Quit with unsaved edits, then start over with the file as `onDisk`. */
  async function quitDirtyThenRelaunch(edit: string, onDisk?: string) {
    const first = await mountEditor(FILE);
    typeInto(first.view, edit);
    await requestStash();
    mounted?.unmount();
    mounted = null;
    if (onDisk !== undefined) disk[FILE] = onDisk;
    await loadPendingStash(Date.now());
    return mountEditor(FILE);
  }

  it("hands the unsaved text back, with its undo history", async () => {
    const ed = await quitDirtyThenRelaunch("zero\n");

    expect(ed.view.state.sliceDoc()).toBe("zero\n" + ORIGINAL);
    expect(ed.dirty[ed.dirty.length - 1]).toEqual({ path: FILE, dirty: true });
    expect(undo({ state: ed.view.state, dispatch: (tr) => ed.view.dispatch(tr) })).toBe(true);
    expect(ed.view.state.sliceDoc()).toBe(ORIGINAL);
  });

  it("takes the entry, so a second buffer for the same file reads the file", async () => {
    await quitDirtyThenRelaunch("zero\n");
    expect(pendingStashPaths()).toEqual([]);
  });

  it("keeps the unsaved text and raises the banner when the file moved underneath it", async () => {
    // Never a silent discard: the work comes back, the disk version is offered
    // beside it, and the user chooses. Only the history goes, because it is a
    // chain of positions into a document that no longer exists.
    const ed = await quitDirtyThenRelaunch("zero\n", "rewritten while the app was shut\n");

    expect(ed.view.state.sliceDoc()).toBe("zero\n" + ORIGINAL);
    expect(mounted!.container.textContent).toContain("changed on disk");
    expect(undo({ state: ed.view.state, dispatch: (tr) => ed.view.dispatch(tr) })).toBe(false);
  });

  it("offers the disk version through the banner's Reload", async () => {
    const ed = await quitDirtyThenRelaunch("zero\n", "rewritten while the app was shut\n");
    const reload = [...mounted!.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Reload",
    )!;

    reload.click();

    expect(ed.view.state.sliceDoc()).toBe("rewritten while the app was shut\n");
    expect(ed.dirty[ed.dirty.length - 1]).toEqual({ path: FILE, dirty: false });
  });

  it("brings the buffer back even though the file is gone", async () => {
    // The deleted case. `Editor.tsx` keeps the tab alive for a stashed path
    // whether or not the file still exists, so the text has somewhere to land.
    const first = await mountEditor(FILE);
    typeInto(first.view, "the only copy of this\n");
    await requestStash();
    mounted?.unmount();
    mounted = null;
    delete disk[FILE];
    await loadPendingStash(Date.now());

    const ed = await mountEditor(FILE);
    expect(ed.view.state.sliceDoc()).toContain("the only copy of this");
  });

  it("falls back to the file when the stash cannot be read at all", async () => {
    // A blob from an incompatible version, or one truncated by a kill. Losing
    // the work is bad; losing the work *and* failing to open the tab is worse.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    stashOnDisk = { [FILE]: { savedText: ORIGINAL, state: { doc: 7 }, savedAt: Date.now() } };
    await loadPendingStash(Date.now());

    const ed = await mountEditor(FILE);

    expect(ed.view.state.sliceDoc()).toBe(ORIGINAL);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
