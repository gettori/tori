import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import PaneView from "../../tabs/PaneView";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { tab } from "../../test/tabs";
import { pointerClick, rightClick } from "../../test/menus";
import { installAnimationFrame } from "../../test/frames";

// The tab strip's bulk-close rows.
//
// Every one of them is a list the menu computes and then hands to `closeTab`
// one entry at a time, so what can go wrong is the list: the wrong neighbours,
// the wrong order, or a dirty tab going without being asked about. The fixture
// is five tabs with two of them dirty and one of them a view, because that is
// the smallest arrangement where "others", "to the right" and "saved" all
// disagree with each other.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const A = `${REPO}/src/a.ts`;
const B = `${REPO}/src/b.ts`;
const C = `${REPO}/src/c.ts`;
const D = `${REPO}/src/d.ts`;

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
      case "git_file_history":
        return Promise.resolve([]);
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
const { syntheticId } = await import("../../utils/syntheticTabs");

const HIST = syntheticId("history", REPO, "src/a.ts");

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

const strip = () =>
  Array.from(document.querySelectorAll("[data-tab-id]")).map((t) => t.getAttribute("data-tab-id"));

async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(strip()).toContain(path));
}

/** Five tabs in strip order, `b.ts` and `c.ts` dirty and the last one a view. */
async function openFive() {
  await mountEditor();
  for (const p of [A, B, C, D, HIST]) await open(p);
  // The stage is lazy, so the strip can be drawn a tick before the thing that
  // reports a buffer dirty exists.
  await waitFor(() => expect(code).not.toBeNull());
  code!.onDirty!(B, true);
  code!.onDirty!(C, true);
  await waitFor(() => expect(strip()).toEqual([A, B, C, D, HIST]));
}

async function menuOn(name: string | RegExp) {
  rightClick(tab(name));
  await screen.findByRole("menu");
}

async function pick(label: string) {
  pointerClick(await screen.findByText(label));
}

/** Answer the discard prompt `n` times, which is how many dirty tabs the row
 *  was pointed at. Each is awaited, since the closes run one after another. */
async function discard(n: number) {
  for (let i = 0; i < n; i += 1) {
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Discard" })).toBeNull());
  }
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

describe("the tab menu's bulk closes", () => {
  it("closes every tab but the one clicked, asking about each dirty one", async () => {
    await openFive();

    await menuOn(/^a\.ts/);
    await pick("Close others");
    await discard(2);

    await waitFor(() => expect(strip()).toEqual([A]));
  });

  it("keeps a tab whose discard prompt was refused", async () => {
    // The prompt is the only thing between a reader and the edits they have
    // not saved, so a Cancel has to stop that tab and only that tab.
    await openFive();

    await menuOn(/^a\.ts/);
    await pick("Close others");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await discard(1);

    await waitFor(() => expect(strip()).toEqual([A, B]));
  });

  it("closes only what sits after the clicked tab", async () => {
    await openFive();

    await menuOn(/^b\.ts/);
    await pick("Close to the right");
    await discard(1);

    await waitFor(() => expect(strip()).toEqual([A, B]));
  });

  it("closes the saved tabs and leaves the dirty ones, the view counting as saved", async () => {
    await openFive();

    await menuOn(/^a\.ts/);
    await pick("Close saved");

    await waitFor(() => expect(strip()).toEqual([B, C]));
  });

  it("offers nothing to the right of the last tab", async () => {
    await openFive();

    await menuOn(/^History: a\.ts/);

    const row = (await screen.findByText("Close to the right")).closest("[role=menuitem]");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("the tab menu's path rows", () => {
  it("offers them on a file tab", async () => {
    await openFive();

    await menuOn(/^a\.ts/);

    expect(await screen.findByText("Copy path")).toBeTruthy();
    expect(screen.getByText("Copy relative path")).toBeTruthy();
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
  });

  it("offers none of them on a view, which names no file on disk", async () => {
    await openFive();

    await menuOn(/^History: a\.ts/);

    expect(await screen.findByText("Close others")).toBeTruthy();
    expect(screen.queryByText("Copy path")).toBeNull();
    expect(screen.queryByText("Copy relative path")).toBeNull();
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
  });
});
