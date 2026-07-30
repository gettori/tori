import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// What the sidebar can see, and when. Every claim here is about a folder the
// tree was never expanded at: session state used to be filled only by expanding
// a row, which quietly made the needs-you pipeline, the tray, and a
// notification click depend on where the tree happened to be open.
const MAIN = "/root/work/repo/main";
const FEAT = "/root/work/repo/feat";
const SOLO = "/root/other/solo";

const unit = (folderPath: string, branch: string) => ({
  label: branch,
  folderPath,
  branch,
  kind: "worktree",
  isCurrent: false,
});

// Two spaces, so "the tab outlives its space" is a real navigation and not a
// hypothetical: `other` does not contain MAIN at all.
const config = {
  path: "/cfg/sway.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      external: false,
      projects: [
        {
          name: "repo",
          path: "/root/work/repo",
          external: false,
          branchUnits: [unit(MAIN, "main"), unit(FEAT, "feat")],
        },
      ],
    },
    {
      name: "other",
      path: "/root/other",
      external: false,
      projects: [
        { name: "solo", path: SOLO, external: false, branchUnits: [unit(SOLO, "main")] },
      ],
    },
  ],
};

const session = (id: string, cwd: string) => ({
  id,
  path: `${cwd}/.transcripts/${id}.jsonl`,
  cwd,
  branch: "main",
  title: id,
  last_active: 1_700_000_000,
  created_at: 1_700_000_000,
  name: null,
  archived: false,
  agent: "claude",
});

// `live-1` is hosted by a tab; `detached-1` is the session started outside Sway
// that nothing would ever probe without the folder sweep.
const LISTINGS: Record<string, ReturnType<typeof session>[]> = {
  [MAIN]: [session("live-1", MAIN), session("detached-1", MAIN)],
  [FEAT]: [],
  [SOLO]: [],
};

const liveTabs = [
  { id: "tab-1", workspace: MAIN, kind: "agent" as const, sessionId: "live-1", agent: "claude" as const },
];

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
  notificationClick: null as ((n: unknown) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions") return Promise.resolve(LISTINGS[String(args.folder)] ?? []);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    // Everything asked about is alive, so the probe is never the reason a dot
    // fails to appear.
    if (cmd === "sessions_running")
      return Promise.resolve(((args.sessions ?? []) as { id: string }[]).map((s) => s.id));
    if (cmd === "session_tail_state") return Promise.resolve("blocked-candidate");
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
  onAction: (fn: (n: unknown) => void) => {
    bridge.notificationClick = fn;
    return Promise.resolve(() => {});
  },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));

const { default: LeftSidebar } = await import("./LeftSidebar");
const { sessions, resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { liveStatuses, setLiveStatuses } = await import("../../utils/sessionStatus");

const listedFolders = () =>
  bridge.calls.filter((c) => c.cmd === "list_sessions").map((c) => String(c.args.folder));

const probedIds = () =>
  bridge.calls
    .filter((c) => c.cmd === "sessions_running")
    .flatMap((c) => (c.args.sessions as { id: string }[]).map((s) => s.id));

describe("what the sidebar can see without being expanded", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    setLiveStatuses([]);
    bridge.calls.length = 0;
    bridge.handlers = {};
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
  });
  afterEach(() => resetSessionStoreForTests());

  // Both presence surfaces hand over a bare session id and nothing else, and
  // neither can wait for the user to have opened the right node first.
  it("focuses a session by bare id in a folder the tree never opened", async () => {
    const picked: (unknown | null)[] = [];
    render(() => <LeftSidebar selected={null} onSelect={(s) => picked.push(s)} liveTabs={liveTabs} />);
    await waitFor(() => expect(bridge.handlers["tray://focus-session"]).toBeTruthy());
    await waitFor(() => expect(sessions()[MAIN]).toBeTruthy());
    const pickedIds = () =>
      picked.map((s) => (s as { sessionId?: string } | null)?.sessionId).filter(Boolean);

    bridge.handlers["tray://focus-session"]({ payload: "detached-1" });
    await waitFor(() => expect(pickedIds()).toContain("detached-1"));

    bridge.notificationClick!({ extra: { sessionId: "live-1" } });
    await waitFor(() => expect(pickedIds()).toContain("live-1"));

    expect(listedFolders()).not.toContain(SOLO); // the active space only
  });

  it("lists every branch-unit in the active space with the whole tree collapsed", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} />);
    // Nothing is expanded: no `sway.expanded.v1` was written above, so the only
    // thing that could have driven these listings is the space's branch-units.
    await waitFor(() => expect(Object.keys(sessions()).sort()).toEqual([FEAT, MAIN]));
  });

  // The store's one non-negotiable: a tab survives a space switch, so the
  // folder it is running in has to survive one too. Dropping it would starve
  // the live-tab x session join that every needs-you signal is built on.
  it("keeps a live tab's folder after switching to a space that does not contain it", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);
    await waitFor(() => expect(sessions()[MAIN]).toBeTruthy());

    fireEvent.click(await screen.findByTitle("other"));
    await waitFor(() => expect(sessions()[SOLO]).toBeTruthy());

    expect(sessions()[MAIN]?.map((s) => s.id)).toEqual(["live-1", "detached-1"]);
    // And the join still resolves, which is what the notification depends on.
    await waitFor(() =>
      expect(liveStatuses().map((s) => s.sessionId)).toEqual(["live-1"]),
    );
  });

  // The tail-state effect used to trigger on `liveTabs` alone, which was enough
  // only because the store could not fill by itself: every fill came from a user
  // action that also happened to move something else. Now the store fills on its
  // own, and this is the case that catches it - no `sessions://changed`, which
  // re-reads tails explicitly and would mask a missing dependency.
  it("reads a live tab's transcript tail as soon as the store finds its session", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);

    // The read itself is the claim: it can only happen once the live tab has
    // been joined against a session the store went and found on its own.
    await waitFor(() =>
      expect(
        bridge.calls.some((c) => c.cmd === "session_tail_state" && c.args.id === "live-1"),
      ).toBe(true),
    );
  });

  // And the whole composition end to end, through the event the scanner
  // actually raises, from a store that starts empty.
  it("reaches waiting-for-approval across a sessions://changed cycle", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);
    await waitFor(() => expect(bridge.handlers["sessions://changed"]).toBeTruthy());

    bridge.handlers["pty://activity"]({ payload: { id: "tab-1", state: "quiet" } });
    bridge.handlers["sessions://changed"]({ payload: null });

    await waitFor(() =>
      expect(liveStatuses().find((s) => s.sessionId === "live-1")?.status).toBe(
        "waitingForApproval",
      ),
    );
  });

  // Nothing else probes a session Sway is not hosting, so without the sweep an
  // agent someone started in a terminal is invisible until its row is clicked.
  // The rows are opened here only so the verdict is readable: the probe that
  // produced it ran off the folder scan, before anything was clicked.
  it("reports an off-tab session as running without anyone clicking it", async () => {
    localStorage.setItem(
      "sway.expanded.v1",
      JSON.stringify(["p:work/repo", "u:work/repo/main"]),
    );
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);

    await waitFor(() => expect(probedIds()).toContain("detached-1"));
    // Scoped to the row, so this is the detached session's own verdict and not
    // a rollup badge on an ancestor that happens to say the same word. The row
    // and its editable label share the title, and document order puts the row
    // (the outer one) first.
    const row = (await screen.findAllByTitle("detached-1"))[0];
    await waitFor(() => expect(row.querySelector('[title="Running"]')).toBeTruthy());
  });
});
