import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, fireEvent, cleanup, within } from "@solidjs/testing-library";
import { pointerClick } from "./test/menus";
import "./test/tabLayout";
import { drift, rows } from "./test/perfBudgets";

const WORK = "/root/work/proj";
const MAIN = `${WORK}/alpha`;
const WAVE = `${WORK}/beta`;
const ROW_A = "alpha";
const ROW_B = "beta";

const worktree = (label: string, folderPath: string) => ({
  label,
  folderPath,
  branch: label,
  kind: "worktree",
  isCurrent: false,
});

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [{ name: "proj", path: WORK, branchUnits: [worktree(ROW_A, MAIN), worktree(ROW_B, WAVE)] }],
    },
  ],
};

async function backend(cmd: string): Promise<unknown> {
  switch (cmd) {
    case "get_settings":
      return (await import("./panels/Settings/settingsStore")).DEFAULT_SETTINGS;
    case "list_user_themes":
      return { themes: [], errors: [] };
    case "get_config":
      return config;
    case "git_status":
    case "fs_read_dir":
    case "list_sessions":
    case "sessions_running":
    case "list_project_attempts":
    case "chat_orphans":
    case "chat_live_sessions":
    case "pty_live_ids":
    case "list_agents":
    case "refresh_agent_health":
      return [];
    case "list_branches":
      return [{ name: "main", current: true }];
    case "git_ahead_behind":
      return { ahead: 0, behind: 0, has_upstream: true };
    case "session_running":
    case "folder_historical":
      return false;
    case "file_exists":
      return true;
    default:
      return null;
  }
}

const invoke = vi.fn((cmd: string) => backend(cmd));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => invoke(cmd) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
    isFocused: () => Promise.resolve(true),
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));
vi.mock("./panels/Terminal/TerminalView", () => ({ default: () => <div data-testid="pty" /> }));
vi.mock("./panels/Chat/ChatView", () => ({ default: () => <div /> }));
vi.mock("./panels/Chat/ChatDraft", () => ({ default: () => <div /> }));
vi.mock("./panels/Editor/CodeEditor", () => ({ default: () => null }));
vi.mock("./panels/Editor/lspClient", () => ({
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const { default: App } = await import("./App");
const { setOpen, focusTab } = await import("./panels/Terminal/terminalTabStore");

const term = (id: string, ws: string) => ({
  id,
  title: id,
  cwd: ws,
  workspace: ws,
  kind: "shell" as const,
  program: "",
  args: [] as string[],
  profile: null,
});

const clickRow = (label: string) =>
  fireEvent.click(within(document.querySelector<HTMLElement>("aside.sidebar")!).getByText(label));

async function settle() {
  let last = -1;
  for (let stable = 0, round = 0; stable < 2; round++) {
    if (round === 200) throw new Error("invokes never settled: something keeps firing under one second");
    await vi.advanceTimersByTimeAsync(1000);
    const now = invoke.mock.calls.length;
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  localStorage.setItem("tori.active-space.v1", "work");
  localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/proj"]));
  invoke.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Both worktrees visited and two shell tabs open on the first, so what is
// measured is a warm switch rather than a first visit's one-off setup.
async function warm() {
  render(() => <App />);
  await settle();
  clickRow(ROW_B);
  await settle();
  clickRow(ROW_A);
  await settle();
  setOpen([term("one", MAIN), term("two", MAIN)]);
  focusTab(MAIN, "one");
  await settle();
  pointerClick(screen.getByRole("tab", { name: "two" }));
  await settle();
}

async function invokedBy(act: () => void): Promise<string[]> {
  const before = invoke.mock.calls.length;
  act();
  await settle();
  return invoke.mock.calls.slice(before).map((c) => c[0]);
}

const worktreeSwitch = (to: string) => invokedBy(() => clickRow(to));
const tabSwitch = (to: string) => invokedBy(() => pointerClick(screen.getByRole("tab", { name: to })));

describe("the webview perf budgets", () => {
  it("holds every webview row", async () => {
    await warm();
    const worktree = await worktreeSwitch(ROW_B);
    await worktreeSwitch(ROW_A);
    const tab = await tabSwitch("one");
    const drifted = drift(
      rows("webview"),
      new Map([
        ["invokes.switch.worktree", worktree.length],
        ["invokes.switch.tab", tab.length],
      ]),
    );
    expect(drifted, `worktree: ${worktree.join(", ")}\ntab: ${tab.join(", ")}`).toEqual([]);
  });

  // An exact count is only a gate if the same switch always counts the same.
  it("counts the same switch the same way every time", async () => {
    await warm();
    const worktree = new Set<number>();
    const tab = new Set<number>();
    for (let i = 0; i < 20; i++) {
      worktree.add((await worktreeSwitch(ROW_B)).length);
      worktree.add((await worktreeSwitch(ROW_A)).length);
      tab.add((await tabSwitch(i % 2 ? "two" : "one")).length);
    }
    expect([...worktree]).toHaveLength(1);
    expect([...tab]).toHaveLength(1);
  });
});
