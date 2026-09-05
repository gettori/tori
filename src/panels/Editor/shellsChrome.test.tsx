// In Shells the editor draws no right panel and offers no "show the tree"
// button: there is no folder behind the selection to draw a tree of. The flag
// itself is left alone, so a folder coming back finds the tree as the user had it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSignal } from "solid-js";
import PaneView from "../../tabs/PaneView";
import { render, waitFor } from "@solidjs/testing-library";

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
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { shellsSelection } = await import("../../utils/features");
type Selection = import("../LeftSidebar/LeftSidebar").Selection;

const unit = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
} as unknown as Selection;

const rightPanel = () => document.querySelector<HTMLElement>('[class*="rightPanel"]')!;
const isHidden = (el: HTMLElement) => [...el.classList].some((c) => c.includes("hidden"));
const revealButton = () => document.querySelector('[aria-label^="Show the file tree"]');

let mounted: ReturnType<typeof render> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  localStorage.clear();
});

describe("the editor chrome in Shells", () => {
  it("hides the right panel and the tree reveal while Shells is selected, and restores them on the way out", async () => {
    const [selected, setSelected] = createSignal<Selection>(shellsSelection());
    let toggles = 0;
    mounted = render(() => (
      <>
        <Editor selected={selected()} showFiletree={true} onToggleFiletree={() => toggles++} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(listening.ready).toBe(true));

    // The flag says shown; Shells overrides it without writing it back.
    expect(isHidden(rightPanel())).toBe(true);
    expect(revealButton()).toBeNull();

    setSelected(unit);
    await waitFor(() => expect(isHidden(rightPanel())).toBe(false));
    expect(toggles).toBe(0);
  });

  it("still offers the reveal in a folder whose tree the user hid", async () => {
    mounted = render(() => (
      <>
        <Editor selected={unit} showFiletree={false} onToggleFiletree={() => {}} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(listening.ready).toBe(true));
    expect(isHidden(rightPanel())).toBe(true);
    await waitFor(() => expect(revealButton()).toBeTruthy());
  });
});
