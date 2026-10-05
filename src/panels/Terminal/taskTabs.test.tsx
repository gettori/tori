import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, waitFor } from "@solidjs/testing-library";

// The other end of the run: the panel emits an `OPEN_TERMINAL` and *this* is
// what receives it. What matters here is that the payload survives the handler
// intact - a task tab that arrived shell-hosted must not be spawned as a
// `command` tab, and the command line must reach `pty_spawn` as `init` rather
// than being typed in afterwards.

const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({
  spawned: [] as { id: string; kind: string; init?: string; cwd: string; program: string }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
    if (cmd === "chat_orphans") return Promise.resolve([]);
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

// Stands in for the real xterm-and-PTY view, recording the props it was handed:
// those props *are* the pty_spawn arguments (TerminalView passes them straight
// through), so this is where the seam can be read without a live terminal.
vi.mock("./TerminalView", () => ({
  default: (props: { id: string; kind: string; init?: string; cwd: string; program: string }) => {
    bridge.spawned.push({
      id: props.id,
      kind: props.kind,
      init: props.init,
      cwd: props.cwd,
      program: props.program,
    });
    return <div data-testid="pty" />;
  },
}));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));

const { default: Terminal } = await import("./Terminal");
const { emitWith, OPEN_TERMINAL } = await import("../../utils/events");
const { toStore } = await import("../../utils/tabPersist");
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

const TASK: OpenTerminal = {
  id: `task:${REPO}:npm:test#1`,
  title: "test",
  cwd: REPO,
  program: "",
  args: [],
  kind: "task",
  init: "pnpm run test\n",
};

function mount() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(() => <Terminal selected={branchSelection as any} onOpenChange={() => {}} />);
}

beforeEach(() => {
  bridge.spawned.length = 0;
  localStorage.clear();
});

describe("a task tab arriving from the Tasks panel", () => {
  it("is spawned shell-hosted, carrying the command line as init", async () => {
    // Never a `pty_write` after the spawn: `init` is delivered backend-once, so
    // this is what makes a remount re-subscribe instead of running it twice.
    mount();
    emitWith<OpenTerminal>(OPEN_TERMINAL, TASK);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === TASK.id)).toBe(true));

    const tab = bridge.spawned.find((s) => s.id === TASK.id)!;
    expect(tab.kind).toBe("task");
    expect(tab.init).toBe("pnpm run test\n");
    // The backend picks the login shell for any kind but `command`, which is why
    // a task carries no program of its own.
    expect(tab.program).toBe("");
    expect(tab.cwd).toBe(REPO);
  });
});

describe("what a relaunch brings back", () => {
  it("leaves task tabs out, exactly as it leaves a clone out", () => {
    // Both for the same reason: restoring one would either re-run it or bring
    // back a bare shell wearing its name. A shell tab beside them still returns.
    const stored = toStore(
      [
        { ...TASK, kind: "task", workspace: REPO, profile: null },
        { id: "shell-1", title: "repo shell", cwd: REPO, workspace: REPO, kind: "shell", program: "", args: [], profile: null },
        { id: "clone-1", title: "Clone", cwd: "/tmp/new", workspace: "/tmp/new", kind: "command", program: "git", args: [], profile: null },
      ],
      {},
      1,
    );
    expect(stored[REPO].tabs.map((t) => t.title)).toEqual(["repo shell"]);
    expect(stored["/tmp/new"]).toBeUndefined();
  });
});
