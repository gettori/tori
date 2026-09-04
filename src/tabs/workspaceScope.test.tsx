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
const { open, setOpen, focusTab } = await import("../panels/Terminal/terminalTabStore");
const { ensureEnvelope, resetPaneLayoutModel, seedOnePane } = await import("../layout/layoutStore");
const { resetTabPlacement } = await import("../layout/tabPlacement");
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
});
