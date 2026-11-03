import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import type { Selection } from "./LeftSidebar";

const REPO = "/root/work/repo";
const ACME = "/Users/me/clients/acme-site";
const THESIS = "/Volumes/Archive/thesis";

const unit = (label: string, folderPath: string, kind = "worktree") => ({
  label,
  folderPath,
  branch: label,
  kind,
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
  ],
  global: {
    projects: [
      { name: "acme-site", path: ACME, branchUnits: [unit("main", ACME, "plain")], availability: "ok" },
      { name: "thesis", path: THESIS, branchUnits: [], availability: "missing" },
    ],
  },
};

const member = (repoPath: string, displayName: string) => ({
  repoPath,
  displayName,
  worktreePath: null,
  state: { kind: "present" },
  order: 0,
});
const topic = (id: string, name: string, members: ReturnType<typeof member>[]) => ({
  id,
  name,
  branch: `feat/${id}`,
  createdAt: 1,
  members,
});

const bridge = vi.hoisted(() => ({
  topics: [] as unknown[],
  picked: null as string | null,
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_topics") return Promise.resolve(bridge.topics);
    if (cmd === "pick_folder") return Promise.resolve(bridge.picked);
    if (cmd === "remove_member") {
      const t = (bridge.topics as ReturnType<typeof topic>[]).find((t) => t.id === args.topicId)!;
      return Promise.resolve({ ...t, members: t.members.filter((m) => m.repoPath !== args.repoPath) });
    }
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

function mount() {
  const [sel, setSel] = createSignal<Selection | null>(null);
  render(() => <LeftSidebar selected={sel()} onSelect={setSel} />);
  return { sel };
}

const called = (cmd: string) => bridge.calls.filter((c) => c.cmd === cmd);

describe("Global's attached folders", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.topics = [];
    bridge.picked = null;
    bridge.calls.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "/global");
  });

  describe("past six", () => {
    const eight = Array.from({ length: 8 }, (_, i) => {
      const path = `/Users/me/p${i + 1}`;
      return { name: `p${i + 1}`, path, branchUnits: [unit("main", path, "plain-dir")], availability: "ok" };
    });
    const saved = { global: config.global.projects, work: config.spaces[0].projects };
    const projectNames = (tree = "[data-topic-list]") =>
      [...document.querySelectorAll<HTMLElement>(`${tree} [class*=_project_] [class*=label]`)].map(
        (l) => l.textContent,
      );
    beforeEach(() => {
      config.global.projects = eight;
      config.spaces[0].projects = eight;
      return () => {
        config.global.projects = saved.global;
        config.spaces[0].projects = saved.work;
      };
    });

    it("lists six projects and folds the rest, keeping the selected project's card", async () => {
      const { sel } = mount();
      await screen.findByText("p1");
      expect(projectNames()).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
      fireEvent.click(screen.getByRole("button", { name: "2 more projects" }));
      fireEvent.click(await screen.findByText("p8"));
      await waitFor(() => expect(sel()?.folderPath).toBe("/Users/me/p8"));
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      await waitFor(() => expect(projectNames()).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p8"]));
      expect(screen.getByRole("button", { name: "1 more project" })).toBeTruthy();
    });

    it("folds a space's projects past six even without Topics", async () => {
      localStorage.setItem("tori.active-space.v1", "work");
      mount();
      await waitFor(() => expect(projectNames("[data-spaces-tree]")).toHaveLength(6));
      expect(screen.getByRole("button", { name: "2 more projects" })).toBeTruthy();
    });
  });

  it("lists them under Projects, the missing one with its note and only Locate and Detach", async () => {
    mount();
    expect(await screen.findByText("acme-site")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Folder missing" })).toBeTruthy();

    fireEvent.click(screen.getByText("thesis"));
    expect(await screen.findByText(THESIS)).toBeTruthy();

    fireEvent.contextMenu(screen.getByText("thesis"));
    const rows = (await screen.findAllByRole("menuitem")).map((r) => r.textContent);
    expect(rows).toEqual(["Locate…", "Detach…The folder stays where it is"]);
  });

  it("locates a missing folder through the picker, then re-points it", async () => {
    bridge.picked = "/Volumes/Backup/thesis";
    mount();
    fireEvent.click(await screen.findByText("thesis"));
    fireEvent.click(await screen.findByRole("button", { name: "Locate…" }));
    await waitFor(() => expect(called("relocate_attached_folder")).toHaveLength(1));
    expect(called("pick_folder")).toHaveLength(1);
    expect(called("relocate_attached_folder")[0].args).toEqual({ old: THESIS, new: "/Volumes/Backup/thesis" });
  });

  it("detaches without deleting: a Topic it was alone in goes, one with others keeps them", async () => {
    bridge.topics = [
      topic("solo", "Solo", [member(ACME, "acme-site")]),
      topic("pair", "Pair", [member(ACME, "acme-site"), member(REPO, "repo")]),
    ];
    mount();
    fireEvent.contextMenu(await screen.findByText("acme-site"));
    pointerClick(await screen.findByText("Detach…"));
    const dialog = await screen.findByRole("dialog", { name: "Detach acme-site?" });
    expect(dialog.textContent).toContain("it leaves Pair");
    expect(dialog.textContent).toContain("Solo has no other project");
    expect(dialog.textContent).toContain("Stays on disk");

    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(called("detach_folder")).toHaveLength(1));
    expect(called("detach_folder")[0].args).toEqual({ path: ACME });
    expect(called("delete_topic").map((c) => c.args.topicId)).toEqual(["solo"]);
    expect(called("remove_member").map((c) => c.args)).toEqual([{ topicId: "pair", repoPath: ACME }]);
    expect(called("remove_project")).toHaveLength(0);
    expect(called("remove_folder")).toHaveLength(0);
  });
});
