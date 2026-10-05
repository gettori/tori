import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// A project card shows at most BRANCH_CAP (6) branch rows and puts the rest
// behind a "N more branches" row. Its own fixture rather than the shared
// structure one: this needs a project with more branches than the cap, and the
// point of every assertion here is the count of rows on screen.
const WORK = "/root/work";
const BIG = `${WORK}/big`;

// wt-01 … wt-10, so the labels sort stably and no two tests collide on a name.
const LABELS = Array.from({ length: 10 }, (_, i) => `wt-${String(i + 1).padStart(2, "0")}`);
const folderOf = (label: string) => `${BIG}/${label}`;

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: WORK,
      projects: [
        {
          name: "big",
          path: BIG,
          branchUnits: LABELS.map((label, i) => ({
            label,
            folderPath: folderOf(label),
            branch: label,
            kind: "worktree",
            isCurrent: i === 0,
          })),
        },
      ],
    },
  ],
};

// A session parked on wt-08, which the cap hides: its rollup has nowhere to go
// but the truncation row.
const HIDDEN_LABEL = "wt-08";
const onHidden = {
  id: "on-hidden",
  path: `${folderOf(HIDDEN_LABEL)}/.t/on-hidden.jsonl`,
  cwd: folderOf(HIDDEN_LABEL),
  branch: HIDDEN_LABEL,
  title: "on-hidden",
  last_active: 1_700_000_000,
  created_at: 1_700_000_000,
  name: null,
  agent: "claude",
  home: { project: BIG, folder: folderOf(HIDDEN_LABEL), branch: HIDDEN_LABEL },
};

const liveTabs = [
  {
    id: "tab-1",
    workspace: folderOf(HIDDEN_LABEL),
    kind: "agent" as const,
    sessionId: onHidden.id,
    agent: "claude" as const, state: "live" as const,
  },
];

const bridge = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
  topics: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions") {
      return Promise.resolve(args.folder === folderOf(HIDDEN_LABEL) ? [onHidden] : []);
    }
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "list_topics") return Promise.resolve(bridge.topics);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    if (cmd === "sessions_running")
      return Promise.resolve(((args.sessions ?? []) as { id: string }[]).map((s) => s.id));
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    bridge.handlers[name] = fn;
    return Promise.resolve(() => {});
  },
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
const { noteDots, resetSessionActivityForTests } = await import("../../utils/sessionActivity");

type Selection = Parameters<typeof LeftSidebar>[0]["selected"];

/** Mounted with the project already open, since truncation only exists there. */
const mount = (selected: Selection = null) => {
  localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/big"]));
  return render(() => (
    <LeftSidebar selected={selected} onSelect={() => {}} liveTabs={liveTabs} />
  ));
};

/** The branch labels on screen, in DOM order. */
const visibleLabels = () => LABELS.filter((l) => screen.queryByText(l) != null);

const settle = async () => {
  await waitFor(() => expect(bridge.handlers["sessions://changed"]).toBeTruthy());
  bridge.handlers["sessions://changed"]({ payload: null });
};

describe("a project card truncates a long branch list", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.handlers = {};
    bridge.topics = [];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("shows the first six branches and counts the rest", async () => {
    mount();

    await waitFor(() => expect(screen.getByText("wt-01")).toBeTruthy());
    expect(visibleLabels()).toEqual(["wt-01", "wt-02", "wt-03", "wt-04", "wt-05", "wt-06"]);
    expect(screen.getByText("4 more branches")).toBeTruthy();
    expect(screen.queryByText("Show less")).toBeNull();
  });

  it("does not count a Topic's worktrees that Spaces hides", async () => {
    const owned = (label: string, order: number) => ({
      repoPath: BIG,
      displayName: label,
      worktreePath: folderOf(label),
      state: { kind: "present" },
      order,
    });
    bridge.topics = [
      { id: "t", name: "T", branch: "t", createdAt: 1, members: [owned("wt-09", 0), owned("wt-10", 1)] },
    ];
    mount();

    await waitFor(() => expect(screen.getByText("2 more branches")).toBeTruthy());
  });

  it("reveals every branch on click, and re-truncates on Show less", async () => {
    mount();

    fireEvent.click(await screen.findByText("4 more branches"));

    await waitFor(() => expect(screen.getByText("wt-10")).toBeTruthy());
    expect(visibleLabels()).toEqual(LABELS);
    expect(screen.getByText("Show less")).toBeTruthy();
    expect(screen.queryByText("4 more branches")).toBeNull();

    fireEvent.click(screen.getByText("Show less"));

    await waitFor(() => expect(screen.queryByText("wt-10")).toBeNull());
    expect(visibleLabels()).toEqual(["wt-01", "wt-02", "wt-03", "wt-04", "wt-05", "wt-06"]);
    expect(screen.getByText("4 more branches")).toBeTruthy();
  });

  // A highlight you cannot see is worse than a longer list. The kept unit stays
  // in its own place in the order, so the tree never reshuffles under the user.
  it("keeps a selected branch visible past the cap, in its natural position", async () => {
    mount({
      spaceName: "work",
      projectName: "big",
      projectPath: BIG,
      folderPath: folderOf("wt-09"),
      branch: "wt-09",
      projectKind: "worktree",
      profile: null,
    });

    await waitFor(() => expect(screen.getByText("wt-09")).toBeTruthy());
    expect(visibleLabels()).toEqual([
      "wt-01", "wt-02", "wt-03", "wt-04", "wt-05", "wt-06", "wt-09",
    ]);
    // wt-09 no longer counts as hidden, so the tally drops with it.
    expect(screen.getByText("3 more branches")).toBeTruthy();
  });

  it("carries a hidden branch's live session on the truncation row", async () => {
    mount();

    const more = (await screen.findByText("4 more branches")).parentElement!;
    await settle();
    noteDots([{ id: onHidden.id, dot: "solid", certainty: "inferred", home: onHidden.home }]);

    // wt-08 is behind the cut, so without this the running agent would report
    // on no row at all.
    await waitFor(() => expect(more.querySelector('[title="Idle"]')).toBeTruthy());

    // Once revealed, the branch reports for itself and the control stops.
    fireEvent.click(screen.getByText("4 more branches"));
    const hidden = (await screen.findByText(HIDDEN_LABEL)).parentElement!;
    await waitFor(() => expect(hidden.querySelector('[title="Idle"]')).toBeTruthy());
    expect(screen.getByText("Show less").parentElement!.querySelector('[title="Idle"]')).toBeNull();
  });

  it("remembers a revealed list across a remount", async () => {
    const { unmount } = mount();
    fireEvent.click(await screen.findByText("4 more branches"));
    await waitFor(() => expect(screen.getByText("wt-10")).toBeTruthy());
    unmount();

    // The disclosure lives in the same persisted set as the project's own, so a
    // deliberately opened list is still open next launch.
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);
    await waitFor(() => expect(screen.getByText("wt-10")).toBeTruthy());
    expect(screen.getByText("Show less")).toBeTruthy();
  });
});
