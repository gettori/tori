// The terminal inside a Feature (#154 phase 1): tabs group under `feature:<id>`
// (so the same folder selected from Spaces shows none of them), restore lists
// sessions across every member root, and the History crumb names the Feature.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const A = "/r/a/.tori/worktrees/auth";
const B = "/r/b/.tori/worktrees/auth";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  byFolder: {} as Record<string, unknown[]>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_sessions") return Promise.resolve(bridge.byFolder[String(args?.folder)] ?? []);
    if (cmd === "file_exists") return Promise.resolve(true);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "session_running" || cmd === "session_running_elsewhere") return Promise.resolve(false);
    if (cmd === "session_tail_state") return Promise.resolve("done");
    if (cmd === "chat_orphans" || cmd === "chat_live_sessions" || cmd === "pty_live_ids") return Promise.resolve([]);
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
vi.mock("./TerminalView", () => ({ default: () => <div data-testid="pty" /> }));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));

const { default: Terminal } = await import("./Terminal");
const { default: PaneView } = await import("../../tabs/PaneView");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { resetTerminalTabModel } = await import("./terminalTabStore");

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const featureSel = (activeRoot: string) => ({
  kind: "feature",
  featureId: "f1",
  featureName: "Auth",
  roots: [A, B],
  activeRoot,
  spaceName: "",
  projectName: "Auth",
  projectPath: activeRoot,
  folderPath: activeRoot,
  branch: "feat/auth",
  projectKind: "feature",
});
const unitSel = {
  kind: "unit",
  spaceName: "work",
  projectName: "a",
  projectPath: "/r/a",
  folderPath: A,
  branch: "feat/auth",
  projectKind: "worktree",
};

const session = (id: string, cwd: string) => ({
  id,
  path: `${cwd}/.t/${id}.jsonl`,
  cwd,
  branch: "feat/auth",
  title: id,
  last_active: 1,
  created_at: 1,
  name: `${id} chat`,
  agent: "claude",
});

/** Tab titles on the strip, without the measuring ghost's copies. */
const stripTitles = () =>
  [...document.querySelectorAll('[role="tab"]')]
    .filter((el) => !el.closest(".otab-ghost"))
    .map((el) => el.textContent?.trim());

const listedFolders = () => bridge.calls.filter((c) => c.cmd === "list_sessions").map((c) => c.args.folder);

beforeEach(() => {
  localStorage.clear();
  resetSessionStoreForTests();
  resetSessionActivityForTests();
  resetTerminalTabModel();
  bridge.calls.length = 0;
  bridge.byFolder = {};
  localStorage.setItem(
    "tori.terminalTabs",
    JSON.stringify({
      "feature:f1": {
        tabs: [
          { title: "Auth shell", cwd: A, kind: "shell", program: "", args: [] },
          { title: "old", cwd: B, kind: "chat", program: "claude", args: [], sessionId: "s-b" },
        ],
        active: 0,
        savedAt: Date.now(),
      },
    }),
  );
});
afterEach(() => resetTerminalTabModel());

describe("the terminal inside a Feature", () => {
  it("restores the Feature's strip from every member root and keeps it off the member's own unit", async () => {
    bridge.byFolder = { [B]: [session("s-b", B)] };
    const [sel, setSel] = createSignal<Record<string, unknown>>(featureSel(A));
    render(() => (
      <>
        <Terminal selected={sel() as never} />
        <PaneView pinKind="shell" />
      </>
    ));
    await waitFor(() => expect(stripTitles()).toContain("Auth shell"));
    // The chat's session lives under B, so only a union across roots finds it.
    await waitFor(() => expect(stripTitles()).toContain("s-b chat"));
    expect(listedFolders()).toEqual(expect.arrayContaining([A, B]));

    setSel(unitSel);
    await waitFor(() => expect(stripTitles()).not.toContain("Auth shell"));
    expect(stripTitles()).not.toContain("s-b chat");

    setSel(featureSel(B));
    await waitFor(() => expect(stripTitles()).toContain("Auth shell"));
  });

  it("names the Feature on the History crumb", async () => {
    render(() => (
      <>
        <Terminal selected={featureSel(A) as never} />
        <PaneView pinKind="shell" />
      </>
    ));
    await waitFor(() => expect(stripTitles()).toContain("Auth shell"));
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    await waitFor(() => expect(screen.queryByText("Auth")).toBeTruthy());
    expect(screen.queryByText("feat/auth")).toBeTruthy();
  });
});
