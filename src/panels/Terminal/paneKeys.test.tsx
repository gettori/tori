// Pane-scoped tab keys and the Cmd+W close guard (plan phase 6), on the
// terminal side: the keystroke acts only while the terminal pane holds pane
// focus, an idle shell closes at once, a chat mid-turn (exact status) and a
// PTY agent that is not quiet (inferred status) ask first, and the
// programmatic "take me to this tab" paths reveal a hidden pane.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { installAnimationFrame } from "../../test/frames";

const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({
  /** sessionStatus by session id, the quiet heuristic's composed answer. */
  status: {} as Record<string, string>,
  /** liveChats rows, the chat surface's exact per-tab status. */
  chats: [] as { tabId: string; status: string }[],
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

vi.mock("./TerminalView", () => ({
  default: (props: { id: string }) => <div data-testid="pty" data-id={props.id} />,
}));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));

vi.mock("../../utils/sessionActivity", () => ({
  sessionStatus: (id: string) => bridge.status[id] ?? "none",
  liveSessionStatuses: () => [],
  notePtyActivity: () => {},
}));
vi.mock("../../utils/chatSessions", () => ({
  liveChats: () => bridge.chats,
  liveChatIds: () => new Set(bridge.chats.map((c) => c.tabId)),
}));

const { default: Terminal } = await import("./Terminal");
const { emitWith, emit, CLOSE_TAB, TAB_JUMP, FOCUS_SESSION_TAB } = await import("../../utils/events");
const { open, setOpen, focusTab, visibleId } = await import("./terminalTabStore");
const {
  ensureEnvelope,
  envelopeFor,
  focusedPaneId,
  resetPaneLayoutModel,
  seedTwoPane,
  setFocusedPane,
  updateLayout,
} = await import("../../layout/layoutStore");
const { findPane, setPaneHidden } = await import("../../layout/paneLayout");
type OpenTerm = import("./terminalTabStore").OpenTerm;
type Selection = import("../LeftSidebar/LeftSidebar").Selection;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

installAnimationFrame();

const branchSelection = {
  spaceName: "work",
  projectName: "repo",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
} as unknown as Selection;

const seed = () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true });

function tab(id: string, kind: OpenTerm["kind"], sessionId?: string): OpenTerm {
  return { id, title: id, cwd: REPO, workspace: REPO, kind, program: "claude", args: [], profile: null, sessionId };
}

function openTab(t: OpenTerm) {
  setOpen([...open(), t]);
  focusTab(t.workspace, t.id);
}

beforeEach(() => {
  localStorage.clear();
  bridge.status = {};
  bridge.chats = [];
  resetPaneLayoutModel();
});

function mount(selected: () => Selection | null = () => branchSelection) {
  return render(() => <Terminal selected={selected()} onOpenChange={() => {}} />);
}

describe("the Cmd+W guard", () => {
  it("closes an idle shell immediately", async () => {
    mount();
    openTab(tab("sh:1", "shell"));
    emit(CLOSE_TAB);
    await waitFor(() => expect(open()).toHaveLength(0));
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("asks before closing a chat mid-turn, and cancel keeps it", async () => {
    mount();
    openTab(tab("chat:1", "chat", "s-chat"));
    bridge.chats = [{ tabId: "chat:1", status: "executing" }];
    emit(CLOSE_TAB);
    await screen.findByText("chat:1 is still working.");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Cancel")).toBeNull());
    expect(open()).toHaveLength(1);
    // Asked again and confirmed: now it closes.
    emit(CLOSE_TAB);
    await screen.findByText("chat:1 is still working.");
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(open()).toHaveLength(0));
  });

  it("pins the PTY agent quiet heuristic: executing asks, idle closes at once", async () => {
    mount();
    openTab(tab("sh:agent", "agent", "s-agent"));
    bridge.status["s-agent"] = "executing";
    emit(CLOSE_TAB);
    await screen.findByText("sh:agent is still working.");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Cancel")).toBeNull());
    expect(open()).toHaveLength(1);

    bridge.status["s-agent"] = "idle";
    emit(CLOSE_TAB);
    await waitFor(() => expect(open()).toHaveLength(0));
    expect(screen.queryByText("Cancel")).toBeNull();
  });
});

describe("pane scoping", () => {
  it("ignores tab keys while the other pane holds pane focus", async () => {
    mount();
    ensureEnvelope(REPO, seed);
    openTab(tab("sh:1", "shell"));
    openTab(tab("sh:2", "shell"));
    focusTab(REPO, "sh:1");

    setFocusedPane(REPO, "right");
    emitWith(TAB_JUMP, { index: 1 });
    emit(CLOSE_TAB);
    // Neither key acted: same active tab, both tabs still open.
    expect(visibleId()).toBe("sh:1");
    expect(open()).toHaveLength(2);

    setFocusedPane(REPO, "left");
    emitWith(TAB_JUMP, { index: 1 });
    expect(visibleId()).toBe("sh:2");
    emit(CLOSE_TAB);
    await waitFor(() => expect(open()).toHaveLength(1));
  });
});

describe("pane-aware focus", () => {
  it("focus-session-tab reveals a hidden terminal pane before focusing the tab", () => {
    mount();
    ensureEnvelope(REPO, seed);
    openTab(tab("sh:1", "shell"));
    updateLayout(REPO, (root) => setPaneHidden(root, "left", true));
    expect(focusedPaneId(REPO)).toBe("right");

    emitWith(FOCUS_SESSION_TAB, { tabId: "sh:1" });
    expect(findPane(envelopeFor(REPO, seed).layout, "left")!.hidden).toBe(false);
    expect(focusedPaneId(REPO)).toBe("left");
    expect(visibleId()).toBe("sh:1");
  });

  it("a sidebar session click reveals and focuses the terminal pane", async () => {
    const [sel, setSel] = createSignal<Selection | null>(branchSelection);
    mount(sel);
    ensureEnvelope(REPO, seed);
    updateLayout(REPO, (root) => setPaneHidden(root, "left", true));
    setFocusedPane(REPO, "right");

    setSel({ ...(branchSelection as object), sessionId: "s-9", agent: "claude" } as Selection);
    await waitFor(() => expect(focusedPaneId(REPO)).toBe("left"));
    expect(findPane(envelopeFor(REPO, seed).layout, "left")!.hidden).toBe(false);
  });

  it("the selection restored at launch does not steal the saved pane focus", async () => {
    // The very first delivery is the restored selection, not a click: the
    // workspace's saved focus (the editor pane here) must survive it.
    ensureEnvelope(REPO, seed);
    setFocusedPane(REPO, "right");
    mount(() => ({ ...(branchSelection as object), sessionId: "s-9", agent: "claude" }) as Selection);
    // The session-open path has run (it resolves async); focus never moved.
    await Promise.resolve();
    expect(focusedPaneId(REPO)).toBe("right");
  });
});
