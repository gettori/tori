// A Topic worktree listed in Spaces has two homes (#154 phase 3): its unit
// row wears a Tag chip that opens the Topic with that folder
// active, and while a Topic is selected no unit reads as active, not even
// the member whose folder is the active root.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const REPO = "/w/api";
const MEMBER = "/w/api-auth";
const SIBLING = "/w/api-other";
// What `probe_project` now emits for a plain repo: the checkout a Topic made
// under the repo's own `.tori/worktrees`, which is where a kept worktree lands.
const NESTED = `${REPO}/.tori/worktrees/kept`;

const config = {
  path: "/cfg/tori.toml",
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
            { label: "feat/kept", folderPath: NESTED, branch: "feat/kept", kind: "worktree", isCurrent: false },
          ],
        },
      ],
    },
  ],
};

const bridge = vi.hoisted(() => ({ topics: [] as unknown[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
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

const topicSel = {
  kind: "topic",
  topicId: "f1",
  topicName: "Auth",
  roots: [MEMBER, "/w/web-auth"],
  activeRoot: MEMBER,
  spaceName: "",
  projectName: "Auth",
  projectPath: MEMBER,
  folderPath: MEMBER,
  branch: "feat/auth",
  projectKind: "topic",
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
const chips = () => document.querySelectorAll("[data-topic-chip]");
const activeUnits = () => document.querySelectorAll('[draggable="true"][aria-current="true"]');

describe("a Topic worktree in Spaces", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.topics = [AUTH];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.sidebar-mode.v1", "spaces");
    localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/api"]));
  });

  it("wears a Tag chip on the member unit only", async () => {
    await mounted(null);
    await waitFor(() => expect(chips().length).toBe(1));
    const chip = screen.getByRole("button", { name: "Open Topic Auth" });
    expect(chip.textContent).toBe("");
    expect(chip.querySelector("svg")).toBeTruthy();
    chip.focus();
    fireEvent.focus(chip);
    expect(screen.getByRole("tooltip").textContent).toBe("Auth");
    expect(chip.closest('[draggable="true"]')?.textContent).toContain("feat/auth");
    expect(screen.getByText("other").closest('[draggable="true"]')?.querySelector("[data-topic-chip]")).toBeNull();
  });

  it("opens the topic with the clicked folder active when the chip is clicked", async () => {
    const onSelect = await mounted(unitSel);
    await waitFor(() => expect(chips().length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Open Topic Auth" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ kind: "topic", topicId: "f1", activeRoot: MEMBER });
  });

  it("marks no unit active while a Topic is selected", async () => {
    await mounted(topicSel);
    await waitFor(() => expect(chips().length).toBe(1));
    expect(activeUnits().length).toBe(0);
  });

  it("still marks the unit active for a unit selection", async () => {
    await mounted(unitSel);
    await waitFor(() => expect(activeUnits().length).toBe(1));
    expect(activeUnits()[0].textContent).toContain("feat/auth");
  });

  // One repo, two Topics. Each Topic's worktree carries its own branch, so
  // the two never share a folder and the unit row for each wears its own chip:
  // a repo belonging to several Topics has several ways back.
  it("wears one chip per Topic a folder belongs to", async () => {
    bridge.topics = [
      AUTH,
      { ...AUTH, id: "f2", name: "Billing", branch: "feat/billing", members: [{ ...AUTH.members[0], worktreePath: SIBLING }] },
    ];
    await mounted(null);

    await waitFor(() => expect(chips().length).toBe(2));
    const names = Array.from(chips()).map((c) => c.getAttribute("aria-label"));
    expect(names).toEqual(["Open Topic Auth", "Open Topic Billing"]);
    // One each, on the row that actually holds that Topic's worktree.
    expect(screen.getByRole("button", { name: "Open Topic Auth" }).closest('[draggable="true"]')?.textContent).toContain("feat/auth");
    expect(screen.getByRole("button", { name: "Open Topic Billing" }).closest('[draggable="true"]')?.textContent).toContain("other");
  });

  // The Keep half of Remove repository: the worktree stays where it is, the
  // record no longer names it, and Spaces is the only place left to reach it
  // from. A row inside the repo's own `.tori/worktrees` is an ordinary unit.
  it("reaches a worktree nested under its own repo", async () => {
    bridge.topics = [
      { ...AUTH, id: "f2", name: "Kept", branch: "feat/kept", members: [{ ...AUTH.members[0], worktreePath: NESTED }] },
    ];
    await mounted(null);
    await waitFor(() => expect(chips().length).toBe(1));
    const row = screen.getByRole("button", { name: "Open Topic Kept" }).closest('[draggable="true"]');
    expect(row?.textContent).toContain("feat/kept");
  });
});
