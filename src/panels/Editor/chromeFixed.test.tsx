import { describe, it, expect, vi, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { render, screen, waitFor } from "@solidjs/testing-library";

// The editor chrome as fixed furniture (plan phase 7): it portals into its own
// stage host beside the pane. Reordering tabs rewrites the pane's strip; the
// chrome must keep the same nodes, parent, and width key across the move.

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
let code: { activePath: string | null } | null = null;
vi.mock("./CodeEditor", () => ({
  default: (p: { activePath: string | null }) => {
    code = p;
    return null;
  },
}));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR } = await import("../../utils/events");
const { kindEntry } = await import("../../tabs/registry");

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

let mounted: ReturnType<typeof render> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  localStorage.clear();
});

async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(code?.activePath).toBe(path));
}

describe("the editor chrome across tab moves", () => {
  it("keeps the same chrome nodes in the same parent when tabs reorder", async () => {
    mounted = render(() => (
      <>
        <Editor selected={selection as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(listening.ready).toBe(true));
    await open(`${REPO}/src/a.ts`);
    await open(`${REPO}/src/b.ts`);

    const chrome = document.querySelector('[class*="rightPanel"]')!;
    expect(chrome).toBeTruthy();
    const chromeParent = chrome.parentElement;
    const main = document.querySelector('[class*="editorMain"]')!;

    // The same rewrite PaneView's strip issues on a drag: this workspace's
    // list, reversed.
    const entry = kindEntry("file");
    entry.stripReorder!([...entry.stripItems!()].reverse());
    await waitFor(() => {
      const tabs = screen.getAllByRole("tab").map((t) => t.textContent ?? "");
      const at = (name: string) => tabs.findIndex((t) => t.includes(name));
      expect(at("b.ts")).toBeLessThan(at("a.ts"));
    });

    expect(document.querySelector('[class*="rightPanel"]')).toBe(chrome);
    expect(chrome.parentElement).toBe(chromeParent);
    expect(document.querySelector('[class*="editorMain"]')).toBe(main);
  });

  it("still reads its width from tori.editor.rightw.v1", async () => {
    localStorage.setItem("tori.editor.rightw.v1", "231");
    mounted = render(() => (
      <>
        <Editor selected={selection as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(listening.ready).toBe(true));
    const chrome = document.querySelector<HTMLElement>('[class*="rightPanel"]')!;
    expect(chrome.style.width).toBe("231px");
  });
});
