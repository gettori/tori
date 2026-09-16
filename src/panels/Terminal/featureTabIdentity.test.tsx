// A terminal tab inside a Feature names its repo (#158 phase 2). A shell has no
// file, so the cwd is what answers, and the member set comes from the same
// module-wide resource the editor reads rather than a second `list_features`.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import { setTabBarWidth } from "../../test/tabLayout";

const A = "/r/a/.tori/worktrees/auth";
const B = "/r/b/.tori/worktrees/auth";

const FEATURE = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [
    { repoPath: "/r/a", displayName: "api", worktreePath: A, state: { kind: "present" }, order: 0 },
    { repoPath: "/r/b", displayName: "web", worktreePath: B, state: { kind: "present" }, order: 1 },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "file_exists") return Promise.resolve(true);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "session_running" || cmd === "session_running_elsewhere") return Promise.resolve(false);
    if (cmd === "session_tail_state") return Promise.resolve("done");
    if (cmd === "chat_orphans" || cmd === "chat_live_sessions" || cmd === "pty_live_ids") return Promise.resolve([]);
    if (cmd === "agent_hook_launch_args") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "list_features") return Promise.resolve([FEATURE]);
    if (cmd === "get_config")
      return Promise.resolve({
        spaces: [
          { name: "back", color: "Sky", projects: [{ path: "/r/a" }] },
          { name: "front", color: "Grass", projects: [{ path: "/r/b" }] },
        ],
      });
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

const featureSel = {
  kind: "feature",
  featureId: "f1",
  featureName: "Auth",
  roots: [A, B],
  activeRoot: A,
  spaceName: "",
  projectName: "Auth",
  projectPath: A,
  folderPath: A,
  branch: "feat/auth",
  projectKind: "feature",
};

/** The chips on the visible strip; the measuring ghost draws its own copies. */
const stripChips = () =>
  [...document.querySelectorAll<HTMLElement>("[data-chip]")].filter((el) => !el.closest(".otab-ghost"));

beforeEach(() => {
  localStorage.clear();
  resetSessionStoreForTests();
  resetSessionActivityForTests();
  resetTerminalTabModel();
  localStorage.setItem(
    "tori.terminalTabs",
    JSON.stringify({
      "feature:f1": {
        tabs: [
          { title: "api shell", cwd: A, kind: "shell", program: "", args: [] },
          { title: "web shell", cwd: B, kind: "shell", program: "", args: [] },
        ],
        active: 0,
        savedAt: Date.now(),
      },
    }),
  );
});
afterEach(() => resetTerminalTabModel());

describe("a terminal tab inside a Feature", () => {
  it("wears one chip per member, each on its own Space tint", async () => {
    render(() => (
      <>
        <Terminal selected={featureSel as never} />
        <PaneView pinKind="shell" />
      </>
    ));
    await waitFor(() => expect(stripChips()).toHaveLength(2));
    const chips = stripChips();
    expect(chips.map((c) => c.getAttribute("data-chip"))).toEqual(["/r/a", "/r/b"]);
    expect(chips.map((c) => c.textContent)).toEqual(["A", "W"]);
    const hues = chips.map((c) => c.style.getPropertyValue("--chip-hue"));
    expect(hues[0]).not.toBe("");
    expect(hues[0]).not.toBe(hues[1]);
    // The chip is silent: the repo reaches the name through the hidden span.
    expect(await screen.findByRole("tab", { name: /^api\s*\/\s*api shell$/ })).toBeTruthy();
  });

  it("names the member on every overflow row", async () => {
    // 150px fits one 120px tab once the +N button is reserved.
    setTabBarWidth(150);
    render(() => (
      <>
        <Terminal selected={featureSel as never} />
        <PaneView pinKind="shell" />
      </>
    ));
    pointerClick(await screen.findByRole("button", { name: "1 more" }));
    const menu = await waitFor(() => screen.getByRole("menu"));
    // Which of the two collapses is the bar's arithmetic, not this test's point:
    // whichever row is in the menu names its own member. The editor suite pins
    // the two-members-at-once case, where both rows are visible together.
    expect(menu.textContent).toMatch(/(api|web) \/ \1 shell/);
  });
});
