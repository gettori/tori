// A Feature worktree listed in Spaces has two homes (#154 phase 3): its unit
// row wears an "in <Feature>" chip that opens the Feature with that folder
// active, and while a Feature is selected no unit reads as active, not even
// the member whose folder is the active root.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const REPO = "/w/api";
const MEMBER = "/w/api-auth";
const SIBLING = "/w/api-other";

const config = {
  path: "/cfg/sway.toml",
  roots: ["/w"],
  spaces: [
    {
      name: "work",
      path: "/w",
      external: false,
      projects: [
        {
          name: "api",
          path: REPO,
          external: false,
          branchUnits: [
            { label: "main", folderPath: REPO, branch: "main", kind: "plain", isCurrent: true },
            { label: "feat/auth", folderPath: MEMBER, branch: "feat/auth", kind: "worktree", isCurrent: false },
            { label: "other", folderPath: SIBLING, branch: "other", kind: "worktree", isCurrent: false },
          ],
        },
      ],
    },
  ],
};

const bridge = vi.hoisted(() => ({ features: [] as unknown[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
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
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");

const AUTH = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [
    { repoPath: REPO, displayName: "api", worktreePath: MEMBER, state: { kind: "present" }, order: 0 },
    { repoPath: "/w/web", displayName: "web", worktreePath: "/w/web-auth", state: { kind: "present" }, order: 1 },
  ],
};

const featureSel = {
  kind: "feature",
  featureId: "f1",
  featureName: "Auth",
  roots: [MEMBER, "/w/web-auth"],
  activeRoot: MEMBER,
  spaceName: "",
  projectName: "Auth",
  projectPath: MEMBER,
  folderPath: MEMBER,
  branch: "feat/auth",
  projectKind: "feature",
};
const unitSel = {
  kind: "unit",
  spaceName: "work",
  projectName: "api",
  projectPath: REPO,
  folderPath: MEMBER,
  branch: "feat/auth",
  projectKind: "worktree",
};

async function mounted(selected: unknown) {
  const onSelect = vi.fn();
  render(() => <LeftSidebar selected={selected as never} onSelect={onSelect} liveTabs={[]} />);
  await waitFor(() => expect(screen.queryByText("other")).toBeTruthy());
  return onSelect;
}
const chips = () => document.querySelectorAll("[data-feature-chip]");
const activeUnits = () => document.querySelectorAll('[draggable="true"][aria-current="true"]');

describe("a Feature worktree in Spaces", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.features = [AUTH];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
    localStorage.setItem("sway.sidebar-mode.v1", "spaces");
    localStorage.setItem("sway.expanded.v1", JSON.stringify(["p:work/api"]));
  });

  it("wears an in-Feature chip on the member unit only", async () => {
    await mounted(null);
    await waitFor(() => expect(chips().length).toBe(1));
    const chip = screen.getByRole("button", { name: "Open Feature Auth" });
    expect(chip.closest('[draggable="true"]')?.textContent).toContain("feat/auth");
    expect(screen.getByText("other").closest('[draggable="true"]')?.querySelector("[data-feature-chip]")).toBeNull();
  });

  it("opens the Feature with the clicked folder active", async () => {
    const onSelect = await mounted(unitSel);
    await waitFor(() => expect(chips().length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Open Feature Auth" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ kind: "feature", featureId: "f1", activeRoot: MEMBER });
  });

  it("marks no unit active while a Feature is selected", async () => {
    await mounted(featureSel);
    await waitFor(() => expect(chips().length).toBe(1));
    expect(activeUnits().length).toBe(0);
  });

  it("still marks the unit active for a unit selection", async () => {
    await mounted(unitSel);
    await waitFor(() => expect(activeUnits().length).toBe(1));
    expect(activeUnits()[0].textContent).toContain("feat/auth");
  });
});
