// Selecting a Feature from the sidebar (#154 phase 2): a row click hands the
// shell a feature Selection, exactly one row reads as active, toggling the
// mode leaves the selection alone, and deleting the selected Feature clears
// it and sweeps its key out of every store.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";

const A = "/w/api/.sway/worktrees/auth";
const B = "/w/web/.sway/worktrees/auth";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  features: [] as unknown[],
}));

const config = {
  path: "/cfg/sway.toml",
  roots: ["/w"],
  spaces: [
    {
      name: "work",
      path: "/w",
      external: false,
      projects: [
        { name: "api", path: "/w/api", external: false, branchUnits: [] },
        { name: "web", path: "/w/web", external: false, branchUnits: [] },
      ],
    },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_features") return Promise.resolve(bridge.features);
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
const AUTH = { id: "f1", name: "Auth", branch: "feat/auth", createdAt: 1, members: [member("/w/api", A, 0), member("/w/web", B, 1)] };
const PAY = { id: "f2", name: "Payments", branch: "feat/payments", createdAt: 2, members: [member("/w/api", A, 0)] };

const featureSel = {
  kind: "feature",
  featureId: "f1",
  featureName: "Auth",
  roots: [A, B],
  activeRoot: B,
  spaceName: "",
  projectName: "Auth",
  projectPath: B,
  folderPath: B,
  branch: "feat/auth",
  projectKind: "feature",
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

describe("selecting a Feature", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.features = [AUTH, PAY];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
    localStorage.setItem("sway.sidebar-mode.v1", "features");
  });

  it("hands the shell a feature Selection on click, keeping a stored active root", async () => {
    const { onSelect } = await mounted(featureSel);
    fireEvent.click(row("Auth"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const sel = onSelect.mock.calls[0][0];
    expect(sel.kind).toBe("feature");
    expect(sel.featureId).toBe("f1");
    expect(sel.roots).toEqual([A, B]);
    expect(sel.activeRoot).toBe(B);

    fireEvent.click(row("Payments"));
    expect(onSelect.mock.calls[1][0]).toMatchObject({ kind: "feature", featureId: "f2", activeRoot: A });
  });

  it("marks exactly the selected row active", async () => {
    await mounted(featureSel);
    const active = document.querySelectorAll('[data-feature][aria-current="true"]');
    expect(active.length).toBe(1);
    expect(active[0].getAttribute("data-feature")).toBe("f1");
  });

  it("leaves the selection alone when the mode toggles", async () => {
    const { onSelect } = await mounted(featureSel);
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(screen.queryByText("Auth")).toBeNull());
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(screen.queryByText("Auth")).toBeTruthy());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("deleting the selected Feature clears it and sweeps feature:<id> from every store", async () => {
    const seed = (key: string, value: unknown) =>
      localStorage.setItem(key, JSON.stringify({ "feature:f1": value, "/w/api": value }));
    seed("sway.panes.v1", { version: 2 });
    seed("sway.tabpanes.v1", {});
    seed("sway.editor.tabs.v1", { paths: [], active: null, savedAt: 1 });
    seed("sway.terminalTabs", { tabs: [], active: 0, savedAt: 1 });
    seed("sway.fileFrecency", {});
    seed("sway.bookmarks", {});
    seed("sway.breakpoints", {});
    seed("sway.watches", []);
    seed("sway.debugAttachPorts", 9229);
    seed("sway.debugLastTarget", { kind: "attach", port: 9229 });
    seed("sway.taskRuns", []);
    seed("sway.searchHistory", []);
    seed("sway.savedSearches", []);
    seed("sway.treeExpanded.v1", { dirs: ["/w/api/src"], closed: [] });
    expect(storesHolding("feature:f1").length).toBe(14);

    const { onSelect } = await mounted(featureSel);
    fireEvent.contextMenu(row("Auth"));
    pointerClick(await screen.findByText("Delete…"));
    await screen.findByRole("dialog", { name: "Delete Auth?" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "delete_feature")).toBe(true));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    expect(storesHolding("feature:f1")).toEqual([]);
    expect(storesHolding("/w/api").length).toBe(14);
  });
});
