// Relaunching into a stash: what the tab strip shows before any buffer exists.
//
// The pane's own half (rebuilding a buffer from a stashed state) is covered in
// `hotExit.test.tsx` against the real `CodeEditor`. This is the other half, and
// it belongs to `Editor.tsx`: the restore is deliberately lazy, so all but one
// of those files has no buffer at all, and the dirty dots have to come from the
// stash rather than from a buffer that will not exist until somebody clicks.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEffect } from "solid-js";
import { render, screen, waitFor } from "@solidjs/testing-library";

import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorHarness";

installResizeObserver();

const REPO = "/space/proj/main";
const FILES = [`${REPO}/a.txt`, `${REPO}/b.txt`, `${REPO}/c.txt`];

/** Which paths still exist on disk. */
let onDisk = new Set(FILES);
/** What the backend's hot-exit file holds. */
let stashOnDisk: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "file_exists":
        return Promise.resolve(onDisk.has(String(args.path)));
      case "hot_exit_load":
        return Promise.resolve(stashOnDisk);
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "git_status":
      case "list_branches":
      case "fs_read_dir":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
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

// Every path the pane was ever asked to show. One entry means the restore
// stayed lazy: only the active tab's buffer is built, the rest are descriptors.
const shown: string[] = [];
vi.mock("./CodeEditor", () => ({
  default: (props: { activePath: string | null }) => {
    createEffect(() => {
      if (props.activePath) shown.push(props.activePath);
    });
    return null;
  },
}));
vi.mock("./lspClient", () => ({ ensureLsp: () => {} }));

const { default: Editor } = await import("./Editor");
const { clearPendingStash, pendingStashPaths } = await import("../../utils/hotExit");

const entry = (savedText: string) => ({ savedText, state: { doc: `${savedText} edited` }, savedAt: Date.now() });

let mounted: ReturnType<typeof render> | null = null;

/** Seed the tab store the way last run's quit would have left it. */
function storeTabs(paths: string[], active: string) {
  localStorage.setItem(
    "sway.editor.tabs.v1",
    JSON.stringify({ [REPO]: { paths, active, savedAt: Date.now() } }),
  );
}

async function relaunch() {
  mounted = render(() => <Editor selected={selectionFor(REPO) as never} />);
  await waitFor(() => expect(listening.ready).toBe(true));
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
}

/** How many tabs are wearing a dirty dot. */
function dirtyDots(): number {
  return mounted!.container.querySelectorAll(".tab-dirty").length;
}

/** The close button on the tab whose label is `name`. */
function closeTabFor(name: string): HTMLElement {
  const tab = [...mounted!.container.querySelectorAll("[role='tab'], button")].find((el) =>
    el.textContent?.includes(name),
  )!;
  return tab.querySelector<HTMLElement>('[aria-label="Close"]') ?? tab.parentElement!.querySelector('[aria-label="Close"]')!;
}

beforeEach(() => {
  localStorage.clear();
  onDisk = new Set(FILES);
  stashOnDisk = {};
  shown.length = 0;
  listening.ready = false;
  clearPendingStash();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("relaunching with unsaved work stashed", () => {
  it("marks every stashed tab dirty while building only one buffer", async () => {
    storeTabs(FILES, FILES[0]);
    stashOnDisk = Object.fromEntries(FILES.map((p) => [p, entry(`${p} on disk`)]));

    await relaunch();

    // Both waits matter, and for opposite reasons: the pane is behind `lazy()`
    // so it mounts a tick after the tabs do, and asserting the lazy restore
    // before it has mounted would pass against an empty list.
    await waitFor(() => expect(dirtyDots()).toBeGreaterThan(0));
    await waitFor(() => expect(shown.length).toBeGreaterThan(0));

    // One dot per stashed tab, before any of their buffers exist.
    expect(dirtyDots()).toBe(FILES.length);
    // The lazy restore is intact: nothing was opened but the active tab, so two
    // of these three files have not been read at all yet.
    expect(new Set(shown)).toEqual(new Set([FILES[0]]));
  });

  it("leaves the tabs clean when there is nothing stashed", async () => {
    storeTabs(FILES, FILES[0]);

    await relaunch();

    await waitFor(() => expect(shown.length).toBeGreaterThan(0));
    expect(dirtyDots()).toBe(0);
  });

  it("marks only the tabs that actually carry unsaved work", async () => {
    storeTabs(FILES, FILES[0]);
    stashOnDisk = { [FILES[1]]: entry("only this one") };

    await relaunch();

    await waitFor(() => expect(dirtyDots()).toBeGreaterThan(0));
    expect(dirtyDots()).toBe(1);
  });

  it("restores a tab whose file has since been deleted", async () => {
    // Without this the tab is dropped as dead and the stash entry has nowhere
    // to land, which loses the only copy of that text.
    storeTabs(FILES, FILES[0]);
    onDisk = new Set([FILES[0]]);
    stashOnDisk = { [FILES[2]]: entry("the only copy") };

    await relaunch();

    await waitFor(() => expect(dirtyDots()).toBeGreaterThan(0));
    expect(screen.getAllByText("c.txt").length).toBeGreaterThan(0);
  });

  it("forgets a stashed tab that was closed on the discard confirm", async () => {
    // The tab never had a buffer, so nothing claimed its entry. Left pending it
    // would ride through the next quit's merge and be handed back on the launch
    // after that, which turns "the edits in this tab will be lost" into a lie
    // one relaunch later.
    storeTabs(FILES, FILES[0]);
    stashOnDisk = { [FILES[1]]: entry("about to be discarded") };
    await relaunch();
    await waitFor(() => expect(dirtyDots()).toBe(1));

    // Closed from the strip rather than through the palette's close-active
    // command: the tab carrying the stash is deliberately *not* the active one,
    // because the one that never gets focus is the one with no buffer to claim
    // its entry.
    closeTabFor("b.txt").click();
    await waitFor(() => expect(screen.getByText("Discard")).toBeTruthy());
    screen.getByText("Discard").click();

    await waitFor(() => expect(pendingStashPaths()).toEqual([]));
  });

  it("still drops a deleted file that had nothing stashed", async () => {
    // The existing rule, unchanged: a tab whose buffer could only ever report
    // that it failed to open is worse than no tab.
    storeTabs(FILES, FILES[0]);
    onDisk = new Set([FILES[0]]);

    await relaunch();

    await waitFor(() => expect(shown.length).toBeGreaterThan(0));
    expect(screen.queryByText("c.txt")).toBeNull();
  });
});
