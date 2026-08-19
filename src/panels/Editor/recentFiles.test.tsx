import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";

// Reopening a closed tab, and the record the pickers rank by.
//
// The rules are unit-tested (`reopenStack.ts`, `frecency.ts`) and what a
// reopened *document* comes back with is `undoOnReopen.test.tsx`'s. What only
// this can answer is whether the pane feeds them: that Cmd+Shift+T reaches the
// same open path a click would (which is what makes the undo history come
// back), and that an open and an edit are counted once each.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "file_exists":
        return Promise.resolve(false);
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));

type CodeProps = {
  activePath: string | null;
  openPaths: string[];
  onDirty: (path: string, dirty: boolean) => void;
};
let code: CodeProps | null = null;
vi.mock("./CodeEditor", () => ({
  default: (p: CodeProps) => {
    code = p;
    return null;
  },
}));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), retainLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR, EDITOR_CLOSE_TAB, EDITOR_REOPEN_CLOSED, FILE_RENAMED, PURGE_UNDER_PATH } =
  await import("../../utils/events");
const { loadFrecency } = await import("../../utils/frecency");

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor() {
  mounted = render(() => <Editor selected={selection as never} />);
  await waitFor(() => expect(listening.ready).toBe(true));
}

async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(code?.activePath).toBe(path));
}

/** Close whatever is active, the way the palette's command does. */
async function closeActive() {
  const was = code?.activePath;
  emitWith(EDITOR_CLOSE_TAB, null);
  await waitFor(() => expect(code?.openPaths ?? []).not.toContain(was));
}

async function reopen(expected: string) {
  emitWith(EDITOR_REOPEN_CLOSED, null);
  await waitFor(() => expect(code?.activePath).toBe(expected));
}

const statsFor = (ws = REPO) => loadFrecency(Date.now())[ws] ?? {};

beforeEach(() => {
  code = null;
  listening.ready = false;
  localStorage.clear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("reopening the tab you just closed", () => {
  it("puts the last close back, then the one before it", async () => {
    await mountEditor();
    await open(`${REPO}/a.ts`);
    await open(`${REPO}/b.ts`);
    await closeActive();
    await open(`${REPO}/a.ts`);
    await closeActive();

    await reopen(`${REPO}/a.ts`);
    await reopen(`${REPO}/b.ts`);
  });

  it("does nothing when nothing has been closed", async () => {
    await mountEditor();
    await open(`${REPO}/a.ts`);

    emitWith(EDITOR_REOPEN_CLOSED, null);

    await waitFor(() => expect(code?.openPaths).toEqual([`${REPO}/a.ts`]));
  });

  // The tab comes back through `openFile`, the same path a tree click takes, so
  // `CodeEditor` swaps the kept buffer in and `reviveClosed` decides whether it
  // still describes the file. Nothing about the document is decided here.
  it("hands the path to the ordinary open, so the kept buffer is what answers", async () => {
    await mountEditor();
    await open(`${REPO}/a.ts`);
    await closeActive();

    await reopen(`${REPO}/a.ts`);

    expect(code?.openPaths).toEqual([`${REPO}/a.ts`]);
  });

  it("does not offer a synthetic view, which names a tab rather than a file", async () => {
    await mountEditor();
    await open(`${REPO}/a.ts`);
    emitWith(OPEN_IN_EDITOR, { path: `sway://commit/abc/${REPO}` });
    await waitFor(() => expect(code?.openPaths.length).toBe(1));
    await closeActive(); // closes the commit view

    emitWith(EDITOR_REOPEN_CLOSED, null);

    // Only the real file is still open, and nothing was put back.
    await waitFor(() => expect(code?.openPaths).toEqual([`${REPO}/a.ts`]));
  });

  it("follows a rename, so what comes back is the file under its new name", async () => {
    await mountEditor();
    await open(`${REPO}/old.ts`);
    await closeActive();

    emitWith(FILE_RENAMED, { from: `${REPO}/old.ts`, to: `${REPO}/new.ts` });

    await reopen(`${REPO}/new.ts`);
  });

  it("forgets a close that was trashed, rather than reopening nothing", async () => {
    await mountEditor();
    await open(`${REPO}/keep.ts`);
    await open(`${REPO}/doomed/x.ts`);
    await closeActive();

    emitWith(PURGE_UNDER_PATH, { path: `${REPO}/doomed` });
    emitWith(EDITOR_REOPEN_CLOSED, null);

    await waitFor(() => expect(code?.openPaths).toEqual([`${REPO}/keep.ts`]));
  });
});

describe("what the pickers rank by", () => {
  it("counts an open once", async () => {
    await mountEditor();
    await open(`${REPO}/a.ts`);
    await waitFor(() => expect(statsFor()[`${REPO}/a.ts`]).toMatchObject({ opens: 1, edits: 0 }));
  });

  // CodeEditor reports the dirty flag on every document change, so counting
  // them all would score a file by how much was typed into it.
  it("counts one edit per editing session, not per keystroke", async () => {
    await mountEditor();
    await open(`${REPO}/a.ts`);

    code!.onDirty(`${REPO}/a.ts`, true);
    code!.onDirty(`${REPO}/a.ts`, true);
    code!.onDirty(`${REPO}/a.ts`, true);

    await waitFor(() => expect(statsFor()[`${REPO}/a.ts`]).toMatchObject({ edits: 1 }));

    // Saving and editing again is a second session, and does count.
    code!.onDirty(`${REPO}/a.ts`, false);
    code!.onDirty(`${REPO}/a.ts`, true);
    await waitFor(() => expect(statsFor()[`${REPO}/a.ts`]).toMatchObject({ edits: 2 }));
  });

  it("never records a synthetic view, which no picker could offer", async () => {
    await mountEditor();
    emitWith(OPEN_IN_EDITOR, { path: `sway://commit/abc/${REPO}` });
    await waitFor(() => expect(screen.queryByText(/Open a file from the tree/)).toBeNull());

    expect(statsFor()).toEqual({});
  });

  it("follows a rename, so the record is not stranded on the old path", async () => {
    await mountEditor();
    await open(`${REPO}/old.ts`);
    await waitFor(() => expect(statsFor()[`${REPO}/old.ts`]).toBeTruthy());

    emitWith(FILE_RENAMED, { from: `${REPO}/old.ts`, to: `${REPO}/new.ts` });

    await waitFor(() => expect(statsFor()[`${REPO}/new.ts`]).toMatchObject({ opens: 1 }));
    expect(statsFor()[`${REPO}/old.ts`]).toBeUndefined();
  });

  it("forgets a trashed file, so no picker keeps offering it", async () => {
    await mountEditor();
    await open(`${REPO}/doomed/x.ts`);
    await waitFor(() => expect(statsFor()[`${REPO}/doomed/x.ts`]).toBeTruthy());

    emitWith(PURGE_UNDER_PATH, { path: `${REPO}/doomed` });

    await waitFor(() => expect(statsFor()[`${REPO}/doomed/x.ts`]).toBeUndefined());
  });
});
