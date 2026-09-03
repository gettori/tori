// One pane shows one thing. In the single-pane default the file home *is* the
// only pane, so the editor column has to stand down while a terminal tab is the
// one on screen. Otherwise both surfaces are flex children of the same stage
// and split it down the middle, with "Open a file from the tree" sitting beside
// a half-width xterm.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorAgent";

installResizeObserver();

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
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR } = await import("../../utils/events");
const { ensureEnvelope, resetPaneLayoutModel, seedOnePane } = await import("../../layout/layoutStore");
const { registerKind } = await import("../../tabs/registry");
const { setPaneActive } = await import("../../layout/tabPlacement");
const { unifiedTabs } = await import("../../tabs/unifiedTabs");
const store = await import("../Terminal/terminalTabStore");

// Enough of the terminal's descriptor for a pane to resolve its pick: the panel
// itself is not the subject, but which tab it calls visible is what makes the
// pane show a terminal rather than a file.
registerKind("shell", {
  icon: () => undefined,
  title: (u) => u.id,
  tooltip: (u) => u.id,
  renderMenuItem: (u) => <span>{u.id}</span>,
  activate: () => {},
  close: () => {},
  stripItems: () => unifiedTabs().filter((u) => u.kind === "shell"),
  stripActiveId: store.visibleId,
  hostIds: (_paneId, tabs) => tabs.map((t) => t.id),
});

const selection = selectionFor(REPO);

let mounted: ReturnType<typeof render> | null = null;

/** The column's own box, which is what carries the hidden class. */
const column = () => document.querySelector('[class*="editorMain"]')!;
const columnHidden = () => /hidden/.test(column().className);

function openShellTab(id: string) {
  store.setOpen([
    { id, title: "zsh", cwd: REPO, workspace: REPO, kind: "shell", program: "/bin/zsh", args: [] },
  ]);
  store.focusTab(REPO, id);
}

beforeEach(() => {
  localStorage.clear();
  listening.ready = false;
  resetPaneLayoutModel();
  store.resetTerminalTabModel();
  ensureEnvelope(REPO, seedOnePane);
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  store.resetTerminalTabModel();
  localStorage.clear();
});

async function mountEditor() {
  mounted = render(() => <Editor selected={selection as never} />);
  await waitFor(() => expect(listening.ready).toBe(true));
}

describe("the editor column in the pane a terminal tab is showing", () => {
  it("fills the pane, note and all, while the pane has nothing else on screen", async () => {
    await mountEditor();
    expect(screen.queryByText(EMPTY_PANE)).toBeTruthy();
    expect(columnHidden()).toBe(false);
  });

  it("stands down when the pane's active tab is a terminal", async () => {
    openShellTab("sh:1");
    await mountEditor();
    await waitFor(() => expect(columnHidden()).toBe(true));
  });

  it("comes back when the pane's pick returns to a file tab", async () => {
    openShellTab("sh:1");
    await mountEditor();
    await waitFor(() => expect(columnHidden()).toBe(true));

    const path = `${REPO}/src/a.ts`;
    emitWith(OPEN_IN_EDITOR, { path });
    await waitFor(() => expect(columnHidden()).toBe(false));

    // Back to the shell, the way a click on its tab gets there: the strip
    // records the pane's pick and the panel focuses the tab.
    setPaneActive(REPO, "main", "sh:1");
    store.focusTab(REPO, "sh:1");
    await waitFor(() => expect(columnHidden()).toBe(true));
  });
});
