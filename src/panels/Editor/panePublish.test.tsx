// What the rest of the app calls "the active file" once two panes can each hold
// one (plan phase 9 task 5): the focused pane's. The palette's enablement, the
// git commands and the breadcrumb all read the same published snapshot, so this
// asserts the snapshot follows pane focus.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, waitFor } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const invokes: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
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
// The buffers are CodeEditor's; this suite is about what the pane publishes.
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR } = await import("../../utils/events");
const { editorState } = await import("../../utils/editorState");
const { ensureEnvelope, resetPaneLayoutModel, seedTwoPane, setFocusedPane } = await import("../../layout/layoutStore");
const { moveTabToPane, resetTabPlacement } = await import("../../layout/tabPlacement");
const { envelopeFor } = await import("../../layout/layoutStore");

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};
const seed = () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true });
const A = `${REPO}/src/a.ts`;
const B = `${REPO}/src/b.ts`;

let mounted: ReturnType<typeof render> | null = null;

beforeEach(() => {
  localStorage.clear();
  invokes.length = 0;
  listening.ready = false;
  resetPaneLayoutModel();
  resetTabPlacement();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the published editor state", () => {
  it("names the file in the focused pane, and follows focus to the other one", async () => {
    mounted = render(() => <Editor selected={selection as never} />);
    await waitFor(() => expect(listening.ready).toBe(true));
    ensureEnvelope(REPO, seed);
    emitWith(OPEN_IN_EDITOR, { path: A });
    emitWith(OPEN_IN_EDITOR, { path: B });
    await waitFor(() => expect(editorState().tabCount).toBe(2));

    // a.ts moves to the left pane; b.ts stays where files open.
    const root = envelopeFor(REPO, seed).layout;
    expect(
      moveTabToPane({
        ws: REPO,
        tab: { id: A, kind: "file" },
        targetPaneId: "left",
        root,
        tabsInWs: [
          { id: A, kind: "file" },
          { id: B, kind: "file" },
        ],
      }),
    ).toBeNull();

    setFocusedPane(REPO, "left");
    await waitFor(() => expect(editorState().activePath).toBe(A));

    setFocusedPane(REPO, "right");
    await waitFor(() => expect(editorState().activePath).toBe(B));
  });
});
