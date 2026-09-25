import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";

// A link or a notification names a folder, a session, or both, and the sidebar
// takes the user there: the right space shown, the unit selected, never a
// checkout behind a click that only said "show me".
const WT = "/root/work/repo/feat";
const PLAIN = "/root/other/plain";

const unit = (folderPath: string, branch: string, kind = "worktree", isCurrent = false) => ({
  label: branch,
  folderPath,
  branch,
  kind,
  isCurrent,
});

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [
        { name: "repo", path: "/root/work/repo", branchUnits: [unit("/root/work/repo/main", "main"), unit(WT, "feat")] },
      ],
    },
    {
      name: "other",
      path: "/root/other",
      projects: [
        {
          name: "plain",
          path: PLAIN,
          branchUnits: [unit(PLAIN, "main", "plain", true), unit(PLAIN, "topic", "plain")],
        },
      ],
    },
  ],
};

const session = (id: string, cwd: string, branch: string) => ({
  id,
  path: `${cwd}/.transcripts/${id}.jsonl`,
  cwd,
  branch,
  title: id,
  last_active: 1_700_000_000,
  created_at: 1_700_000_000,
  name: null,
  agent: "claude",
});

const LISTINGS: Record<string, ReturnType<typeof session>[]> = {
  [WT]: [session("worker-1", WT, "feat")],
  [PLAIN]: [session("elsewhere-1", PLAIN, "topic")],
};

const bridge = vi.hoisted(() => ({ calls: [] as string[], toasts: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push(cmd);
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions") return Promise.resolve(LISTINGS[String(args.folder)] ?? []);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
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
vi.mock("../../components/Toasts/Toasts", () => ({
  // The real one drops an empty message, which the sidebar sends to clear.
  pushToast: (message: string) => message && bridge.toasts.push(message),
  default: () => null,
}));

const { default: LeftSidebar } = await import("./LeftSidebar");
const { emitWith, NAVIGATE } = await import("../../utils/events");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");

type Picked = { spaceName?: string; folderPath?: string; branch?: string; sessionId?: string } | null;

async function mount() {
  const picked: Picked[] = [];
  render(() => <LeftSidebar selected={null} onSelect={(s) => picked.push(s as Picked)} />);
  await waitFor(() => expect(bridge.calls).toContain("get_config"));
  await waitFor(() => expect(document.body.textContent).toContain("plain"));
  return picked;
}

describe("navigating to a target", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.toasts.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "other");
  });

  it("selects the unit a folder names, in a space that was not showing", async () => {
    const picked = await mount();
    emitWith(NAVIGATE, { folder: WT });
    await waitFor(() => expect(picked[picked.length - 1]).toMatchObject({ spaceName: "work", folderPath: WT, branch: "feat" }));
    expect(localStorage.getItem("tori.active-space.v1")).toBe("work");
  });

  it("focuses the session when the target names one", async () => {
    const picked = await mount();
    emitWith(NAVIGATE, { folder: WT, session: "worker-1" });
    await waitFor(() => expect(picked[picked.length - 1]).toMatchObject({ folderPath: WT, sessionId: "worker-1" }));
  });

  it("lands a worktree project's own folder on one of its worktrees", async () => {
    const picked = await mount();
    emitWith(NAVIGATE, { folder: "/root/work/repo" });
    await waitFor(() => expect(picked[picked.length - 1]).toMatchObject({ spaceName: "work", folderPath: "/root/work/repo/main" }));
  });

  it("lands a plain repo's folder on the branch it has checked out", async () => {
    const picked = await mount();
    emitWith(NAVIGATE, { folder: PLAIN });
    await waitFor(() => expect(picked[picked.length - 1]).toMatchObject({ folderPath: PLAIN, branch: "main" }));
  });

  it("refuses a session that would need a checkout, and says so", async () => {
    const picked = await mount();
    const before = picked.length;
    emitWith(NAVIGATE, { folder: PLAIN, session: "elsewhere-1" });
    await waitFor(() => expect(bridge.toasts).toHaveLength(1));
    expect(bridge.toasts[0]).toContain("another branch checked out");
    expect(picked.length).toBe(before);
    expect(bridge.calls).not.toContain("git_checkout");
  });

  it("says so when the folder is no longer in Tori", async () => {
    const picked = await mount();
    const before = picked.length;
    emitWith(NAVIGATE, { folder: "/root/work/gone" });
    await waitFor(() => expect(bridge.toasts).toEqual(["That worktree is no longer in Tori."]));
    expect(picked.length).toBe(before);
  });
});
