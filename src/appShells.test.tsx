// The dock: Sway's own commands in a card under the work card, on screen beside
// whatever branch is selected. The real shell and terminal panel; the surfaces
// are stubbed to what a real one does with focus.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import { createEffect } from "solid-js";

// What the backend answers, from import time on: modules the real panels load
// ask it for things before any test has started.
async function backend(cmd: string): Promise<unknown> {
  if (cmd === "get_settings") return (await import("./panels/Settings/settingsStore")).DEFAULT_SETTINGS;
  if (cmd === "onboarding_should_show") return false;
  if (cmd === "list_user_themes") return { themes: [], errors: [] };
  if (cmd === "list_sessions" || cmd === "sessions_running" || cmd === "chat_orphans") return [];
  if (cmd === "refresh_agent_health" || cmd === "list_agents") return [];
  if (cmd === "session_running") return false;
  return null;
}
const invoke = vi.fn(backend);
const bridge = vi.hoisted(() => ({
  /** Every `listen` handler by event, so a test can exit a tab like the backend. */
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  /** What the shell handed the sidebar as the selection, last render. */
  selected: undefined as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => invoke(cmd) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    bridge.listeners.set(event, handler);
    return () => {};
  }),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
// A real view takes the keyboard when it comes on screen, unless it was told not
// to; that is the whole of what these tests need from one.
vi.mock("./panels/Terminal/TerminalView", () => ({
  default: (props: { id: string; active: boolean; autoFocus?: boolean }) => {
    let el!: HTMLTextAreaElement;
    createEffect(() => {
      if (props.active && props.autoFocus !== false) queueMicrotask(() => el.focus());
    });
    return <textarea ref={el} data-testid="pty" data-id={props.id} data-active={props.active ? "1" : "0"} />;
  },
}));
vi.mock("./panels/Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("./panels/Chat/ChatDraft", () => ({ default: () => <div data-testid="draft" /> }));
vi.mock("./panels/Editor/Editor", () => ({ default: () => <div data-testid="editor-panel" /> }));
vi.mock("./panels/LeftSidebar/LeftSidebar", () => ({
  default: (props: { selected: unknown }) => {
    createEffect(() => (bridge.selected = props.selected));
    return <div />;
  },
}));
vi.mock("./panels/Settings/Settings", () => ({ default: () => <div /> }));
vi.mock("./components/Toolbar/Toolbar", () => ({ default: () => <div /> }));
vi.mock("./components/UpdatePill/UpdatePill", () => ({ default: () => <div /> }));
vi.mock("./components/Omnibox/Omnibox", () => ({ default: () => <div /> }));

import { installAnimationFrame } from "./test/frames";

const { default: App } = await import("./App");
const { emit, emitWith, onWith, CLOSE_TAB, OPEN_JOB, TOAST, TOGGLE_DOCK } = await import("./utils/events");
const { SHELLS_KEY } = await import("./utils/features");
const { paneLock } = await import("./layout/tabPlacement");
const { layoutRoot } = await import("./layout/layoutStore");
const { activeWorkspace, dockActiveId, focusTab, open, setOpen } = await import(
  "./panels/Terminal/terminalTabStore"
);
const { BINDINGS } = await import("./utils/hotkeys");
const { resetCommandStatus } = await import("./panels/Terminal/commandStatus");
type OpenJob = import("./utils/events").OpenJob;
type ToastEvent = import("./utils/events").ToastEvent;
type OpenTerm = import("./panels/Terminal/terminalTabStore").OpenTerm;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

installAnimationFrame();

const REPO = "/space/proj/main";
const unit = {
  kind: "unit",
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
  profile: null,
};

const CLONE: OpenJob = {
  id: "clone:1",
  title: "Clone repo",
  cwd: "/space",
  program: "git",
  args: ["clone", "git@example.com:a/b.git"],
  rediscoverOnExit: true,
};
const SIGN_IN: OpenJob = {
  id: "signin:claude",
  title: "Sign in to Claude",
  cwd: "/home/me",
  program: "claude",
  args: ["auth", "login"],
  interactive: true,
};

const dock = () => document.querySelector<HTMLElement>("[data-dock]")!;
const dockShown = () => !dock().classList.contains("hidden");
const workPane = () => document.querySelector<HTMLElement>(".work-split [data-pane-id]")!;
const surface = (id: string) => document.querySelector<HTMLElement>(`[data-testid="pty"][data-id="${id}"]`);
const commandTabs = () => open().filter((t) => t.kind === "command");

/** Exit a tab the way the backend does, once the panel is listening. */
async function exit(id: string, code: number | null) {
  await waitFor(() => expect(bridge.listeners.has("pty://exit")).toBe(true));
  bridge.listeners.get("pty://exit")!({ payload: { id, code } });
}

/** Something in the branch's pane that holds the keyboard, like the editor. */
function focusWorkspace(): HTMLInputElement {
  const input = document.createElement("input");
  workPane().appendChild(input);
  input.focus();
  return input;
}

/** A shell tab on the selected branch, on screen. */
function branchShell(): OpenTerm {
  const t: OpenTerm = {
    id: "sh:1",
    title: "repo shell",
    cwd: REPO,
    workspace: REPO,
    kind: "shell",
    program: "",
    args: [],
    profile: null,
  };
  setOpen([...open(), t]);
  focusTab(REPO, t.id);
  return t;
}

function mount() {
  return render(() => <App />);
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem("sway.selection.v1", JSON.stringify(unit));
  bridge.listeners.clear();
  bridge.selected = undefined;
  resetCommandStatus();
});

describe("the dock", () => {
  it("is seeded at startup as one pane that takes commands and shells", () => {
    mount();
    expect(layoutRoot(SHELLS_KEY)).toBeTruthy();
    expect(paneLock(SHELLS_KEY, "main")).toBeNull();
  });

  it("toggles on its own key, and says so when there is nothing in it", async () => {
    mount();
    expect(dockShown()).toBe(false);
    expect(BINDINGS.find((b) => b.id === "toggle-dock")?.keys).toEqual(["⌘", "⌃", "J"]);

    fireEvent.keyDown(window, { key: "j", code: "KeyJ", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(dockShown()).toBe(true));
    expect(screen.getByText(/Nothing running/)).toBeTruthy();

    emit(TOGGLE_DOCK);
    await waitFor(() => expect(dockShown()).toBe(false));
  });

  it("draws a command in the dock while the branch stays selected and on screen", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));
    branchShell();
    await waitFor(() => expect(surface("sh:1")?.dataset.active).toBe("1"));

    emitWith<OpenJob>(OPEN_JOB, CLONE);
    await waitFor(() => expect(dockShown()).toBe(true));
    await waitFor(() => expect(dock().querySelector('[data-stage-host="clone:1"]')).not.toBeNull());
    expect(surface("clone:1")?.dataset.active).toBe("1");
    // Two groups on screen at once, and the window never moved.
    expect(activeWorkspace()).toBe(REPO);
    expect(surface("sh:1")?.dataset.active).toBe("1");
    expect(workPane().querySelector('[data-stage-host="clone:1"]')).toBeNull();
  });

  it("holds the tab keys while a command in it has focus, and hands them back to the workspace", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));
    branchShell();

    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(dock().contains(document.activeElement)).toBe(true));
    expect(activeWorkspace()).toBe(REPO);
    // One strip lit: the one the keys will reach.
    await waitFor(() => expect(workPane().querySelector(".unified-strip.pane-blur")).not.toBeNull());
    expect(dock().querySelector(".unified-strip.pane-blur")).toBeNull();

    emit(CLOSE_TAB);
    await screen.findByText("Sign in to Claude is still running.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Sign in to Claude is still running.")).toBeNull());

    focusWorkspace();
    emit(CLOSE_TAB);
    await waitFor(() => expect(open().some((t) => t.id === "sh:1")).toBe(false));
    expect(commandTabs().map((t) => t.id)).toEqual(["signin:claude"]);
    expect(screen.queryByText("Sign in to Claude is still running.")).toBeNull();
  });

  it("brings a clone up without the keyboard, on open and on a later toggle", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));
    const input = focusWorkspace();

    emitWith<OpenJob>(OPEN_JOB, CLONE);
    await waitFor(() => expect(surface("clone:1")?.dataset.active).toBe("1"));
    expect(document.activeElement).toBe(input);

    emit(TOGGLE_DOCK);
    await waitFor(() => expect(dockShown()).toBe(false));
    emit(TOGGLE_DOCK);
    await waitFor(() => expect(surface("clone:1")?.dataset.active).toBe("1"));
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
  });

  it("brings a sign-in up with the keyboard, since it has to be typed at", async () => {
    mount();
    await waitFor(() => expect(activeWorkspace()).toBe(REPO));
    focusWorkspace();

    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(document.activeElement).toBe(surface("signin:claude")));
    expect(dockActiveId()).toBe("signin:claude");
  });

  it("goes away with a clean run", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, CLONE);
    await waitFor(() => expect(dockShown()).toBe(true));

    await exit("clone:1", 0);
    await waitFor(() => expect(dockShown()).toBe(false));
    expect(commandTabs()).toHaveLength(0);
  });

  it("keeps a failed command on its tab wearing the code, and Show brings it back", async () => {
    mount();
    const toasts: ToastEvent[] = [];
    const off = onWith<ToastEvent>(TOAST, (t) => toasts.push(t));
    emitWith<OpenJob>(OPEN_JOB, CLONE);
    await exit("clone:1", 1);
    await waitFor(() => expect(dock().querySelector("[data-verdict]")?.textContent).toBe("exit 1"));

    emit(TOGGLE_DOCK);
    await waitFor(() => expect(dockShown()).toBe(false));
    toasts.find((t) => t.kind === "error")!.action!.run();
    await waitFor(() => expect(dockShown()).toBe(true));
    expect(dockActiveId()).toBe("clone:1");
    off();
  });

  it("reads a program that never started as exit 127", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, { ...CLONE, id: "install:nope", program: "nope" });
    await exit("install:nope", 127);
    await waitFor(() => expect(dock().querySelector("[data-verdict]")?.textContent).toBe("exit 127"));
  });

  it("starts with nothing selected from a Shells selection an earlier build stored", async () => {
    localStorage.setItem(
      "sway.selection.v1",
      JSON.stringify({ kind: "shells", spaceName: "", projectName: "Shells", projectPath: "", folderPath: "", branch: "" }),
    );
    mount();
    await waitFor(() => expect(bridge.selected).toBeNull());
    expect(localStorage.getItem("sway.selection.v1")).toBeNull();
  });

  it("keeps the height it was dragged to across a reload", async () => {
    localStorage.setItem("sway.layout.v1", JSON.stringify({ showDock: true, dock: 300 }));
    const first = mount();
    await waitFor(() => expect(dock().style.height).toBe("300px"));

    const bar = document.querySelector<HTMLElement>('.workspace [role="separator"][aria-orientation="horizontal"]')!;
    bar.dispatchEvent(new MouseEvent("pointerdown", { clientY: 500, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 450 }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientY: 450 }));
    await waitFor(() => expect(dock().style.height).toBe("350px"));

    first.unmount();
    mount();
    await waitFor(() => expect(dock().style.height).toBe("350px"));
    expect(dockShown()).toBe(true);
  });
});
