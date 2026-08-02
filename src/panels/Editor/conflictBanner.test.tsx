import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";

// The conflict banner: the editor's half of the Conflicts section. Nothing in a
// buffer full of `<<<<<<<` markers says *why* it looks like that, and the
// Changes panel that does say so is on the other side of the window (and often
// closed). Both read the same store, so what is tested here is the wiring: that
// the banner tracks the open tab and the current workspace, and that it goes
// away on its own when the file stops being conflicted.

import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorHarness";

installResizeObserver();

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/a.ts`;
const OTHER = `${REPO}/src/b.ts`;

type Row = { status: string; path: string; staged: boolean; unstaged: boolean; conflicted?: boolean };
const CONFLICT: Row = { status: "UU", path: "src/a.ts", staged: false, unstaged: false, conflicted: true };
const RESOLVED: Row = { status: "M ", path: "src/a.ts", staged: true, unstaged: false, conflicted: false };

let statusRows: Row[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "git_status":
        return Promise.resolve(statusRows);
      case "list_branches":
      case "fs_read_dir":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
      case "file_exists":
        return Promise.resolve(String(args.path) === FILE || String(args.path) === OTHER);
      case "get_docs_root":
        return Promise.reject("no docs root");
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
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({ ensureLsp: () => {} }));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR } = await import("../../utils/events");
const { refreshStatus } = await import("../../utils/gitActions");

const selection = selectionFor(REPO);
const BANNER = /Merge conflict/;

let mounted: ReturnType<typeof render> | null = null;

async function mountWith(path: string) {
  mounted = render(() => <Editor selected={selection as never} />);
  await waitFor(() => expect(listening.ready).toBe(true));
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
}

beforeEach(async () => {
  // The git store outlives any one mount, so the previous test's file list
  // would otherwise still be loaded. Selecting nothing is the app's own reset.
  await refreshStatus(null);
  statusRows = [];
  listening.ready = false;
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the conflict banner", () => {
  it("is up as soon as a conflicted file is opened", async () => {
    statusRows = [CONFLICT];
    await mountWith(FILE);

    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());
  });

  it("clears itself once the file is marked resolved", async () => {
    // `git add` on an unmerged path is what marking resolved means. The banner
    // watches the store rather than the buffer, so it goes on the next status
    // read - no save, no reopen, and nothing for the resolve path to remember.
    statusRows = [CONFLICT];
    await mountWith(FILE);
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());

    statusRows = [RESOLVED];
    await refreshStatus(REPO);

    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
  });

  it("stays off a file that is not the conflicted one", async () => {
    // The store lists paths, not the open file, so a banner that only asked
    // "is anything conflicted" would sit on every tab in the workspace.
    statusRows = [CONFLICT];
    await mountWith(OTHER);

    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("says nothing while the store describes another workspace", async () => {
    // The store blanks and refills on a workspace switch, so between the two
    // its file list belongs to the workspace being left. Answering from it
    // would flag a file here because a file *there* is conflicted.
    statusRows = [CONFLICT];
    await mountWith(FILE);
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());

    await refreshStatus("/space/proj/other");

    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
  });
});
