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
  agent: "claude",
});

// `live-1` is hosted by a tab; `detached-1` is the session started outside Sway
// that nothing would ever probe without the folder sweep; `chat-1` is a native
// chat's transcript, on disk like any other.
const LISTINGS: Record<string, ReturnType<typeof session>[]> = {
  [MAIN]: [session("live-1", MAIN), session("detached-1", MAIN), session("chat-1", MAIN)],
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
const { liveSessionStatuses, sessionStatus, resetSessionActivityForTests } = await import(
  "../../utils/sessionActivity"
);

const listedFolders = () =>
  bridge.calls.filter((c) => c.cmd === "list_sessions").map((c) => String(c.args.folder));

const probedIds = () =>
  bridge.calls
    .filter((c) => c.cmd === "sessions_running")
    .flatMap((c) => (c.args.sessions as { id: string }[]).map((s) => s.id));

describe("what the sidebar can see without being expanded", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
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

    fireEvent.click(await screen.findByRole("button", { name: "other" }));
    await waitFor(() => expect(sessions()[SOLO]).toBeTruthy());

    expect(sessions()[MAIN]?.map((s) => s.id)).toEqual(["live-1", "detached-1", "chat-1"]);
    // And the join still resolves, which is what the notification depends on.
    await waitFor(() =>
      expect(liveSessionStatuses().map((s) => s.sessionId)).toEqual(["live-1"]),
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
      expect(liveSessionStatuses().find((s) => s.sessionId === "live-1")?.status).toBe(
        "waitingForApproval",
      ),
    );
  });

  // Nothing else probes a session Sway is not hosting, so without the sweep an
  // agent someone started in a terminal is invisible until something asks after
  // it. Read `sessionStatus` rather than a row: the sidebar lists no sessions
  // any more, and a detached session is deliberately absent from
  // `liveSessionStatuses` (which is tabs and chats, the things with a row to
  // roll up to). This per-session verdict is what the History button's badge
  // counts, and it is the only place the detached tier surfaces.
  it("reports an off-tab session as running without anyone clicking it", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);

    await waitFor(() => expect(probedIds()).toContain("detached-1"));
    await waitFor(() => expect(sessionStatus("detached-1")).toBe("running"));
  });

  // Tab focus is the whole of how a session becomes the selection now: there is
  // no session row left to click. Both tab kinds have to fill `Selection`
  // completely, or the editor's Session panel (sessionId/sessionPath/sessionCwd)
  // and its accumulated-diff view (folderPath + sessionPath) go blank on focus.
  it.each([
    ["a PTY agent tab", "live-1"],
    ["a chat tab", "chat-1"],
  ])("populates the whole selection from %s's focus alone", async (_label, sessionId) => {
    const picked: (Record<string, unknown> | null)[] = [];
    render(() => (
      <LeftSidebar
        selected={null}
        onSelect={(s) => picked.push(s as Record<string, unknown> | null)}
        liveTabs={liveTabs}
      />
    ));
    await waitFor(() => expect(sessions()[MAIN]).toBeTruthy());

    window.dispatchEvent(
      new CustomEvent("sway:terminal-tab-focused", { detail: { folderPath: MAIN, sessionId } }),
    );

    const last = () => picked[picked.length - 1];
    await waitFor(() => expect(last()?.sessionId).toBe(sessionId));
    expect(last()).toMatchObject({
      spaceName: "work",
      projectName: "repo",
      projectPath: "/root/work/repo",
      folderPath: MAIN,
      branch: "main",
      sessionId,
      sessionPath: `${MAIN}/.transcripts/${sessionId}.jsonl`,
      sessionCwd: MAIN,
      agent: "claude",
    });
  });
});
