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

function mount() {
  const [sel, setSel] = createSignal<Selection | null>(null);
  render(() => <LeftSidebar selected={sel()} onSelect={setSel} liveTabs={[]} />);
}

const dialogs = (name: string) => screen.queryAllByRole("dialog", { name });

describe("the sidebar's Topic actions", () => {
  beforeEach(() => {
    bridge.topics = [AUTH];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.sidebar-mode.v1", "topics");
  });

  it("opens the New Topic dialog the Topic list hosts from the head row", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New Topic" }));
    await waitFor(() => expect(dialogs("New Topic")).toHaveLength(1));
  });
});
