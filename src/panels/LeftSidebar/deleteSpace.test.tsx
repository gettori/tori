import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import type { Selection } from "./LeftSidebar";

const REPO = "/root/work/repo";
const LAB = "/root/side/lab";

const unit = (label: string, folderPath: string) => ({
  label,
  folderPath,
  branch: label,
  kind: "worktree",
  isCurrent: label === "main",
});

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [{ name: "repo", path: REPO, branchUnits: [unit("main", `${REPO}/main`)] }],
    },
    {
      name: "side",
      path: "/root/side",
      projects: [{ name: "lab", path: LAB, branchUnits: [unit("main", `${LAB}/main`)] }],
    },
  ],
};

const member = (repoPath: string, displayName: string, worktreePath: string | null = null) => ({
  repoPath,
  displayName,
  worktreePath,
  state: { kind: "present" },
  order: 0,
});
const topic = (id: string, name: string, space: string | undefined, members: ReturnType<typeof member>[]) => ({
  id,
  name,
  branch: `feat/${id}`,
  createdAt: 1,
  members,
  ...(space ? { space } : {}),
});

const PAY = topic("pay", "Pay", "work", [member(REPO, "repo", `${REPO}/.tori/worktrees/pay`)]);
const CART = topic("cart", "Cart", "work", [member(REPO, "repo")]);
const AUTH = topic("auth", "Auth", undefined, [member(REPO, "repo")]);
const BENCH = topic("bench", "Bench", "side", [member(LAB, "lab")]);

const bridge = vi.hoisted(() => ({
  calls: [] as string[],
  refuse: null as string | null,
  toasts: [] as string[],
}));

vi.mock("../../components/Toasts/Toasts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pushToast: (message: string) => {
    if (String(message ?? "").trim()) bridge.toasts.push(message);
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_topics") return Promise.resolve([PAY, CART, AUTH, BENCH]);
    if (cmd === "delete_topic") {
      bridge.calls.push(`delete_topic ${String(args.topicId)}`);
      return args.topicId === bridge.refuse ? Promise.reject("busy") : Promise.resolve(null);
    }
    if (cmd === "delete_space") {
      bridge.calls.push(`delete_space ${String(args.path)}`);
      return Promise.resolve(null);
    }
    if (cmd === "space_delete_preview") return Promise.resolve({ entries: [], sizeBytes: 0 });
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

async function deleteWork() {
  const [sel, setSel] = createSignal<Selection | null>(null);
  render(() => <LeftSidebar selected={sel()} onSelect={setSel} liveTabs={[]} />);
  await screen.findByText("Pay");
  pointerClick(screen.getByRole("button", { name: "Actions for work" }));
  pointerClick(await screen.findByText("Delete space"));
  fireEvent.input(await screen.findByRole("textbox", { name: /to confirm/ }), { target: { value: "work" } });
  fireEvent.click(screen.getByRole("button", { name: "Delete space" }));
}

describe("deleting a space", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.refuse = null;
    bridge.toasts.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("deletes the space's own Topics, and only those, before the space", async () => {
    await deleteWork();
    await waitFor(() => expect(bridge.calls).toContain("delete_space /root/work"));
    expect(bridge.calls).toEqual(["delete_topic pay", "delete_topic cart", "delete_space /root/work"]);
  });

  it("stops before the space when a Topic will not go", async () => {
    bridge.refuse = "pay";
    await deleteWork();
    await waitFor(() => expect(bridge.toasts).toEqual(["busy"]));
    expect(bridge.calls).toEqual(["delete_topic pay"]);
  });
});
