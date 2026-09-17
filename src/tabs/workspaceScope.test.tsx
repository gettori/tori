// Active is workspace-scoped (native-speed plan phase 3): with several visited
// worktrees mounted keep-alive, only the active workspace's pane picks are
// `active`; a background worktree's surfaces are hidden, get no fit/focus, and
// a chat's visibility flips false when its workspace leaves the screen. The
// stage views receive `active` through a memo, so their effects (fit,
// `pty_resize`, `chat_set_visible`) fire on real edges only, not on every
// signal behind the derivation.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createEffect } from "solid-js";
import { installAnimationFrame } from "../test/frames";

const WS1 = "/root/work/repo-a";
const WS2 = "/root/work/repo-b";
const WS3 = "/root/work/repo-c";

const bridge = vi.hoisted(() => ({
  /** Every run of a stage view's active-tracking effect, in order. */
  log: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
    if (cmd === "chat_orphans") return Promise.resolve([]);
    if (cmd === "refresh_agent_health") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));

// The mocks track props.active the way the real views do (fit/focus effects in
// TerminalView, the chat_set_visible flip in ChatView): every effect run is
// logged, so an assertion can tell a real edge from a same-value re-run.
vi.mock("../panels/Terminal/TerminalView", () => ({
  default: (props: { id: string; active: boolean }) => {
    createEffect(() => bridge.log.push(`${props.id}:${props.active}`));
    return <div data-testid="pty" data-id={props.id} data-active={props.active ? "1" : "0"} />;
  },
}));
vi.mock("../panels/Chat/ChatView", () => ({
  default: (props: { tabId: string; active: boolean }) => {
    createEffect(() => bridge.log.push(`${props.tabId}:${props.active}`));
    return <div data-testid="chat" data-id={props.tabId} data-active={props.active ? "1" : "0"} />;
  },
}));

vi.mock("../utils/sessionActivity", () => ({
  sessionStatus: () => "none",
  liveSessionStatuses: () => [],
  notePtyActivity: () => {},
}));
vi.mock("../utils/chatSessions", () => ({
  liveChats: () => [],
  liveChatIds: () => new Set(),
}));

const { default: Terminal } = await import("../panels/Terminal/Terminal");
const { default: PaneView } = await import("./PaneView");
const { open, setOpen, focusTab, focusDockTab, activeWorkspace, dockActiveId } = await import(
  "../panels/Terminal/terminalTabStore"
);
const { showDock, setFocusedSurface, resetDock } = await import("../layout/dockStore");
const { startTabDrag, endTabDrag } = await import("./tabDrag");
const { emit, emitWith, onWith, OPEN_JOB, REVEAL_DOCK, TAB_CYCLE, MOVE_TAB_TO_PANE, SPLIT_PANE } = await import(
  "../utils/events"
);
const { ensureEnvelope, resetPaneLayoutModel, seedOnePane } = await import("../layout/layoutStore");
const { resetTabPlacement } = await import("../layout/tabPlacement");
const { ensureShellsWorkspace, shellsPane } = await import("../layout/shellsWorkspace");
const { paneTabs } = await import("./paneTabs");
const { SHELLS_KEY } = await import("../utils/topics");
type OpenTerm = import("../panels/Terminal/terminalTabStore").OpenTerm;
type Selection = import("../panels/LeftSidebar/LeftSidebar").Selection;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

installAnimationFrame();

const selection = {
  spaceName: "work",
  projectName: "repo-a",
  projectPath: WS1,
  folderPath: WS1,
  branch: "main",
  projectKind: "plain",
} as unknown as Selection;

function tab(id: string, ws: string, kind: OpenTerm["kind"] = "shell"): OpenTerm {
  return {
    id,
    title: id,
    cwd: ws,
    workspace: ws,
    kind,
    program: "zsh",
    args: [],
    profile: null,
    sessionId: kind === "chat" ? `s-${id}` : undefined,
  };
}

function visit(t: OpenTerm) {
  ensureEnvelope(t.workspace, seedOnePane);
  setOpen([...open(), t]);
  focusTab(t.workspace, t.id);
}

const activeIds = () =>
  [...document.querySelectorAll('[data-testid="pty"][data-active="1"], [data-testid="chat"][data-active="1"]')].map(
    (el) => (el as HTMLElement).dataset.id,
  );

beforeEach(() => {
  localStorage.clear();
  bridge.log = [];
  resetPaneLayoutModel();
  resetTabPlacement();
  resetDock(false);
  endTabDrag();
});

describe("workspace-scoped active", () => {
  it("keeps exactly one surface active across three visited worktrees, and flips on real edges only", async () => {
    render(() => <Terminal selected={selection} onOpenChange={() => {}} />);
    visit(tab("sh:1", WS1));
    visit(tab("chat:2", WS2, "chat"));
    visit(tab("sh:3", WS3));

    // Three worktrees visited, all their surfaces mounted: only the active
    // workspace's pane pick is on screen, so the non-hidden count equals the
    // visible panes (one), not one per visited worktree.
    await waitFor(() => expect(activeIds()).toEqual(["sh:3"]));

    bridge.log = [];
    focusTab(WS1, "sh:1");
    await waitFor(() => expect(activeIds()).toEqual(["sh:1"]));

    // The switch is two edges: the revealed terminal turns on, the one that
    // left the screen turns off. The background chat's effect does not run at
    // all, which is what "zero pty_resize for other workspaces" hangs on.
    expect(bridge.log.filter((l) => l === "sh:1:true")).toHaveLength(1);
    expect(bridge.log.filter((l) => l === "sh:3:false")).toHaveLength(1);
    expect(bridge.log.filter((l) => l.startsWith("chat:2"))).toHaveLength(0);

    // Into the chat's workspace and out again: its visibility flips true then
    // false, once each. Before phase 3, `chat_set_visible` could never see
    // false while the tab stayed its pane's pick.
    bridge.log = [];
    focusTab(WS2, "chat:2");
    await waitFor(() => expect(activeIds()).toEqual(["chat:2"]));
    focusTab(WS3, "sh:3");
    await waitFor(() => expect(activeIds()).toEqual(["sh:3"]));
    expect(bridge.log.filter((l) => l === "chat:2:true")).toHaveLength(1);
    expect(bridge.log.filter((l) => l === "chat:2:false")).toHaveLength(1);
  });

  it("a same-pane tab click flips exactly the two tabs that traded places", async () => {
    render(() => <Terminal selected={selection} onOpenChange={() => {}} />);
    visit(tab("sh:1", WS1));
    visit(tab("sh:2", WS1));
    await waitFor(() => expect(activeIds()).toEqual(["sh:2"]));

    bridge.log = [];
    focusTab(WS1, "sh:1");
    await waitFor(() => expect(activeIds()).toEqual(["sh:1"]));
    expect(bridge.log.sort()).toEqual(["sh:1:true", "sh:2:false"]);
  });

  it("re-runs no active effect on a store change that flips nothing", async () => {
    render(() => <Terminal selected={selection} onOpenChange={() => {}} />);
    visit(tab("sh:1", WS1));
    visit(tab("sh:3", WS3));
    await waitFor(() => expect(activeIds()).toEqual(["sh:3"]));

    // A background workspace gains a tab: open() changes, every derivation
    // behind onScreen re-evaluates, and no mounted view's answer moved.
    bridge.log = [];
    ensureEnvelope(WS2, seedOnePane);
    setOpen([...open(), tab("sh:2", WS2)]);
    await waitFor(() =>
      expect(bridge.log.filter((l) => l.startsWith("sh:1") || l.startsWith("sh:3"))).toHaveLength(0),
    );
    expect(activeIds()).toEqual(["sh:3"]);
  });

  // adr_jobs_leave_the_tab_model, restated for the key that replaced "no
  // workspace at all": a Shells tab is keyed on `shells:`, so it can neither
  // join a branch unit's pane nor move the active workspace off that unit.
  it("a shells: tab never joins, and never hides, a branch unit's strip", async () => {
    render(() => <Terminal selected={selection} onOpenChange={() => {}} />);
    visit(tab("sh:1", WS1));
    await waitFor(() => expect(activeIds()).toEqual(["sh:1"]));
    const before = paneTabs(WS1, "main").map((t) => t.id);
    expect(before).toEqual(["sh:1"]);

    ensureShellsWorkspace();
    setOpen([...open(), tab("cmd:1", SHELLS_KEY, "command")]);
    await waitFor(() => expect(paneTabs(SHELLS_KEY, shellsPane()!).map((t) => t.id)).toEqual(["cmd:1"]));

    expect(paneTabs(WS1, "main").map((t) => t.id)).toEqual(before);
    expect(activeWorkspace()).toBe(WS1);
    expect(activeIds()).toEqual(["sh:1"]);
  });

  // The dock is a second group on screen, not a place the window goes: opening,
  // revealing, focusing, cycling and hiding it all leave the selected workspace
  // and its surface exactly where they were.
  it("no dock action moves the selected workspace", async () => {
    render(() => <Terminal selected={selection} onOpenChange={() => {}} />);
    ensureShellsWorkspace();
    visit(tab("sh:1", WS1));
    await waitFor(() => expect(activeIds()).toEqual(["sh:1"]));

    const job = { title: "Clone", cwd: "/root/work", program: "git", args: [] };
    emitWith(OPEN_JOB, { ...job, id: "clone:1" });
    emitWith(OPEN_JOB, { ...job, id: "clone:2" });
    await waitFor(() => expect(activeIds().sort()).toEqual(["clone:2", "sh:1"]));
    expect(activeWorkspace()).toBe(WS1);

    focusDockTab("clone:1");
    setFocusedSurface("dock");
    emit(TAB_CYCLE);
    await waitFor(() => expect(dockActiveId()).toBe("clone:2"));
    emitWith(REVEAL_DOCK, { tabId: "clone:1" });
    focusTab(SHELLS_KEY, "clone:2");
    expect(dockActiveId()).toBe("clone:1");
    showDock(false);
    await waitFor(() => expect(activeIds()).toEqual(["sh:1"]));
    expect(activeWorkspace()).toBe(WS1);
  });

  // The mirror of the test above: a tab from a branch unit dragged over the dock
  // finds no drop target, since the dock's one pane is not part of any branch's
  // tree and a move or split there would land in the wrong one.
  it("a branch tab cannot be dropped on the dock", async () => {
    ensureShellsWorkspace();
    render(() => (
      <>
        <Terminal selected={selection} onOpenChange={() => {}} />
        <PaneView pinKind="command" paneId={shellsPane()!} ws={SHELLS_KEY} />
      </>
    ));
    visit(tab("sh:1", WS1));
    const moved: unknown[] = [];
    const offMove = onWith(MOVE_TAB_TO_PANE, (m) => moved.push(m));
    const offSplit = onWith(SPLIT_PANE, (m) => moved.push(m));

    // jsdom measures every box as zero, so the dock gets the one a layout would
    // give it; without it no zone is ever hit and the test would prove nothing.
    const strip = document.querySelector<HTMLElement>(".otab-list")!.parentElement!;
    const pane = strip.parentElement!;
    const box = (el: HTMLElement, height: number) =>
      (el.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 400, height, right: 400, bottom: height, x: 0, y: 0 }) as DOMRect);
    box(pane, 300);
    box(strip, 40);
    // Both panes are the seeded `main`, so this drag reads as the dock's own.
    startTabDrag({ id: "sh:1", kind: "shell", ws: WS1, fromPane: "main" }, {} as DragEvent);
    for (const [x, y] of [
      [200, 20],
      [200, 150],
    ]) {
      for (const type of ["dragover", "drop"]) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(e, { clientX: { value: x }, clientY: { value: y } });
        pane.dispatchEvent(e);
      }
    }
    endTabDrag();
    offMove();
    offSplit();

    expect(moved).toEqual([]);
    expect(document.querySelector("[data-drop-zone]")).toBeNull();
    expect(paneTabs(WS1, "main").map((t) => t.id)).toEqual(["sh:1"]);
  });
});
