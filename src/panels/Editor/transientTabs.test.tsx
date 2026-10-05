import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import PaneView from "../../tabs/PaneView";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { tab } from "../../test/tabs";
import { installAnimationFrame } from "../../test/frames";

// The pane's one replaceable tab.
//
// Reading a pull request is walking a list of files, and a tab per row leaves a
// strip nobody can read by the time the review is written. One slot answers
// that, and what this suite watches is the two halves that are easy to get
// wrong: the replacement landing where the old tab was, and everything that
// says "I am staying with this file" keeping it.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const A = `${REPO}/src/a.ts`;
const B = `${REPO}/src/b.ts`;
const KEPT = `${REPO}/src/kept.ts`;

installAnimationFrame();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "fs_read_file":
        return Promise.resolve("");
      case "file_exists":
        return Promise.resolve(true);
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
  onDirty?: (path: string, dirty: boolean) => void;
};
let code: CodeProps | null = null;
vi.mock("./CodeEditor", () => ({
  default: (p: CodeProps) => {
    code = p;
    return null;
  },
}));
vi.mock("./lspClient", () => ({
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR } = await import("../../utils/events");

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
  mounted = render(() => (
    <>
      <Editor selected={selection as never} />
      <PaneView pinKind="file" />
    </>
  ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

/** The pane strip's tabs, in the order it draws them. By `data-tab-id`, which
 *  only a unified tab carries: the right pane's own section tabs are `role=tab`
 *  too, and the bar's measuring ghosts are not tabs at all. */
const strip = () => Array.from(document.querySelectorAll("[data-tab-id]")).map((t) => t.getAttribute("data-tab-id"));

async function open(path: string, slot = false) {
  emitWith(OPEN_IN_EDITOR, slot ? { path, preview: true } : { path });
  await waitFor(() => expect(code?.activePath).toBe(path));
}

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

describe("the pane's replaceable tab", () => {
  it("takes over the last transient tab's place rather than adding one", async () => {
    // A pinned tab after it, so this asserts the slot and not merely the count:
    // appending the replacement would put it on the far side of `kept.ts`, and
    // a reader clicking down a file list would watch the tab they are reading
    // move on every click.
    await mountEditor();
    await open(A, true);
    await open(KEPT);
    await waitFor(() => expect(strip()).toEqual([A, KEPT]));

    await open(B, true);

    await waitFor(() => expect(strip()).toEqual([B, KEPT]));
    // And the closed one is gone from the pane, not merely hidden: the strip is
    // `paneTabs`, so a stale id would still be drawn here.
    expect(screen.queryAllByRole("tab", { name: /a\.ts/ })).toHaveLength(0);
    expect(code?.openPaths).not.toContain(A);
  });

  it("says which tab is the replaceable one", async () => {
    await mountEditor();
    await open(A, true);
    await open(KEPT);

    await waitFor(() => expect(tab(/a\.ts/).getAttribute("data-transient")).toBe(""));
    expect(tab(/kept\.ts/).getAttribute("data-transient")).toBeNull();
  });

  it("keeps the tab a double click asked to keep", async () => {
    await mountEditor();
    await open(A, true);
    await waitFor(() => expect(tab(/a\.ts/).getAttribute("data-transient")).toBe(""));

    fireEvent.dblClick(tab(/a\.ts/));
    await waitFor(() => expect(tab(/a\.ts/).getAttribute("data-transient")).toBeNull());

    await open(B, true);
    await waitFor(() => expect(strip()).toEqual([A, B]));
  });

  it("keeps the tab the moment somebody types in it", async () => {
    // The sharpest case: without this the next row opened would close a buffer
    // with unsaved edits in it, and the dirty prompt is the only thing that
    // would have stood between the reader and losing them.
    await mountEditor();
    await open(A, true);
    code!.onDirty!(A, true);
    await waitFor(() => expect(tab(/a\.ts/).getAttribute("data-transient")).toBeNull());

    await open(B, true);
    await waitFor(() => expect(strip()).toEqual([A, B]));
  });

  it("reveals a file that is already open rather than taking the slot for it", async () => {
    // Its own tab already exists, so spending the slot on it would put one file
    // on screen twice and throw away whatever was in the slot.
    await mountEditor();
    await open(KEPT);
    await open(A, true);
    await waitFor(() => expect(strip()).toEqual([KEPT, A]));

    await open(KEPT, true);

    await waitFor(() => expect(code?.activePath).toBe(KEPT));
    expect(strip()).toEqual([KEPT, A]);
    expect(tab(/a\.ts/).getAttribute("data-transient")).toBe("");
  });

  it("brings a tab back from the last launch kept, not passing through", async () => {
    // The restore reads paths and nothing else, which is what makes this true;
    // a tab that survived a relaunch is not one somebody is glancing at, and
    // coming back replaceable would have the first PR file row close it.
    localStorage.setItem(
      "tori.editor.tabs.v1",
      JSON.stringify({ [REPO]: { paths: [A], active: A, savedAt: Date.now() } }),
    );
    await mountEditor();

    await waitFor(() => expect(strip()).toEqual([A]));
    expect(tab(/a\.ts/).getAttribute("data-transient")).toBeNull();
  });

  it("leaves every other opener appending a tab", async () => {
    // Only the pull request's file rows ask for the slot. A file tree open that
    // quietly replaced the last one would lose the tab somebody opened from it.
    await mountEditor();
    await open(A);
    await open(B);

    await waitFor(() => expect(strip()).toEqual([A, B]));
    expect(tab(/a\.ts/).getAttribute("data-transient")).toBeNull();
    expect(tab(/b\.ts/).getAttribute("data-transient")).toBeNull();
  });
});
