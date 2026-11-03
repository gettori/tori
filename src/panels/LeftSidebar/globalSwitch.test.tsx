import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import type { Selection } from "./LeftSidebar";

const WORK = "/root/work/proj";
const MAIN = `${WORK}/main`;
const WAVE = `${WORK}/wave-3`;

const bridge = vi.hoisted(() => ({ topics: [] as unknown[] }));

const unit = (label: string, folderPath: string) => ({
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
      projects: [{ name: "proj", path: WORK, branchUnits: [unit("main", MAIN), unit("wave-3", WAVE)] }],
    },
  ],
};

const AUTH = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [
    {
      repoPath: WORK,
      displayName: "proj",
      worktreePath: `${WORK}/.tori/worktrees/auth`,
      state: { kind: "present" },
      order: 0,
    },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_topics") return Promise.resolve(bridge.topics);
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
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

function mount() {
  const [sel, setSel] = createSignal<Selection | null>(null);
  const onSelect = vi.fn((s: Selection | null) => setSel(s));
  render(() => <LeftSidebar selected={sel()} onSelect={onSelect} liveTabs={[]} />);
  return { sel, onSelect };
}

const click = (name: string) => fireEvent.click(screen.getByText(name));
const segment = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("switching between a space and Global", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.topics = [AUTH];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/proj"]));
  });

  it("comes back to what each was last on", async () => {
    const { sel } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());
    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));

    segment("Global");
    await waitFor(() => expect(screen.getByText("Auth")).toBeTruthy());
    click("Auth");
    fireEvent.click(document.querySelector<HTMLElement>(`[data-member="${WORK}"]`)!);
    await waitFor(() => expect(sel()?.kind).toBe("topic"));

    segment("work");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));
    expect(sel()?.kind).toBe("unit");

    segment("Global");
    await waitFor(() => expect(sel()?.topicId).toBe("f1"));
  });

  it("clears the selection when Global has nothing remembered", async () => {
    const { sel } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());
    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));

    segment("Global");
    await waitFor(() => expect(screen.getByText("Auth")).toBeTruthy());
    expect(sel()).toBeNull();
  });

  it("clears the selection when Global's remembered Topic is gone", async () => {
    localStorage.setItem(
      "tori.selection-memory.v1",
      JSON.stringify({ spaces: {}, topic: { kind: "topic", topicId: "deleted", folderPath: WAVE } }),
    );
    const { sel, onSelect } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());
    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));

    segment("Global");
    await waitFor(() => expect(screen.getByText("Auth")).toBeTruthy());
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  describe("a Topic in a space", () => {
    const PAY = {
      ...AUTH,
      id: "f2",
      name: "Pay",
      branch: "feat/pay",
      space: "work",
      members: [{ ...AUTH.members[0], worktreePath: `${WORK}/.tori/worktrees/pay` }],
    };
    const openPay = async () => {
      await waitFor(() => expect(screen.getByText("Pay")).toBeTruthy());
      click("Pay");
      fireEvent.click(document.querySelector<HTMLElement>(`[data-member="${WORK}"]`)!);
    };

    beforeEach(() => {
      bridge.topics = [AUTH, PAY];
    });

    it("comes back to it on returning to its space", async () => {
      const { sel } = mount();
      await openPay();
      await waitFor(() => expect(sel()?.topicId).toBe("f2"));

      segment("Global");
      await waitFor(() => expect(screen.getByText("Auth")).toBeTruthy());
      click("Auth");
      fireEvent.click(document.querySelector<HTMLElement>(`[data-member="${WORK}"]`)!);
      await waitFor(() => expect(sel()?.topicId).toBe("f1"));

      segment("work");
      await waitFor(() => expect(sel()?.topicId).toBe("f2"));
    });

    it("is not what Global comes back to", async () => {
      const { sel } = mount();
      await openPay();
      await waitFor(() => expect(sel()?.topicId).toBe("f2"));

      segment("Global");
      await waitFor(() => expect(screen.getByText("Auth")).toBeTruthy());
      expect(sel()).toBeNull();
      expect(screen.queryByText("Pay")).toBeNull();
    });

    it("is dropped from its space's memory once it has moved out", async () => {
      localStorage.setItem("tori.active-space.v1", "/global");
      localStorage.setItem(
        "tori.selection-memory.v1",
        JSON.stringify({ spaces: { work: { kind: "topic", topicId: "f2", spaceName: "work", folderPath: "" } } }),
      );
      bridge.topics = [AUTH, { ...PAY, space: undefined }];
      const { sel, onSelect } = mount();
      await waitFor(() => expect(screen.getByText("Pay")).toBeTruthy());
      await screen.findByRole("button", { name: "work" });

      segment("work");
      await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
      expect(onSelect.mock.calls.every(([s]) => s === null)).toBe(true);
      expect(sel()).toBeNull();
    });
  });
});
