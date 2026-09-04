// Splits and tab moves through the shell (plan phase 8): the palette commands
// and the tab menu both emit, App runs the guards, and PaneTree draws whatever
// comes out. The panels are stubbed down to what a pane actually needs of them
// (a registered descriptor over the real stores), so this is about the shell.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@solidjs/testing-library";

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

// Stub panels: register the kinds their real counterparts do, over the real
// tab stores, and render nothing (which is what a service host does anyway).
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
        stripItems: () => unifiedTabs().filter((u) => u.kind === "file" && u.workspace === REPO),
        stripActiveId: () => store.activeByWs()[REPO] ?? null,
        stripReorder: () => {},
        // The real panel's shape (phase 9): one stage host per pane holding
        // file tabs, so two panes can each hold an editor view.
        hostIds: (paneId, tabs) =>
          paneId === null ? ["editor-stage"] : tabs.length ? [`editor-stage:${paneId}`] : [],
      });
      return null;
    },
  };
});

import { DEFAULT_SETTINGS } from "./panels/Settings/settingsStore";
import {
  emit,
  emitWith,
  CLOSE_PANE,
  MOVE_TAB_TO_PANE,
  type MoveTabToPane,
  SPLIT_PANE,
  type SplitPane,
} from "./utils/events";
import { COMMANDS } from "./utils/commands";
import { setOpen, setActiveWorkspace, setActiveByWorkspace } from "./panels/Terminal/terminalTabStore";
import { setTabsByWs, setActiveByWs } from "./panels/Editor/editorTabStore";
import { paneMenuItems } from "./tabs/paneTabs";

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

// The sidebar is a `.pane` too; the work card's own are what these are about.
const pane = (n: number) => document.querySelectorAll<HTMLElement>(".work-split .pane")[n];
const panes = () => document.querySelectorAll(".work-split .pane").length;
const tabsIn = (el: HTMLElement) => within(el).queryAllByRole("tab").map((t) => t.textContent ?? "");

function seedTabs() {
  setOpen([term("sh:1"), term("sh:2")]);
  setActiveWorkspace(REPO);
  setActiveByWorkspace({ [REPO]: "sh:1" });
  setTabsByWs({ [REPO]: [{ path: `${REPO}/a.ts`, name: "a.ts" }] });
  setActiveByWs({ [REPO]: `${REPO}/a.ts` });
}

beforeEach(() => {
  localStorage.clear();
  // This suite is about two panes; the shell seeds one (plan phase 12).
  storeTwoPanes(REPO);
  localStorage.setItem(
    "sway.selection.v1",
    JSON.stringify({
      spaceName: "space",
      projectName: "proj",
      projectPath: "/space/proj",
      folderPath: REPO,
      branch: "main",
      projectKind: "plain",
    }),
  );
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") return DEFAULT_SETTINGS;
    if (cmd === "onboarding_should_show") return false;
    if (cmd === "list_user_themes") return { themes: [], errors: [] };
    return null;
  });
  seedTabs();
});

describe("splitting", () => {
  it("adds a pane beside the focused one, from the palette's own command", () => {
    render(() => <App />);
    expect(panes()).toBe(2);
    // The command the palette lists runs exactly this.
    COMMANDS.find((c) => c.id === "split-pane-right")!.run!();
    expect(panes()).toBe(3);
    expect(document.querySelectorAll(".pane-split.row").length).toBe(1);
  });

  it("nests a down-split under the pane it came from", () => {
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "column" });
    expect(document.querySelector(".pane-split.column")).toBeTruthy();
    expect(panes()).toBe(3);
  });

  it("refuses past the pane cap, visibly", async () => {
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    expect(panes()).toBe(4);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    expect(panes()).toBe(4);
    expect(await screen.findByText(/4 panes is as many as fit/)).toBeTruthy();
  });
});

describe("moving a tab", () => {
  it("puts it in the new pane and takes it out of the old one", async () => {
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: "sh:2", kind: "shell", paneId: "pane-1" });

    await waitFor(() => expect(tabsIn(pane(1))).toEqual(["sh:2"]));
    expect(tabsIn(pane(0))).toEqual(["sh:1"]);
  });

  it("is what the tab's own context menu asks for", async () => {
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    const items = paneMenuItems(REPO, { id: "sh:2", kind: "shell" });
    const move = items.find((i) => "label" in i && i.label === "Move to pane 2");
    expect(move).toBeTruthy();
    if (move && "onClick" in move) move.onClick();

    await waitFor(() => expect(tabsIn(pane(1))).toEqual(["sh:2"]));
  });

  it("takes one file tab into a second pane and leaves its sibling behind", async () => {
    // Phase 8 refused this (one CodeMirror view, one pane); phase 9 gave each
    // pane its own view, and the guard stopped saying no.
    setTabsByWs({
      [REPO]: [
        { path: `${REPO}/a.ts`, name: "a.ts" },
        { path: `${REPO}/b.ts`, name: "b.ts" },
      ],
    });
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, {
      tabId: `${REPO}/a.ts`,
      kind: "file",
      paneId: "pane-1",
    });

    await waitFor(() => expect(tabsIn(pane(1))).toEqual([`${REPO}/a.ts`]));
    expect(tabsIn(pane(2))).toEqual([`${REPO}/b.ts`]);
    // Each pane adopted its own editor stage, which is what phase 9 gave the
    // panes a view apiece to put in.
    expect(pane(1).querySelector('[data-stage-host="editor-stage:pane-1"]')).toBeTruthy();
    expect(pane(2).querySelector('[data-stage-host="editor-stage:right"]')).toBeTruthy();
  });

  it("steps to the pane beside it when no target is named", async () => {
    render(() => <App />);
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: "sh:1", kind: "shell", direction: "next" });
    await waitFor(() => expect(tabsIn(pane(1))).toContain("sh:1"));
  });

  it("lets the same move through once the guard has nothing to refuse", async () => {
    // What phase 9 will do by deleting the guard's file branch, done here by
    // removing what it guards: no call site changes, the move just goes.
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: `${REPO}/a.ts`, kind: "file", paneId: "pane-1" });

    await waitFor(() => expect(tabsIn(pane(1))).toEqual([`${REPO}/a.ts`]));
    // The editor's stage went with it: that is the pane holding it now.
    expect(pane(1).querySelector('[data-stage-host]')).toBeTruthy();
  });

  it("says so rather than nothing when there is nowhere to move to", async () => {
    // One pane in the stored envelope: nothing to step to.
    localStorage.setItem(
      "sway.panes.v1",
      JSON.stringify({
        [REPO]: {
          version: 1,
          layout: { type: "pane", id: "solo", size: 100, hidden: false },
          focusedPaneId: "solo",
        },
      }),
    );
    render(() => <App />);
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: "sh:1", kind: "shell", direction: "next" });
    expect(await screen.findByText(/only one pane/)).toBeTruthy();
  });
});

describe("closing a pane", () => {
  it("hands its tabs to the neighbour rather than dropping them", async () => {
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: "sh:2", kind: "shell", paneId: "pane-1" });
    await waitFor(() => expect(tabsIn(pane(1))).toEqual(["sh:2"]));

    // Closing the pane the move focused: its tabs go to the pane on its right
    // (the editor's, here), appended after what that pane already held.
    emit(CLOSE_PANE);
    await waitFor(() => expect(panes()).toBe(2));
    expect(tabsIn(pane(1))).toEqual([`${REPO}/a.ts`, "sh:2"]);
    expect([...tabsIn(pane(0)), ...tabsIn(pane(1))].sort()).toEqual([`${REPO}/a.ts`, "sh:1", "sh:2"]);
  });

  it("collapses a pane that empties out, and never the last one", async () => {
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: "sh:2", kind: "shell", paneId: "pane-1" });
    await waitFor(() => expect(tabsIn(pane(1))).toEqual(["sh:2"]));

    // The tab goes back; the pane it left has held one and is empty now, so it
    // collapses on its own.
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: "sh:2", kind: "shell", paneId: "left" });
    await waitFor(() => expect(panes()).toBe(2));

    emit(CLOSE_PANE);
    emit(CLOSE_PANE);
    expect(panes()).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/last pane/)).toBeTruthy();
  });

  it("collapses a pane a kind opens into once its last tab leaves", async () => {
    // The editor's own pane, emptied by moving its only file out. It used to be
    // exempt for being where files land, which left an empty box on screen;
    // where a kind lands is resolved spatially at call time, so the pane that
    // remains is the answer either way.
    render(() => <App />);
    await waitFor(() => expect(tabsIn(pane(1))).toEqual([`${REPO}/a.ts`]));
    expect(panes()).toBe(2);

    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, {
      tabId: `${REPO}/a.ts`,
      kind: "file",
      paneId: "left",
    });

    await waitFor(() => expect(panes()).toBe(1));
    expect(tabsIn(pane(0)).sort()).toEqual(["sh:1", "sh:2", `${REPO}/a.ts`].sort());
  });
});
