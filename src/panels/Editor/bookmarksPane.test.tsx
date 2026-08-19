import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { tab, closeOf } from "../../test/tabs";
import { installAnimationFrame } from "../../test/frames";

// Bookmarks from the pane's side.
//
// `bookmarks.ts` owns the rules and `bookmarkGutter.ts` owns the positions; both
// are tested on their own. This is the part neither can see: that a mark made in
// the gutter reaches the panel, that it survives the tab closing and reopening,
// and that the pane's rename and trash sweeps reach it the way they already
// reach the jump list.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// The tab strip corrects its visible count in a frame, and these read tabs off
// the row it draws. Without this the row is still seeded empty.
installAnimationFrame();

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/a.ts`;

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

// The real editor is all of CodeMirror and owns none of this. The stand-in is
// how this suite plays back the one gesture that makes a bookmark.
type CodeProps = {
  activePath: string | null;
  bookmarks?: readonly { line: number; label?: string }[];
  onToggleBookmark?: (path: string, line: number) => void;
  onBookmarksMoved?: (path: string, marks: { line: number; label?: string }[], docLines: number) => void;
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
const { emitWith, OPEN_IN_EDITOR, FILE_RENAMED, PURGE_UNDER_PATH } = await import("../../utils/events");

const selectionFor = (folderPath: string) => ({
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath,
  branch: "main",
  projectKind: "plain",
});

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor() {
  const [selected] = createSignal<unknown>(selectionFor(REPO));
  mounted = render(() => (
      <>
        <Editor selected={selected() as never} />
        <PaneView pinKind="file" />
      </>
    ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

/** Arrive at a file, the way the tree or a picker does. */
async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(code?.activePath).toBe(path));
}

/** Click the gutter, as far as the pane is concerned. */
function mark(path: string, line: number) {
  code!.onToggleBookmark!(path, line);
}

const showPanel = () => fireEvent.click(tab("Bookmarks"));

beforeEach(() => {
  code = null;
  listening.ready = false;
  localStorage.clear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  localStorage.clear();
});

describe("bookmarks, from the pane", () => {
  it("shows a marked line in the panel and hands it back to the editor", async () => {
    await mountEditor();
    await open(FILE);
    mark(FILE, 12);
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 12 }]));
    showPanel();
    // By role, because the tab strip is showing the same file name a few
    // pixels away and only the row says which line.
    expect(screen.getByRole("button", { name: /a\.ts:12/ })).toBeTruthy();
  });

  it("offers the tab before anything is marked, since that is where the gesture is explained", async () => {
    await mountEditor();
    showPanel();
    expect(screen.getByText(/Click the gutter beside a line to mark it/)).toBeTruthy();
  });

  it("keeps a mark after the file is closed and opened again", async () => {
    await mountEditor();
    await open(FILE);
    mark(FILE, 12);
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 12 }]));
    // Closing the tab takes the buffer with it; the mark belongs to the
    // workspace, not to the buffer. Scoped to the drawn tab: the measuring
    // ghost carries a close affordance of the same name.
    fireEvent.click(closeOf("a.ts"));
    await waitFor(() => expect(code?.activePath).toBe(null));
    await open(FILE);
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 12 }]));
  });

  it("takes a mark away when the same line is clicked again", async () => {
    await mountEditor();
    await open(FILE);
    mark(FILE, 12);
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 12 }]));
    mark(FILE, 12);
    await waitFor(() => expect(code?.bookmarks).toEqual([]));
  });

  it("follows a rename to the new path", async () => {
    const moved = `${REPO}/src/renamed.ts`;
    await mountEditor();
    await open(FILE);
    mark(FILE, 12);
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 12 }]));

    emitWith(FILE_RENAMED, { from: FILE, to: moved });
    showPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: /renamed\.ts:12/ })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /a\.ts:12/ })).toBeNull();
  });

  it("leaves no orphan behind when the file is trashed", async () => {
    await mountEditor();
    await open(FILE);
    mark(FILE, 12);
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 12 }]));

    // The folder, not the file: a trash sweeps everything under a path, and a
    // mark on a file with no tab left holding it is exactly the dangling
    // reference the sweep exists to stop.
    emitWith(PURGE_UNDER_PATH, { path: `${REPO}/src` });
    showPanel();
    await waitFor(() =>
      expect(screen.getByText(/Click the gutter beside a line to mark it/)).toBeTruthy(),
    );
  });

  it("keeps a mark the buffer is currently too short to hold", async () => {
    // A checkout or a revert can leave a file shorter than it was when a mark
    // was made. The buffer cannot report a mark past its own end, so taking its
    // answer as the whole truth would delete one on the next keystroke, and
    // nothing else holds a copy.
    await mountEditor();
    await open(FILE);
    mark(FILE, 12);
    mark(FILE, 400);
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 12 }, { line: 400 }]));

    // What a 40-line buffer reports after an edit moved the mark it can see.
    code!.onBookmarksMoved!(FILE, [{ line: 14 }], 40);
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 14 }, { line: 400 }]));
  });

  it("keeps each workspace's marks to itself", async () => {
    await mountEditor();
    await open(FILE);
    mark(FILE, 12);
    // A file in another worktree, marked at the same line: the pane buckets by
    // workspace, so the visible one must not inherit it.
    await waitFor(() => expect(code?.bookmarks).toEqual([{ line: 12 }]));
    const other = "/space/proj/feature/src/a.ts";
    await open(other);
    await waitFor(() => expect(code?.activePath).toBe(other));
    // Still this workspace's list: the file is outside the root but the pane's
    // bucket is the selected folder, so the mark on the other path is not in it.
    expect(code?.bookmarks).toEqual([]);
  });
});
