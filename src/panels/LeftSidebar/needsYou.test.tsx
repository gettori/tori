import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The whole needs-you pipeline, driven from a tree that is entirely collapsed -
// which is now the only state the tree has for sessions, since a branch row is a
// leaf and lists nothing. Every surface a blocked agent is supposed to reach
// in the window is asserted here: the status the tab mark renders from and the
// rollup badges.
//
// Both tiers are run: a PTY tab's status is only Rust's dot, while a chat
// reports its own, so a chat-based check alone would certify a broken PTY path.
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
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [
        {
          name: "repo",
          path: REPO,
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
  home: { project: REPO, folder: MAIN, branch: "main" },
};

const liveTabs = [
  { id: "tab-1", workspace: MAIN, kind: "agent" as const, sessionId: "pty-1", agent: "claude" as const, state: "live" as const },
];

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
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
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));

const { default: LeftSidebar } = await import("./LeftSidebar");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { noteDots, sessionStatus, resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { setLiveChat, dropLiveChat } = await import("../../utils/chatSessions");

const row = async (label: string) => (await screen.findByText(label)).parentElement!;
const badge = (el: Element) => el.querySelector('[title="Waiting for approval"]');

describe("a blocked agent reaches every surface from a fully collapsed tree", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.handlers = {};
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });
  afterEach(() => dropLiveChat("chat-1"));

  it("marks the PTY tier from Rust's dot and badges its rows", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);

    await waitFor(() => expect(bridge.handlers["sessions://changed"]).toBeTruthy());
    noteDots([{ id: "pty-1", dot: "needsYou", certainty: "exact", home: ptySession.home }]);

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
  });

  // The same claim for the tier that reports itself. Its status is its own; the
  // dot and the unit row the rollups read still come from Rust, so this checks
  // the chat side reaches the same places.
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
      visible: false,
    });
    noteDots([{ id: "chat-1", dot: "needsYou", certainty: "exact", home: ptySession.home }]);

    await waitFor(() => expect(sessionStatus("chat-1")).toBe("waitingForApproval"));

    const repo = await row("repo");
    await waitFor(() => expect(badge(repo)).toBeTruthy());

    fireEvent.click(repo);
    const main = await row("main");
    await waitFor(() => expect(badge(main)).toBeTruthy());
    expect(badge(repo)).toBeNull();
  });
});
