import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The tab bar's end of Phase 5: the History button that opens the dropdown, the
// badge that is the only sign of a session running here with no tab, and the
// mark a PTY agent tab now wears.
const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  listing: [] as unknown[],
  running: [] as string[],
  tail: "done" as string,
  surface: "chat" as "chat" | "agent",
}));

// The default surface decides whether a session selection opens a chat tab or a
// PTY agent tab, and only the second one is what the mark below is about. It
// lives in a Solid store with no exported setter, so it is read through here.
vi.mock("../Settings/settingsStore", async (orig) => {
  const actual = await orig<typeof import("../Settings/settingsStore")>();
  return {
    ...actual,
    settings: {
      ...actual.DEFAULT_SETTINGS,
      get chatDefaults() {
        return { ...actual.DEFAULT_SETTINGS.chatDefaults, defaultSurface: bridge.surface };
      },
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_sessions") return Promise.resolve(bridge.listing);
    if (cmd === "sessions_running") return Promise.resolve(bridge.running);
    if (cmd === "session_running") return Promise.resolve(false);
    if (cmd === "session_tail_state") return Promise.resolve(bridge.tail);
    if (cmd === "chat_orphans") return Promise.resolve([]);
    if (cmd === "agent_hook_launch_args") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
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
// Both panes host live machinery (a real PTY, a chat transport) that has nothing
// to do with what the tab strip renders around them.
vi.mock("./TerminalView", () => ({ default: () => <div data-testid="pty" /> }));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));

const { default: Terminal } = await import("./Terminal");
const { trackFolders, resetSessionStoreForTests } = await import("../../utils/sessionStore");
const {
  noteLiveTabs,
  probeBatch,
  notePtyActivity,
  refreshTailStates,
  resetSessionActivityForTests,
} = await import("../../utils/sessionActivity");
type LiveTab = import("../../utils/events").LiveTab;

// The tab bar measures itself to decide what fits. jsdom reports every width as
// zero, so the observer never has anything to say - it only has to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const session = (id: string) => ({
  id,
  path: `${REPO}/.t/${id}.jsonl`,
  cwd: REPO,
  branch: "main",
  title: id,
  last_active: Math.floor(Date.now() / 1000),
  created_at: 1,
  name: null,
  agent: "claude",
});

const branchSelection = {
  spaceName: "work",
  projectName: "repo",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

/** Mount the terminal pane, feeding its tab set to the activity store the way
 *  the app does (through the sidebar), so a tab's status can compose at all. */
function mount(selected: Record<string, unknown> | null = branchSelection) {
  return render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Terminal selected={selected as any} onOpenChange={(tabs: LiveTab[]) => noteLiveTabs(tabs)} />
  ));
}

const historyBtn = () => screen.getByTitle("Session history");

describe("the History button on the tab bar", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.listing = [];
    bridge.running = [];
    bridge.tail = "done";
    bridge.surface = "chat";
    localStorage.clear();
  });

  it("sits in the trailing cluster and opens the dropdown", async () => {
    mount();
    // Beside the launch control rather than in the scrolling tab area, so it
    // keeps its place however many tabs are open.
    expect(historyBtn().closest(".otab-trailing")).not.toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    fireEvent.click(historyBtn());
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
  });

  it("has nothing to show without a workspace on screen", () => {
    mount(null);
    expect((historyBtn() as HTMLButtonElement).disabled).toBe(true);
  });

  // A claude started in a terminal outside Sway. Nothing hosts it, so with the
  // panel shut this badge is the only thing that says it is there at all.
  it("badges a session running here with no tab, and clears on the next probe", async () => {
    bridge.listing = [session("outsider")];
    bridge.running = ["outsider"];
    mount();
    await trackFolders([REPO]);
    await probeBatch([{ id: "outsider", agent: "claude" }]);

    await waitFor(() => expect(screen.getByTitle("1 session running here with no tab open")).toBeTruthy());

    // It exited: the next probe trigger is what notices, and the badge goes.
    bridge.running = [];
    await probeBatch([{ id: "outsider", agent: "claude" }]);
    await waitFor(() =>
      expect(screen.queryByTitle("1 session running here with no tab open")).toBeNull(),
    );
  });
});

describe("the mark a PTY agent tab wears", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.listing = [session("s1")];
    bridge.running = ["s1"];
    bridge.tail = "done";
    localStorage.clear();
    // The PTY route, so the selection opens an agent tab rather than a chat: the
    // inferred tier is the only one that can starve, and it is the one this is
    // about.
    bridge.surface = "agent";
  });

  it("pulses while working and badges when its tail reads blocked, without claiming a measurement", async () => {
    mount({ ...branchSelection, sessionId: "s1", agent: "claude", sessionFile: `${REPO}/.t/s1.jsonl`, sessionCwd: REPO });
    await trackFolders([REPO]);
    await waitFor(() => expect(screen.getByTestId("pty")).toBeTruthy());
    await probeBatch([{ id: "s1", agent: "claude" }]);

    // Idle: probed and alive, nothing happening. Plainly labelled - this tier is
    // inferred from a pgrep probe and a transcript tail, and only the exact side
    // is marked, so "(measured)" stays chat's.
    const idleMark = await screen.findByTitle("Idle");
    // The class string is read now, not later: it is the same live element that
    // the working state re-styles in place, which is the whole point of it.
    const idleClass = idleMark.className;
    expect(idleMark.childElementCount).toBe(1);
    expect(screen.queryByTitle("Idle (measured)")).toBeNull();

    // Working: same glyph, different treatment. The tab must not change shape.
    const tabId = (await import("../../utils/sessionActivity")).liveSessionStatuses()[0].tabId;
    notePtyActivity(tabId, "active");
    const workingMark = await screen.findByTitle("Executing");
    expect(workingMark.className).not.toBe(idleClass);
    expect(workingMark.childElementCount).toBe(1);

    // Blocked: the one state that is a request, so it gets a second element.
    bridge.tail = "blocked-candidate";
    notePtyActivity(tabId, "quiet");
    await refreshTailStates();
    const blocked = await screen.findByTitle("Waiting for approval");
    expect(blocked.childElementCount).toBe(2);
  });
});
