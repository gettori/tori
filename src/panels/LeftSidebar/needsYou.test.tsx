import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The whole needs-you pipeline, driven from a tree that is entirely collapsed -
// which is now the only state the tree has for sessions, since a branch row is a
// leaf and lists nothing. Every surface a blocked agent is supposed to reach is
// asserted here: the status the tab mark renders from, the rollup badges, the OS
// notification and the dock badge.
//
// Both tiers are run, because only the PTY one can starve: `computeSessionDot`
// returns on `chatStatus` at its first line, so a chat never reads a tail state
// and a chat-based check would certify a broken PTY build.
const REPO = "/root/work/repo";
const MAIN = `${REPO}/main`;

const unit = (folderPath: string, branch: string) => ({
  label: branch,
  folderPath,
  branch,
  kind: "worktree",
  isCurrent: branch === "main",
});

const config = {
  path: "/cfg/sway.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      external: false,
      projects: [
        {
          name: "repo",
          path: REPO,
          external: false,
          branchUnits: [unit(MAIN, "main"), unit(`${REPO}/feat`, "feat")],
        },
      ],
    },
  ],
};

const ptySession = {
  id: "pty-1",
  path: `${MAIN}/.t/pty-1.jsonl`,
  cwd: MAIN,
  branch: "main",
  title: "pty-1",
  last_active: 1_700_000_000,
  created_at: 1_700_000_000,
  name: null,
  agent: "claude",
};

const liveTabs = [
  { id: "tab-1", workspace: MAIN, kind: "agent" as const, sessionId: "pty-1", agent: "claude" as const, state: "live" as const },
];

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
  notifications: [] as unknown[],
  tail: "done" as string,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions") {
      return Promise.resolve(args.folder === MAIN ? [ptySession] : []);
    }
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    if (cmd === "sessions_running")
      return Promise.resolve(((args.sessions ?? []) as { id: string }[]).map((s) => s.id));
    if (cmd === "session_tail_state") return Promise.resolve(bridge.tail);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    bridge.handlers[name] = fn;
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    isFocused: () => Promise.resolve(true),
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  // Granted, so the notification path actually runs rather than bailing early.
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (n: unknown) => bridge.notifications.push(n),
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));

const { default: LeftSidebar } = await import("./LeftSidebar");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { sessionStatus, resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { setLiveChat, dropLiveChat } = await import("../../utils/chatSessions");

const row = async (label: string) => (await screen.findByText(label)).parentElement!;
const badge = (el: Element) => el.querySelector('[title="Waiting for approval"]');
const lastArgs = (cmd: string) => [...bridge.calls].reverse().find((c) => c.cmd === cmd)?.args;

describe("a blocked agent reaches every surface from a fully collapsed tree", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.handlers = {};
    bridge.notifications.length = 0;
    bridge.tail = "done";
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
    // Deliberately no `sway.expanded.v1`: nothing in the tree is open, which is
    // the state that used to starve the composition.
  });
  afterEach(() => dropLiveChat("chat-1"));

  it("marks the PTY tier from its tail, badges its rows, notifies and bumps the dock", async () => {
    bridge.tail = "blocked-candidate";
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);

    await waitFor(() => expect(bridge.handlers["pty://activity"]).toBeTruthy());
    // A blocked agent is a *quiet* PTY with a pending tool_use in its tail.
    bridge.handlers["pty://activity"]({ payload: { id: "tab-1", state: "quiet" } });
    bridge.handlers["sessions://changed"]({ payload: null });

    // What the tab mark renders from.
    await waitFor(() => expect(sessionStatus("pty-1")).toBe("waitingForApproval"));

    // The project row, which is the only row on screen while everything is shut.
    const repo = await row("repo");
    await waitFor(() => expect(badge(repo)).toBeTruthy());

    // Opening it hands the badge down to the branch row that owns the session,
    // and the project stops reporting what its children now report themselves.
    fireEvent.click(repo);
    const main = await row("main");
    await waitFor(() => expect(badge(main)).toBeTruthy());
    expect(badge(repo)).toBeNull();
    expect(badge(await row("feat"))).toBeNull();

    // The two out-of-window surfaces.
    await waitFor(() => expect(bridge.notifications.length).toBeGreaterThan(0));
    await waitFor(() => expect(lastArgs("set_badge_count")?.count).toBe(1));
    expect(lastArgs("update_tray")?.needsYou).toBe(1);
  });

  // The same claim for the tier that reports itself. Nothing about the tail or
  // the probe is involved, so this is purely a check that merging the two tiers
  // into one status list left the chat side reaching the same places.
  it("does the same for a chat, whose status is its own to report", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
    await waitFor(() => expect(bridge.handlers["sessions://changed"]).toBeTruthy());

    setLiveChat({
      sessionId: "chat-1",
      sessionName: "a chat",
      agentId: "claude",
      folderPath: MAIN,
      tabId: "chat-tab",
      status: "waitingForApproval",
      // Not the tab on screen, so the notification is not suppressed.
      visible: false,
    });

    await waitFor(() => expect(sessionStatus("chat-1")).toBe("waitingForApproval"));

    const repo = await row("repo");
    await waitFor(() => expect(badge(repo)).toBeTruthy());

    fireEvent.click(repo);
    const main = await row("main");
    await waitFor(() => expect(badge(main)).toBeTruthy());
    expect(badge(repo)).toBeNull();

    await waitFor(() => expect(bridge.notifications.length).toBeGreaterThan(0));
    await waitFor(() => expect(lastArgs("set_badge_count")?.count).toBe(1));
    expect(lastArgs("update_tray")?.needsYou).toBe(1);
  });
});
