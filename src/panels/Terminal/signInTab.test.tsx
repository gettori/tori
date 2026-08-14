import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";

// A sign-in tab is an ordinary terminal tab with two things bolted on, and both
// of them are silent when they break.
//
// The profile's home variable has to reach the spawned process: without it the
// harness writes into the login the user already had, reports success, and
// leaves two profiles that are one account.
//
// The re-probe has to happen when the process ends: without it a finished login
// keeps reading as signed out until the user goes and finds the button in
// Settings, which is the restart this phase exists to remove.

const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({
  spawned: [] as { id: string; kind: string; env?: Record<string, string>; args: string[] }[],
  invoked: [] as string[],
  // Tauri event listeners, by event name, so a `pty://exit` can be fired.
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.invoked.push(cmd);
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
    if (cmd === "chat_orphans") return Promise.resolve([]);
    if (cmd === "refresh_agent_health") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    bridge.listeners.set(name, handler);
    return Promise.resolve(() => {});
  },
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
  default: (props: { id: string; kind: string; env?: Record<string, string>; args: string[] }) => {
    bridge.spawned.push({ id: props.id, kind: props.kind, env: props.env, args: props.args });
    return <div data-testid="pty" />;
  },
}));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));

const { default: Terminal } = await import("./Terminal");
const { emitWith, OPEN_TERMINAL } = await import("../../utils/events");
const { loginTab } = await import("../../utils/signIn");
type OpenTerminal = import("../../utils/events").OpenTerminal;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const branchSelection = {
  spaceName: "work",
  projectName: "repo",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

const SIGN_IN = loginTab(
  "claude",
  "Claude",
  "work",
  "Work",
  { type: "terminal", program: "claude", args: ["auth", "login"], home: ["CLAUDE_CONFIG_DIR", "/canonical/work"] },
  REPO,
)!;

function mount() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(() => <Terminal selected={branchSelection as any} onOpenChange={() => {}} />);
}

/** Fire the backend's process-exit event for one tab. */
async function exit(id: string) {
  await waitFor(() => expect(bridge.listeners.has("pty://exit")).toBe(true));
  bridge.listeners.get("pty://exit")!({ payload: id });
}

beforeEach(() => {
  bridge.spawned.length = 0;
  bridge.invoked.length = 0;
  bridge.listeners.clear();
  localStorage.clear();
});

describe("a sign-in tab", () => {
  it("spawns the login command with the profile's home variable set", async () => {
    mount();
    emitWith<OpenTerminal>(OPEN_TERMINAL, SIGN_IN);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === SIGN_IN.id)).toBe(true));

    const tab = bridge.spawned.find((s) => s.id === SIGN_IN.id)!;
    expect(tab.env).toEqual({ CLAUDE_CONFIG_DIR: "/canonical/work" });
    expect(tab.args).toEqual(["auth", "login"]);
    // Spawned directly rather than seeded into a shell, so the tab stays put
    // after the process exits and a failed login is readable.
    expect(tab.kind).toBe("command");
  });

  // The restart this phase exists to remove.
  it("re-probes agent health when the login process ends", async () => {
    mount();
    emitWith<OpenTerminal>(OPEN_TERMINAL, SIGN_IN);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === SIGN_IN.id)).toBe(true));

    expect(bridge.invoked).not.toContain("refresh_agent_health");
    await exit(SIGN_IN.id);
    await waitFor(() => expect(bridge.invoked).toContain("refresh_agent_health"));
  });

  // Abandoning the tab ends the process too, and re-probing then is right: it
  // re-reads the harness and finds it unchanged, rather than leaving a stale
  // answer behind after a cancel.
  it("re-probes once per tab, not once per exit event", async () => {
    mount();
    emitWith<OpenTerminal>(OPEN_TERMINAL, SIGN_IN);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === SIGN_IN.id)).toBe(true));

    await exit(SIGN_IN.id);
    await waitFor(() => expect(bridge.invoked).toContain("refresh_agent_health"));
    await exit(SIGN_IN.id);
    const refreshes = bridge.invoked.filter((c) => c === "refresh_agent_health").length;
    expect(refreshes).toBe(1);
  });

  // Every other tab exits too, and none of them changed anybody's sign-in.
  it("leaves ordinary tabs alone", async () => {
    mount();
    const clone: OpenTerminal = {
      id: "clone-1",
      title: "Clone",
      cwd: REPO,
      program: "git",
      args: ["clone", "x"],
      kind: "command",
    };
    emitWith<OpenTerminal>(OPEN_TERMINAL, clone);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === clone.id)).toBe(true));
    expect(bridge.spawned.find((s) => s.id === clone.id)!.env).toBeUndefined();

    await exit(clone.id);
    expect(bridge.invoked).not.toContain("refresh_agent_health");
  });
});
