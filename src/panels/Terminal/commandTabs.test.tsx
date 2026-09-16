// The commands Tori runs for you, as tabs. They open in the dock's `shells:`
// group, which is nobody's branch unit, and the window never moves: `focusTab`
// writes `activeWorkspace`, and that write is the whole of the bug
// adr_jobs_leave_the_tab_model exists to prevent. `interactive` decides only
// whether the keyboard follows.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@solidjs/testing-library";

const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({
  /** Every TerminalView mounted, which is every pty_spawn's arguments. */
  spawned: [] as { id: string; env?: Record<string, string>; args: string[]; kind: string; autoFocus?: boolean }[],
  invoked: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.invoked.push(cmd);
    if (cmd === "list_sessions" || cmd === "sessions_running" || cmd === "chat_orphans")
      return Promise.resolve([]);
    if (cmd === "refresh_agent_health" || cmd === "list_agents") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
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

// The props TerminalView receives *are* the pty_spawn arguments, so this is
// where the environment can be read without a live terminal.
vi.mock("./TerminalView", () => ({
  default: (props: { id: string; env?: Record<string, string>; args: string[]; kind: string; autoFocus?: boolean }) => {
    bridge.spawned.push({ id: props.id, env: props.env, args: props.args, kind: props.kind, autoFocus: props.autoFocus });
    return <div data-testid="pty" data-id={props.id} />;
  },
}));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("../Chat/ChatDraft", () => ({ default: () => <div data-testid="draft" /> }));

const { default: Terminal } = await import("./Terminal");
const { default: PaneView } = await import("../../tabs/PaneView");
const { activeWorkspace, dockActiveId, open, resetTerminalTabModel } = await import("./terminalTabStore");
const { ensureShellsWorkspace, shellsPane } = await import("../../layout/shellsWorkspace");
const { dockOpen, resetDock, showDock } = await import("../../layout/dockStore");
const { resetPaneLayoutModel, ensureEnvelope, seedOnePane } = await import("../../layout/layoutStore");
const { resetTabPlacement } = await import("../../layout/tabPlacement");
const { emitWith, OPEN_JOB } = await import("../../utils/events");
const { SHELLS_KEY } = await import("../../utils/features");
const { resetCommandStatus } = await import("./commandStatus");
const { loginJob } = await import("../../utils/signIn");
type OpenJob = import("../../utils/events").OpenJob;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const selection = {
  spaceName: "work",
  projectName: "repo",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
} as never;

const SIGN_IN = loginJob(
  "claude",
  "Claude",
  "work",
  "Work",
  { type: "terminal", program: "claude", args: ["auth", "login"], home: ["CLAUDE_CONFIG_DIR", "/canonical/work"] },
  REPO,
)!;

const CLONE: OpenJob = {
  id: "clone:1",
  title: "Clone repo",
  cwd: "/root/work",
  program: "git",
  args: ["clone", "git@example.com:a/b.git"],
  rediscoverOnExit: true,
};

function mount() {
  return render(() => (
    <>
      <Terminal selected={selection} onOpenChange={() => {}} />
      <div data-testid="branch">
        <PaneView pinKind="shell" />
      </div>
      <div data-testid="dock">
        <PaneView pinKind="command" paneId={shellsPane()!} ws={SHELLS_KEY} />
      </div>
    </>
  ));
}

const commandTabs = () => open().filter((t) => t.kind === "command");
const autoFocusOf = (id: string) => bridge.spawned.find((s) => s.id === id)?.autoFocus;

beforeEach(() => {
  resetTerminalTabModel();
  resetCommandStatus();
  resetPaneLayoutModel();
  resetTabPlacement();
  bridge.spawned.length = 0;
  bridge.invoked.length = 0;
  localStorage.clear();
  resetDock(false);
  ensureShellsWorkspace();
  ensureEnvelope(REPO, seedOnePane);
});

describe("a command Tori runs for you", () => {
  it("opens as a command tab in the Shells workspace", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(commandTabs()).toHaveLength(1));
    expect(commandTabs()[0].workspace).toBe(SHELLS_KEY);
    expect(commandTabs()[0].kind).toBe("command");
  });

  // Without the home variable the agent writes into the login the user already
  // had, reports success, and leaves two profiles that are one account.
  it("spawns the login command with the profile's home variable set", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(bridge.spawned).toHaveLength(1));
    expect(bridge.spawned[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/canonical/work" });
    expect(bridge.spawned[0].args).toEqual(["auth", "login"]);
    expect(bridge.spawned[0].kind).toBe("command");
  });

  // The dedupe job ids were minted for: two installs would race two package
  // managers over one global bin directory.
  it("reaches the one in progress on a second start under the same id", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(bridge.spawned).toHaveLength(1));
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(commandTabs()).toHaveLength(1));
    expect(bridge.spawned).toHaveLength(1);
  });

  // Settings hands a sign-in over and closes: the dock is where it lands, in
  // front, with the keyboard, and the branch underneath stays selected.
  it("reveals the dock with an interactive command in front, keyboard and all", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(dockOpen()).toBe(true));
    expect(dockActiveId()).toBe(SIGN_IN.id);
    expect(activeWorkspace()).toBe(REPO);
    await waitFor(() => expect(autoFocusOf(SIGN_IN.id)).toBe(true));
  });

  it("brings the dock back with the running one in front on a second start", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    emitWith<OpenJob>(OPEN_JOB, CLONE);
    await waitFor(() => expect(dockActiveId()).toBe("clone:1"));

    showDock(false);
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(dockOpen()).toBe(true));
    expect(dockActiveId()).toBe(SIGN_IN.id);
    expect(commandTabs()).toHaveLength(2);
  });

  // No kind's controls mean anything in the dock: there is no branch to launch
  // an agent in and no history to browse. The branch's strip keeps all of them.
  it("draws the launch controls in the branch's strip and only tabs in the dock's", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    const dock = screen.getByTestId("dock");
    await waitFor(() => expect(within(dock).getAllByRole("tab")).toHaveLength(1));
    expect(within(dock).queryByRole("button", { name: "Session history" })).toBeNull();
    expect(within(dock).queryByRole("button", { name: /New chat/ })).toBeNull();
    expect(within(screen.getByTestId("branch")).getByRole("button", { name: "Session history" })).toBeTruthy();
  });

  // The ADR's original bug, restated for the dock: a clone must not pull the
  // window off the branch you are working in, nor the keyboard off what you
  // were typing in.
  it("leaves the window and the keyboard where they are for a non-interactive one", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));

    emitWith<OpenJob>(OPEN_JOB, CLONE);
    await waitFor(() => expect(commandTabs()).toHaveLength(1));
    // The surface still mounts, or the clone would never run: a command tab is
    // born live, so it spawns whether or not anyone is looking at it.
    expect(bridge.spawned.map((s) => s.id)).toContain("clone:1");
    expect(activeWorkspace()).toBe(REPO);
    expect(dockOpen()).toBe(true);
    expect(autoFocusOf("clone:1")).toBe(false);
  });
});
