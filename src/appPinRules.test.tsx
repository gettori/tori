// Pin rules and pane locks through the shell (plan phase 11 tasks 2, 3 and 4).
// A rule says which end of the split a family of tabs opens at, a lock says a
// pane takes one kind and nothing else, and neither may disturb what is already
// on screen. Same stubbed panels as appSplits: registered descriptors over the
// real stores, so this is about the shell.
import { describe, it, expect, vi, afterEach, beforeEach } from "vite-plus/test";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("./panels/LeftSidebar/LeftSidebar", () => ({ default: () => <div /> }));
vi.mock("./panels/Settings/Settings", () => ({ default: () => <div /> }));
vi.mock("./components/Toolbar/Toolbar", () => ({ default: () => <div /> }));
vi.mock("./components/UpdatePill/UpdatePill", () => ({ default: () => <div /> }));
vi.mock("./components/Omnibox/Omnibox", () => ({ default: () => <div /> }));

vi.mock("./panels/Terminal/Terminal", async () => {
  const { registerKind } = await import("./tabs/registry");
  const store = await import("./panels/Terminal/terminalTabStore");
  const { unifiedTabs } = await import("./tabs/unifiedTabs");
  return {
    default: () => {
      for (const kind of ["shell", "agent", "command", "chat", "task"] as const) {
        registerKind(kind, {
          icon: () => undefined,
          title: (u) => u.id,
          tooltip: (u) => u.id,
          renderMenuItem: (u) => <span>{u.id}</span>,
          activate: (u) => store.focusTab(u.workspace, u.id),
          close: () => {},
          stripItems: () =>
            unifiedTabs().filter((u) => u.kind !== "file" && u.workspace === store.activeWorkspace()),
          stripActiveId: store.visibleId,
          stripReorder: () => {},
          hostIds: () => store.open().map((t) => t.id),
        });
      }
      return null;
    },
  };
});
vi.mock("./panels/Editor/Editor", async () => {
  const { registerKind } = await import("./tabs/registry");
  const store = await import("./panels/Editor/editorTabStore");
  const { unifiedTabs } = await import("./tabs/unifiedTabs");
  return {
    default: () => {
      registerKind("file", {
        icon: () => undefined,
        title: (u) => u.id,
        tooltip: (u) => u.id,
        renderMenuItem: (u) => <span>{u.id}</span>,
        activate: () => {},
        close: () => {},
        stripItems: () => unifiedTabs().filter((u) => u.kind === "file"),
        stripActiveId: () => store.activeByWs()[REPO] ?? null,
        stripReorder: () => {},
        hostIds: (paneId, tabs) =>
          paneId === null ? ["editor-stage"] : tabs.length ? [`editor-stage:${paneId}`] : [],
      });
      return null;
    },
  };
});

import { DEFAULT_SETTINGS } from "./panels/Settings/settingsStore";
import { emitWith, MOVE_TAB_TO_PANE, type MoveTabToPane } from "./utils/events";
import { setOpen, setActiveWorkspace, setActiveByWorkspace, open } from "./panels/Terminal/terminalTabStore";
import { setTabsByWs, setActiveByWs } from "./panels/Editor/editorTabStore";
import { paneMenuItems } from "./tabs/paneTabs";
import { paneLock } from "./layout/tabPlacement";
import { resetPinRules } from "./layout/pinRules";
import { saveSettings } from "./panels/Settings/settingsStore";

const REPO = "/space/proj/main";
const { default: App } = await import("./App");
const { storeTwoPanes } = await import("./test/panes");

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const term = (id: string) => ({
  id,
  title: id,
  cwd: REPO,
  workspace: REPO,
  kind: "shell" as const,
  program: "",
  args: [] as string[],
  profile: null,
});

const pane = (n: number) => document.querySelectorAll<HTMLElement>(".work-split .pane")[n];
const tabsIn = (el: HTMLElement) => within(el).queryAllByRole("tab").map((t) => t.textContent ?? "");
const A = `${REPO}/a.ts`;

/** The built-in settings, taken before anything saves. The store proxies
 *  `DEFAULT_SETTINGS` itself, so a save rewrites that very object (the store
 *  says so where it copies the editor block for the same reason) and a "reset
 *  to defaults" read from it later would hand back the last test's answer. */
const PRISTINE = structuredClone(DEFAULT_SETTINGS);

/** What the backend answers with, so a test can change a pin rule the way the
 *  settings panel does: write the file, and the store reads it back. */
let stored = structuredClone(PRISTINE);

const click = (items: ReturnType<typeof paneMenuItems>, label: string) => {
  const item = items.find((i) => "label" in i && i.label === label);
  expect(item, `no menu row labelled "${label}"`).toBeTruthy();
  if (item && "onClick" in item) item.onClick();
};

beforeEach(async () => {
  localStorage.clear();
  // This suite is about two panes; the shell seeds one (plan phase 12).
  storeTwoPanes(REPO);
  localStorage.setItem(
    "tori.selection.v1",
    JSON.stringify({
      spaceName: "space",
      projectName: "proj",
      projectPath: "/space/proj",
      folderPath: REPO,
      branch: "main",
      projectKind: "plain",
    }),
  );
  stored = structuredClone(PRISTINE);
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_settings") return stored;
    if (cmd === "set_settings") {
      stored = args.settings as typeof stored;
      return stored;
    }
    if (cmd === "list_user_themes") return { themes: [], errors: [] };
    return null;
  });
  // The settings store and the pin rules are both module singletons: a test
  // that changed a rule would otherwise hand the next one its answer.
  await saveSettings(structuredClone(PRISTINE));
  resetPinRules();
  setOpen([term("sh:1"), term("sh:2")]);
  setActiveWorkspace(REPO);
  setActiveByWorkspace({ [REPO]: "sh:1" });
  setTabsByWs({ [REPO]: [{ path: A, name: "a.ts" }] });
  setActiveByWs({ [REPO]: A });
});

// Unmounted by hand: this file mounts the shell once per test and the model
// under it is module state, so a second App beside the first would leave two of
// them writing one layout.
afterEach(cleanup);

describe("where a new tab lands", () => {
  it("follows the rule the user set, without moving what is already open", async () => {
    render(() => <App />);
    await waitFor(() => expect(tabsIn(pane(0))).toEqual(["sh:1", "sh:2"]));

    // The settings panel writes the whole file; the store reads it back and the
    // shell pushes the new rules into the layout layer.
    await saveSettings({ ...stored, panePins: { ...stored.panePins, terminal: "rightmost" } });

    // Nothing moved: the two terminals were never assigned a pane by hand, and
    // a rule change is not a reason to carry them across the window.
    await waitFor(() => expect(tabsIn(pane(0))).toEqual(["sh:1", "sh:2"]));
    expect(tabsIn(pane(1))).toEqual([A]);

    // The next one opens where the rule now says.
    setOpen([...open(), term("sh:3")]);
    await waitFor(() => expect(tabsIn(pane(1))).toContain("sh:3"));
    expect(tabsIn(pane(0))).toEqual(["sh:1", "sh:2"]);
  });
});

describe("a pane locked to one kind", () => {
  it("is offered on the tab's own menu, and refuses another kind in a sentence", async () => {
    render(() => <App />);
    await waitFor(() => expect(tabsIn(pane(1))).toEqual([A]));

    click(paneMenuItems(REPO, { id: A, kind: "file" }), "Only file tabs in this pane");
    expect(paneLock(REPO, "right")).toBe("file");

    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: "sh:2", kind: "shell", paneId: "right" });
    expect(await screen.findByText(/only takes file tabs/)).toBeTruthy();
    expect(tabsIn(pane(1))).toEqual([A]);
    expect(tabsIn(pane(0))).toEqual(["sh:1", "sh:2"]);
  });

  it("takes its own kind, and takes anything again once unlocked", async () => {
    render(() => <App />);
    await waitFor(() => expect(tabsIn(pane(1))).toEqual([A]));
    click(paneMenuItems(REPO, { id: A, kind: "file" }), "Only file tabs in this pane");

    click(paneMenuItems(REPO, { id: A, kind: "file" }), "Let this pane take any tab");
    expect(paneLock(REPO, "right")).toBeNull();

    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: "sh:2", kind: "shell", paneId: "right" });
    await waitFor(() => expect(tabsIn(pane(1))).toEqual([A, "sh:2"]));
  });

  it("routes a new tab of another kind around itself", async () => {
    render(() => <App />);
    await waitFor(() => expect(tabsIn(pane(0))).toEqual(["sh:1", "sh:2"]));
    // The terminals' own pane, locked to files: they are already placed there
    // by the rule, so the lock only has to redirect what opens next.
    click(paneMenuItems(REPO, { id: "sh:1", kind: "shell" }), "Only shell tabs in this pane");
    click(paneMenuItems(REPO, { id: A, kind: "file" }), "Only file tabs in this pane");

    setOpen([...open(), { ...term("sh:9"), kind: "chat" as const }]);
    // Both panes are locked away from chat, so it lands at its own rule's end
    // rather than nowhere at all.
    await waitFor(() => expect(tabsIn(pane(0))).toContain("sh:9"));
  });
});

describe("a store written by an older build", () => {
  it("produces today's layout with no pane assignments in it at all", async () => {
    // What an install from before phase 8 has: the legacy two-pane key, and no
    // `tori.tabpanes.v1` whatsoever.
    localStorage.removeItem("tori.tabpanes.v1");
    localStorage.setItem(
      "tori.layout.v1",
      JSON.stringify({ sidebar: 280, editor: 640, showSidebar: true, showTerminal: true, showEditor: true }),
    );
    render(() => <App />);

    await waitFor(() => expect(tabsIn(pane(0))).toEqual(["sh:1", "sh:2"]));
    expect(tabsIn(pane(1))).toEqual([A]);
    expect(document.querySelectorAll(".work-split .pane").length).toBe(2);
  });

  it("reads a placement store written before panes could be locked", async () => {
    // The same key, one field short. A missing map is an empty one, not a
    // reason to drop the assignments beside it.
    localStorage.setItem(
      "tori.tabpanes.v1",
      JSON.stringify({ [REPO]: { tabs: { "sh:2": "right" }, kinds: {}, active: {}, order: {}, seq: 0 } }),
    );
    render(() => <App />);

    // Order inside the pane is the store's own (no stamp was written by an old
    // build either), so the claim is where it landed, not what it sits beside.
    await waitFor(() => expect(tabsIn(pane(1))).toContain("sh:2"));
    expect(tabsIn(pane(1))).toContain(A);
    expect(tabsIn(pane(0))).toEqual(["sh:1"]);
    expect(paneLock(REPO, "right")).toBeNull();
  });
});
