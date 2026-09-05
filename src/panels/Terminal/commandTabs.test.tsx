// The commands Sway runs for you, as tabs. They open in the Shells workspace,
// which is nobody's branch unit, and `interactive` decides whether the window
// moves: `focusTab` writes `activeWorkspace`, and that write is the whole of the
// bug adr_jobs_leave_the_tab_model exists to prevent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({
  /** Every TerminalView mounted, which is every pty_spawn's arguments. */
  spawned: [] as { id: string; env?: Record<string, string>; args: string[]; kind: string }[],
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
  default: (props: { id: string; env?: Record<string, string>; args: string[]; kind: string }) => {
    bridge.spawned.push({ id: props.id, env: props.env, args: props.args, kind: props.kind });
    return <div data-testid="pty" data-id={props.id} />;
  },
}));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("../Chat/ChatDraft", () => ({ default: () => <div data-testid="draft" /> }));

const { default: Terminal } = await import("./Terminal");
const { default: PaneView } = await import("../../tabs/PaneView");
const { activeWorkspace, open, resetTerminalTabModel } = await import("./terminalTabStore");
const { ensureShellsWorkspace } = await import("../../layout/shellsWorkspace");
const { resetPaneLayoutModel, ensureEnvelope, seedOnePane } = await import("../../layout/layoutStore");
const { resetTabPlacement } = await import("../../layout/tabPlacement");
const { emitWith, OPEN_JOB, REVEAL_SHELLS, on: onEvent } = await import("../../utils/events");
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
      <PaneView pinKind="shell" />
    </>
  ));
}

const commandTabs = () => open().filter((t) => t.kind === "command");
const shellTabs = () => open().filter((t) => t.kind === "shell");

beforeEach(() => {
  resetTerminalTabModel();
  resetCommandStatus();
  resetPaneLayoutModel();
  resetTabPlacement();
  bridge.spawned.length = 0;
  bridge.invoked.length = 0;
  localStorage.clear();
  ensureShellsWorkspace();
  ensureEnvelope(REPO, seedOnePane);
});

describe("a command Sway runs for you", () => {
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

  it("takes the window for an interactive command, which is what Settings hands over to", async () => {
    mount();
    const revealed = vi.fn();
    const off = onEvent(REVEAL_SHELLS, revealed);
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(activeWorkspace()).toBe(SHELLS_KEY));
    expect(revealed).toHaveBeenCalled();
    off();
  });

  // The one control the strip keeps in Shells. There is no branch behind this
  // workspace, so the shell it opens has nowhere to be but home.
  it("opens a shell of your own from the strip's +, at home", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(activeWorkspace()).toBe(SHELLS_KEY));

    fireEvent.click(await screen.findByRole("button", { name: "New shell" }));
    await waitFor(() => expect(shellTabs()).toHaveLength(1));
    expect(shellTabs()[0].workspace).toBe(SHELLS_KEY);
    expect(shellTabs()[0].cwd).toBe("/home/me");
    // A shell, not a command: nothing reports for it and nothing auto-closes it.
    expect(shellTabs()[0].kind).toBe("shell");
  });

  it("offers that + only in Shells, where the rest of the cluster is gone", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));
    expect(screen.queryByRole("button", { name: "New shell" })).toBeNull();

    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(activeWorkspace()).toBe(SHELLS_KEY));
    expect(await screen.findByRole("button", { name: "New shell" })).toBeTruthy();
    // The branch-unit cluster stays hidden behind it.
    expect(screen.queryByRole("button", { name: /Launch an agent session/ })).toBeNull();
  });

  // The ADR's original bug, restated for the key that replaced "no workspace at
  // all": a clone must not pull the window off the branch you are working in.
  it("leaves the window where it is for a non-interactive one", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));
    const revealed = vi.fn();
    const off = onEvent(REVEAL_SHELLS, revealed);

    emitWith<OpenJob>(OPEN_JOB, CLONE);
    await waitFor(() => expect(commandTabs()).toHaveLength(1));
    // The surface still mounts, or the clone would never run: a command tab is
    // born live, so it spawns whether or not anyone is looking at it.
    expect(bridge.spawned.map((s) => s.id)).toContain("clone:1");
    expect(activeWorkspace()).toBe(REPO);
    expect(revealed).not.toHaveBeenCalled();
    off();
  });
});
