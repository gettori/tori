// What happens when a command exits. A clean run closes its own tab and the
// toast is the record; anything else stays on screen wearing its code, which is
// the output worth keeping.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const A = "/root/work/repo-a";
const B = "/root/work/repo-b";

const bridge = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args?: Record<string, unknown> }[],
  /** Every `listen` handler by event, so a test can exit a tab like the backend. */
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  toasts: [] as { message: string; kind?: string }[],
  focused: [] as { folderPath: string }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    bridge.invoked.push({ cmd, args });
    if (cmd === "list_sessions" || cmd === "sessions_running" || cmd === "chat_orphans")
      return Promise.resolve([]);
    if (cmd === "refresh_agent_health" || cmd === "list_agents") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    bridge.listeners.set(event, handler);
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

vi.mock("./TerminalView", () => ({
  default: (props: { id: string }) => <div data-testid="pty" data-id={props.id} />,
}));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("../Chat/ChatDraft", () => ({ default: () => <div data-testid="draft" /> }));

const { default: Terminal } = await import("./Terminal");
const { default: PaneView } = await import("../../tabs/PaneView");
const { activeWorkspace, open, resetTerminalTabModel } = await import("./terminalTabStore");
const { ensureShellsWorkspace } = await import("../../layout/shellsWorkspace");
const { resetPaneLayoutModel, ensureEnvelope, seedOnePane } = await import("../../layout/layoutStore");
const { resetTabPlacement } = await import("../../layout/tabPlacement");
const { emitWith, OPEN_JOB, TOAST, TERMINAL_TAB_FOCUSED, onWith } = await import("../../utils/events");
const { SHELLS_KEY } = await import("../../utils/features");
const { commandStatus, resetCommandStatus } = await import("./commandStatus");
type OpenJob = import("../../utils/events").OpenJob;
type ToastEvent = import("../../utils/events").ToastEvent;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const unit = (folderPath: string) =>
  ({
    spaceName: "work",
    projectName: folderPath.split("/").pop(),
    projectPath: folderPath,
    folderPath,
    branch: "main",
    projectKind: "plain",
  }) as never;

const job = (over: Partial<OpenJob> = {}): OpenJob => ({
  id: "clone:1",
  title: "Clone repo",
  cwd: `${A}/nested`,
  program: "git",
  args: ["clone", "git@example.com:a/b.git"],
  ...over,
});

function mount(at = A) {
  const [selected, setSelected] = createSignal(unit(at));
  render(() => (
    <>
      <Terminal selected={selected()} onOpenChange={() => {}} />
      <PaneView pinKind="shell" />
    </>
  ));
  return { setSelected };
}

/** Exit as the backend does, once the listener is up and the tab exists. */
async function report(id: string, code: number) {
  await waitFor(() => {
    expect(bridge.listeners.has("pty://exit")).toBe(true);
    expect(open().some((t) => t.id === id)).toBe(true);
  });
  bridge.listeners.get("pty://exit")!({ payload: { id, code } });
}
const surface = (id: string) => document.querySelector(`[data-testid="pty"][data-id="${id}"]`);

const commandTabs = () => open().filter((t) => t.kind === "command");
const killed = () => bridge.invoked.filter((i) => i.cmd === "pty_kill").map((i) => i.args?.id);
/** The X on a named tab, once the strip has drawn it. The model gains the tab
 *  a tick before the strip does, so this waits rather than reading straight. */
const closeButton = async (name: string) =>
  (await screen.findByRole("tab", { name })).parentElement!.querySelector<HTMLElement>(
    "[data-tab-close]",
  )!;

let offToast: (() => void) | undefined;
let offFocused: (() => void) | undefined;

beforeEach(() => {
  resetTerminalTabModel();
  resetCommandStatus();
  resetPaneLayoutModel();
  resetTabPlacement();
  bridge.invoked.length = 0;
  bridge.listeners.clear();
  bridge.toasts.length = 0;
  bridge.focused.length = 0;
  localStorage.clear();
  ensureShellsWorkspace();
  ensureEnvelope(A, seedOnePane);
  ensureEnvelope(B, seedOnePane);
  offToast?.();
  offFocused?.();
  offToast = onWith<ToastEvent>(TOAST, (t) => bridge.toasts.push({ message: t.message, kind: t.kind }));
  offFocused = onWith<{ folderPath: string }>(TERMINAL_TAB_FOCUSED, (d) => bridge.focused.push(d));
});

describe("a command that reports", () => {
  // Always, even after keystrokes: every interactive command needs typing
  // before it reports, so a "unless you typed" rule would keep open exactly the
  // sign-ins and installs it was meant to tidy away.
  it("closes its own tab on a clean run, and says so once", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, job());
    await waitFor(() => expect(commandTabs()).toHaveLength(1));

    await report("clone:1", 0);
    await waitFor(() => expect(commandTabs()).toHaveLength(0));
    expect(bridge.toasts).toEqual([{ message: "Clone repo finished", kind: "info" }]);
  });

  it("keeps the tab and its output on a non-zero exit", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, job());
    await waitFor(() => expect(surface("clone:1")).not.toBeNull());

    await report("clone:1", 1);
    await waitFor(() => expect(bridge.toasts).toHaveLength(1));
    expect(commandTabs()).toHaveLength(1);
    expect(surface("clone:1")).not.toBeNull();
    expect(commandStatus("clone:1")).toBe("failed");
    expect(bridge.toasts[0]).toEqual({ message: "Clone repo failed (exit 1)", kind: "error" });
    expect(killed()).not.toContain("clone:1");
  });

  it("ignores a second exit rather than toasting twice", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, job());
    await report("clone:1", 1);
    await waitFor(() => expect(bridge.toasts).toHaveLength(1));

    await report("clone:1", 0);
    expect(bridge.toasts).toHaveLength(1);
    expect(commandTabs()).toHaveLength(1);
    expect(commandStatus("clone:1")).toBe("failed");
  });

  it("re-reads what the command changed, and only what it asked for", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, job({ rediscoverOnExit: true }));
    await report("clone:1", 0);
    await waitFor(() => expect(bridge.invoked.some((i) => i.cmd === "rediscover")).toBe(true));

    bridge.invoked.length = 0;
    emitWith<OpenJob>(OPEN_JOB, job({ id: "signin:claude", recheckAgentsOnExit: true }));
    await report("signin:claude", 0);
    await waitFor(() => expect(bridge.invoked.some((i) => i.cmd === "refresh_agent_health")).toBe(true));
    expect(bridge.invoked.some((i) => i.cmd === "rediscover")).toBe(false);
  });
});

describe("the window an auto-close leaves behind", () => {
  it("goes back to where the most recent command was started from", async () => {
    const { setSelected } = mount(A);
    await waitFor(() => expect(activeWorkspace()).toBe(A));
    emitWith<OpenJob>(OPEN_JOB, job({ id: "clone:a" }));
    await waitFor(() => expect(commandTabs()).toHaveLength(1));

    setSelected(unit(B));
    await waitFor(() => expect(activeWorkspace()).toBe(B));
    emitWith<OpenJob>(OPEN_JOB, job({ id: "clone:b", interactive: true }));
    await waitFor(() => expect(activeWorkspace()).toBe(SHELLS_KEY));

    bridge.focused.length = 0;
    await report("clone:a", 0);
    // One tab left, so the group is not empty and the window stays in Shells.
    await waitFor(() => expect(commandTabs()).toHaveLength(1));
    expect(bridge.focused).toEqual([]);

    await report("clone:b", 0);
    await waitFor(() => expect(commandTabs()).toHaveLength(0));
    expect(bridge.focused).toEqual([{ folderPath: B }]);
  });

  // A command started from inside Shells has no branch unit behind it, so it
  // says nothing about where to go back to. Letting it overwrite the origin
  // would strand the window on the empty group it just made.
  it("keeps the last branch it knew when a command is started from inside Shells", async () => {
    mount(A);
    await waitFor(() => expect(activeWorkspace()).toBe(A));
    emitWith<OpenJob>(OPEN_JOB, job({ interactive: true }));
    await waitFor(() => expect(activeWorkspace()).toBe(SHELLS_KEY));

    emitWith<OpenJob>(OPEN_JOB, job({ id: "clone:2" }));
    await waitFor(() => expect(commandTabs()).toHaveLength(2));
    bridge.focused.length = 0;

    await report("clone:1", 0);
    await report("clone:2", 0);
    await waitFor(() => expect(commandTabs()).toHaveLength(0));
    expect(bridge.focused).toEqual([{ folderPath: A }]);
  });
});

describe("closing a command that is still running", () => {
  it("asks first, and leaves the process alone when the answer is no", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, job({ interactive: true }));
    await waitFor(() => expect(commandTabs()).toHaveLength(1));

    fireEvent.click(await closeButton("Clone repo"));
    await screen.findByText("Clone repo is still running.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Clone repo is still running.")).toBeNull());
    expect(commandTabs()).toHaveLength(1);
    expect(killed()).not.toContain("clone:1");
  });

  it("stops it once that is confirmed", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, job({ interactive: true }));
    await waitFor(() => expect(commandTabs()).toHaveLength(1));

    fireEvent.click(await closeButton("Clone repo"));
    await screen.findByText("Clone repo is still running.");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(commandTabs()).toHaveLength(0));
    expect(killed()).toContain("clone:1");
  });

  it("closes a command that has already reported without asking", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, job({ interactive: true }));
    await report("clone:1", 1);
    await waitFor(() => expect(commandStatus("clone:1")).toBe("failed"));

    fireEvent.click(await closeButton("Clone repo"));
    await waitFor(() => expect(commandTabs()).toHaveLength(0));
    expect(screen.queryByText("Clone repo is still running.")).toBeNull();
  });
});
