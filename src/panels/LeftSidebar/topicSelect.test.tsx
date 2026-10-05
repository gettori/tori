// Selecting a Topic from the sidebar (#154 phase 2): a row click hands the
// shell a topic Selection, exactly one row reads as active, toggling the
// mode leaves the selection alone, and deleting the selected Topic clears
// it and sweeps its key out of every store.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";

const A = "/w/api/.tori/worktrees/auth";
const B = "/w/web/.tori/worktrees/auth";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  topics: [] as unknown[],
}));

const config = {
  path: "/cfg/tori.toml",
  roots: ["/w"],
  spaces: [
    {
      name: "work",
      path: "/w",
      projects: [
        { name: "api", path: "/w/api", branchUnits: [] },
        { name: "web", path: "/w/web", branchUnits: [] },
      ],
    },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_topics") return Promise.resolve(bridge.topics);
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
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

const { default: LeftSidebar } = await import("./LeftSidebar");
const { default: ToastRegion } = await import("../../components/Toasts/Toasts");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { storesHolding } = await import("../../utils/purgeWorkspace");
const { emit, TOGGLE_SIDEBAR_MODE } = await import("../../utils/events");

const member = (repo: string, wt: string, order: number) => ({
  repoPath: repo,
  displayName: repo.split("/").pop(),
  worktreePath: wt,
  state: { kind: "present" },
  order,
});
const AUTH = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [member("/w/api", A, 0), member("/w/web", B, 1)],
};
const PAY = { id: "f2", name: "Payments", branch: "feat/payments", createdAt: 2, members: [member("/w/api", A, 0)] };

const topicSel = {
  kind: "topic",
  topicId: "f1",
  topicName: "Auth",
  roots: [A, B],
  activeRoot: B,
  spaceName: "",
  projectName: "Auth",
  projectPath: B,
  folderPath: B,
  branch: "feat/auth",
  projectKind: "topic",
};

async function mounted(selected: unknown) {
  const onSelect = vi.fn();
  const r = render(() => (
    <>
      <LeftSidebar selected={selected as never} onSelect={onSelect} liveTabs={[]} />
      <ToastRegion />
    </>
  ));
  await waitFor(() => expect(screen.queryByText("Auth")).toBeTruthy());
  return { ...r, onSelect };
}
const row = (name: string) => screen.getByText(name).closest("li")!;

describe("selecting a Topic", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.topics = [AUTH, PAY];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.sidebar-mode.v1", "topics");
  });

  it("toggles on a Topic click and hands the shell a Topic Selection on a member click", async () => {
    const { onSelect } = await mounted(topicSel);
    const member = (repoPath: string) => document.querySelector<HTMLElement>(`[data-member="${repoPath}"]`);
    fireEvent.click(screen.getByText("Auth"));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(member("/w/web")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const sel = onSelect.mock.calls[0][0];
    expect(sel.kind).toBe("topic");
    expect(sel.topicId).toBe("f1");
    expect(sel.roots).toEqual([A, B]);
    expect(sel.activeRoot).toBe(B);

    fireEvent.click(member("/w/api")!);
    expect(onSelect.mock.calls[1][0]).toMatchObject({ kind: "topic", topicId: "f1", activeRoot: A });
  });

  it("marks exactly the selected row active", async () => {
    await mounted(topicSel);
    const active = document.querySelectorAll('[data-topic][aria-current="true"]');
    expect(active.length).toBe(1);
    expect(active[0].getAttribute("data-topic")).toBe("f1");
  });

  it("leaves the selection alone across a mode cycle", async () => {
    const { onSelect } = await mounted(topicSel);
    const list = () => document.querySelector("[data-topic-list]") as HTMLElement;
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(list().hidden).toBe(true));
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(list().hidden).toBe(false));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("deleting the selected Topic clears it and sweeps topic:<id> from every store", async () => {
    const seed = (key: string, value: unknown) =>
      localStorage.setItem(key, JSON.stringify({ "topic:f1": value, "/w/api": value }));
    seed("tori.panes.v1", { version: 2 });
    seed("tori.tabpanes.v1", {});
    seed("tori.editor.tabs.v1", { paths: [], active: null, savedAt: 1 });
    seed("tori.terminalTabs", { tabs: [], active: 0, savedAt: 1 });
    seed("tori.fileFrecency", {});
    seed("tori.breakpoints", {});
    seed("tori.watches", []);
    seed("tori.debugAttachPorts", 9229);
    seed("tori.debugLastTarget", { kind: "attach", port: 9229 });
    seed("tori.taskRuns", []);
    seed("tori.searchHistory", []);
    seed("tori.savedSearches", []);
    seed("tori.treeExpanded.v1", { dirs: ["/w/api/src"], closed: [] });
    expect(storesHolding("topic:f1").length).toBe(13);

    const { onSelect } = await mounted(topicSel);
    fireEvent.contextMenu(row("Auth"));
    pointerClick(await screen.findByText("Delete…"));
    await screen.findByRole("dialog", { name: "Delete Auth?" });
    fireEvent.click(screen.getByRole("button", { name: "Delete Topic" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "delete_topic")).toBe(true));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    expect(storesHolding("topic:f1")).toEqual([]);
    expect(storesHolding("/w/api").length).toBe(13);
  });

  it("sweeps the debug stores under each member root, and leaves the rest of that folder alone", async () => {
    // Three stores key on the member root rather than on `topic:<id>`: what a
    // run remembered, its attach port and its watches. The Topic key going
    // never reached them.
    const seed = (key: string, value: unknown) =>
      localStorage.setItem(key, JSON.stringify({ "topic:f1": value, [A]: value, [B]: value }));
    seed("tori.watches", ["req.body"]);
    seed("tori.debugAttachPorts", 9229);
    seed("tori.debugLastTarget", { kind: "attach", port: 9229 });
    // Not the Topic's: a member you keep can be reopened as a branch unit,
    // and these are that unit's.
    seed("tori.editor.tabs.v1", { paths: [`${A}/a.ts`], active: null, savedAt: 1 });
    seed("tori.terminalTabs", { tabs: [], active: 0, savedAt: 1 });
    seed("tori.treeExpanded.v1", { dirs: [`${A}/src`], closed: [] });

    await mounted(topicSel);
    fireEvent.contextMenu(row("Auth"));
    pointerClick(await screen.findByText("Delete…"));
    await screen.findByRole("dialog", { name: "Delete Auth?" });
    fireEvent.click(screen.getByRole("button", { name: "Delete Topic" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "delete_topic")).toBe(true));

    await waitFor(() => expect(storesHolding("topic:f1")).toEqual([]));
    for (const root of [A, B]) {
      expect(storesHolding(root)).toEqual(["tori.editor.tabs.v1", "tori.terminalTabs", "tori.treeExpanded.v1"]);
    }
  });
});
